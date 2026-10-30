"""VORTEX mesh (room) engine — Rave mesh parity.

One action handler serves both transports (WebSocket push + HTTP polling). Room state is a plain
JSON-serializable dict so it can live in memory (local/dev) or in a shared store (serverless).
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
import urllib.request
import zlib
from typing import Any, Dict, List, Optional, Tuple

from security import RateLimiter, client_ip, constant_time_eq, server_secret

# No hard-coded fallback: without VORTEX_SECRET the process gets an unguessable
# per-instance secret (or refuses to boot when WATCHLIVO_STRICT_SECRETS=1).
SYNC_SECRET = server_secret("VORTEX_SECRET")

VALID_PRIVACY = ("public", "nearby", "friends", "private")
VALID_PLAY_MODES = ("leader", "cohost", "autoplay", "quickplay", "vote")
VALID_VOIP = ("off", "leader", "all")
HTTP_PARTICIPANT_TTL = 120.0
EMPTY_ROOM_TTL = 7200.0
VOTE_WINDOW = 8.0
MAX_CHAT = 80
MEDIA_FIELDS = ("provider", "videoId", "url", "title", "thumbnail", "channel", "duration")

# Only these keys may ever be applied from a client-supplied sync snapshot.
SAFE_MERGE_KEYS = (
    "name", "privacy", "playMode", "voipMode", "queue", "skip_votes",
    "voteEndsAt", "endedKey", "rev", "polls", "curated",
    "creatorId", "host_id", "co_hosts", "host_transferred",
)
SYNC_TOKEN_TTL = 86400.0
CLIENT_TOKEN_TTL = 86400.0
_JOIN_LIMITER = RateLimiter(12, 300.0, name="room_pwd")
_PWD_ITERATIONS = 120_000


def now() -> float:
    return time.time()


def clean_str(v: Any, limit: int) -> str:
    return str(v or "").strip()[:limit]


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
    sig = _b64_key(SYNC_SECRET, "cid", room_id, cid, str(iat // int(CLIENT_TOKEN_TTL)))
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
    expected = _b64_key(SYNC_SECRET, "cid", room_id, cid, str(iat // int(CLIENT_TOKEN_TTL)))
    return cid if constant_time_eq(expected, sig) else ""


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
        claims = auth_engine.verify_auth_token(token)
    except Exception:
        claims = None
    return str((claims or {}).get("uid") or "")


def _cid_is_active(room: Dict[str, Any], cid: str, verified_uid: str = "") -> bool:
    """True when ``cid`` is a live participant of ``room`` (prevents takeover)."""
    p = (room.get("participants") or {}).get(cid)
    if not isinstance(p, dict):
        return False
    if verified_uid and (p.get("uid") == verified_uid or room.get("creatorId") == verified_uid):
        return False
    try:
        return now() - float(p.get("lastSeen") or 0.0) < 30.0
    except (TypeError, ValueError):
        return False


def _media_defaults(room: Dict[str, Any]) -> Dict[str, Any]:
    """Guarantee a fully-formed media dict so downstream code cannot KeyError."""
    t = now()
    md = room.get("media")
    if not isinstance(md, dict):
        md = empty_media()
        room["media"] = md
    for key, fallback in (("playing", False), ("currentTime", 0.0), ("updatedAt", t), ("rate", 1.0), ("duration", 0.0)):
        try:
            value = float(md.get(key))
        except (TypeError, ValueError):
            value = fallback
        md[key] = bool(md.get(key)) if key == "playing" else max(0.0, value) if key != "rate" else value
    if md["rate"] <= 0 or md["rate"] > 8:
        md["rate"] = 1.0
    return md



def clean_media(data: Dict[str, Any]) -> Dict[str, Any]:
    url = clean_str(data.get("url"), 2000)
    if url and not re.match(r"^(https?://|/uploads/|/api/rave/)", url):
        url = ""
    thumb = clean_str(data.get("thumbnail"), 1000)
    if thumb and not thumb.startswith(("https://", "http://", "/")):
        thumb = ""
    try:
        duration = max(0.0, float(data.get("duration") or 0))
    except (TypeError, ValueError):
        duration = 0.0
    try:
        season = max(1, int(data.get("season") or 1))
    except (TypeError, ValueError):
        season = 1
    try:
        episode = max(1, int(data.get("episode") or 1))
    except (TypeError, ValueError):
        episode = 1
    alt_urls = [clean_str(u, 1500) for u in (data.get("altUrls") or []) if isinstance(u, str) and u.startswith(("https://", "/api/rave/"))][:6]
    servers = []
    for srv in (data.get("servers") or [])[:8]:
        if isinstance(srv, dict) and srv.get("url") and str(srv.get("url")).startswith(("https://", "/api/rave/")):
            servers.append({
                "id": clean_str(srv.get("id"), 24) or f"srv-{len(servers) + 1}",
                "label": clean_str(srv.get("label"), 80) or f"📡 Sunucu {len(servers) + 1}",
                "url": clean_str(srv.get("url"), 1500),
                "streamType": clean_str(srv.get("streamType"), 16) or "hls",
            })
    sub_tracks = []
    for st in (data.get("subtitleTracks") or [])[:12]:
        if isinstance(st, dict) and st.get("url"):
            su = str(st.get("url") or "")
            if "rapidvid.org/407eb1ed" in su or "1952401276" in su:
                continue
            sub_tracks.append({
                "id": clean_str(st.get("id"), 20),
                "lang": clean_str(st.get("lang"), 12),
                "label": clean_str(st.get("label"), 60),
                "url": clean_str(st.get("url"), 2000),
                "source": clean_str(st.get("source"), 24),
                "kind": "subtitles",
            })
    aud_tracks = []
    for at in (data.get("audioTracks") or [])[:6]:
        if isinstance(at, dict) and at.get("id"):
            aud_tracks.append({
                "id": clean_str(at.get("id"), 20),
                "lang": clean_str(at.get("lang"), 12),
                "targetLang": clean_str(at.get("targetLang") or at.get("lang"), 12),
                "audioLang": clean_str(at.get("audioLang") or at.get("lang"), 12),
                "label": clean_str(at.get("label"), 60),
                "mode": clean_str(at.get("mode"), 20) or "stream",
                "url": clean_str(at.get("url"), 1500),
            })
    raw_intro = data.get("intro")
    intro = None
    if isinstance(raw_intro, dict) and raw_intro.get("end"):
        try:
            i_start = max(0.0, float(raw_intro.get("start") or 0.0))
            i_end = max(0.0, float(raw_intro.get("end") or 0.0))
            if i_end > i_start + 3:
                intro = {"start": round(i_start, 1), "end": round(i_end, 1), "label": clean_str(raw_intro.get("label"), 40) or "⏩ İntroyu Atla"}
        except (TypeError, ValueError):
            intro = None
    return {
        "provider": re.sub(r"[^a-z0-9\-]", "", clean_str(data.get("provider"), 20).lower()) or "web",
        "catalogProvider": re.sub(r"[^a-z0-9\-]", "", clean_str(data.get("catalogProvider"), 20).lower()),
        "videoId": clean_str(data.get("videoId"), 200),
        "url": url,
        "embedUrl": clean_str(data.get("embedUrl"), 2000),
        "streamType": clean_str(data.get("streamType"), 16),
        "providerUrl": clean_str(data.get("providerUrl"), 2000),
        "officialUrl": clean_str(data.get("officialUrl"), 2000),
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
        "musicPlatformLabel": clean_str(data.get("musicPlatformLabel"), 120),
        "mvUrl": clean_str(data.get("mvUrl"), 1500),
        "artist": clean_str(data.get("artist"), 100),
        "songTitle": clean_str(data.get("songTitle"), 120),
        "poster": clean_str(data.get("poster"), 1000) or thumb,
        "audioPreviewUrl": clean_str(data.get("audioPreviewUrl"), 1500),
        "similar": [
            {
                "artist": clean_str(s.get("artist"), 80),
                "songTitle": clean_str(s.get("songTitle") or s.get("title"), 100),
                "title": clean_str(s.get("title") or s.get("songTitle"), 140),
                "poster": clean_str(s.get("poster") or s.get("thumbnail"), 600),
                "duration": max(90, int(float(s.get("duration") or 200))),
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
    }


def media_key(m: Dict[str, Any]) -> str:
    if not m:
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
    return f"{m.get('provider')}|{m.get('videoId') or ''}|{m.get('url') or ''}|{s}|{e}"


def empty_media() -> Dict[str, Any]:
    return {"provider": "", "videoId": "", "url": "", "title": "", "thumbnail": "", "channel": "", "duration": 0.0,
            "playing": False, "currentTime": 0.0, "rate": 1.0, "updatedAt": now(), "lastActionBy": ""}


def new_room(room_id: str, name: str = "", privacy: str = "public", play_mode: str = "leader",
             creator: str = "", creator_id: str = "", password: str = "") -> Dict[str, Any]:
    return {
        "id": room_id,
        "name": clean_str(name, 45) or "Watchlivo Odası",
        "privacy": privacy if privacy in VALID_PRIVACY else "public",
        "playMode": play_mode if play_mode in VALID_PLAY_MODES else "leader",
        "voipMode": "all",
        "passwordHash": hash_room_password(password),
        "creator": clean_str(creator, 24),
        "creatorId": clean_str(creator_id, 64),
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
    """Remove expired chat history while preserving active room conversation."""
    t = now()
    p_map = room.get("participants") or {}
    has_humans = any(p.get("transport") != "bot" for p in p_map.values())
    if not has_humans:
        empty_since = float(room.get("emptySince") or 0.0)
        if room.get("curated") or (empty_since > 0.0 and t - empty_since > 3600.0):
            room["chat"] = []
            room["polls"] = []
        return
    cleaned = []
    for m in (room.get("chat") or []):
        if not isinstance(m, dict):
            continue
        m_ts = float(m.get("ts") or 0.0)
        if m_ts <= 0.0:
            continue
        ttl = 7200.0
        if t - m_ts <= ttl:
            cleaned.append(m)
    room["chat"] = cleaned[-MAX_CHAT:]


def pack_sync_token(room: Dict[str, Any]) -> str:
    t = now()
    prune_chat(room)
    p_map = room.get("participants") or {}
    m_upd = float((room.get("media") or {}).get("updatedAt") or 0.0)
    tok_sig = f"{room.get('rev')}:{len(p_map)}:{m_upd:.2f}:{len(room.get('chat') or [])}:{room.get('privacy')}:{room.get('playMode')}:{room.get('voipMode')}:{room.get('name')}:{int(t // 4)}"
    if room.get("_tok_sig") == tok_sig and room.get("_tok_val"):
        return room["_tok_val"]
    host_id = room.get("host_id")
    co_set = set(room.get("co_hosts") or [])
    p_items = sorted(
        p_map.items(),
        key=lambda kv: (0 if kv[0] == host_id else (1 if kv[0] in co_set else (2 if not kv[1].get("muted", True) or kv[1].get("cam") else 3))),
    )[:24]
    snap = {k: room.get(k) for k in ("id", "name", "privacy", "playMode", "voipMode", "creator",
                                     "creatorId", "host_id", "co_hosts", "host_transferred",
                                     "createdAt", "lastActiveAt", "media", "queue", "skip_votes", "voteEndsAt",
                                     "endedKey", "kicked", "left", "rev", "curated")}
    # Secrets never leave the server: no password hash, no creator identity.
    snap["sigExp"] = t + SYNC_TOKEN_TTL
    snap["participants"] = dict(p_items)
    snap["chat"] = (room.get("chat") or [])[-25:]
    snap["polls"] = (room.get("polls") or [])[-10:]
    snap["events"] = [e for e in (room.get("events") or []) if t - float(e.get("ts") or 0) < 25.0][-25:]
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
        isinstance(sp, dict) and sp.get("transport") != "bot" and (t - float(sp.get("lastSeen") or 0) <= 120.0)
        for sp in (snap.get("participants") or {}).values()
    ) or bool(snap.get("creatorId") or snap.get("host_id"))
    if not snap_active_humans:
        return room
    if room is None:
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
        fresh["participants"] = {
            cid: sp for cid, sp in (snap.get("participants") or {}).items() if isinstance(sp, dict)
        }
        fresh["chat"] = [m for m in (snap.get("chat") or []) if isinstance(m, dict)][-MAX_CHAT:]
        fresh["polls"] = [p for p in (snap.get("polls") or []) if isinstance(p, dict)][-10:]
        fresh["events"] = [e for e in (snap.get("events") or []) if isinstance(e, dict)]
        fresh["signals"] = [s for s in (snap.get("signals") or []) if isinstance(s, dict)]
        # A cold instance restores from the signed snapshot, so the currently
        # playing media has to come with it (the token is HMAC-signed + expiring).
        snap_media = snap.get("media")
        if isinstance(snap_media, dict) and (snap_media.get("url") or snap_media.get("videoId")):
            md = dict(snap_media)
            if md.get("url") and not re.match(r"^(https?://|/uploads/|/api/rave/)", str(md["url"])):
                md["url"] = ""
            if md.get("thumbnail") and not str(md["thumbnail"]).startswith(("https://", "http://", "/")):
                md["thumbnail"] = ""
            fresh["media"] = _media_defaults({"media": md})
        fresh.setdefault("left", {})
        return fresh
    room_has_humans = any(p.get("transport") != "bot" for p in (room.get("participants") or {}).values())
    if not room_has_humans and room.get("curated"):
        return room
    kicked = set(room.get("kicked") or []) | set(snap.get("kicked") or [])
    left_map: Dict[str, float] = {}
    for src in (room.get("left") or {}, snap.get("left") or {}):
        if isinstance(src, dict):
            for lcid, lts in src.items():
                if t - float(lts or 0) < 45.0:
                    left_map[lcid] = max(left_map.get(lcid, 0.0), float(lts or 0))
    merged_p = dict(room.get("participants") or {})
    for cid, sp in (snap.get("participants") or {}).items():
        sp_seen = float(sp.get("lastSeen") or 0)
        if cid in kicked or (cid in left_map and left_map[cid] >= sp_seen):
            merged_p.pop(cid, None)
        elif sp.get("transport") != "bot" and t - sp_seen > 45.0:
            continue
        elif cid not in merged_p or sp_seen > float(merged_p[cid].get("lastSeen") or 0):
            merged_p[cid] = sp
    seen_c: Dict[str, Dict[str, Any]] = {}
    merged_c = []
    for m in (room.get("chat") or []) + (snap.get("chat") or []):
        if not isinstance(m, dict):
            continue
        m_ts = float(m.get("ts") or 0.0)
        if m_ts <= 0.0 or (t - m_ts > 7200.0):
            continue
        mid = m.get("id")
        if mid and mid not in seen_c:
            mc = dict(m)
            seen_c[mid] = mc
            merged_c.append(mc)
        elif mid and mid in seen_c and isinstance(m.get("reactions"), dict):
            existing_r = dict(seen_c[mid].get("reactions") or {})
            for em, ulist in m["reactions"].items():
                if isinstance(ulist, list):
                    merged_u = list(dict.fromkeys((existing_r.get(em) or []) + ulist))
                    if merged_u:
                        existing_r[em] = merged_u[:30]
            seen_c[mid]["reactions"] = existing_r
    seen_ev = set()
    merged_ev = []
    for ev in (room.get("events") or []) + (snap.get("events") or []):
        eid = ev.get("id")
        if eid and eid not in seen_ev and t - float(ev.get("ts") or 0) < 25.0:
            seen_ev.add(eid)
            merged_ev.append(ev)
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
    if (s_has_media and not r_has_media) or s_rev > r_rev or (s_rev == r_rev and s_ct < r_ct - 0.05):
        for k in SAFE_MERGE_KEYS:
            if k in snap:
                room[k] = snap[k]
    elif snap.get("creatorId") and not room.get("host_transferred"):
        if not room.get("creatorId") or s_ct < r_ct - 0.05:
            room["creatorId"] = snap["creatorId"]
            if snap.get("host_id"):
                room["host_id"] = snap["host_id"]
    if (s_has_media and not r_has_media) or (s_has_media and s_m_time > r_m_time + 0.01 and not (r_pos > 25.0 and s_pos < 10.0 and media_key(s_media) == media_key(r_media))):
        room["media"] = s_media
    if snap.get("polls") and not room.get("polls"):
        room["polls"] = snap["polls"]
    elif snap.get("polls") and room.get("polls"):
        by_id = {p.get("id"): p for p in (room.get("polls") or []) if isinstance(p, dict) and p.get("id")}
        for sp in (snap.get("polls") or []):
            if isinstance(sp, dict) and sp.get("id"):
                pid = sp["id"]
                if pid not in by_id or sum(len(o.get("votes") or []) for o in sp.get("options") or []) >= sum(len(o.get("votes") or []) for o in by_id[pid].get("options") or []):
                    by_id[pid] = sp
        room["polls"] = list(by_id.values())[-10:]
    prev_c_len = len(room.get("chat") or [])
    room["rev"] = max(s_rev, r_rev, int(room.get("rev") or 1)) + (1 if len(merged_c) > prev_c_len else 0)
    room["createdAt"] = min(s_ct, r_ct)
    room["kicked"] = list(kicked)[-50:]
    room["left"] = left_map
    room["participants"] = merged_p
    room["chat"] = merged_c[-MAX_CHAT:]
    room["events"] = merged_ev[-35:]
    room["signals"] = merged_sig[-240:]
    return room


def set_media(room: Dict[str, Any], media: Dict[str, Any], by: str, start: float = 0.0) -> None:
    m = clean_media(media)
    m.update({"playing": True, "currentTime": max(0.0, float(start or 0)), "rate": 1.0, "updatedAt": now(), "lastActionBy": by})
    room["media"] = m
    room["skip_votes"] = []
    room["voteEndsAt"] = 0.0
    room["endedKey"] = ""


def sys_msg(room: Dict[str, Any], text: str, user: str = "") -> Dict[str, Any]:
    prune_chat(room)
    t_now = now()
    chat = room.get("chat") or []
    if user and any(k in text for k in ("katıldı", "ayrıldı")):
        for prev in reversed(chat[-4:]):
            if prev.get("system") and prev.get("user") == user and prev.get("text") == text and (t_now - float(prev.get("ts") or 0.0) < 12.0):
                return prev
    msg = {"id": uuid.uuid4().hex[:10], "system": True, "user": user, "text": text, "time": time.strftime("%H:%M"), "ts": t_now}
    room["chat"] = (chat + [msg])[-MAX_CHAT:]
    ev = {"id": uuid.uuid4().hex[:10], "ts": t_now, "type": "chat", "message": msg, "cid": ""}
    room["events"] = (room.get("events") or [])[-34:] + [ev]
    return msg


def serialize(room: Dict[str, Any], for_cid: Optional[str] = None) -> Dict[str, Any]:
    t = now()
    prune_chat(room)
    p_map = room.get("participants") or {}
    has_humans = any(p.get("transport") != "bot" for p in p_map.values())
    m = dict(_media_defaults(room))
    if not has_humans:
        room["media"]["currentTime"] = 0.0
        room["media"]["updatedAt"] = t
        m["currentTime"] = 0.0
        m["updatedAt"] = t
    elapsed_wall = max(0.0, t - float(m.get("updatedAt") or t))
    elapsed = elapsed_wall * m["rate"] if (m["playing"] and has_humans) else 0.0
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
    total_p = len(p_map)
    co_set = set(room.get("co_hosts") or [])
    host_id = room.get("host_id")
    is_cohost_mode = room.get("playMode") == "cohost"
    cache_sig = f"{room.get('rev')}:{total_p}:{host_id}:{len(co_set)}:{int(is_cohost_mode)}"
    if room.get("_parts_sig") == cache_sig and room.get("_parts_list") is not None:
        ser_parts = list(room["_parts_list"])
    else:
        raw_parts = list(p_map.values())
        if total_p > 60:
            raw_parts.sort(key=lambda x: (0 if x["id"] == host_id else (1 if x["id"] in co_set else (2 if not x.get("muted", True) or x.get("cam") or x.get("screen") else 3))))
            raw_parts = raw_parts[:60]
        ser_parts = []
        for p in raw_parts:
            cp = {k: v for k, v in p.items() if k not in ("lastSeen", "uid")}
            cp["isHost"] = p["id"] == host_id
            cp["isCoHost"] = (p["id"] in co_set) or is_cohost_mode
            ser_parts.append(cp)
        room["_parts_sig"] = cache_sig
        room["_parts_list"] = ser_parts
    if for_cid and for_cid in p_map and not any(x["id"] == for_cid for x in ser_parts):
        me_p = p_map[for_cid]
        cp_me = {k: v for k, v in me_p.items() if k not in ("lastSeen", "uid")}
        cp_me["isHost"] = for_cid == host_id
        cp_me["isCoHost"] = (for_cid in co_set) or is_cohost_mode
        ser_parts = ser_parts[:59] + [cp_me]
    recent_events = [e for e in (room.get("events") or []) if t - float(e.get("ts") or 0) < 25.0][-30:]
    if for_cid:
        recent_signals = [s for s in (room.get("signals") or []) if s.get("targetId") == for_cid and t - float(s.get("ts") or 0) < 35.0][-60:]
    else:
        recent_signals = []
    return {
        "id": room["id"], "name": room["name"], "privacy": room["privacy"], "playMode": room["playMode"],
        "voipMode": room["voipMode"], "hasPassword": has_password(room), "creator": room["creator"],
        "host_id": host_id, "co_hosts": list(co_set),
        "curated": bool(room.get("curated")), "polls": (room.get("polls") or [])[-10:],
        "voteEndsAt": room["voteEndsAt"], "media": m, "queue": room["queue"],
        "skip_votes": room["skip_votes"], "participants": ser_parts,
        "participantCount": total_p, "count": total_p,
        "chat": room["chat"][-80:], "events": recent_events, "signals": recent_signals,
        "serverNow": t, "rev": int(room.get("rev") or 1), "syncToken": pack_sync_token(room),
    }


def lobby_entry(room: Dict[str, Any]) -> Dict[str, Any]:
    t = now()
    p_map = room.get("participants") or {}
    has_humans = any(p.get("transport") != "bot" for p in p_map.values())
    raw_m = _media_defaults(room)
    playing = bool(raw_m.get("playing")) and has_humans
    rate = float(raw_m.get("rate") or 1.0)
    updated_at = float(raw_m.get("updatedAt") or t)
    cur_time = float(raw_m.get("currentTime") or 0.0) if has_humans else 0.0
    dur = float(raw_m.get("duration") or 0.0)
    raw_live = max(0.0, cur_time + ((t - updated_at) * rate if playing else 0.0)) if has_humans else 0.0
    m_summary = dict(raw_m)
    m_summary["currentTime"] = cur_time
    m_summary["liveTime"] = round(raw_live, 1)
    host_id = room.get("host_id")
    co_set = set(room.get("co_hosts") or [])
    is_cohost_mode = room.get("playMode") == "cohost"
    parts_preview = []
    for p in list(p_map.values())[:5]:
        cp = {k: v for k, v in p.items() if k not in ("lastSeen", "uid")}
        cp["isHost"] = p["id"] == host_id
        cp["isCoHost"] = (p["id"] in co_set) or is_cohost_mode
        parts_preview.append(cp)
    return {
        "id": room["id"], "name": room["name"], "privacy": room["privacy"], "playMode": room["playMode"],
        "hasPassword": has_password(room), "creator": room.get("creator", ""),
        "host_id": host_id, "rev": int(room.get("rev") or 1),
        "curated": bool(room.get("curated")), "media": m_summary,
        "count": len(p_map), "participantCount": len(p_map), "participants": parts_preview,
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

    def lock(self, room_id: str):
        return self.locks.setdefault(room_id, asyncio.Lock())

    async def get(self, room_id: str, force_fresh: bool = False) -> Optional[Dict[str, Any]]:
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

    async def delete(self, room_id: str) -> None:
        self.rooms.pop(room_id, None)
        if self.tmp_dir:
            try:
                (self.tmp_dir / f"{room_id}.json").unlink(missing_ok=True)
            except Exception:
                pass

    async def all(self) -> List[Dict[str, Any]]:
        if self.tmp_dir:
            try:
                for fp in self.tmp_dir.glob("*.json"):
                    rid = fp.stem
                    if rid not in self.rooms:
                        self.rooms[rid] = json.loads(fp.read_text(encoding="utf-8"))
            except Exception:
                pass
        return list(self.rooms.values())


class _RedisLock:
    _UNLOCK_LUA = 'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end'

    def __init__(self, store: "RedisStore", room_id: str, remote: bool = False) -> None:
        self.store, self.room_id, self.remote = store, room_id, remote
        self.key, self.token = f"vortex:lock:{room_id}", uuid.uuid4().hex
        self.local_lock = store._local_lock(room_id)
        self.acquired_remote = False

    async def __aenter__(self):
        await self.local_lock.acquire()
        if self.remote:
            for _ in range(30):
                res = await self.store.cmd("SET", self.key, self.token, "NX", "PX", "3000")
                if res == "OK":
                    self.acquired_remote = True
                    break
                await asyncio.sleep(0.04)
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

    def lock(self, room_id: str, remote: bool = False):
        return _RedisLock(self, room_id, remote=remote)

    async def get(self, room_id: str, force_fresh: bool = False) -> Optional[Dict[str, Any]]:
        t = now()
        cached = self.l1_rooms.get(room_id)
        cached_has_media = bool(cached and isinstance(cached.get("media"), dict) and (cached["media"].get("url") or cached["media"].get("videoId")))
        if not force_fresh and cached and cached_has_media and (t - self.l1_read_ts.get(room_id, 0.0) < 0.2):
            return cached
        raw = await self.cmd("GET", f"vortex:room:{room_id}")
        if raw:
            try:
                room = json.loads(raw)
                r_has_media = bool(isinstance(room.get("media"), dict) and (room["media"].get("url") or room["media"].get("videoId")))
                if cached_has_media and not r_has_media and (t - self.l1_write_ts.get(room_id, 0.0) < 30.0):
                    room["media"] = cached["media"]
                    room["rev"] = max(int(room.get("rev") or 1), int(cached.get("rev") or 1))
                if cached and cached.get("chat") and not room.get("_explicit_chat_clear") and (t - self.l1_write_ts.get(room_id, 0.0) < 60.0):
                    by_id = {}
                    for cm in (cached.get("chat") or []) + (room.get("chat") or []):
                        if isinstance(cm, dict) and cm.get("id"):
                            by_id[cm["id"]] = cm
                    if len(by_id) > len(room.get("chat") or []):
                        room["chat"] = sorted(by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-MAX_CHAT:]
                self.l1_rooms[room_id] = room
                self.l1_read_ts[room_id] = t
                return room
            except Exception:
                pass
        return cached or await self.fallback.get(room_id)

    async def put(self, room: Dict[str, Any], force_disk: bool = False) -> None:
        rid = room["id"]
        t = now()
        prev_cached = self.l1_rooms.get(rid)
        if prev_cached and isinstance(prev_cached.get("media"), dict) and (prev_cached["media"].get("url") or prev_cached["media"].get("videoId")):
            cur_m = room.get("media") or {}
            if not cur_m.get("url") and not cur_m.get("videoId") and not room.get("_explicit_media_clear"):
                room["media"] = prev_cached["media"]
        if prev_cached and prev_cached.get("chat") and not room.get("_explicit_chat_clear"):
            by_id = {}
            for cm in (prev_cached.get("chat") or []) + (room.get("chat") or []):
                if isinstance(cm, dict) and cm.get("id"):
                    by_id[cm["id"]] = cm
            room["chat"] = sorted(by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-MAX_CHAT:]
        room.pop("_explicit_chat_clear", None)
        self.l1_rooms[rid] = room
        self.l1_read_ts[rid] = t
        await self.fallback.put(room, force_disk=force_disk)
        if not force_disk and (t - self.l1_write_ts.get(rid, 0.0) < 0.8):
            return
        self.l1_write_ts[rid] = t
        clean_r = {k: v for k, v in room.items() if not k.startswith("_")}
        payload = json.dumps(clean_r, separators=(",", ":"), ensure_ascii=False)
        await self.pipeline([
            ["SET", f"vortex:room:{rid}", payload, "EX", "86400"],
            ["SADD", "vortex:rooms", rid],
        ])

    async def delete(self, room_id: str) -> None:
        self.l1_rooms.pop(room_id, None)
        self.l1_read_ts.pop(room_id, None)
        self.l1_write_ts.pop(room_id, None)
        await self.fallback.delete(room_id)
        await self.pipeline([
            ["DEL", f"vortex:room:{room_id}"],
            ["SREM", "vortex:rooms", room_id],
        ])

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
        elif p.get("transport") == "ws" and not STORE.shared and cid not in live_ws:
            gone.append(room["participants"].pop(cid))
            left_map[cid] = t
    room["left"] = {k: v for k, v in left_map.items() if t - float(v or 0) < 45.0}
    room["events"] = [e for e in (room.get("events") or []) if t - float(e.get("ts") or 0) < 25.0][-35:]
    room["signals"] = [s for s in (room.get("signals") or []) if t - float(s.get("ts") or 0) < 35.0][-240:]
    for gp in gone:
        if isinstance(gp, dict) and gp.get("transport") != "bot":
            sys_msg(room, "odadan ayrıldı", gp.get("name", "Misafir"))
    prune_chat(room)
    has_humans = any(p.get("transport") != "bot" for p in room["participants"].values())
    if not has_humans:
        room.setdefault("emptySince", t)
        if room.get("curated") or (t - float(room.get("emptySince") or t) > 3600.0):
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


def ensure_host(room: Dict[str, Any]) -> None:
    humans = [cid for cid, p in room["participants"].items() if p.get("transport") != "bot"]
    cur_host_id = room.get("host_id")
    cur_host = room["participants"].get(cur_host_id) if cur_host_id else None
    if cur_host and (cur_host.get("transport") != "bot" or not humans):
        return
    creator_cid = next((cid for cid, p in room["participants"].items() if (p.get("uid") and room.get("creatorId") and p["uid"] == room["creatorId"]) or (room.get("creatorId") and cid == room["creatorId"])), None)
    if creator_cid and not room.get("host_transferred") and room["participants"].get(creator_cid, {}).get("transport") != "bot":
        room["host_id"] = creator_cid
        return
    if humans:
        room["host_id"] = humans[0]
    elif room["participants"]:
        room["host_id"] = next(iter(room["participants"]))
    else:
        room["host_id"] = None


def _slugify_name(name: str) -> str:
    return re.sub(r"[^a-z0-9\-]", "", (name or "").lower().replace(" ", "-").replace("ı", "i").replace("ş", "s").replace("ğ", "g").replace("ü", "u").replace("ö", "o").replace("ç", "c")).strip("-")


def add_participant(room: Dict[str, Any], cid: str, data: Dict[str, Any], transport: str) -> Tuple[Dict[str, Any], bool]:
    if isinstance(room.get("left"), dict):
        room["left"].pop(cid, None)
    existing = room["participants"].get(cid)
    p = existing or {"id": cid, "muted": True, "speaking": False, "name": "Misafir", "color": "#00f5d4", "device": "Web", "country": "", "uid": ""}
    fields = {
        "name": clean_str(data.get("username"), 24),
        "color": clean_str(data.get("color"), 16) if re.match(r"^#[0-9a-fA-F]{3,8}$", str(data.get("color") or "")) else "",
        "device": clean_str(data.get("device"), 16),
        "country": re.sub(r"[^A-Z]", "", clean_str(data.get("country"), 2).upper()),
        "uid": clean_str(data.get("uid"), 64),
    }
    p.update({k: v for k, v in fields.items() if v})
    p.update({"transport": transport, "lastSeen": now()})
    room["participants"][cid] = p
    cur_host_id = room.get("host_id")
    cur_host = room["participants"].get(cur_host_id) if cur_host_id else None

    # Creator or designated host preservation:
    # If the joining user is the verified creator (by uid, signed creator cid, or room owner slug when current host is not the verified creator), restore host_id.
    p_slug = _slugify_name(p.get("name", ""))
    rid_str = str(room.get("id") or "")
    cur_host_is_verified_creator = bool(
        cur_host and room.get("creatorId") and (cur_host.get("uid") == room.get("creatorId") or cur_host_id == room.get("creatorId"))
    )
    slug_creator_match = bool(
        not room.get("curated")
        and p_slug
        and len(p_slug) >= 3
        and (rid_str.startswith(f"{p_slug}-odasi-") or rid_str.startswith(f"{p_slug}-"))
        and not cur_host_is_verified_creator
    )
    is_creator = bool(
        (p.get("uid") and room.get("creatorId") and p["uid"] == room["creatorId"])
        or (room.get("creatorId") and cid == room["creatorId"])
        or (data.get("isCreator") and not cur_host_is_verified_creator)
        or slug_creator_match
    )
    if is_creator and not room.get("host_transferred"):
        if not cur_host or cur_host.get("transport") == "bot" or not cur_host_is_verified_creator:
            room["host_id"] = cid
        if not room.get("creatorId") or slug_creator_match:
            room["creatorId"] = p.get("uid") or cid
        co = list(room.get("co_hosts") or [])
        if cid not in co:
            co.append(cid)
            room["co_hosts"] = co
    elif not (cur_host and cur_host.get("transport") != "bot"):
        if not cur_host or (cur_host.get("transport") == "bot" and transport != "bot"):
            room["host_id"] = cid
    room["lastActiveAt"] = now()
    return p, existing is None


# ---------------------------------------------------------------------------
# Action handler (shared by WebSocket and HTTP transports)
# ---------------------------------------------------------------------------
def _sync_event(room, action, by):
    return {"type": "sync", "action": action, "by": by, "media": serialize(room)["media"]}


def _room_event(room, kind="room_state", **extra):
    return {"type": kind, "room": serialize(room), **extra}


def _apply_time(room, data):
    if "currentTime" in data:
        try:
            room["media"]["currentTime"] = max(0.0, float(data["currentTime"]))
        except (TypeError, ValueError):
            pass
    at = data.get("atTime")
    t = now()
    try:
        at = float(at)
        room["media"]["updatedAt"] = at if abs(at - t) < 2.0 else t
    except (TypeError, ValueError):
        room["media"]["updatedAt"] = t


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
        return out
    me = room["participants"].get(cid)
    if not me:
        return out
    name = me["name"]
    p_slug = _slugify_name(name)
    rid_str = str(room.get("id") or "")
    cur_host = room["participants"].get(room.get("host_id") or "")
    cur_host_is_verified = bool(
        cur_host and room.get("creatorId") and (cur_host.get("uid") == room.get("creatorId") or room.get("host_id") == room.get("creatorId"))
    )
    is_creator = bool(
        (me.get("uid") and room.get("creatorId") and me["uid"] == room["creatorId"])
        or (room.get("creatorId") and cid == room["creatorId"])
        or (not room.get("curated") and p_slug and len(p_slug) >= 3 and (rid_str.startswith(f"{p_slug}-odasi-") or rid_str.startswith(f"{p_slug}-")))
    )
    if is_creator and not room.get("host_transferred"):
        co = list(room.get("co_hosts") or [])
        if cid not in co:
            co.append(cid)
            room["co_hosts"] = co
        if room.get("host_id") != cid and not cur_host_is_verified and not cur_host:
            room["host_id"] = cid
    is_host = cid == room["host_id"]
    mode = room["playMode"]
    co_hosts = set(room.get("co_hosts") or [])
    can_control = is_host or is_creator or (cid in co_hosts) or (mode == "cohost")
    deny = lambda text: out["reply"].append({"type": "error", "message": text})

    if mtype == "heartbeat":
        cur_host = room["participants"].get(room.get("host_id") or "")
        if not is_host and not (can_control and (not cur_host or cur_host.get("transport") == "bot")):
            return out
        if not room["media"].get("url") and not room["media"].get("videoId"):
            if isinstance(data.get("activeMedia"), dict) and (data["activeMedia"].get("url") or data["activeMedia"].get("videoId")):
                set_media(room, data["activeMedia"], name, float(data.get("currentTime") or data["activeMedia"].get("currentTime") or 0.0))
                room["rev"] = int(room.get("rev") or 1) + 5
                out["broadcast"].append((_room_event(room, "media_changed", by=name), None))
            return out
        try:
            inc_t = float(data.get("currentTime") or 0.0)
        except (TypeError, ValueError):
            inc_t = 0.0
        cur_m = room["media"]
        cur_live = float(cur_m.get("currentTime") or 0.0) + (max(0.0, now() - float(cur_m.get("updatedAt") or now())) * float(cur_m.get("rate") or 1.0) if cur_m.get("playing") else 0.0)
        if cur_live > 25.0 and inc_t < 10.0:
            return out
        _apply_time(room, data)
        if "playing" in data:
            room["media"]["playing"] = bool(data["playing"])
        if is_host and data.get("privacy") in VALID_PRIVACY:
            room["privacy"] = data["privacy"]
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append((_sync_event(room, "heartbeat", name), cid))
        return out

    if mtype == "resolve_media":
        cur_m = room.get("media") or {}
        incoming = clean_media(data)
        if incoming.get("url") and not str(incoming.get("url")).startswith("/api/rave/resolve-catalog"):
            if not cur_m.get("url") or str(cur_m.get("url")).startswith("/api/rave/resolve-catalog") or media_key(cur_m) == media_key(incoming):
                for k in ("provider", "streamType", "url", "altUrls", "subtitleTracks", "audioTracks", "intro", "duration"):
                    if incoming.get(k):
                        cur_m[k] = incoming[k]
                room["media"] = cur_m
                room["rev"] = int(room.get("rev") or 1) + 1
        return out

    if mtype in ("play", "pause", "seek", "rate"):
        if not can_control:
            deny("Bunu yalnızca oda lideri veya ortak lider yapabilir.")
            out["reply"].append(_sync_event(room, "correct", "server"))
            return out
        if not room["media"].get("url") and not room["media"].get("videoId"):
            return out
        _apply_time(room, data)
        if mtype == "play":
            room["media"]["playing"] = True
        elif mtype == "pause":
            room["media"]["playing"] = False
        elif mtype == "rate":
            try:
                room["media"]["rate"] = min(2.0, max(0.25, float(data.get("rate", 1.0))))
            except (TypeError, ValueError):
                pass
        room["media"]["lastActionBy"] = name
        room["rev"] = int(room.get("rev") or 1) + 1
        ev = _sync_event(room, mtype, name)
        ev["id"] = "ev_" + uuid.uuid4().hex[:10]
        ev["ts"] = now()
        ev["cid"] = cid
        room["events"] = (room.get("events") or [])[-34:] + [ev]
        out["broadcast"].append((ev, cid))

    elif mtype == "change_media":
        if room.get("curated"):
            deny("7/24 canlı TV ve radyo odalarında yayın değiştirilemez.")
            return out
        room_has_media = bool(room["media"].get("url") or room["media"].get("videoId"))
        creator_slug = _slugify_name(room.get("creator", ""))
        same_creator_name = bool(p_slug and creator_slug and p_slug == creator_slug)
        if mode in ("leader", "autoplay", "vote") and not can_control and not same_creator_name and room_has_media:
            deny("Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider video seçebilir.")
            return out
        try:
            start_pos = max(0.0, float(data.get("currentTime") or 0.0))
        except (TypeError, ValueError):
            start_pos = 0.0
        set_media(room, data, name, start_pos)
        room["rev"] = int(room.get("rev") or 1) + 5
        sys_msg(room, f"Şu an oynatılıyor: {room['media']['title']}", name)
        out["broadcast"].append((_room_event(room, "media_changed", by=name), None))

    elif mtype == "queue_add":
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

    elif mtype == "vote_skip":
        if cid not in room["skip_votes"]:
            room["skip_votes"].append(cid)
        room["rev"] = int(room.get("rev") or 1) + 1
        needed = max(1, len(room["participants"]) // 2 + 1)
        if len(room["skip_votes"]) >= needed and room["queue"]:
            _play_next(room, "Atlama oylaması")
            out["broadcast"].append((_room_event(room, "media_changed", by="skip"), None))
        else:
            out["broadcast"].append(({"type": "skip_votes", "votes": room["skip_votes"], "needed": needed}, None))

    elif mtype == "video_ended":
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


def _handle_social(room, cid, data, out, name, is_host):
    mtype = data.get("type")
    me = room["participants"][cid]
    t_now = now()
    rl = me.setdefault("_rl", {})
    if mtype in ("chat", "reaction", "soundfx", "poll_create"):
        cd = 3.5 if mtype == "poll_create" else 0.25
        if t_now - float(rl.get(mtype) or 0.0) < cd:
            return out
        rl[mtype] = t_now
    if mtype == "chat":
        text = clean_str(data.get("text"), 1000)
        gif = clean_str(data.get("gif"), 600)
        if gif and not re.match(r"^https://(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com)/", gif):
            gif = ""
        snap = str(data.get("snapshot") or "").strip()
        if snap and (not snap.startswith("data:image/jpeg;base64,") or len(snap) > 48000):
            snap = ""
        try:
            vid_t = float(data.get("videoTime")) if data.get("videoTime") is not None else None
            if vid_t is not None and (vid_t < 0 or vid_t > 86400):
                vid_t = None
        except (TypeError, ValueError):
            vid_t = None
        if text or gif or snap:
            raw_recent = data.get("recentChat")
            if isinstance(raw_recent, list) and not room.get("_explicit_chat_clear"):
                by_id = {m.get("id"): m for m in (room.get("chat") or []) if isinstance(m, dict) and m.get("id")}
                for rm in raw_recent[-25:]:
                    if isinstance(rm, dict) and rm.get("id") and rm["id"] not in by_id:
                        rm_ts = float(rm.get("ts") or t_now)
                        if 0 < t_now - rm_ts <= 7200.0:
                            by_id[rm["id"]] = {
                                "id": clean_str(rm.get("id"), 24),
                                "system": bool(rm.get("system")),
                                "user": clean_str(rm.get("user"), 32),
                                "uid": clean_str(rm.get("uid"), 64),
                                "color": clean_str(rm.get("color"), 16) or "#27DCC8",
                                "text": clean_str(rm.get("text"), 1000),
                                "gif": clean_str(rm.get("gif"), 600),
                                "time": clean_str(rm.get("time"), 12) or time.strftime("%H:%M"),
                                "ts": rm_ts,
                                "replyTo": rm.get("replyTo") if isinstance(rm.get("replyTo"), dict) else None,
                                "reactions": rm.get("reactions") if isinstance(rm.get("reactions"), dict) else {},
                            }
                room["chat"] = sorted(by_id.values(), key=lambda x: float(x.get("ts") or 0.0))[-MAX_CHAT:]
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
                        "text": clean_str(target_m.get("text") or ("📸 Sahne" if target_m.get("snapshot") else "GIF" if target_m.get("gif") else ""), 140),
                        "color": target_m.get("color") or "#00f5d4",
                    }
            req_mid = clean_str(data.get("id"), 24)
            msg_id = req_mid if (req_mid and re.match(r"^[a-zA-Z0-9_-]{4,24}$", req_mid)) else uuid.uuid4().hex[:10]
            msg = {"id": msg_id, "user": name, "uid": me.get("uid", ""), "color": me["color"], "text": text, "gif": gif,
                   "time": time.strftime("%H:%M"), "ts": t_now, "replyTo": reply_obj, "reactions": {}}
            if snap:
                msg["snapshot"] = snap
            if vid_t is not None:
                msg["videoTime"] = round(vid_t, 1)
            room.pop("_explicit_chat_clear", None)
            existing_chat = [m for m in (room.get("chat") or []) if isinstance(m, dict) and m.get("id") != msg_id]
            room["chat"] = (existing_chat + [msg])[-MAX_CHAT:]
            ev = {"id": uuid.uuid4().hex[:10], "ts": t_now, "type": "chat", "message": msg, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            room["rev"] = int(room.get("rev") or 1) + 1
            out["broadcast"].append(({"type": "chat", "message": msg}, None))
    elif mtype == "clear_chat":
        if not (is_host or cid in (room.get("co_hosts") or [])):
            out["reply"].append({"type": "error", "message": "Sohbeti yalnızca oda lideri temizleyebilir."})
            return out
        room["_explicit_chat_clear"] = True
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
                if name in users:
                    users.remove(name)
                else:
                    users.append(name)
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
        out["broadcast"].append(({"type": "typing", "user": name}, cid))
    elif mtype == "reaction":
        emoji = clean_str(data.get("emoji"), 8)
        if emoji:
            ev = {"id": uuid.uuid4().hex[:10], "ts": now(), "type": "reaction", "emoji": emoji, "user": name, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            out["broadcast"].append(({"type": "reaction", "emoji": emoji, "user": name}, cid))
    elif mtype == "soundfx":
        sfx = clean_str(data.get("sfx"), 24)
        if sfx:
            ev = {"id": uuid.uuid4().hex[:10], "ts": now(), "type": "soundfx", "sfx": sfx, "user": name, "cid": cid}
            room["events"] = (room.get("events") or [])[-34:] + [ev]
            out["broadcast"].append(({"type": "soundfx", "sfx": sfx, "user": name}, cid))
    elif mtype == "voice_state":
        if room["voipMode"] == "off" or (room["voipMode"] == "leader" and not is_host):
            me["muted"], me["speaking"] = True, False
            if data.get("muted") is False:
                out["reply"].append({"type": "error", "message": "Bu odada sesli iletişim kısıtlı."})
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
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append(({"type": "participants_updated", "participants": serialize(room)["participants"]}, None))
    elif mtype == "host_action":
        act = data.get("action")
        is_creator_match = bool(
            (room.get("creatorId") and (me.get("uid") == room.get("creatorId") or cid == room.get("creatorId")))
            or (room.get("creator") and me.get("name") and me.get("name") == room.get("creator"))
        )
        if not (is_host or cid in (room.get("co_hosts") or []) or is_creator_match):
            out["reply"].append({"type": "error", "message": "Bu ayarları yalnızca oda lideri değiştirebilir."})
            return out
        if is_creator_match and room.get("host_id") not in room.get("participants", {}):
            room["host_id"] = cid
        if act == "set_privacy":
            if data.get("privacy") in VALID_PRIVACY:
                room["privacy"] = data["privacy"]
            if data.get("playMode") in VALID_PLAY_MODES:
                room["playMode"] = data["playMode"]
            if data.get("voipMode") in VALID_VOIP:
                room["voipMode"] = data["voipMode"]
            if "password" in data:
                room["passwordHash"] = hash_room_password(data.get("password"))
                room.pop("password", None)
            if clean_str(data.get("name"), 45):
                room["name"] = clean_str(data.get("name"), 45)
            _LOBBY_CACHE["ts"] = 0.0
        elif act == "transfer_host" and data.get("targetId") in room["participants"]:
            room["host_id"] = data["targetId"]
            room["host_transferred"] = True
            sys_msg(room, "artık oda lideri", room["participants"][data["targetId"]]["name"])
        elif act == "toggle_cohost" and data.get("targetId") in room["participants"] and data["targetId"] != cid:
            tid = data["targetId"]
            co_list = list(room.get("co_hosts") or [])
            if tid in co_list:
                co_list.remove(tid)
                sys_msg(room, "ortak liderlikten çıkarıldı", room["participants"][tid]["name"])
            else:
                co_list.append(tid)
                sys_msg(room, "ortak lider (Co-Host) yapıldı", room["participants"][tid]["name"])
            room["co_hosts"] = co_list
        elif act == "kick" and data.get("targetId") in room["participants"] and data["targetId"] != cid:
            kicked = room["participants"].pop(data["targetId"])
            k_list = list(room.get("kicked") or [])
            if data["targetId"] not in k_list:
                k_list.append(data["targetId"])
            room["kicked"] = k_list
            sys_msg(room, f"{name} tarafından odadan çıkarıldı", kicked["name"])
            out["kick"] = data["targetId"]
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append((_room_event(room), None))
    elif mtype in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
        target = data.get("targetId")
        if target in room["participants"]:
            relay = {k: v for k, v in data.items() if k in ("type", "sdp", "candidate")}
            relay["fromId"] = cid
            relay["targetId"] = target
            relay["id"] = uuid.uuid4().hex[:10]
            relay["ts"] = now()
            room["signals"] = (room.get("signals") or [])[-239:] + [relay]
            out.setdefault("direct", []).append((target, relay))
    elif mtype == "profile_update":
        me["name"] = clean_str(data.get("name"), 24) or me["name"]
        me["color"] = clean_str(data.get("color"), 16) or me["color"]
        room["_parts_list"] = None
        room["rev"] = int(room.get("rev") or 1) + 1
        out["broadcast"].append(({"type": "participants_updated", "participants": serialize(room)["participants"]}, None))
    elif mtype == "poll_create":
        question = clean_str(data.get("question"), 140)
        raw_opts = [clean_str(o, 80) for o in (data.get("options") or [])[:5] if clean_str(o, 80)]
        if question and len(raw_opts) >= 2:
            poll = {
                "id": "p_" + uuid.uuid4().hex[:8],
                "question": question,
                "creator": name,
                "createdAt": now(),
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
                "time": time.strftime("%H:%M"),
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
        voter_tag = name if name != "Misafir" else f"Misafir#{cid[-4:]}"
        for poll in (room.get("polls") or []):
            if poll.get("id") == pid and 0 <= opt_idx < len(poll.get("options") or []):
                cur_votes = poll["options"][opt_idx].get("votes") or []
                already = (voter_tag in cur_votes) or (name != "Misafir" and name in cur_votes)
                for o in poll["options"]:
                    o["votes"] = [v for v in (o.get("votes") or []) if v != voter_tag and (name == "Misafir" or v != name)]
                if not already:
                    poll["options"][opt_idx]["votes"].append(voter_tag)
                room["rev"] = int(room.get("rev") or 1) + 1
                out["broadcast"].append(({"type": "poll_updated", "poll": poll, "polls": room["polls"]}, None))
                break
    return out


def check_vote_end(room: Dict[str, Any]) -> bool:
    """Rave vote mode: when the 8 s pie timer ends, the top-voted item plays."""
    if room["voteEndsAt"] and now() >= room["voteEndsAt"]:
        room["voteEndsAt"] = 0.0
        if _play_next(room, "Oylama"):
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


async def deliver(room_id: str, out: Dict[str, Any], sender_ws=None) -> None:
    for msg, exclude in out.get("broadcast", []):
        await broadcast(room_id, msg, exclude)
    for target, msg in out.get("direct", []):
        ws = SOCKETS.get(room_id, {}).get(target)
        if ws:
            try:
                await ws.send_json(msg)
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

ROOM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,47}$")

_LIVE_TV = [
    ("trt1", "TRT 1", "https://tv-trt1.medya.trt.com.tr/master.m3u8"),
    ("atv", "ATV", "https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/atv/atv_1080p.m3u8"),
    ("now-tv", "NOW", "https://uycyyuuzyh.turknet.ercdn.net/nphindgytw/nowtv/nowtv_720p.m3u8"),
    ("star-tv", "Star TV", "https://dogus-live.daioncdn.net/startv/playlist.m3u8"),
    ("trt-spor", "TRT Spor", "https://tv-trtspor1.medya.trt.com.tr/master.m3u8"),
    ("a-spor", "A Spor", "https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/aspor/aspor.m3u8"),
    ("ntv", "NTV", "https://dogus-live.daioncdn.net/ntv/playlist.m3u8"),
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
    ("radyo-slow-turk", "Slow Türk", "https://radyo.duhnet.tv/ak_dtvh_slowturk", "direct"),
    ("radyo-best-fm", "Best FM", "https://ssldyg.radyotvonline.com/best/bestfm.stream/playlist.m3u8", "hls"),
    ("radyo-alem-fm", "Alem FM", "https://turkmedya.radyotvonline.net/alemfmaac", "direct"),
]


def _wrap_live_cors_url(u: str) -> str:
    if any(d in u for d in ("ercdn.net", "daioncdn.net", "radyotvonline.")):
        import urllib.parse
        return f"/api/rave/stream?u={urllib.parse.quote(u, safe='')}&proxy_segs=1&ext=.m3u8"
    return u


def _tv_spec(rid: str, name: str, url: str) -> Dict[str, Any]:
    play_u = _wrap_live_cors_url(url)
    return {
        "id": f"tv-{rid}", "name": f"7/24 {name} Canlı Yayın", "creator": "Watchlivo Canlı TV", "privacy": "public", "playMode": "cohost",
        "media": {"provider": "hls", "streamType": "hls", "title": f"📺 {name} · Canlı Yayın", "url": play_u, "altUrls": [url] if play_u != url else [], "channel": "Canlı TV · 7/24",
                  "thumbnail": "/static/watchlivo-poster.svg", "live": True, "mediaType": "live", "duration": 0.0},
    }


def _radio_spec(rid: str, name: str, url: str, kind: str) -> Dict[str, Any]:
    play_u = _wrap_live_cors_url(url) if kind == "hls" else url
    return {
        "id": rid, "name": f"7/24 {name} Canlı Radyo", "creator": "Watchlivo Canlı Radyo", "privacy": "public", "playMode": "cohost",
        "media": {"provider": kind, "streamType": "hls" if kind == "hls" else "mp3", "title": f"📻 {name} · Canlı Radyo", "url": play_u, "altUrls": [url] if play_u != url else [], "channel": "Canlı Radyo · 7/24",
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
    if out.get("schedule_vote_end") and not STORE.shared:
        asyncio.create_task(_vote_timer(room_id, out["schedule_vote_end"]))


async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    room_id = (websocket.path_params.get("room_id") or "").lower()
    q = websocket.query_params
    if not valid_room_id(room_id):
        await websocket.send_json({"type": "error", "message": "Geçersiz oda"})
        await websocket.close()
        return
    requested_cid = re.sub(r"[^a-zA-Z0-9_]", "", str(q.get("clientId") or ""))[:24]
    signed_cid = verify_client_token(room_id, q.get("clientToken"))
    verified_uid = _ws_verified_uid(websocket.scope, q)
    join_data = {k: v for k, v in q.items() if k not in ("pwd", "uid", "clientId", "clientToken")}
    join_data["uid"] = verified_uid
    async with STORE.lock(room_id):
        room = await STORE.get(room_id) or await ensure_curated_room(room_id) or new_room(room_id, creator=q.get("username", ""), creator_id=verified_uid)
        cid = signed_cid or requested_cid
        if not signed_cid and cid and _cid_is_active(room, cid, verified_uid):
            cid = ""
        if not cid:
            cid = uuid.uuid4().hex[:10]
        if not room.get("creatorId") and not room.get("curated") and not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values()):
            room["creatorId"] = verified_uid or cid
        room.setdefault("kicked", [])
        if has_password(room) and cid not in (room.get("participants") or {}):
            allowed, _retry = _JOIN_LIMITER.hit(f"ws:{room_id}:{client_ip(websocket)}")
            if not allowed or not verify_room_password(room, q.get("pwd", "")):
                await websocket.send_json({"type": "password_required", "roomId": room_id, "roomName": room["name"]})
                await websocket.close()
                return
        prune(room)
        was_empty_humans = not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
        empty_elapsed = (now() - float(room.get("emptySince") or 0.0)) if room.get("emptySince") else 0.0
        if was_empty_humans and (room.get("curated") or empty_elapsed > 3600.0):
            room["chat"] = []
            room["polls"] = []
            if room.get("media"):
                room["media"]["currentTime"] = 0.0
                room["media"]["updatedAt"] = now()
                room["media"]["playing"] = True
        room.pop("emptySince", None)
        p, _ = add_participant(room, cid, join_data, "ws")
        join_msg = sys_msg(room, "odaya katıldı", p["name"])
        SOCKETS.setdefault(room_id, {})[cid] = websocket
        await STORE.put(room)
    await websocket.send_json({"type": "init", "clientId": cid, "clientToken": sign_client_token(room_id, cid), "room": serialize(room)})
    await broadcast(room_id, {"type": "user_joined", "user": {"id": cid, "name": p["name"]}, "room": serialize(room)}, exclude=cid)
    await broadcast(room_id, {"type": "chat", "message": join_msg}, exclude=cid)
    try:
        while True:
            data = await websocket.receive_json()
            if not isinstance(data, dict):
                continue
            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong", "t0": data.get("t0", 0), "t0Epoch": data.get("t0Epoch", 0), "serverTime": now()})
                continue
            async with STORE.lock(room_id):
                room = await STORE.get(room_id)
                if not room or cid not in room["participants"]:
                    break
                room["participants"][cid]["lastSeen"] = now()
                out = handle_action(room, cid, data)
                await STORE.put(room)
            await deliver(room_id, out, websocket)
            _after(room_id, out)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as e:  # malformed frames must not crash the server
        print("[ws] error", repr(e))
    finally:
        SOCKETS.get(room_id, {}).pop(cid, None)
        if room_id in SOCKETS and not SOCKETS[room_id]:
            SOCKETS.pop(room_id, None)
        async with STORE.lock(room_id):
            room = await STORE.get(room_id)
            left = room["participants"].pop(cid, None) if room else None
            if room:
                has_humans = any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
                if not has_humans:
                    room["emptySince"] = now()
                    if room.get("curated"):
                        room["chat"] = []
                        room["polls"] = []
                ensure_host(room)
                msg = sys_msg(room, "odadan ayrıldı", left["name"]) if left else None
                room["lastActiveAt"] = now()
                await STORE.put(room)
        if room and left and msg:
            await broadcast(room_id, {"type": "user_left", "user": {"id": cid, "name": left["name"]}, "room": serialize(room)})
            await broadcast(room_id, {"type": "chat", "message": msg})


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
    requested_cid = re.sub(r"[^a-zA-Z0-9_]", "", str(data.get("clientId") or ""))[:24]
    signed_cid = verify_client_token(room_id, data.get("clientToken"))
    verified_uid = str(request.scope.get("wl_uid") or "")
    try:
        since_rev = int(data.get("sinceRev") or 0)
    except (TypeError, ValueError):
        since_rev = 0
    out: Dict[str, Any] = {}
    async with STORE.lock(room_id):
        is_action = data.get("type") not in (None, "", "poll", "init", "ping")
        room = await STORE.get(room_id, force_fresh=bool(is_action or data.get("type") == "init"))
        if data.get("syncToken"):
            room = merge_sync_token(room, data.get("syncToken"), room_id)
        # A cid is only trusted when the server signed it, or when nobody is
        # currently using it (prevents session takeover by claiming a live cid).
        cid = signed_cid or requested_cid
        if not signed_cid and cid and room is not None and _cid_is_active(room, cid, verified_uid):
            cid = ""
        if not cid:
            cid = requested_cid if data.get("type") == "leave" and requested_cid else "h_" + uuid.uuid4().hex[:8]
        if data.get("type") == "leave":
            left_p = room["participants"].pop(cid, None) if room else None
            if room and left_p:
                room.setdefault("left", {})[cid] = now()
                if left_p.get("transport") != "bot":
                    sys_msg(room, "odadan ayrıldı", left_p.get("name", "Misafir"))
                has_humans = any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
                if not has_humans:
                    room["emptySince"] = now()
                    if room.get("curated"):
                        room["chat"] = []
                        room["polls"] = []
                ensure_host(room)
                room["rev"] = int(room.get("rev") or 1) + 1
                await STORE.put(room, force_disk=True)
            return JSONResponse({"ok": True})
        room = room or await ensure_curated_room(room_id) or new_room(room_id, creator=data.get("username", ""), creator_id=verified_uid)
        if not room.get("creatorId") and not room.get("curated") and not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values()):
            room["creatorId"] = verified_uid or cid
        room.setdefault("kicked", [])
        if cid in room["kicked"]:
            return JSONResponse({"error": "kicked"}, status_code=410)
        if has_password(room) and cid not in (room.get("participants") or {}):
            allowed, retry_after = _JOIN_LIMITER.hit(f"http:{room_id}:{client_ip(request)}")
            if not allowed:
                return JSONResponse({"error": "rate_limited", "retryAfter": int(retry_after)}, status_code=429)
            if not verify_room_password(room, data.get("pwd", "")):
                return JSONResponse({"error": "password_required"}, status_code=403)
        prev_host = room.get("host_id")
        prev_seen = float((room.get("participants") or {}).get(cid, {}).get("lastSeen") or 0.0)
        pruned = prune(room)
        was_empty_humans = not any(hp.get("transport") != "bot" for hp in (room.get("participants") or {}).values())
        empty_elapsed = (now() - float(room.get("emptySince") or 0.0)) if room.get("emptySince") else 0.0
        if was_empty_humans and (room.get("curated") or empty_elapsed > 3600.0):
            room["chat"] = []
            room["polls"] = []
            if room.get("media") and not data.get("syncToken"):
                room["media"]["currentTime"] = 0.0
                room["media"]["updatedAt"] = now()
                room["media"]["playing"] = True
            if room.get("curated"):
                spec = next((s for s in CURATED_LIVE_SPECS if s["id"] == room_id), None)
                if spec:
                    room["creator"] = spec.get("creator", "Watchlivo 7/24")
                    if "kinox_bot" in room.get("participants", {}):
                        room["participants"]["kinox_bot"]["name"] = room["creator"]
        room.pop("emptySince", None)
        p, is_new = add_participant(room, cid, {**data, "uid": verified_uid}, "http")
        if is_new:
            sys_msg(room, "odaya katıldı", p["name"])
        active_m = data.get("activeMedia")
        restored_active_media = False
        if not room.get("curated") and isinstance(active_m, dict) and (active_m.get("url") or active_m.get("videoId")):
            room_empty_media = not room["media"].get("url") and not room["media"].get("videoId")
            caller_is_leader = bool(
                cid == room.get("host_id")
                or cid in (room.get("co_hosts") or [])
                or data.get("isCreator")
                or (_slugify_name(p.get("name", "")) and _slugify_name(p.get("name", "")) == _slugify_name(room.get("creator", "")))
            )
            incoming_clean = clean_media(active_m)
            cur_unresolved = str(room["media"].get("url") or "").startswith("/api/rave/resolve-catalog")
            inc_resolved = bool(incoming_clean.get("url") and not str(incoming_clean.get("url")).startswith("/api/rave/resolve-catalog"))
            should_sync_active = room_empty_media or (caller_is_leader and cur_unresolved and inc_resolved)
            if should_sync_active:
                try:
                    am_pos = max(0.0, float(active_m.get("currentTime") or active_m.get("meshStatePosition") or 0.0))
                except (TypeError, ValueError):
                    am_pos = 0.0
                set_media(room, active_m, p["name"], am_pos)
                room["rev"] = int(room.get("rev") or 1) + 5
                restored_active_media = True
        voted = check_vote_end(room)
        mutated = restored_active_media or voted or bool(pruned) or (room.get("host_id") != prev_host) or is_new
        if is_action:
            out = handle_action(room, cid, data)
            mutated = True
            if out.get("kick"):
                room["kicked"] = (room["kicked"] + [out["kick"]])[-50:]
        elif is_new and SOCKETS.get(room_id) and (now() - float(room.get("_lastWsJoinBcast") or 0.0) > 1.0):
            room["_lastWsJoinBcast"] = now()
            out = {"broadcast": [(_room_event(room), cid)]}
        if mutated and not is_action:
            room["rev"] = int(room.get("rev") or 1) + 1
        t_cur = now()
        if mutated or is_new or (t_cur - prev_seen > 8.0):
            await STORE.put(room, force_disk=bool(mutated or is_new))
        cur_rev = int(room.get("rev") or 1)
        m = room["media"]
        server_media_url = str(m.get("url") or m.get("videoId") or "")
        client_media_url = str(data.get("mediaUrl") or "") if "mediaUrl" in data else server_media_url
        server_chat_cnt = len(room.get("chat") or [])
        client_chat_cnt = int(data.get("chatCount")) if isinstance(data.get("chatCount"), int) else server_chat_cnt
        if not is_action and not mutated and not is_new and since_rev > 0 and since_rev == cur_rev and client_media_url == server_media_url and client_chat_cnt == server_chat_cnt:
            elapsed_w = max(0.0, t_cur - float(m.get("updatedAt") or t_cur))
            recent_ev = [e for e in (room.get("events") or []) if t_cur - float(e.get("ts") or 0) < 6.0][-15:]
            recent_sig = [s for s in (room.get("signals") or []) if s.get("targetId") == cid and t_cur - float(s.get("ts") or 0) < 12.0][-25:]
            return JSONResponse({
                "ok": True, "unchanged": True, "clientId": cid, "clientToken": sign_client_token(room_id, cid), "rev": cur_rev, "serverTime": t_cur,
                "participantCount": len(room["participants"]),
                "privacy": room.get("privacy", "public"),
                "playMode": room.get("playMode", "leader"),
                "voipMode": room.get("voipMode", "all"),
                "name": room.get("name", ""),
                "host_id": room.get("host_id"),
                "media": {
                    "url": str(m.get("url") or ""), "videoId": str(m.get("videoId") or ""),
                    "title": str(m.get("title") or ""), "provider": str(m.get("provider") or ""),
                    "playing": bool(m.get("playing")), "currentTime": float(m.get("currentTime") or 0.0),
                    "rate": float(m.get("rate") or 1.0), "updatedAt": float(m.get("updatedAt") or t_cur),
                    "elapsedSinceUpdate": round(elapsed_w, 3), "serverNow": t_cur,
                    "meshStateStatus": "PLAYING" if m.get("playing") else "PAUSED",
                    "meshStatePosition": float(m.get("currentTime") or 0.0),
                    "meshStateTime": float(m.get("updatedAt") or t_cur),
                    "meshStatePlaybackSpeed": float(m.get("rate") or 1.0),
                },
                "syncToken": pack_sync_token(room),
                "events": recent_ev, "signals": recent_sig, "errors": [],
            })
    if out:
        await deliver(room_id, out)
    return JSONResponse({"ok": True, "clientId": cid, "clientToken": sign_client_token(room_id, cid), "room": serialize(room, for_cid=cid), "serverTime": now(),
                         "errors": [m.get("message") for m in out.get("reply", []) if m.get("type") == "error"]})


async def create_room(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    name = clean_str(payload.get("name"), 45) or "Watchlivo Odası"
    slug = re.sub(r"[^a-z0-9\-]", "", name.lower().replace(" ", "-").replace("ı", "i").replace("ş", "s").replace("ğ", "g").replace("ü", "u").replace("ö", "o").replace("ç", "c"))[:24].strip("-") or "oda"
    room_id = f"{slug}-{uuid.uuid4().hex[:5]}"
    req_cid = re.sub(r"[^a-zA-Z0-9_]", "", str(payload.get("clientId") or ""))[:24]
    creator_cid = req_cid or ("h_" + uuid.uuid4().hex[:8])
    verified_uid = str(request.scope.get("wl_uid") or "")
    media = payload.get("media")
    has_incoming_media = isinstance(media, dict) and bool(media.get("url") or media.get("videoId"))
    creator_slug = _slugify_name(payload.get("creator") or "")
    if has_incoming_media and (verified_uid or len(creator_slug) >= 3):
        try:
            all_existing = await STORE.all()
            t_now = now()
            best_existing = None
            for cand in all_existing:
                if not isinstance(cand, dict) or cand.get("curated"):
                    continue
                if t_now - float(cand.get("lastActiveAt") or 0.0) > 600.0:
                    continue
                cand_creator_match = bool(
                    (verified_uid and cand.get("creatorId") == verified_uid)
                    or (creator_slug and _slugify_name(cand.get("creator") or "") == creator_slug)
                )
                if not cand_creator_match:
                    continue
                humans = [pt for pt in (cand.get("participants") or {}).values() if pt.get("transport") != "bot" and t_now - float(pt.get("lastSeen") or 0.0) < 120.0]
                cand_empty_media = not (cand.get("media") or {}).get("url") and not (cand.get("media") or {}).get("videoId")
                if humans and (cand_empty_media or len(humans) >= 2):
                    if not best_existing or len(humans) > len([pt for pt in (best_existing.get("participants") or {}).values() if pt.get("transport") != "bot"]):
                        best_existing = cand
            if best_existing and best_existing.get("id"):
                existing_id = best_existing["id"]
                async with STORE.lock(existing_id):
                    live_room = await STORE.get(existing_id) or best_existing
                    add_participant(
                        live_room,
                        creator_cid,
                        {
                            "username": payload.get("creator") or "Lider",
                            "color": payload.get("color") or "#27DCC8",
                            "device": payload.get("device") or "Web",
                            "country": "TR",
                            "uid": verified_uid,
                            "isCreator": True,
                        },
                        "http",
                    )
                    live_room["host_id"] = creator_cid
                    set_media(live_room, media, live_room.get("creator") or "Lider", start=float(media.get("currentTime") or 0.0))
                    live_room["media"]["playing"] = True
                    live_room["rev"] = int(live_room.get("rev") or 1) + 5
                    sys_msg(live_room, f"Şu an oynatılıyor: {live_room['media']['title']}", live_room.get("creator") or "Lider")
                    await STORE.put(live_room, force_disk=True)
                _LOBBY_CACHE["ts"] = 0.0
                client_token = sign_client_token(existing_id, creator_cid)
                return JSONResponse({"ok": True, "clientId": creator_cid, "clientToken": client_token, "room": serialize(live_room, for_cid=creator_cid)})
        except Exception:
            pass
    room = new_room(room_id, name, payload.get("privacy", "public"), payload.get("playMode", "leader"),
                    payload.get("creator", ""), verified_uid or creator_cid, payload.get("password", ""))
    add_participant(
        room,
        creator_cid,
        {
            "username": payload.get("creator") or "Lider",
            "color": payload.get("color") or "#27DCC8",
            "device": payload.get("device") or "Web",
            "country": "TR",
            "uid": verified_uid,
            "isCreator": True,
        },
        "http",
    )
    room["host_id"] = creator_cid
    media = payload.get("media")
    if isinstance(media, dict) and (media.get("url") or media.get("videoId")):
        set_media(room, media, room["creator"] or "Lider", start=0.0)
        room["media"]["playing"] = True
    room["chat"] = []
    async with STORE.lock(room_id):
        await STORE.put(room, force_disk=True)
    _LOBBY_CACHE["ts"] = 0.0
    client_token = sign_client_token(room_id, creator_cid)
    return JSONResponse({"ok": True, "clientId": creator_cid, "clientToken": client_token, "room": serialize(room, for_cid=creator_cid)})


async def list_rooms(request: Request):
    t = now()
    if _LOBBY_CACHE["data"] is not None and t - float(_LOBBY_CACHE["ts"] or 0.0) < 1.5:
        return JSONResponse(_LOBBY_CACHE["data"], headers={"Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=5"})
    async with _LOBBY_LOCK:
        t = now()
        if _LOBBY_CACHE["data"] is not None and t - float(_LOBBY_CACHE["ts"] or 0.0) < 1.5:
            return JSONResponse(_LOBBY_CACHE["data"], headers={"Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=5"})
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
            if room.get("curated") and room.get("id") not in valid_curated:
                await STORE.delete(room["id"])
                continue
            removed = prune(room)
            p_map = room.get("participants") or {}
            has_humans = any(hp.get("transport") != "bot" for hp in p_map.values())
            needs_save = bool(removed)
            if room.get("curated"):
                spec = next((s for s in CURATED_LIVE_SPECS if s["id"] == room.get("id")), None)
                if spec and str(room.get("creator") or "").startswith("KINOX"):
                    room["creator"] = spec.get("creator", "Watchlivo 7/24")
                    if "kinox_bot" in p_map:
                        p_map["kinox_bot"]["name"] = room["creator"]
                    needs_save = True
                if not has_humans and (room.get("chat") or float((room.get("media") or {}).get("currentTime") or 0.0) > 0.0 or (spec and (room.get("media") or {}).get("url") != spec["media"]["url"])):
                    room["chat"] = []
                    room["polls"] = []
                    if spec:
                        set_media(room, spec["media"], spec.get("creator", "Watchlivo 7/24"), start=0.0)
                    elif room.get("media"):
                        room["media"]["currentTime"] = 0.0
                        room["media"]["updatedAt"] = t
                    needs_save = True
            if needs_save:
                async with STORE.lock(room["id"]):
                    await STORE.put(room)
            p_cnt = len(p_map)
            if (not p_cnt or not has_humans) and not room.get("curated"):
                if not p_cnt and t - room.get("lastActiveAt", t) > EMPTY_ROOM_TTL:
                    await STORE.delete(room["id"])
                continue
            if room["privacy"] == "private" or not p_cnt:
                continue
            candidates.append(room)
        candidates.sort(key=lambda r: (0 if not r.get("curated") else 1, -len(r.get("participants") or {}), CURATED_ORDER.get(r.get("id", ""), 999), r.get("id", "")))
        visible = [lobby_entry(r) for r in candidates[:60]]
        payload = {"rooms": visible, "shared": STORE.shared}
        _LOBBY_CACHE["ts"] = t
        _LOBBY_CACHE["data"] = payload
        return JSONResponse(payload, headers={"Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=5"})


async def room_info(request: Request):
    room_id = (request.path_params.get("room_id") or "").lower()
    room = (await STORE.get(room_id) or await ensure_curated_room(room_id)) if valid_room_id(room_id) else None
    if not room:
        return JSONResponse({"error": "Bu oda artık mevcut değil"}, status_code=404)
    return JSONResponse({"room": lobby_entry(room)})
