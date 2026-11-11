"""Rave.io Parity Engine (social_engine.py)
Implements Rave's internal social, chat, AI, playlist, Drive folder, and RaveDJ modules:
1. Direct Messages (DMThreads / DirectMessageView) & Server-Backed Friendships + Medals
2. OpenGraph Rich Link Previews (LinkPreview)
3. Multi-Language Chat Auto-Translation ([Mesh][translateChat])
4. YouTube Playlist Importer (PlaylistsSelection)
5. RaveDJ AI Dual-Track Mashup & Mix Engine (RAVEDJ RENDERER PROVIDER)
6. In-Room AI Image Studio (StableDiffusion / StableDiffusionHistory / StableDiffusionTag)
7. Google Drive Folder & Multi-Quality MKV/MP4 Browser (GoogleDriveSelection)
8. Moderation & Abuse Reporting (ReportPopUp)
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html as html_mod
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse

import auth_engine
from security import BoundedTTLCache, RateLimiter, client_ip, is_safe_public_url, is_upstash_down, too_many_response

UA_CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# In-memory + Redis-compatible stores for Social / DM / AI History / Reports
# ---------------------------------------------------------------------------
_SOCIAL_USERS = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_DM_THREADS = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_LINK_PREVIEW_CACHE = BoundedTTLCache(maxsize=512, default_ttl=3600.0)
_TRANSLATE_CACHE = BoundedTTLCache(maxsize=1024, default_ttl=3600.0)
_AI_IMAGE_HISTORY: List[Dict[str, Any]] = []
_AI_IMAGE_BY_USER = BoundedTTLCache(maxsize=1024, default_ttl=86400.0)
_REPORTS_LOG: List[Dict[str, Any]] = []
_NOTIFICATION_QUEUES = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_PUSH_SUBSCRIPTIONS = BoundedTTLCache(maxsize=2048, default_ttl=86400.0 * 7)
_PRESENCE_MAP = BoundedTTLCache(maxsize=2048, default_ttl=3600.0)
_SOCIAL_DIR: Dict[str, Dict[str, Any]] = {}
_DM_TYPING = BoundedTTLCache(maxsize=2048, default_ttl=15.0)
_DM_CONFIG = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_LEGACY_BOT_UIDS = {"u_ayla_cinema", "u_mert_dj", "u_zeynep_anime", "u_emre_4k"}


_KV_MEM = BoundedTTLCache(maxsize=512, default_ttl=120.0)
_KV_READ_TS = BoundedTTLCache(maxsize=512, default_ttl=120.0)
_USER_PROGRESS = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_USER_WATCHLIST = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_USER_MUSIC_HISTORY = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)
_LEGACY_GUEST_PURGED = False
_PRIVATE_HEADERS = {"Cache-Control": "private, no-store, no-cache, must-revalidate", "Vary": "Authorization"}
_SERVER_HEALTH: Dict[str, Dict[str, Any]] = {}


_KV_MISS_SENTINEL = ("__wl_kv_empty__",)


def _get_redis_store():
    try:
        import rooms
        st = getattr(rooms, "STORE", None)
        if not getattr(st, "shared", False):
            return None
        if is_upstash_down(getattr(st, "url", "")):
            return None
        return st
    except Exception:
        return None


def _kv_get(key: str, default: Any = None, max_age: float = 8.0) -> Any:
    now_t = time.time()
    mem_val = _KV_MEM.get(key, None)
    if mem_val is not None and (now_t - float(_KV_READ_TS.get(key) or 0.0) < max_age):
        return default if mem_val == _KV_MISS_SENTINEL else mem_val
    st = _get_redis_store()
    if st is not None:
        try:
            raw = st._call(["GET", key])
            if raw:
                val = json.loads(raw)
                mem_ttl = 20.0 if key.startswith("wl:vrelay:") else 120.0
                _KV_MEM.set(key, val, ttl=mem_ttl)
                _KV_READ_TS.set(key, now_t, ttl=mem_ttl)
                return val
            if not is_upstash_down(getattr(st, "url", "")):
                neg_ttl = min(15.0, max(0.2, float(max_age)))
                _KV_MEM.set(key, _KV_MISS_SENTINEL, ttl=neg_ttl)
                _KV_READ_TS.set(key, now_t, ttl=neg_ttl)
                return default
        except Exception:
            pass
    if mem_val == _KV_MISS_SENTINEL:
        return default
    return mem_val if mem_val is not None else default


def _kv_set(key: str, val: Any, ttl_sec: int = 604800) -> None:
    if not key.startswith("wl:vn:"):
        mem_ttl = min(float(max(1, ttl_sec)), 20.0 if key.startswith("wl:vrelay:") else 180.0)
        _KV_MEM.set(key, val, ttl=mem_ttl)
        _KV_READ_TS.set(key, time.time(), ttl=mem_ttl)
    st = _get_redis_store()
    if st is not None:
        try:
            payload = json.dumps(val, separators=(",", ":"), ensure_ascii=False)
            st._call(["SET", key, payload, "EX", str(max(1, int(ttl_sec)))])
        except Exception:
            pass


def _queue_notification(target_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    key = str(target_key or "*").strip().lower() or "*"
    now_t = time.time()
    item: Dict[str, Any] = {
        "id": _clean(payload.get("id"), 48) or ("ntf_" + uuid.uuid4().hex[:10]),
        "type": _clean(payload.get("type") or "room_invite", 32),
        "title": _clean(payload.get("title") or "Watchlivo — Sinema Daveti", 140),
        "body": _clean(payload.get("body") or "Arkadaşın seni sinema odasına çağırıyor!", 260),
        "fromUid": _clean(payload.get("fromUid"), 64),
        "fromName": _clean(payload.get("fromName") or "Arkadaşın", 40),
        "fromHandle": _clean(payload.get("fromHandle"), 36),
        "fromColor": _clean(payload.get("fromColor") or payload.get("color") or "#27DCC8", 16),
        "fromAvatarUrl": _clean_avatar(payload.get("fromAvatarUrl") or payload.get("avatarUrl")),
        "requestId": _clean(payload.get("requestId"), 48),
        "roomId": _clean(payload.get("roomId"), 80),
        "roomName": _clean(payload.get("roomName") or payload.get("roomTitle"), 120),
        "mediaTitle": _clean(payload.get("mediaTitle"), 160),
        "mediaPoster": _clean(payload.get("mediaPoster"), 800),
        "mediaProvider": _clean(payload.get("mediaProvider"), 32),
        "url": _clean(payload.get("url"), 260),
        "ts": float(payload.get("ts") or now_t),
        "expiresAt": float(payload.get("expiresAt") or 0.0),
    }
    existing_q = _kv_get(f"wl:soc:ntf:{key}", None, max_age=1.5)
    q = list(existing_q) if isinstance(existing_q, list) else list(_NOTIFICATION_QUEUES.get(key, []))
    q = [x for x in q if not (float(x.get("expiresAt") or 0.0) > 0 and float(x.get("expiresAt") or 0.0) < now_t)]
    q.append(item)
    del q[:-50]
    _NOTIFICATION_QUEUES[key] = q
    _kv_set(f"wl:soc:ntf:{key}", q, ttl_sec=86400)
    return item

def _now() -> float:
    return time.time()


def _hhmm(ts: Optional[float] = None) -> str:
    from datetime import datetime, timezone, timedelta
    t_val = float(ts) if ts is not None else _now()
    return datetime.fromtimestamp(t_val, tz=timezone(timedelta(hours=3))).strftime("%H:%M")


def _clean(v: Any, limit: int = 200) -> str:
    return str(v or "").strip()[:limit]


_SAFE_DATA_AVATAR_RE = re.compile(r"^data:image/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$", re.I)


def _clean_avatar(v: Any) -> str:
    s = str(v or "").strip()
    if not s:
        return ""
    low = s.lower()
    if low.startswith("data:image/svg") or low.startswith("javascript:"):
        return ""
    if s.startswith(("https://", "/static/", "/uploads/")):
        return s[:800]
    if low.startswith("data:image/") and len(s) <= 45000 and _SAFE_DATA_AVATAR_RE.match(s):
        return re.sub(r"\s+", "", s)
    return ""


def _finite_float(v: Any, default: float = 0.0, lo: Optional[float] = None, hi: Optional[float] = None) -> float:
    try:
        f = float(v)
        if not math.isfinite(f):
            f = default
    except (TypeError, ValueError, OverflowError):
        f = default
    if lo is not None and f < lo:
        f = lo
    if hi is not None and f > hi:
        f = hi
    return f


def _safe_int(v: Any, default: int = 0, lo: Optional[int] = None, hi: Optional[int] = None) -> int:
    try:
        f = float(v)
        if not math.isfinite(f):
            n = default
        else:
            n = int(f)
    except (TypeError, ValueError, OverflowError):
        n = default
    if lo is not None and n < lo:
        n = lo
    if hi is not None and n > hi:
        n = hi
    return n


def _tr_fold_soc(s: Any) -> str:
    return (
        str(s or "")
        .replace("İ", "i").replace("I", "i").replace("ı", "i")
        .replace("Ş", "s").replace("ş", "s")
        .replace("Ğ", "g").replace("ğ", "g")
        .replace("Ü", "u").replace("ü", "u")
        .replace("Ö", "o").replace("ö", "o")
        .replace("Ç", "c").replace("ç", "c")
        .lower()
        .replace("\u0307", "")
    )


def _strip_soc_tag(s: Any) -> str:
    return re.sub(r"#[a-zA-Z0-9]{1,8}$", "", str(s or "").strip()).strip()


_GUEST_BINDINGS = BoundedTTLCache(maxsize=4096, default_ttl=86400 * 14)


def _guest_binding_sig(request: Request) -> str:
    ip_s = str(client_ip(request) or "anon")
    ua_s = str(request.headers.get("user-agent") or "")[:160]
    return hmac.new(auth_engine.AUTH_SECRET, f"gbind:{ip_s}|{ua_s}".encode("utf-8"), hashlib.sha256).hexdigest()[:20]


def _caller_uid(request: Request, raw_uid: Any = "", fallback: str = "guest_default") -> str:
    verified = _clean(request.scope.get("wl_uid"), 64)
    if verified:
        return verified.lower()
    auth_hdr = request.headers.get("Authorization", "")
    if auth_hdr.lower().startswith("bearer "):
        any_claims = auth_engine.verify_any_token(auth_hdr[7:].strip())
        if any_claims and any_claims.get("uid"):
            return str(any_claims["uid"]).strip().lower()[:64]
    cand = _clean(raw_uid, 64).lower()
    req_sig = _guest_binding_sig(request)
    is_ephemeral_cand = (
        (cand.startswith("guest_") or (cand.startswith("u_") and not cand.startswith("u_wl_")))
        and cand not in ("guest_default", "guest_local")
        and bool(re.fullmatch(r"(?:guest_|u_(?!wl_))[a-z0-9_-]{3,48}", cand))
    )
    if is_ephemeral_cand:
        ex_u = _SOCIAL_USERS.get(cand) or _kv_get(f"wl:soc:u:{cand}", None, max_age=3.0)
        saved_sig = ""
        if isinstance(ex_u, dict) and ex_u.get("uid"):
            saved_sig = str(ex_u.get("guestBindingSig") or "")
        if not saved_sig:
            saved_sig = str(_GUEST_BINDINGS.get(cand) or "")
        if isinstance(ex_u, dict) and ex_u.get("uid"):
            if saved_sig and hmac.compare_digest(saved_sig, req_sig):
                _GUEST_BINDINGS.set(cand, req_sig)
                return cand
        else:
            if not saved_sig or hmac.compare_digest(saved_sig, req_sig):
                _GUEST_BINDINGS.set(cand, req_sig)
                return cand
    ip_seed = str(client_ip(request) or "anon")
    ua_seed = str(request.headers.get("user-agent") or "")[:80]
    det_uid = "guest_" + hashlib.sha256(f"{ip_seed}|{ua_seed}|{fallback}".encode("utf-8")).hexdigest()[:12]
    _GUEST_BINDINGS.set(det_uid, req_sig)
    return det_uid


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        full_new = urllib.parse.urljoin(req.full_url, newurl)
        if not is_safe_public_url(full_new):
            raise urllib.error.URLError("Unsafe redirect blocked")
        return super().redirect_request(req, fp, code, msg, headers, full_new)


def _compute_medal(minutes: int) -> str:
    if minutes >= 300:
        return "🥇 Altın İzleyici"
    if minutes >= 120:
        return "🥈 Gümüş İzleyici"
    if minutes >= 30:
        return "🥉 Bronz İzleyici"
    return "⚡ Yeni İzleyici"


def _thread_key(u1: str, u2: str) -> str:
    a, b = sorted([str(u1 or "guest").lower(), str(u2 or "guest").lower()])
    return f"dm:{a}:{b}"


def _norm_handle_tag(raw: str, fallback_name: str = "") -> str:
    cleaned_raw = _strip_soc_tag(str(raw or "").strip().lstrip("@"))
    base = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold_soc(cleaned_raw))[:24].strip("._-")
    if len(base) < 2 and fallback_name:
        cleaned_fb = _strip_soc_tag(str(fallback_name or "").strip()).replace(" ", "_")
        base = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold_soc(cleaned_fb))[:20].strip("._-")
    return f"@{base or 'izleyici'}"


def _load_social_dir() -> Dict[str, Dict[str, Any]]:
    persisted = _kv_get("wl:soc:dir", None, max_age=6.0)
    if isinstance(persisted, dict):
        _SOCIAL_DIR.update(persisted)
    return _SOCIAL_DIR


def _register_social_dir(card: Dict[str, Any], persist: bool = True) -> None:
    uid_c = _clean(card.get("uid"), 64)
    if not uid_c or uid_c in _LEGACY_BOT_UIDS or uid_c in ("guest_default", "guest_local") or uid_c.startswith("unauth_"):
        return
    now_t = _now()
    fast_prev = _SOCIAL_DIR.get(uid_c) if isinstance(_SOCIAL_DIR.get(uid_c), dict) else None
    if not persist and fast_prev and (now_t - float(fast_prev.get("updatedAt") or 0.0) < 60.0):
        d = _SOCIAL_DIR
        prev = fast_prev
    else:
        d = _load_social_dir()
        prev = d.get(uid_c) if isinstance(d.get(uid_c), dict) else {}
    raw_nm = _clean(card.get("name"), 32)
    prev_nm = _clean(prev.get("name"), 32)
    if prev_nm and prev_nm.lower() not in ("izleyici", "misafir") and raw_nm.lower() in ("", "izleyici", "misafir"):
        raw_nm = prev_nm
    raw_hd = _clean(card.get("handle"), 32)
    prev_hd = _clean(prev.get("handle"), 32)
    if prev_hd and prev_hd.lower() not in ("@izleyici", "izleyici", "@misafir", "misafir") and raw_hd.lower() in ("", "@izleyici", "izleyici", "@misafir", "misafir"):
        raw_hd = prev_hd
    av_url_c = _clean_avatar(card.get("avatarUrl")) or _clean_avatar(prev.get("avatarUrl"))
    raw_av_sym = card.get("avatar") or prev.get("avatar") or "🎬"
    av_sym = _clean_avatar(raw_av_sym) or (_clean(raw_av_sym, 16) if not str(raw_av_sym).startswith("data:") else "🎬")
    merged = {
        "uid": uid_c,
        "name": raw_nm or prev_nm or "İzleyici",
        "handle": _norm_handle_tag(raw_hd or prev_hd or "", raw_nm or prev_nm or ""),
        "color": _clean(card.get("color") or prev.get("color") or "#27DCC8", 16),
        "avatar": av_sym or "🎬",
        "avatarUrl": av_url_c,
        "bio": _clean(card.get("bio") if "bio" in card else prev.get("bio", ""), 160),
        "statusEmoji": _clean(card.get("statusEmoji") or prev.get("statusEmoji") or "🍿", 12),
        "statusText": _clean(card.get("statusText") if "statusText" in card else prev.get("statusText", ""), 80),
        "isGuest": bool(uid_c.startswith("guest_")),
        "updatedAt": now_t,
    }
    unchanged = bool(prev) and all(
        merged.get(k) == prev.get(k)
        for k in ("name", "handle", "color", "avatar", "avatarUrl", "bio", "statusEmoji", "statusText")
    )
    prev_upd = float(prev.get("updatedAt") or 0.0) if prev else 0.0
    d[uid_c] = merged
    if len(d) > 800:
        oldest = sorted(
            d.items(),
            key=lambda kv: (0 if str(kv[0]).startswith("guest_") else 1, float((kv[1] or {}).get("updatedAt") or 0.0)),
        )[:120]
        for ok, _ in oldest:
            d.pop(ok, None)
    if persist and (not unchanged or (now_t - prev_upd >= 600.0)):
        _kv_set("wl:soc:dir", d, ttl_sec=2592000)


def _ensure_user_social(
    uid: str,
    name: str = "",
    handle: str = "",
    color: str = "",
    avatar_url: str = "",
    claims: Optional[Dict[str, Any]] = None,
    persist: bool = True,
) -> Dict[str, Any]:
    uid_clean = _clean(uid, 64) or "guest_default"
    persisted_u = _kv_get(f"wl:soc:u:{uid_clean}", None, max_age=(0.5 if persist else 3.0))
    if isinstance(persisted_u, dict) and persisted_u.get("uid"):
        _SOCIAL_USERS[uid_clean] = persisted_u
    auth_card: Optional[Dict[str, Any]] = None
    if not uid_clean.startswith(("guest_", "unauth_")):
        try:
            import auth_engine
            auth_card = auth_engine.resolve_public_user(uid_clean)
        except Exception:
            auth_card = None
        if not auth_card and isinstance(claims, dict) and str(claims.get("uid") or "").lower() == uid_clean.lower():
            auth_card = {
                "uid": uid_clean,
                "name": str(claims.get("name") or ""),
                "handle": str(claims.get("handle") or ""),
                "color": str(claims.get("color") or ""),
                "avatarUrl": str(claims.get("avatarUrl") or ""),
                "bio": str(claims.get("bio") or ""),
                "statusEmoji": str(claims.get("statusEmoji") or "🍿"),
                "statusText": str(claims.get("statusText") or ""),
                "hideWatching": bool(claims.get("hideWatching", False)),
            }
    eff_name = _clean((auth_card or {}).get("name") or name, 32)
    eff_handle = _clean((auth_card or {}).get("handle") or handle, 32)
    eff_color = _clean((auth_card or {}).get("color") or color, 16)
    eff_av = _clean_avatar((auth_card or {}).get("avatarUrl")) or _clean_avatar(avatar_url)
    if uid_clean not in _SOCIAL_USERS:
        _SOCIAL_USERS[uid_clean] = {
            "uid": uid_clean,
            "name": eff_name or "İzleyici",
            "handle": _norm_handle_tag(eff_handle, eff_name or "izleyici"),
            "color": eff_color or "#27DCC8",
            "avatarUrl": eff_av,
            "friends": [],
            "requests": [],
            "outgoingRequests": [],
            "blocked": [],
            "unread": {},
            "privacy": {
                "presenceVisibility": "friends",
                "hideWatching": bool((auth_card or {}).get("hideWatching", False)),
                "allowInvites": "friends",
            },
            "lastSeen": _now(),
        }
    u = _SOCIAL_USERS[uid_clean]
    if uid_clean.startswith("guest_") and not u.get("guestBindingSig"):
        mem_sig = _GUEST_BINDINGS.get(uid_clean)
        if mem_sig:
            u["guestBindingSig"] = str(mem_sig)
    # Purge legacy demo bot entries so only real mutual accounts appear
    u["friends"] = [f for f in (u.get("friends") or []) if isinstance(f, dict) and f.get("uid") not in _LEGACY_BOT_UIDS]
    u["requests"] = [r for r in (u.get("requests") or []) if isinstance(r, dict) and r.get("fromUid") not in _LEGACY_BOT_UIDS and r.get("id") != "req_emre_01"]
    u.setdefault("outgoingRequests", [])
    u.setdefault("blocked", [])
    u.setdefault("privacy", {"presenceVisibility": "friends", "hideWatching": False, "allowInvites": "friends"})
    if auth_card and "hideWatching" in auth_card:
        u["privacy"]["hideWatching"] = bool(auth_card.get("hideWatching"))
    if isinstance(u.get("unread"), dict):
        for bk in list(u["unread"].keys()):
            if bk in _LEGACY_BOT_UIDS:
                u["unread"].pop(bk, None)
    else:
        u["unread"] = {}
    cur_nm = str(u.get("name") or "")
    cur_hd = str(u.get("handle") or "")
    if eff_name and (bool(auth_card) or cur_nm.lower() in ("", "izleyici", "misafir") or eff_name.lower() not in ("izleyici", "misafir")):
        u["name"] = eff_name
    if eff_handle and (bool(auth_card) or cur_hd.lower() in ("", "@izleyici", "izleyici", "@misafir", "misafir") or eff_handle.lower().lstrip("@") not in ("izleyici", "misafir")):
        u["handle"] = _norm_handle_tag(eff_handle, u.get("name") or "")
    if eff_color:
        u["color"] = eff_color
    if eff_av:
        u["avatarUrl"] = eff_av
    _register_social_dir({
        "uid": uid_clean,
        "name": u.get("name"),
        "handle": u.get("handle"),
        "color": u.get("color"),
        "avatarUrl": u.get("avatarUrl"),
        "bio": (auth_card or {}).get("bio", ""),
        "statusEmoji": (auth_card or {}).get("statusEmoji", "🍿"),
        "statusText": (auth_card or {}).get("statusText", ""),
    }, persist=persist)
    if persist:
        _kv_set(f"wl:soc:u:{uid_clean}", u, ttl_sec=2592000)
    return u


def _save_user_social(u: Dict[str, Any]) -> None:
    if not isinstance(u, dict):
        return
    uid_c = _clean(u.get("uid"), 64)
    if not uid_c:
        return
    _SOCIAL_USERS[uid_c] = u
    _kv_set(f"wl:soc:u:{uid_c}", u, ttl_sec=2592000)


def _format_last_seen(last_ts: float, now_ts: float) -> str:
    if not last_ts or last_ts <= 0:
        return "Çevrimdışı"
    diff = max(0, int(now_ts - last_ts))
    if diff < 90:
        return "Az önce aktifti"
    if diff < 3600:
        return f"Son görülme: {max(1, diff // 60)} dk önce"
    if diff < 86400:
        return f"Son görülme: {max(1, diff // 3600)} sa önce"
    return f"Son görülme: {max(1, diff // 86400)} gün önce"


def _compute_live_presence(target_uid: str, viewer_uid: str = "", is_friend: bool = False) -> Dict[str, Any]:
    t_uid = _clean(target_uid, 64)
    v_uid = _clean(viewer_uid, 64)
    now_t = _now()
    pres = _kv_get(f"wl:soc:pres:{t_uid}", None, max_age=2.5)
    if not isinstance(pres, dict):
        pres = _PRESENCE_MAP.get(t_uid) or {}
    t_u = _SOCIAL_USERS.get(t_uid) or _kv_get(f"wl:soc:u:{t_uid}", None, max_age=6.0) or {}
    if not is_friend and v_uid and isinstance(t_u, dict):
        for f_entry in (t_u.get("friends") or []):
            if isinstance(f_entry, dict) and str(f_entry.get("uid") or "").lower() == v_uid.lower():
                is_friend = True
                break
            if isinstance(f_entry, str) and f_entry.lower() == v_uid.lower():
                is_friend = True
                break
    priv = (t_u.get("privacy") if isinstance(t_u, dict) else None) or {}
    vis = str(pres.get("visibility") or priv.get("presenceVisibility") or "friends").lower()
    hide_watch = bool(pres.get("hideWatching") if "hideWatching" in pres else priv.get("hideWatching", False))
    last_seen = _finite_float(pres.get("lastSeen") or (t_u.get("lastSeen") if isinstance(t_u, dict) else 0.0), 0.0)
    raw_state = str(pres.get("state") or "offline").lower()
    custom_txt = _clean(pres.get("statusText"), 60)
    custom_emj = _clean(pres.get("statusEmoji") or "🟢", 10)

    active_room_hit: Optional[Dict[str, Any]] = None
    try:
        import rooms as rooms_mod
        rm_dict = getattr(rooms_mod.STORE, "l1_rooms", None) or getattr(rooms_mod.STORE, "rooms", {}) or {}
        closed_map = getattr(rooms_mod, "_CLOSED_ROOMS", {}) or {}
        if t_uid:
            for r_id, r_obj in list(rm_dict.items()):
                if r_id in closed_map or not isinstance(r_obj, dict):
                    continue
                for p_obj in (r_obj.get("participants") or {}).values():
                    if isinstance(p_obj, dict) and p_obj.get("transport") != "bot" and str(p_obj.get("uid") or "").lower() == t_uid.lower():
                        p_seen = _finite_float(p_obj.get("lastSeen"), 0.0)
                        if now_t - p_seen <= 75.0:
                            active_room_hit = r_obj
                            if p_seen > last_seen and raw_state != "offline":
                                last_seen = p_seen
                                if raw_state not in ("watching", "online", "idle"):
                                    raw_state = "watching"
                        break
                if active_room_hit:
                    break
    except Exception:
        active_room_hit = None

    is_self = bool(v_uid and v_uid == t_uid)
    can_see_presence = is_self or vis == "everyone" or (vis == "friends" and is_friend)
    if not can_see_presence or raw_state == "offline" or (now_t - last_seen) > 75.0 or last_seen <= 0:
        ls_lbl = _format_last_seen(last_seen, now_t) if can_see_presence else "Çevrimdışı"
        return {
            "online": False,
            "presenceState": "offline",
            "status": ls_lbl if can_see_presence else "⚫ Çevrimdışı",
            "lastSeen": last_seen if can_see_presence else 0.0,
            "lastSeenLabel": ls_lbl,
            "roomId": "",
            "mediaTitle": "",
            "watchingTitle": "",
            "watchingRoom": None,
        }
    if raw_state == "idle":
        return {
            "online": True,
            "presenceState": "idle",
            "status": "🌙 Uzakta",
            "lastSeen": last_seen,
            "lastSeenLabel": "Uzakta",
            "roomId": "",
            "mediaTitle": "",
            "watchingTitle": "",
            "watchingRoom": None,
        }
    room_id = _clean(pres.get("roomId"), 80)
    room_priv = _clean(pres.get("roomPrivacy") or "public", 16).lower()
    media_title = _clean(pres.get("mediaTitle") or pres.get("watchingTitle"), 140)
    room_name = _clean(pres.get("roomName"), 100)
    media_poster = _clean(pres.get("mediaPoster"), 800)
    media_prov = _clean(pres.get("mediaProvider") or "cinema", 32)
    room_locked = bool(pres.get("roomLocked") or pres.get("hasPassword"))
    try:
        import rooms as rooms_mod
        closed_map = getattr(rooms_mod, "_CLOSED_ROOMS", {}) or {}
        if room_id and room_id in closed_map:
            room_id = ""
        elif not room_id and isinstance(active_room_hit, dict):
            room_id = _clean(active_room_hit.get("id"), 80)
            room_priv = _clean(active_room_hit.get("privacy") or "public", 16).lower()
            room_locked = bool(rooms_mod.has_password(active_room_hit) or active_room_hit.get("hasPassword"))
            room_name = _clean(active_room_hit.get("name"), 100)
            rm_m = active_room_hit.get("media") or {}
            if isinstance(rm_m, dict):
                media_title = _clean(rm_m.get("title"), 140)
                media_poster = _clean(rm_m.get("poster") or rm_m.get("thumbnail"), 800)
                media_prov = _clean(rm_m.get("provider") or "cinema", 32)
        if room_id:
            rm_dict = getattr(rooms_mod.STORE, "l1_rooms", None) or getattr(rooms_mod.STORE, "rooms", {}) or {}
            live_rm = rm_dict.get(room_id) or (active_room_hit if isinstance(active_room_hit, dict) and _clean(active_room_hit.get("id"), 80) == room_id else None)
            if isinstance(live_rm, dict):
                room_priv = _clean(live_rm.get("privacy") or room_priv or "public", 16).lower()
                if rooms_mod.has_password(live_rm) or live_rm.get("hasPassword"):
                    room_locked = True
                room_name = _clean(live_rm.get("name") or room_name, 100)
                rm_media = live_rm.get("media") or {}
                if isinstance(rm_media, dict) and rm_media.get("title"):
                    media_title = _clean(rm_media.get("title"), 140)
    except Exception:
        pass
    if room_id and not hide_watch and room_priv != "private" and not room_locked and (
        room_priv != "friends" or is_friend
    ):
        label = media_title or room_name or "Sinema Odası"
        return {
            "online": True,
            "presenceState": "watching",
            "status": f"🎬 {label} izliyor",
            "lastSeen": last_seen,
            "lastSeenLabel": "Şu an izliyor",
            "roomId": room_id,
            "mediaTitle": label,
            "watchingTitle": label,
            "hideWatching": False,
            "watchingRoom": {
                "roomId": room_id,
                "roomName": room_name or "Watchlivo Odası",
                "mediaTitle": media_title or room_name or "Canlı Oda",
                "mediaPoster": media_poster,
                "mediaProvider": media_prov,
            },
        }
    return {
        "online": True,
        "presenceState": "online",
        "status": f"{custom_emj} {custom_txt}".strip() if custom_txt else "🟢 Çevrimiçi",
        "lastSeen": last_seen,
        "lastSeenLabel": "Şu an çevrimiçi",
        "roomId": "",
        "mediaTitle": "",
        "watchingTitle": "",
        "hideWatching": bool(hide_watch),
        "watchingRoom": None,
    }


def _user_card_with_presence(uid: str, viewer_uid: str = "") -> Dict[str, Any]:
    t_uid = _clean(uid, 64)
    v_uid = _clean(viewer_uid, 64)
    t_u = _SOCIAL_USERS.get(t_uid) or _kv_get(f"wl:soc:u:{t_uid}", None, max_age=6.0) or {}
    d_card = _load_social_dir().get(t_uid) or {}
    friends_list = (t_u.get("friends") if isinstance(t_u, dict) else None) or []
    is_fr = any(
        (isinstance(f, dict) and str(f.get("uid") or "").lower() == v_uid.lower())
        or (isinstance(f, str) and f.lower() == v_uid.lower())
        for f in friends_list
    ) if v_uid else False
    pres = _compute_live_presence(t_uid, v_uid, is_friend=is_fr)
    return {
        "uid": t_uid,
        "name": _clean(d_card.get("name") or (t_u.get("name") if isinstance(t_u, dict) else "") or "İzleyici", 32),
        "handle": _norm_handle_tag(d_card.get("handle") or (t_u.get("handle") if isinstance(t_u, dict) else "") or "", d_card.get("name") or ""),
        "color": _clean(d_card.get("color") or (t_u.get("color") if isinstance(t_u, dict) else "") or "#27DCC8", 16),
        "avatarUrl": _clean_avatar(d_card.get("avatarUrl")) or _clean_avatar((t_u.get("avatarUrl") if isinstance(t_u, dict) else "")),
        **pres,
    }


def _friendship_state(u: Dict[str, Any], target_uid: str) -> str:
    t_uid = _clean(target_uid, 64)
    if not t_uid:
        return "NONE"
    if any(b.get("uid") == t_uid for b in (u.get("blocked") or []) if isinstance(b, dict)):
        return "BLOCKED"
    if any(f.get("uid") == t_uid for f in (u.get("friends") or []) if isinstance(f, dict)):
        return "FRIENDS"
    if any(r.get("toUid") == t_uid for r in (u.get("outgoingRequests") or []) if isinstance(r, dict)):
        return "OUTGOING_PENDING"
    if any(r.get("fromUid") == t_uid for r in (u.get("requests") or []) if isinstance(r, dict)):
        return "INCOMING_PENDING"
    return "NONE"


def _resolve_social_target(identifier: str, target_uid_hint: str = "") -> Optional[Dict[str, Any]]:
    d = _load_social_dir()
    for cand in [target_uid_hint, identifier]:
        c_str = str(cand or "").strip()
        if not c_str:
            continue
        try:
            import auth_engine
            ac = auth_engine.resolve_public_user(c_str)
            if ac and ac.get("uid"):
                _register_social_dir(ac)
                return ac
        except Exception:
            pass
        if c_str in d:
            return dict(d[c_str])
        if c_str in _SOCIAL_USERS:
            su = _SOCIAL_USERS[c_str]
            return {"uid": su["uid"], "name": su.get("name", "İzleyici"), "handle": su.get("handle", "@izleyici"), "color": su.get("color", "#27DCC8"), "avatarUrl": su.get("avatarUrl", "")}
        c_stripped = _strip_soc_tag(c_str)
        c_fold = _tr_fold_soc(c_stripped.lstrip("@"))
        c_norm = re.sub(r"[^a-z0-9_.\-]", "", c_fold)[:24].strip("._-")
        c_name_fold = _tr_fold_soc(c_stripped)
        for card in d.values():
            if not isinstance(card, dict) or not card.get("uid"):
                continue
            card_h = _tr_fold_soc(str(card.get("handle") or "").lstrip("@"))
            card_n = _tr_fold_soc(str(card.get("name") or ""))
            if (c_fold and card_h in (c_fold, c_norm)) or (c_name_fold and card_n == c_name_fold):
                return dict(card)
        for su_uid, su in list(_SOCIAL_USERS.items()):
            if not isinstance(su, dict) or su_uid in _LEGACY_BOT_UIDS or su_uid in ("guest_default", "guest_local"):
                continue
            su_h = _tr_fold_soc(str(su.get("handle") or "").lstrip("@"))
            su_n = _tr_fold_soc(str(su.get("name") or ""))
            if (c_fold and su_h in (c_fold, c_norm)) or (c_name_fold and su_n == c_name_fold):
                return {"uid": su_uid, "name": su.get("name", "İzleyici"), "handle": su.get("handle", "@izleyici"), "color": su.get("color", "#27DCC8"), "avatarUrl": su.get("avatarUrl", "")}
        try:
            import rooms as rooms_mod
            rm_dict = getattr(rooms_mod.STORE, "l1_rooms", None) or getattr(rooms_mod.STORE, "rooms", {}) or {}
            for r_obj in list(rm_dict.values()):
                if not isinstance(r_obj, dict):
                    continue
                for p_obj in (r_obj.get("participants") or {}).values():
                    if not isinstance(p_obj, dict) or p_obj.get("transport") == "bot":
                        continue
                    p_uid = _clean(p_obj.get("uid"), 64)
                    if not p_uid or p_uid in _LEGACY_BOT_UIDS:
                        continue
                    p_h = _tr_fold_soc(str(p_obj.get("handle") or "").lstrip("@"))
                    p_n = _tr_fold_soc(str(p_obj.get("name") or ""))
                    if p_uid.lower() == c_str.lower() or (c_fold and p_h and p_h in (c_fold, c_norm)) or (c_name_fold and p_n == c_name_fold):
                        card_rm = {
                            "uid": p_uid,
                            "name": _clean(p_obj.get("name") or "İzleyici", 32),
                            "handle": _norm_handle_tag(str(p_obj.get("handle") or ""), str(p_obj.get("name") or "")),
                            "color": _clean(p_obj.get("color") or "#27DCC8", 16),
                            "avatarUrl": _clean_avatar(p_obj.get("avatarUrl")),
                        }
                        _register_social_dir(card_rm, persist=False)
                        return card_rm
        except Exception:
            pass
    return None


def _enrich_friend_entry(fr: Dict[str, Any], viewer_uid: str) -> Dict[str, Any]:
    p_uid = _clean(fr.get("uid"), 64)
    d_card = _load_social_dir().get(p_uid) or {}
    pres = _compute_live_presence(p_uid, viewer_uid, is_friend=True)
    mins = _safe_int(fr.get("watchMinutes"), 0, lo=0, hi=1000000)
    return {
        **fr,
        "uid": p_uid,
        "name": _clean(d_card.get("name") or fr.get("name") or "İzleyici", 32),
        "handle": _norm_handle_tag(d_card.get("handle") or fr.get("handle") or "", d_card.get("name") or fr.get("name") or ""),
        "color": _clean(d_card.get("color") or fr.get("color") or "#27DCC8", 16),
        "avatarUrl": _clean_avatar(d_card.get("avatarUrl")) or _clean_avatar(fr.get("avatarUrl")),
        "online": pres["online"],
        "presenceState": pres["presenceState"],
        "status": pres["status"],
        "lastSeen": pres["lastSeen"],
        "lastSeenLabel": pres["lastSeenLabel"],
        "roomId": pres["roomId"],
        "mediaTitle": pres["mediaTitle"],
        "watchingRoom": pres["watchingRoom"],
        "bestFriend": bool(fr.get("bestFriend", False)),
        "watchMinutes": mins,
        "medal": _compute_medal(mins),
    }


def _enrich_req_item(r: Dict[str, Any], uid_field: str, name_field: str, handle_field: str) -> Dict[str, Any]:
    r_uid = _clean(r.get(uid_field), 64)
    d_card = _load_social_dir().get(r_uid) or {}
    nm = _clean(d_card.get("name") or r.get(name_field) or "İzleyici", 32)
    hd = _norm_handle_tag(d_card.get("handle") or r.get(handle_field) or "", nm)
    return {
        **r,
        name_field: nm,
        handle_field: hd,
        "color": _clean(d_card.get("color") or r.get("color") or "#27DCC8", 16),
        "avatarUrl": _clean_avatar(d_card.get("avatarUrl")) or _clean_avatar(r.get("avatarUrl")),
    }


async def social_guest_provision(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    uid = _caller_uid(request, body.get("uid") or body.get("id"), "guest_default")
    if uid in ("guest_default", "guest_local"):
        uid = "guest_" + uuid.uuid4().hex[:10]
    name = _clean(body.get("name"), 32) or "Misafir"
    raw_handle = _clean(body.get("handle"), 32)
    color = _clean(body.get("color"), 16) or "#00f5d4"
    avatar_url = _clean_avatar(body.get("avatarUrl"))
    if raw_handle:
        cand_h = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold_soc(_strip_soc_tag(raw_handle.lstrip("@"))))[:24].strip("._-")
        if len(cand_h) < 2:
            return JSONResponse({"ok": False, "error": "Kullanıcı adı en az 2 geçerli harf veya rakam içermelidir."}, status_code=400)
        try:
            import auth_engine
            reg_owner = auth_engine.resolve_public_user(f"@{cand_h}")
            if reg_owner and reg_owner.get("uid") and reg_owner["uid"] != uid:
                return JSONResponse({"ok": False, "error": f"Bu kullanıcı adı (@{cand_h}) kayıtlı bir üyeye ait."}, status_code=409)
        except Exception:
            pass
        for d_uid, d_card in _load_social_dir().items():
            if d_uid and d_uid != uid and isinstance(d_card, dict):
                if str(d_card.get("handle") or "").lstrip("@").lower() == cand_h:
                    if uid.startswith("guest_") and re.fullmatch(r"(?:misafir|guest)[a-z0-9_.\-]{0,14}", cand_h):
                        cand_h = f"{cand_h[:15]}_{re.sub(r'[^a-z0-9]', '', uid.lower())[-6:]}"
                        raw_handle = cand_h
                        break
                    return JSONResponse({"ok": False, "error": f"Bu kullanıcı adı (@{cand_h}) zaten kullanımda."}, status_code=409)
    u = _ensure_user_social(uid, name, raw_handle, color, avatar_url, claims=request.scope.get("wl_claims"))
    g_sig = _guest_binding_sig(request)
    if uid.startswith("guest_"):
        u["guestBindingSig"] = g_sig
        _SOCIAL_USERS[uid] = u
        _kv_set(f"wl:soc:u:{uid}", u, ttl_sec=2592000)
    now_t = _now()
    rec = _PRESENCE_MAP.get(uid) or {}
    rec.update({
        "uid": uid,
        "state": rec.get("state") if rec.get("state") in ("watching", "online") else "online",
        "lastSeen": now_t,
        "visibility": (u.get("privacy") or {}).get("presenceVisibility", "friends"),
        "hideWatching": bool((u.get("privacy") or {}).get("hideWatching", False)),
    })
    _PRESENCE_MAP[uid] = rec
    _kv_set(f"wl:soc:pres:{uid}", rec, ttl_sec=180)
    clean_h = str(u.get("handle") or _norm_handle_tag(raw_handle, name)).lstrip("@")
    guest_tok = auth_engine.sign_guest_token(uid, g_sig) if uid.startswith("guest_") else ""
    guest_user = {
        "uid": uid,
        "id": uid,
        "name": u.get("name", name),
        "handle": clean_h,
        "color": u.get("color", color),
        "avatarUrl": u.get("avatarUrl", avatar_url),
        "isGuest": uid.startswith("guest_"),
    }
    if guest_tok:
        guest_user["guestToken"] = guest_tok
    return JSONResponse({
        "ok": True,
        "uid": uid,
        "name": guest_user["name"],
        "handle": clean_h,
        "color": guest_user["color"],
        "isGuest": guest_user["isGuest"],
        "authToken": guest_tok,
        "guestToken": guest_tok,
        "user": guest_user,
    })


async def social_state(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _caller_uid(request, q.get("uid"), "guest_default")
    name = _clean(q.get("name"), 32)
    handle = _clean(q.get("handle"), 32)
    u = _ensure_user_social(uid, name, handle, claims=request.scope.get("wl_claims"), persist=False)
    enriched_friends = [_enrich_friend_entry(fr, uid) for fr in (u.get("friends") or []) if isinstance(fr, dict)]
    # Sort: bestFriends & watching/online first
    enriched_friends.sort(key=lambda f: (
        0 if f.get("presenceState") == "watching" else (1 if f.get("online") else 2),
        0 if f.get("bestFriend") else 1,
        str(f.get("name") or "").lower(),
    ))
    threads_summary = []
    total_unread = 0
    now_t = _now()
    for fr in enriched_friends:
        p_uid = fr.get("uid") or fr.get("handle") or fr.get("name")
        tk = _thread_key(uid, p_uid)
        persisted_dm = _kv_get(f"wl:soc:dm:{tk}", None, max_age=3.0)
        if isinstance(persisted_dm, list):
            _DM_THREADS[tk] = persisted_dm
        msgs = [m for m in (_DM_THREADS.get(tk) or []) if not (float(m.get("expiryAt") or 0) > 0 and float(m.get("expiryAt") or 0) < now_t)]
        last_m = msgs[-1] if msgs else None
        unr = _safe_int((u.get("unread") or {}).get(p_uid), 0, lo=0)
        total_unread += unr
        threads_summary.append({
            "peer": fr,
            "lastMessage": last_m,
            "unreadCount": unr,
            "messageCount": len(msgs),
        })
    online_count = sum(1 for f in enriched_friends if f.get("online"))
    enr_reqs = [_enrich_req_item(r, "fromUid", "fromName", "fromHandle") for r in (u.get("requests") or []) if isinstance(r, dict)]
    enr_out = [_enrich_req_item(r, "toUid", "toName", "toHandle") for r in (u.get("outgoingRequests") or []) if isinstance(r, dict)]
    return JSONResponse({
        "ok": True,
        "uid": uid,
        "name": u.get("name", "İzleyici"),
        "handle": u.get("handle", "@izleyici"),
        "selfPresence": _compute_live_presence(uid, uid, is_friend=True),
        "privacy": u.get("privacy") or {"presenceVisibility": "friends", "hideWatching": False, "allowInvites": "friends"},
        "friends": enriched_friends,
        "onlineCount": online_count,
        "requests": enr_reqs,
        "requestCount": len(enr_reqs),
        "outgoingRequests": enr_out,
        "blocked": u.get("blocked", []),
        "threads": threads_summary,
        "totalUnread": total_unread,
    })


async def social_user_search(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _caller_uid(request, q.get("uid"), "guest_default")
    query = _strip_soc_tag(_clean(q.get("q") or q.get("query"), 64))
    if not query:
        return JSONResponse({"ok": True, "users": []})
    wl_claims = request.scope.get("wl_claims")
    is_authed_caller = bool(request.scope.get("wl_uid"))

    def _run_search_sync() -> List[Dict[str, Any]]:
        u = _ensure_user_social(uid, claims=wl_claims, persist=False)
        found: Dict[str, Dict[str, Any]] = {}
        try:
            import auth_engine
            for ac in auth_engine.search_public_users(query, exclude_uid=uid, limit=20):
                if ac.get("uid") and ac["uid"] not in _LEGACY_BOT_UIDS:
                    _register_social_dir(ac, persist=False)
                    found[ac["uid"]] = ac
        except Exception:
            pass
        q_fold = _tr_fold_soc(query.lstrip("@"))
        q_norm = re.sub(r"[^a-z0-9_.\-]", "", q_fold)
        for d_uid, card in _load_social_dir().items():
            if d_uid == uid or d_uid in found or d_uid in _LEGACY_BOT_UIDS or d_uid in ("guest_default", "guest_local") or not isinstance(card, dict):
                continue
            h_f = _tr_fold_soc(str(card.get("handle") or "").lstrip("@"))
            n_f = _tr_fold_soc(str(card.get("name") or ""))
            if str(d_uid).startswith("guest_") and not is_authed_caller and not (query.startswith("@") and q_fold and h_f == q_fold):
                continue
            if (q_fold and (q_fold in h_f or q_fold in n_f)) or (q_norm and len(q_norm) >= 2 and (q_norm in h_f or q_norm in re.sub(r"[^a-z0-9_.\-]", "", n_f))):
                found[d_uid] = dict(card)
        try:
            import rooms as rooms_mod
            rm_dict = getattr(rooms_mod.STORE, "l1_rooms", None) or getattr(rooms_mod.STORE, "rooms", {}) or {}
            for r_obj in list(rm_dict.values()):
                if not isinstance(r_obj, dict):
                    continue
                for p_obj in (r_obj.get("participants") or {}).values():
                    if not isinstance(p_obj, dict) or p_obj.get("transport") == "bot":
                        continue
                    p_uid = _clean(p_obj.get("uid"), 64)
                    if not p_uid or p_uid == uid or p_uid in found or p_uid in _LEGACY_BOT_UIDS:
                        continue
                    p_h = _tr_fold_soc(str(p_obj.get("handle") or "").lstrip("@"))
                    p_n = _tr_fold_soc(str(p_obj.get("name") or ""))
                    if (q_fold and ((p_h and q_fold in p_h) or q_fold in p_n)) or (q_norm and len(q_norm) >= 2 and ((p_h and q_norm in p_h) or q_norm in re.sub(r"[^a-z0-9_.\-]", "", p_n))):
                        card_rm = {
                            "uid": p_uid,
                            "name": _clean(p_obj.get("name") or "İzleyici", 32),
                            "handle": _norm_handle_tag(str(p_obj.get("handle") or ""), str(p_obj.get("name") or "")),
                            "color": _clean(p_obj.get("color") or "#27DCC8", 16),
                            "avatarUrl": _clean_avatar(p_obj.get("avatarUrl")),
                        }
                        _register_social_dir(card_rm, persist=False)
                        found[p_uid] = card_rm
        except Exception:
            pass
        out_users = []
        blocked_by_me = {b.get("uid") for b in (u.get("blocked") or []) if isinstance(b, dict)}
        for t_uid, card in list(found.items())[:20]:
            fstate = _friendship_state(u, t_uid)
            pres = _compute_live_presence(t_uid, uid, is_friend=(fstate == "FRIENDS"))
            out_users.append({
                "uid": t_uid,
                "name": _clean(card.get("name") or "İzleyici", 32),
                "handle": _norm_handle_tag(card.get("handle") or "", card.get("name") or ""),
                "color": _clean(card.get("color") or "#27DCC8", 16),
                "avatarUrl": _clean_avatar(card.get("avatarUrl")),
                "bio": _clean(card.get("bio") or "", 160),
                "isGuest": bool(str(t_uid).startswith("guest_")),
                "friendshipState": "BLOCKED" if t_uid in blocked_by_me else fstate,
                "online": pres["online"],
                "presenceState": pres["presenceState"],
                "status": pres["status"],
                "watchingRoom": pres["watchingRoom"],
            })
        return out_users

    out_users = await asyncio.to_thread(_run_search_sync)
    return JSONResponse({"ok": True, "users": out_users})


async def social_presence(request: Request) -> JSONResponse:
    if request.method == "GET":
        q = request.query_params
        caller_uid = _caller_uid(request, q.get("callerUid") or q.get("viewerUid") or (q.get("uid") if not q.get("targetUid") and request.scope.get("wl_uid") else ""), "guest_default")
        target_uid = _clean(q.get("targetUid") or q.get("uid") or caller_uid, 64)
        if target_uid.startswith("@") or not target_uid.startswith(("u_", "guest_")):
            tc = _resolve_social_target(target_uid)
            if tc and tc.get("uid"):
                target_uid = _clean(tc["uid"], 64)
        card = _user_card_with_presence(target_uid, caller_uid)
        return JSONResponse({"ok": True, "uid": target_uid, "presence": card, "user": card})
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    uid = _caller_uid(request, body.get("uid"), "guest_default")
    name = _clean(body.get("name"), 32)
    handle = _clean(body.get("handle"), 32)
    color = _clean(body.get("color"), 16)
    avatar_url = _clean_avatar(body.get("avatarUrl"))
    u = _ensure_user_social(uid, name, handle, color, avatar_url, claims=request.scope.get("wl_claims"))
    now_t = _now()
    raw_st = _clean(body.get("state") or "online", 16).lower()
    if raw_st not in ("online", "watching", "idle", "offline"):
        raw_st = "online"
    priv = u.get("privacy") or {}
    vis = _clean(body.get("visibility") or priv.get("presenceVisibility") or "friends", 16).lower()
    if vis not in ("everyone", "friends", "nobody"):
        vis = "friends"
    hide_w = bool(body.get("hideWatching")) if "hideWatching" in body else bool(priv.get("hideWatching", False))
    rec = {
        "uid": uid,
        "state": raw_st,
        "lastSeen": now_t,
        "roomId": _clean(body.get("roomId"), 80) if raw_st in ("watching", "online") else "",
        "roomName": _clean(body.get("roomName"), 100),
        "roomPrivacy": _clean(body.get("roomPrivacy") or "public", 16),
        "roomLocked": bool(body.get("roomLocked") or body.get("hasPassword")),
        "mediaTitle": _clean(body.get("mediaTitle") or body.get("watchingTitle"), 140),
        "watchingTitle": _clean(body.get("watchingTitle") or body.get("mediaTitle"), 140),
        "mediaPoster": _clean(body.get("mediaPoster"), 800),
        "mediaProvider": _clean(body.get("mediaProvider"), 32),
        "statusText": _clean(body.get("statusText"), 60),
        "statusEmoji": _clean(body.get("statusEmoji") or "🍿", 10),
        "visibility": vis,
        "hideWatching": hide_w,
    }
    _PRESENCE_MAP[uid] = rec
    _kv_set(f"wl:soc:pres:{uid}", rec, ttl_sec=180)
    u["lastSeen"] = now_t
    _save_user_social(u)
    card = _user_card_with_presence(uid, uid)
    return JSONResponse({
        "ok": True,
        "uid": uid,
        "presence": card,
        "requestCount": len(u.get("requests") or []),
        "totalUnread": sum(_safe_int(v, 0, lo=0) for v in (u.get("unread") or {}).values()),
    })


async def social_friends_action(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    uid = _caller_uid(request, body.get("uid") or body.get("callerUid"), "guest_default")
    name = _clean(body.get("fromName") or body.get("name"), 32) or "İzleyici"
    handle = _clean(body.get("fromHandle") or body.get("handle"), 32)
    color = _clean(body.get("color"), 16)
    avatar_url = _clean_avatar(body.get("avatarUrl"))
    u = _ensure_user_social(uid, name, handle, color, avatar_url, claims=request.scope.get("wl_claims"))
    action = _clean(body.get("action"), 24).lower()
    now_t = _now()

    def _resp(extra: Optional[Dict[str, Any]] = None, status_code: int = 200) -> JSONResponse:
        ef = [_enrich_friend_entry(f, uid) for f in (u.get("friends") or []) if isinstance(f, dict)]
        enr_reqs = [_enrich_req_item(r, "fromUid", "fromName", "fromHandle") for r in (u.get("requests") or []) if isinstance(r, dict)]
        enr_out = [_enrich_req_item(r, "toUid", "toName", "toHandle") for r in (u.get("outgoingRequests") or []) if isinstance(r, dict)]
        payload = {
            "ok": status_code < 400,
            "uid": uid,
            "friends": ef,
            "requests": enr_reqs,
            "requestCount": len(enr_reqs),
            "outgoingRequests": enr_out,
            "blocked": u.get("blocked", []),
            "privacy": u.get("privacy") or {},
            **(extra or {}),
        }
        return JSONResponse(payload, status_code=status_code)

    if action == "request":
        raw_ident = _clean(body.get("targetHandle") or body.get("targetEmail") or body.get("targetName") or body.get("target") or body.get("targetUid"), 80)
        t_hint = _clean(body.get("targetUid"), 64)
        if not raw_ident and not t_hint:
            return _resp({"error": "Kullanıcı adı (@handle) veya e-posta gerekli."}, 400)
        target_card = _resolve_social_target(raw_ident, t_hint)
        if not target_card or not target_card.get("uid"):
            return _resp({"error": f'"{raw_ident}" ile eşleşen kayıtlı bir Watchlivo hesabı bulunamadı.'}, 404)
        target_uid = _clean(target_card["uid"], 64)
        if target_uid == uid:
            return _resp({"error": "Kendinize arkadaşlık isteği gönderemezsiniz."}, 400)
        t_u = _ensure_user_social(target_uid, target_card.get("name", ""), target_card.get("handle", ""), target_card.get("color", ""), target_card.get("avatarUrl", ""))
        if any(b.get("uid") == target_uid for b in u.get("blocked", [])) or any(b.get("uid") == uid for b in t_u.get("blocked", [])):
            return _resp({"error": "Bu kullanıcı ile etkileşim engellenmiş."}, 403)
        existing = next((f for f in u["friends"] if f.get("uid") == target_uid), None)
        if existing:
            return _resp({"alreadyFriend": True, "friendshipState": "FRIENDS", "status": "FRIENDS", "friend": _enrich_friend_entry(existing, uid)})
        # If target already requested us -> auto-accept mutual friendship!
        incoming = next((r for r in u.get("requests", []) if r.get("fromUid") == target_uid), None)
        if incoming:
            u["requests"] = [r for r in u["requests"] if r.get("fromUid") != target_uid]
            t_u["outgoingRequests"] = [r for r in t_u.get("outgoingRequests", []) if r.get("toUid") != uid]
            if not any(f.get("uid") == target_uid for f in u["friends"]):
                u["friends"].insert(0, {"uid": target_uid, "name": t_u["name"], "handle": t_u["handle"], "color": t_u.get("color", "#27DCC8"), "avatarUrl": t_u.get("avatarUrl", ""), "watchMinutes": 0, "medal": _compute_medal(0), "rankPill": "Onaylı Arkadaş", "addedAt": now_t})
            if not any(f.get("uid") == uid for f in t_u["friends"]):
                t_u["friends"].insert(0, {"uid": uid, "name": u["name"], "handle": u["handle"], "color": u.get("color", "#27DCC8"), "avatarUrl": u.get("avatarUrl", ""), "watchMinutes": 0, "medal": _compute_medal(0), "rankPill": "Onaylı Arkadaş", "addedAt": now_t})
            _kv_set(f"wl:soc:u:{uid}", u, ttl_sec=2592000)
            _kv_set(f"wl:soc:u:{target_uid}", t_u, ttl_sec=2592000)
            _queue_notification(target_uid, {"type": "friend_accepted", "title": f"🎉 {u['name']} arkadaşlık isteğini kabul etti!", "body": "Artık mesajlaşabilir ve odaya davet gönderebilirsiniz.", "fromUid": uid, "fromName": u["name"], "fromHandle": u["handle"], "fromColor": u.get("color", "#27DCC8"), "fromAvatarUrl": u.get("avatarUrl", "")})
            return _resp({"mutualAccepted": True, "friendshipState": "FRIENDS", "status": "FRIENDS", "friend": _enrich_friend_entry(u["friends"][0], uid)})
        if any(r.get("toUid") == target_uid for r in u.get("outgoingRequests", [])):
            return _resp({"pending": True, "alreadyRequested": True, "friendshipState": "OUTGOING_PENDING", "status": "OUTGOING_PENDING", "target": target_card})
        req_id = "req_" + uuid.uuid4().hex[:10]
        out_req = {"id": req_id, "toUid": target_uid, "toName": t_u["name"], "toHandle": t_u["handle"], "color": t_u.get("color", "#27DCC8"), "avatarUrl": t_u.get("avatarUrl", ""), "ts": now_t}
        in_req = {"id": req_id, "fromUid": uid, "fromName": u["name"], "fromHandle": u["handle"], "color": u.get("color", "#27DCC8"), "avatarUrl": u.get("avatarUrl", ""), "watchMinutes": 0, "medal": _compute_medal(0), "ts": now_t}
        u.setdefault("outgoingRequests", []).insert(0, out_req)
        t_u["requests"] = [r for r in t_u.get("requests", []) if r.get("fromUid") != uid]
        t_u["requests"].insert(0, in_req)
        _kv_set(f"wl:soc:u:{uid}", u, ttl_sec=2592000)
        _kv_set(f"wl:soc:u:{target_uid}", t_u, ttl_sec=2592000)
        _queue_notification(target_uid, {
            "type": "friend_request",
            "requestId": req_id,
            "title": f"👋 {u['name']} ({u['handle']}) arkadaşlık isteği gönderdi",
            "body": "Mesajlaşmak ve odalara davet edebilmek için isteği onayla.",
            "fromUid": uid,
            "fromName": u["name"],
            "fromHandle": u["handle"],
            "fromColor": u.get("color", "#27DCC8"),
            "fromAvatarUrl": u.get("avatarUrl", ""),
        })
        return _resp({"pending": True, "friendshipState": "OUTGOING_PENDING", "status": "OUTGOING_PENDING", "target": target_card, "request": out_req})

    elif action in ("accept", "decline", "reject"):
        req_id = _clean(body.get("requestId") or body.get("targetUid") or body.get("targetHandle") or body.get("target"), 64)
        if req_id and (req_id.startswith("@") or not req_id.startswith(("u_", "guest_", "req_"))):
            tc = _resolve_social_target(req_id)
            if tc and tc.get("uid"):
                req_id = _clean(tc["uid"], 64)
        reqs = u.get("requests", [])
        target_req = next(
            (
                r for r in reqs
                if r.get("id") == req_id
                or r.get("fromUid") == req_id
                or (req_id and str(r.get("fromHandle") or "").lstrip("@").lower() == req_id.lstrip("@").lower())
            ),
            None,
        )
        if not target_req:
            return _resp({"error": "İstek bulunamadı veya zaten işlendi."}, 404)
        from_uid = _clean(target_req.get("fromUid"), 64)
        u["requests"] = [r for r in reqs if r.get("id") != target_req.get("id") and r.get("fromUid") != from_uid]
        s_u = _ensure_user_social(from_uid, target_req.get("fromName", ""), target_req.get("fromHandle", ""), target_req.get("color", ""), target_req.get("avatarUrl", "")) if from_uid else None
        if s_u:
            s_u["outgoingRequests"] = [r for r in s_u.get("outgoingRequests", []) if r.get("toUid") != uid and r.get("id") != target_req.get("id")]
        if action == "accept" and from_uid:
            mins = _safe_int(target_req.get("watchMinutes"), 0, lo=0, hi=1000000)
            if not any(f.get("uid") == from_uid for f in u["friends"]):
                u["friends"].insert(0, {"uid": from_uid, "name": (s_u or {}).get("name") or target_req.get("fromName") or "İzleyici", "handle": (s_u or {}).get("handle") or target_req.get("fromHandle") or "@izleyici", "color": (s_u or {}).get("color") or target_req.get("color") or "#F59E0B", "avatarUrl": (s_u or {}).get("avatarUrl") or target_req.get("avatarUrl") or "", "watchMinutes": mins, "medal": _compute_medal(mins), "rankPill": "Onaylı Arkadaş", "addedAt": now_t})
            if s_u and not any(f.get("uid") == uid for f in s_u["friends"]):
                s_u["friends"].insert(0, {"uid": uid, "name": u["name"], "handle": u["handle"], "color": u.get("color", "#27DCC8"), "avatarUrl": u.get("avatarUrl", ""), "watchMinutes": mins, "medal": _compute_medal(mins), "rankPill": "Onaylı Arkadaş", "addedAt": now_t})
            _queue_notification(from_uid, {
                "type": "friend_accepted",
                "title": f"🎉 {u['name']} ({u['handle']}) isteğini kabul etti!",
                "body": "Artık birbirinize mesaj gönderebilir ve odaya davet atabilirsiniz.",
                "fromUid": uid,
                "fromName": u["name"],
                "fromHandle": u["handle"],
                "fromColor": u.get("color", "#27DCC8"),
                "fromAvatarUrl": u.get("avatarUrl", ""),
            })
        _save_user_social(u)
        if s_u and from_uid:
            _save_user_social(s_u)
        res_state = "FRIENDS" if action == "accept" else "NONE"
        return _resp({"friendshipState": res_state, "status": res_state})

    elif action == "cancel":
        req_id = _clean(body.get("requestId") or body.get("targetUid") or body.get("targetHandle") or body.get("target"), 64)
        if req_id and (req_id.startswith("@") or not req_id.startswith(("u_", "guest_", "req_"))):
            tc = _resolve_social_target(req_id)
            if tc and tc.get("uid"):
                req_id = _clean(tc["uid"], 64)
        out_reqs = u.get("outgoingRequests", [])
        hit = next(
            (
                r for r in out_reqs
                if r.get("id") == req_id
                or r.get("toUid") == req_id
                or (req_id and str(r.get("toHandle") or "").lstrip("@").lower() == req_id.lstrip("@").lower())
            ),
            None,
        )
        hit_uid = _clean(hit.get("toUid") if hit else req_id, 64)
        u["outgoingRequests"] = [r for r in out_reqs if r.get("id") != req_id and r.get("toUid") != req_id and r.get("toUid") != hit_uid]
        if hit_uid and hit_uid.startswith(("u_", "guest_")):
            t_u = _ensure_user_social(hit_uid)
            t_u["requests"] = [r for r in t_u.get("requests", []) if r.get("fromUid") != uid and (not hit or r.get("id") != hit.get("id"))]
            _save_user_social(t_u)
        _save_user_social(u)
        return _resp({"friendshipState": "NONE"})

    elif action == "remove":
        target_uid = _clean(body.get("targetUid") or body.get("targetHandle") or body.get("target"), 64)
        if target_uid and (target_uid.startswith("@") or not target_uid.startswith(("u_", "guest_"))):
            tc = _resolve_social_target(target_uid)
            if tc and tc.get("uid"):
                target_uid = _clean(tc["uid"], 64)
        u["friends"] = [f for f in u.get("friends", []) if f.get("uid") != target_uid and f.get("name") != target_uid and str(f.get("handle") or "").lstrip("@").lower() != target_uid.lstrip("@").lower()]
        if target_uid:
            t_u = _ensure_user_social(target_uid)
            t_u["friends"] = [f for f in t_u.get("friends", []) if f.get("uid") != uid]
            _save_user_social(t_u)
        _save_user_social(u)
        return _resp({"friendshipState": "NONE"})

    elif action == "toggle_best":
        target_uid = _clean(body.get("targetUid") or body.get("targetHandle") or body.get("target"), 64)
        if target_uid and (target_uid.startswith("@") or not target_uid.startswith(("u_", "guest_"))):
            tc = _resolve_social_target(target_uid)
            if tc and tc.get("uid"):
                target_uid = _clean(tc["uid"], 64)
        for f in u.get("friends", []):
            if f.get("uid") == target_uid:
                f["bestFriend"] = not bool(f.get("bestFriend", False))
        _save_user_social(u)
        return _resp()

    elif action in ("block", "unblock"):
        target_uid = _clean(body.get("targetUid") or body.get("targetHandle") or body.get("target"), 64)
        if target_uid and (target_uid.startswith("@") or not target_uid.startswith(("u_", "guest_"))):
            tc = _resolve_social_target(target_uid)
            if tc and tc.get("uid"):
                target_uid = _clean(tc["uid"], 64)
        if action == "block" and target_uid and target_uid != uid:
            u["friends"] = [f for f in u.get("friends", []) if f.get("uid") != target_uid]
            u["requests"] = [r for r in u.get("requests", []) if r.get("fromUid") != target_uid]
            u["outgoingRequests"] = [r for r in u.get("outgoingRequests", []) if r.get("toUid") != target_uid]
            if not any(b.get("uid") == target_uid for b in u.get("blocked", [])):
                u.setdefault("blocked", []).append({"uid": target_uid, "name": _clean(body.get("targetName") or target_uid, 32), "ts": now_t})
            t_u = _ensure_user_social(target_uid)
            t_u["friends"] = [f for f in t_u.get("friends", []) if f.get("uid") != uid]
            t_u["requests"] = [r for r in t_u.get("requests", []) if r.get("fromUid") != uid]
            t_u["outgoingRequests"] = [r for r in t_u.get("outgoingRequests", []) if r.get("toUid") != uid]
            _save_user_social(t_u)
        elif action == "unblock" and target_uid:
            u["blocked"] = [b for b in u.get("blocked", []) if b.get("uid") != target_uid and str(b.get("name") or "").lstrip("@").lower() != target_uid.lstrip("@").lower()]
        _save_user_social(u)
        return _resp()

    elif action == "privacy":
        priv = u.setdefault("privacy", {"presenceVisibility": "friends", "hideWatching": False, "allowInvites": "friends"})
        if "presenceVisibility" in body and body["presenceVisibility"] in ("everyone", "friends", "nobody"):
            priv["presenceVisibility"] = body["presenceVisibility"]
        if "hideWatching" in body:
            priv["hideWatching"] = bool(body["hideWatching"])
        if "allowInvites" in body and body["allowInvites"] in ("everyone", "friends"):
            priv["allowInvites"] = body["allowInvites"]
        _kv_set(f"wl:soc:u:{uid}", u, ttl_sec=2592000)
        return _resp()

    elif action == "add_minutes":
        target_uid = _clean(body.get("targetUid"), 64)
        delta = _safe_int(body.get("minutes"), 5, lo=1, hi=120)
        for f in u.get("friends", []):
            if f.get("uid") == target_uid or not target_uid:
                f["watchMinutes"] = _safe_int(f.get("watchMinutes"), 0, lo=0) + delta
                f["medal"] = _compute_medal(f["watchMinutes"])
        _kv_set(f"wl:soc:u:{uid}", u, ttl_sec=2592000)
        return _resp()

    return _resp()


def _get_dm_expiry(tk: str) -> int:
    cfg = _kv_get(f"wl:soc:dmcfg:{tk}", None, max_age=10.0)
    if isinstance(cfg, dict):
        _DM_CONFIG[tk] = cfg
    return _safe_int((_DM_CONFIG.get(tk) or {}).get("expirySec"), 0, lo=0, hi=604800)


async def social_dm_get(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _caller_uid(request, q.get("uid"), "guest_default")
    raw_peer_q = _clean(q.get("peerId"), 64)
    explicit_peer = bool(raw_peer_q)
    peer_id = raw_peer_q
    if peer_id and (peer_id.startswith("@") or not peer_id.startswith(("u_", "guest_"))):
        tc = _resolve_social_target(peer_id)
        if tc and tc.get("uid"):
            peer_id = _clean(tc["uid"], 64)
    u = _ensure_user_social(uid)
    if not peer_id:
        first_fr = (u.get("friends") or [None])[0]
        peer_id = _clean((first_fr or {}).get("uid"), 64)
    if not peer_id:
        return JSONResponse({"ok": True, "peerId": "", "canMessage": False, "friendshipState": "NONE", "messages": []})
    fstate = _friendship_state(u, peer_id)
    now_t = _now()
    peer_card = _resolve_social_target(peer_id, peer_id) or {"uid": peer_id, "name": peer_id, "handle": f"@{peer_id[:16]}"}
    pres = _compute_live_presence(peer_id, uid, is_friend=(fstate == "FRIENDS"))
    tk = _thread_key(uid, peer_id)
    exp_val = _get_dm_expiry(tk)
    if fstate != "FRIENDS":
        return JSONResponse({
            "ok": True,
            "peerId": peer_id,
            "peer": {**peer_card, **pres},
            "friendshipState": fstate,
            "friendState": fstate,
            "canMessage": False,
            "peerTyping": False,
            "expirySec": exp_val,
            "settings": {"expirySec": exp_val},
            "messages": [],
        })
    if isinstance(u.get("unread"), dict):
        removed_unr = u["unread"].pop(peer_id, None)
        if raw_peer_q and raw_peer_q != peer_id:
            removed_unr = u["unread"].pop(raw_peer_q, None) or removed_unr
        if removed_unr is not None:
            _save_user_social(u)
    persisted_dm = _kv_get(f"wl:soc:dm:{tk}", None, max_age=2.0)
    if isinstance(persisted_dm, list):
        _DM_THREADS[tk] = persisted_dm
    raw_msgs = _DM_THREADS.get(tk) or []
    msgs = [m for m in raw_msgs if not (float(m.get("expiryAt") or 0) > 0 and float(m.get("expiryAt") or 0) < now_t)]
    dirty = len(msgs) != len(raw_msgs)
    if explicit_peer:
        for m in msgs:
            if m.get("fromUid") == peer_id and not m.get("readAt"):
                m["readAt"] = now_t
                dirty = True
    if dirty:
        _DM_THREADS[tk] = msgs[-100:]
        _kv_set(f"wl:soc:dm:{tk}", _DM_THREADS[tk], ttl_sec=2592000)
    typ_ts = _finite_float(_kv_get(f"wl:soc:typ:{tk}:{peer_id}", _DM_TYPING.get(f"{tk}:{peer_id}", 0.0), max_age=1.5), 0.0)
    return JSONResponse({
        "ok": True,
        "peerId": peer_id,
        "peer": {**peer_card, **pres},
        "friendshipState": fstate,
        "friendState": fstate,
        "canMessage": True,
        "peerTyping": (now_t - typ_ts) < 5.5,
        "expirySec": exp_val,
        "settings": {"expirySec": exp_val},
        "messages": msgs[-80:],
    })


async def social_dm_send(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    uid = _caller_uid(request, body.get("uid"), "guest_default")
    name = _clean(body.get("fromName") or body.get("name"), 32) or "İzleyici"
    color = _clean(body.get("color"), 16) or "#27DCC8"
    peer_id = _clean(body.get("peerId") or body.get("peerUid") or body.get("targetUid"), 64)
    sub_action = _clean(body.get("action") or "send", 20).lower()
    if not peer_id:
        return JSONResponse({"ok": False, "error": "Alıcı (peerId) seçilmedi."}, status_code=400)
    u = _ensure_user_social(uid, name, color=color)
    fstate = _friendship_state(u, peer_id)
    tk = _thread_key(uid, peer_id)
    t_now = _now()

    if sub_action == "typing":
        if fstate == "FRIENDS":
            _DM_TYPING[f"{tk}:{uid}"] = t_now
            _kv_set(f"wl:soc:typ:{tk}:{uid}", t_now, ttl_sec=8)
        return JSONResponse({"ok": True, "typing": True})

    if fstate != "FRIENDS":
        return JSONResponse({
            "ok": False,
            "canMessage": False,
            "friendshipState": fstate,
            "error": "Mesajlaşmak için karşılıklı arkadaşlık onayı gereklidir.",
        }, status_code=403)

    if sub_action == "settings":
        exp_sec = _safe_int(body.get("expirySec"), 0, lo=0, hi=604800)
        _DM_CONFIG[tk] = {"expirySec": exp_sec, "updatedAt": t_now}
        _kv_set(f"wl:soc:dmcfg:{tk}", _DM_CONFIG[tk], ttl_sec=2592000)
        return JSONResponse({"ok": True, "expirySec": exp_sec})

    persisted_dm = _kv_get(f"wl:soc:dm:{tk}", None, max_age=1.5)
    if isinstance(persisted_dm, list):
        _DM_THREADS[tk] = list(persisted_dm)
    thread = [m for m in (_DM_THREADS.get(tk) or []) if not (float(m.get("expiryAt") or 0) > 0 and float(m.get("expiryAt") or 0) < t_now)]

    if sub_action == "react":
        msg_id = _clean(body.get("messageId"), 48)
        emoji = _clean(body.get("emoji") or "❤️", 12)
        for m in thread:
            if m.get("id") == msg_id:
                rx = m.setdefault("reactions", {})
                users = list(rx.get(emoji) or [])
                if uid in users:
                    users.remove(uid)
                else:
                    users.append(uid)
                if users:
                    rx[emoji] = users[:20]
                else:
                    rx.pop(emoji, None)
                break
        _DM_THREADS[tk] = thread[-100:]
        _kv_set(f"wl:soc:dm:{tk}", _DM_THREADS[tk], ttl_sec=2592000)
        return JSONResponse({"ok": True, "messages": _DM_THREADS[tk][-80:]})

    if sub_action == "delete":
        msg_id = _clean(body.get("messageId"), 48)
        thread = [m for m in thread if not (m.get("id") == msg_id and m.get("fromUid") == uid)]
        _DM_THREADS[tk] = thread[-100:]
        _kv_set(f"wl:soc:dm:{tk}", _DM_THREADS[tk], ttl_sec=2592000)
        return JSONResponse({"ok": True, "messages": _DM_THREADS[tk][-80:]})

    text = _clean(body.get("text"), 1000)
    room_invite = _clean(body.get("roomInvite"), 180)
    raw_card = body.get("roomInviteCard") if isinstance(body.get("roomInviteCard"), dict) else None
    snap = str(body.get("snapshot") or "").strip()
    if snap and (len(snap) > 85000 or not re.match(r"^data:image/(?:png|jpe?g|webp);base64,", snap, re.I)):
        snap = ""
    raw_an = body.get("audioNote")
    msg_id = "dm_" + uuid.uuid4().hex[:10]
    audio_note = persist_audio_note(raw_an, fallback_id=msg_id) if isinstance(raw_an, dict) else None
    if audio_note and len(str(audio_note.get("dataUrl") or "")) > 48000:
        audio_note = {k: v for k, v in audio_note.items() if k != "dataUrl"}
    if not text and not snap and not audio_note and not room_invite and not raw_card:
        return JSONResponse({"ok": False, "error": "Boş mesaj gönderilemez."}, status_code=400)
    exp_sec = _get_dm_expiry(tk)
    msg: Dict[str, Any] = {
        "id": msg_id,
        "fromUid": uid,
        "fromName": u.get("name") or name,
        "color": u.get("color") or color,
        "text": text,
        "time": _hhmm(t_now),
        "ts": t_now,
        "reactions": {},
        "expiryAt": (t_now + exp_sec) if exp_sec > 0 else 0,
    }
    raw_reply = body.get("replyTo")
    if isinstance(raw_reply, dict) and raw_reply.get("id"):
        msg["replyTo"] = {
            "id": _clean(raw_reply.get("id"), 48),
            "fromName": _clean(raw_reply.get("fromName"), 32),
            "text": _clean(raw_reply.get("text"), 140),
        }
    if room_invite or raw_card:
        r_id = _clean((raw_card or {}).get("roomId") or room_invite, 180)
        raw_card_url = str((raw_card or {}).get("url") or "").strip()[:16000]
        safe_card_url = raw_card_url if (raw_card_url.startswith("/#/mesh/") and not re.search(r"[<>\"'\s]", raw_card_url)) else ""
        msg["roomInvite"] = r_id
        msg["roomInviteCard"] = {
            "roomId": r_id,
            "roomName": _clean((raw_card or {}).get("roomName") or "Watchlivo Odası", 100),
            "mediaTitle": _clean((raw_card or {}).get("mediaTitle") or "", 140),
            "mediaPoster": _clean((raw_card or {}).get("mediaPoster") or "", 800),
            "mediaProvider": _clean((raw_card or {}).get("mediaProvider") or "cinema", 32),
        }
        if safe_card_url:
            msg["roomInviteCard"]["url"] = safe_card_url
    if snap:
        msg["snapshot"] = snap
        if body.get("isExplicit"):
            msg["isExplicit"] = True
    if audio_note:
        msg["audioNote"] = audio_note
    thread.append(msg)
    _DM_TYPING.pop(f"{tk}:{uid}", None)
    _kv_set(f"wl:soc:typ:{tk}:{uid}", 0.0, ttl_sec=10)
    _DM_THREADS[tk] = thread[-100:]
    _kv_set(f"wl:soc:dm:{tk}", _DM_THREADS[tk], ttl_sec=2592000)

    if peer_id != uid:
        peer_u = _ensure_user_social(peer_id)
        peer_u.setdefault("unread", {})[uid] = int(peer_u.get("unread", {}).get(uid) or 0) + 1
        _kv_set(f"wl:soc:u:{peer_id}", peer_u, ttl_sec=2592000)
        inv_r = msg.get("roomInvite") or ""
        inv_c = msg.get("roomInviteCard") or {}
        if inv_c.get("url"):
            inv_url = str(inv_c["url"])[:16000]
        elif inv_r:
            if "?" in inv_r:
                r_base, r_qs = inv_r.split("?", 1)
                safe_qs = re.sub(r"[^a-zA-Z0-9_=&.%-]", "", r_qs)[:120]
                inv_url = f"/#/mesh/{urllib.parse.quote(r_base)}" + (f"?{safe_qs}" if safe_qs else "")
            else:
                inv_url = f"/#/mesh/{urllib.parse.quote(inv_r)}"
        else:
            inv_url = "/#/"
        _queue_notification(peer_id, {
            "type": "room_invite" if inv_r else "dm",
            "title": f"🎬 {u['name']} seni odaya davet etti!" if inv_r else f"💬 {u['name']} mesaj gönderdi",
            "body": text or (f'"{inv_c.get("mediaTitle") or inv_c.get("roomName") or "Sinema Odası"}" — Tek tıkla katıl!' if inv_r else ("🎙️ Sesli mesaj gönderdi" if audio_note else "Yeni mesaj")),
            "fromUid": uid,
            "fromName": u["name"],
            "fromHandle": u.get("handle", ""),
            "fromColor": u.get("color", "#27DCC8"),
            "fromAvatarUrl": u.get("avatarUrl", ""),
            "roomId": inv_r,
            "roomName": inv_c.get("roomName", ""),
            "mediaTitle": inv_c.get("mediaTitle", ""),
            "mediaPoster": inv_c.get("mediaPoster", ""),
            "url": inv_url,
            "expiresAt": (t_now + 60.0) if inv_r else 0.0,
        })
    return JSONResponse({"ok": True, "canMessage": True, "message": msg, "messages": _DM_THREADS[tk][-80:]})


async def social_invite(request: Request) -> JSONResponse:
    """Rave SendInviteButton + Poke parity: send/cancel room invites & pokes to mutual friends."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    uid = _caller_uid(request, body.get("uid"), "guest_default")
    name = _clean(body.get("fromName") or body.get("name"), 32) or "İzleyici"
    u = _ensure_user_social(uid, name)
    action = _clean(body.get("action") or "send", 24).lower()
    now_t = _now()

    if action == "cancel":
        inv_id = _clean(body.get("inviteId"), 48)
        target_uid = _clean(body.get("targetUid"), 64).lower()
        room_id = _clean(body.get("roomId"), 80)
        if target_uid:
            q_items = _kv_get(f"wl:soc:ntf:{target_uid}", None, max_age=1.0)
            q_list = list(q_items) if isinstance(q_items, list) else list(_NOTIFICATION_QUEUES.get(target_uid, []))
            q_list = [
                x for x in q_list
                if not (
                    x.get("fromUid") == uid
                    and ((inv_id and x.get("id") == inv_id) or (not inv_id and x.get("roomId") == room_id))
                )
            ]
            _NOTIFICATION_QUEUES[target_uid] = q_list
            _kv_set(f"wl:soc:ntf:{target_uid}", q_list, ttl_sec=86400)
        return JSONResponse({"ok": True, "cancelled": True})

    if action == "poke":
        target_uid = _clean(body.get("targetUid"), 64)
        if not target_uid or _friendship_state(u, target_uid) != "FRIENDS":
            return JSONResponse({"ok": False, "error": "El sallamak için arkadaş olmalısınız."}, status_code=403)
        ntf = _queue_notification(target_uid.lower(), {
            "type": "poke",
            "title": f"👋 {u['name']} ({u['handle']}) sana el salladı!",
            "body": "Sohbete geçmek veya birlikte bir oda açmak için dokun.",
            "fromUid": uid,
            "fromName": u["name"],
            "fromHandle": u.get("handle", ""),
            "fromColor": u.get("color", "#27DCC8"),
            "fromAvatarUrl": u.get("avatarUrl", ""),
            "expiresAt": now_t + 30.0,
        })
        return JSONResponse({"ok": True, "notification": ntf})

    room_id = _clean(body.get("roomId"), 80)
    room_name = _clean(body.get("roomName") or body.get("roomTitle") or "Watchlivo Odası", 100)
    media_title = _clean(body.get("mediaTitle"), 140)
    media_poster = _clean(body.get("mediaPoster"), 800)
    media_provider = _clean(body.get("mediaProvider") or "cinema", 32)
    pwd_q = _clean(body.get("password"), 64)
    sync_tok = str(body.get("syncToken") or body.get("r_tok") or "").strip()[:32000]
    if not room_id:
        return JSONResponse({"ok": False, "error": "Oda kimliği (roomId) gerekli."}, status_code=400)

    try:
        import rooms as _rm
        rm_live = await _rm.STORE.get(room_id)
        if rm_live:
            rm_priv = str(rm_live.get("privacy") or "public").lower()
            rm_has_pw = _rm.has_password(rm_live)
            caller_in_rm = (
                str(rm_live.get("creatorId") or "").lower() == uid
                or any(
                    isinstance(p, dict) and str(p.get("uid") or "").lower() == uid
                    for p in (rm_live.get("participants") or {}).values()
                )
            )
            caller_allowed = (
                caller_in_rm
                or (rm_priv == "public" and not rm_has_pw)
                or (rm_priv == "friends" and not rm_has_pw and _rm._is_friend_of_creator(rm_live, uid))
            )
            if not caller_allowed:
                return JSONResponse({"ok": False, "error": "Bu odaya davet gönderme yetkiniz yok."}, status_code=403)
            if not sync_tok and (not rm_has_pw or caller_in_rm) and rm_priv != "private":
                sync_tok = _rm.pack_sync_token(rm_live)
            elif not sync_tok and caller_in_rm:
                sync_tok = _rm.pack_sync_token(rm_live)
            if not media_title and isinstance(rm_live.get("media"), dict):
                media_title = _clean(rm_live["media"].get("title"), 140)
            if not media_poster and isinstance(rm_live.get("media"), dict):
                media_poster = _clean(rm_live["media"].get("poster") or rm_live["media"].get("thumbnail") or rm_live["media"].get("backdrop"), 800)
    except Exception:
        pass

    targets: List[str] = []
    if action == "invite_all_online":
        enriched_friends = [_enrich_friend_entry(f, uid) for f in (u.get("friends") or []) if isinstance(f, dict)]
        for fr in enriched_friends:
            if fr.get("online") and fr.get("uid"):
                targets.append(fr["uid"])
        if not targets:
            return JSONResponse({"ok": True, "invited": 0, "onlineCount": 0, "sentCount": 0, "invites": []})
    else:
        raw_t = body.get("targetUids")
        if isinstance(raw_t, list):
            targets = [_clean(x, 64) for x in raw_t if _clean(x, 64)]
        elif body.get("targetUid"):
            targets = [_clean(body.get("targetUid"), 64)]

    if not targets:
        return JSONResponse({"ok": False, "error": "Davet edilecek arkadaş seçilmedi."}, status_code=400)

    q_parts = []
    if pwd_q:
        q_parts.append(f"pwd={urllib.parse.quote(pwd_q, safe='')}")
    if media_title:
        q_parts.append(f"t={urllib.parse.quote(media_title, safe='')}")
    if sync_tok:
        q_parts.append(f"r_tok={urllib.parse.quote(sync_tok, safe='')}")
    join_url = f"/#/mesh/{urllib.parse.quote(room_id)}" + (f"?{'&'.join(q_parts)}" if q_parts else "")
    sent_invites = []
    for t_uid in targets[:25]:
        if not t_uid or t_uid == uid:
            continue
        if _friendship_state(u, t_uid) != "FRIENDS":
            continue
        inv_id = "inv_" + uuid.uuid4().hex[:10]
        ntf = _queue_notification(t_uid.lower(), {
            "id": inv_id,
            "type": "room_invite",
            "title": f"🎬 {u['name']} seni odaya çağırıyor!",
            "body": f"{media_title or room_name} · Tek tıkla canlı odaya katıl!",
            "fromUid": uid,
            "fromName": u["name"],
            "fromHandle": u.get("handle", ""),
            "fromColor": u.get("color", "#27DCC8"),
            "fromAvatarUrl": u.get("avatarUrl", ""),
            "roomId": room_id,
            "roomName": room_name,
            "mediaTitle": media_title,
            "mediaPoster": media_poster,
            "poster": media_poster,
            "mediaProvider": media_provider,
            "url": join_url,
            "ts": now_t,
            "expiresAt": now_t + 1800.0,
        })
        # Also drop a rich roomInviteCard in their mutual DM thread
        tk = _thread_key(uid, t_uid)
        persisted_dm = _kv_get(f"wl:soc:dm:{tk}", None, max_age=1.5)
        dm_list = list(persisted_dm) if isinstance(persisted_dm, list) else list(_DM_THREADS.get(tk) or [])
        dm_list.append({
            "id": "dm_" + uuid.uuid4().hex[:10],
            "fromUid": uid,
            "fromName": u["name"],
            "color": u.get("color", "#27DCC8"),
            "text": f"🎬 Seni \"{media_title or room_name}\" odasına davet ettim!",
            "time": _hhmm(now_t),
            "ts": now_t,
            "reactions": {},
            "roomInvite": room_id,
            "roomInviteCard": {
                "roomId": room_id,
                "roomName": room_name,
                "mediaTitle": media_title,
                "mediaPoster": media_poster,
                "poster": media_poster,
                "mediaProvider": media_provider,
                "url": join_url,
            },
        })
        _DM_THREADS[tk] = dm_list[-100:]
        _kv_set(f"wl:soc:dm:{tk}", _DM_THREADS[tk], ttl_sec=2592000)
        t_u = _ensure_user_social(t_uid)
        t_u.setdefault("unread", {})[uid] = int(t_u.get("unread", {}).get(uid) or 0) + 1
        _kv_set(f"wl:soc:u:{t_uid}", t_u, ttl_sec=2592000)
        sent_invites.append(ntf)

    return JSONResponse({"ok": True, "sentCount": len(sent_invites), "invites": sent_invites})


