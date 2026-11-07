"""VORTEX mesh (room) engine — Rave mesh parity.

One action handler serves both transports (WebSocket push + HTTP polling). Room state is a plain
JSON-serializable dict so it can live in memory (local/dev) or in a shared store (serverless).
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import time
import urllib.parse
import urllib.request
import uuid
import zlib
from typing import Any, Dict, List, Optional, Tuple

from security import BoundedTTLCache, RateLimiter, client_ip, constant_time_eq, is_ip_public_global, server_secret

# No hard-coded fallback: without VORTEX_SECRET the process gets an unguessable
# per-instance secret (or refuses to boot when WATCHLIVO_STRICT_SECRETS=1).
SYNC_SECRET = server_secret("VORTEX_SECRET")

VALID_PRIVACY = ("public", "nearby", "friends", "private")
VALID_PLAY_MODES = ("leader", "cohost", "autoplay", "quickplay", "vote")
VALID_VOIP = ("off", "leader", "stage", "all")
HTTP_PARTICIPANT_TTL = 300.0
EMPTY_ROOM_TTL = 14400.0
VOTE_WINDOW = 8.0
MAX_CHAT = 80
MEDIA_FIELDS = ("provider", "videoId", "url", "title", "thumbnail", "channel", "duration")

# Only these keys may ever be applied from a client-supplied sync snapshot.
SAFE_MERGE_KEYS = (
    "name", "privacy", "playMode", "voipMode", "queue", "skip_votes",
    "voteEndsAt", "endedKey", "rev", "polls", "curated", "isMature",
    "creatorId", "creatorCid", "explicitCreatorCid", "host_id", "co_hosts", "stage_speakers", "host_transferred",
)
_CLOSED_ROOMS = BoundedTTLCache(maxsize=4096, default_ttl=7200.0)
SYNC_TOKEN_TTL = 86400.0
CLIENT_TOKEN_TTL = 86400.0
_JOIN_LIMITER = RateLimiter(12, 300.0, name="room_pwd")
_CREATE_ROOM_LIMIT = RateLimiter(120, 60.0, name="room_create")
_PWD_ITERATIONS = 120_000


def now() -> float:
    return time.time()


def now_hhmm(ts: Optional[float] = None) -> str:
    from datetime import datetime, timezone, timedelta
    t_val = float(ts) if ts is not None else now()
    return datetime.fromtimestamp(t_val, tz=timezone(timedelta(hours=3))).strftime("%H:%M")


def clean_str(v: Any, limit: int) -> str:
    return str(v or "").strip()[:limit]


def _finite_float(
    v: Any,
    fallback: float = 0.0,
    min_val: Optional[float] = None,
    max_val: Optional[float] = None,
) -> float:
    try:
        f = float(v)
        if not math.isfinite(f):
            return fallback
        if min_val is not None and f < min_val:
            f = min_val
        if max_val is not None and f > max_val:
            f = max_val
        return f
    except (TypeError, ValueError):
        return fallback


def _safe_int(
    v: Any,
    fallback: int = 0,
    min_val: Optional[int] = None,
    max_val: Optional[int] = None,
) -> int:
    try:
        f = float(v)
        if not math.isfinite(f):
            return fallback
        iv = int(f)
        if min_val is not None and iv < min_val:
            iv = min_val
        if max_val is not None and iv > max_val:
            iv = max_val
        return iv
    except (TypeError, ValueError):
        return fallback


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0 and math.isfinite(v)
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false", "no", "off", "null", "none")
    return bool(v)


def _encrypt_pw_hash(pw_hash: str, room_id: str) -> str:
    if not pw_hash:
        return ""
    nonce = secrets.token_bytes(12)
    pt = pw_hash.encode("utf-8")
    ks = b""
    blk = 0
    while len(ks) < len(pt):
        ks += hashlib.sha256(SYNC_SECRET + b"|pw|" + room_id.encode("utf-8") + nonce + blk.to_bytes(2, "big")).digest()
        blk += 1
    ct = bytes(a ^ b for a, b in zip(pt, ks[:len(pt)]))
    mac = hmac.new(SYNC_SECRET, b"pwmac|" + room_id.encode("utf-8") + nonce + ct, hashlib.sha256).digest()[:12]
    return base64.urlsafe_b64encode(nonce + mac + ct).decode("ascii").rstrip("=")


def _decrypt_pw_hash(enc: str, room_id: str) -> str:
    if not enc or not isinstance(enc, str):
        return ""
    try:
        raw = base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4))
        if len(raw) <= 24:
            return ""
        nonce, mac, ct = raw[:12], raw[12:24], raw[24:]
        exp_mac = hmac.new(SYNC_SECRET, b"pwmac|" + room_id.encode("utf-8") + nonce + ct, hashlib.sha256).digest()[:12]
        if not hmac.compare_digest(mac, exp_mac):
            return ""
        ks = b""
        blk = 0
        while len(ks) < len(ct):
            ks += hashlib.sha256(SYNC_SECRET + b"|pw|" + room_id.encode("utf-8") + nonce + blk.to_bytes(2, "big")).digest()
            blk += 1
        return bytes(a ^ b for a, b in zip(ct, ks[:len(ct)])).decode("utf-8")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Room password + client identity helpers
# ---------------------------------------------------------------------------
def hash_room_password(raw: Any) -> str:
    """Hash a room password. Empty input means "no password"."""
    pw = clean_str(raw, 64)
    if not pw:
        return ""
    salt = secrets.token_hex(8)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt.encode("utf-8"), _PWD_ITERATIONS).hex()
    return f"pbkdf2${salt}${dk}"


def has_password(room: Dict[str, Any]) -> bool:
    return bool(room.get("passwordHash") or room.get("password"))


def verify_room_password(room: Dict[str, Any], raw: Any) -> bool:
    """Constant-time room password check (legacy plaintext rooms keep working)."""
    stored = str(room.get("passwordHash") or "")
    candidate = clean_str(raw, 64)
    if not stored:
        legacy = str(room.get("password") or "")
        return constant_time_eq(legacy, candidate) if legacy else True
    if stored.startswith("pbkdf2$"):
        try:
            _, salt, dk = stored.split("$", 2)
        except ValueError:
            return False
        calc = hashlib.pbkdf2_hmac("sha256", candidate.encode("utf-8"), salt.encode("utf-8"), _PWD_ITERATIONS).hex()
        return constant_time_eq(calc, dk)
    return constant_time_eq(stored, candidate)


def _b64_key(key: bytes, *parts: str) -> str:
    msg = "|".join(str(p) for p in parts).encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:32]


def sign_client_token(room_id: str, cid: str) -> str:
    """Server-issued proof that ``cid`` belongs to the caller for this room."""
    iat = int(now())
    sig = _b64_key(SYNC_SECRET, "cid", room_id, cid, str(iat))
    return f"{cid}.{iat}.{sig}"


def verify_client_token(room_id: str, token: Any) -> str:
    """Return the signed cid, or "" when the token is absent/invalid/expired."""
    if not isinstance(token, str) or len(token) > 200:
        return ""
    parts = token.split(".")
    if len(parts) != 3:
        return ""
    cid, iat_raw, sig = parts
    # Must accept every cid this module can mint, including short ones.
    if not re.fullmatch(r"[A-Za-z0-9_]{1,24}", cid or ""):
        return ""
    try:
        iat = int(iat_raw)
    except (TypeError, ValueError):
        return ""
    if now() - iat > CLIENT_TOKEN_TTL or iat - now() > 300:
        return ""
    expected = _b64_key(SYNC_SECRET, "cid", room_id, cid, str(iat))
    if constant_time_eq(expected, sig):
        return cid
    expected_legacy = _b64_key(SYNC_SECRET, "cid", room_id, cid, str(iat // int(CLIENT_TOKEN_TTL)))
    return cid if constant_time_eq(expected_legacy, sig) else ""


def _ws_verified_uid(scope: Any, q: Any) -> str:
    """Resolve the WebSocket caller's account id.

    Middleware only covers HTTP, so a signed token may also arrive as the
    ``authToken`` query parameter. Anything client-supplied is ignored.
    """
    try:
        uid = str((scope or {}).get("wl_uid") or "")
    except Exception:
        uid = ""
    if uid:
        return uid
    token = ""
    try:
        token = str(q.get("authToken") or q.get("token") or "")
    except Exception:
        token = ""
    if not token:
        return ""
    try:
        import auth_engine
        claims = auth_engine.verify_any_token(token)
    except Exception:
        claims = None
    return str((claims or {}).get("uid") or "")


def _cid_is_active(room: Dict[str, Any], cid: str, verified_uid: str = "", data: Optional[Dict[str, Any]] = None) -> bool:
    """True when ``cid`` is a live participant of ``room`` owned by someone else."""
    p = (room.get("participants") or {}).get(cid)
    if not isinstance(p, dict):
        return False
    if verified_uid and p.get("uid") == verified_uid:
        return False
    if p.get("transport") == "ws":
        try:
            return now() - float(p.get("lastSeen") or 0.0) < 30.0
        except (TypeError, ValueError):
            return False
    if data and isinstance(data, dict):
        req_name = clean_str(data.get("username"), 24)
        req_dev = clean_str(data.get("device"), 16)
        req_col = clean_str(data.get("color"), 16)
        req_uid = clean_str(data.get("uid") or data.get("userId"), 64)
        if p.get("_precreated") and req_name and _slugify_name(p.get("name") or "") == _slugify_name(req_name):
            return False
        mtype = str(data.get("type") or "")
        if (
            mtype not in ("", "poll", "ping") and (mtype != "init" or not room.get("fromCreateApi"))
            and room.get("explicitCreatorCid")
            and cid == room.get("explicitCreatorCid")
            and not str(room.get("creatorId") or "").startswith("u_wl_")
            and p.get("transport") != "ws"
            and req_name
            and p.get("name") == req_name
        ):
            return False
        if (
            req_name
            and p.get("name") == req_name
            and (not req_dev or p.get("device") == req_dev)
            and (not req_col or p.get("color") == req_col)
            and (not p.get("uid") or p.get("uid") == req_uid)
            and cid != room.get("creatorCid")
            and cid != room.get("host_id")
        ):
            return False
    try:
        return now() - float(p.get("lastSeen") or 0.0) < 30.0
    except (TypeError, ValueError):
        return False


def _is_generic_guest_name(raw_name: Any) -> bool:
    slug = re.sub(r"[^a-z0-9]", "", str(raw_name or "").lower())
    if not slug:
        return True
    if slug in ("misafir", "izleyici", "misafirizleyici", "guest", "viewer", "user", "kullanici"):
        return True
    return slug.startswith(("misafir", "izleyici", "guest"))


def _participant_identity_key(p: Dict[str, Any]) -> str:
    if not isinstance(p, dict) or p.get("transport") == "bot":
        return ""
    uid = str(p.get("uid") or "").strip()
    if uid:
        return f"uid:{uid}"
    name_slug = re.sub(r"[^a-z0-9]", "", str(p.get("name") or "").lower())
    color = str(p.get("color") or "").lower().strip()
    device = str(p.get("device") or "").lower().strip()
    if name_slug and not _is_generic_guest_name(name_slug):
        return f"ncd:{name_slug}|{color}|{device}"
    return ""


def _dedupe_room_participants(room: Dict[str, Any], prefer_cid: str = "") -> None:
    """Remove stale ghost duplicate sessions while preserving active multi-device/multi-tab sessions and the room creator."""
    p_map = room.get("participants")
    if not isinstance(p_map, dict) or len(p_map) <= 1:
        return
    t_now = now()
    creator_cid = str(room.get("creatorCid") or "").strip()
    host_cid = str(room.get("host_id") or "").strip()
    to_remove: List[Tuple[str, str]] = []
    by_ident: Dict[str, Tuple[str, Dict[str, Any]]] = {}
    removed_set = set()
    for cid, p in list(p_map.items()):
        if cid in removed_set:
            continue
        ident = _participant_identity_key(p)
        if not ident:
            continue
        if ident not in by_ident:
            by_ident[ident] = (cid, p)
            continue
        prev_cid, prev_p = by_ident[ident]
        prev_seen = float(prev_p.get("lastSeen") or 0.0)
        cur_seen = float(p.get("lastSeen") or 0.0)
        prev_alive = (t_now - prev_seen) <= 35.0
        cur_alive = (t_now - cur_seen) <= 35.0
        # If both sessions are actively polling within the last 10s, they are 2 separate open devices/tabs — keep both!
        if prev_alive and cur_alive:
            if prev_cid in (creator_cid, host_cid):
                continue
            if cid in (creator_cid, host_cid):
                by_ident[ident] = (cid, p)
            continue
        if prev_cid in (creator_cid, host_cid) and prev_alive:
            to_remove.append((cid, prev_cid))
        elif cid in (creator_cid, host_cid) and cur_alive:
            to_remove.append((prev_cid, cid))
            by_ident[ident] = (cid, p)
        elif cur_seen >= prev_seen:
            to_remove.append((prev_cid, cid))
            by_ident[ident] = (cid, p)
        else:
            to_remove.append((cid, prev_cid))
    if not to_remove:
        return
    left_map = room.setdefault("left", {})
    co_list = list(room.get("co_hosts") or [])
    for old_cid, keep_cid in to_remove:
        p_map.pop(old_cid, None)
        left_map[old_cid] = t_now
        if room.get("creatorCid") == old_cid:
            room["creatorCid"] = keep_cid
        if room.get("host_id") == old_cid:
            room["host_id"] = keep_cid
        if old_cid in co_list:
            co_list.remove(old_cid)
            if keep_cid not in co_list:
                co_list.append(keep_cid)
    room["co_hosts"] = co_list


def _media_defaults(room: Dict[str, Any]) -> Dict[str, Any]:
    """Guarantee a fully-formed media dict so downstream code cannot KeyError."""
    t = now()
    md = room.get("media")
    if not isinstance(md, dict):
        md = empty_media()
        room["media"] = md
    for key, fallback in (("playing", False), ("currentTime", 0.0), ("updatedAt", t), ("rate", 1.0), ("duration", 0.0)):
        if key == "playing":
            md[key] = _as_bool(md.get(key))
        else:
            raw_v = md.get(key)
            value = _finite_float(raw_v, fallback) if raw_v is not None else fallback
            md[key] = max(0.0, value) if key != "rate" else value
    if not math.isfinite(md["rate"]) or md["rate"] <= 0 or md["rate"] > 8:
        md["rate"] = 1.0
    return md



_TRUSTED_EMBED_HOSTS = (
    "youtube.com", "youtube-nocookie.com", "youtu.be", "googlevideo.com",
    "vimeo.com", "dailymotion.com", "dai.ly", "twitch.tv",
    "drive.google.com", "docs.google.com", "ok.ru", "odnoklassniki.ru",
    "sibnet.ru", "rutube.ru", "my.mail.ru", "vk.com", "vkvideo.ru",
    "vidmoly.to", "vidmoly.me", "vidmoly.net", "vidmoly.biz",
    "vmbox.", "vmnow.", "vmpx.", "vidsrc.", "vidlink.", "2embed.",
    "superembed.", "autoembed.", "multiembed.", "tau-video.xyz",
    "aliez.me", "sendvid.com", "streamtape.com", "doodstream.com",
    "filemoon.sx", "voe.sx", "mp4upload.com", "yourupload.com",
    "gdriveplayer.to", "rapidvid.org", "closeload.",
    "itunes.apple.com", "mzstatic.com", "dzcdn.net", "scdn.co",
)
_DIRECT_MEDIA_EXT_RE = re.compile(r"\.(?:m3u8|mp4|webm|mkv|mov|mpd|mp3|m4a|aac|ogg|opus|wav|ts)(?:$|[?#])", re.I)


def _is_trusted_embed_host(host: str) -> bool:
    h = (host or "").strip().lower().rstrip(".")
    if not h:
        return False
    for pat in _TRUSTED_EMBED_HOSTS:
        if pat.endswith("."):
            if h.startswith(pat) or f".{pat}" in h:
                return True
        elif h == pat or h.endswith("." + pat):
            return True
    return False


def _clean_media_url(
    raw: Any,
    limit: int = 2000,
    allow_relative: bool = True,
    embed_only: bool = False,
    require_media_or_trusted: bool = False,
) -> str:
    s = re.sub(r"[\x00-\x1f\x7f]", "", clean_str(raw, limit))
    if not s:
        return ""
    if s.startswith("/") and not s.startswith("//"):
        if not allow_relative:
            return ""
        if s.startswith(("/uploads/", "/api/rave/", "/static/")):
            return s
        return ""
    try:
        sp = urllib.parse.urlsplit(s)
    except Exception:
        return ""
    scheme = (sp.scheme or "").lower()
    if embed_only:
        if scheme != "https":
            return ""
    elif scheme not in ("http", "https"):
        return ""
    if sp.username or sp.password:
        return ""
    host = (sp.hostname or "").strip().lower().rstrip(".")
    if not host or host.endswith((".localhost", ".local", ".internal", ".arpa")):
        return ""
    is_local_direct_media = (
        not embed_only
        and host in ("localhost", "127.0.0.1")
        and bool(_DIRECT_MEDIA_EXT_RE.search(sp.path or ""))
    )
    if host == "localhost" and not is_local_direct_media:
        return ""
    try:
        ip_obj = ipaddress.ip_address(host)
        if not is_ip_public_global(ip_obj) and not is_local_direct_media:
            return ""
    except ValueError:
        if "." not in host and not is_local_direct_media:
            return ""
    if embed_only and not _is_trusted_embed_host(host):
        return ""
    if require_media_or_trusted and not (_is_trusted_embed_host(host) or _DIRECT_MEDIA_EXT_RE.search(sp.path or "")):
        return ""
    return s


def clean_media(data: Dict[str, Any]) -> Dict[str, Any]:
    raw_prov = re.sub(r"[^a-z0-9\-]", "", clean_str(data.get("provider"), 20).lower())
    stream_type = clean_str(data.get("streamType"), 16)
    raw_url_peek = clean_str(data.get("url"), 2000)
    if not raw_prov:
        if stream_type.lower() == "hls" or ".m3u8" in raw_url_peek.lower():
            raw_prov = "hls"
        elif _DIRECT_MEDIA_EXT_RE.search(raw_url_peek) or raw_url_peek.startswith(("/uploads/", "/api/rave/")):
            raw_prov = "direct"
        else:
            raw_prov = "web"
    is_iframe_prov = raw_prov in ("embed", "web", "drive", "rutube", "sibnet", "okru", "dailymotion", "twitch") and stream_type.lower() not in ("hls", "mp4", "webm", "mp3", "dash") and not _DIRECT_MEDIA_EXT_RE.search(raw_url_peek) and not raw_url_peek.startswith(("/uploads/", "/api/rave/"))
    url = _clean_media_url(raw_url_peek, 2000, allow_relative=not is_iframe_prov, embed_only=is_iframe_prov)
    thumb = _clean_media_url(data.get("thumbnail"), 1000, allow_relative=True, embed_only=False)
    duration = max(0.0, _finite_float(data.get("duration"), 0.0))
    is_tv = clean_str(data.get("mediaType"), 16).lower() in ("tv", "series", "show", "anime")
    season = max(1, _safe_int(data.get("season"), 1)) if is_tv else 0
    episode = max(1, _safe_int(data.get("episode"), 1)) if is_tv else 0
    alt_urls = []
    for u in (data.get("altUrls") or [])[:8]:
        if isinstance(u, str):
            cu = _clean_media_url(u, 1500, allow_relative=True, embed_only=False)
            if cu and (cu.startswith("/api/rave/") or cu.startswith("https://")) and len(alt_urls) < 6:
                alt_urls.append(cu)
    servers = []
    for srv in (data.get("servers") or [])[:8]:
        if isinstance(srv, dict) and srv.get("url"):
            srv_st = clean_str(srv.get("streamType"), 16) or "hls"
            srv_embed = srv_st.lower() == "embed"
            srv_u = _clean_media_url(srv.get("url"), 1500, allow_relative=not srv_embed, embed_only=srv_embed)
            if srv_u and (srv_u.startswith("/api/rave/") or srv_u.startswith("https://")):
                servers.append({
                    "id": clean_str(srv.get("id"), 24) or f"srv-{len(servers) + 1}",
                    "label": clean_str(srv.get("label"), 80) or f"📡 Sunucu {len(servers) + 1}",
                    "url": srv_u,
                    "streamType": srv_st,
                })
    sub_tracks = []
    for st in (data.get("subtitleTracks") or [])[:12]:
        if isinstance(st, dict) and st.get("url"):
            su = _clean_media_url(st.get("url"), 2000, allow_relative=True, embed_only=False)
            if not su:
                continue
            if "rapidvid.org/407eb1ed" in su or "1952401276" in su:
                continue
            sub_tracks.append({
                "id": clean_str(st.get("id"), 20),
                "lang": clean_str(st.get("lang"), 12),
                "label": clean_str(st.get("label"), 60),
                "url": su,
                "source": clean_str(st.get("source"), 24),
                "kind": "subtitles",
            })
    aud_tracks = []
    for at in (data.get("audioTracks") or [])[:6]:
        if isinstance(at, dict) and at.get("id"):
            au = _clean_media_url(at.get("url"), 1500, allow_relative=True, embed_only=False)
            aud_tracks.append({
                "id": clean_str(at.get("id"), 20),
                "lang": clean_str(at.get("lang"), 12),
                "targetLang": clean_str(at.get("targetLang") or at.get("lang"), 12),
                "audioLang": clean_str(at.get("audioLang") or at.get("lang"), 12),
                "label": clean_str(at.get("label"), 60),
                "mode": clean_str(at.get("mode"), 20) or "stream",
                "url": au,
            })
    raw_intro = data.get("intro")
    intro = None
    if isinstance(raw_intro, dict) and raw_intro.get("end"):
        i_start = max(0.0, _finite_float(raw_intro.get("start"), 0.0))
        i_end = max(0.0, _finite_float(raw_intro.get("end"), 0.0))
        if i_end > i_start + 3:
            intro = {"start": round(i_start, 1), "end": round(i_end, 1), "label": clean_str(raw_intro.get("label"), 40) or "⏩ İntroyu Atla"}
    poster_clean = _clean_media_url(data.get("poster"), 1000, allow_relative=True, embed_only=False) or thumb
    return {
        "provider": raw_prov,
        "catalogProvider": re.sub(r"[^a-z0-9\-]", "", clean_str(data.get("catalogProvider"), 20).lower()),
        "videoId": clean_str(data.get("videoId"), 200),
        "url": url,
        "embedUrl": _clean_media_url(data.get("embedUrl"), 2000, allow_relative=False, embed_only=True),
        "streamType": stream_type,
        "providerUrl": _clean_media_url(data.get("providerUrl"), 2000, allow_relative=False, embed_only=False),
        "officialUrl": _clean_media_url(data.get("officialUrl"), 2000, allow_relative=False, embed_only=False),
        "sourceUrl": _clean_media_url(data.get("sourceUrl"), 2000, allow_relative=True, embed_only=False),
        "altUrls": alt_urls,
        "servers": servers,
        "subtitleTracks": sub_tracks,
        "audioTracks": aud_tracks,
        "intro": intro,
        "title": clean_str(data.get("title"), 200) or "Video",
        "thumbnail": thumb,
        "channel": clean_str(data.get("channel"), 120),
        "duration": duration,
        "live": bool(data.get("live")),
        "isMusic": bool(data.get("isMusic") or data.get("mediaType") == "music"),
        "musicMode": clean_str(data.get("musicMode"), 20),
        "clipVideoId": clean_str(data.get("clipVideoId"), 60),
        "isRemix": bool(data.get("isRemix")),
        "versionBadge": clean_str(data.get("versionBadge"), 40),
        "musicPlatformLabel": clean_str(data.get("musicPlatformLabel"), 120),
        "mvUrl": _clean_media_url(data.get("mvUrl"), 1500, allow_relative=True, require_media_or_trusted=True),
        "bgVideoUrl": _clean_media_url(data.get("bgVideoUrl"), 1500, allow_relative=True, require_media_or_trusted=True),
        "bgYoutubeId": clean_str(data.get("bgYoutubeId"), 40),
        "artist": clean_str(data.get("artist"), 100),
        "songTitle": clean_str(data.get("songTitle"), 120),
        "poster": poster_clean,
        "audioPreviewUrl": _clean_media_url(data.get("audioPreviewUrl"), 1500, allow_relative=True, require_media_or_trusted=True),
        "similar": [
            {
                "id": clean_str(s.get("id") or s.get("trackId"), 80),
                "trackId": clean_str(s.get("trackId") or s.get("id"), 80),
                "videoId": clean_str(s.get("videoId"), 40),
                "mvUrl": _clean_media_url(s.get("mvUrl"), 1500, allow_relative=True, require_media_or_trusted=True),
                "audioPreviewUrl": _clean_media_url(s.get("audioPreviewUrl"), 1500, allow_relative=True, require_media_or_trusted=True),
                "artist": clean_str(s.get("artist"), 80),
                "songTitle": clean_str(s.get("songTitle") or s.get("title"), 100),
                "title": clean_str(s.get("title") or s.get("songTitle"), 140),
                "poster": _clean_media_url(s.get("poster") or s.get("thumbnail"), 600, allow_relative=True),
                "duration": max(90, _safe_int(s.get("duration"), 200)),
                "sourcePlatform": clean_str(s.get("sourcePlatform"), 30),
                "sourceBadge": clean_str(s.get("sourceBadge"), 60),
            }
            for s in (data.get("similar") or [])[:12]
            if isinstance(s, dict) and (s.get("songTitle") or s.get("title"))
        ],
        "altVideoIds": [clean_str(v, 20) for v in (data.get("altVideoIds") or [])[:6] if isinstance(v, str) and v.strip()],
        "id": clean_str(data.get("id"), 64),
        "seriesTitle": clean_str(data.get("seriesTitle"), 160),
        "originalTitle": clean_str(data.get("originalTitle"), 160),
        "year": clean_str(data.get("year"), 12),
        "origLang": clean_str(data.get("origLang"), 12),
        "tmdbId": clean_str(data.get("tmdbId"), 40),
        "imdbId": clean_str(data.get("imdbId"), 40),
        "mediaType": clean_str(data.get("mediaType"), 16),
        "season": season,
        "episode": episode,
        "episodeCount": _safe_int(data.get("episodeCount"), 0, 0, 5000) if is_tv else 0,
        "totalSeasons": _safe_int(data.get("totalSeasons"), 0, 0, 200) if is_tv else 0,
        "seasonsMeta": [
            {
                "season": _safe_int(sm.get("season") or sm.get("season_number"), 0, 0, 200),
                "episodeCount": _safe_int(sm.get("episodeCount") or sm.get("episode_count"), 0, 0, 5000),
            }
            for sm in (data.get("seasonsMeta") or [])[:40]
            if is_tv and isinstance(sm, dict) and _safe_int(sm.get("season") or sm.get("season_number"), 0) > 0
        ],
        "isRaveDJ": bool(data.get("isRaveDJ")),
        "bpm": max(60, min(200, _safe_int(data.get("bpm"), 124))) if data.get("bpm") else 0,
        "crossfadePoints": [round(max(0.0, _finite_float(x, 0.0)), 1) for x in (data.get("crossfadePoints") or [])[:12] if isinstance(x, (int, float)) and math.isfinite(x)],
        "mashupTracks": [
            {
                "videoId": clean_str(t.get("videoId"), 40),
                "title": clean_str(t.get("title"), 140),
                "artist": clean_str(t.get("artist"), 80),
                "url": _clean_media_url(t.get("url"), 1500, allow_relative=True, require_media_or_trusted=True),
                "thumbnail": _clean_media_url(t.get("thumbnail"), 600, allow_relative=True),
                "bpm": max(60, min(200, _safe_int(t.get("bpm"), 124))),
            }
            for t in (data.get("mashupTracks") or [])[:2]
            if isinstance(t, dict)
        ],
    }


def media_key(m: Dict[str, Any]) -> str:
    if not m:
        return ""
    if not (m.get("url") or m.get("videoId") or m.get("tmdbId") or m.get("imdbId") or m.get("id")):
        return ""
    try:
        s = max(1, int(m.get("season") or 1))
    except (TypeError, ValueError):
        s = 1
    try:
        e = max(1, int(m.get("episode") or 1))
    except (TypeError, ValueError):
        e = 1
    if m.get("tmdbId"):
        return f"tmdb|{m.get('tmdbId')}|{m.get('mediaType') or 'movie'}|{s}|{e}"
    if m.get("imdbId"):
        return f"imdb|{m.get('imdbId')}|{m.get('mediaType') or 'movie'}|{s}|{e}"
    mid = str(m.get("id") or "").strip()
    if mid and re.match(r"^(cat[-_]|acx[-_]|anx[-_]|t24[-_]|yt[-_]|tv[-_]|radyo[-_]|fhd[-_]|hfnl[-_]|dbx[-_]|dl[-_]|dp[-_]|trd[-_]|krm[-_])", mid, re.I):
        return f"cat|{mid}|{s}|{e}"
    if m.get("videoId"):
        return f"vid|{m.get('provider') or 'ext'}|{m.get('videoId')}|{s}|{e}"
    is_catalog_stream = bool(m.get("seriesTitle") or m.get("originalTitle") or m.get("catalogProvider") or "/api/rave/" in str(m.get("url") or "") or m.get("season") or m.get("episode"))
    raw_title = str(m.get("seriesTitle") or m.get("originalTitle") or m.get("title") or "").strip().lower()
    if is_catalog_stream and raw_title and raw_title not in ("video", "medya", "stream", "canlı yayın", "medya yükleniyor…", "medya seçilmedi"):
        base_title = re.sub(r"\s+[—–-]\s*\d+\.\s*sezon.*$", "", raw_title, flags=re.I).strip()
        if base_title and base_title not in ("video", "medya", "stream"):
            return f"title|{base_title}|{m.get('mediaType') or 'movie'}|{s}|{e}"
    return f"{m.get('provider')}|{m.get('videoId') or ''}|{m.get('url') or ''}|{s}|{e}"


def empty_media() -> Dict[str, Any]:
    return {"provider": "", "videoId": "", "url": "", "title": "", "thumbnail": "", "channel": "", "duration": 0.0,
            "playing": False, "currentTime": 0.0, "rate": 1.0, "updatedAt": now(), "lastActionBy": ""}


def new_room(room_id: str, name: str = "", privacy: str = "public", play_mode: str = "leader",
             creator: str = "", creator_id: str = "", password: str = "", is_mature: bool = False) -> Dict[str, Any]:
    return {
        "id": room_id,
        "name": clean_str(name, 45) or "Watchlivo Odası",
        "privacy": privacy if privacy in VALID_PRIVACY else "public",
        "playMode": play_mode if play_mode in VALID_PLAY_MODES else "leader",
        "voipMode": "all",
        "isMature": bool(is_mature),
        "passwordHash": hash_room_password(password),
        "creator": clean_str(creator, 24),
        "creatorId": clean_str(creator_id, 64),
        "creatorCid": "",
        "host_id": None,
        "co_hosts": [],
        "createdAt": now(),
        "lastActiveAt": now(),
        "media": empty_media(),
        "queue": [],
        "skip_votes": [],
        "voteEndsAt": 0.0,
        "endedKey": "",
        "rev": 1,
        "participants": {},
        "chat": [],
        "polls": [],
        "events": [],
        "signals": [],
    }


def prune_chat(room: Dict[str, Any]) -> None:
    """Remove expired chat history and deduplicate ephemeral system pills."""
    t = now()
    p_map = room.get("participants") or {}
    has_humans = any(p.get("transport") != "bot" for p in p_map.values())
    if not has_humans:
        empty_since = float(room.get("emptySince") or 0.0)
        if room.get("curated") or (empty_since > 0.0 and t - empty_since > 3600.0):
            room["chat"] = []
            room["polls"] = []
        return
    raw_items = [m for m in (room.get("chat") or []) if isinstance(m, dict) and float(m.get("ts") or 0.0) > 0.0]
    raw_items.sort(key=lambda x: float(x.get("ts") or 0.0))
    cleaned = []
    for m in raw_items:
        m_ts = float(m.get("ts") or 0.0)
        ttl = 1800.0 if m.get("system") else 86400.0
        if t - m_ts <= ttl:
            cleaned.append(m)
    presence_count = 0
    seen_media_sys = False
    deduped_rev = []
    for m in reversed(cleaned):
        if m.get("system"):
            txt = str(m.get("text") or "")
            if "katıldı" in txt or "ayrıldı" in txt:
                if presence_count >= 6:
                    continue
                presence_count += 1
            elif "oynatılıyor" in txt or "başlatıldı" in txt:
                if seen_media_sys:
                    continue
                seen_media_sys = True
        deduped_rev.append(m)
    deduped_rev.reverse()
    room["chat"] = deduped_rev[-MAX_CHAT:]


def pack_sync_token(room: Dict[str, Any]) -> str:
    t = now()
    prune_chat(room)
    p_map = room.get("participants") or {}
    m_obj = room.get("media") or {}
    m_upd = float(m_obj.get("updatedAt") or 0.0)
    m_url_sig = str(m_obj.get("url") or m_obj.get("videoId") or "")[:48]
    sig_list_raw = room.get("signals") or []
    last_sig_id = str(sig_list_raw[-1].get("id") or "") if sig_list_raw and isinstance(sig_list_raw[-1], dict) else ""
    tok_sig = f"{room.get('rev')}:{len(p_map)}:{m_upd:.2f}:{m_url_sig}:{len(room.get('chat') or [])}:{last_sig_id}:{room.get('privacy')}:{room.get('playMode')}:{room.get('voipMode')}:{room.get('name')}:{str(room.get('passwordHash') or '')[:12]}:{int(t // 4)}"
    if room.get("_tok_sig") == tok_sig and room.get("_tok_val"):
        return room["_tok_val"]
    host_id = room.get("host_id")
    co_set = set(room.get("co_hosts") or [])
    stage_set = set(room.get("stage_speakers") or [])
    total_humans = sum(1 for p in p_map.values() if isinstance(p, dict) and p.get("transport") != "bot")
    is_large_room = total_humans >= 25
    p_cap = 20 if is_large_room else 24
    p_items = sorted(
        p_map.items(),
        key=lambda kv: (0 if kv[0] == host_id else (1 if kv[0] in co_set else (2 if kv[0] in stage_set or not kv[1].get("muted", True) or kv[1].get("cam") else 3))),
    )[:p_cap]
    snap = {k: room.get(k) for k in ("id", "name", "privacy", "playMode", "voipMode", "isMature", "creator",
                                     "creatorId", "creatorCid", "explicitCreatorCid", "host_id", "co_hosts", "stage_speakers", "host_transferred",
                                     "createdAt", "lastActiveAt", "media", "queue", "skip_votes", "voteEndsAt",
                                     "endedKey", "kicked", "left", "rev", "curated", "chatClearedAt")}
    if room.get("passwordHash"):
        snap["pwEnc"] = _encrypt_pw_hash(str(room.get("passwordHash") or ""), str(room.get("id") or ""))
    snap["sigExp"] = t + SYNC_TOKEN_TTL
    snap["totalParticipants"] = total_humans
    snap["largeRoomMode"] = is_large_room
    snap_parts: Dict[str, Any] = {}
    for pcid, pp in p_items:
        if isinstance(pp, dict):
            pp_c = {pk: pv for pk, pv in pp.items() if not str(pk).startswith("_")}
            if str(pp_c.get("uid") or "").startswith("guest_"):
                pp_c.pop("uid", None)
            snap_parts[pcid] = pp_c
    snap["participants"] = snap_parts
    compact_chat = []
    chat_slice = -15 if is_large_room else -25
    for cm in (room.get("chat") or [])[chat_slice:]:
        if isinstance(cm, dict):
            has_big_an = cm.get("audioNote") and len(str((cm.get("audioNote") or {}).get("dataUrl") or "")) > 16000
            has_big_snap = cm.get("snapshot") and len(str(cm.get("snapshot") or "")) > 4000
            if has_big_an or has_big_snap:
                cm_copy = dict(cm)
                if has_big_an:
                    an_copy = dict(cm["audioNote"])
                    an_copy.pop("dataUrl", None)
                    cm_copy["audioNote"] = an_copy
                if has_big_snap:
                    cm_copy.pop("snapshot", None)
                compact_chat.append(cm_copy)
            else:
                compact_chat.append(cm)
        else:
            compact_chat.append(cm)
    snap["chat"] = compact_chat
    snap["polls"] = (room.get("polls") or [])[-10:]
    compact_events = []
    for ev_it in [e for e in (room.get("events") or []) if t - float(e.get("ts") or 0) < 25.0][-25:]:
        if isinstance(ev_it, dict) and isinstance(ev_it.get("message"), dict):
            em = ev_it["message"]
            if (em.get("snapshot") and len(str(em.get("snapshot") or "")) > 4000) or (em.get("audioNote") and len(str((em.get("audioNote") or {}).get("dataUrl") or "")) > 16000):
                ev_copy = dict(ev_it)
                em_copy = dict(em)
                em_copy.pop("snapshot", None)
                if isinstance(em_copy.get("audioNote"), dict):
                    an_c = dict(em_copy["audioNote"])
                    an_c.pop("dataUrl", None)
                    em_copy["audioNote"] = an_c
                ev_copy["message"] = em_copy
                compact_events.append(ev_copy)
                continue
        compact_events.append(ev_it)
    snap["events"] = compact_events
    snap["signals"] = [s for s in (room.get("signals") or []) if isinstance(s, dict) and (t - float(s.get("ts") or 0) < 20.0)][-24:]
    raw = zlib.compress(json.dumps(snap, separators=(",", ":"), ensure_ascii=False).encode(), 1)
    b64 = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    sig = hmac.new(SYNC_SECRET, b64.encode(), hashlib.sha256).hexdigest()[:24]
    tok = f"{b64}.{sig}"
    room["_tok_sig"] = tok_sig
    room["_tok_val"] = tok
    return tok


def merge_sync_token(room: Optional[Dict[str, Any]], token: Any, room_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(token, str) or len(token) > 131072 or "." not in token:
        return room
    b64, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(hmac.new(SYNC_SECRET, b64.encode(), hashlib.sha256).hexdigest()[:24], sig):
        return room
    try:
        pad = "=" * (-len(b64) % 4)
        decoder = zlib.decompressobj()
        raw = decoder.decompress(base64.urlsafe_b64decode(b64 + pad), 1024 * 1024)
        if not decoder.eof or decoder.unconsumed_tail:
            return room
        snap = json.loads(raw.decode())
    except Exception:
        return room
    if not isinstance(snap, dict) or snap.get("id") != room_id:
        return room
    t = now()
    try:
        if float(snap.get("sigExp") or 0.0) < t:
            return room
    except (TypeError, ValueError):
        return room
    snap_active_humans = any(
        isinstance(sp, dict) and sp.get("transport") != "bot" and (t - float(sp.get("lastSeen") or 0) <= HTTP_PARTICIPANT_TTL)
        for sp in (snap.get("participants") or {}).values()
    ) or bool(snap.get("creatorId") or snap.get("host_id"))
    if not snap_active_humans:
        return room
    if room is None:
        if room_id in _CLOSED_ROOMS and not snap.get("curated"):
            return None
        fresh = new_room(
            room_id,
            clean_str(snap.get("name"), 45),
            str(snap.get("privacy") or "public"),
            str(snap.get("playMode") or "leader"),
            clean_str(snap.get("creator"), 24),
            clean_str(snap.get("creatorId"), 64),
        )
        for k in SAFE_MERGE_KEYS:
            if k in snap:
                fresh[k] = snap[k]
        try:
            fresh["createdAt"] = float(snap.get("createdAt") or now())
        except (TypeError, ValueError):
            fresh["createdAt"] = now()
        if snap.get("pwEnc"):
            dec_pw = _decrypt_pw_hash(str(snap.get("pwEnc") or ""), room_id)
            if dec_pw:
                fresh["passwordHash"] = dec_pw
        fresh["participants"] = {
            cid: ({**sp, "lastSeen": min(_finite_float(sp.get("lastSeen"), t), t - (HTTP_PARTICIPANT_TTL - 18.0))} if sp.get("transport") != "bot" else sp)
            for cid, sp in (snap.get("participants") or {}).items() if isinstance(sp, dict)
        }
        if snap.get("totalParticipants"):
            try:
                fresh["totalParticipants"] = int(snap.get("totalParticipants") or 0)
            except (TypeError, ValueError):
                pass
        fresh["chat"] = [m for m in (snap.get("chat") or []) if isinstance(m, dict) and (not m.get("system") or (t - float(m.get("ts") or 0.0) <= 1800.0))][-MAX_CHAT:]
        fresh["polls"] = [p for p in (snap.get("polls") or []) if isinstance(p, dict)][-10:]
        fresh["events"] = [e for e in (snap.get("events") or []) if isinstance(e, dict)]
        fresh["signals"] = [s for s in (snap.get("signals") or []) if isinstance(s, dict)]
        # A cold instance restores from the signed snapshot, so the currently
        # playing media has to come with it (the token is HMAC-signed + expiring).
        snap_media = snap.get("media")
        if isinstance(snap_media, dict) and (snap_media.get("url") or snap_media.get("videoId") or snap_media.get("tmdbId") or snap_media.get("title")):
            md = clean_media(snap_media)
            for pb_k in ("playing", "currentTime", "rate", "updatedAt", "lastActionBy", "playbackAnchored", "lastExplicitPauseAt"):
                if pb_k in snap_media:
                    md[pb_k] = snap_media[pb_k]
            fresh["media"] = _media_defaults({"media": md})
        fresh.setdefault("left", {})
        prune_chat(fresh)
        return fresh
    room_has_humans = any(p.get("transport") != "bot" for p in (room.get("participants") or {}).values())
    if not room_has_humans and room.get("curated"):
        return room
    kicked = set(room.get("kicked") or []) | set(snap.get("kicked") or [])
    left_map: Dict[str, float] = {}
    for src in (room.get("left") or {}, snap.get("left") or {}):
        if isinstance(src, dict):
            for lcid, lts in src.items():
                if t - float(lts or 0) < HTTP_PARTICIPANT_TTL + 60.0:
                    left_map[lcid] = max(left_map.get(lcid, 0.0), float(lts or 0))
    merged_p = dict(room.get("participants") or {})
    for cid, sp in (snap.get("participants") or {}).items():
        sp_seen = float(sp.get("lastSeen") or 0)
        if cid in kicked or (cid in left_map and left_map[cid] >= sp_seen):
            merged_p.pop(cid, None)
        elif sp.get("transport") != "bot" and t - sp_seen > HTTP_PARTICIPANT_TTL:
            continue
        elif cid not in merged_p or sp_seen > float(merged_p[cid].get("lastSeen") or 0):
            merged_p[cid] = sp
    cleared_at = max(float(room.get("chatClearedAt") or 0.0), float(snap.get("chatClearedAt") or 0.0))
    if cleared_at > 0.0:
        room["chatClearedAt"] = cleared_at
    seen_c: Dict[str, Dict[str, Any]] = {}
    merged_c = []
    for m in (room.get("chat") or []) + (snap.get("chat") or []):
        if not isinstance(m, dict):
            continue
        m_ts = float(m.get("ts") or 0.0)
        ttl_c = 1800.0 if m.get("system") else 86400.0
        if m_ts <= 0.0 or (t - m_ts > ttl_c) or (cleared_at > 0.0 and m_ts <= cleared_at):
            continue
        mid = m.get("id")
        if mid and mid not in seen_c:
            mc = dict(m)
            seen_c[mid] = mc
            merged_c.append(mc)
        elif mid and mid in seen_c:
            if isinstance(m.get("audioNote"), dict):
                cur_an = dict(seen_c[mid].get("audioNote") or {})
                for ak, av in m["audioNote"].items():
                    if av and not cur_an.get(ak):
                        cur_an[ak] = av
                if cur_an:
                    seen_c[mid]["audioNote"] = cur_an
            if isinstance(m.get("reactions"), dict):
                existing_r = dict(seen_c[mid].get("reactions") or {})
                for em, ulist in m["reactions"].items():
                    if isinstance(ulist, list):
                        merged_u = list(dict.fromkeys((existing_r.get(em) or []) + ulist))
                        if merged_u:
                            existing_r[em] = merged_u[:30]
                seen_c[mid]["reactions"] = existing_r
    merged_c.sort(key=lambda x: float(x.get("ts") or 0.0))
    seen_ev = set()
    raw_evs = []
    best_hb_id = None
    best_hb_key = (-1.0, -1.0)
    for ev in (room.get("events") or []) + (snap.get("events") or []):
        if not isinstance(ev, dict):
            continue
        eid = ev.get("id")
        ev_ts = float(ev.get("ts") or 0.0)
        if eid and eid not in seen_ev and t - ev_ts < 25.0:
            seen_ev.add(eid)
            raw_evs.append(ev)
            if ev.get("type") == "sync" and ev.get("action") == "heartbeat":
                hb_ct = float((ev.get("media") or {}).get("currentTime") or 0.0)
                hb_key = (ev_ts, hb_ct)
                if hb_key >= best_hb_key:
                    best_hb_key = hb_key
                    best_hb_id = eid
    raw_evs.sort(key=lambda x: float(x.get("ts") or 0.0))
    merged_ev = [
        ev for ev in raw_evs
        if not (ev.get("type") == "sync" and ev.get("action") == "heartbeat" and ev.get("id") != best_hb_id)
    ]
    seen_sig = set()
    merged_sig = []
    for sg in (room.get("signals") or []) + (snap.get("signals") or []):
        sid = sg.get("id")
        if sid and sid not in seen_sig and t - float(sg.get("ts") or 0) < 35.0:
            seen_sig.add(sid)
            merged_sig.append(sg)
    s_rev, r_rev = int(snap.get("rev") or 0), int(room.get("rev") or 0)
    s_ct, r_ct = float(snap.get("createdAt") or now()), float(room.get("createdAt") or now())
    s_media = snap.get("media") if isinstance(snap.get("media"), dict) else {}
    r_media = room.get("media") if isinstance(room.get("media"), dict) else {}
    s_has_media = bool(s_media.get("url") or s_media.get("videoId"))
    r_has_media = bool(r_media.get("url") or r_media.get("videoId"))
    s_m_time = float(s_media.get("updatedAt") or 0)
    r_m_time = float(r_media.get("updatedAt") or 0)
    s_pos = float(s_media.get("currentTime") or 0)
    r_pos = float(r_media.get("currentTime") or 0)
    if s_rev > r_rev or (s_rev == r_rev and s_ct < r_ct - 0.05):
        for k in ("name", "privacy", "playMode", "voipMode", "queue", "skip_votes", "voteEndsAt", "endedKey", "curated", "host_transferred"):
            if k in snap:
                room[k] = snap[k]
    if not room.get("passwordHash") and snap.get("pwEnc") and s_rev >= r_rev:
        dec_pw = _decrypt_pw_hash(str(snap.get("pwEnc") or ""), room_id)
        if dec_pw:
            room["passwordHash"] = dec_pw
    prefer_snap_creator = (s_ct < r_ct - 0.05) or (s_has_media and not r_has_media)
    if (not room.get("creatorId") or prefer_snap_creator) and snap.get("creatorId"):
        room["creatorId"] = snap["creatorId"]
    if (not room.get("creatorCid") or prefer_snap_creator) and snap.get("creatorCid"):
        room["creatorCid"] = snap["creatorCid"]
    if (not room.get("explicitCreatorCid") or prefer_snap_creator) and snap.get("explicitCreatorCid"):
        room["explicitCreatorCid"] = snap["explicitCreatorCid"]
    if (not room.get("creator") or prefer_snap_creator) and snap.get("creator"):
        room["creator"] = snap["creator"]
    merged_co = list(dict.fromkeys(list(room.get("co_hosts") or []) + (list(snap.get("co_hosts") or []) if s_rev >= r_rev else [])))
    c_cid_val = str(room.get("creatorCid") or "").strip()
    if c_cid_val and c_cid_val in merged_p and not room.get("host_transferred") and c_cid_val not in merged_co:
        merged_co.append(c_cid_val)
    if c_cid_val and c_cid_val in merged_p:
        for pcid, pp in merged_p.items():
            if isinstance(pp, dict) and pcid != c_cid_val:
                pp["isCreator"] = False
    room["co_hosts"] = [c for c in merged_co if c not in kicked and c not in left_map]
    cur_h_id = room.get("host_id")
    cur_h = merged_p.get(cur_h_id or "")
    cur_h_alive = bool(cur_h and cur_h.get("transport") != "bot" and (t - float(cur_h.get("lastSeen") or 0) <= HTTP_PARTICIPANT_TTL))
    snap_h_id = snap.get("host_id")
    if snap_h_id and snap_h_id in merged_p and snap_h_id not in kicked and snap_h_id not in left_map:
        if not cur_h_alive or (snap.get("host_transferred") and s_rev > r_rev):
            room["host_id"] = snap_h_id
    same_m_key = bool(s_has_media and r_has_media and media_key(s_media) == media_key(r_media))
    s_unresolved = str(s_media.get("url") or "").startswith("/api/rave/resolve-catalog")
    r_unresolved = str(r_media.get("url") or "").startswith("/api/rave/resolve-catalog")
    r_live_pos = r_pos + (max(0.0, t - r_m_time) * float(r_media.get("rate") or 1.0) if (r_media.get("playing") and r_m_time > 0.0 and (not r_unresolved or r_media.get("playbackAnchored") or r_media.get("_playbackAnchored") or r_pos > 0.5)) else 0.0)
    s_live_pos = s_pos + (max(0.0, t - s_m_time) * float(s_media.get("rate") or 1.0) if (s_media.get("playing") and s_m_time > 0.0 and (not s_unresolved or s_media.get("playbackAnchored") or s_media.get("_playbackAnchored") or s_pos > 0.5)) else 0.0)
    stale_snap_regression = bool(
        same_m_key
        and cur_h_alive
        and r_live_pos > 15.0
        and s_live_pos < r_live_pos - 8.0
        and s_m_time < t - 3.0
    )
    pause_protected = bool(
        same_m_key
        and not r_media.get("playing", True)
        and s_media.get("playing")
        and (t - float(r_media.get("lastExplicitPauseAt") or 0.0) < 15.0)
        and s_m_time <= float(r_media.get("lastExplicitPauseAt") or 0.0) + 2.0
    )
    if (s_has_media and not r_has_media) or (s_has_media and not pause_protected and not stale_snap_regression and s_m_time > r_m_time + 0.01 and not (r_live_pos > 25.0 and s_live_pos < 10.0 and same_m_key)):
        if same_m_key and s_unresolved and not r_unresolved:
            merged_m = dict(s_media)
            for k in ("provider", "catalogProvider", "streamType", "url", "altUrls", "servers", "subtitleTracks", "audioTracks", "intro", "duration", "mediaType", "season", "episode", "episodeCount", "totalSeasons", "seasonsMeta", "tmdbId", "imdbId", "seriesTitle", "originalTitle", "videoId", "clipVideoId", "embedUrl", "mvUrl", "audioPreviewUrl", "poster", "thumbnail", "artist", "songTitle", "musicMode", "musicPlatformLabel", "similar"):
                if r_media.get(k):
                    merged_m[k] = r_media[k]
            room["media"] = merged_m
        else:
            room["media"] = s_media
    elif same_m_key and r_unresolved and not s_unresolved:
        for k in ("provider", "catalogProvider", "streamType", "url", "altUrls", "servers", "subtitleTracks", "audioTracks", "intro", "duration", "mediaType", "season", "episode", "episodeCount", "totalSeasons", "seasonsMeta", "tmdbId", "imdbId", "seriesTitle", "originalTitle", "videoId", "clipVideoId", "embedUrl", "mvUrl", "audioPreviewUrl", "poster", "thumbnail", "artist", "songTitle", "musicMode", "musicPlatformLabel", "similar"):
            if s_media.get(k):
                room["media"][k] = s_media[k]
        if s_m_time > r_m_time:
            room["media"]["updatedAt"] = s_m_time
            room["media"]["currentTime"] = s_pos
    if snap.get("polls") and not room.get("polls"):
        room["polls"] = snap["polls"]
    elif snap.get("polls") and room.get("polls"):
        by_id = {p.get("id"): p for p in (room.get("polls") or []) if isinstance(p, dict) and p.get("id")}
        for sp in (snap.get("polls") or []):
            if isinstance(sp, dict) and sp.get("id"):
                pid = sp["id"]
                sp_rev = int(sp.get("rev") or 0)
                cur_p_rev = int(by_id[pid].get("rev") or 0) if pid in by_id else -1
                if pid not in by_id or sp_rev > cur_p_rev or (
                    sp_rev == cur_p_rev
                    and sum(len(o.get("votes") or []) for o in sp.get("options") or []) >= sum(len(o.get("votes") or []) for o in by_id[pid].get("options") or [])
                ):
                    by_id[pid] = sp
        room["polls"] = list(by_id.values())[-10:]
    prev_c_len = len(room.get("chat") or [])
    room["rev"] = max(s_rev, r_rev, int(room.get("rev") or 1)) + (1 if len(merged_c) > prev_c_len else 0)
    room["createdAt"] = min(s_ct, r_ct)
    room["kicked"] = list(kicked)[-50:]
    room["left"] = left_map
    room["participants"] = merged_p
    _dedupe_room_participants(room)
    room["chat"] = merged_c[-MAX_CHAT:]
    prune_chat(room)
    room["events"] = merged_ev[-35:]
    room["signals"] = merged_sig[-240:]
    return room


def _effective_room_name(room: Dict[str, Any]) -> str:
    if room.get("curated"):
        return str(room.get("name") or "7/24 Canlı")
    m = room.get("media") or {}
    m_title = clean_str(m.get("title"), 80)
    if m_title and m_title.lower() not in ("içerik seçilmedi", "medya seçilmedi", "hazır", "video", "oda", "boş oda"):
        return m_title
    return str(room.get("name") or "Watchlivo Odası")


def set_media(room: Dict[str, Any], media: Dict[str, Any], by: str, start: float = 0.0) -> None:
    m = clean_media(media)
    m.update({"playing": True, "currentTime": max(0.0, float(start or 0)), "rate": 1.0, "updatedAt": now(), "lastActionBy": by})
    room["media"] = m
    if not room.get("curated"):
        m_title = clean_str(m.get("title"), 80)
        if m_title and m_title.lower() not in ("içerik seçilmedi", "medya seçilmedi", "hazır", "video", "oda", "boş oda"):
            room["name"] = m_title
    room["skip_votes"] = []
    room["voteEndsAt"] = 0.0
    room["endedKey"] = ""


def sys_msg(room: Dict[str, Any], text: str, user: str = "") -> Dict[str, Any]:
    prune_chat(room)
    t_now = now()
    chat = list(room.get("chat") or [])
    is_presence = any(k in text for k in ("katıldı", "ayrıldı"))
    is_media = any(k in text for k in ("oynatılıyor", "başlatıldı"))
    if user and is_presence:
        for prev in reversed(chat[-6:]):
            if prev.get("system") and prev.get("user") == user and prev.get("text") == text and (t_now - float(prev.get("ts") or 0.0) < 4.0):
                return prev
        chat = [
            m for m in chat
            if not (m.get("system") and m.get("user") == user and any(k in str(m.get("text") or "") for k in ("katıldı", "ayrıldı")) and (t_now - float(m.get("ts") or 0.0) < 10.0))
        ]
    elif is_media:
        chat = [
            m for m in chat
            if not (m.get("system") and any(k in str(m.get("text") or "") for k in ("oynatılıyor", "başlatıldı")))
        ]
    msg = {"id": uuid.uuid4().hex[:10], "system": True, "user": user, "text": text, "time": now_hhmm(t_now), "ts": t_now}
    room["chat"] = (chat + [msg])[-MAX_CHAT:]
    prune_chat(room)
    ev = {"id": uuid.uuid4().hex[:10], "ts": t_now, "type": "chat", "message": msg, "cid": ""}
    room["events"] = (room.get("events") or [])[-34:] + [ev]
    return msg


def serialize(room: Dict[str, Any], for_cid: Optional[str] = None) -> Dict[str, Any]:
    t = now()
    prune_chat(room)
    _dedupe_room_participants(room)
    p_map = room.get("participants") or {}
    has_humans = any(p.get("transport") != "bot" for p in p_map.values())
    m = dict(_media_defaults(room))
    if not has_humans and room.get("curated"):
        room["media"]["currentTime"] = 0.0
        room["media"]["updatedAt"] = t
        m["currentTime"] = 0.0
        m["updatedAt"] = t
    is_unresolved_catalog = (
        str(m.get("url") or "").startswith("/api/rave/resolve-catalog")
        and float(m.get("currentTime") or 0.0) <= 0.5
        and not bool(room.get("media", {}).get("playbackAnchored") or room.get("media", {}).get("_playbackAnchored"))
    )
    if is_unresolved_catalog:
        m["updatedAt"] = t
    elapsed_wall = 0.0 if is_unresolved_catalog else max(0.0, t - float(m.get("updatedAt") or t))
    elapsed = elapsed_wall * m["rate"] if (m["playing"] and has_humans and not is_unresolved_catalog) else 0.0
    raw_live = max(0.0, m["currentTime"] + elapsed)
    dur = float(m.get("duration") or 0.0)
    if room.get("curated") and dur > 300.0 and raw_live >= dur - 60.0:
        room["media"]["currentTime"] = 0.0
        room["media"]["updatedAt"] = t
        m["currentTime"] = 0.0
        m["updatedAt"] = t
        raw_live = 0.0
        elapsed_wall = 0.0
    m["liveTime"] = raw_live
    m["elapsedSinceUpdate"] = round(elapsed_wall, 3)
    m["meshStateStatus"] = "PLAYING" if m["playing"] else "PAUSED"
    m["meshStatePosition"] = float(m["currentTime"])
    m["meshStateTime"] = float(m["updatedAt"])
    m["meshStatePlaybackSpeed"] = float(m["rate"])
    m["serverNow"] = t
    p_map = room.get("participants") or {}
    co_set = set(room.get("co_hosts") or [])
    host_id = room.get("host_id")
    creator_cid = str(room.get("creatorCid") or "").strip() or (str(host_id or "") if not room.get("host_transferred") and not room.get("curated") else "")
    is_cohost_mode = room.get("playMode") == "cohost"
    raw_parts = [x for x in p_map.values() if isinstance(x, dict) and x.get("id")]
    raw_parts.sort(
        key=lambda x: (
            0 if x.get("id") == host_id else (1 if x.get("id") in co_set else (2 if not x.get("muted", True) or x.get("cam") or x.get("screen") else 3)),
            -float(x.get("lastSeen") or 0.0),
        )
    )
    dedup_parts = list(raw_parts)
    live_humans = sum(1 for p in dedup_parts if p.get("transport") != "bot")
    snap_tot = int(room.get("totalParticipants") or 0) if live_humans >= 20 else 0
    total_p = max(live_humans, snap_tot)
    is_large_room = total_p >= 25
    ser_parts = []
    for p in dedup_parts:
        if p.get("transport") == "bot":
            continue
        if len(ser_parts) >= 60:
            break
        pid_cur = p.get("id", "")
        cp = {k: v for k, v in p.items() if not str(k).startswith("_") and k != "lastSeen"}
        if pid_cur != for_cid and str(cp.get("uid") or "").startswith("guest_"):
            cp.pop("uid", None)
        p_is_creator = _is_creator_of_room(room, pid_cur, p)
        cp["isCreator"] = p_is_creator
        cp["isHost"] = pid_cur == host_id
        cp["isCoHost"] = ((pid_cur in co_set) and (pid_cur != creator_cid or pid_cur == host_id or p_is_creator)) or is_cohost_mode
        cp["isStageSpeaker"] = bool(pid_cur == host_id or cp["isCoHost"] or pid_cur in (room.get("stage_speakers") or []))
        ser_parts.append(cp)
    if for_cid and for_cid in p_map and not any(x.get("id") == for_cid for x in ser_parts):
        me_p = p_map[for_cid]
        cp_me = {k: v for k, v in me_p.items() if not str(k).startswith("_") and k != "lastSeen"}
        me_is_creator = _is_creator_of_room(room, for_cid, me_p)
        cp_me["isCreator"] = me_is_creator
        cp_me["isHost"] = for_cid == host_id
        cp_me["isCoHost"] = ((for_cid in co_set) and (for_cid != creator_cid or for_cid == host_id or me_is_creator)) or is_cohost_mode
        ser_parts = ser_parts[:59] + [cp_me]
    recent_events = [e for e in (room.get("events") or []) if t - float(e.get("ts") or 0) < 25.0][-30:]
    if for_cid:
        recent_signals = [s for s in (room.get("signals") or []) if s.get("targetId") == for_cid and t - float(s.get("ts") or 0) < 35.0][-60:]
    else:
        recent_signals = []
    return {
        "id": room["id"], "name": _effective_room_name(room), "rawName": room.get("name", ""), "privacy": room["privacy"], "playMode": room["playMode"],
        "voipMode": room["voipMode"], "isMature": bool(room.get("isMature")), "hasPassword": has_password(room), "creator": room["creator"],
        "creatorCid": creator_cid, "host_id": host_id, "co_hosts": list(co_set), "stage_speakers": list(room.get("stage_speakers") or []),
        "curated": bool(room.get("curated")), "polls": (room.get("polls") or [])[-10:],
        "chatClearedAt": float(room.get("chatClearedAt") or 0.0),
        "voteEndsAt": room["voteEndsAt"], "media": m, "queue": room["queue"],
        "skip_votes": room["skip_votes"], "participants": ser_parts,
        "participantCount": total_p, "count": total_p, "largeRoomMode": is_large_room,
        "chat": room["chat"][-80:], "events": recent_events, "signals": recent_signals,
        "serverNow": t, "rev": int(room.get("rev") or 1), "syncToken": pack_sync_token(room),
    }


def lobby_entry(room: Dict[str, Any], mask_private: bool = False) -> Dict[str, Any]:
    t = now()
    _dedupe_room_participants(room)
    p_map = room.get("participants") or {}
    has_humans = any(p.get("transport") != "bot" for p in p_map.values())
    raw_m = _media_defaults(room)
    is_unresolved_cat = (
        str(raw_m.get("url") or "").startswith("/api/rave/resolve-catalog")
        and float(raw_m.get("currentTime") or 0.0) <= 0.5
        and not bool((room.get("media") or {}).get("playbackAnchored") or (room.get("media") or {}).get("_playbackAnchored"))
    )
    playing = bool(raw_m.get("playing")) and has_humans and not is_unresolved_cat
    rate = float(raw_m.get("rate") or 1.0)
    updated_at = t if is_unresolved_cat else float(raw_m.get("updatedAt") or t)
    cur_time = 0.0 if (not has_humans and room.get("curated")) else float(raw_m.get("currentTime") or 0.0)
    raw_live = max(0.0, cur_time + ((t - updated_at) * rate if playing else 0.0))
    pw_locked = has_password(room)
    hidden = pw_locked or mask_private
    locked_label = "🔒 Şifreli Oda" if pw_locked else "🔒 Özel Oda"
    m_summary = dict(raw_m)
    m_summary["currentTime"] = 0.0 if hidden else cur_time
    m_summary["updatedAt"] = t if hidden else updated_at
    m_summary["liveTime"] = 0.0 if hidden else round(raw_live, 2)
    m_summary["meshStateStatus"] = "PAUSED" if hidden else ("PLAYING" if (bool(raw_m.get("playing")) and has_humans) else "PAUSED")
    m_summary["meshStatePosition"] = 0.0 if hidden else float(cur_time)
    m_summary["meshStateTime"] = float(t if hidden else updated_at)
    m_summary["meshStatePlaybackSpeed"] = 1.0 if hidden else float(rate)
    m_summary["serverNow"] = t
    if hidden:
        m_summary.update({"url": "", "altUrls": [], "servers": [], "subtitleTracks": [], "audioTracks": [], "videoId": "", "clipVideoId": "", "embedUrl": "", "mvUrl": "", "bgVideoUrl": "", "audioPreviewUrl": "", "tmdbId": "", "imdbId": "", "seriesTitle": "", "originalTitle": "", "title": locked_label, "thumbnail": "/static/watchlivo-poster.svg", "poster": "/static/watchlivo-poster.svg"})
    host_id = room.get("host_id")
    co_set = set(room.get("co_hosts") or [])
    is_cohost_mode = room.get("playMode") == "cohost"
    human_cnt = sum(1 for p in p_map.values() if p.get("transport") != "bot")
    parts_preview = []
    creator_hide_watching = False
    c_uid_lob = str(room.get("creatorId") or "").strip()
    if c_uid_lob.startswith("u_wl_"):
        try:
            import social_engine as _se_lob
            su_c = _se_lob._SOCIAL_USERS.get(c_uid_lob)
            if isinstance(su_c, dict) and bool(su_c.get("hideWatching")):
                creator_hide_watching = True
        except Exception:
            pass
    if not hidden:
        for p in [x for x in p_map.values() if isinstance(x, dict) and x.get("transport") != "bot"][:5]:
            p_uid = str(p.get("uid") or "").strip()
            p_hide_w = bool(p.get("hideWatching"))
            if not p_hide_w and p_uid.startswith("u_wl_"):
                try:
                    import social_engine as _se_lob
                    su_p = _se_lob._SOCIAL_USERS.get(p_uid)
                    if isinstance(su_p, dict) and bool(su_p.get("hideWatching")):
                        p_hide_w = True
                except Exception:
                    pass
            if p_hide_w and p_uid and p_uid == c_uid_lob:
                creator_hide_watching = True
            cp = {k: v for k, v in p.items() if not str(k).startswith("_") and k != "lastSeen"}
            if p_uid.startswith("guest_") or p_hide_w:
                cp.pop("uid", None)
            if p_hide_w:
                cp.pop("handle", None)
                cp.pop("avatarUrl", None)
                cp["name"] = "Gizli İzleyici"
            cp["isHost"] = p.get("id") == host_id
            cp["isCoHost"] = (p.get("id") in co_set) or is_cohost_mode
            parts_preview.append(cp)
    return {
        "id": room["id"], "name": locked_label if hidden else _effective_room_name(room), "rawName": "" if hidden else room.get("name", ""), "privacy": room["privacy"], "playMode": room["playMode"],
        "isMature": bool(room.get("isMature")), "hasPassword": pw_locked, "creator": "" if (mask_private or creator_hide_watching) else room.get("creator", ""),
        "creatorCid": "", "host_id": "" if hidden else host_id, "co_hosts": [] if hidden else list(co_set), "rev": int(room.get("rev") or 1),
        "curated": bool(room.get("curated")), "media": m_summary,
        "count": human_cnt, "participantCount": human_cnt, "participants": parts_preview,
        "syncToken": "",
    }


# ---------------------------------------------------------------------------
# Storage: in-memory (single process) or Upstash Redis REST (shared across serverless instances).
# ---------------------------------------------------------------------------
class MemoryStore:
    def __init__(self) -> None:
        self.rooms: Dict[str, Dict[str, Any]] = {}
        self.locks: Dict[str, asyncio.Lock] = {}
        self.shared = False
        import tempfile, pathlib
        self.tmp_dir = pathlib.Path(tempfile.gettempdir()) / "vortex_rooms"
        try:
            self.tmp_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            self.tmp_dir = None

    def lock(self, room_id: str, remote: bool = False):
        if room_id not in self.locks and len(self.locks) > 4096:
            for k, lk in list(self.locks.items())[:1024]:
                if not lk.locked() and k not in self.rooms:
                    self.locks.pop(k, None)
        return self.locks.setdefault(room_id, asyncio.Lock())

    async def get(self, room_id: str, force_fresh: bool = False) -> Optional[Dict[str, Any]]:
        if room_id in _CLOSED_ROOMS and not any(s["id"] == room_id for s in CURATED_LIVE_SPECS):
            return None
        r = self.rooms.get(room_id)
        if r is not None:
            return r
        if self.tmp_dir:
            try:
                fp = self.tmp_dir / f"{room_id}.json"
                if fp.exists():
                    r = json.loads(fp.read_text(encoding="utf-8"))
                    self.rooms[room_id] = r
            except Exception:
                pass
        return r

    async def put(self, room: Dict[str, Any], force_disk: bool = False) -> None:
        _CLOSED_ROOMS.pop(room["id"], None)
        self.rooms[room["id"]] = room
        t = now()
        if self.tmp_dir and (force_disk or t - float(room.get("_lastDiskAt") or 0.0) >= 3.0):
            room["_lastDiskAt"] = t
            try:
                fp = self.tmp_dir / f"{room['id']}.json"
                clean_r = {k: v for k, v in room.items() if not k.startswith("_")}
                fp.write_text(json.dumps(clean_r, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

    async def delete(self, room_id: str, mark_closed: bool = True) -> None:
        if mark_closed:
            _CLOSED_ROOMS[room_id] = now()
        self.rooms.pop(room_id, None)
        if self.tmp_dir:
            try:
                (self.tmp_dir / f"{room_id}.json").unlink(missing_ok=True)
            except Exception:
                pass

    async def all(self) -> List[Dict[str, Any]]:
        if self.tmp_dir:
            for fp in self.tmp_dir.glob("*.json"):
                rid = fp.stem
                if rid not in self.rooms:
                    try:
                        content = fp.read_text(encoding="utf-8")
                        if content.strip():
                            self.rooms[rid] = json.loads(content)
                    except Exception:
                        continue
        return list(self.rooms.values())


class _RedisLock:
    _UNLOCK_LUA = 'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end'

    def __init__(self, store: "RedisStore", room_id: str, remote: bool = True) -> None:
        self.store, self.room_id, self.remote = store, room_id, remote
        self.key, self.token = f"vortex:lock:{room_id}", uuid.uuid4().hex
        self.local_lock = store._local_lock(room_id)
        self.acquired_remote = False

    async def __aenter__(self):
        await self.local_lock.acquire()
        if self.remote:
            for _ in range(45):
                res = await self.store.cmd("SET", self.key, self.token, "NX", "PX", "4000")
                if res == "OK":
                    self.acquired_remote = True
                    break
                await asyncio.sleep(0.035)
        return self

    async def __aexit__(self, *exc):
        try:
            if self.acquired_remote:
                await self.store.cmd("EVAL", self._UNLOCK_LUA, "1", self.key, self.token)
        finally:
            if self.local_lock.locked():
                self.local_lock.release()


class RedisStore:
    """Hybrid L1 (in-memory micro-cache) + L2 (pipelined Upstash Redis REST + disk fallback) store for 10k-100k concurrent users."""

    def __init__(self, url: str, token: str) -> None:
        self.url, self.token, self.shared = url.rstrip("/"), token, True
        self.l1_rooms: Dict[str, Dict[str, Any]] = {}
        self.l1_read_ts: Dict[str, float] = {}
        self.l1_write_ts: Dict[str, float] = {}
        self.locks: Dict[str, asyncio.Lock] = {}
        self.fallback = MemoryStore()

    def _local_lock(self, room_id: str) -> asyncio.Lock:
        if room_id not in self.locks:
            if len(self.locks) > 4096:
                for k, lk in list(self.locks.items())[:1024]:
                    if not lk.locked() and k not in self.l1_rooms:
                        self.locks.pop(k, None)
            self.locks[room_id] = asyncio.Lock()
        return self.locks[room_id]

    def _call(self, args: List[str]) -> Any:
        req = urllib.request.Request(self.url, data=json.dumps(args).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3.5) as r:
            return json.loads(r.read().decode()).get("result")

    def _pipeline_call(self, commands: List[List[str]]) -> Any:
        req = urllib.request.Request(f"{self.url}/pipeline", data=json.dumps(commands).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=4.0) as r:
            return json.loads(r.read().decode())

    async def cmd(self, *args: str) -> Any:
        try:
            return await asyncio.to_thread(self._call, [str(a) for a in args])
        except Exception:
            return None

    async def pipeline(self, commands: List[List[str]]) -> Any:
        try:
            return await asyncio.to_thread(self._pipeline_call, [[str(x) for x in c] for c in commands])
        except Exception:
            return None

    def lock(self, room_id: str, remote: bool = True):
        return _RedisLock(self, room_id, remote=remote)

    async def get(self, room_id: str, force_fresh: bool = False) -> Optional[Dict[str, Any]]:
        t = now()
        is_curated_spec = any(s["id"] == room_id for s in CURATED_LIVE_SPECS)
        if room_id in _CLOSED_ROOMS and not is_curated_spec:
            self.l1_rooms.pop(room_id, None)
            return None
        cached = self.l1_rooms.get(room_id)
        cached_has_media = bool(cached and isinstance(cached.get("media"), dict) and (cached["media"].get("url") or cached["media"].get("videoId")))
        if not force_fresh and cached and cached_has_media and (t - self.l1_read_ts.get(room_id, 0.0) < 0.2):
            return cached
        mget_res = await self.cmd("MGET", f"vortex:room:{room_id}", f"vortex:closed:{room_id}")
        raw = mget_res[0] if isinstance(mget_res, list) and len(mget_res) >= 1 else None
        is_closed = bool(mget_res[1]) if isinstance(mget_res, list) and len(mget_res) >= 2 else False
        if is_closed and not is_curated_spec:
            _CLOSED_ROOMS[room_id] = t
            self.l1_rooms.pop(room_id, None)
            await self.fallback.delete(room_id)
            return None
        if raw:
            try:
                room = json.loads(raw)
                r_has_media = bool(isinstance(room.get("media"), dict) and (room["media"].get("url") or room["media"].get("videoId")))
                c_rev = int((cached or {}).get("rev") or 0)
                r_rev = int(room.get("rev") or 0)
                cleared_c_at = max(
                    float(room.get("chatClearedAt") or 0.0),
                    float((cached or {}).get("chatClearedAt") or 0.0),
                )
                if cleared_c_at > 0.0:
                    room["chatClearedAt"] = cleared_c_at
                allow_l1_merge = cached_has_media and (
                    (not force_fresh and (t - self.l1_write_ts.get(room_id, 0.0) < 30.0))
                    or (c_rev > r_rev and (t - self.l1_write_ts.get(room_id, 0.0) < 5.0))
                )
                if allow_l1_merge:
                    c_m = cached.get("media") or {}
                    r_m = room.get("media") or {}
                    c_upd = float(c_m.get("updatedAt") or 0.0)
                    r_upd = float(r_m.get("updatedAt") or 0.0)
                    if (not r_has_media and not room.get("_explicit_media_clear")) or (c_rev >= r_rev and c_upd > r_upd + 0.01):
                        room["media"] = c_m
                        room["rev"] = max(r_rev, c_rev, 1)
                    if cached.get("events"):
                        ev_by_id = {}
                        for ev_item in (room.get("events") or []) + (cached.get("events") or []):
                            if isinstance(ev_item, dict) and ev_item.get("id") and (t - float(ev_item.get("ts") or 0.0) < 25.0):
                                ev_by_id[ev_item["id"]] = ev_item
                        if ev_by_id:
                            room["events"] = sorted(ev_by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-35:]
                if cached and cached.get("chat") and not room.get("_explicit_chat_clear") and not force_fresh and (t - self.l1_write_ts.get(room_id, 0.0) < 15.0):
                    by_id = {}
                    for cm in (cached.get("chat") or []) + (room.get("chat") or []):
                        if isinstance(cm, dict) and cm.get("id") and (cleared_c_at <= 0.0 or float(cm.get("ts") or 0.0) > cleared_c_at):
                            by_id[cm["id"]] = cm
                    if len(by_id) > len(room.get("chat") or []):
                        room["chat"] = sorted(by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-MAX_CHAT:]
                        prune_chat(room)
                if cached and cached.get("signals") and not force_fresh and (t - self.l1_write_ts.get(room_id, 0.0) < 10.0):
                    sig_by_id = {}
                    for sg_it in (room.get("signals") or []) + (cached.get("signals") or []):
                        if isinstance(sg_it, dict) and sg_it.get("id") and (t - float(sg_it.get("ts") or 0.0) < 25.0):
                            sig_by_id[sg_it["id"]] = sg_it
                    if sig_by_id:
                        room["signals"] = sorted(sig_by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-120:]
                self.l1_rooms[room_id] = room
                self.l1_read_ts[room_id] = t
                return room
            except Exception:
                pass
        return cached or await self.fallback.get(room_id)

    async def put(self, room: Dict[str, Any], force_disk: bool = False) -> None:
        rid = room["id"]
        _CLOSED_ROOMS.pop(rid, None)
        t = now()
        prev_cached = self.l1_rooms.get(rid)
        if room.get("_explicit_chat_clear"):
            room["chatClearedAt"] = max(t, float(room.get("chatClearedAt") or 0.0))
        if prev_cached and isinstance(prev_cached.get("media"), dict) and (prev_cached["media"].get("url") or prev_cached["media"].get("videoId")):
            cur_m = room.get("media") or {}
            if not cur_m.get("url") and not cur_m.get("videoId") and not room.get("_explicit_media_clear"):
                room["media"] = prev_cached["media"]
        if prev_cached and prev_cached.get("chat") and not room.get("_explicit_chat_clear"):
            cleared_c_at = max(float(room.get("chatClearedAt") or 0.0), float(prev_cached.get("chatClearedAt") or 0.0))
            if cleared_c_at > 0.0:
                room["chatClearedAt"] = cleared_c_at
            by_id = {}
            for cm in (prev_cached.get("chat") or []) + (room.get("chat") or []):
                if isinstance(cm, dict) and cm.get("id") and (cleared_c_at <= 0.0 or float(cm.get("ts") or 0.0) > cleared_c_at):
                    by_id[cm["id"]] = cm
            room["chat"] = sorted(by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-MAX_CHAT:]
            prune_chat(room)
        room.pop("_explicit_chat_clear", None)
        room.pop("_explicit_media_clear", None)
        self.l1_rooms[rid] = room
        self.l1_read_ts[rid] = t
        await self.fallback.put(room, force_disk=force_disk)
        is_serverless = os.environ.get("VERCEL") == "1"
        if not force_disk and not is_serverless and (t - self.l1_write_ts.get(rid, 0.0) < 0.25):
            return
        self.l1_write_ts[rid] = t
        clean_r = {k: v for k, v in room.items() if not k.startswith("_")}
        payload = json.dumps(clean_r, separators=(",", ":"), ensure_ascii=False)
        await self.pipeline([
            ["SET", f"vortex:room:{rid}", payload, "EX", "86400"],
            ["SADD", "vortex:rooms", rid],
            ["DEL", f"vortex:closed:{rid}"],
        ])

    async def delete(self, room_id: str, mark_closed: bool = True) -> None:
        if mark_closed:
            _CLOSED_ROOMS[room_id] = now()
        self.l1_rooms.pop(room_id, None)
        self.l1_read_ts.pop(room_id, None)
        self.l1_write_ts.pop(room_id, None)
        await self.fallback.delete(room_id, mark_closed=mark_closed)
        cmds = [
            ["DEL", f"vortex:room:{room_id}"],
            ["SREM", "vortex:rooms", room_id],
        ]
        if mark_closed:
            cmds.append(["SET", f"vortex:closed:{room_id}", "1", "EX", "7200"])
        await self.pipeline(cmds)

    async def all(self) -> List[Dict[str, Any]]:
        ids = await self.cmd("SMEMBERS", "vortex:rooms") or []
        if not ids:
            return await self.fallback.all()
        raws = await self.cmd("MGET", *[f"vortex:room:{i}" for i in ids]) or []
        out = []
        dead_ids = []
        for rid, raw in zip(ids, raws):
            if raw:
                try:
                    room = json.loads(raw)
                    self.l1_rooms[rid] = room
                    self.l1_read_ts[rid] = now()
                    out.append(room)
                except Exception:
                    pass
            else:
                dead_ids.append(rid)
        if dead_ids:
            await self.cmd("SREM", "vortex:rooms", *dead_ids)
        return out or await self.fallback.all()


def make_store():
    url = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN")
    if url and token:
        return RedisStore(url, token)
    return MemoryStore()


STORE = make_store()
SOCKETS: Dict[str, Dict[str, Any]] = {}  # room_id -> {cid: WebSocket} (per process)


def _freeze_empty_room_playback(room: Dict[str, Any], t_now: float) -> None:
    room["emptySince"] = float(room.get("emptySince") or t_now)
    if room.get("curated"):
        return
    m = room.get("media")
    if not isinstance(m, dict) or (not m.get("url") and not m.get("videoId")):
        return
    is_unres = (
        str(m.get("url") or "").startswith("/api/rave/resolve-catalog")
        and float(m.get("currentTime") or 0.0) <= 0.5
        and not bool(m.get("playbackAnchored") or m.get("_playbackAnchored"))
    )
    if m.get("playing") and not is_unres:
        elapsed = max(0.0, t_now - float(m.get("updatedAt") or t_now)) * float(m.get("rate") or 1.0)
        m["currentTime"] = round(max(0.0, float(m.get("currentTime") or 0.0) + elapsed), 3)
        m["playing"] = False
        m["_frozenByEmpty"] = True
        m["updatedAt"] = t_now
        m["playbackAnchored"] = True
        room["_tok_sig"] = ""


def prune(room: Dict[str, Any], force: bool = False) -> List[Dict[str, Any]]:
    """Drop HTTP participants that stopped polling; returns removed participants."""
    t = now()
    if not force and t - float(room.get("_lastPruneAt") or 0.0) < 2.0:
        return []
    room["_lastPruneAt"] = t
    live_ws = SOCKETS.get(room["id"], {})
    gone = []
    left_map = room.setdefault("left", {})
    for cid, p in list(room["participants"].items()):
        if p.get("transport") == "bot":
            continue
        if p.get("transport") == "http" and t - p.get("lastSeen", 0) > HTTP_PARTICIPANT_TTL:
            gone.append(room["participants"].pop(cid))
        elif p.get("transport") == "ws" and cid not in live_ws and (t - p.get("lastSeen", 0) > HTTP_PARTICIPANT_TTL):
            gone.append(room["participants"].pop(cid))
            left_map[cid] = t
    room["left"] = {k: v for k, v in left_map.items() if t - float(v or 0) < HTTP_PARTICIPANT_TTL + 60.0}
    if len(room["left"]) > 100:
        room["left"] = dict(sorted(room["left"].items(), key=lambda kv: float(kv[1] or 0.0))[-100:])
    room["events"] = [e for e in (room.get("events") or []) if t - float(e.get("ts") or 0) < 25.0][-35:]
    room["signals"] = [s for s in (room.get("signals") or []) if t - float(s.get("ts") or 0) < 35.0][-240:]
    for gp in gone:
        if isinstance(gp, dict) and gp.get("transport") != "bot":
            gp_name = gp.get("name", "Misafir")
            still_here = any(
                hp.get("transport") != "bot" and hp.get("name") == gp_name
                for hp in room["participants"].values()
            )
            if not still_here:
                sys_msg(room, "odadan ayrıldı", gp_name)
    prune_chat(room)
    has_humans = any(p.get("transport") != "bot" for p in room["participants"].values())
    if not has_humans:
        _freeze_empty_room_playback(room, t)
        if room.get("curated") or (t - float(room.get("emptySince") or t) > 3600.0):
            room["_explicit_chat_clear"] = True
            room["chat"] = []
            room["polls"] = []
            if isinstance(room.get("media"), dict):
                room["media"]["currentTime"] = 0.0
                room["media"]["updatedAt"] = t
    else:
        room.pop("emptySince", None)
    if gone:
        ensure_host(room)
    return gone


def _slugify_name(name: str) -> str:
    return re.sub(r"[^a-z0-9\-]", "", (name or "").lower().replace(" ", "-").replace("ı", "i").replace("ş", "s").replace("ğ", "g").replace("ü", "u").replace("ö", "o").replace("ç", "c")).strip("-")


def _is_creator_of_room(room: Dict[str, Any], cid: str, p: Optional[Dict[str, Any]] = None, data: Optional[Dict[str, Any]] = None) -> bool:
    if not room or room.get("curated"):
        return False
    p = p or {}
    data = data or {}
    if data.get("_internalCreator"):
        return True
    t_now = now()
    rid_str = str(room.get("id") or "")
    live_ws = SOCKETS.get(rid_str, {})
    p_map = room.get("participants") or {}
    creator_cid = str(room.get("creatorCid") or "").strip()
    alive_ttl = 10.0 if (cid and cid not in p_map) else HTTP_PARTICIPANT_TTL
    if creator_cid:
        if cid and cid == creator_cid:
            return True
        creator_p = p_map.get(creator_cid)
        creator_cid_alive = bool(
            creator_p
            and creator_p.get("transport") != "bot"
            and (creator_cid in live_ws or (t_now - float(creator_p.get("lastSeen") or 0.0) <= alive_ttl))
        )
        if creator_cid_alive:
            return False
    creator_id = str(room.get("creatorId") or "").strip()
    uid = str(p.get("uid") or data.get("uid") or data.get("userId") or "").strip()
    if cid and creator_id and cid == creator_id:
        return True
    if uid and creator_id and uid == creator_id and not creator_id.startswith("guest_") and (not creator_cid or not creator_cid_alive):
        return True
    if uid and creator_id and uid != creator_id and (creator_id.startswith(("u_", "uid_")) or uid.startswith(("u_", "uid_"))):
        return False
    cur_host_id = str(room.get("host_id") or "").strip()
    if not creator_id and not creator_cid and cur_host_id and not room.get("host_transferred"):
        if cid and cid == cur_host_id:
            return True
        cur_host_p = p_map.get(cur_host_id)
        cur_host_alive = bool(
            cur_host_p
            and cur_host_p.get("transport") != "bot"
            and (cur_host_id in live_ws or (t_now - float(cur_host_p.get("lastSeen") or 0.0) <= alive_ttl))
        )
        if cur_host_alive:
            return False
    if not room.get("fromCreateApi") and not room.get("explicitCreatorCid") and not creator_id and data.get("isCreator") and not any(hp.get("transport") != "bot" and hp.get("id") != cid for hp in p_map.values()):
        return True
    return False


def ensure_host(room: Dict[str, Any]) -> None:
    if room.get("curated") and "kinox_bot" in room.get("participants", {}):
        room["host_id"] = "kinox_bot"
        return
    t_now = now()
    live_ws = SOCKETS.get(room.get("id", ""), {})
    humans = [cid for cid, p in room["participants"].items() if p.get("transport") != "bot"]
    cur_host_id = room.get("host_id")
    cur_host = room["participants"].get(cur_host_id) if cur_host_id else None
    if cur_host and (
        (cur_host.get("transport") != "bot" and (cur_host_id in live_ws or (t_now - float(cur_host.get("lastSeen") or 0.0) <= 120.0)))
        or not humans
    ):
        return
    if room.get("host_transferred") and cur_host is None and not humans:
        room["host_transferred"] = False
    creator_candidates = [
        (cid, p) for cid, p in room["participants"].items()
        if p.get("transport") != "bot"
        and (cid in live_ws or (t_now - float(p.get("lastSeen") or 0.0) <= 120.0))
        and _is_creator_of_room(room, cid, p)
    ]
    if creator_candidates and not room.get("host_transferred"):
        creator_candidates.sort(key=lambda kv: float(kv[1].get("lastSeen") or 0.0), reverse=True)
        room["host_id"] = creator_candidates[0][0]
        room["creatorCid"] = creator_candidates[0][0]
        return
    if humans:
        co_set = set(room.get("co_hosts") or [])
        humans_sorted = sorted(
            humans,
            key=lambda c: (1 if c in co_set else 0, float(room["participants"][c].get("lastSeen") or 0.0)),
            reverse=True,
        )
        room["host_id"] = humans_sorted[0]
    elif room["participants"]:
        room["host_id"] = next(iter(room["participants"]))
    else:
        room["host_id"] = None


def _safe_participant_uid(verified_uid: str, raw_uid: Any = "") -> str:
    v_clean = clean_str(verified_uid, 64)
    if v_clean:
        return v_clean
    cand = clean_str(raw_uid, 48).lower()
    if cand.startswith("guest_") and cand not in ("guest_default", "guest_local") and re.fullmatch(r"guest_[a-z0-9_-]{3,44}", cand):
        return cand
    return ""


def add_participant(room: Dict[str, Any], cid: str, data: Dict[str, Any], transport: str) -> Tuple[Dict[str, Any], bool]:
    if isinstance(room.get("left"), dict):
        room["left"].pop(cid, None)
    existing = room["participants"].get(cid)
    p = existing or {"id": cid, "muted": True, "speaking": False, "name": "Misafir", "color": "#00f5d4", "device": "Web", "country": "", "uid": ""}
    if data.get("_precreated"):
        p["_precreated"] = True
    else:
        p.pop("_precreated", None)
    raw_uname = clean_str(data.get("username"), 24)
    existing_name = str((existing or {}).get("name") or "")
    if existing and existing_name and not existing_name.lower().startswith(("misafir", "izleyici")) and raw_uname.lower().startswith(("misafir", "izleyici")):
        raw_uname = existing_name
    raw_avatar = str(data.get("avatarUrl") or "").strip()
    if raw_avatar and not (raw_avatar.startswith(("https://", "/static/", "/uploads/")) or (raw_avatar.startswith("data:image/") and len(raw_avatar) <= 45000)):
        raw_avatar = ""
    hide_loc = _as_bool(data.get("hideLocation")) if "hideLocation" in data else _as_bool(p.get("hideLocation"))
    raw_country = re.sub(r"[^A-Z]", "", clean_str(data.get("country"), 2).upper())
    fields = {
        "name": raw_uname,
        "color": clean_str(data.get("color"), 16) if re.match(r"^#[0-9a-fA-F]{3,8}$", str(data.get("color") or "")) else "",
        "device": clean_str(data.get("device"), 16),
        "country": "XX" if hide_loc else (raw_country or p.get("country") or "TR"),
        "uid": clean_str(data.get("uid") or data.get("userId"), 64),
        "handle": clean_str(data.get("handle"), 24),
        "medal": clean_str(data.get("medal"), 32),
        "bio": clean_str(data.get("bio"), 160),
        "statusText": clean_str(data.get("statusText"), 60),
        "statusEmoji": clean_str(data.get("statusEmoji"), 12),
    }
    p.update({k: v for k, v in fields.items() if v})
    if "bio" in data and not data.get("bio"):
        p["bio"] = ""
    if "statusText" in data and not data.get("statusText"):
        p["statusText"] = ""
    p["hideLocation"] = hide_loc
    if "hideWatching" in data:
        p["hideWatching"] = _as_bool(data.get("hideWatching"))
    if "hideFriends" in data:
        p["hideFriends"] = _as_bool(data.get("hideFriends"))
    if isinstance(data.get("friendsPreview"), list):
        p["friendsPreview"] = [
            {"name": clean_str(f.get("name"), 24), "handle": clean_str(f.get("handle"), 24), "color": clean_str(f.get("color"), 16)}
            for f in data["friendsPreview"][:12] if isinstance(f, dict) and f.get("name")
        ]
    if raw_avatar:
        p["avatarUrl"] = raw_avatar
    if "watchMinutes" in data:
        p["watchMinutes"] = _safe_int(data.get("watchMinutes"), 0, 0, 10_000_000)
    t_now = now()
    p.update({"transport": transport, "lastSeen": t_now})
    if p.get("uid") and transport != "bot":
        try:
            import social_engine as _se_dir
            _se_dir._register_social_dir({
                "uid": p["uid"],
                "name": p.get("name") or "İzleyici",
                "handle": p.get("handle") or "",
                "color": p.get("color") or "#27DCC8",
                "avatarUrl": p.get("avatarUrl") or "",
                "bio": p.get("bio") or "",
                "statusEmoji": p.get("statusEmoji") or "🍿",
                "statusText": p.get("statusText") or "",
            })
        except Exception:
            pass
    replaced_precreated = False
    if existing is None and not data.get("_precreated"):
        live_ws = SOCKETS.get(room.get("id", ""), {})
        p_slug = _slugify_name(p.get("name") or "")
        other_real_humans = any(
            hp.get("transport") != "bot" and not hp.get("_precreated") and hp_cid != cid
            for hp_cid, hp in (room.get("participants") or {}).items()
        )
        for old_cid, old_p in list((room.get("participants") or {}).items()):
            if old_cid == cid or old_p.get("transport") == "bot":
                continue
            if old_p.get("_precreated"):
                old_uid = str(old_p.get("uid") or "").strip()
                p_uid = str(p.get("uid") or "").strip()
                uid_ok = (not old_uid.startswith(("u_", "uid_"))) or (p_uid and p_uid == old_uid)
                explicit_cid = str(room.get("explicitCreatorCid") or "").strip()
                req_mtype = str(data.get("type") or "").strip().lower()
                allow_precreated_claim = req_mtype in ("", "init", "join", "poll") or bool(data.get("_verifiedClientToken"))
                verified_owner_claim = bool(data.get("_verifiedClientToken")) or bool(old_uid.startswith(("u_", "uid_")) and p_uid == old_uid)
                if allow_precreated_claim and uid_ok and (
                    (not other_real_humans and not explicit_cid)
                    or (verified_owner_claim and p_slug and _slugify_name(old_p.get("name") or "") == p_slug and bool(data.get("isCreator")))
                    or (not explicit_cid and p_slug and _slugify_name(old_p.get("name") or "") == p_slug and bool(data.get("isCreator")))
                ):
                    room["participants"].pop(old_cid, None)
                    room.setdefault("left", {})[old_cid] = t_now
                    if room.get("host_id") == old_cid:
                        room["host_id"] = cid
                    if room.get("creatorCid") == old_cid:
                        room["creatorCid"] = cid
                    if room.get("creatorId") == old_cid:
                        room["creatorId"] = p_uid or cid
                    co_l = list(room.get("co_hosts") or [])
                    if old_cid in co_l:
                        co_l.remove(old_cid)
                        if cid not in co_l:
                            co_l.append(cid)
                        room["co_hosts"] = co_l
                    replaced_precreated = True
                    continue
            if not p.get("name") or p.get("name") == "Misafir":
                continue
            if old_cid in live_ws:
                continue
            stale_age = t_now - float(old_p.get("lastSeen") or 0.0)
            same_uid = bool(p.get("uid") and old_p.get("uid") and p.get("uid") == old_p.get("uid"))
            same_guest_name = bool(not p.get("uid") and not old_p.get("uid") and old_p.get("name") == p.get("name"))
            same_stale_user_device = (
                stale_age >= 10.0
                and old_p.get("device") == p.get("device")
                and (same_uid or same_guest_name)
            )
            if same_stale_user_device:
                room["participants"].pop(old_cid, None)
                if room.get("host_id") == old_cid:
                    room["host_id"] = cid
                if room.get("creatorCid") == old_cid:
                    room["creatorCid"] = cid
                co_l = list(room.get("co_hosts") or [])
                if old_cid in co_l:
                    co_l.remove(old_cid)
                    if cid not in co_l:
                        co_l.append(cid)
                    room["co_hosts"] = co_l
    is_creator = _is_creator_of_room(room, cid, p, data)
    p["isCreator"] = bool(is_creator)
    pre_count = len(room.get("participants") or {})
    room["participants"][cid] = p
    _dedupe_room_participants(room, prefer_cid=cid)
    post_count = len(room.get("participants") or {})
    was_deduped_replacement = replaced_precreated or (existing is None and post_count <= pre_count)
    cur_host_id = room.get("host_id")
    cur_host = room["participants"].get(cur_host_id) if cur_host_id else None

    if is_creator and not room.get("host_transferred"):
        if not room.get("creatorId"):
            room["creatorId"] = p.get("uid") or cid
        room["creatorCid"] = cid
        co = list(room.get("co_hosts") or [])
        if cid not in co:
            co.append(cid)
            room["co_hosts"] = co
        cur_host_alive = bool(
            cur_host
            and cur_host.get("transport") != "bot"
            and (cur_host_id in SOCKETS.get(room.get("id", ""), {}) or (t_now - float(cur_host.get("lastSeen") or 0.0) <= 90.0))
        )
        cur_host_is_creator = bool(cur_host and _is_creator_of_room(room, cur_host_id or "", cur_host))
        if not cur_host_alive or not cur_host_is_creator:
            room["host_id"] = cid
    elif room.get("curated") and "kinox_bot" in room.get("participants", {}):
        room["host_id"] = "kinox_bot"
    elif not (cur_host and cur_host.get("transport") != "bot"):
        if not cur_host or (cur_host.get("transport") == "bot" and transport != "bot"):
            room["host_id"] = cid
    room["lastActiveAt"] = t_now
    return p, (existing is None and not was_deduped_replacement)


# ---------------------------------------------------------------------------
# Action handler (shared by WebSocket and HTTP transports)
# ---------------------------------------------------------------------------
def _sync_event(room, action, by):
    return {"type": "sync", "action": action, "by": by, "media": serialize(room)["media"]}


def _room_event(room, kind="room_state", **extra):
    return {"type": kind, "room": serialize(room), **extra}


def _apply_time(room, data):
    if "currentTime" in data:
        room["media"]["currentTime"] = _finite_float(data["currentTime"], float(room["media"].get("currentTime") or 0.0), 0.0, 864000.0)
    at_f = _finite_float(data.get("atTime"), -1.0)
    t = now()
    prev_upd = float(room["media"].get("updatedAt") or 0.0)
    cand = at_f if (at_f > 0.0 and abs(at_f - t) < 2.0) else t
    if prev_upd > 0.0 and abs(prev_upd - t) < 5.0 and cand <= prev_upd:
        cand = prev_upd + 0.001
    room["media"]["updatedAt"] = cand


def _play_next(room, by):
    """Advance according to play mode; returns True if media changed."""
    if not room["queue"]:
        return False
    if room["playMode"] == "vote":
        room["queue"].sort(key=lambda x: len(x.get("votes") or []), reverse=True)
    nxt = room["queue"].pop(0)
    set_media(room, nxt, by)
    sys_msg(room, f"Şu an oynatılıyor: {room['media']['title']}")
    return True


def handle_action(room: Dict[str, Any], cid: str, data: Dict[str, Any]) -> Dict[str, List]:
    out = {"broadcast": [], "reply": []}
    mtype = data.get("type")
    if mtype == "batch":
        for sub in (data.get("items") or [])[:25]:
            if isinstance(sub, dict) and sub.get("type") != "batch":
                sub_out = handle_action(room, cid, sub)
                out["broadcast"].extend(sub_out.get("broadcast", []))
                out["reply"].extend(sub_out.get("reply", []))
                if sub_out.get("direct"):
                    out.setdefault("direct", []).extend(sub_out["direct"])
                if sub_out.get("kick"):
                    out["kick"] = sub_out["kick"]
                if sub_out.get("close_room"):
                    out["close_room"] = True
        return out
    me = room["participants"].get(cid)
    if not me:
        return out
    name = me["name"]
    p_slug = _slugify_name(name)
    rid_str = str(room.get("id") or "")
    t_now = now()
    live_ws = SOCKETS.get(rid_str, {})
    cur_host_id = room.get("host_id")
    cur_host = room["participants"].get(cur_host_id or "")
    cur_host_alive = bool(
        cur_host
        and cur_host.get("transport") != "bot"
        and (cur_host_id in live_ws or (t_now - float(cur_host.get("lastSeen") or 0.0) <= HTTP_PARTICIPANT_TTL))
    )
    cur_host_is_creator = bool(cur_host and _is_creator_of_room(room, cur_host_id or "", cur_host))
    is_creator = _is_creator_of_room(room, cid, me, data)
    me["isCreator"] = bool(is_creator)
    if is_creator:
        if not room.get("host_transferred"):
            room["creatorCid"] = cid
            co = list(room.get("co_hosts") or [])
            if cid not in co:
                co.append(cid)
                room["co_hosts"] = co
            if room.get("host_id") != cid and (not cur_host_alive or not cur_host_is_creator):
                room["host_id"] = cid
    is_host = cid == room["host_id"]
    mode = room["playMode"]
    co_hosts = set(room.get("co_hosts") or [])
    can_control = is_host or is_creator or (cid in co_hosts) or (mode == "cohost")
    deny = lambda text: out["reply"].append({"type": "error", "message": text})
    req_act_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(data.get("actionId") or ""))[:32]

    if mtype == "heartbeat":
        if room.get("curated"):
            return out
        cur_h_id = room.get("host_id")
        cur_host = room["participants"].get(cur_h_id or "")
        cur_host_alive = bool(
            cur_host
            and cur_host.get("transport") != "bot"
            and (cur_h_id in live_ws or (t_now - float(cur_host.get("lastSeen") or 0.0) <= HTTP_PARTICIPANT_TTL))
        )
        if not is_host:
            if can_control and not cur_host_alive:
                room["host_id"] = cid
                is_host = True
            else:
                return out
        if not room["media"].get("url") and not room["media"].get("videoId"):
            if isinstance(data.get("activeMedia"), dict) and (data["activeMedia"].get("url") or data["activeMedia"].get("videoId")):
                try:
                    restore_t = float(data.get("currentTime") or data["activeMedia"].get("currentTime") or 0.0)
                except (TypeError, ValueError):
                    restore_t = 0.0
                set_media(room, data["activeMedia"], name, restore_t)
                room["rev"] = int(room.get("rev") or 1) + 5
                out["broadcast"].append((_room_event(room, "media_changed", by=name), None))
            return out
        inc_t = _finite_float(data.get("currentTime"), 0.0, 0.0, 864000.0)
        cur_m = room["media"]
        if isinstance(data.get("activeMedia"), dict):
            inc_hb_clean = clean_media(data["activeMedia"])
            cur_mk = media_key(cur_m)
            inc_mk = media_key(inc_hb_clean)
            if cur_mk and inc_mk and cur_mk != inc_mk:
                return out
            inc_hb_url = str(inc_hb_clean.get("url") or "")
            if inc_hb_url and not inc_hb_url.startswith("/api/rave/resolve-catalog"):
                cur_hb_url = str(cur_m.get("url") or "")
                if (not cur_hb_url or cur_hb_url.startswith("/api/rave/resolve-catalog")) and (not cur_mk or cur_mk == inc_mk):
                    for k in ("provider", "catalogProvider", "streamType", "url", "altUrls", "servers", "subtitleTracks", "audioTracks", "intro", "duration", "mediaType", "season", "episode", "tmdbId", "imdbId", "seriesTitle", "originalTitle", "videoId", "clipVideoId", "embedUrl", "poster", "thumbnail"):
                        if inc_hb_clean.get(k):
                            cur_m[k] = inc_hb_clean[k]
                    room["_tok_sig"] = ""
        cur_unres_hb = (
            str(cur_m.get("url") or "").startswith("/api/rave/resolve-catalog")
            and float(cur_m.get("currentTime") or 0.0) <= 0.5
            and not bool(cur_m.get("playbackAnchored"))
        )
        if cur_unres_hb and inc_t <= 0.25:
            return out
        cur_live = float(cur_m.get("currentTime") or 0.0) + (max(0.0, t_now - float(cur_m.get("updatedAt") or t_now)) * float(cur_m.get("rate") or 1.0) if (cur_m.get("playing") and not cur_unres_hb) else 0.0)
        if (cur_live > 30.0 and inc_t <= 0.5) or (bool(cur_m.get("playbackAnchored")) and cur_live > 20.0 and inc_t < 4.0):
            return out
        prev_playing = bool(cur_m.get("playing"))
        prev_privacy = room.get("privacy")
        want_play = bool(data.get("playing", prev_playing))
        last_pause_at = float(room["media"].get("lastExplicitPauseAt") or 0.0)
        if want_play and not prev_playing and (t_now - last_pause_at < 15.0):
            want_play = False
        if is_host and data.get("privacy") in VALID_PRIVACY:
            room["privacy"] = data["privacy"]
        is_anchor_hb = _as_bool(data.get("anchor"))
        if prev_playing and want_play and not is_anchor_hb and cur_live > 2.0 and inc_t < cur_live - 2.0:
            room["media"]["currentTime"] = cur_live
            room["media"]["updatedAt"] = t_now
            room["media"]["playbackAnchored"] = True
            room["_tok_sig"] = ""
            return out
        _apply_time(room, data)
        room["media"]["playing"] = want_play
        room["media"]["playbackAnchored"] = True
        room["_tok_sig"] = ""
        if prev_playing and want_play and not is_anchor_hb and cur_live > 5.0 and abs(inc_t - cur_live) <= 0.08 and room.get("privacy") == prev_privacy:
            return out
        if is_anchor_hb or bool(room["media"].get("playing")) != prev_playing or room.get("privacy") != prev_privacy or abs(inc_t - cur_live) > 0.25:
            room["rev"] = int(room.get("rev") or 1) + 1
        hb_ev = _sync_event(room, "heartbeat", name)
        hb_ev["id"] = req_act_id or ("ev_" + uuid.uuid4().hex[:10])
        hb_ev["ts"] = t_now
        hb_ev["cid"] = cid
        prev_evs = [e for e in (room.get("events") or []) if not (e.get("type") == "sync" and e.get("action") == "heartbeat")]
        room["events"] = prev_evs[-34:] + [hb_ev]
        out["broadcast"].append((hb_ev, cid))
        return out

    if mtype == "resolve_media":
        if room.get("curated"):
            return out
        cur_m = room.get("media") or {}
        incoming = clean_media(data)
        inc_url = str(incoming.get("url") or "")
        if inc_url and not inc_url.startswith("/api/rave/resolve-catalog"):
            cur_url = str(cur_m.get("url") or "")
            cur_unresolved = not cur_url or cur_url.startswith("/api/rave/resolve-catalog")
            same_key = (not media_key(cur_m)) or (media_key(cur_m) == media_key(incoming))
            if not can_control:
                # Non-controllers may only fulfill an unresolved catalog room using direct media streams (never iframes/embeds).
                if not cur_url.startswith("/api/rave/resolve-catalog") or not same_key:
                    return out
                if not inc_url.startswith(("/api/rave/stream", "/api/rave/stream-proxy", "https://")):
                    return out
                if incoming.get("provider") in ("embed", "youtube"):
                    return out
                if incoming.get("provider") in ("", "web") and inc_url.startswith("https://"):
                    incoming["provider"] = "hls" if ".m3u8" in inc_url.lower() else "mp4"
                for unsafe_k in ("embedUrl", "mvUrl", "bgVideoUrl", "bgYoutubeId", "audioPreviewUrl", "providerUrl", "officialUrl", "sourceUrl", "videoId"):
                    incoming.pop(unsafe_k, None)
            allow_unresolved = can_control if not cur_url else (can_control or same_key)
            if (cur_unresolved and allow_unresolved) or (can_control and same_key and inc_url != cur_url):
                raw_inc_ct = data.get("currentTime") if data.get("currentTime") is not None else incoming.get("currentTime")
                inc_ct = max(0.0, _finite_float(raw_inc_ct, 0.0))
                cur_ct = max(0.0, float(cur_m.get("currentTime") or 0.0))
                was_anchored = bool(cur_m.get("playbackAnchored") or cur_ct > 0.5 or not cur_unresolved)
                elapsed_live = (
                    max(0.0, t_now - float(cur_m.get("updatedAt") or t_now)) * float(cur_m.get("rate") or 1.0)
                    if (cur_m.get("playing") and was_anchored)
                    else 0.0
                )
                cur_live_pos = max(0.0, cur_ct + elapsed_live)
                if not can_control:
                    if was_anchored or cur_live_pos > 1.5:
                        cur_m["currentTime"] = cur_live_pos
                    else:
                        cur_m["currentTime"] = max(cur_ct, inc_ct)
                elif cur_live_pos > 5.0 and inc_ct < 2.0:
                    cur_m["currentTime"] = cur_live_pos
                elif cur_unresolved and not was_anchored:
                    cur_m["currentTime"] = max(cur_ct, inc_ct) if (cur_ct > 2.0 or inc_ct > 2.0) else inc_ct
                else:
                    cur_m["currentTime"] = max(cur_live_pos, inc_ct)
                allowed_res_keys = (
                    ("provider", "catalogProvider", "streamType", "url", "altUrls", "servers", "subtitleTracks", "audioTracks", "intro", "duration", "mediaType", "season", "episode", "episodeCount", "totalSeasons", "seasonsMeta", "tmdbId", "imdbId", "seriesTitle", "originalTitle", "poster", "thumbnail")
                    if not can_control
                    else ("provider", "catalogProvider", "streamType", "url", "altUrls", "servers", "subtitleTracks", "audioTracks", "intro", "duration", "mediaType", "season", "episode", "episodeCount", "totalSeasons", "seasonsMeta", "tmdbId", "imdbId", "seriesTitle", "originalTitle", "videoId", "clipVideoId", "embedUrl", "mvUrl", "bgVideoUrl", "bgYoutubeId", "audioPreviewUrl", "poster", "thumbnail", "artist", "songTitle", "musicMode", "musicPlatformLabel", "similar")
                )
                for k in allowed_res_keys:
                    if incoming.get(k):
                        cur_m[k] = incoming[k]
                cur_m["updatedAt"] = t_now
                cur_m["playbackAnchored"] = True
                room["media"] = cur_m
                room["rev"] = int(room.get("rev") or 1) + 1
                room["_tok_sig"] = ""
                res_ev = _sync_event(room, "resolve_media", name)
                res_ev["id"] = req_act_id or ("ev_" + uuid.uuid4().hex[:10])
                res_ev["ts"] = t_now
                res_ev["cid"] = cid
                room.setdefault("events", []).append(res_ev)
                room["events"] = room["events"][-35:]
                out["broadcast"].append((res_ev, cid))
        return out

    if mtype in ("play", "pause", "seek", "rate"):
        if room.get("curated") and mtype in ("play", "pause", "seek", "rate"):
            if mtype in ("pause", "seek", "rate"):
                deny("7/24 canlı yayın odalarında yayın duraklatılamaz veya sarılamaz.")
            out["reply"].append(_sync_event(room, "correct", "server"))
            return out
        if not can_control:
            deny("Bunu yalnızca oda lideri veya ortak lider yapabilir.")
            out["reply"].append(_sync_event(room, "correct", "server"))
            return out
        if not room["media"].get("url") and not room["media"].get("videoId"):
            return out
        if (is_creator and not room.get("host_transferred")) or not cur_host_alive:
            room["host_id"] = cid
            is_host = True
        _apply_time(room, data)
        room["media"]["playbackAnchored"] = True
        room["_tok_sig"] = ""
        if mtype == "play":
            room["media"]["playing"] = True
            room["media"]["lastExplicitPauseAt"] = 0.0
            room["endedKey"] = ""
        elif mtype == "pause":
            room["media"]["playing"] = False
            room["media"]["lastExplicitPauseAt"] = t_now
            room["media"]["updatedAt"] = max(t_now, float(room["media"].get("updatedAt") or 0.0) + 0.001)
        elif mtype == "seek":
            room["endedKey"] = ""
        elif mtype == "rate":
            room["media"]["rate"] = _finite_float(data.get("rate", 1.0), 1.0, 0.25, 2.0)
        room["media"]["lastActionBy"] = name
        room["rev"] = int(room.get("rev") or 1) + 1
        ev = _sync_event(room, mtype, name)
        ev["id"] = req_act_id or ("ev_" + uuid.uuid4().hex[:10])
        ev["ts"] = t_now
        ev["cid"] = cid
        room["events"] = (room.get("events") or [])[-34:] + [ev]
        out["broadcast"].append((ev, cid))

    elif mtype == "change_media":
        if room.get("curated"):
            deny("7/24 canlı TV ve radyo odalarında yayın değiştirilemez.")
            return out
        if mode in ("leader", "autoplay", "vote") and not can_control:
            deny("Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider video seçebilir.")
            return out
        if (is_creator and not room.get("host_transferred")) or not cur_host_alive:
            room["host_id"] = cid
            is_host = True
        start_pos = _finite_float(data.get("currentTime"), 0.0, 0.0, 864000.0)
        set_media(room, data, name, start_pos)
        room["rev"] = int(room.get("rev") or 1) + 5
        sys_msg(room, f"Şu an oynatılıyor: {room['media']['title']}", name)
        mc_ev = _room_event(room, "media_changed", by=name)
        mc_ev["id"] = req_act_id or ("mc_" + uuid.uuid4().hex[:10])
        mc_ev["ts"] = t_now
        mc_ev["cid"] = cid
        room["events"] = (room.get("events") or [])[-34:] + [mc_ev]
        out["broadcast"].append((mc_ev, None))

    elif mtype == "queue_add":
        if room.get("curated"):
            deny("7/24 canlı yayın odalarında sıraya video eklenemez.")
            return out
        me_rl = room["participants"][cid].setdefault("_rl", {})
        if now() - float(me_rl.get("queue_add") or 0.0) < 0.35:
            return out
        me_rl["queue_add"] = now()
        item = clean_media(data.get("item") or {})
        item.update({"id": f"q_{uuid.uuid4().hex[:8]}", "votes": [name], "addedBy": name})
        if (mode == "quickplay" and can_control) or (can_control and not room["media"].get("url") and not room["media"].get("videoId")):
            set_media(room, item, name)
            room["rev"] = int(room.get("rev") or 1) + 1
            sys_msg(room, f"Şu an oynatılıyor: {room['media']['title']}", name)
            out["broadcast"].append((_room_event(room, "media_changed", by=name), None))
        else:
            room["queue"] = (room["queue"] + [item])[:50]
            room["rev"] = int(room.get("rev") or 1) + 1
            sys_msg(room, f"sıraya ekledi: {item['title']}", name)
            out["broadcast"].append((_room_event(room), None))

    elif mtype == "vote_video":
        try:
            idx = int(data.get("index", -1))
        except (TypeError, ValueError):
            idx = -1
        if mode == "leader" and not can_control:
            deny("Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider oy kullanabilir.")
            return out
        if 0 <= idx < len(room["queue"]):
            votes = list(room["queue"][idx].get("votes") or [])
            votes.remove(name) if name in votes else votes.append(name)
            room["queue"][idx]["votes"] = votes
            if mode == "vote":
                room["queue"].sort(key=lambda x: len(x.get("votes") or []), reverse=True)
            room["rev"] = int(room.get("rev") or 1) + 1
            out["broadcast"].append(({"type": "vote_updated", "queue": room["queue"], "voteEndsAt": room["voteEndsAt"]}, None))

    elif mtype in ("queue_play_index", "queue_remove"):
        if room.get("curated"):
            deny("7/24 canlı yayın odalarında sıra yönetilemez.")
            return out
        try:
            idx = int(data.get("index", -1))
        except (TypeError, ValueError):
            idx = -1
        if not can_control:
            deny("Sırayı yalnızca oda lideri yönetebilir.")
            return out
        if 0 <= idx < len(room["queue"]):
            item = room["queue"].pop(idx)
            room["rev"] = int(room.get("rev") or 1) + 1
            if mtype == "queue_play_index":
                set_media(room, item, name)
                sys_msg(room, f"Şu an oynatılıyor: {room['media']['title']}")
                out["broadcast"].append((_room_event(room, "media_changed", by=name), None))
            else:
                out["broadcast"].append(({"type": "queue_updated", "queue": room["queue"]}, None))

    elif mtype == "queue_reorder":
        if room.get("curated"):
            deny("7/24 canlı yayın odalarında sıra yönetilemez.")
            return out
        if not (can_control or mode in ("cohost", "quickplay", "vote")):
            deny("Sırayı yalnızca oda lideri yeniden sıralayabilir.")
            return out
        try:
            from_idx = int(data.get("fromIndex", -1))
            to_idx = int(data.get("toIndex", -1))
        except (TypeError, ValueError):
            from_idx, to_idx = -1, -1
        q_len = len(room["queue"])
        if 0 <= from_idx < q_len and 0 <= to_idx < q_len and from_idx != to_idx:
            moved = room["queue"].pop(from_idx)
            room["queue"].insert(to_idx, moved)
            room["rev"] = int(room.get("rev") or 1) + 1
            out["broadcast"].append(({"type": "queue_updated", "queue": room["queue"]}, None))

    elif mtype == "queue_add_batch":
        if room.get("curated"):
            deny("7/24 canlı yayın odalarında sıraya video eklenemez.")
            return out
        me_rl = room["participants"][cid].setdefault("_rl", {})
        if now() - float(me_rl.get("queue_add_batch") or 0.0) < 2.0:
            return out
        me_rl["queue_add_batch"] = now()
        raw_items = data.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            return out
        cleaned_batch = []
        for raw_it in raw_items[:40]:
            if isinstance(raw_it, dict):
                ci = clean_media(raw_it)
                if ci.get("url") or ci.get("videoId"):
                    ci.update({"id": f"q_{uuid.uuid4().hex[:8]}", "votes": [name], "addedBy": name})
                    cleaned_batch.append(ci)
        if cleaned_batch:
            if can_control and not room["media"].get("url") and not room["media"].get("videoId"):
                first_it = cleaned_batch.pop(0)
                set_media(room, first_it, name)
                if cleaned_batch:
                    room["queue"] = (room["queue"] + cleaned_batch)[:60]
                room["rev"] = int(room.get("rev") or 1) + 2
                sys_msg(room, f"📋 Playlist başlatıldı ({1 + len(cleaned_batch)} video): {room['media']['title']}", name)
                out["broadcast"].append((_room_event(room, "media_changed", by=name), None))
            else:
                room["queue"] = (room["queue"] + cleaned_batch)[:60]
                room["rev"] = int(room.get("rev") or 1) + 1
                sys_msg(room, f"📋 Playlist sıraya eklendi ({len(cleaned_batch)} video)", name)
                out["broadcast"].append((_room_event(room), None))

    elif mtype == "vote_skip":
        if room.get("curated"):
            deny("7/24 canlı yayın odalarında yayın atlanamaz.")
            return out
        human_ids = {
            pcid for pcid, pp in (room.get("participants") or {}).items()
            if isinstance(pp, dict) and pp.get("transport") != "bot"
        }
        room["skip_votes"] = [v for v in (room.get("skip_votes") or []) if v in human_ids]
        if cid in human_ids and cid not in room["skip_votes"]:
            room["skip_votes"].append(cid)
        room["rev"] = int(room.get("rev") or 1) + 1
        needed = max(1, len(human_ids) // 2 + 1)
        if len(room["skip_votes"]) >= needed and room["queue"]:
            _play_next(room, "Atlama oylaması")
            out["broadcast"].append((_room_event(room, "media_changed", by="skip"), None))
        else:
            if not room["queue"]:
                room["skip_votes"] = []
            out["broadcast"].append(({"type": "skip_votes", "votes": room["skip_votes"], "needed": needed}, None))

    elif mtype == "video_ended":
        if room.get("curated"):
            return out
        host_p = (room.get("participants") or {}).get(room.get("host_id") or "")
        leader_online = bool(host_p and (now() - float(host_p.get("lastSeen") or 0.0) <= 35.0))
        if mode == "leader" and not can_control and leader_online:
            return out
        m_cur = room["media"]
        try:
            m_dur = float(m_cur.get("duration") or 0.0)
        except (TypeError, ValueError):
            m_dur = 0.0
        if not can_control and m_dur > 30.0:
            t_ref = now()
            exp_pos = float(m_cur.get("currentTime") or 0.0) + (
                max(0.0, t_ref - float(m_cur.get("updatedAt") or t_ref)) * float(m_cur.get("rate") or 1.0)
                if m_cur.get("playing") else 0.0
            )
            if exp_pos < m_dur - 25.0:
                return out
        key = clean_str(data.get("key"), 2100)
        if key and key == media_key(room["media"]) and room["endedKey"] != key:
            room["endedKey"] = key
            room["media"]["playing"] = False
            room["rev"] = int(room.get("rev") or 1) + 1
            if room["queue"] and mode == "vote":
                room["voteEndsAt"] = now() + VOTE_WINDOW
                out["broadcast"].append(({"type": "vote_updated", "queue": room["queue"], "voteEndsAt": room["voteEndsAt"]}, None))
                out["schedule_vote_end"] = room["voteEndsAt"]
            elif room["queue"]:
                _play_next(room, "Otomatik")
                out["broadcast"].append((_room_event(room, "media_changed", by="autoplay"), None))
            else:
                out["broadcast"].append((_sync_event(room, "ended", name), None))
    return _handle_social(room, cid, data, out, name, is_host)


def _merge_recent_chat(room: Dict[str, Any], raw_recent: Any, t_now: float, caller_can_seed: bool = False) -> bool:
    if not caller_can_seed or not isinstance(raw_recent, list) or room.get("curated") or room.get("_explicit_chat_clear"):
        return False
    if any(isinstance(m, dict) and not m.get("system") for m in (room.get("chat") or [])):
        return False
    cleared_at = float(room.get("chatClearedAt") or 0.0)
    by_id = {m.get("id"): m for m in (room.get("chat") or []) if isinstance(m, dict) and m.get("id")}
    added = False
    for rm in raw_recent[-40:]:
        if isinstance(rm, dict) and rm.get("id") and rm["id"] not in by_id and not rm.get("system"):
            try:
                rm_ts = float(rm.get("ts") or t_now)
            except (TypeError, ValueError):
                rm_ts = t_now
            if cleared_at > 0.0 and rm_ts <= cleared_at:
                continue
            if 0 <= t_now - rm_ts <= 86400.0:
                txt_val = clean_str(rm.get("text"), 1000)
                gif_val = clean_str(rm.get("gif"), 600)
                if gif_val and not re.match(r"^https://(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com)/", gif_val):
                    gif_val = ""
                snap_val = str(rm.get("snapshot") or "").strip()
                if snap_val and not (
                    (snap_val.startswith(("data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/png;base64,", "data:image/gif;base64,")) and len(snap_val) <= 85000)
                    or (snap_val.startswith(("/uploads/", "https://image.pollinations.ai/")) and len(snap_val) <= 1500)
                ):
                    snap_val = ""
                raw_an = rm.get("audioNote")
                an_val = None
                if isinstance(raw_an, dict):
                    try:
                        import social_engine as _se_vn
                        an_val = _se_vn.persist_audio_note(raw_an, fallback_id=clean_str(rm.get("id"), 24))
                        if isinstance(an_val, dict) and an_val.get("url") and len(str(an_val.get("dataUrl") or "")) > 24000:
                            an_val = {k: v for k, v in an_val.items() if k != "dataUrl"}
                    except Exception:
                        an_val = None
                    if an_val is None and str(raw_an.get("dataUrl") or "").startswith("data:audio/") and len(str(raw_an.get("dataUrl") or "")) <= 420000:
                        try:
                            an_dur = max(0.5, min(60.0, float(raw_an.get("duration") or 1.0)))
                        except (TypeError, ValueError):
                            an_dur = 2.0
                        raw_peaks = [max(0.05, min(1.0, float(x))) for x in (raw_an.get("peaks") or [])[:36] if isinstance(x, (int, float))]
                        an_val = {"dataUrl": str(raw_an["dataUrl"]), "duration": round(an_dur, 1), "peaks": raw_peaks or [0.3, 0.6, 0.8, 0.5, 0.7, 0.4]}
                if not txt_val and not gif_val and not snap_val and not an_val:
                    continue
                cand_uid = clean_str(rm.get("uid"), 64)
                if cand_uid.startswith("u_wl_"):
                    known_uids = {str(p.get("uid") or "") for p in (room.get("participants") or {}).values() if isinstance(p, dict)}
                    if cand_uid not in known_uids:
                        cand_uid = ""
                raw_rep = rm.get("replyTo")
                clean_rep = None
                if isinstance(raw_rep, dict) and (raw_rep.get("user") or raw_rep.get("text")):
                    clean_rep = {
                        "id": clean_str(raw_rep.get("id"), 24),
                        "user": clean_str(raw_rep.get("user"), 32),
                        "text": clean_str(raw_rep.get("text"), 140),
                        "color": clean_str(raw_rep.get("color"), 16) or "#00f5d4",
                    }
                clean_reacts: Dict[str, List[str]] = {}
                if isinstance(rm.get("reactions"), dict):
                    for rek, rev in list(rm["reactions"].items())[:12]:
                        em_k = clean_str(rek, 8)
                        if em_k and isinstance(rev, list):
                            u_clean = [clean_str(u, 36) for u in rev[:30] if isinstance(u, str) and clean_str(u, 36)]
                            if u_clean:
                                clean_reacts[em_k] = u_clean
                restored_m = {
                    "id": clean_str(rm.get("id"), 24),
                    "system": False,
                    "user": clean_str(rm.get("user"), 32) or "İzleyici",
                    "uid": cand_uid,
                    "color": clean_str(rm.get("color"), 16) or "#27DCC8",
                    "text": txt_val,
                    "gif": gif_val,
                    "time": clean_str(rm.get("time"), 12) or now_hhmm(rm_ts),
                    "ts": rm_ts,
                    "replyTo": clean_rep,
                    "reactions": clean_reacts,
                }
                if snap_val:
                    restored_m["snapshot"] = snap_val
                if rm.get("isExplicit"):
                    restored_m["isExplicit"] = True
                if rm.get("aiGenerated"):
                    restored_m["aiGenerated"] = True
                    restored_m["aiPrompt"] = clean_str(rm.get("aiPrompt"), 160)
                if an_val:
                    restored_m["audioNote"] = an_val
                if rm.get("breakRequest"):
                    restored_m["breakRequest"] = True
                if rm.get("pollId"):
                    restored_m["pollId"] = clean_str(rm.get("pollId"), 32)
                if isinstance(rm.get("videoTime"), (int, float)) and 0 <= float(rm["videoTime"]) <= 86400:
                    restored_m["videoTime"] = round(float(rm["videoTime"]), 1)
                by_id[rm["id"]] = restored_m
                added = True
    if added:
        room["chat"] = sorted(by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-MAX_CHAT:]
    return added


def _handle_social(room, cid, data, out, name, is_host):
    mtype = data.get("type")
    me = room["participants"][cid]
    t_now = now()
    req_act_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(data.get("actionId") or ""))[:32]
    rl = me.setdefault("_rl", {})
    if mtype in ("chat", "reaction", "soundfx", "poll_create", "break_request"):
        cd = 3.5 if mtype == "poll_create" else (1.5 if mtype == "break_request" else (0.04 if mtype == "chat" else 0.15))
        if t_now - float(rl.get(mtype) or 0.0) < cd:
            return out
        rl[mtype] = t_now
    if mtype == "chat":
        text = clean_str(data.get("text"), 1000)
        gif = clean_str(data.get("gif"), 600)
        if gif and not re.match(r"^https://(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com)/", gif):
            gif = ""
        snap = str(data.get("snapshot") or "").strip()
        if snap and not (
            (snap.startswith(("data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/png;base64,", "data:image/gif;base64,")) and len(snap) <= 85000)
            or (snap.startswith(("/uploads/", "https://image.pollinations.ai/")) and len(snap) <= 1500)
        ):
            snap = ""
        raw_an = data.get("audioNote")
        req_mid_pre = clean_str(data.get("id"), 24)
        pre_msg_id = req_mid_pre if (req_mid_pre and re.match(r"^[a-zA-Z0-9_-]{4,24}$", req_mid_pre)) else uuid.uuid4().hex[:10]
        audio_note = None
        if isinstance(raw_an, dict):
            try:
                import social_engine as _se_vn
                audio_note = _se_vn.persist_audio_note(raw_an, fallback_id=pre_msg_id)
                if isinstance(audio_note, dict) and audio_note.get("url") and len(str(audio_note.get("dataUrl") or "")) > 24000:
                    audio_note = {k: v for k, v in audio_note.items() if k != "dataUrl"}
            except Exception:
                audio_note = None
            if audio_note is None:
                an_du = str(raw_an.get("dataUrl") or "").strip()
                if an_du.startswith("data:audio/") and len(an_du) <= 420000:
                    try:
                        an_dur = max(0.5, min(60.0, float(raw_an.get("duration") or 1.0)))
                    except (TypeError, ValueError):
                        an_dur = 2.0
                    raw_peaks = []
                    for pk in (raw_an.get("peaks") or [])[:36]:
                        try:
                            raw_peaks.append(round(max(0.05, min(1.0, float(pk))), 2))
                        except (TypeError, ValueError):
                            pass
                    audio_note = {
                        "dataUrl": an_du,
                        "duration": round(an_dur, 1),
                        "peaks": raw_peaks or [0.25, 0.55, 0.85, 0.45, 0.75, 0.35, 0.65, 0.5],
                    }
        try:
            vid_t = float(data.get("videoTime")) if data.get("videoTime") is not None else None
            if vid_t is not None and (vid_t < 0 or vid_t > 86400):
                vid_t = None
        except (TypeError, ValueError):
            vid_t = None
        if text or gif or snap or audio_note:
            raw_rep = data.get("replyTo")
            reply_obj = None
            if isinstance(raw_rep, dict) and (raw_rep.get("user") or raw_rep.get("text")):
                reply_obj = {
                    "id": clean_str(raw_rep.get("id"), 24),
                    "user": clean_str(raw_rep.get("user"), 32),
                    "text": clean_str(raw_rep.get("text"), 140),
                    "color": clean_str(raw_rep.get("color"), 16) or "#00f5d4",
                }
            elif isinstance(raw_rep, str) and raw_rep.strip():
                rep_id = clean_str(raw_rep, 24)
                target_m = next((m for m in reversed(room.get("chat") or []) if m.get("id") == rep_id), None)
                if target_m:
                    reply_obj = {
                        "id": target_m.get("id", ""),
                        "user": target_m.get("user", ""),
                        "text": clean_str(target_m.get("text") or ("🎙️ Sesli Mesaj" if target_m.get("audioNote") else "📸 Medya" if target_m.get("snapshot") else "GIF" if target_m.get("gif") else ""), 140),
                        "color": target_m.get("color") or "#00f5d4",
                    }
            msg_id = pre_msg_id
            msg = {
                "id": msg_id, "user": name, "uid": me.get("uid", ""), "handle": me.get("handle", ""),
                "avatarUrl": me.get("avatarUrl", ""), "cid": cid, "color": me["color"], "text": text, "gif": gif,
                "time": now_hhmm(t_now), "ts": t_now, "replyTo": reply_obj, "reactions": {},
            }
            if snap:
                msg["snapshot"] = snap
                if data.get("isExplicit"):
                    msg["isExplicit"] = True
                if data.get("aiGenerated"):
                    msg["aiGenerated"] = True
                    msg["aiPrompt"] = clean_str(data.get("aiPrompt"), 160)
            if audio_note:
                msg["audioNote"] = audio_note
            if vid_t is not None:
                msg["videoTime"] = round(vid_t, 1)
            room.pop("_explicit_chat_clear", None)
            existing_chat = [m for m in (room.get("chat") or []) if isinstance(m, dict) and m.get("id") != msg_id]
            room["chat"] = (existing_chat + [msg])[-MAX_CHAT:]
            ev = {"id": uuid.uuid4().hex[:10], "ts": t_now, "type": "chat", "message": msg, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            room["rev"] = int(room.get("rev") or 1) + 1
            out["broadcast"].append(({"id": ev["id"], "type": "chat", "message": msg}, None))
    elif mtype == "profile_update":
        upd_name = clean_str(data.get("username") or data.get("name"), 24)
        if len(upd_name) >= 2:
            me["name"] = upd_name
        upd_handle = clean_str(data.get("handle"), 24)
        if upd_handle:
            me["handle"] = upd_handle
        upd_color = clean_str(data.get("color"), 16)
        if re.match(r"^#[0-9a-fA-F]{3,8}$", upd_color):
            me["color"] = upd_color
        if "bio" in data:
            me["bio"] = clean_str(data.get("bio"), 160)
        if "statusText" in data:
            me["statusText"] = clean_str(data.get("statusText"), 60)
        if "statusEmoji" in data:
            me["statusEmoji"] = clean_str(data.get("statusEmoji"), 12) or "🍿"
        if "hideLocation" in data:
            me["hideLocation"] = _as_bool(data.get("hideLocation"))
            if me["hideLocation"]:
                me["country"] = "XX"
            elif data.get("country"):
                me["country"] = re.sub(r"[^A-Z]", "", clean_str(data.get("country"), 2).upper()) or "TR"
        elif data.get("country") and not me.get("hideLocation"):
            me["country"] = re.sub(r"[^A-Z]", "", clean_str(data.get("country"), 2).upper()) or me.get("country", "TR")
        if "medal" in data:
            me["medal"] = clean_str(data.get("medal"), 32)
        if "watchMinutes" in data:
            me["watchMinutes"] = _safe_int(data.get("watchMinutes"), 0, 0, 10_000_000)
        raw_av_upd = str(data.get("avatarUrl") or "").strip()
        if raw_av_upd and (raw_av_upd.startswith(("https://", "/static/", "/uploads/")) or (raw_av_upd.startswith("data:image/") and len(raw_av_upd) <= 45000)):
            me["avatarUrl"] = raw_av_upd
        elif "avatarUrl" in data and not raw_av_upd:
            me["avatarUrl"] = ""
        if me.get("uid"):
            try:
                import social_engine as _se_upd
                _se_upd._register_social_dir({
                    "uid": me["uid"],
                    "name": me.get("name") or "İzleyici",
                    "handle": me.get("handle") or "",
                    "color": me.get("color") or "#27DCC8",
                    "avatarUrl": me.get("avatarUrl") or "",
                    "bio": me.get("bio") or "",
                    "statusEmoji": me.get("statusEmoji") or "🍿",
                    "statusText": me.get("statusText") or "",
                })
            except Exception:
                pass
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        room["_tok_sig"] = ""
        out["broadcast"].append((_room_event(room), None))
    elif mtype == "clear_chat":
        if room.get("curated"):
            out["reply"].append({"type": "error", "message": "7/24 canlı yayın odalarında sohbet geçmişi silinemez."})
            return out
        if not (is_host or cid in (room.get("co_hosts") or [])):
            out["reply"].append({"type": "error", "message": "Sohbeti yalnızca oda lideri temizleyebilir."})
            return out
        room["_explicit_chat_clear"] = True
        room["chatClearedAt"] = t_now
        room["chat"] = []
        room["polls"] = []
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append((_room_event(room, "chat_cleared", by=name), None))
    elif mtype == "msg_react":
        msg_id = clean_str(data.get("msgId"), 24)
        emoji = clean_str(data.get("emoji"), 8)
        if msg_id and emoji:
            target_m = next((m for m in reversed(room.get("chat") or []) if m.get("id") == msg_id and not m.get("system")), None)
            if target_m is not None:
                reacts = dict(target_m.get("reactions") or {})
                users = list(reacts.get(emoji) or [])
                base_name = name.split("#")[0]
                actor_tag = f"{base_name}#{cid[-4:]}"
                if actor_tag in users:
                    users.remove(actor_tag)
                elif name in users:
                    users.remove(name)
                else:
                    users.append(actor_tag)
                if users:
                    reacts[emoji] = users[:30]
                else:
                    reacts.pop(emoji, None)
                target_m["reactions"] = reacts
                room["rev"] = int(room.get("rev") or 1) + 1
                out["broadcast"].append(({"type": "msg_reacted", "msgId": msg_id, "reactions": reacts}, None))
    elif mtype == "typing":
        ev = {"id": uuid.uuid4().hex[:10], "ts": now(), "type": "typing", "user": name, "cid": cid}
        room["events"] = (room.get("events") or [])[-34:] + [ev]
        out["broadcast"].append(({"id": ev["id"], "type": "typing", "user": name}, cid))
    elif mtype == "reaction":
        emoji = clean_str(data.get("emoji"), 8)
        if emoji:
            ev = {"id": req_act_id or uuid.uuid4().hex[:10], "ts": now(), "type": "reaction", "emoji": emoji, "user": name, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            out["broadcast"].append(({"id": ev["id"], "type": "reaction", "emoji": emoji, "user": name}, cid))
    elif mtype == "soundfx":
        sfx = clean_str(data.get("sfx"), 24)
        if sfx:
            ev = {"id": req_act_id or uuid.uuid4().hex[:10], "ts": now(), "type": "soundfx", "sfx": sfx, "user": name, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            out["broadcast"].append(({"id": ev["id"], "type": "soundfx", "sfx": sfx, "user": name}, cid))
    elif mtype == "break_request":
        if room.get("curated"):
            out["reply"].append({"type": "error", "message": "7/24 canlı yayın odalarında mola istenemez."})
            return out
        ev_id = req_act_id or ("brk_" + uuid.uuid4().hex[:10])
        ev = {
            "id": ev_id,
            "ts": t_now,
            "type": "break_request",
            "user": name,
            "uid": me.get("uid", ""),
            "color": me.get("color", "#27DCC8"),
            "cid": cid,
        }
        room["events"] = (room.get("events") or [])[-34:] + [ev]
        msg = {
            "id": "m_" + uuid.uuid4().hex[:10],
            "user": name,
            "uid": me.get("uid", ""),
            "color": me.get("color", "#27DCC8"),
            "text": f"☕ Mola Zamanı — {name} duraklatma isteği gönderdi.",
            "breakRequest": True,
            "time": now_hhmm(t_now),
            "ts": t_now,
            "reactions": {},
        }
        room.pop("_explicit_chat_clear", None)
        room["chat"] = ((room.get("chat") or []) + [msg])[-MAX_CHAT:]
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append((ev, None))
        out["broadcast"].append(({"type": "chat", "message": msg}, None))
    elif mtype == "voice_state":
        stage_set = set(room.get("stage_speakers") or [])
        can_stage_speak = bool(is_host or cid in (room.get("co_hosts") or []) or cid in stage_set)
        if "handRaised" in data:
            me["handRaised"] = bool(data["handRaised"])
        if room["voipMode"] == "off" or (room["voipMode"] == "leader" and not is_host):
            me["muted"], me["speaking"] = True, False
            if data.get("muted") is False:
                out["reply"].append({"type": "error", "message": "Bu odada sesli iletişim kısıtlı."})
        elif room["voipMode"] == "stage" and not can_stage_speak:
            for k in ("inCall", "deafened"):
                if k in data:
                    me[k] = bool(data[k])
            me["muted"], me["speaking"], me["cam"], me["screen"] = True, False, False, False
            if (data.get("muted") is False) or data.get("cam") or data.get("screen"):
                out["reply"].append({"type": "error", "message": "🎤 Sahne Modu açık — konuşmak için '✋ Söz İste' butonunu kullanın."})
        else:
            want_active = (data.get("muted") is False) or bool(data.get("cam")) or bool(data.get("screen"))
            was_active = (not me.get("muted", True)) or bool(me.get("cam")) or bool(me.get("screen"))
            active_cnt = sum(1 for p in room["participants"].values() if not p.get("muted", True) or p.get("cam") or p.get("screen"))
            if want_active and not was_active and not is_host and active_cnt >= 8:
                me["muted"], me["speaking"], me["cam"], me["screen"] = True, False, False, False
                out["reply"].append({"type": "error", "message": "Sahne dolu: Aynı anda en fazla 8 kişi mikrofon/kamera açabilir."})
            else:
                for k in ("muted", "speaking", "cam", "screen", "inCall", "deafened"):
                    if k in data:
                        me[k] = bool(data[k])
                if not me.get("muted", True):
                    me["handRaised"] = False
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append(({"type": "participants_updated", "participants": serialize(room)["participants"]}, None))
    elif mtype == "hand_raise":
        next_hr = bool(data["raised"]) if "raised" in data else (not bool(me.get("handRaised")))
        me["handRaised"] = next_hr
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        if next_hr:
            ev_hr = {"id": uuid.uuid4().hex[:10], "ts": t_now, "type": "hand_raised", "user": name, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev_hr]
            out["broadcast"].append((ev_hr, cid))
        out["broadcast"].append(({"type": "participants_updated", "participants": serialize(room)["participants"]}, None))
    elif mtype == "host_action":
        if room.get("curated"):
            out["reply"].append({"type": "error", "message": "7/24 canlı yayın odalarında oda ayarları değiştirilemez."})
            return out
        act = data.get("action")
        is_creator_match = (not room.get("host_transferred")) and _is_creator_of_room(room, cid, me, {**data, "uid": me.get("uid", "")})
        if not (is_host or cid in (room.get("co_hosts") or []) or is_creator_match):
            out["reply"].append({"type": "error", "message": "Bu ayarları yalnızca oda lideri değiştirebilir."})
            return out
        if is_creator_match and room.get("host_id") not in room.get("participants", {}):
            room["host_id"] = cid
        if act != "toggle_stage_speaker" and not (is_host or is_creator_match):
            out["reply"].append({"type": "error", "message": "Bu işlemi yalnızca oda lideri gerçekleştirebilir."})
            return out
        if act == "set_privacy":
            if data.get("privacy") in VALID_PRIVACY:
                room["privacy"] = data["privacy"]
            if data.get("playMode") in VALID_PLAY_MODES:
                room["playMode"] = data["playMode"]
            if data.get("voipMode") in VALID_VOIP:
                room["voipMode"] = data["voipMode"]
            if "isMature" in data:
                room["isMature"] = bool(data.get("isMature"))
            if "password" in data and (is_host or is_creator_match):
                room["passwordHash"] = hash_room_password(data.get("password"))
                room.pop("password", None)
            if clean_str(data.get("name"), 45):
                room["name"] = clean_str(data.get("name"), 45)
            _LOBBY_CACHE["ts"] = 0.0
        elif act == "transfer_host" and (is_host or is_creator_match) and data.get("targetId") in room["participants"]:
            room["host_id"] = data["targetId"]
            room["host_transferred"] = True
            sys_msg(room, "artık oda lideri", room["participants"][data["targetId"]]["name"])
        elif act == "toggle_stage_mode":
            next_v = "all" if room.get("voipMode") == "stage" else "stage"
            room["voipMode"] = next_v
            if next_v == "stage":
                allowed_sp = {room.get("host_id")} | set(room.get("co_hosts") or []) | set(room.get("stage_speakers") or [])
                for pcid, pp in (room.get("participants") or {}).items():
                    if pcid not in allowed_sp and isinstance(pp, dict):
                        pp["muted"] = True
                        pp["speaking"] = False
                        pp["cam"] = False
                        pp["screen"] = False
                sys_msg(room, "🎤 Sahne Modu açıldı — dinleyiciler '✋ Söz İste' ile söz alabilir", name)
            else:
                for pp in (room.get("participants") or {}).values():
                    if isinstance(pp, dict):
                        pp["handRaised"] = False
                sys_msg(room, "🎙️ Serbest Ses Modu açıldı — herkes konuşabilir", name)
        elif act == "toggle_stage_speaker" and data.get("targetId") in room["participants"]:
            tid = data["targetId"]
            sp_list = list(room.get("stage_speakers") or [])
            target_p = room["participants"][tid]
            target_p["handRaised"] = False
            if tid in sp_list:
                sp_list.remove(tid)
                target_p["muted"] = True
                target_p["speaking"] = False
                target_p["cam"] = False
                target_p["screen"] = False
                sys_msg(room, "sahneden dinleyiciye alındı", target_p["name"])
            else:
                sp_list.append(tid)
                sys_msg(room, "🎤 sahneye konuşmacı olarak davet edildi", target_p["name"])
            room["stage_speakers"] = sp_list
        elif act in ("toggle_cohost", "promote_cohost") and (is_host or is_creator_match) and data.get("targetId") in room["participants"] and data["targetId"] != cid:
            tid = data["targetId"]
            co_list = list(room.get("co_hosts") or [])
            if tid in co_list:
                co_list.remove(tid)
                sys_msg(room, "ortak liderlikten çıkarıldı", room["participants"][tid]["name"])
            else:
                co_list.append(tid)
                sys_msg(room, "ortak lider (Co-Host) yapıldı", room["participants"][tid]["name"])
            room["co_hosts"] = co_list
        elif act == "kick" and (is_host or is_creator_match) and data.get("targetId") in room["participants"] and data["targetId"] != cid:
            tid = data["targetId"]
            target_p = room["participants"].get(tid)
            if not is_creator_match and (tid == room.get("host_id") or _is_creator_of_room(room, tid, target_p)):
                out["reply"].append({"type": "error", "message": "Oda kurucusu veya lideri odadan çıkarılamaz."})
                return out
            kicked = room["participants"].pop(tid)
            room.setdefault("left", {})[tid] = now()
            co_list = [x for x in (room.get("co_hosts") or []) if x != tid]
            room["co_hosts"] = co_list
            room["stage_speakers"] = [x for x in (room.get("stage_speakers") or []) if x != tid]
            room["skip_votes"] = [x for x in (room.get("skip_votes") or []) if x != tid]
            k_list = list(room.get("kicked") or [])
            if tid not in k_list:
                k_list.append(tid)
            kicked_uid = str(kicked.get("uid") or "").strip()
            if kicked_uid and f"uid:{kicked_uid}" not in k_list:
                k_list.append(f"uid:{kicked_uid}")
            room["kicked"] = k_list[-80:]
            if room.get("host_id") == tid:
                ensure_host(room)
            sys_msg(room, f"{name} tarafından odadan çıkarıldı", kicked["name"])
            out["kick"] = tid
        elif act == "close_room" and (is_host or is_creator_match) and not room.get("curated"):
            room["_close_room_now"] = True
            _LOBBY_CACHE["ts"] = 0.0
            out["close_room"] = True
            return out
        else:
            return out
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append((_room_event(room), None))
    elif mtype in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
        if str(room.get("voipMode") or "all") == "off":
            return out
        target = data.get("targetId")
        if target in room["participants"] and target != cid:
            sig_hits = [ts_h for ts_h in me.get("_sig_hits", ()) if t_now - ts_h < 5.0]
            if len(sig_hits) >= 80:
                me["_sig_hits"] = sig_hits
                return out
            sig_hits.append(t_now)
            me["_sig_hits"] = sig_hits
            relay = {}
            relay["type"] = mtype
            if "sdp" in data and data["sdp"] is not None:
                try:
                    if len(json.dumps(data["sdp"], separators=(",", ":"))) > 49152:
                        return out
                except Exception:
                    return out
                relay["sdp"] = data["sdp"]
            if "candidate" in data and data["candidate"] is not None:
                try:
                    if len(json.dumps(data["candidate"], separators=(",", ":"))) > 4096:
                        return out
                except Exception:
                    return out
                relay["candidate"] = data["candidate"]
            relay["fromId"] = cid
            relay["targetId"] = target
            req_sig_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(data.get("signalId") or ""))[:32]
            relay["id"] = req_sig_id or uuid.uuid4().hex[:10]
            relay["ts"] = t_now
            room["signals"] = [s for s in (room.get("signals") or []) if isinstance(s, dict) and (t_now - float(s.get("ts") or 0) < 30.0)][-119:] + [relay]
            room["rev"] = int(room.get("rev") or 1) + 1
            room["_tok_sig"] = ""
            out.setdefault("direct", []).append((target, relay))
    elif mtype == "poll_create":
        t_now = now()
        question = clean_str(data.get("question"), 140)
        raw_opts = [clean_str(o, 80) for o in (data.get("options") or [])[:5] if clean_str(o, 80)]
        if question and len(raw_opts) >= 2:
            poll = {
                "id": "p_" + uuid.uuid4().hex[:8],
                "question": question,
                "creator": name,
                "createdAt": t_now,
                "rev": 1,
                "options": [{"text": opt, "votes": []} for opt in raw_opts],
            }
            room["polls"] = ((room.get("polls") or []) + [poll])[-10:]
            msg = {
                "id": uuid.uuid4().hex[:10],
                "user": name,
                "uid": me.get("uid", ""),
                "color": me["color"],
                "text": f"📊 Anket: {question}",
                "pollId": poll["id"],
                "time": now_hhmm(t_now),
                "ts": t_now,
            }
            room["chat"] = (room["chat"] + [msg])[-MAX_CHAT:]
            room["rev"] = int(room.get("rev") or 1) + 1
            out["broadcast"].append(({"type": "poll_updated", "poll": poll, "polls": room["polls"]}, None))
            out["broadcast"].append(({"type": "chat", "message": msg}, None))
    elif mtype == "poll_vote":
        pid = clean_str(data.get("pollId"), 32)
        try:
            opt_idx = int(data.get("optionIndex", -1))
        except (TypeError, ValueError):
            opt_idx = -1
        base_v_name = name.split("#")[0]
        voter_tag = f"{base_v_name}#{cid[-4:]}"
        for poll in (room.get("polls") or []):
            if poll.get("id") == pid and 0 <= opt_idx < len(poll.get("options") or []):
                cur_votes = poll["options"][opt_idx].get("votes") or []
                already = voter_tag in cur_votes
                for o in poll["options"]:
                    o["votes"] = [v for v in (o.get("votes") or []) if v != voter_tag]
                if not already:
                    poll["options"][opt_idx]["votes"].append(voter_tag)
                poll["rev"] = int(poll.get("rev") or 1) + 1
                room["rev"] = int(room.get("rev") or 1) + 1
                out["broadcast"].append(({"type": "poll_updated", "poll": poll, "polls": room["polls"]}, None))
                break
    return out


def check_vote_end(room: Dict[str, Any]) -> bool:
    """Rave vote mode: when the 8 s pie timer ends, the top-voted item plays."""
    if room["voteEndsAt"] and now() >= room["voteEndsAt"]:
        room["voteEndsAt"] = 0.0
        if _play_next(room, "Oylama"):
            t_v = now()
            ev = {"id": "mc_" + uuid.uuid4().hex[:10], "ts": t_v, "type": "media_changed", "by": "vote", "media": dict(room.get("media") or {})}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            room["rev"] = int(room.get("rev") or 1) + 1
            return True
    return False


async def broadcast(room_id: str, message: Dict[str, Any], exclude: Optional[str] = None) -> None:
    targets = [(cid, ws) for cid, ws in list(SOCKETS.get(room_id, {}).items()) if cid != exclude]
    if not targets:
        return
    async def _send_one(c_id: str, w_sock: Any) -> None:
        try:
            await asyncio.wait_for(w_sock.send_json(message), timeout=1.5)
        except Exception:
            SOCKETS.get(room_id, {}).pop(c_id, None)
    await asyncio.gather(*(_send_one(c, w) for c, w in targets), return_exceptions=True)


_DELIVERED_EV_IDS = BoundedTTLCache(maxsize=4096, ttl=60.0)
_DELIVERED_SIG_IDS = BoundedTTLCache(maxsize=4096, ttl=60.0)
_LAST_FANOUT_REV = BoundedTTLCache(maxsize=2048, ttl=7200.0)
_WS_FANOUT_TASK: Optional[asyncio.Task] = None


def _mark_delivered_map(bucket: Any, item_id: Any, t_now: float) -> None:
    sid = str(item_id or "").strip()
    if not sid:
        return
    bucket[sid] = t_now


def _snapshot_room_event_ids(room: Optional[Dict[str, Any]]) -> set:
    if not isinstance(room, dict):
        return set()
    return {str(ev_i.get("id")) for ev_i in (room.get("events") or []) if isinstance(ev_i, dict) and ev_i.get("id")}


def _mark_new_local_events_delivered(room: Dict[str, Any], pre_ev_ids: set) -> None:
    t_m = now()
    for ev_i in (room.get("events") or []):
        if isinstance(ev_i, dict) and ev_i.get("id") and str(ev_i["id"]) not in pre_ev_ids:
            _mark_delivered_map(_DELIVERED_EV_IDS, str(ev_i["id"]), t_m)


def _mark_room_local_events_delivered(room: Dict[str, Any]) -> None:
    _mark_new_local_events_delivered(room, set())


async def _ws_redis_fanout_step() -> None:
    if not getattr(STORE, "shared", False) or not hasattr(STORE, "cmd"):
        return
    active_rids = [rid for rid, m in list(SOCKETS.items()) if m]
    if not active_rids:
        return
    keys = [f"vortex:room:{rid}" for rid in active_rids] + [f"vortex:closed:{rid}" for rid in active_rids]
    raws = await STORE.cmd("MGET", *keys)
    if not isinstance(raws, list) or len(raws) < len(active_rids) * 2:
        return
    t_now = now()
    n = len(active_rids)
    for idx, rid in enumerate(active_rids):
        try:
            if not SOCKETS.get(rid):
                continue
            is_closed = bool(raws[n + idx]) and not any(s["id"] == rid for s in CURATED_LIVE_SPECS)
            if is_closed:
                _CLOSED_ROOMS[rid] = t_now
                if hasattr(STORE, "l1_rooms"):
                    STORE.l1_rooms.pop(rid, None)
                await broadcast(rid, {"type": "room_closed", "roomId": rid})
                continue
            raw_room = raws[idx]
            if not raw_room:
                continue
            remote_room = json.loads(raw_room)
            if not isinstance(remote_room, dict):
                continue
            live_map = SOCKETS.get(rid, {})
            prev_l1 = STORE.l1_rooms.get(rid) if hasattr(STORE, "l1_rooms") else None
            if isinstance(prev_l1, dict):
                for l_cid in list(live_map.keys()):
                    if l_cid in (remote_room.get("participants") or {}) and l_cid in (prev_l1.get("participants") or {}):
                        remote_room["participants"][l_cid]["lastSeen"] = max(
                            float(remote_room["participants"][l_cid].get("lastSeen") or 0.0),
                            float(prev_l1["participants"][l_cid].get("lastSeen") or 0.0),
                        )
            if hasattr(STORE, "l1_rooms"):
                STORE.l1_rooms[rid] = remote_room
                STORE.l1_read_ts[rid] = t_now
            rem_rev = int(remote_room.get("rev") or 1)
            prev_rev = _LAST_FANOUT_REV.get(rid, rem_rev)
            _LAST_FANOUT_REV[rid] = rem_rev
            sent_any_ev = False
            for ev in (remote_room.get("events") or []):
                if not isinstance(ev, dict):
                    continue
                ev_id = str(ev.get("id") or "").strip()
                ev_ts = float(ev.get("ts") or 0.0)
                if not ev_id or (t_now - ev_ts > 20.0) or ev_id in _DELIVERED_EV_IDS:
                    continue
                _mark_delivered_map(_DELIVERED_EV_IDS, ev_id, t_now)
                sent_any_ev = True
                await broadcast(rid, ev, exclude=ev.get("cid"))
            for sig in (remote_room.get("signals") or []):
                if not isinstance(sig, dict):
                    continue
                sig_id = str(sig.get("id") or "").strip()
                sig_ts = float(sig.get("ts") or 0.0)
                target_cid = str(sig.get("targetId") or "").strip()
                if not sig_id or not target_cid or (t_now - sig_ts > 25.0) or sig_id in _DELIVERED_SIG_IDS:
                    continue
                ws_target = SOCKETS.get(rid, {}).get(target_cid)
                if ws_target:
                    _mark_delivered_map(_DELIVERED_SIG_IDS, sig_id, t_now)
                    try:
                        await asyncio.wait_for(ws_target.send_json(sig), timeout=1.5)
                    except Exception:
                        pass
            if rem_rev > prev_rev and not sent_any_ev:
                await broadcast(rid, _room_event(remote_room))
        except Exception:
            continue


async def _ws_redis_fanout_loop() -> None:
    while True:
        try:
            if not SOCKETS:
                await asyncio.sleep(1.0)
                continue
            await _ws_redis_fanout_step()
        except asyncio.CancelledError:
            break
        except Exception:
            pass
        await asyncio.sleep(0.45)


def _ensure_ws_fanout_task() -> None:
    global _WS_FANOUT_TASK
    if not getattr(STORE, "shared", False) or os.environ.get("VERCEL") == "1":
        return
    if _WS_FANOUT_TASK is None or _WS_FANOUT_TASK.done():
        try:
            loop = asyncio.get_running_loop()
            _WS_FANOUT_TASK = loop.create_task(_ws_redis_fanout_loop())
        except RuntimeError:
            pass


async def deliver(room_id: str, out: Dict[str, Any], sender_ws=None) -> None:
    t_now = now()
    for msg, exclude in out.get("broadcast", []):
        if isinstance(msg, dict) and msg.get("id"):
            _mark_delivered_map(_DELIVERED_EV_IDS, msg.get("id"), t_now)
        await broadcast(room_id, msg, exclude)
    for target, msg in out.get("direct", []):
        ws = SOCKETS.get(room_id, {}).get(target)
        if ws:
            if isinstance(msg, dict) and msg.get("id"):
                _mark_delivered_map(_DELIVERED_SIG_IDS, msg.get("id"), t_now)
            try:
                await asyncio.wait_for(ws.send_json(msg), timeout=1.5)
            except Exception:
                pass
    if sender_ws:
        for msg in out.get("reply", []):
            try:
                await sender_ws.send_json(msg)
            except Exception:
                pass
    if out.get("kick"):
        ws = SOCKETS.get(room_id, {}).pop(out["kick"], None)
        if ws:
            try:
                await ws.send_json({"type": "kicked"})
                await ws.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Transports + lobby endpoints (Starlette handlers)
# ---------------------------------------------------------------------------
from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.websockets import WebSocket, WebSocketDisconnect  # noqa: E402

ROOM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,47}$")

_LIVE_TV = [
    ("trt1", "TRT 1", "https://tv-trt1.medya.trt.com.tr/master.m3u8"),
    ("atv", "ATV", "https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/atv/atv_1080p.m3u8"),
    ("now-tv", "NOW", "https://uycyyuuzyh.turknet.ercdn.net/nphindgytw/nowtv/nowtv.m3u8"),
    ("star-tv", "Star TV", "https://dogus.daioncdn.net/startv/startv.m3u8?ce=3&app=a20ac41e-bdc3-4aa1-934d-26b484480ac9"),
    ("trt-spor", "TRT Spor", "https://tv-trtspor1.medya.trt.com.tr/master.m3u8"),
    ("a-spor", "A Spor", "https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/aspor/aspor.m3u8"),
    ("ntv", "NTV", "https://dogus.daioncdn.net/ntv/ntv.m3u8?ce=3&app=7c4bb802-0c41-409e-8cd2-799984995694"),
    ("haberturk", "Habertürk TV", "https://tv.ensonhaber.com/haberturk/haberturk.m3u8"),
    ("halk-tv", "Halk TV", "https://halktv-live.daioncdn.net/halktv/halktv.m3u8"),
    ("trt-haber", "TRT Haber", "https://tv-trthaber.medya.trt.com.tr/master.m3u8"),
    ("cnbc-e", "CNBC-e", "https://hnpsechtsc.turknet.ercdn.net/xpnvudnlsv/cnbc-e/cnbc-e.m3u8"),
    ("trt-belgesel", "TRT Belgesel", "https://tv-trtbelgesel.medya.trt.com.tr/master.m3u8"),
]

_LIVE_RADIO = [
    ("radyo-power-turk", "Power Türk", "https://live.powerapp.com.tr/powerturk/abr/powerturk/128/playlist.m3u8", "hls"),
    ("radyo-kral-fm", "Kral FM", "https://dygedge2.radyotvonline.net/kralfm/playlist.m3u8", "hls"),
    ("radyo-super-fm", "Süper FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/SUPER_FM_SC", "direct"),
    ("radyo-metro-fm", "Metro FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/METRO_FM_SC", "direct"),
    ("radyo-power-fm", "Power FM", "https://listen.powerapp.com.tr/powerfm/256/chunks.m3u8", "hls"),
    ("radyo-joy-turk", "Joy Türk", "https://playerservices.streamtheworld.com/api/livestream-redirect/JOY_TURK_SC", "direct"),
    ("radyo-slow-turk", "Slow Türk", "https://radyo1.radyo-dinle.tc/8062/stream", "direct"),
    ("radyo-best-fm", "Best FM", "https://ssldyg.radyotvonline.com/best/bestfm.stream/playlist.m3u8", "hls"),
    ("radyo-alem-fm", "Alem FM", "http://turkmedya.radyotvonline.com/turkmedya/alemfm.stream/playlist.m3u8", "hls"),
]


def _wrap_live_cors_url(u: str) -> str:
    if any(d in u for d in ("ercdn.net", "daioncdn.net", "radyotvonline.")):
        import urllib.parse
        return f"/api/rave/stream?u={urllib.parse.quote(u, safe='')}&proxy_segs=1&ext=.m3u8"
    return u


def _tv_spec(rid: str, name: str, url: str) -> Dict[str, Any]:
    play_u = _wrap_live_cors_url(url)
    alt_u = [url] if (play_u != url and url.startswith("https://")) else []
    return {
        "id": f"tv-{rid}", "name": f"7/24 {name} Canlı Yayın", "creator": "Watchlivo Canlı TV", "privacy": "public", "playMode": "leader",
        "media": {"provider": "hls", "streamType": "hls", "title": f"📺 {name} · Canlı Yayın", "url": play_u, "altUrls": alt_u, "channel": "Canlı TV · 7/24",
                  "thumbnail": "/static/watchlivo-poster.svg", "live": True, "mediaType": "live", "duration": 0.0},
    }


def _radio_spec(rid: str, name: str, url: str, kind: str) -> Dict[str, Any]:
    play_u = _wrap_live_cors_url(url) if kind == "hls" else url
    alt_u = [url] if (play_u != url and url.startswith("https://")) else []
    return {
        "id": rid, "name": f"7/24 {name} Canlı Radyo", "creator": "Watchlivo Canlı Radyo", "privacy": "public", "playMode": "leader",
        "media": {"provider": kind, "streamType": "hls" if kind == "hls" else "mp3", "title": f"📻 {name} · Canlı Radyo", "url": play_u, "altUrls": alt_u, "channel": "Canlı Radyo · 7/24",
                  "thumbnail": "/static/watchlivo-poster.svg", "live": True, "isMusic": True, "mediaType": "music", "artist": name,
                  "songTitle": "Canlı Yayın", "musicPlatformLabel": "Canlı Radyo", "duration": 0.0},
    }


CURATED_LIVE_SPECS = [_tv_spec(*t) for t in _LIVE_TV] + [_radio_spec(*r) for r in _LIVE_RADIO]
CURATED_ORDER = {s["id"]: idx for idx, s in enumerate(CURATED_LIVE_SPECS)}


def _build_curated_room(spec: Dict[str, Any]) -> Dict[str, Any]:
    rid = spec["id"]
    creator_label = spec.get("creator", "Watchlivo 7/24")
    r = new_room(rid, spec["name"], spec.get("privacy", "public"), spec.get("playMode", "cohost"), creator_label, "u_watchlivo_live")
    r["curated"] = True
    set_media(r, spec["media"], creator_label, start=0.0)
    r["participants"]["kinox_bot"] = {
        "id": "kinox_bot",
        "name": creator_label,
        "color": "#00f5d4",
        "device": "7/24 Sinema",
        "country": "TR",
        "uid": "u_watchlivo_live",
        "muted": True,
        "speaking": False,
        "transport": "bot",
        "lastSeen": 9999999999.0,
    }
    r["host_id"] = "kinox_bot"
    r["chat"] = []
    return r


async def ensure_curated_room(room_id: str) -> Optional[Dict[str, Any]]:
    spec = next((s for s in CURATED_LIVE_SPECS if s["id"] == room_id), None)
    if not spec:
        return None
    room = _build_curated_room(spec)
    await STORE.put(room)
    return room


def valid_room_id(room_id: str) -> bool:
    return bool(ROOM_ID_RE.match(room_id or ""))


async def _vote_timer(room_id: str, at: float) -> None:
    await asyncio.sleep(max(0.0, at - now()) + 0.05)
    async with STORE.lock(room_id):
        room = await STORE.get(room_id)
        if not room or not check_vote_end(room):
            return
        await STORE.put(room)
    await broadcast(room_id, _room_event(room, "media_changed", by="vote"))


def _after(room_id: str, out: Dict[str, Any]) -> None:
    if out.get("schedule_vote_end") and os.environ.get("VERCEL") != "1":
        asyncio.create_task(_vote_timer(room_id, out["schedule_vote_end"]))


async def _ws_safe_reject(websocket: WebSocket, payload: Dict[str, Any]) -> None:
    try:
        await websocket.send_json(payload)
        await websocket.close()
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass


async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    room_id = (websocket.path_params.get("room_id") or "").lower()
    q = websocket.query_params
    if not valid_room_id(room_id):
        await _ws_safe_reject(websocket, {"type": "error", "message": "Geçersiz oda"})
        return
    requested_cid = re.sub(r"[^a-zA-Z0-9_]", "", str(q.get("clientId") or ""))[:24]
    signed_cid = verify_client_token(room_id, q.get("clientToken"))
    verified_uid = _ws_verified_uid(websocket.scope, q)
    safe_p_uid = _safe_participant_uid(verified_uid, q.get("uid") or q.get("userId"))
    join_data = {
        k: v for k, v in q.items()
        if not str(k).startswith("_") and k not in ("pwd", "uid", "userId", "clientId", "clientToken", "syncToken")
    }
    join_data["uid"] = safe_p_uid
    registered = False
    cid = ""
    async with STORE.lock(room_id):
        is_curated_ws = any(s["id"] == room_id for s in CURATED_LIVE_SPECS)
        if not is_curated_ws and room_id in _CLOSED_ROOMS and (now() - float(_CLOSED_ROOMS.get(room_id) or 0.0) < 7200.0):
            await _ws_safe_reject(websocket, {"type": "room_closed", "roomId": room_id})
            return
        room = await STORE.get(room_id)
        if room is None and q.get("syncToken"):
            room = merge_sync_token(room, q.get("syncToken"), room_id)
        room = room or await ensure_curated_room(room_id) or new_room(room_id, creator=q.get("username", ""), creator_id=verified_uid)
        cid = signed_cid or requested_cid
        if not signed_cid and cid and _cid_is_active(room, cid, verified_uid, join_data):
            cid = ""
        if not cid:
            cid = uuid.uuid4().hex[:10]
        if not room.get("creatorId") and not room.get("curated") and not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values()):
            room["creatorId"] = verified_uid or cid
            room["creatorCid"] = cid
        room.setdefault("kicked", [])
        if (
            cid in room["kicked"]
            or (verified_uid and f"uid:{verified_uid}" in room["kicked"])
            or (safe_p_uid and f"uid:{safe_p_uid}" in room["kicked"])
        ):
            await _ws_safe_reject(websocket, {"type": "kicked"})
            return
        existing_p = (room.get("participants") or {}).get(cid)
        pw_trusted_member = bool(existing_p and ((signed_cid and signed_cid == cid) or existing_p.get("_precreated")))
        if has_password(room) and not pw_trusted_member:
            ws_rl_key = f"ws:{room_id}:{client_ip(websocket)}"
            allowed, _retry = _JOIN_LIMITER.peek(ws_rl_key)
            if not allowed:
                await _ws_safe_reject(websocket, {"type": "password_required", "roomId": room_id, "roomName": "🔒 Şifreli Oda"})
                return
            if not verify_room_password(room, q.get("pwd", "")):
                if str(q.get("pwd") or "").strip():
                    _JOIN_LIMITER.hit(ws_rl_key)
                await _ws_safe_reject(websocket, {"type": "password_required", "roomId": room_id, "roomName": "🔒 Şifreli Oda"})
                return
        if existing_p and existing_p.get("_precreated"):
            existing_p.pop("_precreated", None)
        if q.get("syncToken"):
            room = merge_sync_token(room, q.get("syncToken"), room_id)
        pre_ev_ids_join = _snapshot_room_event_ids(room)
        prune(room)
        was_empty_humans = not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
        empty_elapsed = (now() - float(room.get("emptySince") or 0.0)) if room.get("emptySince") else 0.0
        if was_empty_humans and (room.get("curated") or empty_elapsed > 3600.0):
            room["_explicit_chat_clear"] = True
            room["chat"] = []
            room["polls"] = []
            if room.get("media"):
                room["media"]["currentTime"] = 0.0
                room["media"]["updatedAt"] = now()
                room["media"]["playing"] = True
                room["media"].pop("_frozenByEmpty", None)
        elif was_empty_humans and not room.get("curated") and isinstance(room.get("media"), dict) and (room["media"].get("url") or room["media"].get("videoId")):
            room["media"]["updatedAt"] = now()
            if room["media"].pop("_frozenByEmpty", False) or not float(room["media"].get("lastExplicitPauseAt") or 0.0):
                room["media"]["playing"] = True
        room.pop("emptySince", None)
        p, is_new_ws = add_participant(room, cid, {**join_data, "_verifiedClientToken": bool(signed_cid and signed_cid == cid)}, "ws")
        join_msg = sys_msg(room, "odaya katıldı", p["name"]) if is_new_ws else None
        SOCKETS.setdefault(room_id, {})[cid] = websocket
        registered = True
        _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
        _mark_new_local_events_delivered(room, pre_ev_ids_join)
        _ensure_ws_fanout_task()
        await STORE.put(room, force_disk=True)
    try:
        await websocket.send_json({"type": "init", "clientId": cid, "clientToken": sign_client_token(room_id, cid), "room": serialize(room, for_cid=cid)})
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    await broadcast(room_id, {"type": "user_joined", "user": {"id": cid, "name": p["name"]}, "room": serialize(room)}, exclude=cid)
    if join_msg:
        await broadcast(room_id, {"type": "chat", "message": join_msg}, exclude=cid)
    explicit_ws_leave = False
    explicit_ws_close = False
    last_redis_ping_sync = now()
    try:
        while True:
            raw_ws_data = await websocket.receive_json()
            if not isinstance(raw_ws_data, dict):
                continue
            data = {k: v for k, v in raw_ws_data.items() if not str(k).startswith("_")}
            if data.get("type") == "ping":
                t_ping = now()
                r_mem = (STORE.l1_rooms if hasattr(STORE, "l1_rooms") else getattr(STORE, "rooms", {})).get(room_id)
                if isinstance(r_mem, dict) and cid in (r_mem.get("participants") or {}):
                    r_mem["participants"][cid]["lastSeen"] = t_ping
                if getattr(STORE, "shared", False) and (t_ping - last_redis_ping_sync >= 20.0):
                    last_redis_ping_sync = t_ping
                    async with STORE.lock(room_id, remote=False):
                        r_sync = await STORE.get(room_id)
                        if isinstance(r_sync, dict) and cid in (r_sync.get("participants") or {}):
                            r_sync["participants"][cid]["lastSeen"] = t_ping
                            await STORE.put(r_sync, force_disk=True)
                await websocket.send_json({"type": "pong", "t0": data.get("t0", 0), "t0Epoch": data.get("t0Epoch", 0), "serverTime": t_ping})
                continue
            if data.get("type") in ("leave", "close_room"):
                explicit_ws_leave = True
                explicit_ws_close = data.get("type") == "close_room"
                break
            if data.get("type") == "init" and (data.get("username") or data.get("name")):
                data = {**data, "type": "profile_update"}
            async with STORE.lock(room_id, remote=True):
                room = await STORE.get(room_id, force_fresh=True)
                if not room or cid not in room["participants"]:
                    break
                pre_ev_ids_act = _snapshot_room_event_ids(room)
                prev_rev_ws = int(room.get("rev") or 1)
                room["participants"][cid]["lastSeen"] = now()
                out = handle_action(room, cid, data)
                if out.get("close_room") or room.get("_close_room_now"):
                    await STORE.delete(room_id)
                    _LOBBY_CACHE["ts"] = 0.0
                    await broadcast(room_id, {"type": "room_closed", "roomId": room_id})
                    break
                _mark_new_local_events_delivered(room, pre_ev_ids_act)
                await STORE.put(room, force_disk=bool(int(room.get("rev") or 1) != prev_rev_ws or out.get("broadcast")))
                _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
            await deliver(room_id, out, websocket)
            _after(room_id, out)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    except Exception as e:  # malformed frames must not crash the server
        print("[ws] error", repr(e))
    finally:
        if not registered:
            return
        SOCKETS.get(room_id, {}).pop(cid, None)
        if room_id in SOCKETS and not SOCKETS[room_id]:
            SOCKETS.pop(room_id, None)
            _LAST_FANOUT_REV.pop(room_id, None)
        async with STORE.lock(room_id):
            room = await STORE.get(room_id)
            if room:
                pre_ev_ids_lv = _snapshot_room_event_ids(room)
                t_disc = now()
                prev_h = room.get("host_id")
                cur_p = room.get("participants", {}).get(cid)
                if explicit_ws_leave:
                    room.get("participants", {}).pop(cid, None)
                    room.setdefault("left", {})[cid] = t_disc
                    is_creator_close = bool(
                        explicit_ws_close
                        and not room.get("curated")
                        and (
                            cid == room.get("creatorCid")
                            or _is_creator_of_room(room, cid, cur_p, join_data)
                            or cid == prev_h
                        )
                    )
                    has_humans = any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
                    if not room.get("curated") and is_creator_close:
                        await STORE.delete(room_id)
                        _LOBBY_CACHE["ts"] = 0.0
                        await broadcast(room_id, {"type": "room_closed", "roomId": room_id}, cid)
                    else:
                        if has_humans and (cid == room.get("creatorCid") or cid == prev_h):
                            room["host_transferred"] = True
                        if cur_p and cur_p.get("transport") != "bot":
                            left_name_ws = cur_p.get("name", "Misafir")
                            if not any(hp.get("transport") != "bot" and hp.get("name") == left_name_ws for hp in (room.get("participants") or {}).values()):
                                leave_m_ws = sys_msg(room, "odadan ayrıldı", left_name_ws)
                                await broadcast(room_id, {"type": "chat", "message": leave_m_ws}, cid)
                        if not has_humans:
                            _freeze_empty_room_playback(room, t_disc)
                            if room.get("curated"):
                                room["chat"] = []
                                room["polls"] = []
                        ensure_host(room)
                        room["lastActiveAt"] = t_disc
                        room["rev"] = int(room.get("rev") or 1) + 1
                        _LOBBY_CACHE["ts"] = 0.0
                        if SOCKETS.get(room_id):
                            _mark_new_local_events_delivered(room, pre_ev_ids_lv)
                            _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
                        await STORE.put(room, force_disk=True)
                        await broadcast(room_id, _room_event(room))
                else:
                    if cur_p:
                        cur_p["transport"] = "http"
                        cur_p["lastSeen"] = min(float(cur_p.get("lastSeen") or 0.0), t_disc - (HTTP_PARTICIPANT_TTL - 20.0))
                    ensure_host(room)
                    room["lastActiveAt"] = t_disc
                    if room.get("host_id") != prev_h:
                        room["rev"] = int(room.get("rev") or 1) + 1
                        if SOCKETS.get(room_id):
                            _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
                    await STORE.put(room, force_disk=True)
                    if room.get("host_id") != prev_h:
                        await broadcast(room_id, _room_event(room))


_LOBBY_CACHE: Dict[str, Any] = {"ts": 0.0, "data": None}
_LOBBY_LOCK = asyncio.Lock()


async def http_sync(request: Request):
    room_id = (request.path_params.get("room_id") or "").lower()
    if not valid_room_id(room_id):
        return JSONResponse({"error": "Geçersiz oda"}, status_code=400)
    try:
        data = await request.json() if request.method == "POST" else dict(request.query_params)
    except Exception:
        data = {}
    if not isinstance(data, dict):
        return JSONResponse({"error": "Geçersiz istek"}, status_code=400)
    data = {k: v for k, v in data.items() if not str(k).startswith("_")}
    requested_cid = re.sub(r"[^a-zA-Z0-9_]", "", str(data.get("clientId") or ""))[:24]
    signed_cid = verify_client_token(room_id, data.get("clientToken"))
    verified_uid = str(request.scope.get("wl_uid") or "")
    try:
        since_rev = int(data.get("sinceRev") or 0)
    except (TypeError, ValueError):
        since_rev = 0
    out: Dict[str, Any] = {}
    need_remote_lock = bool(
        data.get("type") not in (None, "", "poll", "ping")
        or data.get("activeMedia")
        or data.get("recentChat")
        or not signed_cid
    )
    async with STORE.lock(room_id, remote=need_remote_lock):
        is_curated_id = any(s["id"] == room_id for s in CURATED_LIVE_SPECS)
        is_action = data.get("type") not in (None, "", "poll", "init", "ping")
        room = await STORE.get(room_id, force_fresh=bool(is_action or data.get("type") in ("init", "leave", "close_room")))
        if room is None and not is_curated_id and room_id in _CLOSED_ROOMS and (now() - float(_CLOSED_ROOMS.get(room_id) or 0.0) < 7200.0):
            if data.get("type") in ("leave", "close_room"):
                return JSONResponse({"ok": True, "roomClosed": True})
            graceful_http = bool(data.get("gracefulClose") or request.headers.get("x-watchlivo-transport") == "http-poll")
            return JSONResponse({"ok": True, "roomClosed": True, "error": "room_closed"}, status_code=200 if graceful_http else 410)
        pre_merge_host = room.get("host_id") if room else None
        pre_merge_seen = float((room.get("participants") or {}).get(signed_cid or requested_cid, {}).get("lastSeen") or 0.0) if room else 0.0
        if room is None and data.get("syncToken"):
            room = merge_sync_token(room, data.get("syncToken"), room_id)
        # A cid is only trusted when the server signed it, or when nobody is
        # currently using it (prevents session takeover by claiming a live cid).
        if room is not None and not room.get("fromCreateApi") and not room.get("curated") and requested_cid and requested_cid == room.get("creatorCid") and not str(room.get("creatorId") or "").startswith("u_wl_"):
            room["explicitCreatorCid"] = requested_cid
        cid = signed_cid or requested_cid
        cid_rejected = False
        if not signed_cid and cid and room is not None and _cid_is_active(room, cid, verified_uid, {**data, "uid": verified_uid}):
            cid = ""
            cid_rejected = True
        if not cid:
            cid = "h_" + uuid.uuid4().hex[:8]
        if data.get("type") in ("leave", "close_room"):
            if cid_rejected and not verified_uid:
                return JSONResponse({"ok": False, "error": "Yetkisiz oda işlemi"}, status_code=403)
            prev_h = room.get("host_id") if room else None
            cand_p = (room.get("participants") or {}).get(cid) if room else None
            is_explicit_creator_match = bool(
                not cid_rejected
                and room
                and room.get("explicitCreatorCid")
                and cid == room.get("explicitCreatorCid")
                and not str(room.get("creatorId") or "").startswith("u_wl_")
                and cand_p
                and cand_p.get("transport") != "ws"
                and clean_str(data.get("username"), 24) == cand_p.get("name")
            )
            owns_cid = bool(
                signed_cid == cid
                or is_explicit_creator_match
                or (verified_uid and cand_p and cand_p.get("uid") == verified_uid)
                or (not cid_rejected and cand_p and not cand_p.get("uid") and data.get("type") == "leave" and cand_p.get("name") == clean_str(data.get("username"), 24))
            )
            left_p = room["participants"].pop(cid, None) if (room and owns_cid) else None
            if room and not left_p and verified_uid:
                for k_p, v_p in list((room.get("participants") or {}).items()):
                    if v_p.get("transport") == "bot":
                        continue
                    if v_p.get("uid") == verified_uid:
                        cid = k_p
                        owns_cid = True
                        left_p = room["participants"].pop(k_p, None)
                        room.setdefault("left", {})[k_p] = now()
            if room and (owns_cid or not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())):
                if owns_cid:
                    room.setdefault("left", {})[cid] = now()
                is_creator_close = bool(
                    owns_cid
                    and (signed_cid == cid or is_explicit_creator_match or (verified_uid and verified_uid == room.get("creatorId")))
                    and data.get("type") == "close_room"
                    and not room.get("curated")
                    and (
                        cid == room.get("creatorCid")
                        or _is_creator_of_room(room, cid, left_p, {**data, "uid": verified_uid})
                        or cid == prev_h
                    )
                )
                has_humans = any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
                if not room.get("curated") and is_creator_close:
                    await STORE.delete(room_id)
                    _LOBBY_CACHE["ts"] = 0.0
                    await broadcast(room_id, {"type": "room_closed", "roomId": room_id}, cid)
                    return JSONResponse({"ok": True, "roomClosed": True})
                if has_humans and (cid == room.get("creatorCid") or cid == prev_h):
                    room["host_transferred"] = True
                t_leave = now()
                if not has_humans:
                    _freeze_empty_room_playback(room, t_leave)
                    if room.get("curated"):
                        room["chat"] = []
                        room["polls"] = []
                if left_p:
                    pre_ev_ids_hlv = _snapshot_room_event_ids(room)
                    if left_p.get("transport") != "bot":
                        left_name = left_p.get("name", "Misafir")
                        still_here_http = any(hp.get("transport") != "bot" and hp.get("name") == left_name for hp in (room.get("participants") or {}).values())
                        if not still_here_http:
                            leave_msg = sys_msg(room, "odadan ayrıldı", left_name)
                            await broadcast(room_id, {"type": "chat", "message": leave_msg}, cid)
                    ensure_host(room)
                    room["lastActiveAt"] = t_leave
                    room["rev"] = int(room.get("rev") or 1) + 1
                    _LOBBY_CACHE["ts"] = 0.0
                    if SOCKETS.get(room_id):
                        _mark_new_local_events_delivered(room, pre_ev_ids_hlv)
                        _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
                    await STORE.put(room, force_disk=True)
                    await broadcast(room_id, _room_event(room, "user_left", by=left_p.get("name", "")), cid)
                elif not has_humans:
                    ensure_host(room)
                    room["lastActiveAt"] = t_leave
                    room["rev"] = int(room.get("rev") or 1) + 1
                    _LOBBY_CACHE["ts"] = 0.0
                    if SOCKETS.get(room_id):
                        _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
                    await STORE.put(room, force_disk=True)
            return JSONResponse({"ok": True})
        room = room or await ensure_curated_room(room_id) or new_room(room_id, creator=data.get("username", ""), creator_id=verified_uid)
        if not room.get("creatorId") and not room.get("curated") and not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values()):
            room["creatorId"] = verified_uid or cid
            room["creatorCid"] = cid
        if not room.get("fromCreateApi") and not room.get("curated") and requested_cid and requested_cid == room.get("creatorCid") and not str(room.get("creatorId") or "").startswith("u_wl_"):
            room["explicitCreatorCid"] = requested_cid
        safe_http_uid = _safe_participant_uid(verified_uid, data.get("uid") or data.get("userId"))
        room.setdefault("kicked", [])
        if (
            cid in room["kicked"]
            or (verified_uid and f"uid:{verified_uid}" in room["kicked"])
            or (safe_http_uid and f"uid:{safe_http_uid}" in room["kicked"])
        ):
            return JSONResponse({"error": "kicked"}, status_code=410)
        existing_p = (room.get("participants") or {}).get(cid)
        pw_trusted_member = bool(existing_p and ((signed_cid and signed_cid == cid) or existing_p.get("_precreated")))
        if has_password(room) and not pw_trusted_member:
            http_rl_key = f"http:{room_id}:{client_ip(request)}"
            allowed, retry_after = _JOIN_LIMITER.peek(http_rl_key)
            if not allowed:
                return JSONResponse({"error": "rate_limited", "retryAfter": int(retry_after)}, status_code=429)
            if not verify_room_password(room, data.get("pwd", "")):
                if str(data.get("pwd") or "").strip():
                    allowed_hit, retry_hit = _JOIN_LIMITER.hit(http_rl_key)
                    if not allowed_hit:
                        return JSONResponse({"error": "rate_limited", "retryAfter": int(retry_hit)}, status_code=429)
                return JSONResponse({"error": "password_required"}, status_code=403)
        if existing_p and existing_p.get("_precreated"):
            existing_p.pop("_precreated", None)
        if data.get("syncToken"):
            room = merge_sync_token(room, data.get("syncToken"), room_id)
        pre_ev_ids_http = _snapshot_room_event_ids(room)
        prev_host = pre_merge_host if pre_merge_host is not None else room.get("host_id")
        prev_seen = pre_merge_seen or float((room.get("participants") or {}).get(cid, {}).get("lastSeen") or 0.0)
        pruned = prune(room)
        was_empty_humans = not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
        empty_elapsed = (now() - float(room.get("emptySince") or 0.0)) if room.get("emptySince") else 0.0
        stale_empty_wipe = False
        if was_empty_humans and (room.get("curated") or empty_elapsed > 3600.0):
            stale_empty_wipe = True
            if room.get("curated"):
                room["_explicit_chat_clear"] = True
            room["chat"] = []
            room["polls"] = []
            if room.get("media") and not data.get("syncToken"):
                room["media"]["currentTime"] = 0.0
                room["media"]["updatedAt"] = now()
                room["media"]["playing"] = True
                room["media"].pop("_frozenByEmpty", None)
            if room.get("curated"):
                spec = next((s for s in CURATED_LIVE_SPECS if s["id"] == room_id), None)
                if spec:
                    room["creator"] = spec.get("creator", "Watchlivo 7/24")
                    if "kinox_bot" in room.get("participants", {}):
                        room["participants"]["kinox_bot"]["name"] = room["creator"]
                    if (room.get("media") or {}).get("url") != spec["media"]["url"]:
                        set_media(room, spec["media"], room["creator"], start=0.0)
        elif was_empty_humans and not room.get("curated") and isinstance(room.get("media"), dict) and (room["media"].get("url") or room["media"].get("videoId")):
            room["media"]["updatedAt"] = now()
            if room["media"].pop("_frozenByEmpty", False) or not float(room["media"].get("lastExplicitPauseAt") or 0.0):
                room["media"]["playing"] = True
        room.pop("emptySince", None)
        caller_can_seed_chat = bool(
            (signed_cid == cid or was_empty_humans)
            and (
                cid == room.get("host_id")
                or cid == room.get("creatorCid")
                or _is_creator_of_room(room, cid, existing_p, {**data, "uid": safe_http_uid})
            )
        )
        restored_recent_chat = _merge_recent_chat(room, data.get("recentChat"), now(), caller_can_seed=caller_can_seed_chat)
        if stale_empty_wipe and not restored_recent_chat:
            room["_explicit_chat_clear"] = True
        p, is_new = add_participant(room, cid, {**data, "uid": safe_http_uid, "_verifiedClientToken": bool(signed_cid and signed_cid == cid)}, "http")
        join_msg_http = None
        join_ev_http = None
        if is_new:
            join_msg_http = sys_msg(room, "odaya katıldı", p["name"])
            t_ev = now()
            join_map = room.setdefault("_lastHttpJoinMap", {})
            if len(join_map) > 60:
                join_map.clear()
            if t_ev - float(join_map.get(cid) or 0.0) > 0.3:
                join_map[cid] = t_ev
                join_ev_http = {
                    "id": "uj_" + uuid.uuid4().hex[:10],
                    "ts": t_ev,
                    "type": "user_joined",
                    "user": {"id": cid, "name": p["name"], "uid": p.get("uid", "")},
                    "cid": cid,
                }
                room["events"] = (room.get("events") or [])[-34:] + [join_ev_http]
        active_m = data.get("activeMedia")
        restored_active_media = False
        if data.get("type") not in ("resolve_media", "change_media") and not room.get("curated") and isinstance(active_m, dict) and (active_m.get("url") or active_m.get("videoId")):
            room_empty_media = not room["media"].get("url") and not room["media"].get("videoId")
            caller_is_leader = bool(
                cid == room.get("host_id")
                or cid in (room.get("co_hosts") or [])
                or _is_creator_of_room(room, cid, p, data)
            )
            incoming_clean = clean_media(active_m)
            cur_unresolved = str(room["media"].get("url") or "").startswith("/api/rave/resolve-catalog")
            inc_resolved = bool(incoming_clean.get("url") and not str(incoming_clean.get("url")).startswith("/api/rave/resolve-catalog"))
            should_sync_active = (room_empty_media and (caller_is_leader or room.get("playMode") in ("cohost", "quickplay"))) or (cur_unresolved and inc_resolved and media_key(room["media"]) == media_key(incoming_clean))
            if should_sync_active:
                if cur_unresolved and inc_resolved and not room_empty_media and media_key(room["media"]) == media_key(incoming_clean):
                    t_sync_now = now()
                    was_anc = bool(room["media"].get("playbackAnchored") or float(room["media"].get("currentTime") or 0.0) > 0.5)
                    cur_ct_val = float(room["media"].get("currentTime") or 0.0)
                    cur_el = max(0.0, t_sync_now - float(room["media"].get("updatedAt") or t_sync_now)) * float(room["media"].get("rate") or 1.0) if (room["media"].get("playing") and was_anc) else 0.0
                    cur_live_val = max(0.0, cur_ct_val + cur_el)
                    for k in ("provider", "catalogProvider", "streamType", "url", "altUrls", "servers", "subtitleTracks", "audioTracks", "intro", "duration", "mediaType", "season", "episode", "tmdbId", "imdbId", "seriesTitle", "originalTitle", "videoId", "clipVideoId", "embedUrl", "mvUrl", "audioPreviewUrl", "bgVideoUrl", "bgYoutubeId", "poster", "thumbnail", "artist", "songTitle", "musicMode", "musicPlatformLabel", "similar"):
                        if incoming_clean.get(k):
                            room["media"][k] = incoming_clean[k]
                    if was_anc or cur_live_val > 2.0:
                        room["media"]["currentTime"] = cur_live_val
                        room["media"]["updatedAt"] = t_sync_now
                    else:
                        room["media"]["currentTime"] = 0.0
                        room["media"]["updatedAt"] = t_sync_now
                    room["media"]["playbackAnchored"] = True
                    room["rev"] = int(room.get("rev") or 1) + 1
                    room["_tok_sig"] = ""
                    restored_active_media = True
                else:
                    try:
                        am_pos = max(0.0, float(active_m.get("currentTime") or active_m.get("meshStatePosition") or 0.0))
                    except (TypeError, ValueError):
                        am_pos = 0.0
                    set_media(room, active_m, p["name"], am_pos)
                    room["rev"] = int(room.get("rev") or 1) + 5
                    restored_active_media = True
        voted = check_vote_end(room)
        mutated = restored_recent_chat or restored_active_media or voted or bool(pruned) or (room.get("host_id") != prev_host) or is_new
        if is_action:
            out = handle_action(room, cid, data)
            mutated = True
            if out.get("close_room") or room.get("_close_room_now"):
                await STORE.delete(room_id)
                _LOBBY_CACHE["ts"] = 0.0
                await broadcast(room_id, {"type": "room_closed", "roomId": room_id}, cid)
                return JSONResponse({"ok": True, "roomClosed": True})
            if out.get("kick") and out["kick"] not in room["kicked"]:
                room["kicked"] = (room["kicked"] + [out["kick"]])[-50:]
        elif voted and SOCKETS.get(room_id):
            out = {"broadcast": [(_room_event(room, "media_changed", by="vote"), None)]}
        elif is_new and SOCKETS.get(room_id):
            bcast_list = []
            if join_ev_http:
                bcast_list.append(({**join_ev_http, "room": serialize(room)}, cid))
            elif now() - float(room.get("_lastWsJoinBcast") or 0.0) > 1.0:
                room["_lastWsJoinBcast"] = now()
                bcast_list.append((_room_event(room), cid))
            if join_msg_http:
                bcast_list.append(({"type": "chat", "message": join_msg_http}, cid))
            if bcast_list:
                out = {"broadcast": bcast_list}
        if mutated and not is_action:
            room["rev"] = int(room.get("rev") or 1) + 1
        t_cur = now()
        if mutated or is_new or (t_cur - prev_seen > 15.0):
            if SOCKETS.get(room_id):
                if out:
                    _mark_new_local_events_delivered(room, pre_ev_ids_http)
                _LAST_FANOUT_REV[room_id] = int(room.get("rev") or 1)
            await STORE.put(room, force_disk=bool(mutated or is_new))
        cur_rev = int(room.get("rev") or 1)
        m = room["media"]
        server_media_url = str(m.get("url") or m.get("videoId") or "")
        client_media_url = str(data.get("mediaUrl") or "") if "mediaUrl" in data else server_media_url
        chat_list = room.get("chat") or []
        server_chat_cnt = len(chat_list)
        client_chat_cnt = int(data.get("chatCount")) if isinstance(data.get("chatCount"), int) else server_chat_cnt
        server_last_chat_id = str(chat_list[-1].get("id") or "") if chat_list else ""
        client_last_chat_id = str(data.get("lastChatId") or "") if "lastChatId" in data else server_last_chat_id
        server_part_cnt = sum(1 for p in room["participants"].values() if p.get("transport") != "bot")
        client_part_cnt = int(data.get("participantCount")) if isinstance(data.get("participantCount"), int) else server_part_cnt
        if (
            not is_action and not mutated and not is_new and since_rev > 0 and since_rev == cur_rev
            and client_media_url == server_media_url
            and client_chat_cnt == server_chat_cnt
            and client_last_chat_id == server_last_chat_id
            and client_part_cnt == server_part_cnt
        ):
            elapsed_w = max(0.0, t_cur - float(m.get("updatedAt") or t_cur))
            recent_ev = [e for e in (room.get("events") or []) if t_cur - float(e.get("ts") or 0) < 6.0][-15:]
            recent_sig = [s for s in (room.get("signals") or []) if s.get("targetId") == cid and t_cur - float(s.get("ts") or 0) < 12.0][-25:]
            ser_Quick = serialize(room, for_cid=cid)
            return JSONResponse({
                "ok": True, "unchanged": True, "clientId": cid, "clientToken": sign_client_token(room_id, cid), "rev": cur_rev, "serverTime": t_cur,
                "participantCount": ser_Quick["participantCount"],
                "participants": ser_Quick["participants"],
                "polls": ser_Quick["polls"],
                "chat": [],
                "privacy": room.get("privacy", "public"),
                "playMode": room.get("playMode", "leader"),
                "voipMode": room.get("voipMode", "all"),
                "name": _effective_room_name(room),
                "host_id": room.get("host_id"),
                "media": ser_Quick["media"],
                "syncToken": pack_sync_token(room),
                "events": recent_ev, "signals": recent_sig, "errors": [],
            })
    if out:
        await deliver(room_id, out)
    return JSONResponse({"ok": True, "clientId": cid, "clientToken": sign_client_token(room_id, cid), "room": serialize(room, for_cid=cid), "serverTime": now(),
                         "errors": [m.get("message") for m in out.get("reply", []) if m.get("type") == "error"]})


async def create_room(request: Request):
    allowed_rl, retry_rl = _CREATE_ROOM_LIMIT.hit(client_ip(request))
    if not allowed_rl:
        return JSONResponse({"ok": False, "error": "Çok fazla oda oluşturma isteği", "retryAfter": int(retry_rl)}, status_code=429)
    raw_body = await request.body()
    if raw_body and raw_body.strip():
        try:
            payload = json.loads(raw_body)
        except Exception:
            return JSONResponse({"ok": False, "error": "Geçersiz JSON gövdesi"}, status_code=400)
        if not isinstance(payload, dict):
            return JSONResponse({"ok": False, "error": "Geçersiz istek biçimi"}, status_code=400)
    else:
        payload = {}
    name = clean_str(payload.get("name"), 45) or "Watchlivo Odası"
    slug = re.sub(r"[^a-z0-9\-]", "", name.lower().replace(" ", "-").replace("ı", "i").replace("ş", "s").replace("ğ", "g").replace("ü", "u").replace("ö", "o").replace("ç", "c"))[:24].strip("-") or "oda"
    room_id = f"{slug}-{uuid.uuid4().hex[:5]}"
    _CLOSED_ROOMS.pop(room_id, None)
    req_cid = re.sub(r"[^a-zA-Z0-9_]", "", str(payload.get("clientId") or ""))[:24]
    creator_cid = req_cid or ("h_" + uuid.uuid4().hex[:8])
    verified_uid = str(request.scope.get("wl_uid") or "")
    raw_creator_id = clean_str(payload.get("creatorId"), 40)
    if not verified_uid and raw_creator_id.lower().startswith("u_wl_"):
        raw_creator_id = ""
    creator_uid = verified_uid or raw_creator_id or creator_cid
    if verified_uid or req_cid:
        try:
            all_existing = await STORE.all()
            stale_creator_rooms = []
            for cand in all_existing:
                if not isinstance(cand, dict) or cand.get("curated"):
                    continue
                cand_has_live_human = any(
                    hp.get("transport") != "bot" and (now() - float(hp.get("lastSeen") or 0.0) < 45.0)
                    for hp in (cand.get("participants") or {}).values()
                )
                cand_other_humans = any(
                    hp.get("transport") != "bot"
                    and not hp.get("_precreated")
                    and hp_cid != req_cid
                    and (not verified_uid or hp.get("uid") != verified_uid)
                    and (now() - float(hp.get("lastSeen") or 0.0) < 90.0)
                    for hp_cid, hp in (cand.get("participants") or {}).items()
                )
                cand_owned_by_verified = bool(
                    verified_uid
                    and verified_uid.startswith("u_wl_")
                    and cand.get("creatorId") == verified_uid
                    and not cand_other_humans
                    and not cand.get("host_transferred")
                )
                cand_stale_guest_match = bool(
                    not cand_has_live_human
                    and not cand_other_humans
                    and not has_password(cand)
                    and not str(cand.get("creatorId") or "").startswith("u_wl_")
                    and req_cid
                    and cand.get("creatorCid") == req_cid
                )
                if (cand_owned_by_verified or cand_stale_guest_match) and cand.get("id"):
                    stale_creator_rooms.append(cand.get("id"))
            for old_rid in stale_creator_rooms:
                if old_rid and old_rid != room_id:
                    await STORE.delete(old_rid, mark_closed=bool(verified_uid))
                    await broadcast(old_rid, {"type": "room_closed", "roomId": old_rid})
            if stale_creator_rooms:
                _LOBBY_CACHE["ts"] = 0.0
        except Exception:
            pass
    room = new_room(room_id, name, payload.get("privacy", "public"), payload.get("playMode", "leader"),
                    payload.get("creator", ""), creator_uid, payload.get("password", ""), bool(payload.get("isMature")))
    room["creatorCid"] = creator_cid
    room["fromCreateApi"] = True
    room["explicitCreatorCid"] = req_cid
    add_participant(
        room,
        creator_cid,
        {
            "username": payload.get("creator") or "Lider",
            "color": payload.get("color") or "#27DCC8",
            "device": payload.get("device") or "Web",
            "country": "XX" if _as_bool(payload.get("hideLocation")) else (payload.get("country") or "TR"),
            "hideLocation": _as_bool(payload.get("hideLocation")),
            "avatarUrl": payload.get("avatarUrl") or "",
            "handle": clean_str(payload.get("handle"), 24),
            "bio": clean_str(payload.get("bio"), 160),
            "statusText": clean_str(payload.get("statusText"), 60),
            "statusEmoji": clean_str(payload.get("statusEmoji"), 12),
            "hideWatching": _as_bool(payload.get("hideWatching")),
            "hideFriends": _as_bool(payload.get("hideFriends")),
            "medal": payload.get("medal") or "",
            "watchMinutes": payload.get("watchMinutes") or 0,
            "uid": _safe_participant_uid(verified_uid, payload.get("creatorId") or payload.get("uid")),
            "_internalCreator": True,
            "_precreated": True,
        },
        "http",
    )
    room["host_id"] = creator_cid
    room["creatorCid"] = creator_cid
    room["chat"] = []
    creator_label = room["creator"] or payload.get("creator") or "Lider"
    sys_msg(room, "odaya katıldı", creator_label)
    media = payload.get("media")
    if isinstance(media, dict) and (media.get("url") or media.get("videoId")):
        try:
            init_start = max(0.0, float(media.get("currentTime") or media.get("meshStatePosition") or 0.0))
        except (TypeError, ValueError):
            init_start = 0.0
        set_media(room, media, creator_label, start=init_start)
        room["media"]["playing"] = True
        if room["media"].get("title"):
            sys_msg(room, f"Şu an oynatılıyor: {room['media']['title']}", creator_label)
    async with STORE.lock(room_id):
        await STORE.put(room, force_disk=True)
    _LOBBY_CACHE["ts"] = 0.0
    client_token = sign_client_token(room_id, creator_cid)
    return JSONResponse({"ok": True, "clientId": creator_cid, "clientToken": client_token, "room": serialize(room, for_cid=creator_cid)})


def _is_friend_of_creator(room: Dict[str, Any], caller_uid: str) -> bool:
    c_uid = str(room.get("creatorId") or room.get("creator_cid") or "").strip()
    if not c_uid or not caller_uid:
        return False
    if caller_uid.lower() == c_uid.lower():
        return True
    for p in (room.get("participants") or {}).values():
        if isinstance(p, dict) and str(p.get("uid") or "").lower() == caller_uid.lower():
            return True
    try:
        import social_engine
        su = social_engine._SOCIAL_USERS.get(c_uid) or social_engine._SOCIAL_USERS.get(c_uid.lower()) or social_engine._kv_get(f"wl:soc:u:{c_uid}", None, max_age=30.0)
        if isinstance(su, dict):
            for f in (su.get("friends") or []):
                f_uid = str(f.get("uid") if isinstance(f, dict) else f or "").strip()
                if f_uid.lower() == caller_uid.lower():
                    return True
    except Exception:
        pass
    return False


def _render_lobby_for_caller(request: Request, raw_rooms: List[Dict[str, Any]]) -> JSONResponse:
    caller_uid = str(request.scope.get("wl_uid") or "").strip()
    filtered = [r for r in raw_rooms if r.get("privacy") != "friends" or _is_friend_of_creator(r, caller_uid)]
    visible = [lobby_entry(r) for r in filtered[:60]]
    return JSONResponse(
        {"rooms": visible, "shared": STORE.shared},
        headers={
            "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
            "CDN-Cache-Control": "no-store",
            "Vary": "Authorization",
        },
    )


async def list_rooms(request: Request):
    t = now()
    if _LOBBY_CACHE.get("raw_rooms") is not None and t - float(_LOBBY_CACHE["ts"] or 0.0) < 0.6:
        return _render_lobby_for_caller(request, _LOBBY_CACHE["raw_rooms"])
    async with _LOBBY_LOCK:
        t = now()
        if _LOBBY_CACHE.get("raw_rooms") is not None and t - float(_LOBBY_CACHE["ts"] or 0.0) < 0.6:
            return _render_lobby_for_caller(request, _LOBBY_CACHE["raw_rooms"])
        all_rooms = await STORE.all()
        existing_ids = {r.get("id") for r in all_rooms if isinstance(r, dict)}
        for spec in CURATED_LIVE_SPECS:
            if spec["id"] not in existing_ids:
                cr = _build_curated_room(spec)
                await STORE.put(cr)
                all_rooms.append(cr)
        candidates = []
        valid_curated = {s["id"] for s in CURATED_LIVE_SPECS}
        for room in all_rooms:
            rid_item = room.get("id")
            if room.get("curated") and rid_item not in valid_curated:
                await STORE.delete(rid_item)
                continue
            if not room.get("curated") and rid_item in _CLOSED_ROOMS and (t - float(_CLOSED_ROOMS.get(rid_item) or 0.0) < 7200.0):
                continue
            removed = prune(room)
            p_map = room.get("participants") or {}
            has_humans = any(hp.get("transport") != "bot" for hp in p_map.values())
            needs_save = bool(removed)
            if room.get("curated"):
                spec = next((s for s in CURATED_LIVE_SPECS if s["id"] == rid_item), None)
                if spec and str(room.get("creator") or "").startswith("KINOX"):
                    room["creator"] = spec.get("creator", "Watchlivo 7/24")
                    if "kinox_bot" in p_map:
                        p_map["kinox_bot"]["name"] = room["creator"]
                    needs_save = True
                if spec and (room.get("media") or {}).get("url") != spec["media"]["url"]:
                    set_media(room, spec["media"], spec.get("creator", "Watchlivo 7/24"), start=0.0)
                    needs_save = True
                if not has_humans and (room.get("chat") or float((room.get("media") or {}).get("currentTime") or 0.0) > 0.0):
                    room["chat"] = []
                    room["polls"] = []
                    if spec:
                        set_media(room, spec["media"], spec.get("creator", "Watchlivo 7/24"), start=0.0)
                    elif room.get("media"):
                        room["media"]["currentTime"] = 0.0
                        room["media"]["updatedAt"] = t
                    needs_save = True
            if needs_save:
                async with STORE.lock(rid_item):
                    fresh_r = await STORE.get(rid_item, force_fresh=True) if room.get("curated") else None
                    if isinstance(fresh_r, dict) and any(hp.get("transport") != "bot" for hp in (fresh_r.get("participants") or {}).values()):
                        room = fresh_r
                        p_map = room.get("participants") or {}
                        has_humans = True
                    else:
                        await STORE.put(room, force_disk=True)
            p_cnt = len(p_map)
            if (not p_cnt or not has_humans) and not room.get("curated"):
                idle_sec = t - float(room.get("lastActiveAt") or room.get("createdAt") or 0.0)
                if idle_sec > EMPTY_ROOM_TTL:
                    await STORE.delete(rid_item, mark_closed=False)
                continue
            if room.get("privacy", "public") == "private" or not p_cnt:
                continue
            candidates.append(room)
        # Deduplicate non-curated rooms only for verified accounts whose older room has no active viewers
        by_creator_id: Dict[str, Dict[str, Any]] = {}
        deduped_candidates = []
        for r in sorted(candidates, key=lambda x: float(x.get("lastActiveAt") or x.get("createdAt") or 0.0), reverse=True):
            if r.get("curated"):
                deduped_candidates.append(r)
                continue
            c_id_key = str(r.get("creatorId") or "").strip()
            r_has_live = any(hp.get("transport") != "bot" and (t - float(hp.get("lastSeen") or 0.0) < 30.0) for hp in (r.get("participants") or {}).values())
            id_collision = bool(c_id_key.startswith("u_wl_") and c_id_key in by_creator_id and not r_has_live and not r.get("host_transferred"))
            if id_collision:
                await STORE.delete(r["id"], mark_closed=False)
                continue
            if c_id_key.startswith("u_wl_"):
                by_creator_id[c_id_key] = r
            deduped_candidates.append(r)
        candidates = deduped_candidates
        candidates.sort(key=lambda r: (0 if not r.get("curated") else 1, -sum(1 for hp in (r.get("participants") or {}).values() if hp.get("transport") != "bot"), CURATED_ORDER.get(r.get("id", ""), 999), r.get("id", "")))
        _LOBBY_CACHE["ts"] = t
        _LOBBY_CACHE["raw_rooms"] = candidates[:70]
        _LOBBY_CACHE["data"] = None
    return _render_lobby_for_caller(request, _LOBBY_CACHE.get("raw_rooms") or [])


async def room_info(request: Request):
    room_id = (request.path_params.get("room_id") or "").lower()
    if room_id in _CLOSED_ROOMS and (now() - float(_CLOSED_ROOMS.get(room_id) or 0.0) < 7200.0):
        return JSONResponse({"error": "Bu oda artık mevcut değil", "roomClosed": True}, status_code=410)
    room = (await STORE.get(room_id) or await ensure_curated_room(room_id)) if valid_room_id(room_id) else None
    if not room:
        return JSONResponse({"error": "Bu oda artık mevcut değil"}, status_code=404)
    caller_uid = str(request.scope.get("wl_uid") or "").strip()
    signed_cid = verify_client_token(room_id, request.query_params.get("clientToken"))
    priv = str(room.get("privacy") or "public")
    should_mask = False
    if priv == "private":
        is_member = bool(
            (signed_cid and signed_cid in (room.get("participants") or {}))
            or (caller_uid and (caller_uid == str(room.get("creatorId") or "") or any(str(hp.get("uid") or "") == caller_uid for hp in (room.get("participants") or {}).values())))
        )
        should_mask = not is_member
    elif priv == "friends":
        should_mask = not bool(
            (signed_cid and signed_cid in (room.get("participants") or {}))
            or _is_friend_of_creator(room, caller_uid)
        )
    return JSONResponse(
        {"room": lobby_entry(room, mask_private=should_mask)},
        headers={"Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0"},
    )
