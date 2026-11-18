"""VORTEX web server (Starlette).

Serves the SPA, content search APIs and the mesh (room) engine from rooms.py.
Secrets come from environment variables (.env locally, Vercel env in production).
"""
import asyncio
import collections
import concurrent.futures
import hashlib
import hmac
import html as html_mod
import json
import os
import pathlib
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles

from security import RateLimiter, client_ip, is_safe_public_url, too_many_response


BASE_DIR = pathlib.Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"


def _load_dotenv() -> None:
    env = BASE_DIR / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))


_load_dotenv()
import rooms  # noqa: E402  (reads storage env vars at import)

IS_VERCEL = bool(os.environ.get("VERCEL"))
UPLOADS_DIR = pathlib.Path("/tmp/uploads") if IS_VERCEL else BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
TMDB_API_KEY = os.environ.get("TMDB_API_KEY")
GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL") or "claude-sonnet-4-5"
SUNO_MODEL = os.environ.get("SUNO_MODEL") or "suno-v4.5"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_CLOUD_FALLBACK_KEY = os.environ.get("OPENAI_CLOUD_FALLBACK_KEY", "")
SUNO_API_KEY = os.environ.get("SUNO_API_KEY", "")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
MAX_PAGE_BYTES = 3 * 1024 * 1024
UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"


def _raw_get_json(url: str, headers: dict = None, data: bytes = None, timeout: float = 6.5):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA137, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore"))


def _env_int(name: str, default: int) -> int:
    try:
        val = int((os.environ.get(name) or "").strip() or default)
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


# User uploads (own files only). Default 500 MB, override with MAX_UPLOAD_BYTES.
MAX_UPLOAD_BYTES = _env_int("MAX_UPLOAD_BYTES", 500 * 1024 * 1024)
ALLOWED_UPLOAD_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".ogg", ".wav"}


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        csp_nonce = secrets.token_urlsafe(16)
        scope["csp_nonce"] = csp_nonce

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                raw_hdrs = list(message.get("headers") or [])
                existing_keys = {hk.lower() for (hk, _) in raw_hdrs}
                hdrs = list(raw_hdrs)
                if b"x-content-type-options" not in existing_keys:
                    hdrs.append((b"x-content-type-options", b"nosniff"))
                if b"referrer-policy" not in existing_keys:
                    hdrs.append((b"referrer-policy", b"strict-origin-when-cross-origin"))
                if b"x-frame-options" not in existing_keys:
                    hdrs.append((b"x-frame-options", b"SAMEORIGIN"))
                if b"permissions-policy" not in existing_keys:
                    hdrs.append((b"permissions-policy", b"camera=(self), microphone=(self), geolocation=(), display-capture=(self), autoplay=*, fullscreen=*, picture-in-picture=*"))
                if b"strict-transport-security" not in existing_keys:
                    hdrs.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                if b"cross-origin-opener-policy" not in existing_keys:
                    hdrs.append((b"cross-origin-opener-policy", b"same-origin-allow-popups"))
                req_path = str(scope.get("path") or "")
                if b"content-security-policy" not in existing_keys:
                    csp_val = (
                        "default-src 'self'; "
                        f"script-src 'self' 'nonce-{csp_nonce}' blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://static.cloudflareinsights.com https://www.gstatic.com https://apis.google.com https://www.youtube.com https://s.ytimg.com https://player.vimeo.com https://www.googletagmanager.com https://www.google-analytics.com https://ssl.google-analytics.com; "
                        "worker-src 'self' blob:; "
                        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                        "font-src 'self' data: https://fonts.gstatic.com; "
                        "img-src 'self' data: blob: https:; "
                        "media-src 'self' data: blob: https:; "
                        "connect-src 'self' https: wss: ws: blob: data: http://127.0.0.1:* http://localhost:*; "
                        "frame-src 'self' https:; "
                        "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
                    ).encode("ascii")
                    hdrs.append((b"content-security-policy", csp_val))
                raw_qs = bytes(scope.get("query_string") or b"")
                if req_path.startswith("/uploads/"):
                    hdrs = [(hk, hv) for (hk, hv) in hdrs if hk.lower() not in (b"content-security-policy", b"content-disposition")]
                    hdrs.append((b"content-security-policy", b"default-src 'none'; sandbox"))
                    is_playable_upload = req_path.lower().endswith((".mp4", ".webm", ".mkv", ".mov", ".mp3", ".wav", ".ogg", ".m4a"))
                    hdrs.append((b"content-disposition", b"inline" if is_playable_upload else b"attachment"))
                if req_path in ("/desktop-auth.html", "/static/desktop-auth.html"):
                    hdrs = [(hk, hv) for (hk, hv) in hdrs if hk.lower() not in (b"cache-control", b"cdn-cache-control", b"vercel-cdn-cache-control", b"x-robots-tag")]
                    hdrs.append((b"cache-control", b"private, no-store, no-cache, must-revalidate, max-age=0"))
                    hdrs.append((b"cdn-cache-control", b"no-store"))
                    hdrs.append((b"x-robots-tag", b"noindex, nofollow"))
                elif req_path.startswith("/static/") and req_path.lower().endswith((".js", ".css", ".mjs")):
                    if b"v=" in raw_qs:
                        hdrs = [(hk, hv) for (hk, hv) in hdrs if hk.lower() != b"cache-control"]
                        hdrs.append((b"cache-control", b"public, max-age=31536000, immutable"))
                    elif b"cache-control" not in existing_keys:
                        hdrs.append((b"cache-control", b"public, max-age=0, must-revalidate"))
                if req_path == "/api/rooms" or req_path.startswith(("/api/user/", "/api/auth/", "/api/rave/social/", "/api/rave/notifications/", "/api/rave/voice-relay/", "/api/rave/ai-image", "/api/rave/yt-personalized-feed", "/api/rooms/")):
                    hdrs = [(hk, hv) for (hk, hv) in hdrs if hk.lower() not in (b"cache-control", b"cdn-cache-control", b"vercel-cdn-cache-control", b"vary")]
                    hdrs.append((b"cache-control", b"private, no-store, no-cache, must-revalidate, max-age=0"))
                    hdrs.append((b"cdn-cache-control", b"no-store"))
                    hdrs.append((b"vary", b"Authorization"))
                message = {**message, "headers": hdrs}
            await send(message)

        await self.app(scope, receive, send_wrapper)


IDENTITY_HEADER = b"authorization"
_UID_CACHE: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()


def _claims_from_token(token: str) -> dict:
    """Resolve a bearer token to verified claims (short 2s TTL cache, 5000 entries)."""
    if not token:
        return {}
    now_ts = time.time()
    hit = _UID_CACHE.get(token)
    if hit and hit[1] > now_ts:
        val = hit[0]
        return val if isinstance(val, dict) else {"uid": str(val or "")}
    try:
        import auth_engine
        claims = auth_engine.verify_any_token(token)
    except Exception:
        claims = None
    if isinstance(claims, dict) and claims.get("uid"):
        _UID_CACHE[token] = (claims, now_ts + 2.0)
        _UID_CACHE.move_to_end(token)
        while len(_UID_CACHE) > 5000:
            _UID_CACHE.popitem(last=False)
        return claims
    _UID_CACHE.pop(token, None)
    return {}


def _uid_from_token(token: str) -> str:
    """Resolve a bearer token to a verified uid (small TTL cache, 5000 entries)."""
    return str(_claims_from_token(token).get("uid") or "")