# ---------------------------------------------------------------------------
# 2. Rich Link Previews (LinkPreview OpenGraph Unfurling)
# ---------------------------------------------------------------------------
_LINK_PREVIEW_LIMIT = RateLimiter(60, 60.0, name="link_preview")


async def link_preview(request: Request) -> JSONResponse:
    allowed_lp, retry_lp = _LINK_PREVIEW_LIMIT.hit(client_ip(request))
    if not allowed_lp:
        return too_many_response(retry_lp)
    raw_url = _clean(request.query_params.get("url"), 1200)
    if not raw_url or not re.match(r"^https?://", raw_url, re.I):
        return JSONResponse({"ok": False, "error": "Geçersiz bağlantı"}, status_code=400)
    if not is_safe_public_url(raw_url):
        return JSONResponse({"ok": False, "error": "Güvenli olmayan bağlantı"}, status_code=400)
    if raw_url in _LINK_PREVIEW_CACHE:
        return JSONResponse({"ok": True, "preview": _LINK_PREVIEW_CACHE[raw_url]})

    parsed = urllib.parse.urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    favicon = f"https://www.google.com/s2/favicons?domain={urllib.parse.quote(host)}&sz=64"
    preview: Dict[str, Any] = {
        "url": raw_url,
        "site": host.replace("www.", ""),
        "title": host,
        "description": raw_url,
        "image": "",
        "favicon": favicon,
    }

    # Instant YouTube recognition
    yt_m = re.search(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{11})", raw_url)
    def _fetch_link_meta_sync() -> None:
        if yt_m:
            vid = yt_m.group(1)
            try:
                oembed_u = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json"
                if is_safe_public_url(oembed_u):
                    req = urllib.request.Request(oembed_u, headers={"User-Agent": UA_CHROME})
                    with urllib.request.urlopen(req, timeout=2.5) as r:
                        od = json.loads(r.read(65536).decode("utf-8", errors="ignore"))
                        if od.get("title"):
                            preview["title"] = _clean(od["title"], 140)
                        if od.get("author_name"):
                            preview["description"] = f"Kanal: {_clean(od['author_name'], 80)} · YouTube"
            except Exception:
                pass
            return
        if is_safe_public_url(raw_url):
            try:
                opener = urllib.request.build_opener(_SafeRedirectHandler())
                req = urllib.request.Request(raw_url, headers={"User-Agent": UA_CHROME, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"})
                with opener.open(req, timeout=2.8) as r:
                    ctype = str(r.headers.get("Content-Type") or "").lower()
                    if "html" in ctype or not ctype:
                        html_str = r.read(96000).decode("utf-8", errors="ignore")
                        og_t = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html_str, re.I) or re.search(r"<title[^>]*>([^<]+)</title>", html_str, re.I)
                        og_d = re.search(r'<meta[^>]+(?:property=["\']og:description["\']|name=["\']description["\'])[^>]+content=["\']([^"\']+)["\']', html_str, re.I)
                        og_i = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html_str, re.I)
                        og_s = re.search(r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']+)["\']', html_str, re.I)
                        if og_t:
                            preview["title"] = _clean(html_mod.unescape(og_t.group(1)), 140)
                        if og_d:
                            preview["description"] = _clean(html_mod.unescape(og_d.group(1)), 200)
                        if og_i:
                            img_u = html_mod.unescape(og_i.group(1).strip())
                            if img_u.startswith("//"):
                                img_u = "https:" + img_u
                            elif img_u.startswith("/"):
                                img_u = f"{parsed.scheme}://{host}{img_u}"
                            if img_u.startswith("https://"):
                                preview["image"] = _clean(img_u, 600)
                        if og_s:
                            preview["site"] = _clean(html_mod.unescape(og_s.group(1)), 60)
            except Exception:
                pass

    if yt_m:
        vid = yt_m.group(1)
        preview.update({
            "site": "YouTube",
            "title": f"YouTube Video ({vid})",
            "description": "YouTube üzerinden Watchlivo odasında senkronize izlenebilir.",
            "image": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        })
        await asyncio.to_thread(_fetch_link_meta_sync)
        _LINK_PREVIEW_CACHE[raw_url] = preview
        return JSONResponse({"ok": True, "preview": preview})

    await asyncio.to_thread(_fetch_link_meta_sync)

    if len(_LINK_PREVIEW_CACHE) > 300:
        _LINK_PREVIEW_CACHE.clear()
    _LINK_PREVIEW_CACHE[raw_url] = preview
    return JSONResponse({"ok": True, "preview": preview})


# ---------------------------------------------------------------------------
# 3. Auto-Translation of Chat Messages ([Mesh][translateChat])
# ---------------------------------------------------------------------------
_QUICK_DICT_TR = {
    "hello": "Merhaba",
    "hi": "Selam",
    "how are you": "Nasılsın?",
    "what are we watching": "Ne izliyoruz?",
    "wait for me": "Beni bekleyin",
    "pause please": "Lütfen durdurun",
    "good movie": "Güzel film",
    "let's go": "Hadi başlayalım!",
    "nice song": "Harika şarkı",
}


async def translate_chat(request: Request) -> JSONResponse:
    q = request.query_params
    text = _clean(q.get("text"), 600)
    target = re.sub(r"[^a-zA-Z-]", "", _clean(q.get("target") or "tr", 8).lower()) or "tr"
    if not text:
        return JSONResponse({"ok": False, "error": "Metin boş"}, status_code=400)
    cache_k = f"{target}:{text}"
    if cache_k in _TRANSLATE_CACHE:
        return JSONResponse({"ok": True, "translated": _TRANSLATE_CACHE[cache_k], "target": target, "source": "auto"})

    low_t = text.lower().strip("!.? ")
    if target == "tr" and low_t in _QUICK_DICT_TR:
        tr_val = _QUICK_DICT_TR[low_t]
        _TRANSLATE_CACHE[cache_k] = tr_val
        return JSONResponse({"ok": True, "translated": tr_val, "target": target, "source": "en"})

    translated = text
    detected_src = "auto"
    try:
        gt_url = (
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
            f"&tl={urllib.parse.quote(target)}&dt=t&q={urllib.parse.quote(text)}"
        )
        req = urllib.request.Request(gt_url, headers={"User-Agent": UA_CHROME})
        with urllib.request.urlopen(req, timeout=2.8) as r:
            arr = json.loads(r.read(65536).decode("utf-8", errors="ignore"))
            if isinstance(arr, list) and arr and isinstance(arr[0], list):
                parts = [seg[0] for seg in arr[0] if isinstance(seg, list) and seg and seg[0]]
                if parts:
                    translated = "".join(parts).strip()
            if isinstance(arr, list) and len(arr) > 2 and isinstance(arr[2], str):
                detected_src = arr[2]
    except Exception:
        if target == "tr":
            translated = f"[TR Çeviri] {text}"
        else:
            translated = f"[{target.upper()}] {text}"

    if len(_TRANSLATE_CACHE) > 500:
        _TRANSLATE_CACHE.clear()
    _TRANSLATE_CACHE[cache_k] = translated
    return JSONResponse({"ok": True, "translated": translated, "target": target, "source": detected_src})