class IdentityMiddleware:
    """Attach the verified account id to the request scope without buffering streaming responses.

    Downstream handlers read ``scope["wl_uid"]``. A client-supplied ``uid`` field
    is never trusted, so identity cannot be spoofed by editing a JSON body.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            token = ""
            for hk, hv in scope.get("headers") or ():
                if hk.lower() == IDENTITY_HEADER:
                    val = hv.decode("latin-1", errors="ignore")
                    if val.lower().startswith("bearer "):
                        token = val[7:].strip()
                    break
            claims = _claims_from_token(token) if token else {}
            scope["wl_uid"] = str(claims.get("uid") or "")
            scope["wl_claims"] = claims
        await self.app(scope, receive, send)


# ---------------------------------------------------------------------------
# Outbound HTTP helpers (timeouts, size limits, SSRF guard for user-supplied URLs)
# ---------------------------------------------------------------------------
def _http(url: str, data: bytes = None, headers: dict = None, timeout: float = 6.0, limit: int = MAX_PAGE_BYTES) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit)


def _http_json(url: str, **kw):
    return json.loads(_http(url, **kw).decode("utf-8", errors="ignore"))


def public_http_url(url: str) -> bool:
    """Reject non-http(s) schemes and hosts resolving to private/loopback/link-local/CGNAT/NAT64 ranges (0-TTL SSRF guard)."""
    return is_safe_public_url(url)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not public_http_url(newurl):
            raise urllib.error.HTTPError(newurl, code, "blocked redirect", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _public_open(request, timeout=8.0):
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    if not public_http_url(url):
        raise ValueError("Geçersiz URL")
    return urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout)


# ---------------------------------------------------------------------------
# Content search (Rave SuperSearch: YouTube + titles with "where to watch" offers)
# ---------------------------------------------------------------------------
_YT_SEARCH_CACHE: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()


def _yt_search_sync(q: str):
    q_norm = str(q or "").strip().lower()
    now_ts = time.time()
    if q_norm:
        cached = _YT_SEARCH_CACHE.get(q_norm)
        if cached and now_ts - cached[1] < 300.0 and cached[0]:
            return list(cached[0])
    items = []
    try:
        html = _http("https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": q, "hl": "tr", "gl": "TR"}), timeout=4.2).decode("utf-8", errors="ignore")
        m = re.search(r"var ytInitialData\s*=\s*(\{.*?\});</script>", html, re.S)
        if m:
            data = json.loads(m.group(1))
            sections = (data.get("contents", {}).get("twoColumnSearchResultsRenderer", {}).get("primaryContents", {})
                        .get("sectionListRenderer", {}).get("contents", []))
            for sec in sections:
                for it in sec.get("itemSectionRenderer", {}).get("contents", []):
                    vr = it.get("videoRenderer")
                    if not vr or not vr.get("videoId"):
                        continue
                    vid = vr["videoId"]
                    title = "".join(r.get("text", "") for r in vr.get("title", {}).get("runs", [])) or "Video"
                    owner_runs = vr.get("ownerText", {}).get("runs", []) or vr.get("longBylineText", {}).get("runs", [])
                    channel = "".join(r.get("text", "") for r in owner_runs) or "YouTube"
                    ch_id = ""
                    if owner_runs and isinstance(owner_runs[0], dict):
                        ch_id = (((owner_runs[0].get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("browseId") or "")
                    ch_thumbs = ((((vr.get("channelThumbnailSupportedRenderers") or {}).get("channelThumbnailWithLinkRenderer") or {}).get("thumbnail") or {}).get("thumbnails") or [])
                    ch_avatar = ch_thumbs[-1].get("url", "") if ch_thumbs and isinstance(ch_thumbs[-1], dict) else ""
                    views = (vr.get("shortViewCountText") or {}).get("simpleText") or (vr.get("viewCountText") or {}).get("simpleText") or ""
                    published = (vr.get("publishedTimeText") or {}).get("simpleText") or ""
                    dur = vr.get("lengthText", {}).get("simpleText", "")
                    live = any("LIVE" in json.dumps(b).upper() or "CANLI" in json.dumps(b).upper() for b in (vr.get("badges") or []))
                    items.append({
                        "videoId": vid, "title": title, "channel": channel, "channelId": ch_id,
                        "channelAvatar": ch_avatar, "views": views, "published": published,
                        "duration": dur, "live": live,
                        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                        "url": f"https://www.youtube.com/watch?v={vid}",
                    })
                    if len(items) >= 24:
                        break
                if len(items) >= 24:
                    break
    except Exception:
        pass
    if not items:
        try:
            it_res = music_engine._yt_innertube_search_sync(q, 16)
            for r in (it_res or []):
                vid = r.get("videoId")
                if not vid:
                    continue
                d_s = int(r.get("duration") or 0)
                dur_str = f"{d_s // 60}:{d_s % 60:02d}" if d_s > 0 else "3:30"
                items.append({
                    "videoId": vid,
                    "title": r.get("title") or r.get("songTitle") or "Video",
                    "channel": r.get("artist") or "YouTube",
                    "duration": dur_str,
                    "live": False,
                    "thumbnail": r.get("poster") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "url": f"https://www.youtube.com/watch?v={vid}",
                })
        except Exception:
            pass
    if q_norm and items:
        _YT_SEARCH_CACHE[q_norm] = (list(items), now_ts)
        while len(_YT_SEARCH_CACHE) > 120:
            _YT_SEARCH_CACHE.popitem(last=False)
    return items


async def search_youtube(request: Request):
    q = (request.query_params.get("q") or "").strip()[:200]
    if not q:
        return JSONResponse({"items": []})
    try:
        items = await asyncio.wait_for(asyncio.to_thread(_yt_search_sync, q), timeout=9)
        return JSONResponse({"items": items})
    except Exception as e:
        return JSONResponse({"items": [], "error": f"YouTube araması başarısız: {type(e).__name__}"}, status_code=502)


_YT_NEXT_CACHE: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()
_YT_CHAN_CACHE: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()
_YT_FEED_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=6)
_YT_VID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _extract_yt_vid(raw_val: str) -> str:
    s = str(raw_val or "").strip()
    if _YT_VID_RE.match(s):
        return s
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{11})", s)
    return m.group(1) if m else ""


def _fmt_views_tr(n_str: str) -> str:
    try:
        v = int(str(n_str or "0").strip())
    except Exception:
        return ""
    if v <= 0:
        return ""
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}".replace(".0", "") + " Mn görüntüleme"
    if v >= 1_000:
        return f"{v // 1_000} B görüntüleme"
    return f"{v} görüntüleme"


def _parse_lockup_view_model(lvm: dict, exclude_vid: str = "") -> dict | None:
    if not isinstance(lvm, dict):
        return None
    vid = str(lvm.get("contentId") or "").strip()
    if not _YT_VID_RE.match(vid) or vid == exclude_vid:
        return None
    ctype = str(lvm.get("contentType") or "")
    if ctype and "VIDEO" not in ctype and "SHORT" not in ctype:
        return None
    meta = (lvm.get("metadata") or {}).get("lockupMetadataViewModel") or {}
    title = str(((meta.get("title") or {}).get("content") or "")).strip()
    if not title:
        return None
    av_vm = (meta.get("image") or {}).get("decoratedAvatarViewModel") or {}
    av_srcs = ((((av_vm.get("avatar") or {}).get("avatarViewModel") or {}).get("image") or {}).get("sources")) or []
    ch_avatar = str(av_srcs[-1].get("url") or "") if av_srcs and isinstance(av_srcs[-1], dict) else ""
    ch_id = str(((((((av_vm.get("rendererContext") or {}).get("commandContext") or {}).get("onTap") or {}).get("innertubeCommand") or {}).get("browseEndpoint") or {}).get("browseId") or "")).strip()
    rows = (((meta.get("metadata") or {}).get("contentMetadataViewModel") or {}).get("metadataRows")) or []
    channel = "YouTube"
    views = ""
    published = ""
    if len(rows) >= 1 and isinstance(rows[0], dict):
        p0 = rows[0].get("metadataParts") or []
        if p0 and isinstance(p0[0], dict):
            channel = str(((p0[0].get("text") or {}).get("content") or channel)).strip() or "YouTube"
    if len(rows) >= 2 and isinstance(rows[1], dict):
        p1 = rows[1].get("metadataParts") or []
        if len(p1) >= 1 and isinstance(p1[0], dict):
            views = str(((p1[0].get("text") or {}).get("content") or p1[0].get("accessibilityLabel") or "")).strip()
        if len(p1) >= 2 and isinstance(p1[1], dict):
            published = str(((p1[1].get("text") or {}).get("content") or "")).strip()
    dur = ""
    overlays = (((lvm.get("contentImage") or {}).get("thumbnailViewModel") or {}).get("overlays")) or []
    for ov in overlays:
        if not isinstance(ov, dict):
            continue
        badges = ((ov.get("thumbnailBottomOverlayViewModel") or {}).get("badges")) or []
        for b in badges:
            txt = str((((b or {}).get("thumbnailBadgeViewModel") or {}).get("text") or "")).strip()
            if txt and (":" in txt or "CANLI" in txt.upper() or "LIVE" in txt.upper()):
                dur = txt
                break
    live = ("CANLI" in dur.upper() or "LIVE" in dur.upper())
    return {
        "videoId": vid, "title": title, "channel": channel, "channelId": ch_id,
        "channelAvatar": ch_avatar, "views": views, "published": published,
        "duration": "" if live else dur, "live": live,
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "url": f"https://www.youtube.com/watch?v={vid}",
    }


def _yt_next_related_sync(video_id: str, reason: str = "") -> list:
    vid = _extract_yt_vid(video_id)
    if not vid:
        return []
    now_ts = time.time()
    cached = _YT_NEXT_CACHE.get(vid)
    base_items = None
    if cached and now_ts - cached[1] < 900.0:
        base_items = cached[0]
    if base_items is None:
        base_items = []
        seen = {vid}
        try:
            payload = json.dumps({
                "context": {
                    "client": {"clientName": "WEB", "clientVersion": "2.20250201.01.00", "hl": "tr", "gl": "TR"}
                },
                "videoId": vid,
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
                data=payload,
                headers={"Content-Type": "application/json", "User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9"},
            )
            with urllib.request.urlopen(req, timeout=5.5) as r:
                data = json.loads(r.read().decode("utf-8", errors="ignore"))

            def _walk(node):
                if len(base_items) >= 20:
                    return
                if isinstance(node, dict):
                    if "lockupViewModel" in node:
                        parsed = _parse_lockup_view_model(node["lockupViewModel"], exclude_vid=vid)
                        if parsed and parsed["videoId"] not in seen:
                            seen.add(parsed["videoId"])
                            base_items.append(parsed)
                    elif "compactVideoRenderer" in node:
                        cvr = node["compactVideoRenderer"]
                        cvid = str(cvr.get("videoId") or "")
                        if _YT_VID_RE.match(cvid) and cvid not in seen:
                            seen.add(cvid)
                            ctitle = (cvr.get("title") or {}).get("simpleText") or "".join(x.get("text", "") for x in (cvr.get("title") or {}).get("runs", []))
                            cchan = "".join(x.get("text", "") for x in (cvr.get("longBylineText") or {}).get("runs", [])) or "YouTube"
                            cdur = (cvr.get("lengthText") or {}).get("simpleText") or ""
                            cviews = (cvr.get("shortViewCountText") or {}).get("simpleText") or ""
                            cpub = (cvr.get("publishedTimeText") or {}).get("simpleText") or ""
                            clive = any("LIVE" in json.dumps(b).upper() or "CANLI" in json.dumps(b).upper() for b in (cvr.get("badges") or []))
                            if ctitle:
                                base_items.append({
                                    "videoId": cvid, "title": ctitle, "channel": cchan, "channelId": "",
                                    "channelAvatar": "", "views": cviews, "published": cpub,
                                    "duration": cdur, "live": clive,
                                    "thumbnail": f"https://i.ytimg.com/vi/{cvid}/hqdefault.jpg",
                                    "url": f"https://www.youtube.com/watch?v={cvid}",
                                })
                    for v in node.values():
                        if isinstance(v, (dict, list)):
                            _walk(v)
                elif isinstance(node, list):
                    for x in node:
                        if isinstance(x, (dict, list)):
                            _walk(x)

            _walk(data)
            if base_items:
                _YT_NEXT_CACHE[vid] = (base_items, now_ts)
                _YT_NEXT_CACHE.move_to_end(vid)
                while len(_YT_NEXT_CACHE) > 250:
                    _YT_NEXT_CACHE.popitem(last=False)
        except Exception:
            pass
    out = []
    for it in base_items:
        c = dict(it)
        if reason:
            c["reason"] = reason
        c["sourceKind"] = "collaborative"
        out.append(c)
    return out


def _yt_channel_feed_sync(channel_id: str, channel_name: str = "", channel_avatar: str = "") -> list:
    cid = str(channel_id or "").strip()
    cname = str(channel_name or "").strip()
    ck = f"{cid}|{cname.lower()}"
    now_ts = time.time()
    cached = _YT_CHAN_CACHE.get(ck)
    if cached and now_ts - cached[1] < 720.0:
        return [dict(x) for x in cached[0]]
    items = []
    if cid.startswith("UC") and len(cid) >= 20:
        try:
            feed_url = "https://www.youtube.com/feeds/videos.xml?" + urllib.parse.urlencode({"channel_id": cid})
            xml_bytes = _http(feed_url, timeout=4.5)
            root = ET.fromstring(xml_bytes)
            ns = {"atom": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015", "media": "http://search.yahoo.com/mrss/"}
            author_el = root.find("atom:author/atom:name", ns)
            resolved_ch = (author_el.text.strip() if author_el is not None and author_el.text else cname) or "YouTube"
            for entry in root.findall("atom:entry", ns)[:12]:
                vid_el = entry.find("yt:videoId", ns)
                tit_el = entry.find("atom:title", ns)
                pub_el = entry.find("atom:published", ns)
                stat_el = entry.find("media:group/media:community/media:statistics", ns)
                vid = vid_el.text.strip() if vid_el is not None and vid_el.text else ""
                tit = tit_el.text.strip() if tit_el is not None and tit_el.text else ""
                if not _YT_VID_RE.match(vid) or not tit:
                    continue
                pub_str = (pub_el.text[:10] if pub_el is not None and pub_el.text else "")
                v_cnt = _fmt_views_tr(stat_el.attrib.get("views", "") if stat_el is not None else "")
                items.append({
                    "videoId": vid, "title": tit, "channel": resolved_ch, "channelId": cid,
                    "channelAvatar": channel_avatar, "views": v_cnt, "published": pub_str,
                    "duration": "", "live": False,
                    "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "reason": f"🔔 {resolved_ch}",
                    "sourceKind": "subscription",
                })
        except Exception:
            pass
    if not items and cname:
        clean_handle = cname.lstrip("@").strip()
        for r in _yt_search_sync(f"{clean_handle} yeni video")[:10]:
            c = dict(r)
            if channel_avatar and not c.get("channelAvatar"):
                c["channelAvatar"] = channel_avatar
            if cid and not c.get("channelId"):
                c["channelId"] = cid
            c["reason"] = f"🔔 {cname}"
            c["sourceKind"] = "subscription"
            items.append(c)
    if items:
        _YT_CHAN_CACHE[ck] = (items, now_ts)
        while len(_YT_CHAN_CACHE) > 200:
            _YT_CHAN_CACHE.popitem(last=False)
    return [dict(x) for x in items]


def _build_yt_personalized_feed_sync(ukey: str, params: dict) -> dict:
    bundle = social_engine.get_user_yt_taste_bundle(ukey) if ukey else {
        "authenticated": False, "progress": [], "watchlist": [], "musicHistory": [], "ytPrefs": social_engine._default_yt_prefs()
    }
    prefs = bundle.get("ytPrefs") or {}
    prog_list = bundle.get("progress") or []
    wlist = bundle.get("watchlist") or []
    mhist = bundle.get("musicHistory") or []

    chip = str(params.get("chip") or "all").strip()[:80]
    dismissed_set = {str(x) for x in (prefs.get("dismissedVideoIds") or [])} | {str(x) for x in (params.get("dismissedVideoIds") or []) if x}
    blocked_ch = {str(x).lower() for x in (prefs.get("blockedChannels") or [])} | {str(x).lower() for x in (params.get("blockedChannels") or []) if x}

    followed = list(prefs.get("subscriptions") or [])
    seen_fch = {(str(c.get("channelId") or "") or str(c.get("name") or "").lower()) for c in followed}
    for c_in in (params.get("seedChannels") or []):
        if isinstance(c_in, dict):
            ck = str(c_in.get("channelId") or "") or str(c_in.get("name") or "").lower()
            if ck and ck not in seen_fch:
                seen_fch.add(ck)
                followed.append({"channelId": str(c_in.get("channelId") or ""), "name": str(c_in.get("name") or ""), "avatar": str(c_in.get("avatar") or "")})

    liked_vids = [x for x in (prefs.get("likedVideos") or []) if isinstance(x, dict) and _extract_yt_vid(x.get("videoId"))]
    liked_set = {_extract_yt_vid(x.get("videoId")) for x in liked_vids}
    prog_pct_map = {}
    seed_vids = []
    seen_sv = set()

    def _push_seed(vid_raw, label_raw):
        v = _extract_yt_vid(vid_raw)
        if v and v not in seen_sv and v not in dismissed_set:
            seen_sv.add(v)
            seed_vids.append((v, label_raw))

    for lv in liked_vids[:3]:
        short_t = str(lv.get("title") or "")[:28].strip()
        _push_seed(lv.get("videoId"), f"❤️ Beğendiğin: {short_t}" if short_t else "❤️ Beğenilerine göre")
    for p in prog_list:
        pv = _extract_yt_vid(p.get("videoId") or p.get("url") or p.get("sourceUrl"))
        if pv:
            prog_pct_map[pv] = float(p.get("percent") or 0.0)
            short_t = str(p.get("title") or "")[:28].strip()
            _push_seed(pv, f"✨ İzlediğin: {short_t}" if short_t else "✨ İzleme geçmişine göre")
    for w in wlist:
        wv = _extract_yt_vid(w.get("videoId") or w.get("url") or w.get("sourceUrl"))
        if wv:
            liked_set.add(wv)
            _push_seed(wv, "🔖 Listendeki videoya göre")
    for m in mhist[:4]:
        mv = _extract_yt_vid(m.get("videoId"))
        if mv:
            _push_seed(mv, f"🎵 Dinlediğin: {str(m.get('artist') or '')[:24]}".strip())
    for cv in (params.get("seedVideoIds") or [])[:6]:
        if isinstance(cv, dict):
            _push_seed(cv.get("videoId"), f"✨ İzlediğin: {str(cv.get('title') or '')[:26]}".strip() or "✨ Sana Özel")
        else:
            _push_seed(cv, "✨ İzleme geçmişine göre")

    freq_channels = list(followed[:5])
    seen_fc_names = {str(c.get("name") or "").lower() for c in freq_channels if c.get("name")}
    for p in prog_list:
        if str(p.get("provider") or "").lower() != "youtube":
            continue
        ch_n = str(p.get("channel") or "").strip()
        if ch_n and ch_n.lower() not in ("youtube", "sinema", "video") and "·" not in ch_n and ch_n.lower() not in seen_fc_names:
            seen_fc_names.add(ch_n.lower())
            freq_channels.append({"channelId": str(p.get("channelId") or ""), "name": ch_n, "avatar": str(p.get("channelAvatar") or "")})

    affinity_queries = []
    for sq in list(prefs.get("searchHistory") or [])[:3] + list(params.get("seedQueries") or [])[:3]:
        sq_s = str(sq or "").strip()[:80]
        if sq_s and sq_s.lower() not in {q[0].lower() for q in affinity_queries}:
            affinity_queries.append((sq_s, f"🔍 Araman: {sq_s[:24]}"))
    for m in mhist[:2]:
        art = str(m.get("artist") or "").strip()
        if art and art.lower() != "sanatçı" and len(affinity_queries) < 5:
            affinity_queries.append((f"{art} resmi klip canlı", f"🎵 {art}"))
    for p in prog_list[:3]:
        if str(p.get("provider") or "") != "youtube" and p.get("title") and len(affinity_queries) < 5:
            mt = str(p.get("seriesTitle") or p.get("title") or "").split("—")[0].strip()[:36]
            if mt:
                affinity_queries.append((f"{mt} fragman inceleme sahne", f"🎬 İzlediğin: {mt[:22]}"))

    chips = [
        {"id": "all", "label": "Tümü"},
        {"id": "for_you", "label": "✨ Sana Özel"},
        {"id": "subscriptions", "label": f"🔔 Takip Edilenler ({len(followed)})" if followed else "🔔 Takip Edilenler"},
        {"id": "recent", "label": "🆕 Yeni Yüklenenler"},
    ]
    for fc in freq_channels[:3]:
        fc_name = str(fc.get("name") or "").strip()
        fc_id = str(fc.get("channelId") or "").strip()
        if fc_name:
            chips.append({"id": f"ch:{fc_id}:{fc_name[:32]}", "label": f"📺 {fc_name[:20]}"})
    for aq, _ in affinity_queries[:2]:
        short_q = aq.replace("fragman inceleme sahne", "").replace("resmi klip canlı", "").strip()[:20]
        if short_q:
            chips.append({"id": f"q:{aq[:48]}", "label": f"🎯 {short_q}"})
    chips.extend([
        {"id": "music", "label": "🎵 Müzik"},
        {"id": "cinema", "label": "🎬 Sinema & Fragman"},
        {"id": "gaming", "label": "🎮 Oyun"},
        {"id": "live", "label": "🔴 Canlı"},
    ])

    futures = []
    if chip == "subscriptions":
        targets = followed[:5] or freq_channels[:4]
        for fc in targets:
            futures.append(_YT_FEED_POOL.submit(_yt_channel_feed_sync, fc.get("channelId", ""), fc.get("name", ""), fc.get("avatar", "")))
        if not futures:
            futures.append(_YT_FEED_POOL.submit(_yt_search_sync, "Türkiye popüler içerik üreticileri son video 2026"))
    elif chip.startswith("ch:"):
        parts = chip.split(":", 2)
        cid_p = parts[1] if len(parts) > 1 else ""
        cn_p = parts[2] if len(parts) > 2 else ""
        futures.append(_YT_FEED_POOL.submit(_yt_channel_feed_sync, cid_p, cn_p, ""))
        if cn_p:
            futures.append(_YT_FEED_POOL.submit(_yt_search_sync, f"{cn_p} popüler videolar"))
    elif chip.startswith("q:"):
        q_val = chip[2:].strip()
        futures.append(_YT_FEED_POOL.submit(_yt_search_sync, q_val))
    elif chip in ("music", "cinema", "gaming", "live", "recent"):
        cat_map = {
            "music": "Türkçe pop alternatif rap hit video klip 2026",
            "cinema": "yeni film dizi resmi fragman inceleme Türkçe 2026",
            "gaming": "Türkçe oyun inceleme gameplay eğlence 2026",
            "live": "Türkiye canlı yayın haber müzik spor live",
            "recent": "Türkiye bu hafta yeni yüklenen popüler videolar 2026",
        }
        if chip == "recent" and freq_channels:
            for fc in freq_channels[:2]:
                futures.append(_YT_FEED_POOL.submit(_yt_channel_feed_sync, fc.get("channelId", ""), fc.get("name", ""), fc.get("avatar", "")))
        futures.append(_YT_FEED_POOL.submit(_yt_search_sync, cat_map[chip]))
        if seed_vids and chip in ("music", "cinema", "for_you"):
            futures.append(_YT_FEED_POOL.submit(_yt_next_related_sync, seed_vids[0][0], seed_vids[0][1]))
    else:
        for sv_id, sv_lbl in seed_vids[:3]:
            futures.append(_YT_FEED_POOL.submit(_yt_next_related_sync, sv_id, sv_lbl))
        if chip != "for_you":
            for fc in freq_channels[:2]:
                futures.append(_YT_FEED_POOL.submit(_yt_channel_feed_sync, fc.get("channelId", ""), fc.get("name", ""), fc.get("avatar", "")))
        for aq_q, aq_lbl in affinity_queries[:2]:
            def _run_aff(q_str=aq_q, lbl_str=aq_lbl):
                return [{**x, "reason": lbl_str, "sourceKind": "affinity"} for x in _yt_search_sync(q_str)[:10]]
            futures.append(_YT_FEED_POOL.submit(_run_aff))
        if len(futures) < 2:
            futures.append(_YT_FEED_POOL.submit(_yt_search_sync, "Türkiye popüler müzik sinema teknoloji eğlence 2026"))

    buckets = []
    done, _ = concurrent.futures.wait(futures, timeout=6.5)
    for fut in futures:
        if fut in done:
            try:
                res_list = fut.result()
                if isinstance(res_list, list) and res_list:
                    buckets.append(res_list)
            except Exception:
                pass

    followed_ids = {str(c.get("channelId") or "") for c in followed if c.get("channelId")}
    followed_names = {str(c.get("name") or "").lower() for c in followed if c.get("name")}
    merged = []
    seen_out = set()
    max_len = max((len(b) for b in buckets), default=0)
    for idx in range(max_len):
        for b in buckets:
            if idx >= len(b):
                continue
            it = b[idx]
            vid = _extract_yt_vid(it.get("videoId"))
            if not vid or vid in seen_out or vid in dismissed_set:
                continue
            ch_low = str(it.get("channel") or "").lower()
            ch_id = str(it.get("channelId") or "")
            if (ch_low and ch_low in blocked_ch) or (ch_id and ch_id.lower() in blocked_ch):
                continue
            if prog_pct_map.get(vid, 0.0) >= 95.0 and chip in ("all", "for_you"):
                continue
            seen_out.add(vid)
            item_out = dict(it)
            item_out["isLiked"] = vid in liked_set
            item_out["isFollowedChannel"] = bool((ch_id and ch_id in followed_ids) or (ch_low and ch_low in followed_names))
            item_out["watchedPercent"] = round(prog_pct_map.get(vid, 0.0), 1)
            if not item_out.get("reason"):
                item_out["reason"] = "✨ Sana Özel" if (seed_vids or affinity_queries) else "🔥 Önerilen"
            merged.append(item_out)
            if len(merged) >= 32:
                break
        if len(merged) >= 32:
            break

    has_signals = bool(seed_vids or followed or affinity_queries)
    return {
        "ok": True,
        "authenticated": bool(ukey),
        "personalized": has_signals,
        "chip": chip,
        "chips": chips,
        "followedChannels": followed[:30],
        "signalSummary": {
            "seedVideos": len(seed_vids),
            "followedChannels": len(followed),
            "affinityTopics": len(affinity_queries),
        },
        "items": merged,
    }


async def yt_personalized_feed(request: Request):
    ukey = social_engine._verified_account_key(request)
    params: dict = dict(request.query_params)
    if request.method == "POST":
        try:
            body = await request.json()
            if isinstance(body, dict):
                params.update(body)
        except Exception:
            pass
    try:
        data = await asyncio.wait_for(asyncio.to_thread(_build_yt_personalized_feed_sync, ukey, params), timeout=8.5)
        return JSONResponse(data, headers=social_engine._PRIVATE_HEADERS)
    except Exception as e:
        return JSONResponse({"ok": False, "items": [], "chips": [], "error": f"Akış yüklenemedi: {type(e).__name__}"}, status_code=502, headers=social_engine._PRIVATE_HEADERS)


_BIDI_CTRL_RE = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]")


JW_QUERY = ("query GetSearchTitles($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) { popularTitles(country: $country, first: $first, filter: $filter) "
            "{ edges { node { id objectType content(country: $country, language: $language) { title originalReleaseYear posterUrl externalIds { imdbId tmdbId } } "
            "offers(country: $country, platform: WEB) { monetizationType standardWebURL package { clearName shortName } } } } } }")


def _justwatch_sync(q: str = "", packages=None, country: str = "TR", first: int = 16):
    flt = {}
    if q:
        flt["searchQuery"] = q
    if packages:
        flt["packages"] = packages
    pkg_set = set(packages or [])
    body = json.dumps({"operationName": "GetSearchTitles", "query": JW_QUERY,
                       "variables": {"country": country, "language": "tr", "first": first, "filter": flt}}).encode()
    data = json.loads(_http("https://apis.justwatch.com/graphql", data=body, headers={"Content-Type": "application/json"}, timeout=6).decode("utf-8", errors="ignore"))
    results = []
    for e in data.get("data", {}).get("popularTitles", {}).get("edges", []):
        node = e.get("node") or {}
        content = node.get("content") or {}
        ext = content.get("externalIds") or {}
        seen, offers = set(), []
        for off in node.get("offers") or []:
            pkg = (off.get("package") or {}).get("clearName") or ""
            short = (off.get("package") or {}).get("shortName") or ""
            url = off.get("standardWebURL") or ""
            if pkg and url and pkg not in seen:
                seen.add(pkg)
                offers.append({"provider": pkg, "short": short, "url": url, "type": off.get("monetizationType", "")})
        if pkg_set:
            pkg_offers = [o for o in offers if o.get("short") in pkg_set]
            if not pkg_offers:
                continue
            offers.sort(key=lambda o: 0 if o.get("short") in pkg_set else 1)
        raw = content.get("posterUrl") or ""
        poster_u = f"https://images.justwatch.com{raw.replace('{profile}', 's332').replace('{format}', 'webp')}" if raw else ""
        obj_type = node.get("objectType") or "MOVIE"
        results.append({
            "id": node.get("id"),
            "type": obj_type,
            "mediaType": "tv" if obj_type == "SHOW" else "movie",
            "tmdbId": str(ext.get("tmdbId") or ""),
            "imdbId": str(ext.get("imdbId") or ""),
            "title": content.get("title"),
            "originalTitle": content.get("title"),
            "year": str(content.get("originalReleaseYear") or ""),
            "rating": 8.0,
            "poster": poster_u,
            "backdrop": poster_u,
            "officialUrl": offers[0]["url"] if offers else "",
            "offers": offers[:8],
        })
    return results


_SUB_VTT_CACHE = collections.OrderedDict()
_TTS_CACHE = collections.OrderedDict()


_SUPERSEARCH_CACHE: dict[str, tuple[float, dict]] = {}


def _tmdb_search_sync(q: str, limit: int = 20) -> list:
    """TMDB title search: metadata only (title, year, poster, overview).

    Results never carry a stream URL. Where-to-watch offers come from JustWatch
    and point at the official platform pages.
    """
    if not TMDB_API_KEY or not q:
        return []
    url = "https://api.themoviedb.org/3/search/multi?" + urllib.parse.urlencode(
        {"api_key": TMDB_API_KEY, "language": "tr-TR", "query": q, "include_adult": "false", "page": 1}
    )
    data = _http_json(url, timeout=5.0) or {}
    out = []
    for r in data.get("results") or []:
        mtype = r.get("media_type")
        if mtype not in ("movie", "tv"):
            continue
        tid = str(r.get("id") or "")
        poster = f"https://image.tmdb.org/t/p/w500{r['poster_path']}" if r.get("poster_path") else ""
        backdrop = f"https://image.tmdb.org/t/p/w780{r['backdrop_path']}" if r.get("backdrop_path") else poster
        title = (r.get("title") or r.get("name") or "").strip()
        out.append({
            "id": tid, "tmdbId": tid, "mediaType": mtype,
            "title": title,
            "originalTitle": (r.get("original_title") or r.get("original_name") or title).strip(),
            "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],
            "rating": round(float(r.get("vote_average") or 0), 1),
            "overview": (r.get("overview") or "")[:260],
            "poster": poster, "backdrop": backdrop,
        })
        if len(out) >= limit:
            break
    return out


async def supersearch(request: Request):
    q = _BIDI_CTRL_RE.sub("", request.query_params.get("q") or "").strip()[:200]
    if not q:
        return JSONResponse({"youtube": [], "tmdb": [], "justwatch": []})
    qkey = q.replace("İ", "i").replace("I", "ı").lower()
    cached = _SUPERSEARCH_CACHE.get(qkey)
    cc_hdrs = {"Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900"}
    if cached and time.time() - cached[0] < 300:
        return JSONResponse(cached[1], headers=cc_hdrs)
    res = await asyncio.gather(asyncio.to_thread(_yt_search_sync, q), asyncio.to_thread(_tmdb_search_sync, q), asyncio.to_thread(_justwatch_sync, q), return_exceptions=True)
    yt, tmdb, jw = [r if isinstance(r, list) else [] for r in res]
    payload = {"query": q, "youtube": yt, "tmdb": tmdb, "justwatch": jw}
    try:
        _track_analytics_sync("search", query=q)
    except Exception:
        pass
    if len(_SUPERSEARCH_CACHE) >= 250:
        _SUPERSEARCH_CACHE.pop(next(iter(_SUPERSEARCH_CACHE)), None)
    _SUPERSEARCH_CACHE[qkey] = (time.time(), payload)
    return JSONResponse(payload, headers=cc_hdrs)


async def gifs(request: Request):
    q = (request.query_params.get("q") or "").strip()[:80]
    if not GIPHY_API_KEY:
        return JSONResponse({"gifs": [], "error": "GIF servisi yapılandırılmamış"})
    ep = "search" if q else "trending"
    url = f"https://api.giphy.com/v1/gifs/{ep}?" + urllib.parse.urlencode({"api_key": GIPHY_API_KEY, "q": q, "limit": 24, "rating": "pg-13"})
    try:
        data = await asyncio.to_thread(_http_json, url)
    except Exception:
        return JSONResponse({"gifs": []})
    out = []
    for g in data.get("data", []):
        im = g.get("images", {})
        full, small = (im.get("fixed_height") or {}).get("url"), (im.get("fixed_height_small") or {}).get("url")
        if full:
            out.append({"id": g.get("id"), "title": g.get("title", "GIF"), "url": full, "preview": small or full})
    return JSONResponse({"gifs": out})


# ---------------------------------------------------------------------------
# Link resolution (Rave captureURLChange -> idParser -> fetchSelected for web-playable sources)
# ---------------------------------------------------------------------------
YT_RE = re.compile(r"(?:youtube\.com/(?:[^/\n\s]+/\s*)?(?:v/|u/\w/|live/|embed/|watch\?v=|&v=|shorts/)|youtu\.be/)([^\"&?/\s]{11})", re.I)


async def vimeo_oembed(request: Request):
    url = (request.query_params.get("url") or "").strip()
    if not re.match(r"^https?://(www\.|player\.)?vimeo\.com/", url):
        return JSONResponse({"error": "Geçersiz Vimeo bağlantısı"}, status_code=400)
    try:
        data = await asyncio.to_thread(_http_json, "https://vimeo.com/api/oembed.json?" + urllib.parse.urlencode({"url": url}))
        return JSONResponse({k: data.get(k) for k in ("title", "author_name", "thumbnail_url", "duration", "video_id")})
    except Exception:
        return JSONResponse({"error": "Vimeo bilgisi alınamadı (video gizli olabilir)"}, status_code=404)


# Platforms watched the Rave way: every participant signs in to their OWN
# account inside the native app's in-app browser. The server never sees
# credentials or cookies and never serves the video; it only relays
# play/pause/seek through the room sync engine (rooms.py).
RAVE_PROVIDERS_SPEC = {
    "netflix": {"name": "Netflix", "domain": ".netflix.com", "loginUrl": "https://www.netflix.com/login", "browseUrl": "https://www.netflix.com/browse"},
    "disney": {"name": "Disney+", "domain": ".disneyplus.com", "loginUrl": "https://www.disneyplus.com/login", "browseUrl": "https://www.disneyplus.com/home"},
    "prime": {"name": "Prime Video", "domain": ".primevideo.com", "loginUrl": "https://www.primevideo.com/auth-redirect", "browseUrl": "https://www.primevideo.com"},
    "max": {"name": "Max", "domain": ".max.com", "loginUrl": "https://auth.max.com/login", "browseUrl": "https://play.max.com"},
    "crunchyroll": {"name": "Crunchyroll", "domain": ".crunchyroll.com", "loginUrl": "https://sso.crunchyroll.com/login", "browseUrl": "https://www.crunchyroll.com/videos/popular"},
    "tubi": {"name": "Tubi", "domain": ".tubitv.com", "loginUrl": "https://tubitv.com/login", "browseUrl": "https://tubitv.com/home"},
    "exxen": {"name": "Exxen", "domain": ".exxen.com", "loginUrl": "https://www.exxen.com/tr/sign-in", "browseUrl": "https://www.exxen.com/tr"},
    "blutv": {"name": "BluTV", "domain": ".blutv.com", "loginUrl": "https://www.blutv.com/giris", "browseUrl": "https://www.blutv.com"},
    "gain": {"name": "GAİN", "domain": ".gain.tv", "loginUrl": "https://www.gain.tv/giris", "browseUrl": "https://www.gain.tv"},
    "tod": {"name": "TOD", "domain": ".todtv.com.tr", "loginUrl": "https://www.todtv.com.tr/giris", "browseUrl": "https://www.todtv.com.tr"},
    "tabii": {"name": "tabii", "domain": ".tabii.com", "loginUrl": "https://www.tabii.com/tr/login", "browseUrl": "https://www.tabii.com/tr"},
    "tvplus": {"name": "TV+", "domain": ".tvplus.com.tr", "loginUrl": "https://tvplus.com.tr/giris", "browseUrl": "https://tvplus.com.tr"},
    "puhutv": {"name": "puhutv", "domain": ".puhutv.com", "loginUrl": "https://puhutv.com/giris", "browseUrl": "https://puhutv.com"},
    "mubi": {"name": "MUBI", "domain": ".mubi.com", "loginUrl": "https://mubi.com/tr/login", "browseUrl": "https://mubi.com/tr/showing"},
    "apple": {"name": "Apple TV+", "domain": ".apple.com", "loginUrl": "https://tv.apple.com/tr", "browseUrl": "https://tv.apple.com/tr"},
    "hulu": {"name": "Hulu", "domain": ".hulu.com", "loginUrl": "https://auth.hulu.com/web/login", "browseUrl": "https://www.hulu.com/hub/home"},
    "paramount": {"name": "Paramount+", "domain": ".paramountplus.com", "loginUrl": "https://www.paramountplus.com/account/signin/", "browseUrl": "https://www.paramountplus.com/home/"},
    "peacock": {"name": "Peacock", "domain": ".peacocktv.com", "loginUrl": "https://www.peacocktv.com/signin", "browseUrl": "https://www.peacocktv.com/watch/home"},
    "plex": {"name": "Plex", "domain": ".plex.tv", "loginUrl": "https://app.plex.tv/auth", "browseUrl": "https://watch.plex.tv"},
    "pluto": {"name": "Pluto TV", "domain": ".pluto.tv", "loginUrl": "https://pluto.tv/sign-in", "browseUrl": "https://pluto.tv"},
    "kick": {"name": "Kick", "domain": ".kick.com", "loginUrl": "https://kick.com/", "browseUrl": "https://kick.com"},
    "tiktok": {"name": "TikTok", "domain": ".tiktok.com", "loginUrl": "https://www.tiktok.com/login", "browseUrl": "https://www.tiktok.com"},
    "dailymotion": {"name": "Dailymotion", "domain": ".dailymotion.com", "loginUrl": "https://www.dailymotion.com/signin", "browseUrl": "https://www.dailymotion.com"},
    "dropbox": {"name": "Dropbox", "domain": ".dropbox.com", "loginUrl": "https://www.dropbox.com/login", "browseUrl": "https://www.dropbox.com/home"},
    "youtube": {"name": "YouTube", "domain": ".youtube.com", "loginUrl": "https://accounts.google.com/ServiceLogin?service=youtube", "browseUrl": "https://www.youtube.com"},
    "drive": {"name": "Google Drive", "domain": ".google.com", "loginUrl": "https://accounts.google.com/ServiceLogin?service=wise", "browseUrl": "https://drive.google.com/drive/my-drive"},
    "twitch": {"name": "Twitch", "domain": ".twitch.tv", "loginUrl": "https://www.twitch.tv/login", "browseUrl": "https://www.twitch.tv"},
    "vimeo": {"name": "Vimeo", "domain": ".vimeo.com", "loginUrl": "https://vimeo.com/log_in", "browseUrl": "https://vimeo.com/watch"},
}


async def rave_get_accounts(request: Request):
    """Static directory of supported platforms for the in-app browser.

    No credentials, cookies or session state are accepted, stored or returned.
    """
    accounts = {
        pkey: {"provider": pkey, "name": spec["name"], "domain": spec["domain"], "loginUrl": spec["loginUrl"], "browseUrl": spec["browseUrl"]}
        for pkey, spec in RAVE_PROVIDERS_SPEC.items()
    }
    return JSONResponse({"accounts": accounts}, headers={"Cache-Control": "public, max-age=3600"})


def _norm_vtt_ts_tok(tok: str) -> str:
    m = re.match(r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$", (tok or "").strip())
    if not m:
        return tok.replace(",", ".")
    hh = int(m.group(1) or 0)
    mm = int(m.group(2))
    ss = int(m.group(3))
    ms = (m.group(4) or "000").ljust(3, "0")[:3]
    return f"{hh:02d}:{mm:02d}:{ss:02d}.{ms}"


def _norm_vtt_ts_line(ts_line: str) -> str:
    lhs, sep, rhs_full = ts_line.partition("-->")
    if not sep:
        return ts_line
    rhs_parts = rhs_full.strip().split(None, 1)
    if not rhs_parts:
        return ts_line
    start_norm = _norm_vtt_ts_tok(lhs.strip())
    end_norm = _norm_vtt_ts_tok(rhs_parts[0])
    extra = re.sub(r"[<>\"']", "", rhs_parts[1]).strip() if len(rhs_parts) > 1 else ""
    return f"{start_norm} --> {end_norm}" + (f" {extra}" if extra else "")


def _srt_to_vtt(raw_bytes) -> str:
    txt = ""
    if isinstance(raw_bytes, str):
        txt = raw_bytes
    else:
        if raw_bytes.startswith((b"\xff\xfe", b"\xfe\xff")):
            encs = ("utf-16", "utf-8-sig", "cp1254", "latin-1")
        elif len(raw_bytes) >= 4 and raw_bytes.count(b"\x00") > len(raw_bytes) // 5:
            bomless_u16 = "utf-16-le" if (len(raw_bytes) >= 2 and raw_bytes[1] == 0) else "utf-16-be"
            encs = (bomless_u16, "utf-16", "utf-8-sig", "cp1254", "latin-1")
        else:
            encs = ("utf-8-sig", "utf-8", "cp1254", "latin-1")
        for enc in encs:
            try:
                txt = raw_bytes.decode(enc)
                break
            except Exception:
                continue
    txt = txt.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if "<p " in txt and "begin=" in txt:
        cues = []
        for idx, m in enumerate(re.finditer(r'<p[^>]*\bbegin=["\']([^"\']+)["\'][^>]*\bend=["\']([^"\']+)["\'][^>]*>(.*?)</p>', txt, re.I | re.S), 1):
            b = _norm_vtt_ts_tok(m.group(1))
            e = _norm_vtt_ts_tok(m.group(2))
            body = re.sub(r"<br\s*/?>", "\n", m.group(3), flags=re.I)
            body = html_mod.unescape(body)
            body = re.sub(r"<[^>]*>", "", body).replace("<", "").replace(">", "").strip()
            if body:
                cues.append(f"{idx}\n{b} --> {e}\n{body}")
        return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    if "<text " in txt and "start=" in txt:
        cues = []
        def _fmt_sec(sec_f: float) -> str:
            sec_f = max(0.0, sec_f)
            hh = int(sec_f // 3600)
            mm = int((sec_f % 3600) // 60)
            ss = sec_f % 60
            return f"{hh:02d}:{mm:02d}:{ss:06.3f}"
        for idx, m in enumerate(re.finditer(r'<text[^>]*\bstart=["\']([\d.]+)["\'][^>]*?(?:\bdur=["\']([\d.]+)["\'])?[^>]*>(.*?)</text>', txt, re.I | re.S), 1):
            st_f = float(m.group(1) or 0)
            dur_f = float(m.group(2) or 3.0)
            body = html_mod.unescape(m.group(3) or "")
            body = re.sub(r"<[^>]*>", " ", body).replace("<", "").replace(">", "").strip()
            if body:
                cues.append(f"{idx}\n{_fmt_sec(st_f)} --> {_fmt_sec(st_f + max(0.5, dur_f))}\n{body}")
        return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    if "[Events]" in txt or re.search(r"(?m)^Dialogue:\s*\d+,", txt):
        cues = []
        for idx, m in enumerate(re.finditer(r"(?m)^Dialogue:\s*[^,]*,(\d+:\d{2}:\d{2}[.,]\d{1,3}),(\d+:\d{2}:\d{2}[.,]\d{1,3}),([^,]*),(?:[^,]*,){5}(.+)$", txt), 1):
            style_name = (m.group(3) or "").strip()
            raw_ass_txt = m.group(4) or ""
            if re.search(r"\{\\[^}]*\\p[1-9]\b", raw_ass_txt) or re.search(r"(?:^|[\s_-])(?:sign|signs|drawing|rune|fx|karaoke|shape|logo)(?:$|[\s_-])", style_name, re.I):
                continue
            b_ts = _norm_vtt_ts_tok(m.group(1))
            e_ts = _norm_vtt_ts_tok(m.group(2))
            body = re.sub(r"\{[^}]*\}", "", raw_ass_txt)
            body = re.sub(r"\\[nN]", "\n", body).replace("\\h", " ")
            body = html_mod.unescape(body)
            body = re.sub(r"<[^>]*>", "", body).replace("<", "").replace(">", "").strip()
            if body:
                cues.append(f"{len(cues) + 1}\n{b_ts} --> {e_ts}\n{body}")
        return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    txt = re.sub(r"\{\\[^}]*\}", "", txt)
    txt = re.sub(r"<br\s*/?>", "\n", txt, flags=re.I)
    txt = html_mod.unescape(txt)
    txt = re.sub(r"</?[a-zA-Z!][^>\n]*>", "", txt)
    txt = re.sub(r"^X-TIMESTAMP-MAP[^\n]*\n?", "", txt, flags=re.M)
    txt = re.sub(
        r"(?im)^.*?(?:ai\.opensubtitles\.com|opensubtitles\.org|osdb\.link|advertise your product or brand here|support us and become vip|do you want subtitles for any video|www\.altyazi\.org|turkcealtyazi\.org|subscene\.com|deneme\s*bonusu|freespin|t\.me/|(?:bahis|casino|telegram)[^\n]*(?:https?://|www\.|@[a-z0-9_]{3,}|\.(?:com|net|org|xyz|bet|io)|bonus|güncel\s*giriş)|çeviri\s*:|senkron\s*:|iyi seyirler dileriz).*$\n?",
        "",
        txt,
    )
    txt = re.sub(r"[♪♫♬♩]+", " ", txt)
    txt = re.sub(r"(?im)^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$\n?", "", txt)
    raw_blocks = re.split(r"\n{2,}", txt.strip())
    cleaned_blocks = []
    prev_ts_norm = ("", "")
    for blk in raw_blocks:
        b_lines = [ln.strip() for ln in blk.splitlines() if ln.strip()]
        if not b_lines:
            continue
        if b_lines[0].startswith("WEBVTT") or b_lines[0].startswith("NOTE") or b_lines[0].startswith("STYLE"):
            continue
        ts_idx = -1
        for i_ln, ln in enumerate(b_lines):
            if "-->" in ln:
                ts_idx = i_ln
                break
        if ts_idx < 0:
            continue
        ts_line = _norm_vtt_ts_line(b_lines[ts_idx])
        payload_lines = b_lines[ts_idx + 1:]
        dedup_payload = []
        seen_ln = set()
        for pl in payload_lines:
            pl_clean = re.sub(r"<[^>]*>", "", pl).replace("<", "").replace(">", "").strip()
            norm_k = re.sub(r"\W+", " ", pl_clean.lower()).strip()
            if not norm_k or norm_k in seen_ln:
                continue
            seen_ln.add(norm_k)
            dedup_payload.append(pl_clean)
        if not dedup_payload:
            continue
        joined_payload = "\n".join(dedup_payload)
        cur_sig = (ts_line.split("-->")[0].strip()[:8], joined_payload.lower())
        if cur_sig == prev_ts_norm:
            continue
        prev_ts_norm = cur_sig
        cleaned_blocks.append(f"{ts_line}\n{joined_payload}")
    return "WEBVTT\n\n" + "\n\n".join(cleaned_blocks) + "\n"


_VTT_CACHE_LOCK = threading.Lock()
_TTS_CACHE_LOCK = threading.Lock()


_ISO_TO_TR_NAME = {
    "tr": "Türkçe", "en": "İngilizce", "de": "Almanca", "es": "İspanyolca",
    "fr": "Fransızca", "it": "İtalyanca", "ru": "Rusça", "ar": "Arapça",
    "pt": "Portekizce", "nl": "Felemenkçe", "pl": "Lehçe", "ja": "Japonca",
    "ko": "Korece", "uk": "Ukraynaca", "el": "Yunanca",
}
_AUDIO_LANG_FLAGS = {"tr": "🇹🇷", "en": "🇬🇧", "ja": "🇯🇵", "ko": "🇰🇷", "de": "🇩🇪", "fr": "🇫🇷", "es": "🇪🇸", "it": "🇮🇹", "ru": "🇷🇺", "ar": "🇸🇦", "pt": "🇵🇹", "nl": "🇳🇱", "pl": "🇵🇱", "zh": "🇨🇳", "hi": "🇮🇳"}
_AUDIO_LANG_TR_NAMES = {**_ISO_TO_TR_NAME, "zh": "Çince", "hi": "Hintçe"}


def _fetch_vtt_sync(url: str, timeout: float = 8.0) -> str:
    """Fetch a public subtitle file (YouTube caption track or a user-supplied .vtt/.srt) and normalise it to WebVTT."""
    with _VTT_CACHE_LOCK:
        if url in _SUB_VTT_CACHE:
            _SUB_VTT_CACHE.move_to_end(url)
            return _SUB_VTT_CACHE[url]
    # YouTube caption tracks returned by the iOS player API are bound to that client.
    is_yt_caption = urllib.parse.urlparse(url).hostname in ("www.youtube.com", "youtube.com") and "/api/timedtext" in url
    hdrs = {
        "User-Agent": "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)" if is_yt_caption else UA137,
        "Accept": "*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    }
    raw = b""
    try:
        req = urllib.request.Request(url, headers=hdrs)
        with _public_open(req, timeout=timeout) as r:
            raw = r.read(2 * 1024 * 1024)
    except Exception:
        raw = b""
    if not raw:
        return ""
    if raw[:2] == b"\x1f\x8b":
        try:
            import zlib
            raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw, max_length=4 * 1024 * 1024)
        except Exception:
            pass
    vtt = _srt_to_vtt(raw)
    if vtt and vtt.count("-->") >= 1:
        with _VTT_CACHE_LOCK:
            _SUB_VTT_CACHE[url] = vtt
            _SUB_VTT_CACHE.move_to_end(url)
            while len(_SUB_VTT_CACHE) > 300:
                _SUB_VTT_CACHE.popitem(last=False)
    return vtt


def _translate_vtt_to_tr_sync(vtt: str, target_lang: str = "tr") -> str:
    tl_code = re.sub(r"[^a-z-]", "", (target_lang or "tr").strip().lower())[:5] or "tr"
    ck = f"{tl_code}_vtt:{hashlib.md5(vtt[:4096].encode('utf-8', errors='ignore')).hexdigest()}:{len(vtt)}"
    with _VTT_CACHE_LOCK:
        if ck in _SUB_VTT_CACHE:
            _SUB_VTT_CACHE.move_to_end(ck)
            return _SUB_VTT_CACHE[ck]
    blocks = vtt.split("\n\n")
    cue_indices = []
    cue_texts = []
    parsed_blocks = []
    for idx, blk in enumerate(blocks):
        lines = blk.strip().split("\n")
        ts_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), -1)
        if ts_idx >= 0 and ts_idx + 1 < len(lines):
            txt = " ".join(re.sub(r"<[^>]+>", "", ln).strip() for ln in lines[ts_idx + 1:] if ln.strip())
            parsed_blocks.append((lines[:ts_idx + 1], txt))
            if txt:
                cue_indices.append(idx)
                cue_texts.append(txt)
        else:
            parsed_blocks.append((lines, None))
    if not cue_texts:
        return vtt
    import concurrent.futures
    batches = []
    cur_b, cur_i, cur_len = [], [], 0
    for c_i, c_t in zip(cue_indices, cue_texts):
        if cur_len + len(c_t) > 1500 or len(cur_b) >= 28:
            batches.append((cur_i, cur_b))
            cur_b, cur_i, cur_len = [], [], 0
        cur_b.append(c_t)
        cur_i.append(c_i)
        cur_len += len(c_t) + 4
    if cur_b:
        batches.append((cur_i, cur_b))
    batches = batches[:40]

    def _tr_batch(b_tuple):
        b_idxs, b_txts = b_tuple
        joined = "\n ||| \n".join(b_txts)
        u = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={tl_code}&dt=t&q={urllib.parse.quote(joined)}"
        try:
            data = _raw_get_json(u, headers={"User-Agent": UA137}, timeout=3.5)
            full_tr = "".join(seg[0] for seg in (data[0] or []) if seg and seg[0])
            parts = [p.strip() for p in re.split(r"\s*\|\|\|\s*", full_tr)]
            if len(parts) == len(b_idxs):
                return dict(zip(b_idxs, parts))
        except Exception:
            pass
        return {}

    tr_map = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for res_d in pool.map(_tr_batch, batches):
            tr_map.update(res_d)
    out_blocks = []
    for idx, (hdr_lines, orig_txt) in enumerate(parsed_blocks):
        if orig_txt is None:
            out_blocks.append("\n".join(hdr_lines))
        else:
            out_blocks.append("\n".join(hdr_lines + [tr_map.get(idx, orig_txt)]))
    res_vtt = "\n\n".join(out_blocks) + "\n"
    with _VTT_CACHE_LOCK:
        _SUB_VTT_CACHE[ck] = res_vtt
        _SUB_VTT_CACHE.move_to_end(ck)
        while len(_SUB_VTT_CACHE) > 200:
            _SUB_VTT_CACHE.popitem(last=False)
    return res_vtt


_SUB_RESP_CACHE: dict[str, tuple[float, dict]] = {}


def _fetch_yt_subtitles_and_audio_sync(video_id: str) -> dict:
    vid = (video_id or "").strip()
    if not re.match(r"^[A-Za-z0-9_-]{11}$", vid):
        return {"subtitleTracks": [], "audioTracks": []}
    ck = f"yt_sub_aud:{vid}"
    cached = _SUB_RESP_CACHE.get(ck)
    if cached and time.time() - cached[0] < 900:
        return cached[1]
    payload = {
        "videoId": vid,
        "context": {
            "client": {
                "clientName": "IOS",
                "clientVersion": "20.03.02",
                "deviceMake": "Apple",
                "deviceModel": "iPhone16,2",
                "osName": "iPhone",
                "osVersion": "18.2.1.22C161",
                "hl": "tr",
                "gl": "TR",
            }
        },
    }
    subs = []
    audio = [
        {"id": "orig", "lang": "orig", "targetLang": "orig", "audioLang": "orig", "label": "🎬 Orijinal Ses (YouTube HD)", "mode": "stream", "url": ""},
    ]
    try:
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5.5) as r:
            data = json.loads(r.read(1024 * 900).decode("utf-8", errors="ignore"))
        caps = ((data.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get("captionTracks") or []
        seen_ids = set()
        best_src_vtt_url = ""
        has_tr = False
        for c in caps:
            base_u = (c.get("baseUrl") or "").strip()
            if not base_u:
                continue
            vtt_raw_u = base_u if "fmt=vtt" in base_u else f"{base_u}&fmt=vtt"
            lcode_raw = (c.get("languageCode") or "en").strip()
            lcode_short = lcode_raw.split("-")[0].lower()
            vss_id = (c.get("vssId") or "").strip()
            is_asr = (c.get("kind") == "asr") or vss_id.startswith("a.")
            runs = (c.get("name") or {}).get("runs") or []
            name_txt = "".join(x.get("text", "") for x in runs).strip() or (c.get("name") or {}).get("simpleText") or ""
            flag = _AUDIO_LANG_FLAGS.get(lcode_short, "🌐")
            tr_lang_name = _AUDIO_LANG_TR_NAMES.get(lcode_short, name_txt or lcode_raw.upper())
            if not name_txt:
                name_txt = f"{tr_lang_name}{' (Otomatik)' if is_asr else ' (Orijinal)'}"
            lbl = f"{flag} {name_txt}" if flag not in name_txt else name_txt
            track_id = f"{lcode_raw}-asr" if is_asr else lcode_raw
            if track_id in seen_ids:
                track_id = f"{track_id}-{len(seen_ids) + 1}"
            seen_ids.add(track_id)
            if lcode_short == "tr":
                has_tr = True
            if not best_src_vtt_url or (lcode_short == "en" and not is_asr):
                best_src_vtt_url = vtt_raw_u
            vtt_proxy = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(vtt_raw_u, safe='')}&lang={urllib.parse.quote(lcode_short)}"
            subs.append({
                "id": track_id,
                "lang": lcode_short,
                "ytLangCode": lcode_raw,
                "label": lbl,
                "url": vtt_proxy,
                "kind": "subtitles",
                "source": "youtube-asr" if is_asr else "youtube",
            })
        if not has_tr and best_src_vtt_url:
            tr_proxy = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(best_src_vtt_url, safe='')}&lang=tr&translate=tr"
            subs.insert(0, {
                "id": "tr-auto-translate",
                "lang": "tr",
                "ytLangCode": "tr",
                "label": "🇹🇷 Türkçe (YouTube Otomatik Çeviri Senkron)",
                "url": tr_proxy,
                "kind": "subtitles",
                "source": "ai-tr",
            })
        subs.sort(key=lambda t: (0 if t.get("lang") == "tr" and t.get("source") != "ai-tr" else (1 if t.get("lang") == "tr" else (2 if t.get("lang") == "en" else 3))))
        if any(t.get("lang") == "tr" for t in subs):
            audio.append({
                "id": "tr-ai-dub",
                "lang": "tr",
                "targetLang": "tr",
                "audioLang": "tr",
                "label": "🇹🇷 Türkçe Dublaj (Akıllı Seslendirme)",
                "mode": "tts",
            })
        if any(t.get("lang") == "en" for t in subs):
            audio.append({
                "id": "en-ai-dub",
                "lang": "en",
                "targetLang": "en",
                "audioLang": "en",
                "label": "🇬🇧 İngilizce Dublaj (Akıllı Seslendirme)",
                "mode": "tts",
            })
    except Exception:
        pass
    out = {"subtitleTracks": subs, "subtitles": subs, "audioTracks": audio, "intro": None, "platformAudioLangs": [], "platformSubLangs": []}
    if len(_SUB_RESP_CACHE) >= 300:
        _SUB_RESP_CACHE.pop(next(iter(_SUB_RESP_CACHE)), None)
    _SUB_RESP_CACHE[ck] = (time.time(), out)
    return out


async def rave_subtitles(request: Request):
    """Caption tracks for a YouTube video the room is playing (YouTube's own captions only)."""
    vid = (request.query_params.get("videoId") or request.query_params.get("v") or "").strip()[:20]
    stream_url = (request.query_params.get("url") or "").strip()[:1500]
    if not vid and stream_url:
        m_yt = YT_RE.search(stream_url)
        if m_yt:
            vid = m_yt.group(1)
    if not (vid and re.match(r"^[A-Za-z0-9_-]{11}$", vid)):
        return JSONResponse({"subtitleTracks": [], "subtitles": [], "audioTracks": []})
    try:
        yt_res = await asyncio.wait_for(asyncio.to_thread(_fetch_yt_subtitles_and_audio_sync, vid), timeout=7.5)
    except Exception:
        yt_res = {"subtitleTracks": [], "audioTracks": []}
    return JSONResponse(yt_res, headers={"Cache-Control": "public, max-age=180, s-maxage=900"})


_SUB_TRANSLATE_LIMIT = RateLimiter(30, 60.0, name="sub_tr")


async def rave_subtitle_vtt(request: Request):
    if request.method == "OPTIONS":
        return Response(b"", status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
        })
    url = (request.query_params.get("url") or "").strip()
    fb = (request.query_params.get("fb") or "").strip()
    lang = (request.query_params.get("lang") or "").strip().lower()
    translate = (request.query_params.get("translate") or "").strip().lower()
    if translate:
        allowed_tr, retry_tr = _SUB_TRANSLATE_LIMIT.hit(client_ip(request))
        if not allowed_tr:
            return too_many_response(retry_tr)

    if not url.startswith(("https://", "http://")) or not public_http_url(url):
        return Response("WEBVTT\n\n", media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*"})
    vtt = ""
    need_tr = (translate == "tr")
    need_en = (translate == "en")
    try:
        vtt = await asyncio.wait_for(asyncio.to_thread(_fetch_vtt_sync, url), timeout=7.5)
    except Exception:
        vtt = ""
    min_cues = 20 if (request.query_params.get("mtype") == "tv") else 35
    if vtt.count("-->") < min_cues and fb.startswith(("https://", "http://")) and public_http_url(fb):
        try:
            fb_vtt = await asyncio.wait_for(asyncio.to_thread(_fetch_vtt_sync, fb), timeout=7.5)
            if fb_vtt.count("-->") > vtt.count("-->"):
                vtt = fb_vtt
                if lang == "tr" and ("english" in fb.lower() or "sublanguageid-eng" in fb.lower()):
                    need_tr = True
        except Exception:
            pass
    if lang == "tr" and not need_tr and vtt.count("-->") >= 2:
        sample_vtt = vtt[:6000]
        if not re.search(r"[ğşıöüçĞŞİÖÜÇ]", sample_vtt) and len(re.findall(r"\b(?:the|you|what|that|have|with|this|from|they|would|there)\b", sample_vtt, re.I)) >= 4:
            need_tr = True
    if vtt.count("-->") >= 2 and need_tr:
        try:
            vtt = await asyncio.wait_for(asyncio.to_thread(_translate_vtt_to_tr_sync, vtt, "tr"), timeout=8.5)
        except Exception:
            pass
    elif vtt.count("-->") >= 2 and need_en:
        try:
            vtt = await asyncio.wait_for(asyncio.to_thread(_translate_vtt_to_tr_sync, vtt, "en"), timeout=8.5)
        except Exception:
            pass
    if not vtt or not vtt.startswith("WEBVTT"):
        vtt = "WEBVTT\n\n"
    if vtt.count("-->") < 1:
        return Response(b"" if request.method == "HEAD" else b"WEBVTT\n\n", status_code=404, media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})
    body_bytes = vtt.encode("utf-8")
    return Response(b"" if request.method == "HEAD" else body_bytes, media_type="text/vtt; charset=utf-8", headers={
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    })