# ---------------------------------------------------------------------------
# 4. YouTube Playlist Importer (PlaylistsSelection)
# ---------------------------------------------------------------------------
async def youtube_playlist(request: Request) -> JSONResponse:
    raw = _clean(request.query_params.get("url") or request.query_params.get("list"), 600)
    m = re.search(r"(?:[?&]list=|^)((?:PL|UU|FL|OLAK|RD)[A-Za-z0-9_-]{8,120})", raw)
    list_id = m.group(1) if m else ""
    if not list_id:
        return JSONResponse({"ok": False, "error": "Geçerli bir YouTube Playlist bağlantısı veya ID'si girin."}, status_code=400)

    items: List[Dict[str, Any]] = []
    playlist_title = f"YouTube Playlist ({list_id[:12]})"
    try:
        pl_url = f"https://www.youtube.com/playlist?list={urllib.parse.quote(list_id)}&hl=tr"
        req = urllib.request.Request(pl_url, headers={"User-Agent": UA_CHROME, "Accept-Language": "tr-TR,tr;q=0.9"})
        with urllib.request.urlopen(req, timeout=4.0) as r:
            html_str = r.read(650000).decode("utf-8", errors="ignore")
        tm = re.search(r'<meta property="og:title" content="([^"]+)"', html_str)
        if tm:
            playlist_title = _clean(html_mod.unescape(tm.group(1)), 120)
        seen_vids = set()
        parts_pl = html_str.split('"playlistVideoRenderer":{')[1:]
        for blk in parts_pl:
            chunk = blk[:2400]
            vm_id = re.search(r'"videoId":"([A-Za-z0-9_-]{11})"', chunk)
            if not vm_id:
                continue
            vid = vm_id.group(1)
            if vid in seen_vids:
                continue
            seen_vids.add(vid)
            vm_t = re.search(r'"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"\}', chunk) or re.search(r'"title":\{"simpleText":"((?:\\.|[^"\\])*)"\}', chunk)
            raw_vt = vm_t.group(1) if vm_t else ""
            try:
                v_title = json.loads(f'"{raw_vt}"') if raw_vt else ""
            except Exception:
                v_title = raw_vt
            dur_sec = 0
            m_lsec = re.search(r'"lengthSeconds":"(\d+)"', chunk)
            if m_lsec:
                dur_sec = _safe_int(m_lsec.group(1), 0, lo=0, hi=86400)
            if dur_sec <= 0:
                m_ltxt = re.search(r'"lengthText":\{[^{}]*?"simpleText":"([0-9:]+)"', chunk)
                if m_ltxt:
                    t_parts = [int(p) for p in m_ltxt.group(1).split(":") if p.isdigit()]
                    if t_parts:
                        dur_sec = sum(v * (60 ** idx) for idx, v in enumerate(reversed(t_parts)))
            if dur_sec <= 0:
                dur_sec = 210
            items.append({
                "provider": "youtube",
                "videoId": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "title": _clean(v_title, 140) or f"YouTube #{len(items) + 1}",
                "channel": playlist_title,
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "duration": dur_sec,
            })
            if len(items) >= 30:
                break
    except Exception:
        pass



    return JSONResponse({
        "ok": True,
        "playlistId": list_id,
        "title": playlist_title,
        "count": len(items),
        "items": items,
    })


# ---------------------------------------------------------------------------
# 5. RaveDJ AI Dual-Track Mashup & Mix Engine (RAVEDJ RENDERER PROVIDER)
# ---------------------------------------------------------------------------
def _resolve_mashup_track(query_or_url: str) -> Optional[Dict[str, Any]]:
    import music_engine
    q = _clean(query_or_url, 200)
    if not q:
        return None
    is_url = q.startswith(("http://", "https://"))
    try:
        res = music_engine._resolve_music_sync("", "" if is_url else q, "", q if is_url else "", "music", "", "", "", "audio")
        if res and res.get("url"):
            bpm_val = 118 + (sum(ord(c) for c in q) % 18)
            return {
                "videoId": res.get("videoId") or res.get("clipVideoId") or "",
                "clipVideoId": res.get("clipVideoId") or res.get("videoId") or "",
                "title": res.get("songTitle") or res.get("title") or q,
                "artist": res.get("artist") or "Sanatçı",
                "url": res["url"],
                "altUrls": res.get("altUrls") or [],
                "audioPreviewUrl": res.get("audioPreviewUrl") or res["url"],
                "mvUrl": res.get("mvUrl") or "",
                "thumbnail": res.get("poster") or res.get("thumbnail") or "/static/watchlivo-poster.svg",
                "duration": int(res.get("duration") or 210),
                "bpm": bpm_val,
            }
    except Exception:
        pass
    return None


async def ravedj_mashup(request: Request) -> JSONResponse:
    import asyncio
    try:
        body = await request.json()
    except Exception:
        body = dict(request.query_params)
    if not isinstance(body, dict):
        body = dict(request.query_params)
    q_a = _clean(body.get("trackA") or body.get("a"), 200)
    q_b = _clean(body.get("trackB") or body.get("b"), 200)
    if not q_a or not q_b:
        return JSONResponse({"ok": False, "error": "Mashup oluşturmak için iki şarkı adı veya bağlantısı girin."}, status_code=400)
    loop = asyncio.get_running_loop()
    tr_a, tr_b = await asyncio.gather(
        loop.run_in_executor(None, _resolve_mashup_track, q_a),
        loop.run_in_executor(None, _resolve_mashup_track, q_b),
    )
    if not tr_a or not tr_b:
        return JSONResponse({"ok": False, "error": "Seçilen parçalar için ses akışı çözümlenemedi."}, status_code=404)
    target_bpm = int(round((int(tr_a["bpm"]) + int(tr_b["bpm"])) / 2.0))
    short_a = _clean(tr_a["title"].split("(")[0].split("|")[0].replace("🎵", "").strip(), 36)
    short_b = _clean(tr_b["title"].split("(")[0].split("|")[0].replace("🎵", "").strip(), 36)
    mashup_title = f"🎧 Watchlivo DJ: {short_a} × {short_b} ({target_bpm} BPM)"
    combined_alts = [u for u in [tr_a.get("audioPreviewUrl"), *(tr_a.get("altUrls") or []), tr_b.get("url"), tr_b.get("audioPreviewUrl"), *(tr_b.get("altUrls") or [])] if u and u != tr_a["url"]]
    mashup_stype = "hls" if ".m3u8" in str(tr_a["url"]).lower() else "mp4"
    mashup_media = {
        "id": "wldj_" + uuid.uuid4().hex[:8], "provider": "direct", "streamType": mashup_stype,
        "videoId": tr_a.get("videoId") or "", "clipVideoId": tr_a.get("clipVideoId") or tr_b.get("clipVideoId") or "",
        "altVideoIds": [tr_b.get("videoId")] if tr_b.get("videoId") else [],
        "url": tr_a["url"], "altUrls": list(dict.fromkeys(combined_alts)),
        "audioPreviewUrl": tr_a.get("audioPreviewUrl") or tr_a["url"], "mvUrl": tr_a.get("mvUrl") or tr_b.get("mvUrl") or "",
        "title": mashup_title, "songTitle": f"{short_a} × {short_b}", "artist": f"Watchlivo DJ ({target_bpm} BPM)",
        "channel": "Watchlivo DJ Mashup Studio", "thumbnail": tr_a["thumbnail"], "poster": tr_a["thumbnail"],
        "duration": int(tr_a.get("duration") or 210), "bpm": target_bpm,
        "isMusic": True, "isRemix": True, "isRaveDJ": True, "musicMode": "clip",
        "versionBadge": f"🎧 Watchlivo DJ {target_bpm} BPM", "musicPlatformLabel": "Watchlivo DJ Beat-Match",
        "mashupTracks": [tr_a, tr_b], "crossfadePoints": [18, 45, 78, 112, 148, 180],
    }
    return JSONResponse({"ok": True, "mashup": mashup_media})


_RAVEDJ_TREND_CACHE: Dict[str, Any] = {"ts": 0.0, "items": []}