def _clip_tts_text(text: str, limit: int = 220) -> str:
    s = re.sub(r"\s+", " ", (text or "").strip())
    if len(s) <= limit:
        return s
    cut = s[:limit]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp >= limit // 2 else cut).strip()


def _fetch_tts_mp3_sync(text: str, lang: str = "tr") -> bytes:
    clipped = _clip_tts_text(text, 220)
    ck = f"{lang}:{clipped}"
    with _TTS_CACHE_LOCK:
        if ck in _TTS_CACHE:
            _TTS_CACHE.move_to_end(ck)
            return _TTS_CACHE[ck]
    q = urllib.parse.quote(clipped)
    u = f"https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl={urllib.parse.quote(lang[:5])}&q={q}"
    req = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://translate.google.com/"})
    with urllib.request.urlopen(req, timeout=4.5) as r:
        data = r.read(256 * 1024)
    if data:
        with _TTS_CACHE_LOCK:
            _TTS_CACHE[ck] = data
            _TTS_CACHE.move_to_end(ck)
            while len(_TTS_CACHE) > 120:
                _TTS_CACHE.popitem(last=False)
    return data


async def rave_tts(request: Request):
    raw_txt = (request.query_params.get("q") or request.query_params.get("text") or "").strip()
    text = _clip_tts_text(raw_txt, 220)
    lang = (request.query_params.get("lang") or "tr").strip().lower()[:5]
    if not text:
        return Response(b"", media_type="audio/mpeg", status_code=400)
    try:
        mp3 = await asyncio.wait_for(asyncio.to_thread(_fetch_tts_mp3_sync, text, lang), timeout=5.0)
        return Response(mp3, media_type="audio/mpeg", headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400, s-maxage=604800",
        })
    except Exception:
        return Response(b"", media_type="audio/mpeg", status_code=502)