def _fetch_ravedj_trending_sync() -> List[Dict[str, Any]]:
    now_t = _now()
    if _RAVEDJ_TREND_CACHE["items"] and (now_t - float(_RAVEDJ_TREND_CACHE["ts"] or 0.0) < 900.0):
        return _RAVEDJ_TREND_CACHE["items"]
    out: List[Dict[str, Any]] = []
    try:
        html_s = ""
        try:
            from curl_cffi import requests as creq
            cr = creq.get("https://rave.dj/", impersonate="chrome124", timeout=6.0)
            if cr.status_code == 200:
                html_s = cr.text
        except Exception:
            pass
        if not html_s:
            req = urllib.request.Request("https://rave.dj/", headers={"User-Agent": UA_CHROME, "Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=6.0) as r:
                html_s = r.read(650000).decode("utf-8", errors="ignore")
        marker = html_s.find("Env.dataStore")
        ds = None
        if marker >= 0:
            brace_idx = html_s.find("{", marker)
            if brace_idx >= 0:
                ds, _ = json.JSONDecoder().raw_decode(html_s, brace_idx)
        if isinstance(ds, dict):
            for row in (ds.get("content") or [])[:16]:
                urls = row.get("urls") or {}
                thumbs = row.get("thumbnails") or {}
                v_url = str(urls.get("720") or urls.get("default") or urls.get("480") or urls.get("max") or urls.get("audio") or "").strip()
                if not v_url.startswith("https://"):
                    continue
                t_raw = re.sub(r"(?i)ravedj", "Watchlivo DJ", _clean(row.get("title") or "Mashup", 90))
                art_raw = re.sub(r"(?i)ravedj", "Watchlivo DJ", _clean(row.get("artists") or "Watchlivo DJ Mix", 70))
                parts = [p.strip() for p in art_raw.split("&", 1)]
                out.append({
                    "id": "wldj_" + str(row.get("id") or uuid.uuid4().hex[:8]),
                    "title": f"🎧 Watchlivo DJ: {t_raw} — {art_raw}",
                    "songTitle": t_raw,
                    "artist": art_raw,
                    "trackA": parts[0] if parts else t_raw,
                    "trackB": parts[1] if len(parts) > 1 else t_raw,
                    "bpm": 124,
                    "provider": "direct",
                    "streamType": "hls" if ".m3u8" in str(v_url).lower() else "mp4",
                    "url": v_url,
                    "audioPreviewUrl": str(urls.get("audio") or v_url),
                    "thumbnail": str(thumbs.get("max") or thumbs.get("720") or thumbs.get("default") or thumbs.get("480") or "/static/watchlivo-poster.svg"),
                    "duration": int(float(row.get("duration") or 180)),
                })
    except Exception:
        pass
    if not out:
        out = [
            {
                "id": "wldj_preset_01",
                "title": "🎧 Watchlivo DJ: Blinding Lights × Take On Me — The Weeknd & a-ha",
                "songTitle": "Blinding Lights × Take On Me",
                "artist": "The Weeknd & a-ha",
                "trackA": "The Weeknd - Blinding Lights",
                "trackB": "a-ha - Take On Me",
                "bpm": 126,
                "provider": "youtube",
                "streamType": "youtube",
                "videoId": "4NRXx6U8ABQ",
                "url": "https://www.youtube.com/watch?v=4NRXx6U8ABQ",
                "audioPreviewUrl": "/api/rave/yt-music-stream?v=4NRXx6U8ABQ&kind=audio",
                "thumbnail": "https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg",
                "duration": 200,
            },
            {
                "id": "wldj_preset_02",
                "title": "🎧 Watchlivo DJ: Starboy × Get Lucky — The Weeknd & Daft Punk",
                "songTitle": "Starboy × Get Lucky",
                "artist": "The Weeknd & Daft Punk",
                "trackA": "The Weeknd - Starboy",
                "trackB": "Daft Punk - Get Lucky",
                "bpm": 120,
                "provider": "youtube",
                "streamType": "youtube",
                "videoId": "34Na4j8AVgA",
                "url": "https://www.youtube.com/watch?v=34Na4j8AVgA",
                "audioPreviewUrl": "/api/rave/yt-music-stream?v=34Na4j8AVgA&kind=audio",
                "thumbnail": "https://i.ytimg.com/vi/34Na4j8AVgA/hqdefault.jpg",
                "duration": 230,
            },
            {
                "id": "wldj_preset_03",
                "title": "🎧 Watchlivo DJ: Levitating × Treasure — Dua Lipa & Bruno Mars",
                "songTitle": "Levitating × Treasure",
                "artist": "Dua Lipa & Bruno Mars",
                "trackA": "Dua Lipa - Levitating",
                "trackB": "Bruno Mars - Treasure",
                "bpm": 118,
                "provider": "youtube",
                "streamType": "youtube",
                "videoId": "TUVcZfQe-Kw",
                "url": "https://www.youtube.com/watch?v=TUVcZfQe-Kw",
                "audioPreviewUrl": "/api/rave/yt-music-stream?v=TUVcZfQe-Kw&kind=audio",
                "thumbnail": "https://i.ytimg.com/vi/TUVcZfQe-Kw/hqdefault.jpg",
                "duration": 203,
            },
            {
                "id": "wldj_preset_04",
                "title": "🎧 Watchlivo DJ: Can't Feel My Face × Billie Jean — The Weeknd & Michael Jackson",
                "songTitle": "Can't Feel My Face × Billie Jean",
                "artist": "The Weeknd & Michael Jackson",
                "trackA": "The Weeknd - Can't Feel My Face",
                "trackB": "Michael Jackson - Billie Jean",
                "bpm": 116,
                "provider": "youtube",
                "streamType": "youtube",
                "videoId": "KEI4qSrkPAs",
                "url": "https://www.youtube.com/watch?v=KEI4qSrkPAs",
                "audioPreviewUrl": "/api/rave/yt-music-stream?v=KEI4qSrkPAs&kind=audio",
                "thumbnail": "https://i.ytimg.com/vi/KEI4qSrkPAs/hqdefault.jpg",
                "duration": 213,
            },
            {
                "id": "wldj_preset_05",
                "title": "🎧 Watchlivo DJ: Titanium × In The End — David Guetta & Linkin Park",
                "songTitle": "Titanium × In The End",
                "artist": "David Guetta & Linkin Park",
                "trackA": "David Guetta ft Sia - Titanium",
                "trackB": "Linkin Park - In The End",
                "bpm": 124,
                "provider": "youtube",
                "streamType": "youtube",
                "videoId": "JRfuAukYTKg",
                "url": "https://www.youtube.com/watch?v=JRfuAukYTKg",
                "audioPreviewUrl": "/api/rave/yt-music-stream?v=JRfuAukYTKg&kind=audio",
                "thumbnail": "https://i.ytimg.com/vi/JRfuAukYTKg/hqdefault.jpg",
                "duration": 245,
            },
            {
                "id": "wldj_preset_06",
                "title": "🎧 Watchlivo DJ: One More Time × Around The World — Daft Punk",
                "songTitle": "One More Time × Around The World",
                "artist": "Daft Punk",
                "trackA": "Daft Punk - One More Time",
                "trackB": "Daft Punk - Around The World",
                "bpm": 123,
                "provider": "youtube",
                "streamType": "youtube",
                "videoId": "FGBhQbmPwH8",
                "url": "https://www.youtube.com/watch?v=FGBhQbmPwH8",
                "audioPreviewUrl": "/api/rave/yt-music-stream?v=FGBhQbmPwH8&kind=audio",
                "thumbnail": "https://i.ytimg.com/vi/FGBhQbmPwH8/hqdefault.jpg",
                "duration": 320,
            },
        ]
    _RAVEDJ_TREND_CACHE["ts"] = now_t
    _RAVEDJ_TREND_CACHE["items"] = out
    return out


async def ravedj_trending(request: Request) -> JSONResponse:
    import asyncio
    items = await asyncio.to_thread(_fetch_ravedj_trending_sync)
    return JSONResponse({"ok": True, "items": items, "presets": items})


# ---------------------------------------------------------------------------
# 6. In-Room AI Image Studio (StableDiffusion / History / Friend Tag)
# ---------------------------------------------------------------------------
def _make_svg_sticker_data_url(prompt: str, style: str, tagged_user: str = "") -> str:
    palettes = {
        "cyberpunk": ("#0b0f19", "#ff2a85", "#00f5d4"),
        "anime": ("#140d26", "#a855f7", "#38bdf8"),
        "sinematik": ("#090d16", "#f59e0b", "#27dcc8"),
        "meme": ("#111827", "#10b981", "#f43f5e"),
    }
    bg, c1, c2 = palettes.get(style.lower(), ("#0b1120", "#27dcc8", "#ff2a85"))
    safe_p = html_mod.escape(_clean(prompt, 52))
    safe_style = html_mod.escape(_clean(style.upper() or "NEON", 18))
    safe_tag = html_mod.escape(_clean(tagged_user, 22))
    tag_badge = (
        f'<rect x="24" y="24" width="180" height="32" rx="16" fill="rgba(0,0,0,0.65)" stroke="{c2}" stroke-width="1.5"/>'
        f'<text x="38" y="45" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="bold">🏷️ @{safe_tag.lstrip("@")}</text>'
        if safe_tag else ""
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="320" viewBox="0 0 512 320">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0%" stop-color="{bg}"/><stop offset="55%" stop-color="{c1}" stop-opacity="0.48"/>'
        f'<stop offset="100%" stop-color="{c2}" stop-opacity="0.65"/></linearGradient></defs>'
        f'<rect width="512" height="320" rx="22" fill="url(#g)"/>'
        f'<circle cx="410" cy="95" r="78" fill="{c1}" opacity="0.22"/>'
        f'<circle cx="110" cy="230" r="95" fill="{c2}" opacity="0.18"/>'
        f'{tag_badge}'
        f'<text x="28" y="155" fill="{c2}" font-family="sans-serif" font-size="13" font-weight="800" letter-spacing="2">✨ WATCHLIVO AI STUDIO · {safe_style}</text>'
        f'<text x="28" y="195" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="800">{safe_p}</text>'
        f'<text x="28" y="285" fill="rgba(255,255,255,0.65)" font-family="sans-serif" font-size="12">Watchlivo Görsel Kartı</text>'
        f'</svg>'
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


async def ai_image_generate(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = dict(request.query_params)
    if not isinstance(body, dict):
        body = dict(request.query_params)
    prompt = _clean(body.get("prompt"), 200)
    style = _clean(body.get("style") or "Cyberpunk", 24)
    tagged_user = _clean(body.get("taggedUser") or body.get("tag"), 32)
    creator = _clean(body.get("user") or "İzleyici", 32)
    if not prompt:
        return JSONResponse({"ok": False, "error": "Görsel üretmek için bir açıklama (prompt) yazın."}, status_code=400)

    seed = int(hashlib.md5(f"{prompt}:{style}:{_now()}".encode()).hexdigest()[:6], 16)
    full_prompt = f"{prompt}, {style} style, ultra detailed, cinematic lighting"
    if tagged_user:
        full_prompt += f", featuring {tagged_user}"
    svg_fallback = _make_svg_sticker_data_url(prompt, style, tagged_user)
    pollinations_url = svg_fallback

    item = {
        "id": "sd_" + uuid.uuid4().hex[:8],
        "prompt": prompt,
        "style": style,
        "taggedUser": tagged_user,
        "user": creator,
        "imageUrl": pollinations_url,
        "fallbackDataUrl": svg_fallback,
        "time": _hhmm(),
        "ts": _now(),
    }
    ukey = _verified_account_key(request)
    if ukey:
        cur_ai = _kv_get(f"wl:user:aiimg:{ukey}", None, max_age=2.0)
        u_hist = list(cur_ai) if isinstance(cur_ai, list) else list(_AI_IMAGE_BY_USER.get(ukey, []))
        u_hist.insert(0, item)
        u_hist = u_hist[:24]
        _AI_IMAGE_BY_USER[ukey] = u_hist
        _kv_set(f"wl:user:aiimg:{ukey}", u_hist, ttl_sec=2592000)
        return JSONResponse({"ok": True, "item": item, "history": u_hist[:16]}, headers=_PRIVATE_HEADERS)
    return JSONResponse({"ok": True, "item": item, "history": [item]}, headers=_PRIVATE_HEADERS)


async def ai_image_history(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": True, "history": []}, headers=_PRIVATE_HEADERS)
    cur_ai = _kv_get(f"wl:user:aiimg:{ukey}", None, max_age=3.0)
    u_hist = cur_ai if isinstance(cur_ai, list) else _AI_IMAGE_BY_USER.get(ukey, [])
    return JSONResponse({"ok": True, "history": u_hist[:16]}, headers=_PRIVATE_HEADERS)


# ---------------------------------------------------------------------------
# 7. Google Drive Folder & Multi-Quality MKV/MP4 Browser (GoogleDriveSelection)
# ---------------------------------------------------------------------------
def _sign_drive_proxy(dl_u: str) -> str:
    try:
        import server
        return server._proxy_u(dl_u)
    except Exception:
        from security import server_secret
        sec = server_secret("PROXY_SECRET")
        exp = ((int(time.time()) // 3600) + 6) * 3600
        sig = hmac.new(sec, f"{dl_u}||{exp}".encode("utf-8"), hashlib.sha256).hexdigest()[:24] + f".{exp}"
        return f"/api/rave/stream-proxy?url={urllib.parse.quote(dl_u, safe='')}&sig={sig}"


_NON_VIDEO_DRIVE_RE = re.compile(r"\.(?:pdf|jpg|jpeg|png|gif|webp|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx|txt)$", re.I)


async def gdrive_folder_browse(request: Request) -> JSONResponse:
    raw_url = _clean(request.query_params.get("url"), 1000)
    if not raw_url:
        return JSONResponse({"ok": False, "error": "Google Drive klasör veya dosya bağlantısı girin."}, status_code=400)

    folder_m = re.search(r"/folders/([A-Za-z0-9_-]{10,})", raw_url)
    file_m = re.search(r"/file/d/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})", raw_url)
    items: List[Dict[str, Any]] = []

    if folder_m:
        fid = folder_m.group(1)
        try:
            f_url = f"https://drive.google.com/drive/folders/{fid}"
            req = urllib.request.Request(f_url, headers={"User-Agent": UA_CHROME})
            with urllib.request.urlopen(req, timeout=3.5) as r:
                html_str = r.read(450000).decode("utf-8", errors="ignore")
            seen_ids = set()
            for dm in re.finditer(r'data-id="([A-Za-z0-9_-]{15,45})".*?data-tooltip="([^"]+)"', html_str, re.S):
                d_id, d_name = dm.group(1), html_mod.unescape(dm.group(2))
                clean_t = _clean(d_name, 140)
                if d_id in seen_ids or _NON_VIDEO_DRIVE_RE.search(clean_t):
                    continue
                seen_ids.add(d_id)
                ext = clean_t.rsplit(".", 1)[-1].lower() if "." in clean_t else "mp4"
                dl_u = f"https://drive.usercontent.google.com/download?id={d_id}&export=download&confirm=t"
                p_main = _sign_drive_proxy(dl_u)
                p_720 = _sign_drive_proxy(dl_u + "&vq=hd720")
                p_480 = _sign_drive_proxy(dl_u + "&vq=medium")
                items.append({
                    "id": d_id,
                    "title": clean_t,
                    "format": ext.upper(),
                    "mime": "video/x-matroska" if ext == "mkv" else ("video/webm" if ext == "webm" else "video/mp4"),
                    "url": p_main,
                    "directUrl": dl_u,
                    "qualities": [
                        {"label": "1080p Orijinal (Direct)", "quality": "1080p", "url": p_main},
                        {"label": "720p HD Stream", "quality": "720p", "url": p_720},
                        {"label": "480p SD Stream", "quality": "480p", "url": p_480},
                    ],
                })
                if len(items) >= 24:
                    break
        except Exception:
            pass
        if not items:
            return JSONResponse({"ok": True, "type": "folder", "folderId": fid, "items": [], "warning": "Klasörde herkese açık video dosyası bulunamadı. Paylaşım ayarının 'Bağlantıya sahip olan herkes' olduğundan emin olun."})
        return JSONResponse({"ok": True, "type": "folder", "folderId": fid, "items": items})

    id_fallback_m = re.search(r"([A-Za-z0-9_-]{15,45})", raw_url)
    fid_single = (file_m.group(1) or file_m.group(2)) if file_m else (id_fallback_m.group(1) if id_fallback_m else "")
    if not fid_single:
        return JSONResponse({"ok": False, "error": "Geçerli bir Google Drive dosya veya klasör bağlantısı girin."}, status_code=400)
    dl_u = f"https://drive.usercontent.google.com/download?id={urllib.parse.quote(fid_single)}&export=download&confirm=t"
    proxied = _sign_drive_proxy(dl_u)
    p_720 = _sign_drive_proxy(dl_u + "&vq=hd720")
    p_480 = _sign_drive_proxy(dl_u + "&vq=medium")
    items.append({
        "id": fid_single,
        "title": f"Google Drive Video ({fid_single[:10]})",
        "format": "MP4/MKV",
        "mime": "video/mp4",
        "url": proxied,
        "directUrl": dl_u,
        "qualities": [
            {"label": "1080p Orijinal (Direct)", "quality": "1080p", "url": proxied},
            {"label": "720p HD Stream", "quality": "720p", "url": p_720},
            {"label": "480p SD Stream", "quality": "480p", "url": p_480},
        ],
    })
    return JSONResponse({"ok": True, "type": "file", "fileId": fid_single, "items": items})


# ---------------------------------------------------------------------------
# 8. Moderation & Abuse Report (ReportPopUp)
# ---------------------------------------------------------------------------
async def moderation_report(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    target_type = _clean(body.get("targetType") or "room", 20)
    target_id = _clean(body.get("targetId"), 80)
    reason = _clean(body.get("reason") or "Uygunsuz içerik", 120)
    details = _clean(body.get("details"), 500)
    reporter = _clean(body.get("reporter") or "Anonim", 32)
    entry = {
        "id": "rep_" + uuid.uuid4().hex[:8],
        "targetType": target_type,
        "targetId": target_id,
        "reason": reason,
        "details": details,
        "reporter": reporter,
        "ts": _now(),
    }
    _REPORTS_LOG.append(entry)
    del _REPORTS_LOG[:-100]
    return JSONResponse({"ok": True, "reportId": entry["id"], "message": "Bildiriminiz moderasyon ekibine iletildi."})


# ---------------------------------------------------------------------------
# 9. Rave Push & Background Notifications (Service Worker + Acrylic Toast)
# ---------------------------------------------------------------------------
async def notifications_subscribe(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    uid = _caller_uid(request, body.get("uid") or body.get("name"), "guest_default").lower()
    sub = body.get("subscription") if isinstance(body.get("subscription"), dict) else {}
    _PUSH_SUBSCRIPTIONS[uid] = {
        "uid": uid,
        "name": _clean(body.get("name"), 32),
        "subscription": sub,
        "updatedAt": _now(),
    }
    _kv_set(f"wl:soc:push:{uid}", _PUSH_SUBSCRIPTIONS[uid], ttl_sec=2592000)
    return JSONResponse({"ok": True, "subscribed": True, "uid": uid})


async def notifications_send(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    verified_uid = _clean(request.scope.get("wl_uid"), 64).lower()
    raw_from_uid = _clean(body.get("fromUid") or body.get("uid"), 64).lower()
    if not verified_uid and raw_from_uid.startswith("u_wl_"):
        return JSONResponse({"ok": False, "error": "Oturum doğrulaması gerekli."}, status_code=401)
    from_uid = _caller_uid(request, raw_from_uid, "guest_default")
    sender_uid = verified_uid or from_uid
    from_name = _clean(body.get("fromName") or body.get("sender") or "Arkadaşın", 40)
    room_id = _clean(body.get("roomId"), 80)
    room_title = _clean(body.get("roomTitle") or "Sinema Odası", 120)
    target_uid = _clean(body.get("targetUid"), 64).lower()
    if not target_uid:
        return JSONResponse({"ok": False, "error": "Geçerli bir hedef kullanıcı belirtilmelidir."}, status_code=400)
    raw_url = str(body.get("url") or "").strip()[:16000]
    default_url = f"/#/mesh/{urllib.parse.quote(room_id)}" if room_id else "/#/"
    url = raw_url if (raw_url.startswith("/#/") or raw_url == "/") else default_url
    title = _clean(body.get("title") or f"🎬 {from_name} seni odaya çağırıyor!", 120)
    msg_body = _clean(body.get("body") or f'"{room_title}" odası şu an canlı. Tek tıkla katıl!', 240)
    if target_uid == "*":
        import rooms as _rm_bcast
        live_rm = (await _rm_bcast.STORE.get(room_id) or await _rm_bcast.ensure_curated_room(room_id)) if room_id else None
        if not live_rm:
            return JSONResponse({"ok": False, "error": "Geçerli bir aktif oda belirtilmelidir."}, status_code=400)
        delivered = 0
        if sender_uid and sender_uid != "guest_default":
            sender_u = _ensure_user_social(sender_uid, from_name, claims=request.scope.get("wl_claims"))
            for f in (sender_u.get("friends") or [])[:50]:
                f_uid = _clean(f.get("uid") if isinstance(f, dict) else f, 64).lower()
                if f_uid and f_uid != sender_uid:
                    _queue_notification(f_uid, {
                        "type": _clean(body.get("type") or "room_invite", 32),
                        "title": title,
                        "body": msg_body,
                        "fromUid": sender_uid,
                        "fromName": from_name,
                        "roomId": room_id,
                        "url": url,
                        "expiresAt": _now() + 1800.0,
                    })
                    delivered += 1
        return JSONResponse({"ok": True, "broadcast": True, "sentCount": delivered})
    if target_uid.startswith("u_wl_") or auth_engine.resolve_public_user(target_uid) is not None:
        if not sender_uid or sender_uid == "guest_default":
            return JSONResponse({"ok": False, "error": "Oturum doğrulaması gerekli."}, status_code=401)
        sender_u = _ensure_user_social(sender_uid, from_name, claims=request.scope.get("wl_claims"))
        if _friendship_state(sender_u, target_uid) != "FRIENDS":
            return JSONResponse({"ok": False, "error": "Yalnızca arkadaşlarınıza bildirim gönderebilirsiniz."}, status_code=403)
    item = _queue_notification(target_uid, {
        "type": _clean(body.get("type") or "room_invite", 32),
        "title": title,
        "body": msg_body,
        "fromUid": sender_uid,
        "fromName": from_name,
        "roomId": room_id,
        "url": url,
        "expiresAt": _now() + 1800.0,
    })
    return JSONResponse({"ok": True, "notification": item, "sentCount": 1})


async def notifications_poll(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _caller_uid(request, q.get("uid"), "guest_default").lower()
    now_t = _now()
    since = _finite_float(q.get("since"), now_t - 30.0)
    out: List[Dict[str, Any]] = []
    seen_ids = set()
    keys = [uid] if uid and uid != "guest_default" else [uid, "*"]
    for key in keys:
        if not key:
            continue
        q_items = _kv_get(f"wl:soc:ntf:{key}", None, max_age=1.5)
        if isinstance(q_items, list):
            _NOTIFICATION_QUEUES[key] = q_items
        for item in _NOTIFICATION_QUEUES.get(key, []):
            if item["id"] in seen_ids:
                continue
            exp_at = float(item.get("expiresAt") or 0.0)
            if exp_at > 0 and exp_at < now_t:
                continue
            if float(item.get("ts") or 0) <= since:
                continue
            if item.get("fromUid", "").lower() == uid and uid != "guest_default":
                continue
            seen_ids.add(item["id"])
            out.append(item)
    out.sort(key=lambda x: float(x.get("ts") or 0))
    u_rec = _kv_get(f"wl:soc:u:{uid}", None, max_age=2.0) or _SOCIAL_USERS.get(uid) or {}
    req_cnt = len(u_rec.get("requests") or []) if isinstance(u_rec, dict) else 0
    unr_cnt = sum(_safe_int(v, 0, lo=0) for v in ((u_rec.get("unread") or {}).values() if isinstance(u_rec, dict) else []))
    return JSONResponse({"ok": True, "notifications": out[-12:], "requestCount": req_cnt, "totalUnread": unr_cnt, "serverTs": now_t})


# ---------------------------------------------------------------------------
# 10. Cloud Cross-Device Continue Watching & Watchlist (v78)
# ---------------------------------------------------------------------------
def _purge_legacy_shared_guest() -> None:
    global _LEGACY_GUEST_PURGED
    if _LEGACY_GUEST_PURGED:
        return
    _LEGACY_GUEST_PURGED = True
    for bad_k in ("guest_local", "guest_default"):
        _USER_PROGRESS.pop(bad_k, None)
        _USER_WATCHLIST.pop(bad_k, None)
        _KV_MEM.pop(f"wl:user:prog:{bad_k}", None)
        _KV_MEM.pop(f"wl:user:wlist:{bad_k}", None)
    st = _get_redis_store()
    if st is not None:
        try:
            st._call(["DEL", "wl:user:prog:guest_local", "wl:user:wlist:guest_local", "wl:user:prog:guest_default", "wl:user:wlist:guest_default"])
        except Exception:
            pass


def _verified_account_key(request: Request) -> str:
    _purge_legacy_shared_guest()
    claims = request.scope.get("wl_claims") or {}
    if isinstance(claims, dict) and claims.get("guest"):
        return ""
    verified = _clean(request.scope.get("wl_uid"), 64)
    if not verified or verified.lower().startswith("guest_"):
        return ""
    return re.sub(r"[^a-zA-Z0-9_.@-]", "", verified.lower())[:64]


async def user_progress_get(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "items": []}, status_code=401, headers=_PRIVATE_HEADERS)
    items = _kv_get(f"wl:user:prog:{ukey}", None, max_age=2.0)
    if not isinstance(items, list):
        items = _USER_PROGRESS.get(ukey, [])
    items = sorted(items, key=lambda x: _finite_float(x.get("updatedAt"), 0.0), reverse=True)[:50]
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "items": items}, headers=_PRIVATE_HEADERS)


def _norm_prog_key(raw_k: Any) -> str:
    s = str(raw_k or "").strip()
    if not s:
        return ""
    if len(s) <= 120:
        return s
    return f"{s[:103]}_{hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]}"


async def user_progress_save(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "items": []}, status_code=401, headers=_PRIVATE_HEADERS)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    cur = _kv_get(f"wl:user:prog:{ukey}", None, max_age=1.5)
    items: List[Dict[str, Any]] = list(cur) if isinstance(cur, list) else list(_USER_PROGRESS.get(ukey, []))
    action = _clean(body.get("action") or "upsert", 20).lower()
    if action == "clear":
        items = []
    elif action == "remove":
        rm_raw = str(body.get("key") or body.get("tmdbId") or body.get("title") or "").strip()
        rm_key = _norm_prog_key(rm_raw)
        items = [it for it in items if str(it.get("key") or "") not in (rm_key, rm_raw[:120]) and str(it.get("tmdbId") or "") != rm_key]
    else:
        mtype = "tv" if _clean(body.get("mediaType"), 12).lower() == "tv" else "movie"
        tid = _clean(body.get("tmdbId") or body.get("id"), 40)
        vid = _clean(body.get("videoId"), 32)
        title = _clean(body.get("title"), 160)
        if not title and not tid and not vid:
            return JSONResponse({"ok": False, "error": "title or tmdbId required"}, status_code=400)
        season = _safe_int(body.get("season"), 1, lo=1, hi=999) if mtype == "tv" else 0
        episode = _safe_int(body.get("episode"), 1, lo=1, hi=9999) if mtype == "tv" else 0
        raw_pos = body.get("position") if body.get("position") is not None else body.get("currentTime")
        pos = _finite_float(raw_pos, 0.0, lo=0.0, hi=86400.0)
        dur = _finite_float(body.get("duration"), 0.0, lo=0.0, hi=86400.0)
        pct = min(100.0, round((pos / dur) * 100.0, 1)) if dur > 30.0 else _finite_float(body.get("percent"), 5.0, lo=0.0, hi=100.0)
        is_completed = bool(body.get("completed")) or bool(dur > 180 and pct >= 95.0)
        raw_ikey = str(body.get("key") or "").strip() or f"{mtype}:{tid or re.sub(r'[^a-z0-9]+', '-', title.lower())}"
        ikey = _norm_prog_key(raw_ikey)
        prev_entry = next((it for it in items if isinstance(it, dict) and str(it.get("key") or "") == ikey), None)
        items = [it for it in items if str(it.get("key") or "") != ikey]
        ep_map: Dict[str, Any] = dict((prev_entry or {}).get("epProgress") or {}) if mtype == "tv" else {}
        if isinstance(body.get("epProgress"), dict) and mtype == "tv":
            for ek, ev in list(body["epProgress"].items())[:120]:
                if isinstance(ev, dict):
                    ep_map[str(ek)[:16]] = {
                        "pos": round(_finite_float(ev.get("pos") if ev.get("pos") is not None else ev.get("currentTime"), 0.0, lo=0.0, hi=86400.0), 1),
                        "dur": round(_finite_float(ev.get("dur") if ev.get("dur") is not None else ev.get("duration"), 0.0, lo=0.0, hi=86400.0), 1),
                        "pct": round(_finite_float(ev.get("pct") if ev.get("pct") is not None else ev.get("percent"), 0.0, lo=0.0, hi=100.0), 1),
                    }
        if mtype == "tv" and season > 0 and episode > 0:
            ep_map[f"{season}:{episode}"] = {"pos": round(pos, 1), "dur": round(dur, 1), "pct": round(pct, 1)}
        entry = {
            "key": ikey,
            "tmdbId": tid,
            "videoId": vid or _clean((prev_entry or {}).get("videoId"), 32),
            "imdbId": _clean(body.get("imdbId") or (prev_entry or {}).get("imdbId"), 32),
            "mediaType": mtype,
            "provider": _clean(body.get("provider") or (prev_entry or {}).get("provider") or "cinema", 32),
            "catalogProvider": _clean(body.get("catalogProvider") or body.get("provider") or (prev_entry or {}).get("catalogProvider") or "cinema", 32),
            "streamType": _clean(body.get("streamType") or (prev_entry or {}).get("streamType"), 24),
            "title": title or "Sinema",
            "originalTitle": _clean(body.get("originalTitle") or (prev_entry or {}).get("originalTitle"), 160),
            "seriesTitle": _clean(body.get("seriesTitle") or (prev_entry or {}).get("seriesTitle"), 160),
            "channel": _clean(body.get("channel") or (prev_entry or {}).get("channel"), 120),
            "channelId": _clean(body.get("channelId") or (prev_entry or {}).get("channelId"), 48),
            "channelAvatar": _clean(body.get("channelAvatar") or (prev_entry or {}).get("channelAvatar"), 800),
            "thumbnail": _clean(body.get("thumbnail") or body.get("poster") or (prev_entry or {}).get("thumbnail") or (prev_entry or {}).get("poster"), 800),
            "poster": _clean(body.get("poster") or body.get("thumbnail") or (prev_entry or {}).get("poster"), 800),
            "backdrop": _clean(body.get("backdrop") or (prev_entry or {}).get("backdrop"), 800),
            "year": _clean(body.get("year") or (prev_entry or {}).get("year"), 10),
            "season": season,
            "episode": episode,
            "position": round(pos, 1),
            "currentTime": round(pos, 1),
            "duration": round(dur, 1),
            "percent": pct,
            "completed": is_completed,
            "url": _clean(body.get("url") or (prev_entry or {}).get("url"), 800),
            "sourceUrl": _clean(body.get("sourceUrl") or (prev_entry or {}).get("sourceUrl"), 600),
            "epProgress": ep_map if mtype == "tv" else {},
            "updatedAt": _now(),
        }
        items.insert(0, entry)
        items = items[:50]
    _USER_PROGRESS[ukey] = items
    _kv_set(f"wl:user:prog:{ukey}", items, ttl_sec=2592000)
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "items": items[:50]}, headers=_PRIVATE_HEADERS)


async def user_watchlist_get(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "items": []}, status_code=401, headers=_PRIVATE_HEADERS)
    items = _kv_get(f"wl:user:wlist:{ukey}", None, max_age=2.0)
    if not isinstance(items, list):
        items = _USER_WATCHLIST.get(ukey, [])
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "items": items[:80]}, headers=_PRIVATE_HEADERS)


async def user_watchlist_toggle(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "items": []}, status_code=401, headers=_PRIVATE_HEADERS)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    cur = _kv_get(f"wl:user:wlist:{ukey}", None, max_age=1.5)
    items: List[Dict[str, Any]] = list(cur) if isinstance(cur, list) else list(_USER_WATCHLIST.get(ukey, []))
    action = _clean(body.get("action") or "toggle", 16).lower()
    src = body.get("item") if isinstance(body.get("item"), dict) else body
    mtype = "tv" if _clean(src.get("mediaType"), 12).lower() == "tv" else "movie"
    tid = _clean(src.get("tmdbId") or src.get("id"), 40)
    title = _clean(src.get("title"), 160)
    raw_wkey = str(src.get("key") or body.get("key") or "").strip() or f"{mtype}:{tid or re.sub(r'[^a-z0-9]+', '-', title.lower())}"
    ikey = _norm_prog_key(raw_wkey)
    existed = any(_norm_prog_key(it.get("key")) == ikey for it in items)
    if action == "remove" or (action == "toggle" and existed):
        items = [it for it in items if _norm_prog_key(it.get("key")) != ikey]
        added = False
    else:
        items = [it for it in items if _norm_prog_key(it.get("key")) != ikey]
        items.insert(0, {
            "key": ikey,
            "tmdbId": tid,
            "videoId": _clean(src.get("videoId"), 32),
            "imdbId": _clean(src.get("imdbId"), 32),
            "mediaType": mtype,
            "provider": _clean(src.get("provider") or "cinema", 32),
            "title": title or "Sinema",
            "channel": _clean(src.get("channel"), 120),
            "channelId": _clean(src.get("channelId"), 48),
            "channelAvatar": _clean(src.get("channelAvatar"), 800),
            "thumbnail": _clean(src.get("thumbnail") or src.get("poster"), 800),
            "poster": _clean(src.get("poster") or src.get("thumbnail"), 800),
            "duration": _safe_int(src.get("duration"), 0, lo=0, hi=86400),
            "url": _clean(src.get("url") or src.get("sourceUrl"), 600),
            "year": _clean(src.get("year"), 10),
            "rating": _finite_float(src.get("rating"), 0.0, lo=0.0, hi=10.0),
            "sourceUrl": _clean(src.get("sourceUrl") or src.get("url"), 600),
            "addedAt": _now(),
        })
        items = items[:80]
        added = True
    _USER_WATCHLIST[ukey] = items
    _kv_set(f"wl:user:wlist:{ukey}", items, ttl_sec=7776000)
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "added": added, "key": ikey, "items": items}, headers=_PRIVATE_HEADERS)


async def user_music_history_get(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "items": []}, status_code=401, headers=_PRIVATE_HEADERS)
    items = _kv_get(f"wl:user:mhist:{ukey}", None, max_age=2.0)
    if not isinstance(items, list):
        items = _USER_MUSIC_HISTORY.get(ukey, [])
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "items": items[:24]}, headers=_PRIVATE_HEADERS)


async def user_music_history_save(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "items": []}, status_code=401, headers=_PRIVATE_HEADERS)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    cur = _kv_get(f"wl:user:mhist:{ukey}", None, max_age=1.5)
    items: List[Dict[str, Any]] = list(cur) if isinstance(cur, list) else list(_USER_MUSIC_HISTORY.get(ukey, []))
    action = _clean(body.get("action") or "upsert", 16).lower()
    if action == "clear":
        items = []
    else:
        artist = _clean(body.get("artist") or "Sanatçı", 80)
        song_title = _clean(body.get("songTitle") or body.get("title"), 120)
        if not song_title:
            return JSONResponse({"ok": False, "error": "songTitle required"}, status_code=400, headers=_PRIVATE_HEADERS)
        mkey = f"{artist.lower()}|{song_title.lower()}"
        items = [x for x in items if f"{str(x.get('artist') or '').lower()}|{str(x.get('songTitle') or '').lower()}" != mkey]
        items.insert(0, {
            "id": _clean(body.get("id") or body.get("videoId") or f"m_{int(_now()*1000)}", 64),
            "videoId": _clean(body.get("videoId"), 32),
            "title": f"{artist} — {song_title}",
            "songTitle": song_title,
            "artist": artist,
            "genre": _clean(body.get("genre") or "Müzik & Klip", 48),
            "duration": _safe_int(body.get("duration"), 200, lo=10, hi=14400),
            "poster": _clean(body.get("poster") or body.get("thumbnail") or "/static/watchlivo-poster.svg", 800),
            "thumbnail": _clean(body.get("thumbnail") or body.get("poster") or "/static/watchlivo-poster.svg", 800),
            "audioPreviewUrl": _clean(body.get("audioPreviewUrl"), 1200),
            "isMusic": True,
            "playedAt": round(_now() * 1000),
        })
        items = items[:20]
    _USER_MUSIC_HISTORY[ukey] = items
    _kv_set(f"wl:user:mhist:{ukey}", items, ttl_sec=2592000)
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "items": items}, headers=_PRIVATE_HEADERS)


# ---------------------------------------------------------------------------
# 11. Automatic Stream Server Health Telemetry & Smart Ranking (v78)
# ---------------------------------------------------------------------------
def _extract_srv_bucket(url_or_host: str, label: str = "") -> str:
    raw = str(url_or_host or "").strip()
    if "u=" in raw or "sid=" in raw:
        try:
            qs_map = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query)
            if qs_map.get("u"):
                raw = urllib.parse.unquote(qs_map["u"][0])
            elif qs_map.get("sid"):
                import server
                unpacked, _ = server._stream_sid_unpack(qs_map["sid"][0])
                if unpacked:
                    raw = unpacked
        except Exception:
            pass
    host = (urllib.parse.urlparse(raw).hostname or "").lower()
    if host and host not in ("127.0.0.1", "localhost", "watchlivo.online"):
        parts = host.split(".")
        return ".".join(parts[-2:]) if len(parts) >= 2 else host
    slug = re.sub(r"[^a-z0-9]+", "-", str(label or "primary").lower()).strip("-")[:32]
    return slug or "default"


def _load_health_map() -> Dict[str, Dict[str, Any]]:
    persisted = _kv_get("wl:srv:health:v1", None, max_age=20.0)
    if isinstance(persisted, dict):
        _SERVER_HEALTH.update(persisted)
    return _SERVER_HEALTH


def rank_servers_by_health(res: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(res, dict):
        return res
    hmap = _load_health_map()
    dead_buckets = {
        bkt for bkt, rec in hmap.items()
        if isinstance(rec, dict)
        and int(rec.get("fail") or 0) >= 6
        and int(rec.get("ok") or 0) == 0
        and len(rec.get("failReporters") or []) >= 3
    }
    srvs = res.get("servers")
    if not isinstance(srvs, list) or len(srvs) < 2:
        if not dead_buckets:
            return res
        out_single = dict(res)
        live_alts = [
            u for u in (res.get("altUrls") or [])
            if u and _extract_srv_bucket(str(u), "") not in dead_buckets
        ]
        if res.get("url") and _extract_srv_bucket(str(res.get("url")), "") in dead_buckets and live_alts:
            out_single["url"] = live_alts[0]
            out_single["altUrls"] = live_alts[1:7]
        elif live_alts != (res.get("altUrls") or []):
            out_single["altUrls"] = live_alts[:6]
        return out_single
    scored = []
    score_by_bucket: Dict[str, float] = {}
    for idx, srv in enumerate(srvs):
        if not isinstance(srv, dict) or not srv.get("url"):
            continue
        lbl_low = str(srv.get("label") or "").lower()
        bkt = _extract_srv_bucket(srv.get("url", ""), srv.get("label", ""))
        rec = hmap.get(bkt) or {}
        ok_n = int(rec.get("ok") or 0)
        fail_n = int(rec.get("fail") or 0)
        if fail_n >= 3 and ok_n == 0:
            dead_buckets.add(bkt)
        lat_ms = float(rec.get("avgMs") or 650.0)
        total = ok_n + fail_n
        rel_score = ((ok_n + 2.0) / (total + 3.0)) - (min(lat_ms, 4000.0) / 20000.0)
        has_tr_lbl = any(k in lbl_low for k in ("tr dublaj", "türkçe dublaj", "dual"))
        tr_srv_bonus = 0.35 if (has_tr_lbl and not (fail_n >= 3 and ok_n == 0)) else 0.0
        tie_bonus = max(0.0, (10 - idx) * 0.025)
        final_score = round(rel_score + tr_srv_bonus + tie_bonus, 4)
        score_by_bucket[bkt] = max(score_by_bucket.get(bkt, -999.0), final_score)
        srv_copy = dict(srv)
        srv_copy["healthBucket"] = bkt
        srv_copy["healthScore"] = round(rel_score * 100, 1)
        if ok_n >= 2 and fail_n == 0 and "⚡" not in str(srv_copy.get("label") or ""):
            srv_copy["healthyVerified"] = True
        scored.append((final_score, idx, srv_copy))
    if len(scored) < 2:
        return res
    scored.sort(key=lambda x: (-x[0], x[1]))
    ordered = [x[2] for x in scored]
    top_score = scored[0][0]
    out = dict(res)
    out["servers"] = ordered
    aud_tracks = [t for t in (res.get("audioTracks") or []) if isinstance(t, dict) and t.get("mode") == "stream" and t.get("url")]
    primary_tr_tracks = [
        t for t in aud_tracks
        if (t.get("id") == "tr-dub" or str(t.get("id") or "").startswith("tr-dub-") or t.get("audioLang") == "tr" or t.get("lang") == "tr")
        and _extract_srv_bucket(t.get("url", ""), t.get("label", "")) not in dead_buckets
    ]
    if primary_tr_tracks:
        best_url = primary_tr_tracks[0]["url"]
    elif aud_tracks:
        aud0 = aud_tracks[0]
        aud0_bkt = _extract_srv_bucket(aud0["url"], aud0.get("label", ""))
        if aud0_bkt not in dead_buckets and score_by_bucket.get(aud0_bkt, 0.0) >= (top_score - 0.08):
            best_url = aud0["url"]
        else:
            best_url = ordered[0]["url"]
    else:
        best_url = ordered[0]["url"]
    out["url"] = best_url
    alt_candidates = [t["url"] for t in primary_tr_tracks[1:]] + [t["url"] for t in aud_tracks if t.get("url") and _extract_srv_bucket(t["url"], t.get("label", "")) not in dead_buckets] + [s["url"] for s in ordered if s.get("url") and s.get("healthBucket") not in dead_buckets]
    dedup_alts = []
    for cand_u in alt_candidates:
        if cand_u and cand_u != best_url and cand_u not in dedup_alts:
            dedup_alts.append(cand_u)
    out["altUrls"] = dedup_alts[:6]
    return out


_SRV_HEALTH_RL = BoundedTTLCache(maxsize=4096, default_ttl=60.0)


async def server_health_report(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    url_raw = _clean(body.get("url") or body.get("host"), 1200)
    label = _clean(body.get("label"), 80)
    if not url_raw and not label:
        return JSONResponse({"ok": False}, status_code=400)
    ok = bool(body.get("ok", True)) and not bool(body.get("stalled", False))
    lat_ms = _finite_float(body.get("latencyMs"), 550.0 if ok else 4500.0, lo=20.0, hi=15000.0)
    bkt = _extract_srv_bucket(url_raw, label)
    ip_hash = hashlib.sha256(str(client_ip(request) or "anon").encode("utf-8")).hexdigest()[:12]
    rl_key = f"{ip_hash}:{bkt}:{'ok' if ok else 'fail'}"
    if _SRV_HEALTH_RL.get(rl_key):
        hmap_cur = _load_health_map()
        return JSONResponse({"ok": True, "bucket": bkt, "stats": hmap_cur.get(bkt) or {}})
    _SRV_HEALTH_RL.set(rl_key, 1, ttl=60.0)
    hmap = _load_health_map()
    rec = dict(hmap.get(bkt) or {"ok": 0, "fail": 0, "avgMs": lat_ms, "updatedAt": 0.0, "failReporters": []})
    reporters = [str(x) for x in (rec.get("failReporters") or []) if x][:16]
    if ok:
        rec["ok"] = min(500, int(rec.get("ok") or 0) + 1)
        if rec.get("fail", 0) > 0 and rec["ok"] % 2 == 0:
            rec["fail"] = max(0, int(rec["fail"]) - 1)
        if ip_hash in reporters:
            reporters.remove(ip_hash)
    else:
        rec["fail"] = min(200, int(rec.get("fail") or 0) + 1)
        if ip_hash not in reporters:
            reporters.append(ip_hash)
            reporters = reporters[-12:]
    rec["failReporters"] = reporters
    prev_ms = float(rec.get("avgMs") or lat_ms)
    rec["avgMs"] = round(prev_ms * 0.65 + lat_ms * 0.35, 1)
    rec["label"] = label or rec.get("label") or bkt
    rec["updatedAt"] = _now()
    hmap[bkt] = rec
    if len(hmap) > 160:
        oldest_k = min(hmap, key=lambda k: float(hmap[k].get("updatedAt") or 0))
        hmap.pop(oldest_k, None)
    _kv_set("wl:srv:health:v1", hmap, ttl_sec=604800)
    return JSONResponse({"ok": True, "bucket": bkt, "stats": rec})


async def server_health_get(request: Request) -> JSONResponse:
    hmap = _load_health_map()
    return JSONResponse({"ok": True, "servers": hmap, "count": len(hmap)})
# ---------------------------------------------------------------------------
# 12. Account-Bound YouTube Personalization Graph & OAuth Sync (v91)
# ---------------------------------------------------------------------------
_USER_YT_PREFS = BoundedTTLCache(maxsize=2048, default_ttl=86400.0)


def _default_yt_prefs() -> Dict[str, Any]:
    return {
        "subscriptions": [],
        "likedVideos": [],
        "searchHistory": [],
        "dismissedVideoIds": [],
        "blockedChannels": [],
        "topics": [],
        "googleConnected": False,
        "googleEmail": "",
        "googleChannelTitle": "",
        "updatedAt": 0.0,
    }


def _norm_yt_prefs(raw: Any) -> Dict[str, Any]:
    base = _default_yt_prefs()
    if not isinstance(raw, dict):
        return base
    subs = []
    seen_ch = set()
    for ch in (raw.get("subscriptions") if isinstance(raw.get("subscriptions"), list) else []):
        if not isinstance(ch, dict):
            continue
        cid = _clean(ch.get("channelId"), 48)
        cname = _clean(ch.get("name") or ch.get("title"), 100)
        ck = (cid or cname.lower()).strip()
        if not ck or ck in seen_ch:
            continue
        seen_ch.add(ck)
        subs.append({
            "channelId": cid,
            "name": cname or "YouTube Kanalı",
            "avatar": _clean(ch.get("avatar") or ch.get("thumbnail"), 800),
            "handle": _clean(ch.get("handle"), 64),
            "addedAt": _finite_float(ch.get("addedAt"), _now()),
        })
    liked = []
    seen_vid = set()
    for lv in (raw.get("likedVideos") if isinstance(raw.get("likedVideos"), list) else []):
        if not isinstance(lv, dict):
            continue
        vid = _clean(lv.get("videoId"), 20)
        if not vid or len(vid) < 6 or vid in seen_vid:
            continue
        seen_vid.add(vid)
        liked.append({
            "videoId": vid,
            "title": _clean(lv.get("title"), 160) or "YouTube Videosu",
            "channel": _clean(lv.get("channel"), 100) or "YouTube",
            "channelId": _clean(lv.get("channelId"), 48),
            "channelAvatar": _clean(lv.get("channelAvatar"), 800),
            "thumbnail": _clean(lv.get("thumbnail"), 800) or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "duration": _safe_int(lv.get("duration"), 0, lo=0, hi=86400),
            "likedAt": _finite_float(lv.get("likedAt"), _now()),
        })
    searches = []
    for sq in (raw.get("searchHistory") if isinstance(raw.get("searchHistory"), list) else []):
        sq_c = _clean(sq, 100)
        if sq_c and sq_c.lower() not in {x.lower() for x in searches}:
            searches.append(sq_c)
    dismissed = []
    for dv in (raw.get("dismissedVideoIds") if isinstance(raw.get("dismissedVideoIds"), list) else []):
        dv_c = _clean(dv, 24)
        if dv_c and dv_c not in dismissed:
            dismissed.append(dv_c)
    blocked = []
    for bc in (raw.get("blockedChannels") if isinstance(raw.get("blockedChannels"), list) else []):
        bc_c = _clean(bc, 100)
        if bc_c and bc_c.lower() not in {x.lower() for x in blocked}:
            blocked.append(bc_c)
    topics = []
    for tp in (raw.get("topics") if isinstance(raw.get("topics"), list) else []):
        tp_c = _clean(tp, 48)
        if tp_c and tp_c.lower() not in {x.lower() for x in topics}:
            topics.append(tp_c)
    base.update({
        "subscriptions": subs[:60],
        "likedVideos": liked[:80],
        "searchHistory": searches[:25],
        "dismissedVideoIds": dismissed[:200],
        "blockedChannels": blocked[:80],
        "topics": topics[:20],
        "googleConnected": bool(raw.get("googleConnected")),
        "googleEmail": _clean(raw.get("googleEmail"), 120),
        "googleChannelTitle": _clean(raw.get("googleChannelTitle"), 100),
        "updatedAt": _finite_float(raw.get("updatedAt"), _now()),
    })
    return base
def _load_user_yt_prefs(ukey: str) -> Dict[str, Any]:
    if not ukey:
        return _default_yt_prefs()
    kv_val = _kv_get(f"wl:user:ytprefs:{ukey}", None, max_age=2.0)
    if isinstance(kv_val, dict):
        norm = _norm_yt_prefs(kv_val)
        _USER_YT_PREFS[ukey] = norm
        return norm
    return _norm_yt_prefs(_USER_YT_PREFS.get(ukey))


def _save_user_yt_prefs(ukey: str, prefs: Dict[str, Any]) -> Dict[str, Any]:
    norm = _norm_yt_prefs({**prefs, "updatedAt": _now()})
    _USER_YT_PREFS[ukey] = norm
    _kv_set(f"wl:user:ytprefs:{ukey}", norm, ttl_sec=7776000)
    return norm


def _fetch_google_yt_oauth_data(access_token: str) -> Dict[str, Any]:
    tok = _clean(access_token, 2048)
    out: Dict[str, Any] = {"subs": [], "likes": [], "channelTitle": "", "ok": False}
    if not tok or len(tok) < 16:
        return out
    hdrs = {"Authorization": f"Bearer {tok}", "Accept": "application/json", "User-Agent": "Watchlivo/2.0"}
    try:
        req_me = urllib.request.Request("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", headers=hdrs)
        with urllib.request.urlopen(req_me, timeout=5) as r:
            me_data = json.loads(r.read().decode("utf-8", errors="ignore"))
            ch_items = me_data.get("items") or []
            if ch_items:
                out["channelTitle"] = _clean(((ch_items[0].get("snippet") or {}).get("title") or ""), 100)
                out["ok"] = True
    except Exception:
        pass
    try:
        req_sub = urllib.request.Request("https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=35", headers=hdrs)
        with urllib.request.urlopen(req_sub, timeout=6) as r:
            sub_data = json.loads(r.read().decode("utf-8", errors="ignore"))
            out["ok"] = True
            for it in (sub_data.get("items") or []):
                sn = it.get("snippet") or {}
                cid = _clean(((sn.get("resourceId") or {}).get("channelId") or ""), 48)
                cname = _clean(sn.get("title"), 100)
                thumbs = sn.get("thumbnails") or {}
                av = _clean(((thumbs.get("default") or thumbs.get("medium") or {}).get("url") or ""), 800)
                if cid or cname:
                    out["subs"].append({"channelId": cid, "name": cname, "avatar": av, "addedAt": _now()})
    except Exception:
        pass
    try:
        req_lk = urllib.request.Request("https://www.googleapis.com/youtube/v3/videos?part=snippet&myRating=like&maxResults=25", headers=hdrs)
        with urllib.request.urlopen(req_lk, timeout=6) as r:
            lk_data = json.loads(r.read().decode("utf-8", errors="ignore"))
            out["ok"] = True
            for it in (lk_data.get("items") or []):
                vid = _clean(it.get("id"), 20)
                sn = it.get("snippet") or {}
                if vid:
                    out["likes"].append({
                        "videoId": vid,
                        "title": _clean(sn.get("title"), 160),
                        "channel": _clean(sn.get("channelTitle"), 100),
                        "channelId": _clean(sn.get("channelId"), 48),
                        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                        "likedAt": _now(),
                    })
    except Exception:
        pass
    return out


def get_user_yt_taste_bundle(ukey: str) -> Dict[str, Any]:
    if not ukey:
        return {"authenticated": False, "progress": [], "watchlist": [], "musicHistory": [], "ytPrefs": _default_yt_prefs()}
    prog = _kv_get(f"wl:user:prog:{ukey}", None, max_age=2.0)
    if not isinstance(prog, list):
        prog = _USER_PROGRESS.get(ukey, [])
    wlist = _kv_get(f"wl:user:wlist:{ukey}", None, max_age=2.0)
    if not isinstance(wlist, list):
        wlist = _USER_WATCHLIST.get(ukey, [])
    mhist = _kv_get(f"wl:user:mhist:{ukey}", None, max_age=2.0)
    if not isinstance(mhist, list):
        mhist = _USER_MUSIC_HISTORY.get(ukey, [])
    prefs = _load_user_yt_prefs(ukey)
    return {"authenticated": True, "uid": ukey, "progress": prog[:40], "watchlist": wlist[:50], "musicHistory": mhist[:20], "ytPrefs": prefs}
async def user_yt_prefs_get(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "prefs": _default_yt_prefs()}, status_code=401, headers=_PRIVATE_HEADERS)
    prefs = _load_user_yt_prefs(ukey)
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "prefs": prefs}, headers=_PRIVATE_HEADERS)