_UPLOAD_LIMIT = RateLimiter(20, 3600.0, name="upload")
MAX_UPLOADS_TOTAL_BYTES = int(os.environ.get("MAX_UPLOADS_TOTAL_BYTES") or 5 * 1024 ** 3)


def _uploads_dir_size(prune_ttl_sec: float = 86400.0) -> int:
    total = 0
    now_t = time.time()
    try:
        for entry in UPLOADS_DIR.iterdir():
            try:
                if entry.is_file():
                    st = entry.stat()
                    if prune_ttl_sec > 0 and (now_t - st.st_mtime) > prune_ttl_sec:
                        entry.unlink(missing_ok=True)
                        continue
                    total += st.st_size
            except OSError:
                continue
    except OSError:
        return 0
    return total


def _has_valid_upload_magic(ext: str, head: bytes) -> bool:
    if len(head) < 12:
        return False
    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n")
    low = stripped[:256].lower()
    if head.startswith((b"MZ", b"\x7fELF", b"#!")) or low.startswith((b"<!doctype", b"<html", b"<svg", b"<script", b"<img", b"<body", b"<iframe", b"<?xml")):
        return False
    if ext in (".mp4", ".mov", ".m4v", ".m4a"):
        return head[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot")
    if ext == ".webm":
        return head.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".ogg":
        return head.startswith(b"OggS")
    if ext == ".wav":
        return head.startswith(b"RIFF") and head[8:12] == b"WAVE"
    if ext == ".mp3":
        return head.startswith(b"ID3") or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    return False


async def upload_file(request: Request):
    if IS_VERCEL:
        return JSONResponse({"error": "Dosya yükleme bulut sürümünde kapalı. Dosyanı Google Drive'a yükleyip bağlantısını kullanabilirsin."}, status_code=501)
    # Uploads are expensive (disk, bandwidth): verified accounts only (never guest tokens).
    uid = str(request.scope.get("wl_uid") or "")
    claims = request.scope.get("wl_claims") or {}
    if not uid or claims.get("guest"):
        return JSONResponse({"error": "Yükleme için giriş yapmalısın."}, status_code=401)
    allowed, retry_after = _UPLOAD_LIMIT.hit(uid)
    if not allowed:
        return too_many_response(retry_after)
    try:
        length = int(request.headers.get("content-length") or 0)
    except ValueError:
        length = 0
    if length > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "Dosya 1 GB sınırını aşıyor"}, status_code=413)
    if _uploads_dir_size() + max(0, length) > MAX_UPLOADS_TOTAL_BYTES:
        return JSONResponse({"error": "Sunucu depolama alanı dolu. Lütfen daha sonra tekrar dene."}, status_code=507)
    try:
        form = await request.form(max_part_size=MAX_UPLOAD_BYTES)
    except Exception:
        return JSONResponse({"error": "Geçersiz form verisi"}, status_code=400)
    file = form.get("file")
    if not file or not getattr(file, "filename", None) or not hasattr(file, "read"):
        return JSONResponse({"error": "Dosya bulunamadı"}, status_code=400)
    clean_fname = os.path.basename(str(file.filename or "").replace("\\", "/")).strip()
    if not clean_fname:
        return JSONResponse({"error": "Geçersiz dosya adı"}, status_code=400)
    ext = pathlib.Path(clean_fname).suffix.lower()
    if ext not in ALLOWED_UPLOAD_EXTS:
        return JSONResponse({"error": f"Desteklenmeyen dosya türü: {ext}"}, status_code=400)
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    dest = UPLOADS_DIR / name
    size = 0
    header_buf = bytearray()
    header_checked = False
    try:
        with open(dest, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                if not header_checked:
                    header_buf.extend(chunk[:max(0, 512 - len(header_buf))])
                    if len(header_buf) >= 16:
                        header_checked = True
                        if not _has_valid_upload_magic(ext, bytes(header_buf)):
                            out.close()
                            dest.unlink(missing_ok=True)
                            return JSONResponse({"error": "Geçersiz medya dosyası başlığı"}, status_code=415)
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    out.close()
                    dest.unlink(missing_ok=True)
                    return JSONResponse({"error": "Dosya 1 GB sınırını aşıyor"}, status_code=413)
                out.write(chunk)
        if size < 16 or not _has_valid_upload_magic(ext, bytes(header_buf)):
            dest.unlink(missing_ok=True)
            return JSONResponse({"error": "Boş veya geçersiz medya dosyası"}, status_code=415)
    except Exception:
        dest.unlink(missing_ok=True)
        return JSONResponse({"error": "Dosya yükleme kesildi"}, status_code=400)
    return JSONResponse({"url": f"/uploads/{name}", "filename": clean_fname[:120], "size": size})


async def manifest_json(request: Request):
    return JSONResponse(
        {
            "id": "/",
            "scope": "/",
            "name": "Watchlivo — Birlikte Sinema, Dizi & Müzik",
            "short_name": "Watchlivo",
            "description": "Arkadaşlarınla aynı anda, tek kare gecikmesiz izle — web, telefon ve masaüstü.",
            "start_url": "/",
            "display": "standalone",
            "background_color": "#06090e",
            "theme_color": "#06090e",
            "orientation": "any",
            "icons": [
                {"src": "/static/watchlivo-logo.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"},
                {"src": "/static/watchlivo-icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                {"src": "/static/watchlivo-icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
                {"src": "/static/watchlivo-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                {"src": "/static/watchlivo-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
            ],
        },
        media_type="application/manifest+json",
    )


async def service_worker(request: Request):
    sw_path = STATIC_DIR / "sw.js"
    js = sw_path.read_text(encoding="utf-8") if sw_path.exists() else "self.addEventListener('install',()=>self.skipWaiting());"
    return Response(js, media_type="application/javascript", headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


async def health(request: Request):
    mem_rooms = getattr(rooms.STORE, "l1_rooms", None) or getattr(rooms.STORE, "rooms", {}) or {}
    total_p = sum(
        sum(1 for p in (r.get("participants") or {}).values() if isinstance(p, dict) and p.get("transport") != "bot")
        for r in mem_rooms.values()
        if isinstance(r, dict)
    )
    return JSONResponse({
        "ok": True,
        "sharedStore": rooms.STORE.shared,
        "vercel": IS_VERCEL,
        "activeRooms": len(mem_rooms),
        "totalParticipants": total_p,
    })


async def index(request: Request):
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"), headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "X-Frame-Options": "SAMEORIGIN"})


_APK_HASH_CACHE: dict[str, object] = {"mtime": None, "sha256": "", "sizeBytes": 0}
_IPA_HASH_CACHE: dict[str, object] = {"mtime": None, "sha256": "", "sizeBytes": 0}


async def app_version_endpoint(request: Request):
    meta_file = BASE_DIR / "app_version.json"
    apk_file = STATIC_DIR / "Watchlivo-v2.0.apk"
    data = {
        "ok": True,
        "packageName": "online.watchlivo.app",
        "versionCode": 22,
        "versionName": "2.0.2",
        "apkUrl": "https://watchlivo.online/download/Watchlivo-v2.0.apk",
        "fallbackUrl": "https://watchlivo.online/static/Watchlivo-v2.0.apk",
        "sha256": "",
        "sizeBytes": 0,
        "mandatory": True,
        "autoInstall": True,
        "changelog": "Watchlivo Native v2.0.2 — Sesli arama (mikrofon), oda içi sesli mesaj kaydı/dinleme, donanım oynatıcı ve Rave.io tarzı otomatik güncelleme.",
    }
    if meta_file.exists():
        try:
            loaded = json.loads(meta_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception:
            pass
    if apk_file.exists() and (not data.get("sha256") or not data.get("sizeBytes")):
        try:
            st = apk_file.stat()
            if _APK_HASH_CACHE.get("mtime") == st.st_mtime_ns and _APK_HASH_CACHE.get("sizeBytes") == st.st_size:
                data["sha256"] = _APK_HASH_CACHE["sha256"]
                data["sizeBytes"] = _APK_HASH_CACHE["sizeBytes"]
            else:
                raw = apk_file.read_bytes()
                sha = hashlib.sha256(raw).hexdigest()
                _APK_HASH_CACHE.update({"mtime": st.st_mtime_ns, "sha256": sha, "sizeBytes": len(raw)})
                data["sha256"] = sha
                data["sizeBytes"] = len(raw)
        except Exception:
            pass
    return JSONResponse(
        data,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Access-Control-Allow-Origin": "*",
        },
    )


async def download_apk_endpoint(request: Request):
    apk_file = STATIC_DIR / "Watchlivo-v2.0.apk"
    if apk_file.exists():
        return FileResponse(
            apk_file,
            media_type="application/vnd.android.package-archive",
            headers={
                "Content-Disposition": 'attachment; filename="Watchlivo-v2.0.apk"',
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "X-Content-Type-Options": "nosniff",
            },
        )
    ext_apk = (os.environ.get("WATCHLIVO_APK_DOWNLOAD_URL") or "").strip()
    if ext_apk.startswith("https://"):
        return RedirectResponse(ext_apk, status_code=302)
    return RedirectResponse("/static/Watchlivo-v2.0.apk", status_code=302)


async def download_windows_endpoint(request: Request):
    exe_file = STATIC_DIR / "Watchlivo.exe"
    ext_win = os.environ.get("WATCHLIVO_WINDOWS_DOWNLOAD_URL", "").strip()
    if request.query_params.get("check") == "1":
        has_native = bool(exe_file.exists() or ext_win.startswith("https://"))
        dl_url = ext_win if ext_win.startswith("https://") else ("/download/windows" if exe_file.exists() else "")
        return JSONResponse({
            "ok": True,
            "available": has_native,
            "nativeAvailable": has_native,
            "url": dl_url,
            "downloadUrl": dl_url,
            "fallback": "pwa",
        }, headers={"Cache-Control": "no-store"})
    if exe_file.exists():
        return FileResponse(
            exe_file,
            media_type="application/vnd.microsoft.portable-executable",
            headers={
                "Content-Disposition": 'attachment; filename="Watchlivo.exe"',
                "X-Content-Type-Options": "nosniff",
            },
        )
    if ext_win.startswith("https://"):
        return RedirectResponse(ext_win, status_code=302)
    return RedirectResponse("/#/?platform=windows", status_code=302)


async def download_ipa_endpoint(request: Request):
    ipa_file = STATIC_DIR / "Watchlivo.ipa"
    if ipa_file.exists():
        return FileResponse(
            ipa_file,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": 'attachment; filename="Watchlivo.ipa"',
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "X-Content-Type-Options": "nosniff",
            },
        )
    ext_ipa = (os.environ.get("WATCHLIVO_IPA_DOWNLOAD_URL") or "").strip()
    if ext_ipa.startswith("https://"):
        return RedirectResponse(ext_ipa, status_code=302)
    return RedirectResponse("/static/Watchlivo.ipa", status_code=302)


async def ios_version_endpoint(request: Request):
    meta_file = BASE_DIR / "ios_version.json"
    ipa_file = STATIC_DIR / "Watchlivo.ipa"
    data: dict[str, object] = {
        "ok": True,
        "bundleId": "online.watchlivo.app",
        "packageName": "online.watchlivo.app",
        "versionCode": 200,
        "versionName": "2.0.0",
        "ipaUrl": "https://watchlivo.online/download/ipa",
        "fallbackUrl": "https://watchlivo.online/static/Watchlivo.ipa",
        "manifestUrl": "https://watchlivo.online/api/ios/manifest.plist",
        "sha256": "",
        "sizeBytes": 0,
        "mandatory": True,
        "autoInstall": True,
        "changelog": "Watchlivo Native iOS v2.0.0 — %100 Native UIKit & AVPlayerViewController (WebRTC/WKWebView yok), tüm uygulamalarda çalışan sistem PiP, oda içi AAC sesli mesaj kaydı/dinleme ve Rave.io tarzı otomatik güncelleme.",
        "remoteConfig": {
            "baseUrl": "https://watchlivo.online",
            "posterProxyEnabled": True,
            "syncIntervalMs": 2000,
        },
    }
    if meta_file.exists():
        try:
            loaded = json.loads(meta_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception:
            pass
    if ipa_file.exists():
        try:
            st = ipa_file.stat()
            if _IPA_HASH_CACHE.get("mtime") == st.st_mtime_ns and _IPA_HASH_CACHE.get("sizeBytes") == st.st_size:
                data["sha256"] = _IPA_HASH_CACHE["sha256"]
                data["sizeBytes"] = _IPA_HASH_CACHE["sizeBytes"]
            else:
                raw = ipa_file.read_bytes()
                sha = hashlib.sha256(raw).hexdigest()
                _IPA_HASH_CACHE.update({"mtime": st.st_mtime_ns, "sha256": sha, "sizeBytes": len(raw)})
                data["sha256"] = sha
                data["sizeBytes"] = len(raw)
        except Exception:
            pass
    return JSONResponse(
        data,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Access-Control-Allow-Origin": "*",
        },
    )


async def ios_manifest_endpoint(request: Request):
    meta_file = BASE_DIR / "ios_version.json"
    version_name = "2.0.0"
    bundle_id = "online.watchlivo.app"
    ipa_url = "https://watchlivo.online/download/ipa"
    if meta_file.exists():
        try:
            loaded = json.loads(meta_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                version_name = str(loaded.get("versionName") or version_name)
                bundle_id = str(loaded.get("bundleId") or bundle_id)
                ipa_url = str(loaded.get("ipaUrl") or ipa_url)
        except Exception:
            pass
    plist_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>{ipa_url}</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>display-image</string>
                    <key>url</key>
                    <string>https://watchlivo.online/static/watchlivo-icon-192.png</string>
                </dict>
                <dict>
                    <key>kind</key>
                    <string>full-size-image</string>
                    <key>url</key>
                    <string>https://watchlivo.online/static/watchlivo-icon-512.png</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>{bundle_id}</string>
                <key>bundle-version</key>
                <string>{version_name}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>Watchlivo</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>"""
    return Response(
        content=plist_xml,
        media_type="application/xml; charset=utf-8",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Access-Control-Allow-Origin": "*",
        },
    )


async def download_ios_endpoint(request: Request):
    cfg_file = STATIC_DIR / "Watchlivo.mobileconfig"
    if cfg_file.exists():
        return FileResponse(
            cfg_file,
            media_type="application/x-apple-aspen-config",
            headers={
                "Content-Disposition": 'inline; filename="Watchlivo.mobileconfig"',
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
            },
        )
    return RedirectResponse("/static/Watchlivo.mobileconfig", status_code=302)


async def indexnow_key_endpoint(request: Request):
    return PlainTextResponse("b8f4e2a9c1d74e36a5b09f82c4e1d3a7")


_AI_LIMIT = RateLimiter(30, 3600.0, name="ai_chat")
_SUNO_LIMIT = RateLimiter(10, 3600.0, name="suno")


async def rave_ai_status(request: Request):
    """Report which AI engines are configured — never expose key material."""
    return JSONResponse({
        "ok": True,
        "engines": [
            {"id": "openai", "name": "OpenAI", "activeModel": OPENAI_MODEL, "configured": bool(OPENAI_API_KEY), "status": "active" if OPENAI_API_KEY else "unconfigured"},
            {"id": "suno", "name": "Suno", "activeModel": SUNO_MODEL, "configured": bool(SUNO_API_KEY), "status": "active" if SUNO_API_KEY else "unconfigured"},
        ],
    })


def _ai_guard(request: Request, limiter: RateLimiter):
    """Return (uid, error_response). AI calls cost money, so they need a verified account."""
    uid = str(request.scope.get("wl_uid") or "")
    claims = request.scope.get("wl_claims") or {}
    if not uid or claims.get("guest"):
        return "", JSONResponse({"ok": False, "error": "Yapay zeka özellikleri için giriş yapmalısın."}, status_code=401)
    allowed, retry_after = limiter.hit(uid)
    if not allowed:
        return uid, too_many_response(retry_after)
    return uid, None


def _call_openai_sync(prompt: str, model: str) -> dict:
    use_model = (model or OPENAI_MODEL or "claude-sonnet-4-5").split()[0].strip()
    use_key = (OPENAI_API_KEY or "").strip()
    sys_msg = (
        "Sen dünyaca ünlü bir Türkçe/Global şarkı sözü yazarı, Suno v4.5 müzik prodüktörü ve Watchlivo sinema/müzik yapay zeka asistanısın. "
        "Şarkı/beste istendiğinde TITLE:, STYLE_PROMPT: (maksimum 120 karakter İngilizce prodüksiyon etiketleri) ve LYRICS: ([Intro], [Verse 1], [Chorus], [Bridge], [Outro]) üret."
    )
    if use_key:
        try:
            req = urllib.request.Request(
                "https://api.openai.com/v1/chat/completions",
                data=json.dumps({
                    "model": use_model,
                    "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": prompt}],
                    "max_completion_tokens": 900,
                }).encode("utf-8"),
                headers={"Authorization": f"Bearer {use_key}", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=16) as r:
                d = json.loads(r.read().decode("utf-8"))
                txt = (d.get("choices") or [{}])[0].get("message", {}).get("content") or ""
                if txt:
                    return {"ok": True, "model": d.get("model") or use_model, "text": txt, "provider": "openai-direct"}
        except Exception:
            pass
    if not OPENAI_CLOUD_FALLBACK_KEY:
        return {"ok": False, "error": "Yapay zeka servisi yapılandırılmamış."}
    try:
        req2 = urllib.request.Request(
            "https://xstzsqkfynhexvulcvab.supabase.co/functions/v1/text-gen-live",
            data=json.dumps({
                "appName": "AI Paragraph Generator",
                "packageName": "com.app.ai.paragraph.writer",
                "versionCode": 18,
                "versionName": "1.1.8",
                "model": "gpt-5.4",
                "prompt": f"{sys_msg}\n\n{prompt}",
                "n": 1,
                "temperature": 0.75,
                "topP": 1.0,
                "token": 1000,
                "stream": False,
            }).encode("utf-8"),
            headers={"X-API-Key": OPENAI_CLOUD_FALLBACK_KEY, "Authorization": f"Bearer {OPENAI_CLOUD_FALLBACK_KEY}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req2, timeout=16) as r:
            d2 = json.loads(r.read().decode("utf-8"))
            txt2 = d2.get("data") or d2.get("text") or ""
            return {"ok": True, "model": "gpt-5.4", "text": txt2, "provider": "openai-cloud"}
    except Exception:
        return {"ok": False, "error": "Yapay zeka servisi şu anda yanıt vermiyor."}


async def rave_ai_chat(request: Request):
    _uid, guard = _ai_guard(request, _AI_LIMIT)
    if guard:
        return guard
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    prompt = str(body.get("prompt") or request.query_params.get("prompt") or "").strip()[:4000]
    model = str(body.get("model") or request.query_params.get("model") or OPENAI_MODEL).strip()[:48]
    if not prompt:
        return JSONResponse({"ok": False, "error": "Prompt boş olamaz"}, status_code=400)
    res = await asyncio.to_thread(_call_openai_sync, prompt, model)
    return JSONResponse(res)


def _submit_suno_sync(lyrics: str, style: str, title: str) -> dict:
    use_key = (SUNO_API_KEY or "").strip()
    clean_lyrics = re.sub(r"\([^\)]*\)", "", lyrics or "").strip()[:1000]
    clean_style = (style or "Turkish Pop, Deep Bass, Catchy Synth, Studio Master, 124 BPM").replace("\n", " ").strip()[:125]
    out = {"ok": False, "title": title or "Watchlivo AI Şarkı", "style": clean_style, "sunoTaskId": "", "murekaTokenId": ""}
    if not use_key:
        out["error"] = "Müzik servisi yapılandırılmamış."
        return out
    try:
        req1 = urllib.request.Request(
            "https://xstzsqkfynhexvulcvab.supabase.co/functions/v1/generate-song",
            data=json.dumps({"lyrics": clean_lyrics, "style": clean_style, "vocal_gender": "male"}).encode("utf-8"),
            headers={"X-API-Key": use_key, "Authorization": f"Bearer {use_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req1, timeout=14) as r:
            d1 = json.loads(r.read().decode("utf-8"))
            out["sunoTaskId"] = d1.get("task_id") or ""
    except Exception:
        pass
    try:
        req2 = urllib.request.Request(
            "https://aisongscreator.com/api/generate.php",
            data=json.dumps({"lyrics": clean_lyrics, "style": clean_style}).encode("utf-8"),
            headers={"X-API-Key": use_key, "Authorization": f"Bearer {use_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req2, timeout=14) as r:
            d2 = json.loads(r.read().decode("utf-8"))
            out["murekaTokenId"] = d2.get("token_id") or ""
    except Exception:
        pass
    out["ok"] = bool(out["sunoTaskId"] or out["murekaTokenId"])
    if not out["ok"]:
        out["error"] = "Müzik üretim servisi görevi kabul etmedi."
    return out


async def rave_suno_generate(request: Request):
    _uid, guard = _ai_guard(request, _SUNO_LIMIT)
    if guard:
        return guard
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    lyrics = str(body.get("lyrics") or "").strip()[:4000]
    style = str(body.get("style") or "").strip()[:200]
    title = str(body.get("title") or "Watchlivo AI Hit").strip()[:80]
    res = await asyncio.to_thread(_submit_suno_sync, lyrics, style, title)
    return JSONResponse(res)


import auth_engine
import music_engine
import social_engine


async def room_share_landing(request: Request) -> HTMLResponse:
    import html as _html
    raw_id = str(request.path_params.get("room_id") or "").strip()[:80]
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", raw_id).lower()
    raw_scheme = (request.headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",")[0].strip().lower()
    scheme = "http" if raw_scheme == "http" else "https"
    raw_host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "watchlivo.online").split(",")[0].strip()
    host = raw_host if re.fullmatch(r"[a-zA-Z0-9.\-:]{1,120}", raw_host) else "watchlivo.online"
    origin = f"{scheme}://{host}"
    room = (await rooms.STORE.get(safe_id) or await rooms.ensure_curated_room(safe_id)) if safe_id else None
    incoming_rtok = str(request.query_params.get("r_tok") or "").strip()[:32000]
    if room is None and safe_id and incoming_rtok:
        try:
            room = rooms.merge_sync_token(None, incoming_rtok, safe_id)
            if room:
                await rooms.STORE.put(room, force_disk=True)
        except Exception:
            pass
    is_locked = bool(room and rooms.has_password(room))
    is_non_public = bool(room and str(room.get("privacy") or "public") in ("private", "friends"))
    req_pwd = str(request.query_params.get("pwd") or "")
    pwd_ok = (not is_locked) or bool(room and rooms.verify_room_password(room, req_pwd))
    valid_in_rtok = bool(incoming_rtok and safe_id and rooms.merge_sync_token(None, incoming_rtok, safe_id) is not None)
    hide_meta = (is_non_public and not (valid_in_rtok and pwd_ok)) or (is_locked and not pwd_ok)
    p_count = sum(1 for hp in ((room or {}).get("participants") or {}).values() if isinstance(hp, dict) and hp.get("transport") != "bot")
    raw_r_name = str((room or {}).get("name") or ("" if hide_meta else request.query_params.get("t")) or safe_id or "Watchlivo Sinema Odası").strip()
    r_name = ("Şifreli Watchlivo Odası" if is_locked else "Özel Watchlivo Odası") if hide_meta else raw_r_name
    media = ((room or {}).get("media") or {}) if (room and not hide_meta) else {}
    m_title = str(media.get("title") or ("" if hide_meta else request.query_params.get("t")) or "").strip()
    raw_img = str(media.get("backdrop") or media.get("poster") or media.get("thumbnail") or "").strip()
    if raw_img.startswith("/") and not raw_img.lower().endswith(".svg"):
        og_img = f"{origin}{raw_img}"
    elif raw_img.startswith("https://") and not raw_img.lower().endswith(".svg"):
        og_img = raw_img
    else:
        og_img = f"{origin}/static/watchlivo-og.png"

    if is_locked and hide_meta:
        og_title = "🔒 Şifreli Watchlivo Odası"
        og_desc = f"Şu an odada {max(1, p_count)} kişi var. Davet bağlantısına tıklayarak şifreyle katıl!"
    elif is_non_public and hide_meta:
        og_title = "🔒 Özel Watchlivo Odası"
        og_desc = "Bu oda yalnızca davetli üyeler veya arkadaşlar içindir. Davet bağlantısına tıklayarak katıl!"
    elif is_locked:
        og_title = f"🔒 {r_name} — Şifreli Watchlivo Odası"
        og_desc = f"Şu an odada {max(1, p_count)} kişi var. Davet bağlantısına tıklayarak şifreyle katıl!"
    elif is_non_public:
        og_title = "🔒 Özel Watchlivo Odası"
        og_desc = "Bu oda yalnızca davetli üyeler veya arkadaşlar içindir. Davet bağlantısına tıklayarak katıl!"
    elif m_title:
        v_txt = f"{p_count} kişi birlikte izliyor" if p_count > 1 else "Canlı izleme odası açık"
        og_title = f"🎬 {m_title} · {r_name} | Watchlivo"
        og_desc = f"{v_txt} — Tek tıkla senkronize sinema odasına katıl, sesli ve yazılı sohbetle izle!"
    elif room:
        og_title = f"🍿 {r_name} — Canlı Watchlivo Odası"
        og_desc = f"Odada {max(1, p_count)} kişi seni bekliyor — Tek tıkla birlikte izlemeye katıl!"
    else:
        og_title = "Watchlivo — Birlikte Sinema, Dizi & Müzik Odaları"
        og_desc = "Arkadaşlarınla aynı anda, tek kare gecikmesiz film, dizi, anime ve canlı yayın izle."

    esc_title = _html.escape(og_title, quote=True)
    esc_desc = _html.escape(og_desc, quote=True)
    esc_img = _html.escape(og_img, quote=True)
    fwd_params = []
    for qp_k in ("pwd", "t", "m", "tmdbId", "mt", "s", "e", "autocall"):
        qp_v = str(request.query_params.get(qp_k) or "").strip()[:500]
        if qp_v:
            fwd_params.append((qp_k, qp_v))
    can_mint_rtok = (not is_non_public) and pwd_ok
    eff_rtok = incoming_rtok if (valid_in_rtok and pwd_ok) else ""
    if not eff_rtok and room and can_mint_rtok and incoming_rtok:
        try:
            eff_rtok = rooms.pack_sync_token(room)
        except Exception:
            eff_rtok = ""
    if eff_rtok and incoming_rtok:
        fwd_params.append(("r_tok", eff_rtok))
    qs_suffix = ("?" + urllib.parse.urlencode(fwd_params)) if fwd_params else ""
    target_hash = f"/#/mesh/{urllib.parse.quote(safe_id)}{qs_suffix}" if safe_id else "/#/"
    esc_url = _html.escape(f"{origin}/r/{urllib.parse.quote(safe_id)}", quote=True)
    csp_nonce = _html.escape(str(request.scope.get("csp_nonce") or ""), quote=True)
    html_doc = f"""<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{esc_title}</title>
  <meta name="description" content="{esc_desc}" />
  <link rel="canonical" href="{esc_url}" />
  <meta property="og:type" content="video.other" />
  <meta property="og:site_name" content="Watchlivo" />
  <meta property="og:title" content="{esc_title}" />
  <meta property="og:description" content="{esc_desc}" />
  <meta property="og:image" content="{esc_img}" />
  <meta property="og:url" content="{esc_url}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{esc_title}" />
  <meta name="twitter:description" content="{esc_desc}" />
  <meta name="twitter:image" content="{esc_img}" />
  <script nonce="{csp_nonce}">window.location.replace({json.dumps(target_hash)});</script>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#06090e;color:#f8fafc;font-family:system-ui,sans-serif;text-align:center;padding:24px;">
  <div style="max-width:440px;padding:28px;border-radius:20px;background:#0e1522;border:1px solid rgba(39,220,200,.3);">
    <div style="font-size:1.15rem;font-weight:800;margin-bottom:8px;">{esc_title}</div>
    <p style="font-size:.9rem;color:#94a3b8;margin:0 0 18px;">{esc_desc}</p>
    <a href="{_html.escape(target_hash, quote=True)}" style="display:inline-block;padding:12px 24px;border-radius:12px;background:linear-gradient(135deg,#27dcc8,#10b981);color:#041014;font-weight:800;text-decoration:none;">🎬 Odaya Hemen Katıl</a>
  </div>
</body>
</html>"""
    return HTMLResponse(html_doc, headers={"Cache-Control": "no-store, must-revalidate"})


async def rave_sub_vtt_translate(request: Request):
    if request.method == "OPTIONS":
        return Response(b"", status_code=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"})
    allowed_tr, retry_tr = _SUB_TRANSLATE_LIMIT.hit(client_ip(request))
    if not allowed_tr:
        return too_many_response(retry_tr)
    if request.method == "POST":
        raw_b = (await request.body())[:512 * 1024]
        vtt_in = _srt_to_vtt(raw_b) if raw_b else "WEBVTT\n\n"
        if vtt_in.count("-->") >= 1:
            try:
                vtt_in = await asyncio.wait_for(asyncio.to_thread(_translate_vtt_to_tr_sync, vtt_in), timeout=8.5)
            except Exception:
                pass
        return Response(vtt_in.encode("utf-8"), media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*"})
    url_q = (request.query_params.get("url") or "").strip()
    if not url_q.startswith(("https://", "http://")) or not public_http_url(url_q):
        return Response("WEBVTT\n\n", media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*"})
    try:
        vtt = await asyncio.wait_for(asyncio.to_thread(_fetch_vtt_sync, url_q), timeout=7.5)
        if vtt.count("-->") >= 1:
            vtt = await asyncio.wait_for(asyncio.to_thread(_translate_vtt_to_tr_sync, vtt), timeout=8.5)
    except Exception:
        vtt = "WEBVTT\n\n"
    return Response(vtt.encode("utf-8"), media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*"})


async def rave_meshes_compat(request: Request):
    if request.method == "POST":
        return await rooms.create_room(request)
    return await rooms.list_rooms(request)


_ANALYTICS_LOCK = threading.Lock()
_ANALYTICS_STATE: dict = {
    "loaded": False,
    "last_flush": 0.0,
    "total_pageviews": 0,
    "total_searches": 0,
    "total_watches": 0,
    "visitors": set(),
    "daily": {},
    "devices": {"ios": 0, "android": 0, "desktop": 0, "pwa": 0},
    "top_searches": {},
    "top_watched": {},
    "active_heartbeats": {},
}


def _detect_device_bucket(ua: str, explicit_dev: str = "") -> str:
    ed = (explicit_dev or "").strip().lower()
    if ed in ("ios", "android", "desktop", "pwa"):
        return ed
    u = (ua or "").lower()
    if "iphone" in u or "ipad" in u or "ipod" in u:
        return "ios"
    if "android" in u:
        return "android"
    return "desktop"


def _load_analytics_from_kv_locked() -> None:
    if _ANALYTICS_STATE["loaded"]:
        return
    _ANALYTICS_STATE["loaded"] = True
    try:
        saved = social_engine._kv_get("wl:analytics:v1")
        if isinstance(saved, dict):
            _ANALYTICS_STATE["total_pageviews"] = max(_ANALYTICS_STATE["total_pageviews"], int(saved.get("total_pageviews") or 0))
            _ANALYTICS_STATE["total_searches"] = max(_ANALYTICS_STATE["total_searches"], int(saved.get("total_searches") or 0))
            _ANALYTICS_STATE["total_watches"] = max(_ANALYTICS_STATE["total_watches"], int(saved.get("total_watches") or 0))
            for v in (saved.get("visitors") or [])[:5000]:
                if isinstance(v, str):
                    _ANALYTICS_STATE["visitors"].add(v)
            if isinstance(saved.get("devices"), dict):
                for dk in ("ios", "android", "desktop", "pwa"):
                    _ANALYTICS_STATE["devices"][dk] = max(_ANALYTICS_STATE["devices"].get(dk, 0), int(saved["devices"].get(dk) or 0))
            if isinstance(saved.get("top_searches"), dict):
                for sk, sv in list(saved["top_searches"].items())[:200]:
                    _ANALYTICS_STATE["top_searches"][str(sk)] = max(_ANALYTICS_STATE["top_searches"].get(str(sk), 0), int(sv or 0))
            if isinstance(saved.get("top_watched"), dict):
                for wk, wv in list(saved["top_watched"].items())[:200]:
                    _ANALYTICS_STATE["top_watched"][str(wk)] = max(_ANALYTICS_STATE["top_watched"].get(str(wk), 0), int(wv or 0))
            if isinstance(saved.get("daily"), dict):
                for d_key, d_val in list(saved["daily"].items())[-30:]:
                    if isinstance(d_val, dict):
                        _ANALYTICS_STATE["daily"][str(d_key)] = {
                            "pageviews": int(d_val.get("pageviews") or 0),
                            "visitors": set(str(x) for x in (d_val.get("visitors") or [])[:2000]),
                        }
    except Exception:
        pass


def _flush_analytics_to_kv_locked(force: bool = False) -> None:
    now_t = time.time()
    if not force and (now_t - _ANALYTICS_STATE["last_flush"] < 20.0):
        return
    _ANALYTICS_STATE["last_flush"] = now_t
    try:
        top_s = dict(sorted(_ANALYTICS_STATE["top_searches"].items(), key=lambda kv: kv[1], reverse=True)[:100])
        top_w = dict(sorted(_ANALYTICS_STATE["top_watched"].items(), key=lambda kv: kv[1], reverse=True)[:100])
        daily_ser = {}
        for dk, dv in list(_ANALYTICS_STATE["daily"].items())[-14:]:
            daily_ser[dk] = {
                "pageviews": int(dv.get("pageviews") or 0),
                "visitors": list(dv.get("visitors") or set())[:1000],
            }
        payload = {
            "total_pageviews": _ANALYTICS_STATE["total_pageviews"],
            "total_searches": _ANALYTICS_STATE["total_searches"],
            "total_watches": _ANALYTICS_STATE["total_watches"],
            "visitors": list(_ANALYTICS_STATE["visitors"])[-3000:],
            "devices": dict(_ANALYTICS_STATE["devices"]),
            "top_searches": top_s,
            "top_watched": top_w,
            "daily": daily_ser,
        }
        social_engine._kv_set("wl:analytics:v1", payload)
    except Exception:
        pass


def _track_analytics_sync(
    event_type: str,
    visitor_id: str = "",
    device: str = "",
    query: str = "",
    title: str = "",
    media_type: str = "",
) -> None:
    day_str = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 10800))
    now_t = time.time()
    with _ANALYTICS_LOCK:
        _load_analytics_from_kv_locked()
        if len(_ANALYTICS_STATE["daily"]) > 45:
            for old_d in sorted(_ANALYTICS_STATE["daily"].keys())[:-35]:
                _ANALYTICS_STATE["daily"].pop(old_d, None)
        d_ent = _ANALYTICS_STATE["daily"].setdefault(day_str, {"pageviews": 0, "visitors": set()})
        if visitor_id:
            if len(_ANALYTICS_STATE["visitors"]) < 5000:
                _ANALYTICS_STATE["visitors"].add(visitor_id)
            if len(d_ent["visitors"]) < 2500:
                d_ent["visitors"].add(visitor_id)
            _ANALYTICS_STATE["active_heartbeats"][visitor_id] = now_t
            if len(_ANALYTICS_STATE["active_heartbeats"]) > 2000:
                cutoff = now_t - 360.0
                _ANALYTICS_STATE["active_heartbeats"] = {k: v for k, v in _ANALYTICS_STATE["active_heartbeats"].items() if v >= cutoff}
        if event_type in ("pageview", "pwa_launch"):
            _ANALYTICS_STATE["total_pageviews"] += 1
            d_ent["pageviews"] += 1
            if device in _ANALYTICS_STATE["devices"]:
                _ANALYTICS_STATE["devices"][device] += 1
            if event_type == "pwa_launch":
                _ANALYTICS_STATE["devices"]["pwa"] += 1
        elif event_type == "search" and query:
            q_clean = re.sub(r"\s+", " ", query.strip())[:80]
            if len(q_clean) >= 2:
                _ANALYTICS_STATE["total_searches"] += 1
                if q_clean in _ANALYTICS_STATE["top_searches"] or len(_ANALYTICS_STATE["top_searches"]) < 100000:
                    _ANALYTICS_STATE["top_searches"][q_clean] = _ANALYTICS_STATE["top_searches"].get(q_clean, 0) + 1
        elif event_type == "watch" and title:
            t_clean = re.sub(r"\s+", " ", title.strip())[:100]
            if len(t_clean) >= 2:
                _ANALYTICS_STATE["total_watches"] += 1
                lbl = f"{t_clean} ({'Dizi' if media_type == 'tv' else 'Film'})" if media_type else t_clean
                if lbl in _ANALYTICS_STATE["top_watched"] or len(_ANALYTICS_STATE["top_watched"]) < 100000:
                    _ANALYTICS_STATE["top_watched"][lbl] = _ANALYTICS_STATE["top_watched"].get(lbl, 0) + 1
        _flush_analytics_to_kv_locked(force=False)


async def robots_txt_endpoint(request: Request) -> Response:
    txt = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /ws/\n"
        "Disallow: /uploads/\n"
        "Disallow: /stats\n"
        "Disallow: /analytics\n"
        "Disallow: /desktop-auth.html\n\n"
        "Sitemap: https://watchlivo.online/sitemap.xml\n"
    )
    return Response(txt, media_type="text/plain; charset=utf-8", headers={"Cache-Control": "public, max-age=3600"})


async def sitemap_xml_endpoint(request: Request) -> Response:
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 10800))
    urls = [
        ("https://watchlivo.online/", "1.0", "daily"),
        ("https://watchlivo.online/about", "0.8", "weekly"),
        ("https://watchlivo.online/privacy", "0.8", "monthly"),
        ("https://watchlivo.online/terms", "0.8", "monthly"),
        ("https://watchlivo.online/dmca", "0.8", "monthly"),
        ("https://watchlivo.online/contact", "0.8", "weekly"),
    ]
    xml_items = "\n".join(
        f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{today}</lastmod>\n    <changefreq>{freq}</changefreq>\n    <priority>{prio}</priority>\n  </url>"
        for loc, prio, freq in urls
    )
    xml_doc = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{xml_items}\n"
        "</urlset>\n"
    )
    return Response(xml_doc, media_type="application/xml; charset=utf-8", headers={"Cache-Control": "public, max-age=3600"})


async def _build_analytics_summary() -> dict:
    day_str = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 10800))
    now_t = time.time()
    try:
        all_rooms = await rooms.STORE.all()
    except Exception:
        all_rooms = []
    active_rooms = 0
    room_users = 0
    for r_obj in (all_rooms or []):
        if isinstance(r_obj, dict):
            active_rooms += 1
            for hp in (r_obj.get("participants") or {}).values():
                if isinstance(hp, dict) and hp.get("transport") != "bot":
                    room_users += 1
    with _ANALYTICS_LOCK:
        _load_analytics_from_kv_locked()
        d_ent = _ANALYTICS_STATE["daily"].get(day_str) or {"pageviews": 0, "visitors": set()}
        online_hb = sum(1 for ts in _ANALYTICS_STATE["active_heartbeats"].values() if now_t - ts <= 300.0)
        top_s = [{"query": k, "count": v} for k, v in sorted(_ANALYTICS_STATE["top_searches"].items(), key=lambda kv: kv[1], reverse=True)[:15]]
        top_w = [{"title": k, "count": v} for k, v in sorted(_ANALYTICS_STATE["top_watched"].items(), key=lambda kv: kv[1], reverse=True)[:15]]
        daily_hist = [
            {"date": dk, "pageviews": int(dv.get("pageviews") or 0), "uniqueVisitors": len(dv.get("visitors") or set())}
            for dk, dv in sorted(_ANALYTICS_STATE["daily"].items())[-14:]
        ]
        return {
            "ok": True,
            "date": day_str,
            "onlineNow": max(online_hb, room_users, 1),
            "activeRooms": active_rooms,
            "roomParticipants": room_users,
            "todayUniqueVisitors": max(len(d_ent.get("visitors") or set()), 1),
            "totalUniqueVisitors": max(len(_ANALYTICS_STATE["visitors"]), 1),
            "todayPageviews": max(int(d_ent.get("pageviews") or 0), 1),
            "totalPageviews": max(int(_ANALYTICS_STATE["total_pageviews"] or 0), 1),
            "totalSearches": int(_ANALYTICS_STATE["total_searches"] or 0),
            "totalWatches": int(_ANALYTICS_STATE["total_watches"] or 0),
            "devices": dict(_ANALYTICS_STATE["devices"]),
            "topSearches": top_s,
            "topWatched": top_w,
            "dailyHistory": daily_hist,
        }


_GA_MEASUREMENT_ID_CACHE: dict = {"id": os.environ.get("GA_MEASUREMENT_ID", "").strip(), "ts": 0.0}


def _get_ga_measurement_id_sync() -> str:
    env_id = os.environ.get("GA_MEASUREMENT_ID", "").strip()
    if env_id:
        return env_id
    now_t = time.time()
    if _GA_MEASUREMENT_ID_CACHE.get("id") and (now_t - float(_GA_MEASUREMENT_ID_CACHE.get("ts") or 0) < 120.0):
        return str(_GA_MEASUREMENT_ID_CACHE["id"])
    try:
        saved_id = social_engine._kv_get("wl:ga_id:v1")
        if isinstance(saved_id, str) and re.fullmatch(r"G-[A-Z0-9]{6,16}", saved_id.strip().upper()):
            _GA_MEASUREMENT_ID_CACHE["id"] = saved_id.strip().upper()
            _GA_MEASUREMENT_ID_CACHE["ts"] = now_t
            return _GA_MEASUREMENT_ID_CACHE["id"]
    except Exception:
        pass
    return str(_GA_MEASUREMENT_ID_CACHE.get("id") or "G-HQXSREQV3R")


def _set_ga_measurement_id_sync(ga_id: str) -> str:
    clean_id = (ga_id or "").strip().upper()
    if clean_id and not re.fullmatch(r"G-[A-Z0-9]{6,16}", clean_id):
        raise ValueError("Geçersiz Google Analytics 4 Ölçüm Kimliği (Örn: G-XXXXXXXXXX)")
    _GA_MEASUREMENT_ID_CACHE["id"] = clean_id
    _GA_MEASUREMENT_ID_CACHE["ts"] = time.time()
    try:
        social_engine._kv_set("wl:ga_id:v1", clean_id)
    except Exception:
        pass
    return clean_id


def _send_server_ga4_hit_sync(vid_hash: str, ua_str: str, ip_str: str, ev: str = "pageview", path_str: str = "/", page_title: str = "") -> None:
    """Server-side GA4 /g/collect relay so Brave Shields / DNS blockers never drop Watchlivo Realtime users."""
    import urllib.parse as _up
    import urllib.request as _ur
    cid_num = int(vid_hash[:8], 16) % 900000000 + 100000000
    now_sec = int(time.time())
    cid = f"{cid_num}.{now_sec - 30}"
    ga_ev = "page_view" if ev in ("pageview", "pwa_launch", "route_view") else ("user_engagement" if ev == "heartbeat" else ev)
    active_id = _get_ga_measurement_id_sync() or "G-HQXSREQV3R"
    tids = list(dict.fromkeys([active_id, "G-HQXSREQV3R", "G-3EGLLTB9J0", "G-82ZD4CPWEP", "G-NJ1NRNFEX6"]))
    for tid in tids:
        try:
            q = _up.urlencode({
                "v": "2",
                "tid": tid,
                "cid": cid,
                "sid": str(now_sec),
                "sct": "1",
                "seg": "1",
                "_s": "1",
                "_p": str(int(time.time() * 1000)),
                "ul": "tr-tr",
                "sr": "1920x1080",
                "dl": f"https://watchlivo.online/{path_str.lstrip('/')}",
                "dt": page_title or "Watchlivo — Birlikte Sinema, Dizi & Müzik Odaları",
                "en": ga_ev,
                "_et": "15000",
                "_nsi": "1",
                "_fv": "1",
                "_ss": "1",
                "_ee": "1",
                "_uip": ip_str if ip_str and ip_str != "127.0.0.1" else "",
            })
            url = f"https://www.google-analytics.com/g/collect?{q}"
            req = _ur.Request(
                url,
                data=b"",
                headers={
                    "User-Agent": ua_str or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
                    "X-Forwarded-For": ip_str,
                },
                method="POST",
            )
            with _ur.urlopen(req, timeout=4.0) as _:
                pass
        except Exception:
            pass


_GA_PROXY_LIMIT = RateLimiter(240, 60.0, name="ga_proxy")


async def rave_ga_collect_proxy(request: Request) -> Response:
    """First-party transport_url relay for Google Analytics 4 (/api/rave/ga-collect/g/collect)."""
    import urllib.request as _ur
    if request.method == "OPTIONS":
        return Response(b"", status_code=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"})
    allowed_ga, retry_ga = _GA_PROXY_LIMIT.hit(client_ip(request))
    if not allowed_ga:
        return too_many_response(retry_ga)
    path_low = str(request.url.path or "").lower()
    sec_dest = (request.headers.get("sec-fetch-dest") or "").lower()
    if "sw_iframe" in path_low or "service_worker" in path_low or path_low.endswith(".html") or sec_dest in ("iframe", "document"):
        return HTMLResponse(
            "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>",
            status_code=200,
            headers={"Cache-Control": "no-store", "Content-Disposition": "inline"},
        )
    qs = str(request.url.query or "")[:4096]
    body_bytes = (await request.body())[:32768]
    ua_str = request.headers.get("user-agent") or "Mozilla/5.0"
    ip_str = client_ip(request)
    if ip_str and ip_str != "127.0.0.1" and "_uip=" not in qs:
        qs = f"{qs}&_uip={ip_str}" if qs else f"_uip={ip_str}"

    def _forward():
        for host in ("https://www.google-analytics.com/g/collect", "https://www.google.com/g/collect"):
            try:
                req = _ur.Request(
                    f"{host}?{qs}",
                    data=body_bytes if request.method == "POST" else None,
                    headers={"User-Agent": ua_str, "X-Forwarded-For": ip_str},
                    method=request.method,
                )
                with _ur.urlopen(req, timeout=4.0) as r:
                    return r.status
            except Exception:
                continue
        return 204

    await asyncio.to_thread(_forward)
    return Response(b"", status_code=204, headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"})


def _is_admin_request(request: Request) -> bool:
    adm_secret = os.environ.get("ADMIN_SECRET", "").strip()
    if not adm_secret:
        return False
    hdr_tok = (request.headers.get("x-admin-secret") or "").strip()
    if not hdr_tok:
        auth_h = (request.headers.get("authorization") or "").strip()
        if auth_h.lower().startswith("bearer "):
            hdr_tok = auth_h[7:].strip()
    return bool(hdr_tok and hmac.compare_digest(hdr_tok, adm_secret))


def _mask_email(raw_email: str) -> str:
    em = str(raw_email or "").strip()
    if not em or "@" not in em:
        return "***" if em else ""
    local, _, domain = em.partition("@")
    head = local[:1] if local else "*"
    return f"{head}***@{domain}"


_CONTACT_LIMIT = RateLimiter(15, 600.0, name="contact_post")


async def rave_analytics_endpoint(request: Request) -> JSONResponse:
    ip_str = client_ip(request)
    ua_str = request.headers.get("user-agent") or ""
    vid_hash = hashlib.sha256(f"wl-vis|{ip_str}|{ua_str[:120]}".encode("utf-8")).hexdigest()[:16]
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        if "gaMeasurementId" in body:
            req_ga = str(body.get("gaMeasurementId") or "").strip().upper()
            cur_ga = await asyncio.to_thread(_get_ga_measurement_id_sync)
            if req_ga != cur_ga and not _is_admin_request(request):
                return JSONResponse(
                    {"ok": False, "error": "Google Analytics kimliğini değiştirmek için yönetici yetkisi gerekli."},
                    status_code=403,
                    headers={"Cache-Control": "no-store"},
                )
            try:
                saved_ga = await asyncio.to_thread(_set_ga_measurement_id_sync, req_ga)
                if "event" not in body:
                    return JSONResponse({"ok": True, "gaMeasurementId": saved_ga}, headers={"Cache-Control": "no-store"})
            except ValueError as ve:
                return JSONResponse({"ok": False, "error": str(ve)}, status_code=400, headers={"Cache-Control": "no-store"})
        ev = str(body.get("event") or "pageview").strip().lower()[:32]
        dev = _detect_device_bucket(ua_str, str(body.get("device") or ""))
        q_str = str(body.get("query") or "")[:80]
        t_str = str(body.get("title") or "")[:100]
        mt_str = str(body.get("mediaType") or "")[:16]
        if ev not in ('heartbeat', 'route_view'):
            await asyncio.to_thread(_track_analytics_sync, ev, vid_hash, dev, q_str, t_str, mt_str)
        await asyncio.to_thread(_send_server_ga4_hit_sync, vid_hash, ua_str, ip_str, ev, str(body.get('path') or '/'), t_str)
        ga_id = await asyncio.to_thread(_get_ga_measurement_id_sync)
        return JSONResponse({"ok": True, "gaMeasurementId": ga_id}, headers={"Cache-Control": "no-store"})
    summary = await _build_analytics_summary()
    summary["gaMeasurementId"] = await asyncio.to_thread(_get_ga_measurement_id_sync)
    return JSONResponse(summary, headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


_CONTACT_MESSAGES_MEM: list = []


def _get_contact_messages_sync() -> list:
    global _CONTACT_MESSAGES_MEM
    try:
        saved = social_engine._kv_get("wl:contact_msgs:v1")
        if isinstance(saved, list) and len(saved) >= len(_CONTACT_MESSAGES_MEM):
            _CONTACT_MESSAGES_MEM = saved[-80:]
    except Exception:
        pass
    return list(_CONTACT_MESSAGES_MEM)


def _save_contact_message_sync(msg: dict) -> list:
    global _CONTACT_MESSAGES_MEM
    msgs = _get_contact_messages_sync()
    msgs.insert(0, msg)
    _CONTACT_MESSAGES_MEM = msgs[:80]
    try:
        social_engine._kv_set("wl:contact_msgs:v1", _CONTACT_MESSAGES_MEM)
    except Exception:
        pass
    return _CONTACT_MESSAGES_MEM


async def rave_contact_endpoint(request: Request) -> JSONResponse:
    if request.method == "POST":
        allowed_c, retry_c = _CONTACT_LIMIT.hit(client_ip(request))
        if not allowed_c:
            return too_many_response(retry_c)
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        cat = str(body.get("category") or "contact").strip()[:24]
        name = str(body.get("name") or "Misafir").strip()[:64]
        email = str(body.get("email") or "").strip()[:96]
        subj = str(body.get("subject") or "").strip()[:140]
        msg = str(body.get("message") or "").strip()[:1200]
        if len(subj) < 2 and len(msg) < 2:
            return JSONResponse({"ok": False, "error": "Lütfen bir başlık veya mesaj girin."}, status_code=400)
        entry = {
            "id": hashlib.sha256(f"{time.time()}|{name}|{subj}".encode("utf-8")).hexdigest()[:10],
            "ts": time.strftime("%Y-%m-%d %H:%M", time.gmtime(time.time() + 10800)),
            "category": cat,
            "name": name,
            "email": email,
            "subject": subj,
            "message": msg,
        }
        await asyncio.to_thread(_save_contact_message_sync, entry)
        safe_entry = {**entry, "email": _mask_email(email)}
        return JSONResponse({"ok": True, "officialEmail": "jokallame0@gmail.com", "entry": safe_entry}, headers={"Cache-Control": "no-store"})
    msgs = await asyncio.to_thread(_get_contact_messages_sync)
    if _is_admin_request(request):
        pub_msgs = [m for m in msgs[:30] if isinstance(m, dict)]
    else:
        pub_msgs = [
            {
                "id": str(m.get("id") or ""),
                "ts": str(m.get("ts") or ""),
                "category": str(m.get("category") or "contact"),
                "name": (str(m.get("name") or "M")[:1] + "***"),
                "email": _mask_email(str(m.get("email") or "")),
                "subject": str(m.get("subject") or ""),
            }
            for m in msgs[:30]
            if isinstance(m, dict)
        ]
    return JSONResponse({"ok": True, "officialEmail": "jokallame0@gmail.com", "messages": pub_msgs}, headers={"Cache-Control": "no-store"})


async def legal_page_endpoint(request: Request) -> HTMLResponse:
    path = request.url.path.strip("/").lower() or "about"
    pages = {
        "about": (
            "Hakkımızda — Watchlivo Birlikte İzleme Odaları",
            "Watchlivo (watchlivo.online) arkadaşlarla aynı anda senkronize izleme (watch party) platformu hakkında kurumsal bilgiler.",
            "ℹ️ Hakkımızda — Watchlivo Sinema & Medya Platformu",
            "<p><b>Watchlivo (watchlivo.online)</b>, insanların fiziksel olarak ayrı olsalar bile aynı anda, tek kare gecikmesiz birlikte film, dizi, anime, canlı TV ve müzik izlemesi için geliştirilmiş yeni nesil bir senkronize izleme (Watch Party) platformudur.</p>"
            "<h3>Öne Çıkan Özelliklerimiz</h3>"
            "<ul><li><b>Saliselik Senkronizasyon:</b> Oynatma, duraklatma ve sarma odadaki herkes için anında eşitlenir.</li>"
            "<li><b>WebRTC Sesli & Yazılı Sohbet:</b> Oda içinde düşük gecikmeli mikrofon, sesli not ve canlı reaksiyonlar.</li>"
            "<li><b>Kendi Hesabınla İzle:</b> Netflix, Disney+, Prime Video gibi platformlarda herkes kendi aboneliğiyle giriş yapar; Watchlivo yalnızca oynat/duraklat/sar komutlarını eşitler, hiçbir video barındırmaz veya sunmaz. YouTube, Vimeo, Twitch ve kendi yüklediğin dosyalar da desteklenir.</li>"
            "<li><b>Tüm Cihazlarda Kurulumsuz Erişim:</b> Web, iOS PWA, Android Native APK v2.0 ve Windows desteği.</li></ul>"
        ),
        "privacy": (
            "Gizlilik Politikası & KVKK — Watchlivo",
            "Watchlivo kişisel verilerin korunması (KVKK), çerez politikası ve WebRTC sesli sohbet gizlilik standartları.",
            "🔒 Gizlilik Politikası & KVKK Aydınlatma Metni",
            "<p><b>Watchlivo (watchlivo.online)</b> olarak kullanıcılarımızın gizliliğine ve 6698 sayılı KVKK ile GDPR standartlarına en üst düzeyde önem veriyoruz.</p>"
            "<ul><li><b>Oda İçi Sesli Sohbet (WebRTC):</b> Sesli görüşmeler anlık iletilir ve sunucularımızda kesinlikle kaydedilmez.</li>"
            "<li><b>Üye ve Misafir Verileri:</b> Kayıtsız misafirler için yalnızca geçici oturum rumuzu kullanılır. Üye bilgileri üçüncü taraflarla paylaşılmaz.</li>"
            "<li><b>Çerezler ve Analitik:</b> Tema, ses ve kaldığınız dakika bilgileri tarayıcınızda tutulur; performans ölçümü için anonim Google Analytics 4 kullanılır.</li></ul>"
        ),
        "terms": (
            "Kullanım Koşulları & Topluluk Kuralları — Watchlivo",
            "Watchlivo izleme odaları kullanım şartları, topluluk kuralları ve kullanıcı sorumlulukları.",
            "📜 Kullanım Koşulları & Topluluk Kuralları",
            "<p><b>watchlivo.online</b> platformunu kullanarak aşağıdaki kuralları kabul etmiş sayılırsınız:</p>"
            "<ul><li>Herkese açık odalarda hakaret, taciz, nefret söylemi ve spam yasaktır.</li>"
            "<li>Oda kurucuları (Host) kendi odalarının moderasyonundan ve şifre ayarlarından yetkilidir.</li>"
            "<li>Platform altyapısına yönelik otomatik bot veya kötüye kullanım girişimleri engellenir.</li></ul>"
        ),
        "dmca": (
            "DMCA & Telif Hakkı Bildirimi — Watchlivo",
            "Watchlivo 5651 sayılı kanun ve DMCA kapsamında yer sağlayıcı ve içerik kaldırma (Uyar-Kaldır) prosedürü.",
            "⚖️ Telif Hakkı (DMCA) & Uyar-Kaldır Bildirimi",
            "<p><b>Watchlivo (watchlivo.online)</b>, 5651 sayılı Kanun ve DMCA (17 U.S.C. § 512) kapsamında kendi sunucularında üçüncü taraf video içeriği barındırmayan ve sunmayan bir birlikte izleme (watch party) platformudur. Platform içerikleri her katılımcı kendi hesabıyla izler; kullanıcıların yüklediği dosyalar ise bildirim üzerine kaldırılır.</p>"
            "<p>Telif hakkı sahipleri, ilgili içeriğin bağlantı bilgisi ve hak sahipliği belgesiyle birlikte resmi e-posta adresimiz üzerinden bildirimde bulunabilir. Geçerli başvurular en geç <b>24 saat içinde</b> dizinden kaldırılır.</p>"
        ),
        "contact": (
            "İletişim & Destek — Watchlivo",
            "Watchlivo resmi iletişim e-posta adresi (jokallame0@gmail.com), hata bildirimi ve DMCA başvuru sayfası.",
            "✉️ İletişim & Destek Merkezi",
            "<p>Görüş, öneri, işbirliği, hata bildirimi veya telif hakkı (DMCA) başvurularınız için bize doğrudan ulaşabilirsiniz:</p>"
            "<!--email_off--><p style='font-size:16px;'><b>📬 Resmi E-Posta Adresimiz:</b> <a href='mailto:jokallame0@gmail.com' style='color:#27dcc8;font-weight:800;'>jokallame0@gmail.com</a></p><!--/email_off-->"
        ),
    }
    title, desc, h1_txt, body_html = pages.get(path, pages["about"])
    csp_nonce = html_mod.escape(str(request.scope.get("csp_nonce") or ""), quote=True)
    form_html = ""
    if path in ("contact", "dmca"):
        def_cat = "dmca" if path == "dmca" else "request"
        form_html = f"""
    <form id="wl-page-contact-form" style="margin-top:18px;display:grid;gap:12px;background:#09101b;padding:18px;border-radius:14px;border:1px solid rgba(39,220,200,.22);">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">
        <label for="wlc-cat" style="font-size:12px;color:#94a3b8;display:grid;gap:4px;">Kategori
          <select id="wlc-cat" style="background:#0d1522;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:14px;">
            <option value="request" {'selected' if def_cat=='request' else ''}>💡 Öneri / İstek</option>
            <option value="bug">🛠️ Hata / Bozuk Bölüm Bildirimi</option>
            <option value="contact">✉️ Genel İletişim</option>
            <option value="dmca" {'selected' if def_cat=='dmca' else ''}>⚖️ DMCA / Telif Bildirimi</option>
          </select>
        </label>
        <label for="wlc-name" style="font-size:12px;color:#94a3b8;display:grid;gap:4px;">Adınız / Rumuz
          <input id="wlc-name" type="text" maxlength="64" placeholder="Adınız" style="background:#0d1522;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:16px;" />
        </label>
        <label for="wlc-email" style="font-size:12px;color:#94a3b8;display:grid;gap:4px;">E-Posta Adresiniz
          <input id="wlc-email" type="email" maxlength="96" placeholder="ornek@eposta.com" style="background:#0d1522;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:16px;" />
        </label>
      </div>
      <label for="wlc-subj" style="font-size:12px;color:#94a3b8;display:grid;gap:4px;">Başlık / İçerik Adı
        <input id="wlc-subj" type="text" required minlength="2" maxlength="140" placeholder="Örn: Öneri veya bildirim konusu" style="background:#0d1522;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:16px;" />
      </label>
      <label for="wlc-msg" style="font-size:12px;color:#94a3b8;display:grid;gap:4px;">Mesajınız
        <textarea id="wlc-msg" rows="4" required minlength="2" maxlength="1200" placeholder="Detayları buraya yazın..." style="background:#0d1522;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:16px;resize:vertical;"></textarea>
      </label>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <button type="submit" style="background:#27dcc8;color:#041014;border:none;border-radius:10px;padding:10px 20px;font-weight:800;font-size:14px;cursor:pointer;">Gönder</button>
        <span id="wlc-status" role="status" aria-live="polite" style="font-size:13px;color:#27dcc8;font-weight:700;"></span>
      </div>
    </form>
    <script nonce="{csp_nonce}">
      document.getElementById('wl-page-contact-form')?.addEventListener('submit', async (ev) => {{
        ev.preventDefault();
        const st = document.getElementById('wlc-status');
        st.style.color = '#27dcc8';
        st.textContent = 'Gönderiliyor...';
        try {{
          const r = await fetch('/api/rave/contact', {{
            method: 'POST',
            headers: {{ 'Content-Type': 'application/json' }},
            body: JSON.stringify({{
              category: document.getElementById('wlc-cat').value,
              name: document.getElementById('wlc-name').value,
              email: document.getElementById('wlc-email').value,
              subject: document.getElementById('wlc-subj').value,
              message: document.getElementById('wlc-msg').value
            }})
          }});
          const d = await r.json();
          if (r.ok && d.ok) {{
            st.textContent = '✅ Mesajınız iletildi! En kısa sürede incelenecektir.';
            ev.target.reset();
          }} else {{
            st.style.color = '#f87171';
            st.textContent = '❌ ' + (d.error || 'Gönderilemedi.');
          }}
        }} catch (_) {{
          st.style.color = '#f87171';
          st.textContent = '❌ Ağ bağlantısı hatası.';
        }}
      }});
    </script>"""
    esc_t = html_mod.escape(title, quote=True)
    esc_d = html_mod.escape(desc, quote=True)
    esc_p = html_mod.escape(path, quote=True)
    canon_u = f"https://watchlivo.online/{esc_p}"
    html_doc = f"""<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{esc_t}</title>
  <meta name="description" content="{esc_d}" />
  <link rel="canonical" href="{canon_u}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Watchlivo" />
  <meta property="og:title" content="{esc_t}" />
  <meta property="og:description" content="{esc_d}" />
  <meta property="og:url" content="{canon_u}" />
  <meta property="og:image" content="https://watchlivo.online/static/watchlivo-og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{esc_t}" />
  <meta name="twitter:description" content="{esc_d}" />
  <meta name="twitter:image" content="https://watchlivo.online/static/watchlivo-og.png" />
  <style>
    body {{ margin:0; background:#070b12; color:#f8fafc; font-family:Inter,system-ui,sans-serif; padding:28px 18px; line-height:1.65; }}
    .box {{ max-width:820px; margin:0 auto; background:#0d1522; border:1px solid rgba(39,220,200,.25); border-radius:20px; padding:28px; }}
    nav {{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:20px; padding-bottom:14px; border-bottom:1px solid rgba(255,255,255,.08); }}
    nav a {{ color:#94a3b8; text-decoration:none; font-size:13px; font-weight:700; padding:6px 12px; border-radius:999px; background:rgba(255,255,255,.05); }}
    nav a.act, nav a:hover {{ color:#041014; background:#27dcc8; }}
    a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {{ outline:2px solid #27dcc8; outline-offset:2px; }}
    h1 {{ margin:0 0 14px; font-size:22px; color:#fff; }}
    p, li {{ color:#cbd5e1; font-size:14px; }}
    .foot {{ margin-top:24px; padding-top:14px; border-top:1px solid rgba(255,255,255,.08); font-size:13px; color:#94a3b8; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; }}
  </style>
</head>
<body>
  <div class="box">
    <nav aria-label="Kurumsal sayfalar">
      <a href="/">← Watchlivo Ana Sayfa</a>
      <a href="/about" class="{'act' if path=='about' else ''}">Hakkımızda</a>
      <a href="/privacy" class="{'act' if path=='privacy' else ''}">Gizlilik & KVKK</a>
      <a href="/terms" class="{'act' if path=='terms' else ''}">Kullanım Koşulları</a>
      <a href="/dmca" class="{'act' if path=='dmca' else ''}">DMCA / Telif</a>
      <a href="/contact" class="{'act' if path=='contact' else ''}">İletişim</a>
    </nav>
    <main>
      <h1>{h1_txt}</h1>
      {body_html}
      {form_html}
    </main>
    <div class="foot">
      <!--email_off--><span>📩 Resmi İletişim & Hukuk: <a href="mailto:jokallame0@gmail.com" style="color:#27dcc8;font-weight:700;">jokallame0@gmail.com</a></span><!--/email_off-->
      <span>© 2026 Watchlivo (watchlivo.online)</span>
    </div>
  </div>
</body>
</html>"""
    cache_hdr = "private, no-store, must-revalidate" if form_html else "public, max-age=3600"
    return HTMLResponse(html_doc, headers={"Cache-Control": cache_hdr})


async def analytics_dashboard_page(request: Request) -> HTMLResponse:
    csp_nonce = html_mod.escape(str(request.scope.get("csp_nonce") or ""), quote=True)
    data = await _build_analytics_summary()
    ga_id = await asyncio.to_thread(_get_ga_measurement_id_sync)
    ga_status = f"🟢 Aktif ({html_mod.escape(ga_id)})" if ga_id else "⚪ G-XXXXXXXXXX Ölçüm Kimliği Bekleniyor"
    s_rows = "".join(
        f"<tr><td>{i}</td><td>{html_mod.escape(x['query'])}</td><td style='text-align:right;font-weight:700;color:#27dcc8;'>{x['count']}</td></tr>"
        for i, x in enumerate(data["topSearches"], 1)
    ) or "<tr><td colspan='3' style='color:#64748b;'>Henüz arama kaydı yok</td></tr>"
    w_rows = "".join(
        f"<tr><td>{i}</td><td>{html_mod.escape(x['title'])}</td><td style='text-align:right;font-weight:700;color:#10b981;'>{x['count']}</td></tr>"
        for i, x in enumerate(data["topWatched"], 1)
    ) or "<tr><td colspan='3' style='color:#64748b;'>Henüz izleme kaydı yok</td></tr>"
    is_admin = _is_admin_request(request)
    contact_msgs = (await asyncio.to_thread(_get_contact_messages_sync)) if is_admin else []
    if is_admin:
        c_rows = "".join(
            f"<tr><td>{html_mod.escape(m.get('ts',''))}</td><td><b>{html_mod.escape(m.get('category',''))}</b></td><td>{html_mod.escape(m.get('name',''))} ({html_mod.escape(m.get('email',''))})</td><td><b>{html_mod.escape(m.get('subject',''))}</b> — {html_mod.escape(m.get('message',''))}</td></tr>"
            for m in contact_msgs[:15]
        ) or "<tr><td colspan='4' style='color:#94a3b8;'>Henüz gelen istek veya iletişim mesajı yok</td></tr>"
    else:
        c_rows = "<tr><td colspan='4' style='color:#94a3b8;'>🔒 İletişim mesajları yalnızca yetkili yönetici oturumunda görüntülenebilir.</td></tr>"
    devs = data["devices"]
    html = f"""<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Watchlivo — Google Analytics 4 & SEO Yönetim Paneli</title>
  <style>
    body {{ margin:0; background:#070b12; color:#f8fafc; font-family:Inter,system-ui,sans-serif; padding:24px; }}
    .wrap {{ max-width:1080px; margin:0 auto; }}
    .top {{ display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:20px; }}
    .badge {{ background:rgba(16,185,129,.15); border:1px solid rgba(39,220,200,.4); color:#27dcc8; padding:6px 14px; border-radius:999px; font-size:13px; font-weight:700; }}
    .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; margin-bottom:22px; }}
    .card {{ background:#0d1522; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:18px; }}
    .lbl {{ color:#94a3b8; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }}
    .val {{ font-size:28px; font-weight:800; color:#fff; margin-top:6px; }}
    .sub {{ font-size:12px; color:#27dcc8; margin-top:4px; }}
    .cols {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }}
    table {{ width:100%; border-collapse:collapse; font-size:13px; margin-top:10px; }}
    th, td {{ padding:8px 6px; border-bottom:1px solid rgba(255,255,255,.06); text-align:left; }}
    th {{ color:#94a3b8; font-weight:600; }}
    a.btn, button.btn {{ color:#041014; background:#27dcc8; padding:9px 16px; border-radius:10px; text-decoration:none; font-weight:700; font-size:13px; border:none; cursor:pointer; }}
    input.inp {{ background:#070b12; border:1px solid rgba(39,220,200,.35); color:#fff; padding:9px 14px; border-radius:10px; font-size:14px; min-width:220px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1 style="margin:0;font-size:22px;">📈 Watchlivo — Google Analytics 4 (`gtag.js`) & SEO Yönetimi</h1>
        <div style="color:#94a3b8;font-size:13px;margin-top:4px;">Bu sayfayı yenilemek sayacı ARTIRMAZ · Yalnızca gerçek tekil oturumlar ve Google Analytics 4 olayları işlenir.</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <span class="badge">{ga_status}</span>
        <a class="btn" href="/">← Watchlivo Ana Sayfa</a>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px;border-color:rgba(39,220,200,.35);">
      <div class="lbl">🔗 Resmi Google Analytics 4 (`gtag.js`) Bağlantısı</div>
      <p style="font-size:13px;color:#cbd5e1;margin:8px 0 12px;">Google Analytics 4 mülkünüzün <b>G-XXXXXXXXXX</b> Ölçüm Kimliğini aşağıya girip kaydedin; tüm sayfa görüntülemeleri, film/dizi aramaları ve oda katılımları doğrudan resmi Google Analytics 4 panelinize (`analytics.google.com`) akar.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <input id="ga-inp" class="inp" placeholder="G-XXXXXXXXXX" value="{html_mod.escape(ga_id)}" />
        <button id="btn-save-ga" type="button" class="btn">Kaydet & Google Analytics'i Aktifleştir</button>
        <span id="ga-msg" style="font-size:13px;color:#27dcc8;font-weight:700;"></span>
      </div>
    </div>
    <div class="cols">
      <div class="card">
        <div class="lbl">🔍 En Çok Aranan İçerikler (Sunucu İçi Top 15)</div>
        <table><thead><tr><th>#</th><th>Sorgu</th><th style="text-align:right;">Adet</th></tr></thead><tbody>{s_rows}</tbody></table>
      </div>
      <div class="card">
        <div class="lbl">🎬 En Çok Açılan / İzlenen Yapımlar (Sunucu İçi Top 15)</div>
        <table><thead><tr><th>#</th><th>Yapım</th><th style="text-align:right;">Adet</th></tr></thead><tbody>{w_rows}</tbody></table>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="lbl">📩 Gelen Film/Dizi İstekleri, Hata Bildirimleri & İletişim Mesajları (Resmi E-Posta: jokallame0@gmail.com)</div>
      <table><thead><tr><th>Tarih</th><th>Kategori</th><th>Gönderen</th><th>Başlık & Mesaj</th></tr></thead><tbody>{c_rows}</tbody></table>
    </div>
  </div>
  <script nonce="{csp_nonce}">
    async function saveGaId() {{
      const v = document.getElementById('ga-inp').value.trim().toUpperCase();
      const msg = document.getElementById('ga-msg');
      msg.textContent = 'Kaydediliyor...';
      const r = await fetch('/api/rave/analytics', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ gaMeasurementId: v }})
      }});
      const d = await r.json();
      if (d.ok) {{
        msg.textContent = '✅ Kaydedildi: ' + (d.gaMeasurementId || 'Temizlendi');
        setTimeout(() => location.reload(), 600);
      }} else {{
        msg.style.color = '#f87171';
        msg.textContent = '❌ ' + (d.error || 'Hata');
      }}
    }}
    document.getElementById('btn-save-ga')?.addEventListener('click', saveGaId);
  </script>
</body>
</html>"""
    return HTMLResponse(html, headers={"Cache-Control": "no-store, must-revalidate"})


class SelectiveGZipMiddleware:
    """Compress HTML/JS/CSS/JSON/VTT/M3U8 while keeping byte-range media streams unbuffered."""

    _SKIP_PREFIXES = (
        "/api/rave/yt-music-stream",
        "/api/rave/voice-note/",
        "/uploads/",
        "/download/",
    )

    def __init__(self, app, minimum_size: int = 1000):
        self.raw_app = app
        self.gzip_app = GZipMiddleware(app, minimum_size=minimum_size)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = str(scope.get("path") or "")
            if path.startswith(self._SKIP_PREFIXES) or path.lower().endswith((".apk", ".ipa", ".exe", ".mp4", ".mp3", ".webm")):
                await self.raw_app(scope, receive, send)
                return
        await self.gzip_app(scope, receive, send)


async def _favicon_endpoint(request: Request):
    svg = STATIC_DIR / "watchlivo-logo.svg"
    if svg.exists():
        return FileResponse(svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=204)


async def _apple_touch_icon_endpoint(request: Request):
    png = STATIC_DIR / "watchlivo-icon-192.png"
    if png.exists():
        return FileResponse(png, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=204)


async def desktop_auth_page(request: Request):
    page = STATIC_DIR / "desktop-auth.html"
    if page.exists():
        return FileResponse(
            page,
            media_type="text/html; charset=utf-8",
            headers={
                "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
                "X-Robots-Tag": "noindex, nofollow",
            },
        )
    return Response("Not found", status_code=404)


async def _index_html_redirect(request: Request):
    qs = str(request.url.query or "")
    return RedirectResponse(f"/?{qs}" if qs else "/", status_code=301)


app = Starlette(
    routes=[
        Route("/", index),
        Route("/index.html", _index_html_redirect, methods=["GET", "HEAD"]),
        Route("/desktop-auth.html", desktop_auth_page, methods=["GET", "HEAD"]),
        Route("/favicon.ico", _favicon_endpoint, methods=["GET", "HEAD"]),
        Route("/apple-touch-icon.png", _apple_touch_icon_endpoint, methods=["GET", "HEAD"]),
        Route("/apple-touch-icon-precomposed.png", _apple_touch_icon_endpoint, methods=["GET", "HEAD"]),
        Route("/robots.txt", robots_txt_endpoint, methods=["GET", "HEAD"]),
        Route("/sitemap.xml", sitemap_xml_endpoint, methods=["GET", "HEAD"]),
        Route("/stats", analytics_dashboard_page, methods=["GET"]),
        Route("/analytics", analytics_dashboard_page, methods=["GET"]),
        Route("/about", legal_page_endpoint, methods=["GET", "HEAD"]),
        Route("/privacy", legal_page_endpoint, methods=["GET", "HEAD"]),
        Route("/terms", legal_page_endpoint, methods=["GET", "HEAD"]),
        Route("/dmca", legal_page_endpoint, methods=["GET", "HEAD"]),
        Route("/contact", legal_page_endpoint, methods=["GET", "HEAD"]),
        Route("/api/rave/contact", rave_contact_endpoint, methods=["GET", "POST"]),
        Route("/api/rave/analytics", rave_analytics_endpoint, methods=["GET", "POST"]),
        Route("/api/rave/ga-collect/{rest:path}", rave_ga_collect_proxy, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/ga-collect", rave_ga_collect_proxy, methods=["GET", "POST", "OPTIONS"]),
        Route("/r/{room_id}", room_share_landing),
        Route("/join/{room_id}", room_share_landing),
        Route("/manifest.json", manifest_json, methods=["GET", "HEAD"]),
        Route("/manifest.webmanifest", manifest_json, methods=["GET", "HEAD"]),
        Route("/sw.js", service_worker),
        Route("/api/health", health),
        Route("/api/app/version", app_version_endpoint, methods=["GET", "HEAD"]),
        Route("/app_version.json", app_version_endpoint, methods=["GET", "HEAD"]),
        Route("/api/ios/version", ios_version_endpoint, methods=["GET", "HEAD"]),
        Route("/ios_version.json", ios_version_endpoint, methods=["GET", "HEAD"]),
        Route("/api/ios/manifest.plist", ios_manifest_endpoint, methods=["GET", "HEAD"]),
        Route("/download/apk", download_apk_endpoint),
        Route("/download/Watchlivo-v2.0.apk", download_apk_endpoint),
        Route("/download/Watchlivo-v2.0.0.apk", download_apk_endpoint),
        Route("/download/ipa", download_ipa_endpoint),
        Route("/download/Watchlivo.ipa", download_ipa_endpoint),
        Route("/download/Watchlivo-v2.0.ipa", download_ipa_endpoint),
        Route("/download/ios", download_ios_endpoint),
        Route("/download/windows", download_windows_endpoint),
        Route("/download/exe", download_windows_endpoint),
        Route("/api/auth/register", auth_engine.auth_register, methods=["POST"]),
        Route("/api/auth/login", auth_engine.auth_login, methods=["POST"]),
        Route("/api/auth/oauth", auth_engine.auth_oauth, methods=["POST"]),
        Route("/api/auth/phone/send-code", auth_engine.auth_phone_send_code, methods=["POST"]),
        Route("/api/auth/phone/verify-code", auth_engine.auth_phone_verify_code, methods=["POST"]),
        Route("/api/auth/email-action", auth_engine.auth_email_action, methods=["POST"]),
        Route("/api/auth/reset-password", auth_engine.auth_email_action, methods=["POST"]),
        Route("/api/auth/password", auth_engine.auth_change_password, methods=["POST", "PUT"]),
        Route("/api/auth/change-password", auth_engine.auth_change_password, methods=["POST", "PUT"]),
        Route("/api/auth/delete", auth_engine.auth_delete_account, methods=["POST", "DELETE"]),
        Route("/api/auth/account/delete", auth_engine.auth_delete_account, methods=["POST", "DELETE"]),
        Route("/api/auth/account", auth_engine.auth_delete_account, methods=["DELETE"]),
        Route("/api/auth/profile", auth_engine.auth_profile, methods=["POST"]),
        Route("/api/auth/profile", auth_engine.auth_delete_account, methods=["DELETE"]),
        Route("/api/auth/logout", auth_engine.auth_logout, methods=["POST"]),
        Route("/api/auth/me", auth_engine.auth_me, methods=["GET"]),
        Route("/api/auth/me", auth_engine.auth_delete_account, methods=["DELETE"]),
        Route("/api/rave/social/guest", social_engine.social_guest_provision, methods=["POST"]),
        Route("/api/rave/social/state", social_engine.social_state, methods=["GET"]),
        Route("/api/rave/social/search", social_engine.social_user_search, methods=["GET"]),
        Route("/api/rave/social/presence", social_engine.social_presence, methods=["GET", "POST"]),
        Route("/api/rave/social/invite", social_engine.social_invite, methods=["POST"]),
        Route("/api/rave/social/friends", social_engine.social_friends_action, methods=["POST"]),
        Route("/api/rave/social/dm", social_engine.social_dm_get, methods=["GET"]),
        Route("/api/rave/social/dm", social_engine.social_dm_send, methods=["POST"]),
        Route("/api/rave/voice-note", social_engine.voice_note_upload, methods=["POST"]),
        Route("/api/rave/voice-note/{note_id}", social_engine.voice_note_stream, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/voice-relay/{room_id}", social_engine.voice_relay_endpoint, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/voice-relay", social_engine.voice_relay_endpoint, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/social/voice-relay/{room_id}", social_engine.voice_relay_endpoint, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/social/voice-relay", social_engine.voice_relay_endpoint, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/link-preview", social_engine.link_preview, methods=["GET"]),
        Route("/api/rave/translate-chat", social_engine.translate_chat, methods=["GET"]),
        Route("/api/rave/playlist", social_engine.youtube_playlist, methods=["GET"]),
        Route("/api/rave/ravedj-mashup", social_engine.ravedj_mashup, methods=["GET", "POST"]),
        Route("/api/rave/ravedj-trending", social_engine.ravedj_trending, methods=["GET"]),
        Route("/api/rave/ai-image", social_engine.ai_image_generate, methods=["GET", "POST"]),
        Route("/api/rave/ai-image-history", social_engine.ai_image_history, methods=["GET"]),
        Route("/api/rave/gdrive-folder", social_engine.gdrive_folder_browse, methods=["GET"]),
        Route("/api/rave/report", social_engine.moderation_report, methods=["POST"]),
        Route("/api/rave/notifications/subscribe", social_engine.notifications_subscribe, methods=["POST"]),
        Route("/api/rave/notifications/send", social_engine.notifications_send, methods=["POST"]),
        Route("/api/rave/notifications/poll", social_engine.notifications_poll, methods=["GET"]),
        Route("/api/user/progress", social_engine.user_progress_get, methods=["GET"]),
        Route("/api/user/progress", social_engine.user_progress_save, methods=["POST"]),
        Route("/api/user/watchlist", social_engine.user_watchlist_get, methods=["GET"]),
        Route("/api/user/watchlist", social_engine.user_watchlist_toggle, methods=["POST"]),
        Route("/api/user/music-history", social_engine.user_music_history_get, methods=["GET"]),
        Route("/api/user/music-history", social_engine.user_music_history_save, methods=["POST"]),
        Route("/api/user/yt-preferences", social_engine.user_yt_prefs_get, methods=["GET"]),
        Route("/api/user/yt-preferences", social_engine.user_yt_prefs_save, methods=["POST"]),
        Route("/api/rave/yt-personalized-feed", yt_personalized_feed, methods=["GET", "POST"]),
        Route("/api/rave/yt-feed", yt_personalized_feed, methods=["GET", "POST"]),
        Route("/api/rave/ai-status", rave_ai_status),
        Route("/api/rave/ai-chat", rave_ai_chat, methods=["GET", "POST"]),
        Route("/api/rave/suno-generate", rave_suno_generate, methods=["POST"]),
        Route("/api/search/youtube", search_youtube),
        Route("/api/rave/yt-search", search_youtube),
        Route("/api/rave/supersearch", supersearch),
        Route("/api/rave/music-catalog", music_engine.music_catalog),
        Route("/api/rave/music-similar", music_engine.music_similar),
        Route("/api/rave/music-resolve", music_engine.music_resolve),
        Route("/api/rave/resolve-music", music_engine.music_resolve),
        Route("/api/rave/music-lyrics.vtt", music_engine.music_lyrics_vtt),
        Route("/api/rave/lyrics", music_engine.music_lyrics_vtt),
        Route("/api/rave/yt-music-stream", music_engine.yt_music_stream, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/yt-pip-hls.m3u8", music_engine.yt_pip_hls_master, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/yt-pip-track.m3u8", music_engine.yt_pip_hls_track, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/subtitles", rave_subtitles),
        Route("/api/rave/subtitle.vtt", rave_subtitle_vtt, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/sub-vtt-translate", rave_sub_vtt_translate, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/meshes", rave_meshes_compat, methods=["GET", "POST"]),
        Route("/api/rave/tts", rave_tts),
        Route("/api/rave/accounts", rave_get_accounts),
        Route("/api/rave/gifs", gifs),
        Route("/api/rave/oembed", vimeo_oembed),
        Route("/api/upload", upload_file, methods=["POST"]),
        Route("/api/rooms", rooms.list_rooms),
        Route("/b8f4e2a9c1d74e36a5b09f82c4e1d3a7.txt", indexnow_key_endpoint),
        Route("/api/rooms/create", rooms.create_room, methods=["POST"]),
        Route("/api/rooms/{room_id}", rooms.room_info),
        Route("/api/rooms/{room_id}/sync", rooms.http_sync, methods=["GET", "POST"]),
        Route("/api/rooms/{room_id}/poll", rooms.http_sync, methods=["GET", "POST"]),
        Route("/api/rooms/{room_id}/action", rooms.http_sync, methods=["POST"]),
        WebSocketRoute("/ws/{room_id}", rooms.ws_endpoint),
        Mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR), check_dir=False), name="uploads"),
        Mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static"),
    ],
    middleware=[
        Middleware(SecurityHeaders),
        Middleware(SelectiveGZipMiddleware, minimum_size=1000),
        Middleware(IdentityMiddleware),
    ],
)


def _serve() -> None:
    """Run the Starlette app locally. Vercel imports `app` directly instead."""
    host = os.environ.get("HOST") or "127.0.0.1"
    port = int(os.environ.get("PORT") or 8000)
    try:
        import uvicorn
    except ImportError:
        raise SystemExit("uvicorn is missing. Run: pip install -r requirements.txt")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    _serve()