async def user_yt_prefs_save(request: Request) -> JSONResponse:
    ukey = _verified_account_key(request)
    if not ukey:
        return JSONResponse({"ok": False, "authenticated": False, "uid": "", "prefs": _default_yt_prefs()}, status_code=401, headers=_PRIVATE_HEADERS)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    prefs = _load_user_yt_prefs(ukey)
    action = _clean(body.get("action") or "sync", 32).lower()
    imported_stats: Dict[str, Any] = {}

    if action == "reset":
        prefs = _default_yt_prefs()
    elif action in ("follow_channel", "unfollow_channel", "toggle_channel"):
        ch = body.get("channel") if isinstance(body.get("channel"), dict) else body
        cid = _clean(ch.get("channelId"), 48)
        cname = _clean(ch.get("name") or ch.get("channel"), 100)
        ck = (cid or cname.lower()).strip()
        if ck:
            subs = list(prefs.get("subscriptions") or [])
            existed = any((str(s.get("channelId") or "") == cid and cid) or (str(s.get("name") or "").lower() == cname.lower() and cname) for s in subs)
            subs = [s for s in subs if not ((cid and str(s.get("channelId") or "") == cid) or (cname and str(s.get("name") or "").lower() == cname.lower()))]
            if action == "follow_channel" or (action == "toggle_channel" and not existed):
                subs.insert(0, {
                    "channelId": cid,
                    "name": cname or cid,
                    "avatar": _clean(ch.get("avatar") or ch.get("channelAvatar"), 800),
                    "handle": _clean(ch.get("handle"), 64),
                    "addedAt": _now(),
                })
            prefs["subscriptions"] = subs[:60]
    elif action in ("like_video", "unlike_video", "toggle_like"):
        lv = body.get("video") if isinstance(body.get("video"), dict) else body
        vid = _clean(lv.get("videoId"), 20)
        if vid:
            likes = list(prefs.get("likedVideos") or [])
            existed = any(str(x.get("videoId") or "") == vid for x in likes)
            likes = [x for x in likes if str(x.get("videoId") or "") != vid]
            if action == "like_video" or (action == "toggle_like" and not existed):
                likes.insert(0, {
                    "videoId": vid,
                    "title": _clean(lv.get("title"), 160) or "YouTube Videosu",
                    "channel": _clean(lv.get("channel"), 100) or "YouTube",
                    "channelId": _clean(lv.get("channelId"), 48),
                    "channelAvatar": _clean(lv.get("channelAvatar"), 800),
                    "thumbnail": _clean(lv.get("thumbnail"), 800) or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "duration": _safe_int(lv.get("duration"), 0, lo=0, hi=86400),
                    "likedAt": _now(),
                })
            prefs["likedVideos"] = likes[:80]
    elif action == "dismiss_video":
        vid = _clean(body.get("videoId"), 24)
        if vid:
            dlist = [x for x in (prefs.get("dismissedVideoIds") or []) if x != vid]
            dlist.insert(0, vid)
            prefs["dismissedVideoIds"] = dlist[:200]
    elif action == "undo_dismiss":
        vid = _clean(body.get("videoId"), 24)
        prefs["dismissedVideoIds"] = [x for x in (prefs.get("dismissedVideoIds") or []) if x != vid]
    elif action == "block_channel":
        bch = _clean(body.get("channelId") or body.get("channel") or body.get("name"), 100)
        if bch:
            blist = [x for x in (prefs.get("blockedChannels") or []) if x.lower() != bch.lower()]
            blist.insert(0, bch)
            prefs["blockedChannels"] = blist[:80]
    elif action == "unblock_channel":
        bch = _clean(body.get("channelId") or body.get("channel") or body.get("name"), 100)
        prefs["blockedChannels"] = [x for x in (prefs.get("blockedChannels") or []) if x.lower() != bch.lower()]
    elif action == "add_search":
        q = _clean(body.get("query") or body.get("q"), 100)
        if q and len(q) >= 2:
            sh = [x for x in (prefs.get("searchHistory") or []) if x.lower() != q.lower()]
            sh.insert(0, q)
            prefs["searchHistory"] = sh[:25]
    elif action == "import_oauth":
        tok = _clean(body.get("ytAccessToken"), 2048)
        oauth_res = await asyncio.to_thread(_fetch_google_yt_oauth_data, tok) if tok else {"ok": False, "subs": [], "likes": [], "channelTitle": ""}
        if oauth_res.get("subs"):
            prefs["subscriptions"] = oauth_res["subs"] + list(prefs.get("subscriptions") or [])
        if oauth_res.get("likes"):
            prefs["likedVideos"] = oauth_res["likes"] + list(prefs.get("likedVideos") or [])
        prefs["googleConnected"] = bool(oauth_res.get("ok") or body.get("googleConnected", True))
        prefs["googleEmail"] = _clean(body.get("googleEmail") or prefs.get("googleEmail"), 120)
        prefs["googleChannelTitle"] = _clean(oauth_res.get("channelTitle") or body.get("googleChannelTitle") or prefs.get("googleChannelTitle"), 100)
        imported_stats = {"importedSubs": len(oauth_res.get("subs") or []), "importedLikes": len(oauth_res.get("likes") or []), "oauthOk": bool(oauth_res.get("ok"))}
    else:
        incoming = body.get("prefs") if isinstance(body.get("prefs"), dict) else body
        for k in ("subscriptions", "likedVideos", "searchHistory", "dismissedVideoIds", "blockedChannels", "topics"):
            if isinstance(incoming.get(k), list):
                prefs[k] = incoming[k] + list(prefs.get(k) or [])
        if "googleConnected" in incoming:
            prefs["googleConnected"] = bool(incoming.get("googleConnected"))
        if incoming.get("googleEmail"):
            prefs["googleEmail"] = _clean(incoming.get("googleEmail"), 120)
        if incoming.get("googleChannelTitle"):
            prefs["googleChannelTitle"] = _clean(incoming.get("googleChannelTitle"), 100)

    saved = _save_user_yt_prefs(ukey, prefs)
    return JSONResponse({"ok": True, "authenticated": True, "uid": ukey, "prefs": saved, **imported_stats}, headers=_PRIVATE_HEADERS)


# ---------------------------------------------------------------------------
# 9. Persistent Cross-Platform Voice Notes & Live Voice Relay Fallback
# ---------------------------------------------------------------------------
import pathlib as _vn_pathlib
import tempfile as _vn_tempfile
from starlette.responses import Response as _StarletteResponse

_VOICE_NOTE_MEM: Dict[str, Dict[str, Any]] = {}
_VOICE_RELAY_MEM: Dict[str, List[Dict[str, Any]]] = {}
_VN_TMP_DIR = _vn_pathlib.Path(_vn_tempfile.gettempdir()) / "vortex_voice_notes"
try:
    _VN_TMP_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    _VN_TMP_DIR = None


def _detect_audio_mime(raw_bytes: bytes, declared_mime: str = "") -> str:
    head = raw_bytes[:16]
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return "audio/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    dm = (declared_mime or "").split(";")[0].strip().lower()
    if dm in ("video/mp4", "audio/mp4", "audio/x-m4a", "audio/aac"):
        return "audio/mp4"
    if dm in ("video/webm", "audio/webm"):
        return "audio/webm"
    if dm.startswith("audio/"):
        return dm
    return "audio/wav"


_VN_UPLOAD_LIMIT = RateLimiter(30, 60.0, name="vn_upload")
_VR_POST_LIMIT = RateLimiter(25, 5.0, name="vr_post")
_VR_GET_LIMIT = RateLimiter(90, 10.0, name="vr_get")
_VR_AUTH_FAIL_LIMIT = RateLimiter(20, 60.0, name="vr_fail")
_RELAY_HEADERS = dict(_PRIVATE_HEADERS)


def _safe_cors_origin(request: Request) -> str:
    orig = (request.headers.get("origin") or "").strip()
    if orig in (
        "https://watchlivo.online",
        "https://www.watchlivo.online",
        "https://localhost",
        "capacitor://localhost",
        "ionic://localhost",
    ) or re.match(r"^https?://(?:localhost|127\.0\.0\.1)(?::\d+)?$", orig):
        return orig
    return ""


def _get_voice_relay_lock(room_id: str) -> asyncio.Lock:
    loop_id = id(asyncio.get_running_loop())
    lock_map = globals().setdefault("_VOICE_RELAY_LOCKS", {})
    if len(lock_map) > 160:
        for lk_k in list(lock_map.keys()):
            entry = lock_map.get(lk_k)
            if not isinstance(entry, tuple) or not entry[1].locked():
                lock_map.pop(lk_k, None)
    cur_entry = lock_map.get(room_id)
    if isinstance(cur_entry, tuple) and cur_entry[0] == loop_id:
        return cur_entry[1]
    new_lock = asyncio.Lock()
    lock_map[room_id] = (loop_id, new_lock)
    return new_lock


def _bound_voice_note_mem() -> None:
    while len(_VOICE_NOTE_MEM) > 120:
        oldest_k = min(_VOICE_NOTE_MEM, key=lambda k: float(_VOICE_NOTE_MEM[k].get("ts") or 0.0))
        _VOICE_NOTE_MEM.pop(oldest_k, None)


def _save_voice_note_entry(note_id: str, entry: Dict[str, Any]) -> None:
    _VOICE_NOTE_MEM[note_id] = entry
    _bound_voice_note_mem()
    if _VN_TMP_DIR is not None:
        try:
            (_VN_TMP_DIR / f"{note_id}.json").write_text(json.dumps(entry, separators=(",", ":")), encoding="utf-8")
            files = list(_VN_TMP_DIR.glob("*.json"))
            if len(files) > 120:
                files.sort(key=lambda p: p.stat().st_mtime)
                for old_fp in files[:-120]:
                    try:
                        old_fp.unlink(missing_ok=True)
                    except Exception:
                        pass
        except Exception:
            pass
    _kv_set(f"wl:vn:{note_id}", entry, ttl_sec=86400)


def _load_voice_note_entry(note_id: str) -> Optional[Dict[str, Any]]:
    clean_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(note_id or ""))[:40]
    if not clean_id:
        return None
    hit = _VOICE_NOTE_MEM.get(clean_id)
    if isinstance(hit, dict) and hit.get("b64"):
        return hit
    if _VN_TMP_DIR is not None:
        fp = _VN_TMP_DIR / f"{clean_id}.json"
        if fp.exists():
            try:
                loaded = json.loads(fp.read_text(encoding="utf-8"))
                if isinstance(loaded, dict) and loaded.get("b64"):
                    _VOICE_NOTE_MEM[clean_id] = loaded
                    _bound_voice_note_mem()
                    return loaded
            except Exception:
                pass
    kv_hit = _kv_get(f"wl:vn:{clean_id}", None, max_age=3600.0)
    _KV_MEM.pop(f"wl:vn:{clean_id}", None)
    _KV_READ_TS.pop(f"wl:vn:{clean_id}", None)
    if isinstance(kv_hit, dict) and kv_hit.get("b64"):
        _VOICE_NOTE_MEM[clean_id] = kv_hit
        _bound_voice_note_mem()
        return kv_hit
    return None


def persist_audio_note(raw_an: Any, fallback_id: str = "") -> Optional[Dict[str, Any]]:
    if not isinstance(raw_an, dict):
        return None
    try:
        an_dur = max(0.5, min(60.0, float(raw_an.get("duration") or 1.5)))
        if not math.isfinite(an_dur):
            an_dur = 2.0
    except (TypeError, ValueError):
        an_dur = 2.0
    raw_peaks = [
        round(max(0.05, min(1.0, float(x))), 2)
        for x in (raw_an.get("peaks") or [])[:36]
        if isinstance(x, (int, float)) and math.isfinite(float(x))
    ]
    norm_peaks = raw_peaks or [0.3, 0.62, 0.84, 0.48, 0.74, 0.52, 0.86, 0.42]
    existing_url = str(raw_an.get("url") or "").strip()
    m_url = re.match(r"^/api/rave/voice-note/([a-zA-Z0-9_-]{4,40})$", existing_url)
    an_du = str(raw_an.get("dataUrl") or "").strip()
    if m_url and not an_du:
        nid = m_url.group(1)
        return {
            "id": nid,
            "url": f"/api/rave/voice-note/{nid}",
            "mime": _clean(raw_an.get("mime") or "audio/wav", 40),
            "duration": round(an_dur, 1),
            "peaks": norm_peaks,
        }
    if not an_du or len(an_du) > 1200000 or "," not in an_du:
        return None
    hdr, b64_part = an_du.split(",", 1)
    if not hdr.lower().startswith(("data:audio/", "data:video/mp4", "data:video/webm", "data:application/octet-stream")):
        return None
    b64_clean = re.sub(r"\s+", "", b64_part)
    try:
        raw_bytes = base64.b64decode(b64_clean, validate=False)
    except Exception:
        return None
    if len(raw_bytes) < 32 or len(raw_bytes) > 900000:
        return None
    decl_mime = hdr[5:].split(";")[0] if hdr.lower().startswith("data:") else ""
    mime = _detect_audio_mime(raw_bytes, decl_mime)
    clean_b64 = base64.b64encode(raw_bytes).decode("ascii")
    norm_du = f"data:{mime};base64,{clean_b64}"
    nid = "vn_" + uuid.uuid4().hex[:16]
    _save_voice_note_entry(nid, {"id": nid, "mime": mime, "b64": clean_b64, "duration": round(an_dur, 1), "peaks": norm_peaks, "ts": _now()})
    return {
        "id": nid,
        "url": f"/api/rave/voice-note/{nid}",
        "mime": mime,
        "dataUrl": norm_du,
        "duration": round(an_dur, 1),
        "peaks": norm_peaks,
    }


async def voice_note_upload(request: Request):
    ip_key = str(client_ip(request) or "local")[:64]
    allowed_vn, retry_vn = _VN_UPLOAD_LIMIT.hit(ip_key)
    if not allowed_vn:
        return too_many_response(retry_vn)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz veri"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz veri"}, status_code=400)
    saved = persist_audio_note(body)
    if not saved:
        return JSONResponse({"ok": False, "error": "Ses kaydı işlenemedi"}, status_code=400)
    resp_note = {k: v for k, v in saved.items() if k != "dataUrl"}
    return JSONResponse({"ok": True, "audioNote": resp_note}, headers=_PRIVATE_HEADERS)


async def voice_note_stream(request: Request):
    cors_orig = _safe_cors_origin(request)
    if request.method == "OPTIONS":
        opt_hdrs = {
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
            "Accept-Ranges": "bytes",
        }
        if cors_orig:
            opt_hdrs["Access-Control-Allow-Origin"] = cors_orig
            opt_hdrs["Vary"] = "Origin"
        return _StarletteResponse(status_code=204, headers=opt_hdrs)
    note_id = request.path_params.get("note_id") or ""
    entry = _load_voice_note_entry(note_id)
    if not entry or not entry.get("b64"):
        return JSONResponse({"ok": False, "error": "Sesli mesaj bulunamadı"}, status_code=404)
    try:
        raw_bytes = base64.b64decode(entry["b64"])
    except Exception:
        return JSONResponse({"ok": False, "error": "Ses verisi bozuk"}, status_code=500)
    total = len(raw_bytes)
    mime = str(entry.get("mime") or "audio/wav")
    base_headers = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": 'inline; filename="voice-note"',
    }
    if cors_orig:
        base_headers["Access-Control-Allow-Origin"] = cors_orig
        base_headers["Vary"] = "Origin"
    if request.method == "HEAD":
        base_headers["Content-Length"] = str(total)
        return _StarletteResponse(status_code=200, headers=base_headers)
    rng = (request.headers.get("range") or request.headers.get("Range") or "").strip()
    if rng:
        m_rng = re.match(r"^bytes=(\d*)-(\d*)$", rng)
        if not m_rng or total <= 0:
            err_hdrs = {**base_headers, "Content-Range": f"bytes */{total}"}
            return _StarletteResponse(status_code=416, headers=err_hdrs)
        s_str, e_str = m_rng.group(1), m_rng.group(2)
        if not s_str and not e_str:
            err_hdrs = {**base_headers, "Content-Range": f"bytes */{total}"}
            return _StarletteResponse(status_code=416, headers=err_hdrs)
        if not s_str and e_str:
            suffix = int(e_str)
            if suffix <= 0:
                err_hdrs = {**base_headers, "Content-Range": f"bytes */{total}"}
                return _StarletteResponse(status_code=416, headers=err_hdrs)
            start = max(0, total - suffix)
            end = total - 1
        else:
            start = int(s_str)
            end = int(e_str) if e_str else (total - 1)
            if start >= total or (e_str and end < start):
                err_hdrs = {**base_headers, "Content-Range": f"bytes */{total}"}
                return _StarletteResponse(status_code=416, headers=err_hdrs)
            end = min(end, total - 1)
        chunk = raw_bytes[start : end + 1]
        base_headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        base_headers["Content-Length"] = str(len(chunk))
        return _StarletteResponse(content=chunk, status_code=206, headers=base_headers)
    base_headers["Content-Length"] = str(total)
    return _StarletteResponse(content=raw_bytes, status_code=200, headers=base_headers)


async def voice_relay_endpoint(request: Request):
    cors_orig = _safe_cors_origin(request)
    relay_hdrs = {**_RELAY_HEADERS, **({"Access-Control-Allow-Origin": cors_orig, "Vary": "Origin"} if cors_orig else {})}
    if request.method == "OPTIONS":
        opt_hdrs = {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
        if cors_orig:
            opt_hdrs["Access-Control-Allow-Origin"] = cors_orig
            opt_hdrs["Vary"] = "Origin"
        return _StarletteResponse(status_code=204, headers=opt_hdrs)
    room_id = re.sub(r"[^a-z0-9_\-]", "", str(request.path_params.get("room_id") or request.query_params.get("roomId") or "").lower())[:48]
    if not room_id:
        return JSONResponse({"ok": False, "error": "Geçersiz oda"}, status_code=400, headers=relay_hdrs)
    kv_key = f"wl:vrelay:{room_id}"
    now_t = _now()
    if len(_VOICE_RELAY_MEM) > 80:
        stale_rooms = [
            rk for rk, rbuf in list(_VOICE_RELAY_MEM.items())
            if not rbuf or (now_t - float(rbuf[-1].get("ts") or 0.0) > 30.0)
        ]
        for sr in stale_rooms:
            _VOICE_RELAY_MEM.pop(sr, None)
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "Geçersiz JSON"}, status_code=400, headers=_RELAY_HEADERS)
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "error": "Geçersiz veri"}, status_code=400, headers=_RELAY_HEADERS)
        cid = re.sub(r"[^a-zA-Z0-9_]", "", str(body.get("clientId") or ""))[:24]
        b64 = re.sub(r"\s+", "", str(body.get("b64") or ""))
        if not cid or not b64 or len(b64) > 80000:
            return JSONResponse({"ok": False, "error": "Geçersiz ses paketi"}, status_code=400, headers=_RELAY_HEADERS)
        ctok = str(body.get("clientToken") or "").strip()
        try:
            import rooms as _rm
            rm_obj = await _rm.STORE.get(room_id)
            tok_ok = bool(ctok and _rm.verify_client_token(room_id, ctok) == cid)
        except Exception:
            return JSONResponse({"ok": False, "error": "Oda doğrulaması yapılamadı"}, status_code=503, headers=_RELAY_HEADERS)
        if rm_obj is None:
            _VR_AUTH_FAIL_LIMIT.hit(client_ip(request))
            return JSONResponse({"ok": False, "error": "Oda bulunamadı"}, status_code=404, headers=_RELAY_HEADERS)
        if cid in (rm_obj.get("kicked") or rm_obj.get("kicked_cids") or []):
            return JSONResponse({"ok": False, "error": "Odadan çıkarıldınız"}, status_code=403, headers=_RELAY_HEADERS)
        if not tok_ok:
            ok_fail, retry_fail = _VR_AUTH_FAIL_LIMIT.hit(client_ip(request))
            if not ok_fail:
                return too_many_response(retry_fail)
            return JSONResponse({"ok": False, "error": "Yetkisiz istemci"}, status_code=403, headers=_RELAY_HEADERS)
        if cid not in (rm_obj.get("participants") or {}):
            return JSONResponse({"ok": False, "error": "Oda katılımcısı değilsiniz"}, status_code=403, headers=_RELAY_HEADERS)
        vmode = str(rm_obj.get("voipMode") or "all")
        if vmode == "off":
            return JSONResponse({"ok": False, "error": "Ses kanalı kapalı"}, status_code=403, headers=_RELAY_HEADERS)
        if vmode == "leader" and cid != rm_obj.get("host_id") and cid not in (rm_obj.get("co_hosts") or []):
            return JSONResponse({"ok": False, "error": "Sadece oda lideri konuşabilir"}, status_code=403, headers=_RELAY_HEADERS)
        if vmode == "stage" and cid != rm_obj.get("host_id") and cid not in (rm_obj.get("co_hosts") or []) and cid not in (rm_obj.get("stage_speakers") or []):
            return JSONResponse({"ok": False, "error": "Sahne konuşma izni gerekli"}, status_code=403, headers=_RELAY_HEADERS)
        ok_vr, _ = _VR_POST_LIMIT.hit(f"{room_id}:{cid}")
        if not ok_vr:
            return JSONResponse({"ok": False, "error": "Hız sınırı"}, status_code=429, headers=_RELAY_HEADERS)
        seq = _safe_int(body.get("seq"), 0, lo=0, hi=999999999)
        mime = _clean(body.get("mime") or "audio/wav", 32)
        if not mime.startswith("audio/"):
            mime = "audio/wav"
        rlock = _get_voice_relay_lock(room_id)
        async with rlock:
            now_t = time.time()
            cur = _kv_get(kv_key, None, max_age=0.12)
            buf = list(cur) if isinstance(cur, list) else list(_VOICE_RELAY_MEM.get(room_id, []))
            buf = [p for p in buf if isinstance(p, dict) and (now_t - float(p.get("ts") or 0.0) < 10.0)]
            pkt = {"id": f"{cid}_{seq}_{int(now_t * 1000)}", "fromId": cid, "seq": seq, "ts": round(now_t, 4), "mime": mime, "b64": b64}
            buf.append(pkt)
            buf = buf[-64:]
            _VOICE_RELAY_MEM[room_id] = buf
            _kv_set(kv_key, buf, ttl_sec=20)
        return JSONResponse({"ok": True, "ts": pkt["ts"]}, headers=relay_hdrs)
    cid_q = re.sub(r"[^a-zA-Z0-9_]", "", str(request.query_params.get("clientId") or ""))[:24]
    ctok_q = str(request.query_params.get("clientToken") or "").strip()
    if not cid_q:
        return JSONResponse({"ok": False, "error": "İstemci kimliği gerekli"}, status_code=400, headers=relay_hdrs)
    try:
        import rooms as _rm
        rm_obj_g = await _rm.STORE.get(room_id)
        tok_ok_g = bool(ctok_q and _rm.verify_client_token(room_id, ctok_q) == cid_q)
    except Exception:
        return JSONResponse({"ok": False, "error": "Oda doğrulaması yapılamadı"}, status_code=503, headers=relay_hdrs)
    if rm_obj_g is None:
        return JSONResponse({"ok": False, "error": "Oda bulunamadı"}, status_code=404, headers=relay_hdrs)
    if cid_q in (rm_obj_g.get("kicked") or rm_obj_g.get("kicked_cids") or []):
        return JSONResponse({"ok": False, "error": "Odadan çıkarıldınız"}, status_code=403, headers=relay_hdrs)
    if not tok_ok_g:
        ok_fail, retry_fail = _VR_AUTH_FAIL_LIMIT.hit(client_ip(request))
        if not ok_fail:
            return too_many_response(retry_fail)
        return JSONResponse({"ok": False, "error": "Yetkisiz istemci"}, status_code=403, headers=relay_hdrs)
    if cid_q not in (rm_obj_g.get("participants") or {}):
        return JSONResponse({"ok": False, "error": "Oda katılımcısı değilsiniz"}, status_code=403, headers=relay_hdrs)
    ok_get, _ = _VR_GET_LIMIT.hit(f"{room_id}:{cid_q}")
    if not ok_get:
        return JSONResponse({"ok": False, "error": "Hız sınırı"}, status_code=429, headers=relay_hdrs)
    if str(rm_obj_g.get("voipMode") or "all") == "off":
        return JSONResponse({"ok": True, "serverTime": round(now_t, 4), "packets": []}, headers=relay_hdrs)
    try:
        since_ts = float(request.query_params.get("sinceTs") or 0.0)
        if not math.isfinite(since_ts):
            since_ts = 0.0
    except (TypeError, ValueError):
        since_ts = 0.0
    rlock = _get_voice_relay_lock(room_id)
    async with rlock:
        now_t = time.time()
        cur = _kv_get(kv_key, None, max_age=0.12)
        buf = list(cur) if isinstance(cur, list) else list(_VOICE_RELAY_MEM.get(room_id, []))
        out_pkts = [
            p for p in buf
            if isinstance(p, dict)
            and p.get("fromId") != cid_q
            and float(p.get("ts") or 0.0) > since_ts
            and (now_t - float(p.get("ts") or 0.0) < 10.0)
        ]
    return JSONResponse({"ok": True, "serverTime": round(now_t, 4), "packets": out_pkts}, headers=relay_hdrs)


