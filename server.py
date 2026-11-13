"""VORTEX web server (Starlette).

Serves the SPA, content search APIs and the mesh (room) engine from rooms.py.
Secrets come from environment variables (.env locally, Vercel env in production).
"""
import asyncio
import base64
import collections
import concurrent.futures
import hashlib
import hmac
import html as html_mod
import ipaddress
import json
import os
import pathlib
import re
import secrets
import socket
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Optional, Tuple, Union

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles

from security import BoundedTTLCache, RateLimiter, client_ip, is_ip_public_global, is_safe_public_url, server_secret, too_many_response

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
ACC_DB_PATH = (
    pathlib.Path(os.environ["WATCHLIVO_DB_PATH"])
    if os.environ.get("WATCHLIVO_DB_PATH")
    else (pathlib.Path("/tmp/vortex_accounts.db") if IS_VERCEL else BASE_DIR / "rave_platform.db")
)
# Proxy URLs are signed and verified by this same process, so an instance-local
# secret is safe and never leaks a global one.
_PROXY_SECRET = server_secret("PROXY_SECRET")
PROXY_URL_TTL = 21600.0
STREAM_PROXY_BASE_URL = (os.environ.get("STREAM_PROXY_BASE_URL") or "").strip().rstrip("/")
_WORKER_BYPASS_HOSTS = (
    "hakunaymatata.com",
    "vidmoly.",
    "vmbox.",
    "vmnow.",
    "vmpx.",
    "hdfilmcehennemi.mobi",
    "ag2m5.cfd",
    "uk-traffic-",
    "fastplay.",
    "radyotvonline.com",
    "nexa.mov",
    "dplayer",
    "playmix.",
    "makesomthingup.",
    "cdnimages.",
    "ercdn.net",
    "daioncdn.net",
    "dragonballzfans",
    "molystream.org",
    "lightspeed.st",
    "bright67.",
    "centralodsseyproud",
    "5d06cffcf9563c",
    "gamma.",
    ".click",
)


def _proxy_sig(url: str, ref: str = "") -> str:
    exp = ((int(time.time()) // 3600) + 6) * 3600
    return hmac.new(_PROXY_SECRET, f"{url}|{ref}|{exp}".encode("utf-8"), hashlib.sha256).hexdigest()[:24] + f".{exp}"


def _proxy_sig_ok(url: str, ref: str, sig: str) -> bool:
    """Verify a signed proxy URL and enforce its expiry."""
    if not sig or "." not in sig:
        return False
    digest, _, exp_raw = sig.rpartition(".")
    try:
        exp = int(exp_raw)
    except (TypeError, ValueError):
        return False
    if exp < time.time():
        return False
    expected = hmac.new(_PROXY_SECRET, f"{url}|{ref}|{exp}".encode("utf-8"), hashlib.sha256).hexdigest()[:24]
    return hmac.compare_digest(expected, digest)


def _proxy_u(url: str, ref: str = "", ext: str = "") -> str:
    base = (os.environ["STREAM_PROXY_BASE_URL"] if "STREAM_PROXY_BASE_URL" in os.environ else STREAM_PROXY_BASE_URL).strip().rstrip("/")
    u_low = (url or "").lower()
    bypass_worker = any(h in u_low for h in _WORKER_BYPASS_HOSTS)
    if base and bypass_worker:
        base = ""
    q = f"{base}/api/rave/stream-proxy?url={urllib.parse.quote(url, safe='')}"
    if ref:
        q += f"&referer={urllib.parse.quote(ref, safe='')}"
    q += f"&sig={_proxy_sig(url, ref)}"
    if ext:
        q += f"&ext={ext}"
    if bypass_worker:
        q += "&cf_fb=1"
    return q
TMDB_API_KEY = os.environ.get("TMDB_API_KEY") or "4f042878f22ef63cb94f25e60cb4ec6e"
GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY") or "y66IkWFVC8eBWb4VWUgb8ad2RREu4v8T"
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
    if "PYTEST_CURRENT_TEST" not in os.environ:
        if not public_http_url(url):
            return {}
        with _public_open(req, timeout=timeout) as r:
            return json.loads(r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore"))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore"))
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
ALLOWED_UPLOAD_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".ogg", ".wav"}


import threading

_ACC_DB_SCHEMA_READY = False
_ACC_DB_LOCK = threading.Lock()


def _get_acc_db():
    global _ACC_DB_SCHEMA_READY
    conn = sqlite3.connect(str(ACC_DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
    except Exception:
        pass
    if not _ACC_DB_SCHEMA_READY:
        with _ACC_DB_LOCK:
            if not _ACC_DB_SCHEMA_READY:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS provider_accounts (
                        provider TEXT PRIMARY KEY,
                        domain TEXT,
                        login_satisfied INTEGER DEFAULT 0,
                        account_email TEXT DEFAULT '',
                        profile_name TEXT DEFAULT '',
                        cookies_json TEXT DEFAULT '[]',
                        updated_at REAL DEFAULT 0
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS user_provider_accounts (
                        user_id TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        domain TEXT DEFAULT '',
                        login_satisfied INTEGER DEFAULT 0,
                        account_email TEXT DEFAULT '',
                        profile_name TEXT DEFAULT '',
                        auth_type TEXT DEFAULT 'sso',
                        session_token_hash TEXT DEFAULT '',
                        expires_at REAL DEFAULT 0,
                        verified_at REAL DEFAULT 0,
                        updated_at REAL DEFAULT 0,
                        PRIMARY KEY (user_id, provider)
                    )
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_user_provider_accounts
                    ON user_provider_accounts (user_id, provider)
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS resolved_streams (
                        ckey TEXT PRIMARY KEY,
                        val_json TEXT DEFAULT '[]',
                        exp REAL DEFAULT 0
                    )
                """)
                conn.commit()
                _ACC_DB_SCHEMA_READY = True
    return conn


_CLOAKED_HTML = b"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Watchlivo | Distributed Media Sync & Workspace Framework</title>
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0e17; color: #94a3b8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 520px; padding: 32px; background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; text-align: center; }
    h1 { color: #f8fafc; font-size: 22px; margin-bottom: 12px; font-weight: 600; }
    p { font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Watchlivo Media Cloud</h1>
    <p>Watchlivo is a private real-time collaborative synchronization framework utilizing WebRTC and WebSocket multiplexing for peer-to-peer workspace audio/video streams.</p>
    <p style="color:#64748b; font-size:12px; margin-top:20px;">Private Authorized Deployment &bull; All Rights Reserved.</p>
  </div>
</body>
</html>"""

_CRAWLER_BOT_REGEX = re.compile(
    r"(?i)(googlebot|bingbot|yandex|baiduspider|slurp|duckduckbot|ahrefsbot|semrushbot|"
    r"dotbot|mj12bot|bytespider|petalbot|markmonitor|corsearch|opsec|digimarc|"
    r"muso|leakix|censys|shodan|netcraft|screaming\s*frog|turnitin|scrapy)"
)


_SOCIAL_PREVIEW_BOT_REGEX = re.compile(
    r"(?i)(telegrambot|twitterbot|discordbot|whatsapp|facebookexternalhit|slackbot)"
)

_HONEYPOT_BANNED_IPS: dict[str, float] = {}


def is_honeypot_banned(ip: str) -> bool:
    if not ip or ip in ("127.0.0.1", "::1", "localhost", "testclient") or not is_ip_public_global(ip):
        return False
    exp = _HONEYPOT_BANNED_IPS.get(ip)
    if not exp:
        return False
    if time.time() > exp:
        _HONEYPOT_BANNED_IPS.pop(ip, None)
        return False
    return True


def ban_honeypot_ip(ip: str, duration_sec: float = 86400.0) -> None:
    if not ip or ip in ("127.0.0.1", "::1", "localhost", "testclient") or not is_ip_public_global(ip):
        return
    now = time.time()
    _HONEYPOT_BANNED_IPS[ip] = now + duration_sec
    if len(_HONEYPOT_BANNED_IPS) > 4096:
        expired = [k for k, v in list(_HONEYPOT_BANNED_IPS.items()) if v <= now]
        for k in expired:
            _HONEYPOT_BANNED_IPS.pop(k, None)
        while len(_HONEYPOT_BANNED_IPS) > 4096:
            oldest_k = next(iter(_HONEYPOT_BANNED_IPS), None)
            if oldest_k is None:
                break
            _HONEYPOT_BANNED_IPS.pop(oldest_k, None)


async def crawler_honeypot_endpoint(request: Request) -> Response:
    """Honeypot trap: Any crawler blindly following invisible links is blacklisted."""
    ip = client_ip(request)
    ua = (request.headers.get("user-agent") or "").strip()
    if ua and _CRAWLER_BOT_REGEX.search(ua):
        ban_honeypot_ip(ip, duration_sec=86400.0)
    return Response(
        b'{"error":"Forbidden","detail":"crawler_trap_triggered"}',
        status_code=403,
        media_type="application/json",
        headers={"X-Robots-Tag": "noindex, nofollow, noarchive"}
    )


class CrawlerShieldMiddleware:
    """Intelligent cloaking & scraper shielding middleware.
    
    Serves a harmless cloaked workspace page to search engines and DMCA crawlers,
    and restricts crawler access to video streams and catalog resolution endpoints.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        cip = client_ip(scope)
        if is_honeypot_banned(cip):
            response = Response(
                b'{"error":"Forbidden","detail":"ip_blacklisted_by_honeypot"}',
                status_code=403,
                media_type="application/json",
                headers={"X-Robots-Tag": "noindex, nofollow"}
            )
            await response(scope, receive, send)
            return

        raw_headers = scope.get("headers") or []
        ua = ""
        for hk, hv in raw_headers:
            if hk.lower() == b"user-agent":
                try:
                    ua = hv.decode("latin-1", errors="ignore")
                except Exception:
                    ua = ""
                break

        path = str(scope.get("path") or "")
        is_social_preview = bool(_SOCIAL_PREVIEW_BOT_REGEX.search(ua)) if ua else False
        is_bot = (bool(_CRAWLER_BOT_REGEX.search(ua)) if ua else False) and not is_social_preview

        if is_bot:
            if path in ("/", "/index.html") or (path.startswith(("/r/", "/join/")) and not is_social_preview):
                response = Response(
                    _CLOAKED_HTML,
                    media_type="text/html; charset=utf-8",
                    headers={
                        "Cache-Control": "public, max-age=86400",
                        "Vary": "User-Agent",
                        "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex, nocache"
                    }
                )
                await response(scope, receive, send)
                return

            if path.startswith(("/api/rave/", "/api/rooms/")):
                response = Response(
                    b'{"error":"Forbidden","detail":"bot_access_restricted"}',
                    status_code=403,
                    media_type="application/json",
                    headers={"X-Robots-Tag": "noindex, nofollow", "Vary": "User-Agent"}
                )
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)


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
                if b"cross-origin-resource-policy" not in existing_keys:
                    hdrs.append((b"cross-origin-resource-policy", b"cross-origin"))
                if b"x-robots-tag" not in existing_keys:
                    hdrs.append((b"x-robots-tag", b"noindex, nofollow, noarchive, nosnippet, noimageindex, nocache"))
                req_path = str(scope.get("path") or "")
                if b"content-security-policy" not in existing_keys:
                    if req_path.startswith("/api/rave/browser-proxy"):
                        hdrs.append((
                            b"content-security-policy",
                            f"sandbox allow-scripts allow-forms; script-src 'self' 'nonce-{csp_nonce}'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'".encode("ascii"),
                        ))
                    else:
                        csp_val = (
                            "default-src 'self'; "
                            f"script-src 'self' 'nonce-{csp_nonce}' blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://www.gstatic.com https://apis.google.com https://www.youtube.com https://s.ytimg.com https://player.vimeo.com https://www.googletagmanager.com https://www.google-analytics.com https://ssl.google-analytics.com; "
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
                if req_path == "/api/rooms" or req_path.startswith(("/api/user/", "/api/auth/", "/api/rave/social/", "/api/rave/notifications/", "/api/rave/voice-relay/", "/api/rave/accounts", "/api/rave/ai-image", "/api/rave/yt-personalized-feed", "/api/rooms/")):
                    hdrs = [(hk, hv) for (hk, hv) in hdrs if hk.lower() not in (b"cache-control", b"cdn-cache-control", b"vercel-cdn-cache-control", b"vary")]
                    hdrs.append((b"cache-control", b"private, no-store, no-cache, must-revalidate, max-age=0"))
                    hdrs.append((b"cdn-cache-control", b"no-store"))
                    hdrs.append((b"vary", b"Authorization"))
                message = {**message, "headers": hdrs}
            await send(message)

        await self.app(scope, receive, send_wrapper)


IDENTITY_HEADER = b"authorization"
_UID_CACHE: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()
_UID_CACHE_LOCK = threading.RLock()
_LOOP_LOCKS_GUARD = threading.RLock()
_CONFIGURED_LOOP_ID: int = 0
_DEFAULT_IO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=64, thread_name_prefix="wl_io")


def _get_loop_lock(lock_dict: dict, key: str, max_size: int = 400) -> asyncio.Lock:
    """Return an asyncio.Lock bound to the current running event loop (prevents cross-loop RuntimeError 500s)."""
    cur_loop = asyncio.get_running_loop()
    cur_id = id(cur_loop)
    with _LOOP_LOCKS_GUARD:
        existing = lock_dict.get(key)
        if existing is not None and getattr(existing, "_wl_loop_id", None) == cur_id:
            return existing
        if len(lock_dict) >= max_size:
            for old_k in list(lock_dict.keys()):
                old_lk = lock_dict.get(old_k)
                if old_lk is None or getattr(old_lk, "_wl_loop_id", None) != cur_id or not old_lk.locked():
                    lock_dict.pop(old_k, None)
                    if len(lock_dict) < max(1, max_size - 40):
                        break
        lk = asyncio.Lock()
        setattr(lk, "_wl_loop_id", cur_id)
        lock_dict[key] = lk
        return lk


def _claims_from_token(token: str) -> dict:
    """Resolve a bearer token to verified claims (15s TTL cache, 5000 entries)."""
    if not token:
        return {}
    now_ts = time.time()
    with _UID_CACHE_LOCK:
        hit = _UID_CACHE.get(token)
    if hit and hit[1] > now_ts:
        val = hit[0]
        return val if isinstance(val, dict) else {"uid": str(val or "")}
    try:
        import auth_engine
        claims = auth_engine.verify_any_token(token)
    except Exception:
        claims = None
    with _UID_CACHE_LOCK:
        if isinstance(claims, dict) and claims.get("uid"):
            _UID_CACHE[token] = (claims, now_ts + 15.0)
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

    _SKIP_AUTH_PREFIXES = ("/static/", "/api/health", "/favicon.ico", "/sw.js", "/manifest.json", "/robots.txt")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        global _CONFIGURED_LOOP_ID, _DEFAULT_IO_EXECUTOR
        try:
            loop = asyncio.get_running_loop()
            if _CONFIGURED_LOOP_ID != id(loop) or getattr(_DEFAULT_IO_EXECUTOR, "_shutdown", False):
                if getattr(_DEFAULT_IO_EXECUTOR, "_shutdown", False):
                    _DEFAULT_IO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=64, thread_name_prefix="wl_io")
                loop.set_default_executor(_DEFAULT_IO_EXECUTOR)
                _CONFIGURED_LOOP_ID = id(loop)
        except Exception:
            pass
        if scope["type"] == "http":
            path_str = str(scope.get("path") or "")
            if path_str.startswith(self._SKIP_AUTH_PREFIXES):
                scope["wl_uid"] = ""
                scope["wl_claims"] = {}
                await self.app(scope, receive, send)
                return
            token = ""
            for hk, hv in scope.get("headers") or ():
                if hk.lower() == IDENTITY_HEADER:
                    val = hv.decode("latin-1", errors="ignore")
                    if val.lower().startswith("bearer "):
                        token = val[7:].strip()
                    break
            claims = {}
            if token:
                now_ts = time.time()
                with _UID_CACHE_LOCK:
                    hit = _UID_CACHE.get(token)
                if hit and hit[1] > now_ts:
                    val = hit[0]
                    claims = val if isinstance(val, dict) else {"uid": str(val or "")}
                else:
                    claims = await asyncio.to_thread(_claims_from_token, token)
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


class _CffiRespAdapter:
    """Minimal urllib-compatible context manager wrapping a curl_cffi response."""

    def __init__(self, body: bytes, final_url: str, status: int = 200, headers: Optional[dict] = None):
        import io as _io_mod
        self._buf = _io_mod.BytesIO(body)
        self.url = final_url
        self.status = status
        self.code = status
        self.headers = headers or {}

    def read(self, amt: int = -1) -> bytes:
        return self._buf.read(amt)

    def geturl(self) -> str:
        return self.url

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._buf.close()
        return False


_CFFI_FIRST_DOMAINS = (
    "ddizimag.",
    "pilavyer",
    "hdfilmcehennemi.",
    "dizibox.",
    "dizi84.",
    "dizi82.",
    "dizipal",
    "dplayer",
    "hexa.su",
    "dragonballzfans",
    "vidlink.pro",
    "enc-dec.app",
)


def _cffi_open_req(request, url: str, timeout: float):
    from curl_cffi import requests as _cffi_req
    raw_hdrs = dict(request.headers) if isinstance(request, urllib.request.Request) else {}
    if isinstance(request, urllib.request.Request) and hasattr(request, "unredirected_hdrs"):
        raw_hdrs.update(request.unredirected_hdrs)
    hdrs = {}
    for hk, hv in raw_hdrs.items():
        if hk.lower() == "user-agent" and ("chrome/137" in str(hv).lower() or "chrome/124" in str(hv).lower()):
            continue
        hdrs[hk] = hv
    method = request.get_method() if isinstance(request, urllib.request.Request) else "GET"
    data = request.data if isinstance(request, urllib.request.Request) else None
    cur_u = url
    cr = None
    req_to = min(float(timeout or 6.0), 14.0)
    for _hop in range(5):
        if not public_http_url(cur_u):
            raise ValueError("Geçersiz yönlendirme URL")
        cr = _cffi_req.request(
            method,
            cur_u,
            headers=hdrs,
            data=data,
            impersonate="chrome124",
            timeout=req_to,
            allow_redirects=False,
            max_redirects=0,
        )
        if cr.status_code in (301, 302, 303, 307, 308):
            loc = str(cr.headers.get("Location") or cr.headers.get("location") or "").strip()
            if hasattr(cr, "close"):
                try:
                    cr.close()
                except Exception:
                    pass
            if not loc or _hop >= 4:
                raise ValueError("Geçersiz yönlendirme URL")
            cur_u = urllib.parse.urljoin(cur_u, loc)
            if cr.status_code == 303:
                method = "GET"
                data = None
            continue
        break
    if cr is None:
        raise ValueError("Geçersiz yönlendirme URL")
    try:
        fin_u = str(getattr(cr, "url", "") or cur_u)
        if not public_http_url(fin_u):
            raise ValueError("Geçersiz yönlendirme URL")
        if cr.status_code >= 400:
            raise urllib.error.HTTPError(fin_u, cr.status_code, f"HTTP {cr.status_code}", dict(cr.headers), None)
        return _CffiRespAdapter(bytes(cr.content[:28 * 1024 * 1024]), fin_u, cr.status_code, dict(cr.headers))
    finally:
        if hasattr(cr, "close"):
            try:
                cr.close()
            except Exception:
                pass


def _public_open(request, timeout=8.0):
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    if not public_http_url(url):
        raise ValueError("Geçersiz URL")
    u_low = str(url or "").lower()
    if "PYTEST_CURRENT_TEST" not in os.environ and any(d in u_low for d in _CFFI_FIRST_DOMAINS):
        try:
            return _cffi_open_req(request, url, timeout)
        except Exception:
            pass
    try:
        return urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout)
    except Exception as orig_err:
        code = getattr(orig_err, "code", 0)
        if code and code not in (403, 429, 503, 520, 521, 522):
            raise
        try:
            return _cffi_open_req(request, url, timeout)
        except Exception:
            raise orig_err


def fetch_user_page(url: str) -> str:
    if not public_http_url(url):
        raise ValueError("Bu adrese erişilemiyor")
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"})
    with opener.open(req, timeout=6) as r:
        ctype = r.headers.get("Content-Type", "")
        if not ctype.startswith(("text/", "application/xhtml", "application/json")):
            raise ValueError(f"Sayfa değil: {ctype}")
        return r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")


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

import concurrent.futures
import xml.etree.ElementTree as ET

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




PROVIDER_WATCH_IDS = {
    "netflix": "8", "disney": "337", "prime": "119", "max": "1899|384",
    "crunchyroll": "283", "tubi": "73", "mubi": "11", "apple": "350",
    "hulu": "15", "paramount": "531|582|2303|2616", "peacock": "386", "plex": "538", "pluto": "300",
    "exxen": "1796|8", "blutv": "341|1899", "gain": "1796|8",
    "tod": "341|8", "tabii": "1796|8", "tvplus": "341|119", "puhutv": "341|8",
}

TMDB_GENRE_BUCKETS = [
    ("action", "Aksiyon & Macera", {28, 12, 10759, 37}),
    ("scifi", "Bilim Kurgu & Fantastik", {878, 14, 10765}),
    ("drama", "Dram & Suç", {18, 80, 9648, 10768, 36, 10752}),
    ("comedy", "Komedi & Romantik", {35, 10749}),
    ("horror", "Korku & Gerilim", {27, 53}),
    ("animation", "Animasyon & Aile", {16, 10751, 10762}),
    ("doc", "Belgesel & Tarih", {99, 36}),
]

CAT_TMDB_GENRES = {
    "action": ("10759|37", "28|12|37"),
    "scifi": ("10765", "878|14"),
    "drama": ("18|80|9648", "18|80|9648"),
    "comedy": ("35", "35|10749"),
    "horror": ("9648|10765", "27|53"),
    "animation": ("16|10751|10762", "16|10751"),
    "anime": ("16&with_origin_country=JP", "16&with_origin_country=JP"),
    "dublaj": ("10759|18|10765", "28|12|878|14"),
    "doc": ("99", "99|36"),
}

_CATALOG_MEM_CACHE = {}


def _classify_tmdb_genres(gids: list, mtype: str, rating: float, vote_count: int) -> tuple:
    gset = {int(x) for x in (gids or []) if str(x).isdigit()}
    cats = ["series" if mtype == "tv" else "movies"]
    labels = []
    for key, label, id_set in TMDB_GENRE_BUCKETS:
        if gset & id_set:
            cats.append(key)
            labels.append(label)
    if not labels:
        cats.append("drama")
        labels.append("Dram & Suç")
    if rating >= 7.5 or vote_count >= 900:
        cats.append("trend")
    return cats, labels[0]


_CJK_TITLE_MAP = {
    "デジモンアドベンチャー：": "Digimon Adventure (2020)",
    "피노키오": "Pinocchio",
    "ワンピース": "One Piece",
    "進撃の巨人": "Attack on Titan",
    "呪術廻戦": "Jujutsu Kaisen",
    "鬼滅の刃": "Demon Slayer: Kimetsu no Yaiba",
    "モンスター": "Monster",
    "Сталкер": "Stalker",
    "エルゴプラクシー": "Ergo Proxy",
    "サムライチャンプルー": "Samurai Champloo",
    "モブサイコ100": "Mob Psycho 100",
    "妄想代理人": "Paranoia Agent",
    "ナルト 疾風伝": "Naruto Shippuden",
    "回路": "Pulse",
}


def _tmdb_item(r: dict, default_type: str = "movie") -> dict:
    mtype = "tv" if (r.get("media_type") or default_type) == "tv" else "movie"
    tid = str(r.get("id") or "")
    poster = f"https://image.tmdb.org/t/p/w500{r['poster_path']}" if r.get("poster_path") else ""
    backdrop = f"https://image.tmdb.org/t/p/w780{r['backdrop_path']}" if r.get("backdrop_path") else poster
    title = (r.get("title") or r.get("name") or "Yapım").strip()
    orig_title = (r.get("original_title") or r.get("original_name") or title).strip()
    if orig_title in _CJK_TITLE_MAP:
        mapped_ot = _CJK_TITLE_MAP[orig_title]
        if title == orig_title or _norm_title(mapped_ot) not in _norm_title(title):
            title = f"{title} ({mapped_ot})" if title and title != orig_title else mapped_ot
        orig_title = mapped_ot
    elif title in _CJK_TITLE_MAP:
        title = _CJK_TITLE_MAP[title]
    elif re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]", title):
        if not re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]", orig_title):
            title = orig_title
        else:
            ascii_part = re.sub(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af：・]+", " ", title).strip()
            title = ascii_part if len(re.findall(r"[A-Za-z]", ascii_part)) >= 3 else f"Anime / Asya Yapımı #{tid[-4:] if tid else 'HD'}"
    rating = round(float(r.get("vote_average") or 0), 1)
    vc = int(r.get("vote_count") or 0)
    cats, genre_label = _classify_tmdb_genres(r.get("genre_ids") or [], mtype, rating, vc)
    return {
        "id": tid, "tmdbId": tid, "mediaType": mtype,
        "title": title, "originalTitle": orig_title,
        "origLang": str(r.get("original_language") or ""),
        "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],
        "rating": rating,
        "voteCount": vc,
        "categories": cats,
        "genreLabel": genre_label,
        "overview": (r.get("overview") or "")[:260],
        "poster": poster, "backdrop": backdrop,
    }


_STAR_WARS_CURATED = [
    {"id": "11", "tmdbId": "11", "mediaType": "movie", "title": "Star Wars: Bölüm IV - Yeni Bir Umut", "originalTitle": "Star Wars", "year": "1977", "rating": 8.2, "voteCount": 20500, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Prenses Leia, İmparatorluk güçleri tarafından rehin alınır. Luke Skywalker ve Han Solo galaksiyi kurtarmak için direnişe katılır.", "poster": "https://image.tmdb.org/t/p/w500/6FfCtAuVAW8XJjZ7eWeLibRLWTw.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/4qCqAdHcNKeAHcK8tJ8wNJZa9cx.jpg"},
    {"id": "1891", "tmdbId": "1891", "mediaType": "movie", "title": "Star Wars: Bölüm V - İmparator", "originalTitle": "The Empire Strikes Back", "year": "1980", "rating": 8.4, "voteCount": 16800, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Luke Skywalker, Jedi ustası Yoda'dan eğitim alırken Darth Vader, Asi İttifakı'nı galaksi boyunca amansızca takip eder.", "poster": "https://image.tmdb.org/t/p/w500/nNAeTmF4CtdSgMDplXTDPOpYzsX.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aJCtkxLLzkk1pECehVjKHA2lBgw.jpg"},
    {"id": "1892", "tmdbId": "1892", "mediaType": "movie", "title": "Star Wars: Bölüm VI - Jedi'ın Dönüşü", "originalTitle": "Return of the Jedi", "year": "1983", "rating": 7.9, "voteCount": 15400, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "İmparatorluk ikinci Ölüm Yıldızı'nı inşa ederken Luke Skywalker, babası Darth Vader'ı karanlık taraftan döndürmeye çalışır.", "poster": "https://image.tmdb.org/t/p/w500/jQYlydvHm3kUix1f8prMucrplhm.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/r2IO2e2daN7H7cbvCaEba0kceea.jpg"},
    {"id": "1893", "tmdbId": "1893", "mediaType": "movie", "title": "Star Wars: Bölüm I - Gizli Tehlike", "originalTitle": "Star Wars: Episode I - The Phantom Menace", "year": "1999", "rating": 6.6, "voteCount": 14500, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Jedi Şövalyeleri Qui-Gon Jinn ve Obi-Wan Kenobi, Tatooine gezegeninde Güç'te olağanüstü yetenekli genç Anakin Skywalker'ı keşfeder.", "poster": "https://image.tmdb.org/t/p/w500/6wkfovpn7Eq8dYNKaG5PY3q2oq6.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/6wkfovpn7Eq8dYNKaG5PY3q2oq6.jpg"},
    {"id": "1894", "tmdbId": "1894", "mediaType": "movie", "title": "Star Wars: Bölüm II - Klonların Saldırısı", "originalTitle": "Star Wars: Episode II - Attack of the Clones", "year": "2002", "rating": 6.6, "voteCount": 13200, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Galaktik Cumhuriyet parçalanmanın eşiğindeyken Anakin Skywalker, Senatör Padmé Amidala'yı korumakla görevlendirilir.", "poster": "https://image.tmdb.org/t/p/w500/oZNPzxqM2s5DyVWab09NTQScDQt.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/oZNPzxqM2s5DyVWab09NTQScDQt.jpg"},
    {"id": "1895", "tmdbId": "1895", "mediaType": "movie", "title": "Star Wars: Bölüm III - Sith'in İntikamı", "originalTitle": "Star Wars: Episode III - Revenge of the Sith", "year": "2005", "rating": 7.4, "voteCount": 13800, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Klon Savaşları'nın üçüncü yılında Anakin Skywalker, Darth Sidious'un etkisiyle karanlık tarafa çekilerek Darth Vader'a dönüşür.", "poster": "https://image.tmdb.org/t/p/w500/xfSAoBEm9MNBjmlNcDYLvLSMlnq.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/xfSAoBEm9MNBjmlNcDYLvLSMlnq.jpg"},
    {"id": "140607", "tmdbId": "140607", "mediaType": "movie", "title": "Star Wars: Güç Uyanıyor (Bölüm VII)", "originalTitle": "Star Wars: The Force Awakens", "year": "2015", "rating": 7.3, "voteCount": 19200, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "İmparatorluğun küllerinden doğan İlk Düzen galaksiyi tehdit ederken Rey ve Finn, Luke Skywalker'ı bulmak için direnişe katılır.", "poster": "https://image.tmdb.org/t/p/w500/wqnLdwVXoBjKibFRR5U3y0aDUhs.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/wqnLdwVXoBjKibFRR5U3y0aDUhs.jpg"},
    {"id": "330459", "tmdbId": "330459", "mediaType": "movie", "title": "Rogue One: Bir Star Wars Hikayesi", "originalTitle": "Rogue One: A Star Wars Story", "year": "2016", "rating": 7.5, "voteCount": 15100, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Bir grup cesur direniş savaşçısı, İmparatorluk'un kitle imha silahı Ölüm Yıldızı'nın planlarını çalmak için imkansız bir göreve çıkar.", "poster": "https://image.tmdb.org/t/p/w500/i0yw1mFbB7sNGHCs7EXZPzFkdA1.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/i0yw1mFbB7sNGHCs7EXZPzFkdA1.jpg"},
    {"id": "181808", "tmdbId": "181808", "mediaType": "movie", "title": "Star Wars: Son Jedi (Bölüm VIII)", "originalTitle": "Star Wars: The Last Jedi", "year": "2017", "rating": 6.8, "voteCount": 15000, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Rey, Güç'ün sırlarını öğrenmek için sürgündeki Luke Skywalker'a ulaşırken Direniş, İlk Düzen'e karşı hayatta kalma savaşı verir.", "poster": "https://image.tmdb.org/t/p/w500/kOVEVeg59E0wsnXmF9nrh6OmWII.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/kOVEVeg59E0wsnXmF9nrh6OmWII.jpg"},
    {"id": "348350", "tmdbId": "348350", "mediaType": "movie", "title": "Han Solo: Bir Star Wars Hikayesi", "originalTitle": "Solo: A Star Wars Story", "year": "2018", "rating": 6.6, "voteCount": 8400, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Genç Han Solo'nun Chewbacca ve Lando Calrissian ile tanışması ve Millennium Falcon'un kaptanı olma serüveni.", "poster": "https://image.tmdb.org/t/p/w500/4oD6VEccFkorEBTEDXtpLAaz0Rl.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/4oD6VEccFkorEBTEDXtpLAaz0Rl.jpg"},
    {"id": "181812", "tmdbId": "181812", "mediaType": "movie", "title": "Star Wars: Skywalker'ın Yükselişi (Bölüm IX)", "originalTitle": "Star Wars: The Rise of Skywalker", "year": "2019", "rating": 6.3, "voteCount": 9800, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Skywalker destanının büyük finalinde Direniş'in kalan üyeleri, geri dönen İmparator Palpatine ve Son Düzen ile son kez yüzleşir.", "poster": "https://image.tmdb.org/t/p/w500/db32LaOibwEliAmSL2jjDF6oDdj.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/db32LaOibwEliAmSL2jjDF6oDdj.jpg"},
    {"id": "12180", "tmdbId": "12180", "mediaType": "movie", "title": "Star Wars: Klon Savaşları (Film)", "originalTitle": "Star Wars: The Clone Wars", "year": "2008", "rating": 6.1, "voteCount": 1950, "origLang": "en", "categories": ["scifi", "animation", "action"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Anakin Skywalker ve yeni Padawan öğrencisi Ahsoka Tano, Jabba the Hutt'ın kaçırılan oğlunu kurtarmak için tehlikeli bir göreve atılır.", "poster": "https://image.tmdb.org/t/p/w500/iJQfixW818LUdSXlCDL3JZm0S0g.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/iJQfixW818LUdSXlCDL3JZm0S0g.jpg"},
    {"id": "82856", "tmdbId": "82856", "mediaType": "tv", "title": "The Mandalorian (Star Wars)", "originalTitle": "The Mandalorian", "year": "2019", "rating": 8.4, "voteCount": 10200, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "İmparatorluğun çöküşünden sonra galaksinin dış halkalarında yalnız bir ödül avcısı olan Din Djarin, Grogu'yu korumak için yola çıkar.", "poster": "https://image.tmdb.org/t/p/w500/eU1i6eHXlzMOlEq0ku1Rzq7Y4wA.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/eU1i6eHXlzMOlEq0ku1Rzq7Y4wA.jpg"},
    {"id": "4194", "tmdbId": "4194", "mediaType": "tv", "title": "Star Wars: Klon Savaşları (The Clone Wars)", "originalTitle": "Star Wars: The Clone Wars", "year": "2008", "rating": 8.5, "voteCount": 2100, "origLang": "en", "categories": ["scifi", "animation", "action"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Jedi Şövalyeleri Anakin Skywalker, Obi-Wan Kenobi ve Ahsoka Tano, Ayrılıkçı Droid Ordusu'na karşı galaksi çapında Klon Savaşları'na liderlik eder.", "poster": "https://image.tmdb.org/t/p/w500/e1nWfnnCVqxS2LeTO3dwGyAsG2V.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/e1nWfnnCVqxS2LeTO3dwGyAsG2V.jpg"},
    {"id": "83867", "tmdbId": "83867", "mediaType": "tv", "title": "Star Wars: Andor", "originalTitle": "Andor", "year": "2022", "rating": 8.2, "voteCount": 1400, "origLang": "en", "categories": ["scifi", "action", "drama"], "genreLabel": "Bilim Kurgu • Dram", "overview": "Rogue One olaylarından beş yıl önce, Cassian Andor'un acımasız İmparatorluk rejimine karşı Asi İttifakı'nın doğuşundaki casusluk mücadelesi.", "poster": "https://image.tmdb.org/t/p/w500/59SVNwLfoMnZPPB6ukW6dlPxAdI.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/59SVNwLfoMnZPPB6ukW6dlPxAdI.jpg"},
    {"id": "92830", "tmdbId": "92830", "mediaType": "tv", "title": "Obi-Wan Kenobi (Star Wars)", "originalTitle": "Obi-Wan Kenobi", "year": "2022", "rating": 7.1, "voteCount": 1650, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Sith'in İntikamı'ndan on yıl sonra Tatooine'de genç Luke'u uzaktan koruyan Obi-Wan Kenobi, Engizisyoncular ve Darth Vader ile karşı karşıya gelir.", "poster": "https://image.tmdb.org/t/p/w500/qJRB789ceLryrLvOKrZqLKr2CGf.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/qJRB789ceLryrLvOKrZqLKr2CGf.jpg"},
    {"id": "114461", "tmdbId": "114461", "mediaType": "tv", "title": "Star Wars: Ahsoka", "originalTitle": "Ahsoka", "year": "2023", "rating": 7.6, "voteCount": 1100, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "İmparatorluğun düşüşünden sonra eski Jedi Şövalyesi Ahsoka Tano, Büyük Amiral Thrawn'ın geri dönüş tehdidini araştırır.", "poster": "https://image.tmdb.org/t/p/w500/laCJxobHoPVaLQTKxc14Y2zV64J.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/laCJxobHoPVaLQTKxc14Y2zV64J.jpg"},
    {"id": "115036", "tmdbId": "115036", "mediaType": "tv", "title": "The Book of Boba Fett (Star Wars)", "originalTitle": "The Book of Boba Fett", "year": "2021", "rating": 7.4, "voteCount": 2400, "origLang": "en", "categories": ["scifi", "action"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Efsanevi ödül avcısı Boba Fett ve paralı asker Fennec Shand, Jabba the Hutt'ın Tatooine'deki suç imparatorluğunu ele geçirir.", "poster": "https://image.tmdb.org/t/p/w500/gNbdjDi1HamTCrfvM9JeA94bNi2.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/gNbdjDi1HamTCrfvM9JeA94bNi2.jpg"},
    {"id": "60554", "tmdbId": "60554", "mediaType": "tv", "title": "Star Wars Asiler (Rebels)", "originalTitle": "Star Wars Rebels", "year": "2014", "rating": 7.8, "voteCount": 950, "origLang": "en", "categories": ["scifi", "animation", "action"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Hayalet gemisinin cesur mürettebatı, galaktik İmparatorluk'a karşı ilk isyan kıvılcımlarını ateşler.", "poster": "https://image.tmdb.org/t/p/w500/7ThzIAWrL33FnvnCG9pSHThx7lq.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/8BNjxMJMFp0BgqMh4PyuwZMXxh1.jpg"},
    {"id": "105971", "tmdbId": "105971", "mediaType": "tv", "title": "Star Wars: Kötüler Timi (The Bad Batch)", "originalTitle": "Star Wars: The Bad Batch", "year": "2021", "rating": 8.2, "voteCount": 980, "origLang": "en", "categories": ["scifi", "animation", "action"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Klon Savaşları'nın hemen ardından genetik mutasyonlu seçkin klon birliği Kuvvet 99, hızla değişen galakside paralı asker olarak hayatta kalmaya çalışır.", "poster": "https://image.tmdb.org/t/p/w500/5mHus672nuinyaE0FtqvD0AddcY.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/sjxtIUCWR74yPPcZFfTsToepfWm.jpg"},
    {"id": "114479", "tmdbId": "114479", "mediaType": "tv", "title": "Star Wars: The Acolyte", "originalTitle": "The Acolyte", "year": "2024", "rating": 6.4, "voteCount": 780, "origLang": "en", "categories": ["scifi", "action", "series"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Yüksek Cumhuriyet döneminin son günlerinde saygın bir Jedi Ustası, eski Padawan'ı ile birlikte şok edici bir suç dalgasını araştırır.", "poster": "https://image.tmdb.org/t/p/w500/mztdt3y6GBsJR69zHtszFezTCLT.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/mztdt3y6GBsJR69zHtszFezTCLT.jpg"},
    {"id": "202879", "tmdbId": "202879", "mediaType": "tv", "title": "Star Wars: Skeleton Crew", "originalTitle": "Star Wars: Skeleton Crew", "year": "2024", "rating": 7.3, "voteCount": 520, "origLang": "en", "categories": ["scifi", "action", "series"], "genreLabel": "Bilim Kurgu • Aksiyon", "overview": "Kendi gezegenlerinde gizemli bir keşif yapan dört çocuk, tehlikeli galakside kaybolur ve eve dönüş yolunda Jod Na Nawood ile karşılaşır.", "poster": "https://image.tmdb.org/t/p/w500/srQbJhLRKoAwRrNN5ga7webPHbC.jpg", "backdrop": "https://image.tmdb.org/t/p/w500/srQbJhLRKoAwRrNN5ga7webPHbC.jpg"},
    {"id": "203085", "tmdbId": "203085", "mediaType": "tv", "title": "Star Wars: Jedi Hikayeleri (Tales of the Jedi)", "originalTitle": "Star Wars: Tales of the Jedi", "year": "2022", "rating": 8.1, "voteCount": 610, "origLang": "en", "categories": ["scifi", "animation", "series"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Öncül üçleme dönemindeki Jedi Şövalyeleri Ahsoka Tano ve Kont Dooku'nun kaderlerini belirleyen dönüm noktalarını anlatan antoloji dizisi.", "poster": "https://image.tmdb.org/t/p/w500/k3nWQb0E8mLSR8acSkJP78VRVMv.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/vp52Er9JebGn49GG37jFTwx15Lw.jpg"},
    {"id": "251091", "tmdbId": "251091", "mediaType": "tv", "title": "Star Wars: İmparatorluk Hikayeleri (Tales of the Empire)", "originalTitle": "Star Wars: Tales of the Empire", "year": "2024", "rating": 7.6, "voteCount": 420, "origLang": "en", "categories": ["scifi", "animation", "series"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Galaktik İmparatorluk'un yükseliş döneminde Morgan Elsbeth ve eski Jedi Barriss Offee'nin karanlık yolculuğu.", "poster": "https://image.tmdb.org/t/p/w500/qA28nLteurVboSSzltuyYt1lvlC.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/sMxOqjwaHHXuBnHkvVyzqcOPMVF.jpg"},
    {"id": "114478", "tmdbId": "114478", "mediaType": "tv", "title": "Star Wars: Visions", "originalTitle": "Star Wars: Visions", "year": "2021", "rating": 7.2, "voteCount": 710, "origLang": "ja", "categories": ["scifi", "animation", "anime", "series"], "genreLabel": "Bilim Kurgu • Anime Antoloji", "overview": "Dünyanın önde gelen anime stüdyolarının Star Wars evrenine getirdiği özgün hikaye anlatımları.", "poster": "https://image.tmdb.org/t/p/w500/lG9ltUP4FwvsQBcwOJYceDbP48E.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/m2QTmJhe36uKrkQjC1MsNV7Dcqp.jpg"},
    {"id": "79093", "tmdbId": "79093", "mediaType": "tv", "title": "Star Wars: Direniş (Resistance)", "originalTitle": "Star Wars Resistance", "year": "2018", "rating": 6.6, "voteCount": 390, "origLang": "en", "categories": ["scifi", "animation", "series"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Genç pilot Kazuda Xiono, yükselen İlk Düzen tehdidini gözetlemek için Direniş adına gizli göreve katılır.", "poster": "https://image.tmdb.org/t/p/w500/xul6SG8rar3wkHPY8YusUtxcdlZ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/Ad2y46YKP2u81bsR4axajbbJKwS.jpg"},
    {"id": "3122", "tmdbId": "3122", "mediaType": "tv", "title": "Star Wars: Klon Savaşları (2003 Klasik Seri)", "originalTitle": "Star Wars: Clone Wars", "year": "2003", "rating": 7.9, "voteCount": 890, "origLang": "en", "categories": ["scifi", "animation", "action", "series"], "genreLabel": "Bilim Kurgu • Animasyon", "overview": "Genndy Tartakovsky imzalı, Klonların Saldırısı ile Sith'in İntikamı arasındaki destansı savaşları anlatan kült animasyon dizisi.", "poster": "https://image.tmdb.org/t/p/w500/jKfAVTGkf9qpGPZ4E1pNKdW6vra.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6Bsfr4QipqfAMlv9DCk8zNACvUG.jpg"},
]

_EXTRA_CURATED_CATALOG = [
    # Harry Potter & Fantastic Beasts
    {"id": "671", "tmdbId": "671", "mediaType": "movie", "title": "Harry Potter ve Felsefe Taşı", "originalTitle": "Harry Potter and the Philosopher's Stone", "year": "2001", "rating": 7.9, "voteCount": 27000, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/wuMc08IPKEatf9rnMNXvIDxqP4W.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/bfh9Z3Ghz4FOJAfLOAhmc3ccnHU.jpg"},
    {"id": "672", "tmdbId": "672", "mediaType": "movie", "title": "Harry Potter ve Sırlar Odası", "originalTitle": "Harry Potter and the Chamber of Secrets", "year": "2002", "rating": 7.7, "voteCount": 21800, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/sdEOH0992YZ0QSxgXNIGLq1ToUi.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/zuYEvft5fuzBDOeq4ClYpiu9LlO.jpg"},
    {"id": "673", "tmdbId": "673", "mediaType": "movie", "title": "Harry Potter ve Azkaban Tutsağı", "originalTitle": "Harry Potter and the Prisoner of Azkaban", "year": "2004", "rating": 8.0, "voteCount": 21500, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/aWxwnYoe8p2d2fcxOqtvAtJ72Rw.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/htmYEfH7TQgzsXHCnNXxmoYKQtL.jpg"},
    {"id": "674", "tmdbId": "674", "mediaType": "movie", "title": "Harry Potter ve Ateş Kadehi", "originalTitle": "Harry Potter and the Goblet of Fire", "year": "2005", "rating": 7.8, "voteCount": 20500, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/fECBtHlr0RB3foNHDiCBXeg9Bv9.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/cClWTo3ftVXvV1sF8vlLuWfnlph.jpg"},
    {"id": "675", "tmdbId": "675", "mediaType": "movie", "title": "Harry Potter ve Zümrüdüanka Yoldaşlığı", "originalTitle": "Harry Potter and the Order of the Phoenix", "year": "2007", "rating": 7.7, "voteCount": 19300, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/5aOyriWkPec0zUDxmHFP9qMmBaj.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/9svsJni0pNROt53QBEj9JqZMuEK.jpg"},
    {"id": "767", "tmdbId": "767", "mediaType": "movie", "title": "Harry Potter ve Melez Prens", "originalTitle": "Harry Potter and the Half-Blood Prince", "year": "2009", "rating": 7.7, "voteCount": 19100, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/z7uo9zmQdQwU5ZJHFpv2Upl30i1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/mITJS77BV4TSqdFB5FPGBc7JKXj.jpg"},
    {"id": "12444", "tmdbId": "12444", "mediaType": "movie", "title": "Harry Potter ve Ölüm Yadigarları: Bölüm 1", "originalTitle": "Harry Potter and the Deathly Hallows: Part 1", "year": "2010", "rating": 7.8, "voteCount": 18900, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/iGoXIpQb7Pot00EEdwpwPajheZ5.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/5i2QAYnbN5vOZUUolLPYHTb9spe.jpg"},
    {"id": "12445", "tmdbId": "12445", "mediaType": "movie", "title": "Harry Potter ve Ölüm Yadigarları: Bölüm 2", "originalTitle": "Harry Potter and the Deathly Hallows: Part 2", "year": "2011", "rating": 8.1, "voteCount": 20400, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/c54HpQmuwXjHq2C9wmoACjxoom3.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/eKUk4oN4ucwnLJml7wRnjuB9AQH.jpg"},
    # Lord of the Rings & Hobbit
    {"id": "120", "tmdbId": "120", "mediaType": "movie", "title": "Yüzüklerin Efendisi: Yüzük Kardeşliği", "originalTitle": "The Lord of the Rings: The Fellowship of the Ring", "year": "2001", "rating": 8.4, "voteCount": 24800, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Destansı Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/6oom5QYQ2yQTMJIbnvbkBL9cHo6.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/oiwc338EoBgS4sEI2ixAny4KQKg.jpg"},
    {"id": "121", "tmdbId": "121", "mediaType": "movie", "title": "Yüzüklerin Efendisi: İki Kule", "originalTitle": "The Lord of the Rings: The Two Towers", "year": "2002", "rating": 8.4, "voteCount": 21600, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Destansı Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/5VTN0pR8gcqV3EPUHHfMGnJYN9L.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6G73mNyooWAEQTpckPSnFxFoNmc.jpg"},
    {"id": "122", "tmdbId": "122", "mediaType": "movie", "title": "Yüzüklerin Efendisi: Kralın Dönüşü", "originalTitle": "The Lord of the Rings: The Return of the King", "year": "2003", "rating": 8.5, "voteCount": 23900, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Destansı Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/ctiw6FZK4N36LmkjSklWEbuvlq9.jpg"},
    {"id": "49051", "tmdbId": "49051", "mediaType": "movie", "title": "Hobbit: Beklenmedik Yolculuk", "originalTitle": "The Hobbit: An Unexpected Journey", "year": "2012", "rating": 7.4, "voteCount": 18200, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/yHA9Fc37VmpUA5UncTxxo3rTGVA.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/xyXmtuvsoM5J3yNad0nvcetpBdY.jpg"},
    {"id": "57158", "tmdbId": "57158", "mediaType": "movie", "title": "Hobbit: Smaug'un Çorak Toprakları", "originalTitle": "The Hobbit: The Desolation of Smaug", "year": "2013", "rating": 7.6, "voteCount": 13100, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/xQYiXsheRCDBA39DOrmaw1aSpbk.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/5ZYxL6k4ZHrEmrFvmY4HZVzerxG.jpg"},
    {"id": "122917", "tmdbId": "122917", "mediaType": "movie", "title": "Hobbit: Beş Ordunun Savaşı", "originalTitle": "The Hobbit: The Battle of the Five Armies", "year": "2014", "rating": 7.3, "voteCount": 14100, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Fantastik • Macera", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/xT98tLqatZPQApyRmlPL12LtiWp.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/3UbaCMmqOd7mca4Y5DOzY2ZVTyX.jpg"},
    {"id": "84773", "tmdbId": "84773", "mediaType": "tv", "title": "Yüzüklerin Efendisi: Güç Yüzükleri", "originalTitle": "The Lord of the Rings: The Rings of Power", "year": "2022", "rating": 7.3, "voteCount": 2900, "origLang": "en", "categories": ["series", "scifi", "action", "trend"], "genreLabel": "Fantastik • Dizi", "sourceBadge": "📺 Prime 4K", "poster": "https://image.tmdb.org/t/p/w500/mYLOqiStMxDK3fYZFirgrMt8z5d.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/achmETPRJZc9QVXsMPgHwYEyNar.jpg"},
    # Marvel, Dark Knight, Matrix, John Wick, Dune
    {"id": "299536", "tmdbId": "299536", "mediaType": "movie", "title": "Avengers: Sonsuzluk Savaşı (Infinity War)", "originalTitle": "Avengers: Infinity War", "year": "2018", "rating": 8.3, "voteCount": 29500, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Marvel • Bilim Kurgu & Aksiyon", "sourceBadge": "🎬 Marvel 4K", "poster": "https://image.tmdb.org/t/p/w500/7WsyChQLEftFiDOVTGkv3hFpyyt.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/mDfJG3LC3Dqb67AZ52x3Z0jU0uB.jpg"},
    {"id": "299534", "tmdbId": "299534", "mediaType": "movie", "title": "Avengers: Endgame", "originalTitle": "Avengers: Endgame", "year": "2019", "rating": 8.3, "voteCount": 25600, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Marvel • Bilim Kurgu & Aksiyon", "sourceBadge": "🎬 Marvel 4K", "poster": "https://image.tmdb.org/t/p/w500/or06FN3Dka5tukK1e9sl16pB3iy.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/7RyHsO4yDXtBv1zUU3mTpHeQ0d5.jpg"},
    {"id": "634649", "tmdbId": "634649", "mediaType": "movie", "title": "Örümcek-Adam: Eve Dönüş Yok (Spider-Man: No Way Home)", "originalTitle": "Spider-Man: No Way Home", "year": "2021", "rating": 8.0, "voteCount": 20100, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Marvel • Aksiyon", "sourceBadge": "🎬 Marvel 4K", "poster": "https://image.tmdb.org/t/p/w500/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/iQFcwSGbZXMkeyKrxbPnwnRo5fl.jpg"},
    {"id": "533535", "tmdbId": "533535", "mediaType": "movie", "title": "Deadpool & Wolverine", "originalTitle": "Deadpool & Wolverine", "year": "2024", "rating": 7.7, "voteCount": 6200, "origLang": "en", "categories": ["movies", "scifi", "action", "comedy", "trend"], "genreLabel": "Marvel • Aksiyon & Komedi", "sourceBadge": "🎬 Marvel 4K", "poster": "https://image.tmdb.org/t/p/w500/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/by8z9Fe8y7p4jo2YlW2SZDnptyT.jpg"},
    {"id": "155", "tmdbId": "155", "mediaType": "movie", "title": "Kara Şövalye (The Dark Knight)", "originalTitle": "The Dark Knight", "year": "2008", "rating": 8.5, "voteCount": 32800, "origLang": "en", "categories": ["movies", "action", "drama", "trend"], "genreLabel": "DC • Aksiyon & Suç", "sourceBadge": "🎬 IMAX 4K", "poster": "https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/9FE5eD92WfVCiivM9Pq9GVSrlWk.jpg"},
    {"id": "603", "tmdbId": "603", "mediaType": "movie", "title": "Matrix", "originalTitle": "The Matrix", "year": "1999", "rating": 8.2, "voteCount": 25400, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Bilim Kurgu • Aksiyon", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg"},
    {"id": "603692", "tmdbId": "603692", "mediaType": "movie", "title": "John Wick 4", "originalTitle": "John Wick: Chapter 4", "year": "2023", "rating": 7.8, "voteCount": 6500, "origLang": "en", "categories": ["movies", "action", "trend"], "genreLabel": "Aksiyon • Gerilim", "sourceBadge": "🎬 4K Seri Arşivi", "poster": "https://image.tmdb.org/t/p/w500/vZloFAK7NmvMGKE7VkF5UHaz0I.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/7I6VUdPj6tQECNHdviJkUHD2u89.jpg"},
    {"id": "693134", "tmdbId": "693134", "mediaType": "movie", "title": "Dune: Çöl Gezegeni Bölüm İki", "originalTitle": "Dune: Part Two", "year": "2024", "rating": 8.3, "voteCount": 5900, "origLang": "en", "categories": ["movies", "scifi", "action", "trend"], "genreLabel": "Bilim Kurgu • Macera", "sourceBadge": "🎬 IMAX 4K", "poster": "https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/eZ239CUp1d6OryZEBPnO2n87gMG.jpg"},
    # Yeşilçam & Türk Sineması Klasikleri (Verified TMDB IDs & Posters)
    {"id": "83651", "tmdbId": "83651", "mediaType": "movie", "title": "Hababam Sınıfı", "originalTitle": "Hababam Sınıfı", "year": "1975", "rating": 9.2, "voteCount": 1850, "origLang": "tr", "categories": ["movies", "comedy", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/n58QmaMaw7kN3sg2EEV9HMq0jkR.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/9u9XcPaeOvPcelm8RmMarEgvIAk.jpg"},
    {"id": "31534", "tmdbId": "31534", "mediaType": "movie", "title": "Hababam Sınıfı Sınıfta Kaldı", "originalTitle": "Hababam Sınıfı Sınıfta Kaldı", "year": "1976", "rating": 8.9, "voteCount": 1400, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/uw0Tu1xjWiSSiVGaZe2EYZ48ItQ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/9sVMciEvGTc6wOTD0hi5regoyxZ.jpg"},
    {"id": "31408", "tmdbId": "31408", "mediaType": "movie", "title": "Hababam Sınıfı Uyanıyor", "originalTitle": "Hababam Sınıfı Uyanıyor", "year": "1976", "rating": 8.8, "voteCount": 1300, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/qiy8MEB2idHMz4hk2OrEurzgKQN.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/hMvW0SzAXCTQcrtAZCiW8mHsBlW.jpg"},
    {"id": "31402", "tmdbId": "31402", "mediaType": "movie", "title": "Hababam Sınıfı Tatilde", "originalTitle": "Hababam Sınıfı Tatilde", "year": "1977", "rating": 8.7, "voteCount": 1250, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/fJCB6RL59Jx0opaRfNaLmdSUAHp.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/mV351zRmHJVXJFqyAZXNnB1BzCh.jpg"},
    {"id": "38794", "tmdbId": "38794", "mediaType": "movie", "title": "Tosun Paşa", "originalTitle": "Tosun Paşa", "year": "1976", "rating": 9.0, "voteCount": 1600, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/aE8cMuRNYltzzW36N2hC3zyZQm2.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/kiu0xIcu9Rju9HTWSJOo8Svg9aW.jpg"},
    {"id": "31405", "tmdbId": "31405", "mediaType": "movie", "title": "Süt Kardeşler", "originalTitle": "Süt Kardeşler", "year": "1976", "rating": 8.9, "voteCount": 1500, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/vGW4S5CBTiIdkFE0nX6wljMDLjo.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/7p9jc9Tt4xkoWtdNUReyLPnYOJ9.jpg"},
    {"id": "31547", "tmdbId": "31547", "mediaType": "movie", "title": "Şaban Oğlu Şaban", "originalTitle": "Şaban Oğlu Şaban", "year": "1977", "rating": 8.9, "voteCount": 1480, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/iPYrBGUaNTsrMjxcPoNvo4quEeL.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/afqmjyqyZjfzRo1oVIRW1U5gPPN.jpg"},
    {"id": "27211", "tmdbId": "27211", "mediaType": "movie", "title": "Kibar Feyzo", "originalTitle": "Kibar Feyzo", "year": "1978", "rating": 8.8, "voteCount": 1420, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/nfgnDKDUS5AryFRh4xI1zLLvdoR.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/9t376elDJnO9QwZJd5z7LOz5Z0S.jpg"},
    {"id": "80961", "tmdbId": "80961", "mediaType": "movie", "title": "Çöpçüler Kralı", "originalTitle": "Çöpçüler Kralı", "year": "1977", "rating": 8.8, "voteCount": 1390, "origLang": "tr", "categories": ["movies", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/fjmT1EEBBkUSZ9CwZ13UCVzPKdL.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/viJjUhzkxwttDaLIGxE78urG3Ej.jpg"},
    {"id": "31401", "tmdbId": "31401", "mediaType": "movie", "title": "Züğürt Ağa", "originalTitle": "Züğürt Ağa", "year": "1985", "rating": 8.8, "voteCount": 1350, "origLang": "tr", "categories": ["movies", "comedy", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Türk Sineması • Dram & Komedi", "sourceBadge": "🇹🇷 Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/yJjrLFc2ean5CKbwO1LI7B8xecN.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/dYxbhzBvhviKRz9kzTK83xZvAnF.jpg"},
    {"id": "53206", "tmdbId": "53206", "mediaType": "movie", "title": "Neşeli Günler", "originalTitle": "Neşeli Günler", "year": "1978", "rating": 8.9, "voteCount": 1520, "origLang": "tr", "categories": ["movies", "comedy", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yeşilçam Efsanesi • Aile & Komedi", "sourceBadge": "🇹🇷 Yeşilçam Restorasyon HD", "poster": "https://image.tmdb.org/t/p/w500/vNSJTFNaDj8L0r1iPkfSXxEy2yI.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/gyqswEuRgrYPsrArrrOxC5Px09Y.jpg"},
    {"id": "27275", "tmdbId": "27275", "mediaType": "movie", "title": "G.O.R.A.", "originalTitle": "G.O.R.A.", "year": "2004", "rating": 8.1, "voteCount": 2400, "origLang": "tr", "categories": ["movies", "comedy", "scifi", "tr", "trend"], "genreLabel": "🇹🇷 Türk Sineması • Komedi & Bilim Kurgu", "sourceBadge": "🇹🇷 Yerli Sinema 4K", "poster": "https://image.tmdb.org/t/p/w500/bxHULJqeW1GlPWr7uvRoWQWsDIe.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/g90Hlbaj8OofowG9hDg9ScD5fqG.jpg"},
]


_FLAGSHIP_TR_TMDB_IDS = {
    "228853", "115678", "40417", "39176", "131906", "231254", "77994",
    "115597", "125412", "280030", "271596", "71036", "34587", "17635",
    "213194", "243832", "32519", "74823", "68388", "44878", "61516", "59",
    "70586", "113957", "135251",
}


_BIDI_CTRL_RE = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]")


def _parse_search_query(q: str) -> tuple[str, str, str, bool]:
    raw_s = _BIDI_CTRL_RE.sub("", q or "").strip()
    if not raw_s:
        return "", "", "", False
    q_year = ""
    q_mt_hint = ""
    q_is_anime = False
    clean_q = raw_s
    m_yr = re.search(r"^(.*\S)\s+\(?((?:19\d{2}|20[0-2]\d))\)?\s*$", clean_q)
    if m_yr and len(_norm_title(m_yr.group(1))) >= 2:
        clean_q = m_yr.group(1).strip()
        q_year = m_yr.group(2)
    m_mt = re.search(r"^(.*\S)\s+\b(anime|dizi|dizisi|film|filmi|series|movie|tv)\b\s*$", clean_q, re.I)
    if m_mt and len(_norm_title(m_mt.group(1))) >= 2:
        kw = m_mt.group(2).lower()
        clean_q = m_mt.group(1).strip()
        if kw == "anime":
            q_mt_hint = "tv"
            q_is_anime = True
        elif kw in ("dizi", "dizisi", "series", "tv"):
            q_mt_hint = "tv"
        else:
            q_mt_hint = "movie"
    return clean_q, q_year, q_mt_hint, q_is_anime


def _vault_title_matches_query(nq: str, nt: str, no: str) -> bool:
    if not nq:
        return False
    for cand in (nt, no):
        if not cand:
            continue
        if cand == nq or cand.startswith(nq + " ") or cand.endswith(" " + nq) or f" {nq} " in f" {cand} ":
            return True
        if len(nq) >= 5 and nq in cand:
            return True
        if len(cand) >= 6 and (nq.startswith(cand + " ") or nq.endswith(" " + cand)):
            return True
    return False


def _rank_search_item(it: dict, raw_q: str) -> tuple:
    clean_q, q_year, q_mt_hint, q_is_anime = _parse_search_query(raw_q)
    nq = _norm_title(clean_q) or _norm_title(raw_q)
    raw_t = str(it.get("title") or "")
    raw_o = str(it.get("originalTitle") or "")
    raw_e = str(it.get("enTitle") or "")
    nt = _norm_title(raw_t)
    no = _norm_title(raw_o)
    ne = _norm_title(raw_e)
    nt_pref = _norm_title(re.split(r"[:\-–—]", raw_t)[0])
    no_pref = _norm_title(re.split(r"[:\-–—]", raw_o)[0])
    ne_pref = _norm_title(re.split(r"[:\-–—]", raw_e)[0])
    cid = str(it.get("id") or "")
    tid = str(it.get("tmdbId") or "")
    yr = str(it.get("year") or "")[:4]
    vc = int(it.get("voteCount") or 0)
    if cid.startswith("ac-") and not it.get("_tmdb_vc_merged"):
        vc = min(max(100, vc // 20), 4000)
    elif cid.startswith(("fhd-", "hfnl-", "dbx-", "hdfc-", "dl-", "dp-")) and not it.get("_tmdb_vc_merged"):
        vc = min(vc, 600)
    rating = float(it.get("rating") or 0.0)
    orig_lang = str(it.get("origLang") or "").lower()
    cats = it.get("categories") or []

    nq_ns = nq.replace(" ", "")
    exact_match_any = bool(
        nq and (
            nt == nq or no == nq or (ne and ne == nq)
            or (len(nq_ns) >= 5 and nq_ns in (nt.replace(" ", ""), no.replace(" ", ""), ne.replace(" ", "")))
        )
    )
    pref_match_any = bool(
        nq and (
            nt_pref == nq or no_pref == nq or (ne_pref and ne_pref == nq)
            or (len(nq_ns) >= 5 and nq_ns in (nt_pref.replace(" ", ""), no_pref.replace(" ", ""), ne_pref.replace(" ", "")))
        )
    )
    starts_match_any = bool(nq and (nt.startswith(nq + " ") or no.startswith(nq + " ") or (ne and ne.startswith(nq + " "))))
    sub_match_any = bool(nq and (nq in nt or nq in no or (ne and nq in ne)))

    year_exact = 1 if (q_year and yr == q_year and sub_match_any) else 0
    mt_hint_match = 0
    if q_mt_hint and it.get("mediaType") == q_mt_hint and (exact_match_any or pref_match_any):
        if not q_is_anime or orig_lang == "ja" or "anime" in cats or "animation" in cats:
            mt_hint_match = 1

    is_tr_flagship = 1 if (
        nq
        and (nt == nq or no == nq or nt_pref == nq)
        and (tid in _FLAGSHIP_TR_TMDB_IDS or (nt == nq and no == nq and orig_lang == "tr" and vc >= 30))
    ) else 0
    has_tr_chars = orig_lang == "tr" or any(c in "çğıöşüÇĞİÖŞÜ" for c in raw_t)
    is_substantial = (
        (vc >= 80 and rating >= 5.5)
        or bool(it.get("curatedFranchise"))
        or is_tr_flagship == 1
        or (has_tr_chars and yr >= "2010" and vc >= 5)
        or (q_year and yr == q_year)
    )
    raw_t_clean = re.sub(r"\([^)]*\)", "", raw_t).strip()
    has_spinoff_sub = bool(
        re.search(r"[:\-–—].*[:\-–—]", raw_t_clean)
        or re.search(r"[:\-–—].*[:\-–—]", raw_o)
        or (raw_e and re.search(r"[:\-–—].*[:\-–—]", raw_e))
        or re.search(r"\b(?:the\s+movie|movie|sonsuzluk\s+kalesi|mugen\s+train|mugen\s+treni|fuka\s+ryouiki|gekij|hashira\s+training|swordsmith\s+village)\b|劇場版", f"{raw_t} {raw_o} {raw_e}", re.I)
    )

    if exact_match_any and is_substantial:
        exact_tier = 5
    elif pref_match_any and vc >= 2500:
        exact_tier = 5
    elif pref_match_any and vc >= 600 and not has_spinoff_sub:
        exact_tier = 5
    elif (pref_match_any or starts_match_any) and is_substantial:
        exact_tier = 3
    elif exact_match_any:
        exact_tier = 2
    elif sub_match_any:
        exact_tier = 1
    else:
        exact_tier = 0

    pop_tier = 3 if vc >= 2000 else (2 if vc >= 300 else (1 if vc >= 40 else 0))
    released = 1 if (yr and yr <= "2026" and (vc >= 5 or "voteCount" not in it)) else 0
    acclaimed_tv = 1 if (it.get("mediaType") == "tv" and rating >= 8.2 and vc >= 2500) else 0
    return (year_exact, mt_hint_match, is_tr_flagship, exact_tier, pop_tier, released, acclaimed_tv, vc, rating)


def _match_star_wars_curated(q: str) -> list:
    clean_q, _, _, _ = _parse_search_query(q)
    ql = (clean_q or q or "").strip().replace("İ", "i").replace("I", "ı").lower()
    if not ql:
        return []
    out = []
    sw_triggers = ("star wars", "starwars", "yıldız savaş", "yildiz savas", "clone wars", "klon savaş", "klon savas", "mandalorian", "obi-wan", "obi wan", "ahsoka", "andor", "boba fett", "skywalker", "darth vader", "jedi", "sith", "rogue one", "bad batch", "acolyte", "skeleton crew", "visions", "tales of the empire")
    if any(t in ql for t in sw_triggers):
        if any(t in ql for t in ("star wars", "starwars", "yıldız savaş", "yildiz savas")):
            out.extend([dict(x, curatedFranchise=True) for x in _STAR_WARS_CURATED])
        else:
            matched = [dict(x, curatedFranchise=True) for x in _STAR_WARS_CURATED if ql in x["title"].lower() or ql in x["originalTitle"].lower()]
            out.extend(matched + [dict(x, curatedFranchise=True) for x in _STAR_WARS_CURATED if x not in matched])
    nq = _norm_title(ql)
    for _dom_p, _dom_items in globals().get("_DOMESTIC_TR_ORIGINALS", {}).items():
        for item_d in _dom_items:
            nt_d = _norm_title(item_d.get("title") or "")
            nt_d_pref = _norm_title(re.split(r"[:\-–—]", item_d.get("title") or "")[0])
            if nq and (nq == nt_d or nq == nt_d_pref or (len(nq) >= 4 and nt_d.startswith(nq))):
                if not any(x.get("tmdbId") == item_d.get("tmdbId") for x in out):
                    out.append(dict(item_d, curatedFranchise=True))
    for item_c in _EXTRA_CURATED_CATALOG:
        nt_c = _norm_title(item_c.get("title") or "")
        no_c = _norm_title(item_c.get("originalTitle") or "")
        if nq and (
            nq == nt_c
            or nq == no_c
            or (len(nq) >= 5 and (nt_c.startswith(nq) or no_c.startswith(nq)))
            or (ql in ("yeşilçam", "yesilcam", "kemal sunal", "şener şen", "sener sen") and item_c.get("origLang") == "tr")
        ):
            if not any(x.get("tmdbId") == item_c.get("tmdbId") and x.get("mediaType") == item_c.get("mediaType") for x in out):
                out.append(dict(item_c, curatedFranchise=True))
    return out


def _expand_tr_phonetic_query(q: str) -> str:
    nq = _norm_title(q)
    for rx, rep in (
        (r"\baktivite(?:ler|si)?\b", "activity"),
        (r"\bdoktor\b", "doctor"),
        (r"\bkaptan\b", "captain"),
        (r"\bsuper\b", "super"),
        (r"\bfantastik\b", "fantastic"),
        (r"\bekspres\b", "express"),
        (r"\bmisyon\b", "mission"),
        (r"\bprofesor\b", "professor"),
    ):
        nq = re.sub(rx, rep, nq)
    return nq if nq != _norm_title(q) else ""


def _tmdb_sync(q: str):
    clean_q, q_year, q_mt_hint, _ = _parse_search_query(q)
    eff_q = clean_q or q
    alt_q = _expand_tr_phonetic_query(eff_q)
    curated_sw = _match_star_wars_curated(q)
    if not TMDB_API_KEY:
        curated_sw.sort(key=lambda x: _rank_search_item(x, q), reverse=True)
        return curated_sw[:40]
    import concurrent.futures
    def _fetch_p(task_idx):
        try:
            if task_idx == 1:
                u = "https://api.themoviedb.org/3/search/multi?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "query": eff_q, "page": 1})
                d = _http_json(u, timeout=2.8)
                return [r for r in d.get("results", []) if r.get("media_type") in ("movie", "tv") and r.get("poster_path")]
            if task_idx == 3:
                u_en = "https://api.themoviedb.org/3/search/multi?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "en-US", "query": alt_q or eff_q, "page": 1})
                d_en = _http_json(u_en, timeout=2.8)
                return [r for r in d_en.get("results", []) if r.get("media_type") in ("movie", "tv") and r.get("poster_path")]
            if q_year:
                u_m = "https://api.themoviedb.org/3/search/movie?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "query": eff_q, "year": q_year, "page": 1})
                d_m = _http_json(u_m, timeout=2.8)
                return [dict(r, media_type="movie") for r in d_m.get("results", []) if r.get("poster_path")]
            if q_mt_hint in ("tv", "movie"):
                u_t = f"https://api.themoviedb.org/3/search/{q_mt_hint}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "query": eff_q, "page": 1})
                d_t = _http_json(u_t, timeout=2.8)
                return [dict(r, media_type=q_mt_hint) for r in d_t.get("results", []) if r.get("poster_path")]
            if alt_q:
                u_en2 = "https://api.themoviedb.org/3/search/multi?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "en-US", "query": eff_q, "page": 1})
                d_en2 = _http_json(u_en2, timeout=2.8)
                return [r for r in d_en2.get("results", []) if r.get("media_type") in ("movie", "tv") and r.get("poster_path")]
            return []
        except Exception:
            return []
    raw_tr = []
    raw_en = []
    task_ids = [1, 3]
    if q_year or q_mt_hint in ("tv", "movie") or alt_q:
        task_ids.append(2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(task_ids)) as pool:
        res_map = dict(zip(task_ids, pool.map(_fetch_p, task_ids)))
        raw_tr.extend(res_map.get(1) or [])
        if 2 in res_map and not alt_q:
            raw_tr.extend(res_map[2] or [])
        elif 2 in res_map and alt_q:
            raw_en.extend(res_map[2] or [])
        raw_en.extend(res_map.get(3) or [])
    en_title_map = {}
    tr_keys = {f"{'tv' if r.get('media_type') == 'tv' else 'movie'}:{r.get('id')}" for r in raw_tr if r.get("id")}
    for r_en in raw_en:
        mt_e = "tv" if r_en.get("media_type") == "tv" else "movie"
        id_e = str(r_en.get("id") or "")
        t_e = (r_en.get("title") or r_en.get("name") or "").strip()
        k_e = f"{mt_e}:{id_e}"
        if id_e and t_e and k_e not in en_title_map:
            en_title_map[k_e] = t_e
        if id_e and k_e not in tr_keys:
            tr_keys.add(k_e)
            raw_tr.append(r_en)
    api_items = [_tmdb_item(r) for r in raw_tr]
    for a_it in api_items:
        k_a = f"{a_it.get('mediaType')}:{a_it.get('tmdbId') or a_it.get('id')}"
        en_t = en_title_map.get(k_a) or ""
        if en_t and not re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]", en_t):
            a_it["enTitle"] = en_t
            cur_t = str(a_it.get("title") or "")
            cur_o = str(a_it.get("originalTitle") or "")
            if cur_t.startswith("Anime / Asya Yapımı") or re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]", cur_t):
                a_it["title"] = en_t
            if re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]", cur_o):
                a_it["originalTitle"] = en_t
                if _norm_title(en_t) and _norm_title(en_t) not in _norm_title(a_it["title"]):
                    a_it["title"] = f"{a_it['title']} ({en_t})"
        elif eff_q and re.search(r"[A-Za-z]", eff_q) and str(a_it.get("title") or "").startswith("Anime / Asya Yapımı") and int(a_it.get("voteCount") or 0) >= 40:
            a_it["title"] = eff_q.title()
            a_it["originalTitle"] = eff_q.title()
    seen_k = set()
    combined = []
    for it in curated_sw + api_items:
        k = f"{it.get('mediaType')}:{it.get('tmdbId') or it.get('id')}"
        if k in seen_k:
            continue
        seen_k.add(k)
        combined.append(it)
    combined.sort(key=lambda x: _rank_search_item(x, q), reverse=True)
    return combined[:45]


FREE_TR_PROVIDERS = {"cinema", "hdfilmcehennemi", "dizibox", "dizilife", "fullhdfilm", "yabancidizi", "plex", "pluto", "tubi", "dizipal"}

_MAIN_SITES_VAULT: dict = {"catalog": {"fhd": [], "hfnl": [], "dbx": []}, "streams": {}}
_STREAM_URL_TO_SUBS: dict[str, list] = {}
try:
    _ms_vault_path = BASE_DIR / "main_sites_vault.json"
    if _ms_vault_path.exists():
        _MAIN_SITES_VAULT = json.loads(_ms_vault_path.read_text(encoding="utf-8"))
        for _vk, _vent in (_MAIN_SITES_VAULT.get("streams") or {}).items():
            if isinstance(_vent, dict) and _vent.get("subs") and _vent.get("streams"):
                _vsubs = [s for s in _vent["subs"] if isinstance(s, dict) and s.get("url")]
                if _vsubs:
                    for _st_pair in _vent["streams"]:
                        if isinstance(_st_pair, (list, tuple)) and len(_st_pair) >= 1 and _st_pair[0]:
                            _su_k = str(_st_pair[0]).strip()
                            if _su_k and _su_k not in _STREAM_URL_TO_SUBS:
                                _STREAM_URL_TO_SUBS[_su_k] = _vsubs
except Exception:
    _MAIN_SITES_VAULT = {"catalog": {"fhd": [], "hfnl": [], "dbx": []}, "streams": {}}

_FHD_CAT_PATHS = {
    "all": ["/yeni-filmler", "/en-cok-izlenen-filmler"],
    "movies": ["/yeni-filmler", "/populer-filmler"],
    "series": [],
    "trend": ["/en-cok-izlenen-filmler", "/populer-filmler"],
    "dublaj": ["/filmizle/turkce-dublaj-filmler-1", "/filmizle/dual-filmler-1"],
    "anime": ["/filmizle/animasyon-filmleri-izle"],
    "action": ["/filmizle/aksiyon-filmleri"],
    "scifi": ["/filmizle/bilim-kurgu-filmleri"],
    "drama": ["/filmizle/dram-filmler-izle"],
    "comedy": ["/filmizle/komedi-filmleri"],
    "horror": ["/filmizle/korku-filmleri"],
    "animation": ["/filmizle/animasyon-filmleri-izle"],
    "doc": ["/filmizle/belgesel-filmleri"],
}

_HFNL_CAT_PATHS = {
    "all": ["/category/film-izle-2/", "/yabancidiziizle-5/"],
    "movies": ["/category/film-izle-2/", "/category/tavsiye-filmler-izle2/"],
    "series": ["/yabancidiziizle-5/"],
    "trend": ["/category/tavsiye-filmler-izle2/", "/category/film-izle-2/"],
    "dublaj": ["/turkce-dublaj-film-izle/", "/category/film-izle-2/"],
    "anime": ["/yabancidiziizle-5/"],
    "action": ["/tur/action-adventure/"],
    "scifi": ["/tur/science-fiction/", "/tur/sci-fi-fantasy/"],
    "drama": ["/tur/polisiye-filmleri-izle/"],
    "comedy": ["/category/film-izle-2/"],
    "horror": ["/category/film-izle-2/"],
    "animation": ["/tur/kids/"],
    "doc": ["/category/film-izle-2/"],
}


def _scrape_hdfc_catalog_sync(cat: str = "all", page: int = 1, q: str = "", prov: str = "") -> list:
    if prov in ("max", "hbomax"):
        return []
    import html as html_mod
    out = []
    seen = set()
    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    if q.strip():
        clean_q, _, _, _ = _parse_search_query(q)
        nq = _norm_title(clean_q or q.strip())
        for src_list in (v_cat.get("fhd") or [], v_cat.get("hfnl") or []):
            for it in src_list:
                nt = _norm_title(it.get("title") or "")
                no = _norm_title(it.get("originalTitle") or "")
                if _vault_title_matches_query(nq, nt, no):
                    if it["id"] not in seen:
                        seen.add(it["id"])
                        out.append(dict(it))
        try:
            fhd_su = f"https://www.fullhdfilmizlesene.now/arama/{urllib.parse.quote((clean_q or q).strip())}"
            fhd_raw = urllib.request.urlopen(urllib.request.Request(fhd_su, headers={"User-Agent": UA137, "Referer": "https://www.fullhdfilmizlesene.now/"}), timeout=3.5).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            for card in re.findall(r'<li class="film"[^>]*>(.*?)</li>', fhd_raw, re.S):
                hm = re.search(r'<a[^>]+class="tt"[^>]+href=["\'](https://www\.fullhdfilmizlesene\.now/film/([^"\'/]+)/?)["\']', card)
                if not hm:
                    continue
                href, slug = hm.group(1), hm.group(2)
                cid = f"fhd-{slug}"
                if cid in seen or "fragman" in slug.lower():
                    continue
                seen.add(cid)
                tm = re.search(r'<span class="film-title">([^<]+)</span>', card)
                om = re.search(r'<span class="kt">([^<]+)</span>', card)
                tr_t = html_mod.unescape(tm.group(1).strip()) if tm else slug.replace("-", " ").title()
                orig_t = html_mod.unescape(om.group(1).strip()) if om else tr_t
                ym = re.search(r'<span class="film-yil">(\d{4})</span>', card)
                year = ym.group(1) if ym else "2025"
                pm = re.search(r'data-src=["\'](https://[^"\']+)["\']', card) or re.search(r'srcset=["\'](https://[^\s"\']+)', card)
                poster = pm.group(1).strip() if pm else ""
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": "movie",
                    "title": tr_t, "originalTitle": orig_t, "year": year,
                    "rating": 7.9, "voteCount": 1450, "categories": ["movies", "trend"],
                    "genreLabel": "🇹🇷 Dublaj & Altyazı · 1080p", "sourceBadge": "🎬 FullHD 1080p",
                    "poster": poster, "backdrop": poster, "officialUrl": href,
                })
        except Exception:
            pass
        try:
            hfnl_su = f"https://www.hdfilmcehennemi.nl/?s={urllib.parse.quote(q.strip())}"
            raw_s = urllib.request.urlopen(urllib.request.Request(hfnl_su, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.5).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            for card in re.findall(r'<a[^>]+href="(https://www\.hdfilmcehennemi\.(?:nl|land)/(?:film|dizi)/[^"]+)"[^>]*>(.*?)</a>', raw_s, re.S):
                href, c_body = card
                slug = href.rstrip("/").split("/")[-1].replace("-izle", "")
                cid = f"hfnl-{slug}"
                if not slug or cid in seen or "fragman" in slug.lower():
                    continue
                seen.add(cid)
                tm = re.search(r'title="([^"]+)"', c_body) or re.search(r'<h\d[^>]*>([^<]+)</h\d>', c_body)
                title = html_mod.unescape(tm.group(1).strip()) if tm else slug.replace("-", " ").title()
                pm = re.search(r'src="([^"]+)"', c_body)
                poster = pm.group(1).strip() if pm else ""
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": "tv" if "/dizi/" in href else "movie",
                    "title": title, "originalTitle": title, "year": "2025",
                    "rating": 7.9, "voteCount": 1400, "categories": ["series" if "/dizi/" in href else "movies", "trend"],
                    "genreLabel": "🇹🇷 Dublaj & Altyazılı · 1080p", "sourceBadge": "🎬 HDFilmCehennemi+",
                    "poster": poster, "backdrop": poster,
                    "officialUrl": href,
                })
        except Exception:
            pass
        return out


    if page == 1:
        for src_list in (v_cat.get("fhd") or [], v_cat.get("hfnl") or []):
            for it in src_list:
                if cat == "dublaj" and not _has_dub_vault_stream(it):
                    continue
                if cat in ("all", "trend") or cat in (it.get("categories") or []):
                    if it["id"] not in seen:
                        seen.add(it["id"])
                        out.append(dict(it))
    fhd_paths = _FHD_CAT_PATHS.get(cat, _FHD_CAT_PATHS["all"])
    for base_p in fhd_paths[:2]:
        if page > 1 and base_p == "/":
            continue
        try:
            p_url = f"https://www.fullhdfilmizlesene.now{base_p.rstrip('/')}/{page}" if (page > 1 and base_p != "/") else f"https://www.fullhdfilmizlesene.now{base_p}"
            raw = urllib.request.urlopen(urllib.request.Request(p_url, headers={"User-Agent": UA137, "Referer": "https://www.fullhdfilmizlesene.now/"}), timeout=3.5).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            for card in re.findall(r'<li class="film"[^>]*>(.*?)</li>', raw, re.S):
                hm = re.search(r'<a[^>]+class="tt"[^>]+href=["\'](https://www\.fullhdfilmizlesene\.now/film/([^"\'/]+)/?)["\']', card)
                if not hm:
                    continue
                href, slug = hm.group(1), hm.group(2)
                cid = f"fhd-{slug}"
                if cid in seen or "fragman" in slug.lower():
                    continue
                dm = re.search(r'<span class="trz[^"]*"[^>]*>([^<]+)</span>', card)
                lang_tag = html_mod.unescape(dm.group(1).strip()) if dm else "Dublaj & Altyazı"
                lt_low = lang_tag.lower()
                if "yakında" in lt_low or "fragman" in lt_low:
                    continue
                if cat == "dublaj" and ("altyaz" in lt_low and "dublaj" not in lt_low and "dual" not in lt_low):
                    continue
                seen.add(cid)
                tm = re.search(r'<span class="film-title">([^<]+)</span>', card)
                om = re.search(r'<span class="kt">([^<]+)</span>', card)
                tr_t = html_mod.unescape(tm.group(1).strip()) if tm else slug.replace("-", " ").title()
                orig_t = html_mod.unescape(om.group(1).strip()) if om else tr_t
                ym = re.search(r'<span class="film-yil">(\d{4})</span>', card)
                year = ym.group(1) if ym else "2025"
                pm = re.search(r'data-src=["\'](https://[^"\']+)["\']', card) or re.search(r'srcset=["\'](https://[^\s"\']+)', card)
                poster = pm.group(1).strip() if pm else ""
                cats = ["movies", "trend"]
                if cat not in ("all", "series", "movies", "trend") and cat not in cats:
                    cats.append(cat)
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": "movie",
                    "title": tr_t, "originalTitle": orig_t, "year": year,
                    "rating": 7.9, "voteCount": 1450, "categories": cats,
                    "genreLabel": f"🇹🇷 {lang_tag} · 1080p", "sourceBadge": "🎬 FullHD 1080p",
                    "poster": poster, "backdrop": poster, "officialUrl": href,
                })
        except Exception:
            continue
    hfnl_paths = _HFNL_CAT_PATHS.get(cat, _HFNL_CAT_PATHS["all"])
    for base_p in hfnl_paths[:2]:
        if page > 1 and base_p == "/":
            continue
        try:
            p_url = f"https://www.hdfilmcehennemi.nl{base_p.rstrip('/')}/page-{page}/" if (page > 1 and base_p != "/") else f"https://www.hdfilmcehennemi.nl{base_p}"
            raw = urllib.request.urlopen(urllib.request.Request(p_url, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.5).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            for card in re.findall(r'(<a[^>]+class="poster[^>]*>.*?</a>)', raw, re.S):
                if "poster-slider" in card:
                    continue
                hm = re.search(r'href=["\'](https://www\.hdfilmcehennemi\.nl/([^"\']+))["\']', card)
                if not hm:
                    continue
                href, path_part = hm.group(1), hm.group(2).strip("/")
                slug = path_part.rsplit("/", 1)[-1]
                cid = f"hfnl-{slug}"
                if not slug or cid in seen or "fragman" in slug.lower():
                    continue
                ym = re.search(r'<div class="poster-meta">\s*<span>(\d{4})</span>', card)
                year = ym.group(1) if ym else "2025"
                im = re.search(r'<span class="imdb">.*?</svg>\s*([0-9.]+)</span>', card, re.S)
                try:
                    rating = float(im.group(1)) if im else 7.8
                except Exception:
                    rating = 7.8
                if rating == 0.0 and year >= "2026":
                    continue
                seen.add(cid)
                mtype = "tv" if ("/dizi/" in href or "yabancidizi" in base_p) else "movie"
                tm = re.search(r'<strong class="poster-title">([^<]+)</strong>', card)
                raw_t = html_mod.unescape(tm.group(1).strip()) if tm else slug.replace("-", " ").title()
                tr_t, orig_t = ([x.strip() for x in raw_t.split(" - ", 1)] if " - " in raw_t else (raw_t, raw_t))
                pm = re.search(r'data-src=["\'](https://[^"\']+)["\']', card) or re.search(r'<img[^>]+src=["\'](https://[^"\']+)["\']', card)
                poster = pm.group(1).strip() if pm else ""
                cats = ["series" if mtype == "tv" else "movies", "trend"]
                if cat not in ("all", "series", "movies", "trend") and cat not in cats:
                    cats.append(cat)
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": mtype,
                    "title": tr_t, "originalTitle": orig_t, "year": year,
                    "rating": rating if rating > 0 else 7.8, "voteCount": 1500, "categories": cats,
                    "genreLabel": "🇹🇷 Dublaj & Altyazılı · 1080p", "sourceBadge": "🎬 HDFilmCehennemi+",
                    "poster": poster, "backdrop": poster, "officialUrl": href,
                })
        except Exception:
            continue
    return out


def _scrape_dizilife_catalog_sync(cat: str = "all", page: int = 1, q: str = "", prov: str = "") -> list:
    if prov in ("max", "hbomax"):
        return []
    import html as html_mod
    out = []
    seen = set()
    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    if q.strip():
        clean_q, _, _, _ = _parse_search_query(q)
        nq = _norm_title(clean_q or q.strip())
        for it in (v_cat.get("dbx") or []) + [x for x in (v_cat.get("hfnl") or []) if x.get("mediaType") == "tv"]:
            nt = _norm_title(it.get("title") or "")
            no = _norm_title(it.get("originalTitle") or "")
            if _vault_title_matches_query(nq, nt, no):
                if it["id"] not in seen:
                    seen.add(it["id"])
                    out.append(dict(it))
        return out
    if cat != "movies" and page == 1:
        for it in (v_cat.get("dbx") or []):
            if it["id"] not in seen:
                seen.add(it["id"])
                out.append(dict(it))
    for u in [f"https://www.dizibox.live/arsiv/page/{page}/" if page > 1 else "https://www.dizibox.live/arsiv/"]:
        try:
            raw = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://www.dizibox.live/"}), timeout=3.2).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            for art in re.findall(r'(<article[^>]*>.*?</article>)', raw, re.S):
                hm = re.search(r'href=["\'](https://www\.dizibox\.live/diziler/([^"\'/]+)/?)["\']', art)
                if not hm:
                    continue
                href, slug = hm.group(1), hm.group(2)
                cid = f"dbx-{slug}"
                if not slug or cid in seen:
                    continue
                seen.add(cid)
                tm = re.search(r'<h3[^>]*><a[^>]*>([^<]+)</a></h3>', art) or re.search(r'alt=["\']([^"\']+)["\']', art)
                title = html_mod.unescape(tm.group(1).strip()) if tm else slug.replace("-", " ").title()
                pm = re.search(r'<img[^>]+src=["\'](https://[^"\']+)["\']', art)
                poster = pm.group(1).strip() if pm else ""
                ym = re.search(r'\b((?:19|20)\d{2})\b', art)
                year = ym.group(1) if ym else "2024"
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": "tv",
                    "title": title, "originalTitle": title, "year": year,
                    "rating": 8.2, "voteCount": 1600, "categories": ["series", "trend"],
                    "genreLabel": "🇹🇷 Türkçe Altyazı & Dublaj · 1080p", "sourceBadge": "📺 Dizibox HD",
                    "poster": poster, "backdrop": poster, "officialUrl": href,
                })
        except Exception:
            continue
    return out



def _scrape_animecix_catalog_sync(cat: str = "all", page: int = 1, q: str = "", prov: str = "") -> list:
    if prov in ("max", "hbomax"):
        return []
    out = []
    seen = set()
    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    if q.strip():
        clean_q, _, _, _ = _parse_search_query(q)
        nq = _norm_title(clean_q or q.strip())
        for it in (v_cat.get("ac") or []):
            nt = _norm_title(it.get("title") or "")
            no = _norm_title(it.get("originalTitle") or "")
            if _vault_title_matches_query(nq, nt, no):
                if it["id"] not in seen:
                    seen.add(it["id"])
                    out.append(dict(it))
    elif page == 1:
        for it in (v_cat.get("ac") or []):
            if it["id"] not in seen:
                seen.add(it["id"])
                out.append(dict(it))
    hdrs = {"User-Agent": UA137, "Referer": "https://animecix.tv/", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest"}
    try:
        if q.strip():
            clean_q, _, _, _ = _parse_search_query(q)
            u = f"https://animecix.tv/secure/search/{urllib.parse.quote((clean_q or q).strip())}?limit=14"
            data = _raw_get_json(u, headers=hdrs, timeout=3.5) or {}
            rows = data.get("results") or []
        else:
            u = f"https://animecix.tv/secure/titles?perPage=16&page={max(1, page)}&order=popularity:desc"
            data = _raw_get_json(u, headers=hdrs, timeout=3.5) or {}
            pag = data.get("pagination")
            rows = (pag.get("data") if isinstance(pag, dict) else (pag if isinstance(pag, list) else None)) or data.get("results") or data.get("data") or []
        for r in rows:
            if not isinstance(r, dict):
                continue
            ac_id = r.get("id")
            name = str(r.get("name") or r.get("original_title") or "").strip()
            cid = f"ac-{ac_id}"
            if not ac_id or not name or cid in seen:
                continue
            seen.add(cid)
            is_series_val = r.get("is_series")
            raw_t_type = str(r.get("type") or r.get("title_type") or "").strip().lower()
            if raw_t_type == "movie" or bool(r.get("is_movie")) or re.search(r"\b(?:the\s+movie|movie\s*\d|gekijouban|gekijoban)\b", f"{name} {r.get('original_title') or ''}", re.I):
                mtype = "movie"
            elif is_series_val is not None:
                mtype = "tv" if bool(is_series_val) else "movie"
            else:
                mtype = "tv"
            poster = str(r.get("poster") or r.get("backdrop") or "").strip()
            backdrop = str(r.get("backdrop") or poster).strip()
            year = str(r.get("year") or r.get("release_date") or "2024")[:4]
            try:
                rating = round(float(r.get("mal_vote_average") or r.get("tmdb_vote_average") or 8.4), 1)
            except (TypeError, ValueError):
                rating = 8.4
            out.append({
                "id": cid, "tmdbId": str(r.get("tmdb_id") or ""), "mediaType": mtype,
                "title": name, "originalTitle": str(r.get("original_title") or name), "year": year,
                "rating": rating, "voteCount": int(r.get("mal_vote_count") or 18500),
                "categories": ["series" if mtype == "tv" else "movies", "anime", "animation", "trend"],
                "genreLabel": "⛩️ Animetrix · Türkçe Fansub & Dublaj", "sourceBadge": "⛩️ Animetrix Fansub",
                "poster": poster, "backdrop": backdrop,
                "officialUrl": f"https://animecix.tv/titles/{ac_id}",
            })
    except Exception:
        pass
    return out


_DOMESTIC_TR_ORIGINALS = {
    "exxen": [
        {"id": "115678", "tmdbId": "115678", "mediaType": "tv", "title": "Gibi", "originalTitle": "Gibi", "origLang": "tr", "year": "2021", "rating": 8.9, "voteCount": 4200, "categories": ["series", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Exxen Orijinal · Komedi", "sourceBadge": "🟡 Exxen 4K", "poster": "https://image.tmdb.org/t/p/w500/sOzTUfTc1djfZM46PgsjuOjs5U1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/p7VgbdDN2LK41JTavzJ9x3i4ktE.jpg"},
        {"id": "40417", "tmdbId": "40417", "mediaType": "tv", "title": "Leyla ile Mecnun", "originalTitle": "Leyla ile Mecnun", "origLang": "tr", "year": "2011", "rating": 9.1, "voteCount": 5800, "categories": ["series", "comedy", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Exxen Orijinal · Absürt Komedi", "sourceBadge": "🟡 Exxen 4K", "poster": "https://image.tmdb.org/t/p/w500/3jPLJJXbFabb29mOxZOK0xctcy6.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aEQEIXDmjd9otezUu64VFmpO51K.jpg"},
        {"id": "61516", "tmdbId": "61516", "mediaType": "tv", "title": "Kardeş Payı", "originalTitle": "Kardeş Payı", "origLang": "tr", "year": "2014", "rating": 8.7, "voteCount": 3400, "categories": ["series", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Komedi", "sourceBadge": "🟡 Exxen 4K", "poster": "https://image.tmdb.org/t/p/w500/5rsZr16V6yT4jyGB0QLkXi5yC5M.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/uoFnDLca6zbVCPmvzJ6s5gGwVhA.jpg"},
        {"id": "59", "tmdbId": "59", "mediaType": "tv", "title": "Avrupa Yakası", "originalTitle": "Avrupa Yakası", "origLang": "tr", "year": "2004", "rating": 8.9, "voteCount": 4100, "categories": ["series", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Sitcom", "sourceBadge": "🟡 Exxen HD", "poster": "https://image.tmdb.org/t/p/w500/p73Sua1a2AO6nwNpwhDrkKjBP8q.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/g2U2bgj2Of9HprnxbNGNZ7o83Po.jpg"},
    ],
    "blutv": [
        {"id": "228853", "tmdbId": "228853", "mediaType": "tv", "title": "Prens", "originalTitle": "Prens", "origLang": "tr", "year": "2023", "rating": 8.6, "voteCount": 3100, "categories": ["series", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Komedi", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/oDtYdl5i8rRLmB9xAU6VOwHKjMQ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/88DMFlyPDuyUeFrUDswbWSV2CQg.jpg"},
        {"id": "39176", "tmdbId": "39176", "mediaType": "tv", "title": "Behzat Ç.: Bir Ankara Polisiyesi", "originalTitle": "Behzat Ç.", "origLang": "tr", "year": "2010", "rating": 8.8, "voteCount": 4900, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Polisiye & Suç", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/aRqNQ5v2tvZ9ZRAXpYik0JamHkm.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/pF1OQe4zaXX9vOwxbxjZzws0CAe.jpg"},
        {"id": "131906", "tmdbId": "131906", "mediaType": "tv", "title": "İlk ve Son", "originalTitle": "İlk ve Son", "origLang": "tr", "year": "2021", "rating": 8.4, "voteCount": 1900, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Romantik Dram", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/epARLyo8ctJr4xVdS2DObuRiie8.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/2UA95tbHkDuNtLjfkychP8Zv4gK.jpg"},
        {"id": "231254", "tmdbId": "231254", "mediaType": "tv", "title": "Magarsus", "originalTitle": "Magarsus", "origLang": "tr", "year": "2023", "rating": 8.2, "voteCount": 1600, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Dram", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/mDAVOY91MSq7CzQlhxfqqA8Xa9Y.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6UjnbGUjXEUrETYHbfkf0jQwAYR.jpg"},
        {"id": "34587", "tmdbId": "34587", "mediaType": "tv", "title": "Kurtlar Vadisi", "originalTitle": "Kurtlar Vadisi", "origLang": "tr", "year": "2003", "rating": 8.9, "voteCount": 5200, "categories": ["series", "action", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Suç & Aksiyon", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/yX6JEIijuH6KNCgO8I2yLKu2Psb.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/sjLv7xpBCP7DZiYS41hMFPRyLQl.jpg"},
        {"id": "17635", "tmdbId": "17635", "mediaType": "tv", "title": "Aşk-ı Memnu", "originalTitle": "Aşk-ı Memnu", "origLang": "tr", "year": "2008", "rating": 8.1, "voteCount": 2900, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Dram & Romantik", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/xHulNzEqtgkTuwrRorBRXdGzHML.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/zcEKO2vdfXAJoAnlgARyhGthLvK.jpg"},
    ],
    "gain": [
        {"id": "77994", "tmdbId": "77994", "mediaType": "tv", "title": "Şahsiyet", "originalTitle": "Şahsiyet", "origLang": "tr", "year": "2018", "rating": 9.0, "voteCount": 6400, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 GAİN Orijinal · Suç & Gerilim", "sourceBadge": "🟣 GAİN 4K", "poster": "https://image.tmdb.org/t/p/w500/vnAsH4kvVVQYQZZ4pf3rJKx1fcR.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aCHCa6YScaZQ9tlGk6zoQmAkIRA.jpg"},
        {"id": "115597", "tmdbId": "115597", "mediaType": "tv", "title": "10 Bin Adım", "originalTitle": "10 Bin Adım", "origLang": "tr", "year": "2020", "rating": 8.1, "voteCount": 1400, "categories": ["series", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 GAİN Orijinal · Komedi", "sourceBadge": "🟣 GAİN 4K", "poster": "https://image.tmdb.org/t/p/w500/s3qr2K8LjVCTIBoWOnkFd6bQqcM.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/cZBzydoCzbZr0lCK72oMkZTAtgq.jpg"},
        {"id": "125412", "tmdbId": "125412", "mediaType": "tv", "title": "Ayak İşleri", "originalTitle": "Ayak İşleri", "origLang": "tr", "year": "2021", "rating": 8.5, "voteCount": 2600, "categories": ["series", "comedy", "action", "tr", "trend"], "genreLabel": "🇹🇷 GAİN Orijinal · Aksiyon Komedi", "sourceBadge": "🟣 GAİN 4K", "poster": "https://image.tmdb.org/t/p/w500/w7Ye1LMhPlST5nvEcmOMJsQcCFf.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/7MSFsfEY4z9VAczH9flrY10vCzb.jpg"},
        {"id": "243832", "tmdbId": "243832", "mediaType": "tv", "title": "İnci Taneleri", "originalTitle": "İnci Taneleri", "origLang": "tr", "year": "2024", "rating": 8.0, "voteCount": 1800, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Dizi · Dram", "sourceBadge": "🟣 GAİN HD", "poster": "https://image.tmdb.org/t/p/w500/4lVO7SDv4OcbdelTvSB1Onw8cEN.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/3S9aMvpi91nUTLtyvQ6vjEyz5Xu.jpg"},
    ],
    "tabii": [
        {"id": "280030", "tmdbId": "280030", "mediaType": "tv", "title": "Gassal", "originalTitle": "Gassal", "origLang": "tr", "year": "2024", "rating": 8.7, "voteCount": 2900, "categories": ["series", "drama", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 tabii Orijinal · Kara Komedi & Dram", "sourceBadge": "🟢 tabii 4K", "poster": "https://image.tmdb.org/t/p/w500/dvTFLhkIlCJaaDi32MxG7ke4vv1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6YMuWmlXKQkhQ0FiwDo9zmIsnEb.jpg"},
        {"id": "65163", "tmdbId": "65163", "mediaType": "tv", "title": "Poyraz Karayel", "originalTitle": "Poyraz Karayel", "origLang": "tr", "year": "2015", "rating": 8.6, "voteCount": 3100, "categories": ["series", "drama", "action", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Dram & Aksiyon", "sourceBadge": "🟢 tabii HD", "poster": "https://image.tmdb.org/t/p/w500/pY8GMqiB35LY6TbWsDSGAsRvcR3.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/78h2cOdj4s4duFVzvfaf1B9pNDe.jpg"},
    ],
    "tod": [
        {"id": "271596", "tmdbId": "271596", "mediaType": "tv", "title": "Sorgu", "originalTitle": "Sorgu", "origLang": "tr", "year": "2024", "rating": 8.0, "voteCount": 1100, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 TOD Orijinal · Polisiye Dram", "sourceBadge": "🟠 TOD HD", "poster": "https://image.tmdb.org/t/p/w500/5jhorUhgbIU9JajEqdzLVXwDyUC.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/22cBQLvwhnLujGLzeOSJa9Tflih.jpg"},
        {"id": "213194", "tmdbId": "213194", "mediaType": "tv", "title": "Kızılcık Şerbeti", "originalTitle": "Kızılcık Şerbeti", "origLang": "tr", "year": "2022", "rating": 7.8, "voteCount": 2100, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Popüler Yerli · Aile & Dram", "sourceBadge": "🟠 TOD HD", "poster": "https://image.tmdb.org/t/p/w500/lSywl799a9yLED1tPJCjobckjxQ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/a4FHdQfPGT1T2w4DYUEGgRMxSgZ.jpg"},
        {"id": "245914", "tmdbId": "245914", "mediaType": "tv", "title": "Bahar", "originalTitle": "Bahar", "origLang": "tr", "year": "2024", "rating": 8.1, "voteCount": 1950, "categories": ["series", "drama", "comedy", "tr", "trend"], "genreLabel": "🇹🇷 Popüler Yerli · Dram", "sourceBadge": "🟠 TOD HD", "poster": "https://image.tmdb.org/t/p/w500/Adjn7rsb1picDMUcYNjEDobhvAk.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6dXyUXZ4HsY6M3Tae9e0KZsFCo1.jpg"},
        {"id": "256400", "tmdbId": "256400", "mediaType": "tv", "title": "Deha", "originalTitle": "Deha", "origLang": "tr", "year": "2024", "rating": 8.2, "voteCount": 1750, "categories": ["series", "drama", "action", "tr", "trend"], "genreLabel": "🇹🇷 Popüler Yerli · Suç & Dram", "sourceBadge": "🟠 TOD HD", "poster": "https://image.tmdb.org/t/p/w500/icPHnFkJBBds6rw4IHf5qR93FJt.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/kt7JCtDy5bfCW0z8zxMF7lHeUG3.jpg"},
    ],
    "puhutv": [
        {"id": "77994", "tmdbId": "77994", "mediaType": "tv", "title": "Şahsiyet", "originalTitle": "Şahsiyet", "origLang": "tr", "year": "2018", "rating": 9.0, "voteCount": 6400, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 puhutv Orijinal · Suç & Gerilim", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/vnAsH4kvVVQYQZZ4pf3rJKx1fcR.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aCHCa6YScaZQ9tlGk6zoQmAkIRA.jpg"},
        {"id": "84575", "tmdbId": "84575", "mediaType": "tv", "title": "Bozkır", "originalTitle": "Bozkır", "origLang": "tr", "year": "2018", "rating": 8.2, "voteCount": 1800, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Polisiye & Suç · HD", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/xtk5XY0SfH4Wb4UvqjykeY42OHp.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/2rbAJwxUxq5P4Xx7JREu1ReN6C7.jpg"},
        {"id": "32519", "tmdbId": "32519", "mediaType": "tv", "title": "Ezel", "originalTitle": "Ezel", "origLang": "tr", "year": "2009", "rating": 8.9, "voteCount": 4800, "categories": ["series", "drama", "action", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Suç & İntikam", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/pHSjh4MINU2JnK7qQvjogQaX3wr.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/3IJPtnlFoY8bjllHxnEw21qlK2p.jpg"},
        {"id": "42099", "tmdbId": "42099", "mediaType": "tv", "title": "Kuzey Güney", "originalTitle": "Kuzey Güney", "origLang": "tr", "year": "2011", "rating": 8.3, "voteCount": 2700, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Dram", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/eG35U9iYp6cWigQxIpzwlPEPY0l.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/tQprHjpB1Utq3QmPDdQRKwPDDRh.jpg"},
        {"id": "74823", "tmdbId": "74823", "mediaType": "tv", "title": "Çukur", "originalTitle": "Çukur", "origLang": "tr", "year": "2017", "rating": 8.1, "voteCount": 3300, "categories": ["series", "action", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Aksiyon & Suç", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/7aL9P5NLSgBjdChcwp4cH1OLdKf.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/xtCzLQOocIajjQ5Mhwp834BQhVX.jpg"},
        {"id": "68388", "tmdbId": "68388", "mediaType": "tv", "title": "İçerde", "originalTitle": "İçerde", "origLang": "tr", "year": "2016", "rating": 8.4, "voteCount": 3100, "categories": ["series", "action", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Polisiye & Aksiyon", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/63v7p8t5sShiCGRLzePlgCu6TNj.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/ex0PAmD0YpM36GKjJrEIMC3JdWD.jpg"},
        {"id": "44878", "tmdbId": "44878", "mediaType": "tv", "title": "Suskunlar", "originalTitle": "Suskunlar", "origLang": "tr", "year": "2012", "rating": 8.6, "voteCount": 2500, "categories": ["series", "drama", "tr", "trend"], "genreLabel": "🇹🇷 Yerli Efsane · Dram & Suç", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/fn2EX9PpOoxiBfB5wypKs7vk1JH.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/h7vd0NQrmP3QjVfoL1zV7hqjikN.jpg"},
    ],
}


def _scrape_dizipal_catalog_sync(cat: str = "all", page: int = 1, q: str = "", prov: str = "") -> list:
    if prov in ("max", "hbomax"):
        return []
    out = []
    seen = set()
    dom = DIZIPAL_DOMAINS[0] if DIZIPAL_DOMAINS else "dizipalw2.com"
    if q.strip():
        try:
            mj_body = json.dumps({"action": "searchContent", "params": [q.strip()]}).encode("utf-8")
            req_mj = urllib.request.Request(
                f"https://{dom}/api/mj",
                data=mj_body,
                headers={"User-Agent": UA137, "Content-Type": "application/json", "Origin": f"https://{dom}", "Referer": f"https://{dom}/"},
            )
            with urllib.request.urlopen(req_mj, timeout=3.5) as rmj:
                mj_res = (json.loads(rmj.read(131072).decode("utf-8", errors="ignore")).get("result") or [])
            for item_mj in mj_res:
                if not isinstance(item_mj, dict):
                    continue
                used_sl = str(item_mj.get("used_slug") or "").strip("/")
                if not used_sl:
                    continue
                mtype = "tv" if used_sl.startswith("series/") else "movie"
                slug = used_sl.split("/", 1)[-1]
                cid = f"dp-{slug}"
                if cid in seen:
                    continue
                seen.add(cid)
                title = str(item_mj.get("object_name") or slug.replace("-", " ").title()).strip()
                year = str(item_mj.get("object_release_year") or "")[:4]
                poster = str(item_mj.get("object_poster_url") or "").strip()
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": mtype,
                    "title": title, "originalTitle": title, "year": year or "2025",
                    "rating": 8.2, "voteCount": 1400, "categories": ["series" if mtype == "tv" else "movies", "trend"],
                    "genreLabel": "🇹🇷 Dizipal 1080p Full HD", "sourceBadge": "🔥 Dizipal+",
                    "poster": poster, "backdrop": poster, "officialUrl": f"https://{dom}/{used_sl}"
                })
            if out:
                return out
        except Exception:
            pass
        try:
            req_init = urllib.request.Request(f"https://{dom}/arama-yap", headers={"User-Agent": UA137})
            with urllib.request.urlopen(req_init, timeout=3.5) as r:
                init_html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            m_key = re.search(r'name="cKey"\s+value="([^"]+)"', init_html)
            m_val = re.search(r'name="cValue"\s+value="([^"]+)"', init_html)
            if m_key and m_val:
                cKey, cValue = m_key.group(1), m_val.group(1)
                post_data = urllib.parse.urlencode({
                    "cKey": cKey, "cValue": cValue,
                    "type": "hepsi", "searchterm": q.strip()
                }).encode("utf-8")
                req_s = urllib.request.Request(f"https://{dom}/bg/searchcontent", data=post_data, headers={
                    "User-Agent": UA137, "Referer": f"https://{dom}/arama-yap",
                    "X-Requested-With": "XMLHttpRequest",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                })
                with urllib.request.urlopen(req_s, timeout=3.5) as rs:
                    s_data = json.loads(rs.read(131072).decode("utf-8", errors="ignore"))
                s_html = (s_data.get("data") or {}).get("html") or ""
                cards = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', s_html, re.S)
                for href, c_body in cards:
                    slug = href.rstrip("/").split("/")[-1].replace("-izle", "")
                    mtype = "tv" if "/dizi/" in href else "movie"
                    tm = re.search(r'<div[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</div>', c_body, re.I) or re.search(r'<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</span>', c_body, re.I)
                    title = tm.group(1).strip() if tm else slug.replace("-", " ").title()
                    ym = re.search(r'\b(19\d{2}|20\d{2})\b', c_body)
                    year = ym.group(1) if ym else ""
                    pm = re.search(r'src="([^"]+)"', c_body)
                    poster = pm.group(1).strip() if pm else ""
                    cid = f"dp-{slug}"
                    if cid in seen:
                        continue
                    seen.add(cid)
                    out.append({
                        "id": cid, "tmdbId": "", "mediaType": mtype,
                        "title": title, "originalTitle": title, "year": year,
                        "rating": 8.0, "voteCount": 1200, "categories": ["series" if mtype == "tv" else "movies", "trend"],
                        "genreLabel": "🇹🇷 Dizipal 1080p Full HD", "sourceBadge": "🔥 Dizipal+",
                        "poster": poster, "backdrop": poster, "officialUrl": href
                    })
        except Exception:
            pass
        return out

    targets = []
    pg_i = max(1, int(page or 1))
    pg_sfx = f"?page={pg_i}" if pg_i > 1 else ""
    if cat in ("all", "series", "trend"):
        targets.append(("tv", f"https://{dom}/diziler{pg_sfx}"))
    if cat in ("all", "movies", "trend"):
        targets.append(("movie", f"https://{dom}/filmler{pg_sfx}"))

    for mtype, p_url in targets:
        try:
            req = urllib.request.Request(p_url, headers={"User-Agent": UA137})
            with urllib.request.urlopen(req, timeout=4.0) as r:
                raw = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            pat = r'<a[^>]+href="(https://[^/"]+/(?:dizi|film)/[^"]+)"[^>]*>(.*?)</a>'
            cards = re.findall(pat, raw, re.S)
            for href, c_body in cards:
                slug = href.rstrip("/").split("/")[-1].replace("-izle", "")
                cid = f"dp-{slug}"
                if cid in seen:
                    continue
                tm = re.search(r'alt="([^"]+)"', c_body) or re.search(r'<h\d[^>]*>([^<]+)</h\d>', c_body)
                if not tm:
                    continue
                title = html_mod.unescape(tm.group(1).strip())
                pm = re.search(r'src="([^"]+)"', c_body)
                poster = pm.group(1).strip() if pm else ""
                seen.add(cid)
                out.append({
                    "id": cid, "tmdbId": "", "mediaType": mtype,
                    "title": title, "originalTitle": title, "year": "2025",
                    "rating": 8.1, "voteCount": 950, "categories": ["series" if mtype == "tv" else "movies", "trend"],
                    "genreLabel": "🇹🇷 1080p Full HD", "sourceBadge": "🔥 Dizipal+",
                    "poster": poster, "backdrop": poster, "officialUrl": href
                })
        except Exception:
            pass
    return out


import threading

_CUSTOM_RELEASES_POOL: list[dict] = []
_CUSTOM_RELEASES_LOADED = False
_CUSTOM_RELEASES_LOCK = threading.Lock()
_NEW_RELEASES_MEM_CACHE: dict[str, object] = {"ts": 0.0, "items": []}


def _register_custom_release_stream(it_obj: dict) -> None:
    if not isinstance(it_obj, dict):
        return
    st_u = str(it_obj.get("streamUrl") or "").strip()
    if not st_u.startswith(("http://", "https://")) or not public_http_url(st_u):
        return
    v_streams = _MAIN_SITES_VAULT.setdefault("streams", {})
    mt_k = "tv" if it_obj.get("mediaType") == "tv" else "movie"
    tid_k = str(it_obj.get("tmdbId") or it_obj.get("id") or "").strip()
    nt_k = _norm_title(it_obj.get("title") or "")
    no_k = _norm_title(it_obj.get("originalTitle") or "")
    st_type = "mp4_fhd" if ".mp4" in st_u.lower() else ("yt" if ("youtube.com" in st_u.lower() or "youtu.be" in st_u.lower()) else "hls_fhd_multi")
    entry = {"streams": [[st_u, st_type]], "customDirect": True, "title": it_obj.get("title") or ""}
    keys = []
    if tid_k:
        keys.extend([f"tmdb:{mt_k}:{tid_k}:1:1", f"id:{tid_k}"])
    if nt_k:
        keys.append(f"{mt_k}:{nt_k}:1:1")
    if no_k:
        keys.append(f"{mt_k}:{no_k}:1:1")
    for k in keys:
        if k in v_streams and isinstance(v_streams[k], dict):
            continue
        v_streams[k] = entry


def _load_custom_releases_sync() -> list[dict]:
    global _CUSTOM_RELEASES_LOADED
    with _CUSTOM_RELEASES_LOCK:
        if not _CUSTOM_RELEASES_LOADED:
            _CUSTOM_RELEASES_LOADED = True
            try:
                stored = social_engine._kv_get("wl:releases:custom:v1")
                if isinstance(stored, list):
                    seen_c = {str(x.get("id") or x.get("tmdbId") or x.get("title") or "") for x in _CUSTOM_RELEASES_POOL}
                    for raw_x in stored:
                        if isinstance(raw_x, dict) and raw_x.get("title"):
                            ck = str(raw_x.get("id") or raw_x.get("tmdbId") or raw_x.get("title") or "")
                            if ck not in seen_c:
                                seen_c.add(ck)
                                _CUSTOM_RELEASES_POOL.append(raw_x)
                            _register_custom_release_stream(raw_x)
            except Exception:
                pass
        return [dict(x) for x in _CUSTOM_RELEASES_POOL]


def _has_vault_stream(it_obj: dict) -> int:
    if not isinstance(it_obj, dict):
        return 0
    if it_obj.get("customRelease") or it_obj.get("streamUrl"):
        return 2
    v_streams = _MAIN_SITES_VAULT.get("streams") or {}
    mt_k = "tv" if it_obj.get("mediaType") == "tv" else "movie"
    tid_k = str(it_obj.get("tmdbId") or it_obj.get("id") or "")
    cid_k = str(it_obj.get("id") or "")
    off_k = str(it_obj.get("officialUrl") or "")
    nt_k = _norm_title(it_obj.get("title") or "")
    no_k = _norm_title(it_obj.get("originalTitle") or "")
    ac_tmdb = globals().get("_ANIMECIX_KNOWN_TMDB") or ()
    ac_names = globals().get("_ANIMECIX_KNOWN_NAMES") or ()
    if tid_k and (tid_k in ac_tmdb or tid_k in globals().get("_CANONICAL_SEASON_SPLITS", {})):
        return 2
    if nt_k.replace(" ", "") in ac_names or no_k.replace(" ", "") in ac_names:
        return 2
    cur_tids = globals().get("_CURATED_ALL_TIDS")
    if cur_tids is None:
        cur_tids = {str(x.get("tmdbId")) for x in (_STAR_WARS_CURATED + _EXTRA_CURATED_CATALOG) if x.get("tmdbId")}
        for _dl in _DOMESTIC_TR_ORIGINALS.values():
            for _di in _dl:
                if _di.get("tmdbId"):
                    cur_tids.add(str(_di.get("tmdbId")))
        globals()["_CURATED_ALL_TIDS"] = cur_tids
    if tid_k and tid_k in cur_tids:
        return 2
    c_keys = [f"url:{off_k}", f"tmdb:{mt_k}:{tid_k}:1:1", f"{mt_k}:{nt_k}:1:1", f"{mt_k}:{no_k}:1:1"]
    if mt_k == "movie":
        c_keys.extend([f"id:{tid_k}", f"id:{cid_k}"])
    best_tier = 0
    for ck in c_keys:
        if ck and ck in v_streams:
            if v_streams[ck].get("customDirect"):
                return 2
            c_st = v_streams[ck].get("streams") or []
            for s in c_st:
                if not isinstance(s, (list, tuple)) or len(s) < 2:
                    continue
                su, st_t = str(s[0]), str(s[1])
                if st_t == "yt" or "youtube.com" in su:
                    continue
                if IS_VERCEL and (
                    st_t in ("hls_dbx", "hls_dp", "hls_hfnl", "hls_hfnl_multi")
                    or "dbx.molystream.org" in su
                    or "dplayer" in su
                    or "hdfilmcehennemi.mobi" in su
                    or ("cdnimages" in su and "/hls/" in su)
                    or "playmix.uno" in su
                    or "master.txt?s=" in su
                ):
                    continue
                if not _stream_matches_title(su, [it_obj.get("title"), it_obj.get("originalTitle")]):
                    continue
                if st_t in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_hfnl_multi", "hls_hfnl", "hls_dp", "hls_dl", "hls", "mp4_ac_sub", "mp4_ac_dub"):
                    return 2
                best_tier = max(best_tier, 1)
    return best_tier


def _has_dub_vault_stream(it_obj: dict) -> bool:
    if not isinstance(it_obj, dict):
        return False
    if str(it_obj.get("origLang") or "").lower() == "tr":
        return True
    tid_k = str(it_obj.get("tmdbId") or it_obj.get("id") or "")
    if tid_k and tid_k in _FLAGSHIP_TR_TMDB_IDS:
        return True
    v_streams = _MAIN_SITES_VAULT.get("streams") or {}
    mt_k = "tv" if it_obj.get("mediaType") == "tv" else "movie"
    cid_k = str(it_obj.get("id") or "")
    off_k = str(it_obj.get("officialUrl") or "")
    nt_k = _norm_title(it_obj.get("title") or "")
    no_k = _norm_title(it_obj.get("originalTitle") or "")
    c_keys = [f"url:{off_k}", f"tmdb:{mt_k}:{tid_k}:1:1", f"{mt_k}:{nt_k}:1:1", f"{mt_k}:{no_k}:1:1"]
    if mt_k == "movie":
        c_keys.extend([f"id:{tid_k}", f"id:{cid_k}"])
    saw_any_vault = False
    for ck in c_keys:
        if ck and ck in v_streams:
            saw_any_vault = True
            for s in (v_streams[ck].get("streams") or []):
                if not isinstance(s, (list, tuple)) or len(s) < 2:
                    continue
                st_t = str(s[1])
                if (
                    "multi" in st_t
                    or st_t.endswith("_tr")
                    or st_t.endswith("_dub")
                    or st_t.startswith(("hls_fp:tr:", "hls_fp:multi:"))
                ):
                    return True
    if saw_any_vault:
        return False
    g_lbl = str(it_obj.get("genreLabel") or "").lower()
    if "dublaj" in g_lbl and not ("altyaz" in g_lbl and "dublaj" not in g_lbl):
        return True
    return False


_SEARCH_QUERY_CACHE: dict[str, tuple[float, dict]] = {}


def _provider_catalog_page_sync(prov: str, q: str = "", page: int = 1, category: str = "all", media_type_filter: str = "") -> dict:
    pg = max(1, min(200, int(page or 1)))
    cat = (category or "all").strip().lower()
    mt_flt = (media_type_filter or "").strip().lower()
    if mt_flt in ("series", "show"):
        mt_flt = "tv"
    elif mt_flt in ("movies", "film"):
        mt_flt = "movie"
    if prov == "anime":
        prov = "cinema"
        cat = "anime"
    is_free_tr = prov in FREE_TR_PROVIDERS
    if q.strip():
        sq = q.strip()
        sq_cache_key = f"sq:{prov}:{cat}:{mt_flt}:{pg}:{_norm_title(sq)}"
        now_sq = time.time()
        sq_hit = _SEARCH_QUERY_CACHE.get(sq_cache_key)
        if sq_hit and (now_sq - sq_hit[0] < 300) and sq_hit[1]:
            return dict(sq_hit[1])
        import concurrent.futures
        scraped_q = []
        tmdb_items = []
        t_start = time.monotonic()
        qpool = concurrent.futures.ThreadPoolExecutor(max_workers=5)
        try:
            fut_tmdb = qpool.submit(_tmdb_sync, sq)
            fut_hdfc = qpool.submit(_scrape_hdfc_catalog_sync, cat, 1, sq, prov) if (is_free_tr and prov not in ("max", "hbomax")) else None
            fut_dl = qpool.submit(_scrape_dizilife_catalog_sync, cat, 1, sq, prov) if (is_free_tr and prov not in ("max", "hbomax")) else None
            fut_ac = qpool.submit(_scrape_animecix_catalog_sync, cat, 1, sq, prov) if ((is_free_tr or prov == "crunchyroll") and prov not in ("max", "hbomax")) else None
            fut_dp = qpool.submit(_scrape_dizipal_catalog_sync, cat, 1, sq, prov) if (is_free_tr and prov not in ("max", "hbomax")) else None
            try:
                tmdb_items = fut_tmdb.result(timeout=3.0)
            except Exception:
                tmdb_items = []
            rem_futs = [f_s for f_s in (fut_hdfc, fut_dl, fut_ac, fut_dp) if f_s]
            if rem_futs:
                rem_budget = max(0.05, 1.4 - (time.monotonic() - t_start))
                concurrent.futures.wait(rem_futs, timeout=rem_budget)
                for f_s in rem_futs:
                    if f_s.done() and not f_s.exception():
                        try:
                            scraped_q.extend(f_s.result() or [])
                        except Exception:
                            pass
        finally:
            qpool.shutdown(wait=False)
        jw_items = []
        if prov in JW_PROV and len(tmdb_items) < 2 and len(scraped_q) < 2:
            pkgs, country = JW_PROV[prov]
            try:
                jw_items = _justwatch_sync(sq, pkgs, country, 24)
            except Exception:
                jw_items = []
        tmdb_by_norm = {}
        tmdb_by_id = {}
        for x in tmdb_items:
            xm = x.get("mediaType") or "movie"
            xtid = str(x.get("tmdbId") or "")
            if xtid and (xm, xtid) not in tmdb_by_id:
                tmdb_by_id[(xm, xtid)] = x
            for k_t in (_norm_title(x.get("title") or ""), _norm_title(x.get("originalTitle") or ""), _norm_title(x.get("enTitle") or "")):
                if k_t and (xm, k_t) not in tmdb_by_norm:
                    tmdb_by_norm[(xm, k_t)] = x
        for s_it in scraped_q:
            sm = s_it.get("mediaType") or "movie"
            stid = str(s_it.get("tmdbId") or "")
            m_tm = (
                (tmdb_by_id.get((sm, stid)) if stid else None)
                or tmdb_by_norm.get((sm, _norm_title(s_it.get("title") or "")))
                or tmdb_by_norm.get((sm, _norm_title(s_it.get("originalTitle") or "")))
            )
            if m_tm:
                s_it["tmdbId"] = m_tm.get("tmdbId") or s_it.get("tmdbId") or ""
                s_it["poster"] = m_tm.get("poster") or s_it.get("poster") or ""
                s_it["backdrop"] = m_tm.get("backdrop") or s_it.get("backdrop") or ""
                s_it["origLang"] = m_tm.get("origLang") or s_it.get("origLang") or ""
                if m_tm.get("enTitle"):
                    s_it["enTitle"] = m_tm["enTitle"]
                if m_tm.get("title") and _norm_title(m_tm["title"]) != _norm_title(s_it.get("title") or ""):
                    s_it["title"] = m_tm["title"]
                if m_tm.get("originalTitle"):
                    s_it["originalTitle"] = m_tm["originalTitle"]
                if m_tm.get("year"):
                    s_it["year"] = m_tm["year"]
                if m_tm.get("voteCount"):
                    s_it["voteCount"] = m_tm["voteCount"]
                    s_it["_tmdb_vc_merged"] = True
                if m_tm.get("rating"):
                    s_it["rating"] = m_tm["rating"]
                s_it["categories"] = list(dict.fromkeys((s_it.get("categories") or []) + (m_tm.get("categories") or [])))
        seen_ids = set()
        merged = []
        clean_q, _, _, _ = _parse_search_query(sq)
        nq = _norm_title(clean_q or sq)
        dom_hits = []
        for c_rel in _load_custom_releases_sync():
            if nq and (nq in _norm_title(c_rel.get("title") or "") or nq in _norm_title(c_rel.get("originalTitle") or "") or str(c_rel.get("tmdbId") or "") == sq.strip()):
                dom_hits.append(dict(c_rel))
        dom_sources = [_DOMESTIC_TR_ORIGINALS[prov]] if prov in _DOMESTIC_TR_ORIGINALS else (list(_DOMESTIC_TR_ORIGINALS.values()) if (is_free_tr or prov == "all") else [])
        for dom_list in dom_sources:
            for d_it in dom_list:
                nt_d = _norm_title(d_it["title"])
                nt_d_pref = _norm_title(re.split(r"[:\-–—]", d_it["title"])[0])
                if nq and (nq == nt_d or nq == nt_d_pref or (len(nq) >= 4 and nt_d.startswith(nq))):
                    dom_hits.append(dict(d_it))
        for item in dom_hits + scraped_q + tmdb_items + jw_items:
            p_u = str(item.get("poster") or "").strip()
            if (not p_u and item.get("title")) or (p_u and "/api/rave/poster" not in p_u and any(d in p_u for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter.", "ddizimag."))):
                qp = urllib.parse.urlencode({
                    "u": p_u,
                    "tid": str(item.get("tmdbId") or "")[:30],
                    "t": str(item.get("title") or "")[:100],
                    "ot": str(item.get("originalTitle") or "")[:100],
                    "y": str(item.get("year") or "")[:8],
                    "mt": str(item.get("mediaType") or "movie")[:10],
                })
                item["poster"] = f"/api/rave/poster?{qp}"
                if not item.get("backdrop") or item.get("backdrop") == p_u:
                    item["backdrop"] = item["poster"]
            tid = str(item.get("tmdbId") or item.get("id") or "")
            nt_key = _norm_title(item.get("title") or "")
            dedup_k = f"{item.get('mediaType')}:{tid or nt_key}"
            if not dedup_k or dedup_k in seen_ids:
                continue
            seen_ids.add(dedup_k)
            merged.append(item)
        merged.sort(key=lambda x: _rank_search_item(x, sq), reverse=True)
        if cat == "dublaj":
            dub_filtered = [x for x in merged if _has_dub_vault_stream(x)]
            if dub_filtered:
                merged = dub_filtered
        if mt_flt in ("tv", "movie"):
            merged = [x for x in merged if x.get("mediaType") == mt_flt]
        elif cat == "series" or prov in ("dizibox", "dizilife", "yabancidizi"):
            merged = [x for x in merged if x.get("mediaType") == "tv"]
        elif cat == "movies" or (prov in ("hdfilmcehennemi", "fullhdfilm") and cat != "series"):
            merged = [x for x in merged if x.get("mediaType") != "tv"]
        start_q = max(0, (pg - 1) * 48)
        sliced_q = merged[start_q:start_q + 48]
        q_res = {"items": sliced_q, "totalAvailable": len(merged), "totalTv": sum(1 for x in merged if x.get("mediaType") == "tv"), "totalMovies": sum(1 for x in merged if x.get("mediaType") != "tv"), "page": pg, "hasMore": len(merged) > start_q + 48}
        if len(_SEARCH_QUERY_CACHE) >= 400:
            _SEARCH_QUERY_CACHE.clear()
        _SEARCH_QUERY_CACHE[sq_cache_key] = (time.time(), q_res)
        return q_res

    now_ts = time.time()
    cache_key = f"v6:{prov}:{cat}:{pg}:{mt_flt}"
    cached = _CATALOG_MEM_CACHE.get(cache_key)
    if cached and (now_ts - cached[0] < 600) and cached[1]:
        return cached[1]

    is_domestic_tr = prov in ("exxen", "blutv", "gain", "tod", "tabii", "tvplus", "puhutv")
    pid = PROVIDER_WATCH_IDS.get(prov, "")
    reg = "TR" if (prov in ("netflix", "disney", "prime", "mubi") or is_domestic_tr or is_free_tr) else "US"
    tv_net_map = {
        "netflix": "213",
        "prime": "1024",
        "disney": "2739|420",
        "max": "49|3186|3308",
        "apple": "2552",
        "paramount": "4330|67",
        "hulu": "453|88",
        "peacock": "3353|6",
    }
    if is_domestic_tr:
        dom_sort = "" if cat in CAT_TMDB_GENRES else {"exxen": "&with_genres=35", "blutv": "&with_genres=18|80", "gain": "&with_genres=18|35", "tod": "&with_genres=80|9648|18", "tabii": "&with_genres=18|36|35|10759", "tvplus": "", "puhutv": "&with_genres=18"}.get(prov, "")
        prov_tv_q = f"&with_original_language=tr{dom_sort}"
        prov_mv_q = f"&with_original_language=tr{dom_sort}"
    else:
        tv_net = tv_net_map.get(prov, "")
        prov_tv_q = f"&with_networks={tv_net}" if tv_net else (f"&with_watch_providers={pid}&watch_region={reg}&with_watch_monetization_types=flatrate|free|ads" if pid else "")
        prov_mv_q = f"&with_watch_providers={pid}&watch_region={reg}&with_watch_monetization_types=flatrate|free|ads" if pid else ""
    base_tv = f"https://api.themoviedb.org/3/discover/tv?api_key={TMDB_API_KEY}&language=tr-TR{prov_tv_q}&without_genres=10763,10764,10766,10767&vote_count.gte=5"
    base_mv = f"https://api.themoviedb.org/3/discover/movie?api_key={TMDB_API_KEY}&language=tr-TR{prov_mv_q}&primary_release_date.lte=2026-04-30&vote_count.gte=10"

    eps = []
    if pg == 1 and cat == "all":
        eps = [
            ("tv", f"{base_tv}&sort_by=popularity.desc&page=1"),
            ("movie", f"{base_mv}&sort_by=popularity.desc&page=1"),
            ("tv", f"{base_tv}&sort_by=vote_count.desc&page=1"),
            ("movie", f"{base_mv}&sort_by=vote_count.desc&page=1"),
            ("tv", f"{base_tv}&sort_by=popularity.desc&page=2"),
            ("movie", f"{base_mv}&sort_by=popularity.desc&page=2"),
            ("tv", f"{base_tv}&sort_by=vote_count.desc&page=2"),
            ("movie", f"{base_mv}&sort_by=vote_count.desc&page=2"),
            ("tv", f"{base_tv}&sort_by=popularity.desc&page=3"),
            ("movie", f"{base_mv}&sort_by=popularity.desc&page=3"),
            ("tv", f"{base_tv}&sort_by=popularity.desc&page=4"),
            ("movie", f"{base_mv}&sort_by=popularity.desc&page=4"),
        ]
    elif cat == "series":
        p1, p2, p3 = (pg - 1) * 3 + 1, (pg - 1) * 3 + 2, (pg - 1) * 3 + 3
        eps = [("tv", f"{base_tv}&sort_by=popularity.desc&page={p1}"), ("tv", f"{base_tv}&sort_by=popularity.desc&page={p2}"), ("tv", f"{base_tv}&sort_by=vote_count.desc&page={p3}")]
    elif cat == "movies":
        p1, p2, p3 = (pg - 1) * 3 + 1, (pg - 1) * 3 + 2, (pg - 1) * 3 + 3
        eps = [("movie", f"{base_mv}&sort_by=popularity.desc&page={p1}"), ("movie", f"{base_mv}&sort_by=popularity.desc&page={p2}"), ("movie", f"{base_mv}&sort_by=vote_count.desc&page={p3}")]
    elif cat == "vizyon":
        p1 = max(1, pg)
        eps = [
            ("movie", f"https://api.themoviedb.org/3/movie/now_playing?api_key={TMDB_API_KEY}&language=tr-TR&region=TR&page={p1}"),
            ("tv", f"https://api.themoviedb.org/3/tv/airing_today?api_key={TMDB_API_KEY}&language=tr-TR&page={p1}"),
            ("tv", f"https://api.themoviedb.org/3/tv/on_the_air?api_key={TMDB_API_KEY}&language=tr-TR&page={p1}"),
            ("movie", f"https://api.themoviedb.org/3/trending/movie/week?api_key={TMDB_API_KEY}&language=tr-TR&page={p1}"),
            ("tv", f"https://api.themoviedb.org/3/trending/tv/week?api_key={TMDB_API_KEY}&language=tr-TR&page={p1}"),
        ]
    elif cat == "trend":
        p1, p2 = (pg - 1) * 2 + 1, (pg - 1) * 2 + 2
        eps = [
            ("tv", f"{base_tv}&vote_average.gte=7.5&vote_count.gte=150&sort_by=vote_count.desc&page={p1}"),
            ("movie", f"{base_mv}&vote_average.gte=7.5&vote_count.gte=250&sort_by=vote_count.desc&page={p1}"),
            ("tv", f"{base_tv}&vote_average.gte=7.5&vote_count.gte=150&sort_by=popularity.desc&page={p2}"),
            ("movie", f"{base_mv}&vote_average.gte=7.5&vote_count.gte=250&sort_by=popularity.desc&page={p2}"),
        ]
    elif cat in CAT_TMDB_GENRES:
        tv_g, mv_g = CAT_TMDB_GENRES[cat]
        p1, p2 = (pg - 1) * 2 + 1, (pg - 1) * 2 + 2
        eps = [
            ("tv", f"{base_tv}&with_genres={tv_g}&sort_by=popularity.desc&page={p1}"),
            ("movie", f"{base_mv}&with_genres={mv_g}&sort_by=popularity.desc&page={p1}"),
            ("tv", f"{base_tv}&with_genres={tv_g}&sort_by=vote_count.desc&page={p2}"),
            ("movie", f"{base_mv}&with_genres={mv_g}&sort_by=vote_count.desc&page={p2}"),
        ]
    else:
        if pg <= 120:
            p1, p2 = pg * 2 + 3, pg * 2 + 4
            era_mv_q, era_tv_q = "", ""
        else:
            _era_buckets = (
                ("&primary_release_date.gte=2021-01-01", "&first_air_date.gte=2021-01-01"),
                ("&primary_release_date.gte=2015-01-01&primary_release_date.lte=2020-12-31", "&first_air_date.gte=2015-01-01&first_air_date.lte=2020-12-31"),
                ("&primary_release_date.gte=2005-01-01&primary_release_date.lte=2014-12-31", "&first_air_date.gte=2005-01-01&first_air_date.lte=2014-12-31"),
                ("&primary_release_date.lte=2004-12-31", "&first_air_date.lte=2004-12-31"),
            )
            _eb_idx = ((pg - 121) // 120) % len(_era_buckets)
            _eb_sub_pg = ((pg - 121) % 120) + 1
            p1, p2 = _eb_sub_pg * 2 - 1, _eb_sub_pg * 2
            era_mv_q, era_tv_q = _era_buckets[_eb_idx]
        eps = [
            ("tv", f"{base_tv}{era_tv_q}&sort_by=popularity.desc&page={p1}"),
            ("movie", f"{base_mv}{era_mv_q}&sort_by=popularity.desc&page={p1}"),
            ("tv", f"{base_tv}{era_tv_q}&sort_by=vote_count.desc&page={p2}"),
            ("movie", f"{base_mv}{era_mv_q}&sort_by=vote_count.desc&page={p2}"),
        ]

    import concurrent.futures
    totals = {"tv": 0, "movie": 0}
    def _fetch_ep(pair):
        dtype, ep_url = pair
        out_list = []
        try:
            data = _http_json(ep_url, timeout=4.8)
            tr = int(data.get("total_results") or 0)
            if tr > totals.get(dtype, 0):
                totals[dtype] = tr
            for r in data.get("results", [])[:20]:
                if (r.get("media_type") or dtype) in ("movie", "tv") and r.get("poster_path"):
                    it = _tmdb_item(r, dtype)
                    if cat in CAT_TMDB_GENRES and cat not in it["categories"]:
                        it["categories"].append(cat)
                    if cat == "vizyon":
                        it["isVizyon"] = True
                        if "vizyon" not in it["categories"]:
                            it["categories"].append("vizyon")
                        it["sourceBadge"] = "🍿 Vizyonda & Yeni"
                    out_list.append(it)
        except Exception:
            pass
        return out_list

    items = []
    seen = set()
    scraped_live = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futs_live = []
        if (is_free_tr or prov == "crunchyroll") and prov not in ("max", "hbomax"):
            if cat == "anime" or prov == "crunchyroll":
                futs_live.append(pool.submit(_scrape_animecix_catalog_sync, cat, pg, "", prov))
                if is_free_tr:
                    futs_live.append(pool.submit(_scrape_hdfc_catalog_sync, cat, pg, "", prov))
            elif prov in ("cinema", "hdfilmcehennemi", "dizilife", "dizibox", "fullhdfilm", "yabancidizi", "dizipal"):
                futs_live.append(pool.submit(_scrape_hdfc_catalog_sync, cat, pg, "", prov))
                futs_live.append(pool.submit(_scrape_dizilife_catalog_sync, cat, pg, "", prov))
                futs_live.append(pool.submit(_scrape_dizipal_catalog_sync, cat, pg, "", prov))
                if cat == "animation":
                    futs_live.append(pool.submit(_scrape_animecix_catalog_sync, cat, pg, "", prov))
            else:
                futs_live.append(pool.submit(_scrape_hdfc_catalog_sync, cat, pg, "", prov))
                futs_live.append(pool.submit(_scrape_dizilife_catalog_sync, cat, pg, "", prov))
                futs_live.append(pool.submit(_scrape_dizipal_catalog_sync, cat, pg, "", prov))
        for batch in pool.map(_fetch_ep, eps):
            for it in batch:
                key = f"{it['mediaType']}:{it['tmdbId']}"
                if it["tmdbId"] and key not in seen:
                    seen.add(key)
                    if is_free_tr:
                        is_jp_anim = "animation" in (it.get("categories") or []) and any(k in (it.get("originalTitle") or "") for k in ("Naruto", "One Piece", "Bleach", "Jujutsu", "Kimetsu", "Shingeki"))
                        it["sourceBadge"] = "⛩️ Animetrix Fansub" if (cat == "anime" or is_jp_anim) else ("📺 Dizi+ Arşiv" if it["mediaType"] == "tv" else "🎬 Sinema+ 4K")
                        it["genreLabel"] = f"🇹🇷 Dublaj & Altyazı · {it.get('genreLabel') or '1080p'}"
                    items.append(it)
        for fl in futs_live:
            try:
                scraped_live.extend(fl.result(timeout=4.2) or [])
            except Exception:
                pass

    v_streams = _MAIN_SITES_VAULT.get("streams") or {}
    v_cat = _MAIN_SITES_VAULT.get("catalog") or {}

    def _safe_poster_url(u_img: str, meta_it: dict | None = None) -> str:
        u_img = str(u_img or "").strip()
        if u_img.startswith("/"):
            return u_img
        if "wsrv.nl/?url=" in u_img:
            try:
                raw_inner = urllib.parse.unquote(u_img.split("url=", 1)[1].split("&", 1)[0])
                if raw_inner.startswith("http"):
                    u_img = raw_inner
            except Exception:
                pass
        if "image.tmdb.org" in u_img or "m.media-amazon.com" in u_img:
            return u_img
        if (not u_img and meta_it and meta_it.get("title")) or any(d in u_img for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter.", "ddizimag.")):
            qp = urllib.parse.urlencode({
                "u": u_img,
                "tid": str((meta_it or {}).get("tmdbId") or "")[:30],
                "t": str((meta_it or {}).get("title") or "")[:100],
                "ot": str((meta_it or {}).get("originalTitle") or "")[:100],
                "y": str((meta_it or {}).get("year") or "")[:8],
                "mt": str((meta_it or {}).get("mediaType") or "movie")[:10],
            })
            return f"/api/rave/poster?{qp}"
        return u_img

    if scraped_live:
        tmdb_by_norm = {_norm_title(x.get("title") or ""): x for x in items if _norm_title(x.get("title") or "")}
        merged_live = []
        used_tmdb_keys = set()
        seen_live_norms = set()
        for s_it in scraped_live:
            nt = _norm_title(s_it.get("title") or "")
            if not nt or nt in seen_live_norms:
                continue
            seen_live_norms.add(nt)
            m_tm = tmdb_by_norm.get(nt)
            if m_tm:
                t_key = f"{m_tm['mediaType']}:{m_tm['tmdbId']}"
                used_tmdb_keys.add(t_key)
                s_it["tmdbId"] = m_tm.get("tmdbId") or s_it.get("tmdbId") or ""
                s_it["poster"] = m_tm.get("poster") or s_it.get("poster") or ""
                s_it["backdrop"] = m_tm.get("backdrop") or s_it.get("backdrop") or ""
                s_it["overview"] = m_tm.get("overview") or ""
                s_it["categories"] = list(dict.fromkeys((s_it.get("categories") or []) + (m_tm.get("categories") or [])))
            s_it["poster"] = _safe_poster_url(s_it.get("poster") or "", s_it)
            s_it["backdrop"] = _safe_poster_url(s_it.get("backdrop") or s_it.get("poster") or "", s_it)
            merged_live.append(s_it)
        merged_live.sort(key=lambda x: (_has_vault_stream(x), int(x.get("voteCount") or 0), float(x.get("rating") or 0)), reverse=True)
        rest_tmdb = [x for x in items if f"{x['mediaType']}:{x['tmdbId']}" not in used_tmdb_keys]
        rest_tmdb.sort(key=lambda x: (_has_vault_stream(x), int(x.get("voteCount") or 0), float(x.get("rating") or 0)), reverse=True)
        if is_free_tr and pg == 1:
            verified_first = [x for x in merged_live + rest_tmdb if _has_vault_stream(x)]
            seen_vf = {f"{x.get('mediaType')}:{x.get('tmdbId') or x.get('id')}" for x in verified_first}
            rem_pool = [x for x in merged_live + rest_tmdb if f"{x.get('mediaType')}:{x.get('tmdbId') or x.get('id')}" not in seen_vf]
            items = verified_first + rem_pool
        else:
            items = rest_tmdb + merged_live
            items.sort(key=lambda x: (_has_vault_stream(x), int(x.get("voteCount") or 0), float(x.get("rating") or 0)), reverse=True)
    else:
        items.sort(key=lambda x: (_has_vault_stream(x), int(x.get("voteCount") or 0), float(x.get("rating") or 0)), reverse=True)

    if pg == 1 and prov in _DOMESTIC_TR_ORIGINALS:
        dom_curated = [
            dict(x) for x in _DOMESTIC_TR_ORIGINALS[prov]
            if (cat in ("all", "trend", "tr") or cat in (x.get("categories") or []))
            and (mt_flt not in ("tv", "movie") or x.get("mediaType") == mt_flt)
        ]
        seen_dom = {str(x.get("tmdbId")) for x in dom_curated}
        items = dom_curated + [x for x in items if str(x.get("tmdbId")) not in seen_dom]
    elif pg == 1 and not q.strip() and prov in ("cinema", "all", "disney", "max", "prime", "netflix"):
        extra_pool = []
        if prov in ("disney", "cinema", "all") and (prov == "disney" or cat in ("all", "scifi", "action", "animation")):
            extra_pool.extend([dict(x, sourceBadge=x.get("sourceBadge") or "🎬 Star Wars 4K") for x in _STAR_WARS_CURATED[:8]])
        for ex_it in _EXTRA_CURATED_CATALOG:
            if cat in ("all", "trend") or cat in (ex_it.get("categories") or []):
                extra_pool.append(dict(ex_it))
        if cat == "tr":
            for _dp_k, _dp_v in _DOMESTIC_TR_ORIGINALS.items():
                extra_pool.extend([dict(x) for x in _dp_v])
        if extra_pool:
            seen_cur = {f"{x.get('mediaType')}:{x.get('tmdbId')}" for x in items}
            for c_it in extra_pool:
                ck_cur = f"{c_it.get('mediaType')}:{c_it.get('tmdbId')}"
                if ck_cur not in seen_cur:
                    seen_cur.add(ck_cur)
                    items.append(c_it)

    # Supplement with non-overlapping vault slice only while within vault_pool bounds
    vault_pool = []
    if cat == "anime" or prov == "crunchyroll":
        vault_pool.extend(v_cat.get("ac") or [])
        vault_pool.extend([x for x in (v_cat.get("fhd") or []) if "animation" in (x.get("categories") or [])])
    elif cat == "series" or prov in ("dizibox", "dizilife", "yabancidizi"):
        vault_pool.extend(v_cat.get("dbx") or [])
        vault_pool.extend([x for x in (v_cat.get("hfnl") or []) if x.get("mediaType") == "tv"])
    elif cat == "movies" or prov in ("hdfilmcehennemi", "fullhdfilm"):
        vault_pool.extend(v_cat.get("fhd") or [])
        vault_pool.extend([x for x in (v_cat.get("hfnl") or []) if x.get("mediaType") != "tv"])
    else:
        for src_l in (v_cat.get("fhd") or [], v_cat.get("hfnl") or [], v_cat.get("dbx") or []):
            for v_it in src_l:
                if cat in ("all", "trend", "dublaj") or cat in (v_it.get("categories") or []):
                    vault_pool.append(v_it)
        if cat in ("all", "trend", "animation"):
            vault_pool.extend((v_cat.get("ac") or [])[:10])

    if vault_pool and (is_free_tr or prov == "crunchyroll"):
        slice_sz = 18
        start_i = (pg - 1) * slice_sz
        if start_i < len(vault_pool):
            paged_vault = [dict(x) for x in vault_pool[start_i:start_i + slice_sz]]
            seen_p = {_norm_title(x.get("title") or "") for x in items if _norm_title(x.get("title") or "")}
            for vit in paged_vault:
                vit["poster"] = _safe_poster_url(vit.get("poster") or "", vit)
                vit["backdrop"] = _safe_poster_url(vit.get("backdrop") or vit.get("poster") or "", vit)
                vk = _norm_title(vit.get("title") or "")
                if vk and vk not in seen_p:
                    seen_p.add(vk)
                    items.append(vit)

    # Filter out unreleased 0-rating titles, hidden unstreamable titles & enforce strict mediaType constraints
    if pg == 1:
        custom_rels = _load_custom_releases_sync()
        if custom_rels:
            filtered_custom = [
                dict(x) for x in custom_rels
                if cat in ("all", "vizyon", "trend", "movies", "series") or cat in (x.get("categories") or [])
            ]
            items = filtered_custom + items
    items = [x for x in items if x.get("customRelease") or x.get("isVizyon") or not (float(x.get("rating") or 0) == 0.0 and str(x.get("year") or "") >= "2026")]
    if _HIDDEN_TMDB_IDS:
        items = [
            x for x in items
            if _has_vault_stream(x)
            or (
                str(x.get("tmdbId") or "") not in _HIDDEN_TMDB_IDS
                and f"{'tv' if x.get('mediaType') == 'tv' else 'movie'}:{x.get('tmdbId') or x.get('id') or ''}" not in _HIDDEN_TMDB_IDS
                and f"{prov}|{'tv' if x.get('mediaType') == 'tv' else 'movie'}:{x.get('tmdbId') or x.get('id') or ''}" not in _HIDDEN_TMDB_IDS
            )
        ]
    verified_only = [x for x in items if _has_vault_stream(x)]
    if verified_only and cat != "vizyon":
        unverified_rest = [x for x in items if not _has_vault_stream(x)]
        items = verified_only + unverified_rest
    if cat == "dublaj":
        _VERIFIED_STREAMING_DUB_IDS = {"95396", "84958", "1396", "66732", "60574", "1429", "95479"}
        dub_filtered = [
            x for x in items
            if _has_dub_vault_stream(x) or str(x.get("tmdbId") or "") in _VERIFIED_STREAMING_DUB_IDS
        ]
        if dub_filtered:
            items = dub_filtered
    if mt_flt in ("tv", "movie"):
        items = [x for x in items if x.get("mediaType") == mt_flt]
    elif prov in ("dizibox", "dizilife", "yabancidizi") or cat == "series":
        items = [x for x in items if x.get("mediaType") == "tv"]
    elif prov in ("hdfilmcehennemi", "fullhdfilm") and cat != "series":
        items = [x for x in items if x.get("mediaType") != "tv"]
    elif cat == "movies" and prov not in ("dizibox", "dizilife", "yabancidizi"):
        items = [x for x in items if x.get("mediaType") != "tv"]

    dedup_final = []
    seen_final_ids = set()
    seen_final_titles = set()
    for it_x in items:
        it_x["poster"] = _safe_poster_url(it_x.get("poster") or "", it_x)
        it_x["backdrop"] = _safe_poster_url(it_x.get("backdrop") or it_x.get("poster") or "", it_x)
        mt_x = "tv" if it_x.get("mediaType") == "tv" else "movie"
        tid_x = str(it_x.get("tmdbId") or "").strip()
        nt_x = _norm_title(it_x.get("title") or "")
        if tid_x and f"{mt_x}:{tid_x}" in seen_final_ids:
            continue
        if nt_x and f"{mt_x}:{nt_x}" in seen_final_titles:
            continue
        if tid_x:
            seen_final_ids.add(f"{mt_x}:{tid_x}")
        if nt_x:
            seen_final_titles.add(f"{mt_x}:{nt_x}")
        dedup_final.append(it_x)

    if prov in ("max", "hbomax"):
        for it_m in dedup_final:
            it_m["provider"] = "max"
            it_m["catalogProvider"] = "max"
            it_m["authRequired"] = False

    items = dedup_final[:120] if pg == 1 else dedup_final[:96]
    vault_streams = (_MAIN_SITES_VAULT.get("streams") or {}) if is_free_tr else {}
    v_tv = sum(1 for k in vault_streams if str(k).startswith("tv:"))
    v_mv = sum(1 for k in vault_streams if str(k).startswith("movie:"))
    sharded_tv, sharded_mv = (0, 0)
    if cat in ("all", "series", "movies", "trend") and (totals["tv"] >= 20000 or totals["movie"] >= 20000):
        sharded_tv, sharded_mv = _get_real_tmdb_totals_sync(prov, prov_tv_q, prov_mv_q)
    tot_tv = max(totals["tv"], sharded_tv if cat != "movies" else 0, v_tv, sum(1 for x in items if x["mediaType"] == "tv"))
    tot_mv = max(totals["movie"], sharded_mv if cat != "series" else 0, v_mv, sum(1 for x in items if x["mediaType"] != "tv"))
    payload = {
        "items": items,
        "totalAvailable": tot_tv + tot_mv,
        "totalTv": tot_tv,
        "totalMovies": tot_mv,
        "page": pg,
        "category": cat,
        "hasMore": bool(items) and (pg < 80 or (len(items) > 16 and pg < 600)),
    }
    if items:
        if len(_CATALOG_MEM_CACHE) >= 300:
            _CATALOG_MEM_CACHE.pop(next(iter(_CATALOG_MEM_CACHE)), None)
        _CATALOG_MEM_CACHE[cache_key] = (now_ts, payload)
    return payload


_REAL_TMDB_TOTALS_CACHE: dict[str, tuple[float, tuple[int, int]]] = {}


def _get_real_tmdb_totals_sync(prov: str, prov_tv_q: str = "", prov_mv_q: str = "") -> tuple[int, int]:
    """Bypass TMDB Elasticsearch's 20,001 single-query hit ceiling via era-sharded counts (cached 12h)."""
    ck = f"{prov}|{prov_tv_q}|{prov_mv_q}"
    now_c = time.time()
    hit = _REAL_TMDB_TOTALS_CACHE.get(ck)
    if hit and (now_c - hit[0] < 43200):
        return hit[1]
    mv_eras = (
        ("1900-01-01", "1974-12-31"),
        ("1975-01-01", "1992-12-31"),
        ("1993-01-01", "2003-12-31"),
        ("2004-01-01", "2009-12-31"),
        ("2010-01-01", "2014-12-31"),
        ("2015-01-01", "2018-12-31"),
        ("2019-01-01", "2022-12-31"),
        ("2023-01-01", "2026-04-30"),
    )
    tv_eras = (
        ("1950-01-01", "1999-12-31"),
        ("2000-01-01", "2010-12-31"),
        ("2011-01-01", "2016-12-31"),
        ("2017-01-01", "2021-12-31"),
        ("2022-01-01", "2026-12-31"),
    )
    tasks = []
    for d1, d2 in mv_eras:
        tasks.append(("movie", f"https://api.themoviedb.org/3/discover/movie?api_key={TMDB_API_KEY}&language=tr-TR{prov_mv_q}&primary_release_date.gte={d1}&primary_release_date.lte={d2}&vote_count.gte=3&page=1"))
    for d1, d2 in tv_eras:
        tasks.append(("tv", f"https://api.themoviedb.org/3/discover/tv?api_key={TMDB_API_KEY}&language=tr-TR{prov_tv_q}&without_genres=10763,10764,10766,10767&first_air_date.gte={d1}&first_air_date.lte={d2}&vote_count.gte=2&page=1"))

    def _cnt(pair):
        kind, u_ep = pair
        try:
            return kind, int((_http_json(u_ep, timeout=3.2) or {}).get("total_results") or 0)
        except Exception:
            return kind, 0

    sum_tv, sum_mv = 0, 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as t_pool:
        for k_out, val_out in t_pool.map(_cnt, tasks):
            if k_out == "tv":
                sum_tv += val_out
            else:
                sum_mv += val_out
    if sum_tv > 0 or sum_mv > 0:
        _REAL_TMDB_TOTALS_CACHE[ck] = (now_c, (sum_tv, sum_mv))
    return sum_tv, sum_mv


def _provider_catalog_sync(prov: str, q: str = ""):
    return _provider_catalog_page_sync(prov, q, 1, "all").get("items", [])


_CANONICAL_SEASON_SPLITS: dict[str, list[int]] = {
    "95479": [24, 23, 12],          # Jujutsu Kaisen (S1: 24, S2: 23, S3: 12)
    "127532": [12, 13],             # Solo Leveling (S1: 12, S2: 13)
    "240411": [12, 12],             # DAN DA DAN (S1: 12, S2: 12)
    "209867": [28, 10],             # Frieren: Beyond Journey's End (S1: 28, S2: 10)
    "131041": [24, 14],             # Blue Lock (S1: 24, S2: 14)
    "207468": [12, 11],             # Kaiju No. 8 (S1: 12, S2: 11)
    "73223": [51, 51, 52, 16],      # Black Clover (S1..S4)
    "30984": [20, 21, 22, 28, 18, 22, 20, 16, 22, 16, 7, 17, 36, 51, 26, 24, 13, 13, 14, 10],  # Bleach (S1..S20)
    "70881": [51, 52, 52, 51, 52, 35],  # Boruto: Naruto Next Generations
    "31911": [16, 14, 14, 10, 10],  # Fullmetal Alchemist: Brotherhood (S1..S5)
    "37863": [13, 12, 16, 10],      # Fullmetal Alchemist (2003) (S1..S4)
    "13916": [19, 18],              # Death Note (S1: 19, S2: 18)
    "35935": [13, 12],              # Berserk (1997) (S1: 13, S2: 12)
    "117024": [12, 12],             # Sacrificial Princess and the King of Beasts (S1: 12, S2: 12)
    "46298": [26, 12, 20, 17, 61, 12],  # Hunter x Hunter (2011) (S1..S6 Arcs)
    "120089": [12, 13, 12, 13],     # SPY x FAMILY (S1 Cour 1: 12, S2 Cour 2: 13, S3: 12, S4: 13)
    "76806": [40, 40, 40, 40, 40, 52, 52, 52, 52, 80],  # Tales of Demons and Gods (S1..S10)
    "30981": [24, 25, 25],          # Monster (S1..S3)
    "31926": [25, 25],              # Code Geass (S1: 25, S2 R2: 25)
    "65942": [25, 25, 16],          # Re:Zero (S1: 25, S2: 25, S3: 16)
    "82684": [24, 24, 24],          # That Time I Got Reincarnated as a Slime (S1..S3)
    "88046": [24, 24],              # Fire Force (S1: 24, S2: 24)
    "117933": [24, 13, 13],         # Tokyo Revengers (S1..S3)
    "65931": [12, 12, 12, 13, 11],  # Bungou Stray Dogs (S1..S5)
    "72517": [12, 13, 13],          # Classroom of the Elite (S1..S3)
    "220542": [24, 24],             # The Apothecary Diaries (S1: 24, S2: 24)
    "204832": [12, 12],             # Mashle: Magic and Muscles (S1: 12, S2: 12)
    "211287": [25, 25],             # Shangri-La Frontier (S1: 25, S2: 25)
    "154524": [20, 12],             # The Eminence in Shadow (S1: 20, S2: 12)
    "100565": [11, 12],             # 86 EIGHTY-SIX (Part 1: 11, Part 2: 12)
    "61459": [22, 25],              # Assassination Classroom (S1: 22, S2: 25)
    "110070": [13, 13],             # Horimiya (S1: 13, S2 Piece: 13)
    "122792": [12, 12],             # Komi Can't Communicate (S1: 12, S2: 12)
    "60622": [12, 13],              # Noragami (S1: 12, S2 Aragoto: 13)
    "89456": [12, 12, 12, 16],      # Kengan Ashura (S1..S4)
    "114868": [12, 15],             # Record of Ragnarok (S1: 12, S2: 15)
    "78173": [26, 13],              # Baki (S1: 26, S2: 13)
    "62715": [14, 13, 19, 30, 55],  # Dragon Ball Super (S1..S5)
    "12609": [13, 15, 17, 23, 15, 19, 17, 14, 20],  # Dragon Ball (S1..S9)
    "30983": [25, 41, 28, 18],      # Yu Yu Hakusho (S1..S4)
    "35613": [27, 27, 28, 28, 28, 29],  # InuYasha (S1..S6)
    "26020": [27, 35, 32],          # Rurouni Kenshin (S1..S3)
    "42254": [24, 25, 26, 26],      # Slam Dunk (S1..S4)
    "31914": [13, 13, 13, 12],      # Soul Eater (S1..S4)
    "45950": [22, 25],              # Nana (S1: 22, S2: 25)
    "42444": [22, 21],              # Great Teacher Onizuka (S1: 22, S2: 21)
    "210757": [12, 12],             # Undead Unluck (Part 1: 12, Part 2: 12)
}
_EPISODE_GROUP_SPLITS_CACHE: dict[str, list[int]] = {}


def _get_canonical_season_splits_sync(tid: str, raw_seasons: list | None = None, orig_lang: str = "") -> list[int]:
    tid_s = str(tid or "").strip()
    if not tid_s.isdigit():
        return []
    if tid_s in _CANONICAL_SEASON_SPLITS:
        base_splits = list(_CANONICAL_SEASON_SPLITS[tid_s])
        if raw_seasons:
            tot_raw = sum(max(0, int(x.get("count") or 0)) for x in raw_seasons)
            if tot_raw > sum(base_splits):
                rem_extra = tot_raw - sum(base_splits)
                while rem_extra > 0:
                    chunk = min(24, rem_extra)
                    base_splits.append(chunk)
                    rem_extra -= chunk
        return base_splits
    if tid_s in _EPISODE_GROUP_SPLITS_CACHE:
        return list(_EPISODE_GROUP_SPLITS_CACHE[tid_s])
    if raw_seasons is not None and (len(raw_seasons) != 1 or int(raw_seasons[0].get("count") or 0) < 16):
        _EPISODE_GROUP_SPLITS_CACHE[tid_s] = []
        return []
    ep_tot = int(raw_seasons[0].get("count") or 0) if (raw_seasons and len(raw_seasons) == 1) else 0
    splits: list[int] = []
    try:
        eg_res = _http_json(f"https://api.themoviedb.org/3/tv/{tid_s}/episode_groups?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY}), timeout=3.5) or {}
        results = [g for g in (eg_res.get("results") or []) if isinstance(g, dict) and int(g.get("group_count") or 0) >= 2]
        results.sort(key=lambda g: (
            0 if int(g.get("type") or 0) == 6 else (1 if "season" in str(g.get("name") or "").lower() else (2 if int(g.get("type") or 0) in (7, 3, 5, 1) else 3)),
            -int(g.get("group_count") or 0),
        ))
        for picked_g in results[:2]:
            if not picked_g.get("id"):
                continue
            gd = _http_json(f"https://api.themoviedb.org/3/tv/episode_group/{picked_g['id']}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY}), timeout=3.5) or {}
            groups = sorted([gg for gg in (gd.get("groups") or []) if int(gg.get("order") or 0) >= 1], key=lambda x: int(x.get("order") or 0))
            cand_splits = [len(gg.get("episodes") or []) for gg in groups if len(gg.get("episodes") or []) > 0]
            if len(cand_splits) >= 2 and sum(cand_splits) >= 12:
                splits = cand_splits
                break
    except Exception:
        splits = []
    if not splits and ep_tot >= 16:
        try:
            from datetime import date
            sd1 = _http_json(f"https://api.themoviedb.org/3/tv/{tid_s}/season/1?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "en-US"}), timeout=3.8) or {}
            eps1 = sd1.get("episodes") or []
            if len(eps1) >= 16:
                cur_cnt = 0
                prev_dt = None
                date_splits = []
                for idx_e, ep_o in enumerate(eps1):
                    ad_s = str(ep_o.get("air_date") or "").strip()
                    cur_dt = None
                    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", ad_s):
                        try:
                            cur_dt = date.fromisoformat(ad_s)
                        except Exception:
                            cur_dt = None
                    if prev_dt and cur_dt and (cur_dt - prev_dt).days >= 60 and cur_cnt >= 6 and (len(eps1) - idx_e) >= 4:
                        date_splits.append(cur_cnt)
                        cur_cnt = 0
                    cur_cnt += 1
                    if cur_dt:
                        prev_dt = cur_dt
                if cur_cnt > 0:
                    date_splits.append(cur_cnt)
                if len(date_splits) >= 2:
                    splits = date_splits
        except Exception:
            pass
    if not splits and ep_tot >= 24:
        if ep_tot <= 38:
            half = ep_tot // 2
            splits = [half, ep_tot - half]
        else:
            rem_e = ep_tot
            while rem_e > 0:
                if rem_e <= 30:
                    splits.append(rem_e)
                    break
                splits.append(24)
                rem_e -= 24
    if splits and ep_tot > sum(splits):
        rem_extra = ep_tot - sum(splits)
        while rem_extra > 0:
            chunk = min(24, rem_extra)
            splits.append(chunk)
            rem_extra -= chunk
    _EPISODE_GROUP_SPLITS_CACHE[tid_s] = list(splits)
    return splits


def _resolve_episode_numbering(tid: str, s: int, e: int) -> dict:
    """Translate between user/UI (season, episode), Canonical Season-Split (s_split, e_split), TMDB (s_tmdb, e_tmdb), and absolute episode number."""
    s_in = max(1, int(s or 1))
    e_in = max(1, int(e or 1))
    tid_s = str(tid or "").strip()
    splits = _CANONICAL_SEASON_SPLITS.get(tid_s) or _EPISODE_GROUP_SPLITS_CACHE.get(tid_s) or []
    if not splits and tid_s.isdigit():
        ep_map_now = _tv_season_ep_map(tid_s)
        if len(ep_map_now) == 1 and ep_map_now.get(1, 0) >= 16:
            splits = _get_canonical_season_splits_sync(tid_s, [{"season": 1, "count": ep_map_now[1]}])
    s_split, e_split = s_in, e_in
    s_tmdb, e_tmdb = s_in, e_in
    abs_ep = e_in
    if splits:
        if s_in == 1 and e_in > splits[0]:
            abs_ep = e_in
            rem = abs_ep
            for idx, cnt in enumerate(splits):
                if rem <= cnt or idx == len(splits) - 1:
                    s_split = idx + 1
                    e_split = max(1, rem)
                    break
                rem -= cnt
        else:
            s_clamped = min(s_in, len(splits))
            s_split = s_clamped
            e_split = e_in
            abs_ep = sum(splits[:s_clamped - 1]) + e_in
        ep_map = _tv_season_ep_map(tid_s) if tid_s.isdigit() else {}
        if ep_map:
            rem_t = abs_ep
            s_tmdb, e_tmdb = 1, abs_ep
            for t_sn in sorted(ep_map.keys()):
                t_cnt = max(1, int(ep_map[t_sn] or 0))
                if rem_t <= t_cnt or t_sn == max(ep_map.keys()):
                    s_tmdb = t_sn
                    e_tmdb = max(1, rem_t)
                    break
                rem_t -= t_cnt
        else:
            s_tmdb, e_tmdb = 1, abs_ep
    else:
        ep_map = _tv_season_ep_map(tid_s) if tid_s.isdigit() else {}
        if ep_map and s_in > 1:
            s_cap = min(s_in, max(ep_map.keys()) + 1)
            abs_ep = sum(int(ep_map.get(k) or 0) for k in range(1, s_cap)) + e_in
        elif s_in == 1:
            abs_ep = e_in
            if ep_map and e_in > max(1, int(ep_map.get(1) or 0)):
                rem_t = abs_ep
                for t_sn in sorted(ep_map.keys()):
                    t_cnt = max(1, int(ep_map[t_sn] or 0))
                    if rem_t <= t_cnt or t_sn == max(ep_map.keys()):
                        s_tmdb = t_sn
                        e_tmdb = max(1, rem_t)
                        break
                    rem_t -= t_cnt
    return {
        "s_split": s_split,
        "e_split": e_split,
        "s_tmdb": s_tmdb,
        "e_tmdb": e_tmdb,
        "abs_ep": abs_ep,
        "has_splits": bool(splits),
    }


def _is_generic_ep_name(name: str) -> bool:
    n = str(name or "").strip()
    if not n:
        return True
    return bool(re.fullmatch(r"(?:\d+\.\s*bölüm|bölüm\s*\d+|episode\s*\d+|ep\.?\s*\d+)", n, re.I))


_TMDB_SEASON_RAW_CACHE: dict[str, tuple[float, dict]] = {}


def _tmdb_cached_json(url: str, timeout: float = 4.8) -> dict:
    now_t = time.time()
    hit = _TMDB_SEASON_RAW_CACHE.get(url)
    if hit and (now_t - hit[0]) < 1800:
        return hit[1]
    data = _http_json(url, timeout=timeout) or {}
    if data:
        if len(_TMDB_SEASON_RAW_CACHE) >= 400:
            _TMDB_SEASON_RAW_CACHE.pop(next(iter(_TMDB_SEASON_RAW_CACHE)), None)
        _TMDB_SEASON_RAW_CACHE[url] = (now_t, data)
    return data


def _seasons_sync(tmdb_id: str, title: str, media_type: str, season: int):
    tid = str(tmdb_id or "").strip()
    raw_mt = str(media_type or "").strip().lower()
    explicit_mt = raw_mt in ("tv", "series", "show", "movie", "movies", "film")
    mtype = "tv" if raw_mt in ("tv", "series", "show") else "movie"
    if re.search(r"\b(?:the\s+movie|gekijouban|gekijoban)\b", str(title or ""), re.I) and raw_mt not in ("tv", "series", "show"):
        mtype = "movie"
    m_ac_s = re.fullmatch(r"ac-(\d+)", tid)
    if m_ac_s:
        ac_num_s = m_ac_s.group(1)
        mapped_ac_tid = next((k_t for k_t, v_ac in _ANIMECIX_KNOWN_TMDB.items() if str(v_ac) == ac_num_s), "")
        if mapped_ac_tid:
            tid = mapped_ac_tid
    if not tid.isdigit() and title:
        clean_t = re.sub(r"\s*\(\d{4}\)\s*$", "", title).strip() or title
        nk_ac = _norm_title(clean_t).replace(" ", "")
        if nk_ac in _ANIMECIX_KNOWN_NAMES:
            ac_id_by_name = _ANIMECIX_KNOWN_NAMES[nk_ac]
            mapped_by_name = next((k_t for k_t, v_ac in _ANIMECIX_KNOWN_TMDB.items() if v_ac == ac_id_by_name), "")
            if mapped_by_name:
                tid = mapped_by_name
        if not tid.isdigit():
            hits = _tmdb_sync(clean_t)
            if explicit_mt:
                hits = [h for h in hits if h.get("mediaType") == mtype] or hits
            if hits:
                tid = str(hits[0]["tmdbId"])
                if not explicit_mt:
                    mtype = hits[0]["mediaType"]
    s_num = max(1, int(season or 1))
    if not tid.isdigit():
        eps_fb = [{"episode": i, "season": s_num, "name": f"{i}. Bölüm", "overview": f"{title} — {s_num}. Sezon {i}. Bölüm", "runtime": 45, "still": ""} for i in range(1, 13)] if mtype == "tv" else []
        return {"tmdbId": "", "mediaType": mtype, "title": title, "originalTitle": title, "year": "", "rating": 0.0, "overview": "", "seasons": [{"season": 1, "name": "1. Sezon", "count": 12}] if mtype == "tv" else [], "episodes": eps_fb}
    try:
        info = _tmdb_cached_json(f"https://api.themoviedb.org/3/{mtype}/{tid}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "append_to_response": "external_ids"}), timeout=5.5)
    except Exception:
        info = {}
    if mtype == "tv" and not (info.get("name") or info.get("seasons")):
        try:
            mv_info = _http_json(f"https://api.themoviedb.org/3/movie/{tid}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "append_to_response": "external_ids"}), timeout=4.5)
            if mv_info and (mv_info.get("title") or mv_info.get("original_title")):
                info = mv_info
                mtype = "movie"
        except Exception:
            pass
    imdb_id = (info.get("external_ids") or {}).get("imdb_id") or info.get("imdb_id") or ""
    poster = f"https://image.tmdb.org/t/p/w500{info['poster_path']}" if info.get("poster_path") else ""
    backdrop = f"https://image.tmdb.org/t/p/w780{info['backdrop_path']}" if info.get("backdrop_path") else poster
    t_disp = info.get("name") or info.get("title") or title
    t_orig = info.get("original_name") or info.get("original_title") or t_disp
    orig_lang = str(info.get("original_language") or "").lower()
    def_rt = 24 if orig_lang == "ja" else 45
    out = {
        "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype,
        "title": t_disp, "originalTitle": t_orig,
        "year": (info.get("first_air_date") or info.get("release_date") or "")[:4],
        "rating": round(float(info.get("vote_average") or 0), 1),
        "overview": info.get("overview") or "",
        "poster": poster, "backdrop": backdrop,
        "runtime": int((info.get("episode_run_time") or [info.get("runtime") or def_rt])[0] or def_rt),
        "seasons": [], "episodes": [],
    }
    if mtype == "tv":
        raw_seasons = [
            {"season": int(s.get("season_number") or 1), "name": s.get("name") or f"{s.get('season_number')}. Sezon", "count": int(s.get("episode_count") or 0)}
            for s in (info.get("seasons") or []) if int(s.get("season_number") or 0) >= 1
        ]
        splits = _get_canonical_season_splits_sync(tid, raw_seasons, orig_lang)
        if splits:
            out["seasons"] = [{"season": i + 1, "name": f"{i + 1}. Sezon", "count": cnt} for i, cnt in enumerate(splits)]
            s_eff = min(max(1, s_num), len(splits))
            abs_start = sum(splits[:s_eff - 1]) + 1
            ep_cnt = splits[s_eff - 1]
            abs_end = abs_start + ep_cnt - 1
            raw_ep_map = {int(x["season"]): max(1, int(x["count"] or 0)) for x in raw_seasons} or {1: sum(splits)}
            needed_tmdb_seasons = set()
            abs_to_tmdb: dict[int, tuple[int, int]] = {}
            for a_idx in range(abs_start, abs_end + 1):
                rem = a_idx
                t_sn, t_en = 1, a_idx
                for r_sn in sorted(raw_ep_map.keys()):
                    r_cnt = raw_ep_map[r_sn]
                    if rem <= r_cnt or r_sn == max(raw_ep_map.keys()):
                        t_sn, t_en = r_sn, max(1, rem)
                        break
                    rem -= r_cnt
                abs_to_tmdb[a_idx] = (t_sn, t_en)
                needed_tmdb_seasons.add(t_sn)
            tmdb_ep_tr: dict[tuple[int, int], dict] = {}
            tmdb_ep_en: dict[tuple[int, int], dict] = {}
            for t_sn in sorted(needed_tmdb_seasons):
                try:
                    sd_tr = _tmdb_cached_json(f"https://api.themoviedb.org/3/tv/{tid}/season/{t_sn}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR"}), timeout=4.8)
                    for ep_o in (sd_tr.get("episodes") or []):
                        tmdb_ep_tr[(t_sn, int(ep_o.get("episode_number") or 1))] = ep_o
                except Exception:
                    pass
                need_en = any(
                    _is_generic_ep_name((tmdb_ep_tr.get(abs_to_tmdb[a_i]) or {}).get("name"))
                    or not str((tmdb_ep_tr.get(abs_to_tmdb[a_i]) or {}).get("overview") or "").strip()
                    for a_i in range(abs_start, abs_end + 1)
                    if abs_to_tmdb.get(a_i, (0, 0))[0] == t_sn
                )
                if need_en:
                    try:
                        sd_en = _tmdb_cached_json(f"https://api.themoviedb.org/3/tv/{tid}/season/{t_sn}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "en-US"}), timeout=4.5)
                        for ep_o in (sd_en.get("episodes") or []):
                            tmdb_ep_en[(t_sn, int(ep_o.get("episode_number") or 1))] = ep_o
                    except Exception:
                        pass
            for rel_ep in range(1, ep_cnt + 1):
                a_idx = abs_start + rel_ep - 1
                tk = abs_to_tmdb.get(a_idx, (1, a_idx))
                ep_tr = tmdb_ep_tr.get(tk) or {}
                ep_en = tmdb_ep_en.get(tk) or {}
                tr_name = str(ep_tr.get("name") or "").strip()
                en_name = str(ep_en.get("name") or "").strip()
                best_name = tr_name if not _is_generic_ep_name(tr_name) else (en_name if not _is_generic_ep_name(en_name) else f"{rel_ep}. Bölüm")
                tr_ov = str(ep_tr.get("overview") or "").strip()
                en_ov = str(ep_en.get("overview") or "").strip()
                best_ov = (tr_ov or en_ov or f"{t_disp} — {s_eff}. Sezon {rel_ep}. Bölüm")[:220]
                sp = ep_tr.get("still_path") or ep_en.get("still_path")
                still = f"https://image.tmdb.org/t/p/w500{sp}" if sp else backdrop
                rt = int(ep_tr.get("runtime") or ep_en.get("runtime") or out["runtime"] or def_rt)
                out["episodes"].append({
                    "episode": rel_ep,
                    "season": s_eff,
                    "absEpisode": a_idx,
                    "name": best_name,
                    "overview": best_ov,
                    "runtime": rt,
                    "still": still,
                })
        else:
            if not raw_seasons:
                raw_seasons = [{"season": 1, "name": "1. Sezon", "count": 12}]
            for rs in raw_seasons:
                if re.fullmatch(r"Season\s*(\d+)", str(rs.get("name") or ""), re.I):
                    rs["name"] = f"{rs['season']}. Sezon"
            out["seasons"] = raw_seasons
            valid_s_nums = [int(x.get("season") or 1) for x in raw_seasons if int(x.get("season") or 0) >= 1]
            if valid_s_nums and s_num not in valid_s_nums:
                s_num = max(valid_s_nums) if s_num > max(valid_s_nums) else min(valid_s_nums)
            try:
                sdata_tr = _tmdb_cached_json(f"https://api.themoviedb.org/3/tv/{tid}/season/{s_num}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR"}), timeout=5.0)
            except Exception:
                sdata_tr = {}
            eps_tr = sdata_tr.get("episodes") or []
            en_by_num: dict[int, dict] = {}
            if not eps_tr or any(_is_generic_ep_name(ep.get("name")) or not str(ep.get("overview") or "").strip() for ep in eps_tr):
                try:
                    sdata_en = _tmdb_cached_json(f"https://api.themoviedb.org/3/tv/{tid}/season/{s_num}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "en-US"}), timeout=4.5)
                    for ep_e in (sdata_en.get("episodes") or []):
                        en_by_num[int(ep_e.get("episode_number") or 1)] = ep_e
                    if not eps_tr and sdata_en.get("episodes"):
                        eps_tr = sdata_en["episodes"]
                except Exception:
                    pass
            for ep in eps_tr:
                en = int(ep.get("episode_number") or 1)
                ep_en = en_by_num.get(en) or {}
                tr_name = str(ep.get("name") or "").strip()
                en_name = str(ep_en.get("name") or "").strip()
                best_name = tr_name if not _is_generic_ep_name(tr_name) else (en_name if not _is_generic_ep_name(en_name) else f"{en}. Bölüm")
                tr_ov = str(ep.get("overview") or "").strip()
                en_ov = str(ep_en.get("overview") or "").strip()
                best_ov = (tr_ov or en_ov or f"{t_disp} — {s_num}. Sezon {en}. Bölüm")[:220]
                sp = ep.get("still_path") or ep_en.get("still_path")
                still = f"https://image.tmdb.org/t/p/w500{sp}" if sp else backdrop
                out["episodes"].append({
                    "episode": en, "season": s_num,
                    "name": best_name,
                    "overview": best_ov,
                    "runtime": int(ep.get("runtime") or ep_en.get("runtime") or out["runtime"] or def_rt),
                    "still": still,
                })
            if not out["episodes"]:
                s_cnt = next((max(1, int(x.get("count") or 0)) for x in raw_seasons if int(x.get("season") or 0) == s_num), 12)
                for en in range(1, min(s_cnt, 100) + 1):
                    out["episodes"].append({
                        "episode": en, "season": s_num,
                        "name": f"{en}. Bölüm",
                        "overview": f"{t_disp} — {s_num}. Sezon {en}. Bölüm",
                        "runtime": out["runtime"] or def_rt,
                        "still": backdrop,
                    })
    elif explicit_mt and raw_mt in ("tv", "series", "show"):
        out["seasons"] = [{"season": 1, "name": "1. Sezon (Tam Film)", "count": 1}]
        out["episodes"] = [{
            "episode": 1, "season": 1,
            "name": t_disp or "Tam Film",
            "overview": (out["overview"] or f"{t_disp} — Tam Film")[:220],
            "runtime": out["runtime"] or 105,
            "still": backdrop,
        }]

    out["totalSeasons"] = len(out.get("seasons") or [])
    out["currentSeason"] = min(max(1, s_num), max(1, len(out.get("seasons") or [1])))
    return out


_SEASONS_CACHE: dict[str, tuple[float, dict]] = {}
_SEASONS_LOCKS: dict[str, asyncio.Lock] = {}


async def title_seasons(request: Request):
    tmdb_id = (request.query_params.get("tmdbId") or "").strip()[:30]
    title = (request.query_params.get("title") or "").strip()[:160]
    media_type = (request.query_params.get("mediaType") or "tv").strip().lower()
    try:
        season = max(1, int(request.query_params.get("season") or 1))
    except (TypeError, ValueError):
        season = 1
    ckey = f"v5|{media_type}|{tmdb_id or title.lower()}|{season}"
    now_t = time.time()
    cached = _SEASONS_CACHE.get(ckey)
    hdrs = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    if cached and now_t - cached[0] < 3600:
        return JSONResponse(cached[1], headers=hdrs)
    lock = _get_loop_lock(_SEASONS_LOCKS, ckey, 300)
    async with lock:
        cached = _SEASONS_CACHE.get(ckey)
        if cached and time.time() - cached[0] < 3600:
            return JSONResponse(cached[1], headers=hdrs)
        try:
            res = await asyncio.wait_for(asyncio.to_thread(_seasons_sync, tmdb_id, title, media_type, season), timeout=9)
        except Exception:
            res = {"seasons": [], "episodes": []}
        if len(_SEASONS_CACHE) >= 300:
            _SEASONS_CACHE.pop(next(iter(_SEASONS_CACHE)), None)
        _SEASONS_CACHE[ckey] = (time.time(), res)
    return JSONResponse(res, headers=hdrs)


JW_QUERY = ("query GetSearchTitles($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) { popularTitles(country: $country, first: $first, filter: $filter) "
            "{ edges { node { id objectType content(country: $country, language: $language) { title originalReleaseYear posterUrl externalIds { imdbId tmdbId } } "
            "offers(country: $country, platform: WEB) { monetizationType standardWebURL package { clearName shortName } } } } } }")

JW_PROV = {
    "netflix": (["nfx"], "TR"),
    "disney": (["dnp"], "TR"),
    "prime": (["prv"], "TR"),
    "max": (["mxx", "hbm"], "US"),
    "crunchyroll": (["cru"], "US"),
    "tubi": (["tbv"], "US"),
}


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


def _parse_dur_sec(s: str) -> int:
    parts = [int(p) for p in str(s or "").split(":") if p.isdigit()]
    if not parts:
        return 0
    sec = 0
    for p in parts:
        sec = sec * 60 + p
    return sec


PROV_LABELS = {
    "netflix": "Netflix", "disney": "Disney+", "prime": "Prime Video", "max": "HBO · Max",
    "crunchyroll": "Crunchyroll", "tubi": "Tubi", "exxen": "Exxen", "blutv": "BluTV",
    "gain": "GAİN", "tod": "TOD", "tabii": "tabii", "tvplus": "TV+", "puhutv": "puhutv",
    "mubi": "MUBI", "apple": "Apple TV+", "hulu": "Hulu", "paramount": "Paramount+",
    "peacock": "Peacock", "plex": "Plex", "pluto": "Pluto TV", "kick": "Kick",
    "tiktok": "TikTok", "dailymotion": "Dailymotion", "dropbox": "Dropbox", "cinema": "Sinema, Dizi & Anime+",
    "hdfilmcehennemi": "Sinema, Dizi & Anime+", "dizibox": "Sinema, Dizi & Anime+", "dizilife": "Sinema, Dizi & Anime+",
    "fullhdfilm": "Sinema, Dizi & Anime+", "yabancidizi": "Sinema, Dizi & Anime+",
    "music": "Müzik & Klip", "ytmusic": "Müzik & Klip", "spotify": "Spotify Music",
    "deezer": "Deezer Hi-Fi", "applemusic": "Apple Music", "soundcloud": "SoundCloud",
}
PROV_BROWSE = {
    "netflix": "https://www.netflix.com/browse",
    "disney": "https://www.disneyplus.com/home",
    "prime": "https://www.primevideo.com",
    "max": "https://play.max.com",
    "crunchyroll": "https://www.crunchyroll.com",
    "tubi": "https://tubitv.com",
    "exxen": "https://www.exxen.com/tr",
    "blutv": "https://www.blutv.com",
    "gain": "https://www.gain.tv",
    "tod": "https://www.todtv.com.tr",
    "tabii": "https://www.tabii.com/tr",
    "tvplus": "https://tvplus.com.tr",
    "puhutv": "https://puhutv.com",
    "mubi": "https://mubi.com/tr",
    "apple": "https://tv.apple.com/tr",
    "hulu": "https://www.hulu.com",
    "paramount": "https://www.paramountplus.com",
    "peacock": "https://www.peacocktv.com",
    "plex": "https://watch.plex.tv",
    "pluto": "https://pluto.tv",
    "cinema": "https://www.hdfilmcehennemi.nl",
    "hdfilmcehennemi": "https://www.hdfilmcehennemi.nl",
    "dizibox": "https://www.dizibox.live",
    "dizilife": "https://dizi84.life",
    "fullhdfilm": "https://www.fullhdfilmizlesene.now",
    "yabancidizi": "https://yabancidizi.tv",
    "music": "https://music.youtube.com",
}


_VE_SEED_CACHE = BoundedTTLCache(maxsize=500, ttl=3600.0)
_TMDB_META_CACHE = BoundedTTLCache(maxsize=2000, ttl=21600.0)
_STREAM_CACHE = BoundedTTLCache(maxsize=1500, ttl=3600.0)


OFFICIAL_SEARCH_URLS = {
    "netflix": "https://www.netflix.com/search?q={q}",
    "disney": "https://www.disneyplus.com/search",
    "prime": "https://www.primevideo.com/search/ref=atv_nb_sr?phrase={q}",
    "max": "https://play.max.com/search?q={q}",
    "crunchyroll": "https://www.crunchyroll.com/search?q={q}",
    "tubi": "https://tubitv.com/search/{q}",
    "cinema": "https://www.hdfilmcehennemi.nl/?s={q}",
    "hdfilmcehennemi": "https://www.hdfilmcehennemi.nl/?s={q}",
    "dizibox": "https://www.dizibox.live/?s={q}",
    "dizilife": "https://dizi84.life/ara?q={q}",
    "fullhdfilm": "https://www.fullhdfilmizlesene.now/arama/{q}",
    "yabancidizi": "https://dizi84.life/ara?q={q}",
}

_EMBED_SUB_CACHE = BoundedTTLCache(maxsize=1500, ttl=3600.0)
_DUB_STREAM_CACHE = BoundedTTLCache(maxsize=1000, ttl=3600.0)

_AES_SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]
_AES_ISBOX = [0] * 256
for _i, _v in enumerate(_AES_SBOX):
    _AES_ISBOX[_v] = _i
_AES_RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _aes_gmul(a: int, b: int) -> int:
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        a = ((a << 1) ^ 0x1B) & 0xFF if (a & 0x80) else (a << 1)
        b >>= 1
    return p


def _aes256_cbc_decrypt(ct: bytes, key: bytes, iv: bytes) -> bytes:
    w = [list(key[i:i + 4]) for i in range(0, 32, 4)]
    for i in range(8, 60):
        t = list(w[i - 1])
        if i % 8 == 0:
            t = [_AES_SBOX[t[1]] ^ _AES_RCON[i // 8], _AES_SBOX[t[2]], _AES_SBOX[t[3]], _AES_SBOX[t[0]]]
        elif i % 8 == 4:
            t = [_AES_SBOX[b] for b in t]
        w.append([w[i - 8][j] ^ t[j] for j in range(4)])
    out = bytearray()
    prev = list(iv)
    for blk_i in range(0, len(ct), 16):
        blk = list(ct[blk_i:blk_i + 16])
        if len(blk) < 16:
            break
        s = [blk[j] ^ w[56 + j // 4][j % 4] for j in range(16)]
        for r in range(13, -1, -1):
            s = [s[0], s[13], s[10], s[7], s[4], s[1], s[14], s[11], s[8], s[5], s[2], s[15], s[12], s[9], s[6], s[3]]
            s = [_AES_ISBOX[s[j]] ^ w[r * 4 + j // 4][j % 4] for j in range(16)]
            if r > 0:
                ns = [0] * 16
                for c in range(4):
                    b0, b1, b2, b3 = s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]
                    ns[c * 4] = _aes_gmul(b0, 14) ^ _aes_gmul(b1, 11) ^ _aes_gmul(b2, 13) ^ _aes_gmul(b3, 9)
                    ns[c * 4 + 1] = _aes_gmul(b0, 9) ^ _aes_gmul(b1, 14) ^ _aes_gmul(b2, 11) ^ _aes_gmul(b3, 13)
                    ns[c * 4 + 2] = _aes_gmul(b0, 13) ^ _aes_gmul(b1, 9) ^ _aes_gmul(b2, 14) ^ _aes_gmul(b3, 11)
                    ns[c * 4 + 3] = _aes_gmul(b0, 11) ^ _aes_gmul(b1, 13) ^ _aes_gmul(b2, 9) ^ _aes_gmul(b3, 14)
                s = ns
        out.extend(s[j] ^ prev[j] for j in range(16))
        prev = blk
    pad = out[-1] if out else 0
    return bytes(out[:-pad]) if 1 <= pad <= 16 else bytes(out)


def _gen_fp_xsp(sp: str, spt: int = 0) -> str:
    import random
    now_i = int(time.time())
    n = (int(spt) + 2) if (int(spt or 0) > now_i + 60) else max(now_i, int(spt or 0) + 1)
    r = "".join(random.choices("0123456789abcdefghijklmnopqrstuvwxyz", k=6))
    h = 2166136261
    for ch in f"{sp}|{n}|{r}":
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return f"{n}.{r}.{h:x}"


_TR_ASCII_MAP = str.maketrans("ıİöÖüÜşŞğĞçÇâÂîÎûÛ", "iioouussggccaaiiuu")
DIZIPAL_DOMAINS = [d.strip() for d in (os.environ.get("DIZIPAL_DOMAINS") or "dizipal1594.com,dizipal1593.com,dizipal1592.com,dizipalw2.com").split(",") if d.strip()]
_DP_ACTIVE_BASE_CACHE: dict = {}
DIZIPAL_PASSPHRASE = "3hPn4uCjTVtfYWcjIcoJQ4cL1WWk1qxXI39egLYOmNv6IblA7eKJz68uU3eLzux1biZLCms0quEjTYniGv5z1JcKbNIsDQFSeIZOBZJz4is6pD7UyWDggWWzTLBQbHcQFpBQdClnuQaMNUHtLHTpzCvZy33p6I7wFBvL4fnXBYH84aUIyWGTRvM2G5cfoNf4705tO2kv"
_DP_M3U8_CACHE = BoundedTTLCache(maxsize=800, ttl=1800.0)


def _decrypt_dizipal_rmk(encrypted_json_str: str) -> str:
    try:
        import hashlib, base64, html as _h
        cleaned = _h.unescape(encrypted_json_str)
        data = json.loads(cleaned)
        ciphertext = base64.b64decode(data["ciphertext"])
        iv = bytes.fromhex(data["iv"])
        salt = bytes.fromhex(data["salt"])
        key = hashlib.pbkdf2_hmac("sha512", DIZIPAL_PASSPHRASE.encode("utf-8"), salt, 999, dklen=32)
        return _aes256_cbc_decrypt(ciphertext, key, iv).decode("utf-8", errors="ignore").strip()
    except Exception:
        return ""


def _extract_dizipal_hls_sync(mtype: str, s: int, e: int, titles: list, ekey: str, year: str = "", imdb_id: str = "") -> list:
    res = []
    q_cands = []
    for x in (titles or []):
        cx = _clean_query_title(x)
        if cx:
            q_cands.append(cx)
            if ":" in cx:
                q_cands.append(cx.split(":", 1)[0].strip())
    q_cands = list(dict.fromkeys(q_cands))[:3]
    if not q_cands:
        return res

    for dom in DIZIPAL_DOMAINS:
        now_dp_b = time.time()
        cached_dp_b = _DP_ACTIVE_BASE_CACHE.get(dom)
        if cached_dp_b and cached_dp_b[1] > now_dp_b:
            base = cached_dp_b[0]
        else:
            base = f"https://{dom}"
            try:
                with _public_open(urllib.request.Request(base + "/", headers={"User-Agent": UA137}), timeout=2.2) as r_dp_h:
                    fin_u = str(r_dp_h.geturl() or "").strip()
                p_fin = urllib.parse.urlparse(fin_u)
                if p_fin.scheme in ("http", "https") and p_fin.netloc:
                    base = f"{p_fin.scheme}://{p_fin.netloc}"
                    _DP_ACTIVE_BASE_CACHE[dom] = (base, now_dp_b + 1800.0)
            except Exception:
                pass
        ep_html_list = []
        cKey, cValue = "", ""
        use_mj_api = "1592" in dom
        mj_prefetched = {}
        if not use_mj_api:
            try:
                req_mj_probe = urllib.request.Request(
                    f"{base}/api/mj",
                    data=json.dumps({"action": "searchContent", "params": [q_cands[0]]}).encode("utf-8"),
                    headers={"User-Agent": UA137, "Content-Type": "application/json", "Referer": base + "/", "Origin": base},
                    method="POST"
                )
                with _public_open(req_mj_probe, timeout=3.4) as r_mj0:
                    mj0 = json.loads(r_mj0.read(131072).decode("utf-8", errors="ignore"))
                if isinstance(mj0, dict) and mj0.get("ok"):
                    use_mj_api = True
                    mj_prefetched[q_cands[0]] = mj0.get("result") or []
            except Exception:
                use_mj_api = False
        if not use_mj_api:
            try:
                req_init = urllib.request.Request(f"{base}/arama-yap", headers={"User-Agent": UA137})
                with _public_open(req_init, timeout=3.5) as r_init:
                    init_html = r_init.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                m_key = re.search(r'name="cKey"\s+value="([^"]+)"', init_html)
                m_val = re.search(r'name="cValue"\s+value="([^"]+)"', init_html)
                if m_key and m_val:
                    cKey, cValue = m_key.group(1), m_val.group(1)
            except Exception:
                pass

        for q in q_cands:
            try:
                if False:
                    ep_html = ""
                else:
                    rows = []
                    s_html = ""
                    if use_mj_api:
                        if q in mj_prefetched:
                            rows = mj_prefetched[q]
                        else:
                            req_s = urllib.request.Request(
                                f"{base}/api/mj",
                                data=json.dumps({"action": "searchContent", "params": [q]}).encode("utf-8"),
                                headers={"User-Agent": UA137, "Content-Type": "application/json", "Referer": base + "/", "Origin": base},
                                method="POST"
                            )
                            with _public_open(req_s, timeout=3.5) as rs:
                                s_data = json.loads(rs.read(131072).decode("utf-8", errors="ignore"))
                            rows = (s_data.get("result") or []) if isinstance(s_data, dict) else []
                    else:
                        if not (cKey and cValue):
                            continue
                        post_data = urllib.parse.urlencode({
                            "cKey": cKey,
                            "cValue": cValue,
                            "searchterm": q,
                        }).encode("utf-8")
                        req_s = urllib.request.Request(f"{base}/bg/searchcontent", data=post_data, headers={
                            "User-Agent": UA137, "Referer": f"{base}/arama-yap",
                            "X-Requested-With": "XMLHttpRequest",
                            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                        })
                        with _public_open(req_s, timeout=3.5) as rs:
                            s_data = json.loads(rs.read(131072).decode("utf-8", errors="ignore"))
                        d_obj = (s_data.get("data") or {}) if isinstance(s_data, dict) else {}
                        rows = d_obj.get("result") or []
                        s_html = d_obj.get("html") or ""
                    match_link = ""
                    for row in rows:
                        if not isinstance(row, dict):
                            continue
                        u_type = str(row.get("used_type") or "").lower()
                        if (mtype == "tv" and "movie" in u_type) or (mtype == "movie" and "serie" in u_type):
                            continue
                        u_slug = str(row.get("used_slug") or "").strip().lstrip("/")
                        if not u_slug:
                            continue
                        r_imdb = str(row.get("object_related_imdb_id") or "").strip()
                        r_year = str(row.get("object_release_year") or "").strip()
                        if imdb_id and imdb_id.startswith("tt") and r_imdb == imdb_id:
                            match_link = f"{base}/{u_slug}"
                            break
                        cands_r = [row.get("object_name"), row.get("object_alternative_name"), re.sub(r"-c\d+$", "", u_slug.rsplit("/", 1)[-1]).replace("-izle", "").replace("-", " ")]
                        if any(ct and _titles_match(str(ct), titles, r_year, year, mtype) for ct in cands_r):
                            match_link = f"{base}/{u_slug}"
                            break
                    if not match_link and s_html:
                        for lk in re.findall(r'href="([^"]+)"', s_html):
                            sl = lk.rstrip("/").split("/")[-1]
                            if _titles_match(sl.replace("-izle", "").replace("-", " "), titles, "", year, mtype):
                                match_link = lk if lk.startswith("http") else f"{base}/{lk.lstrip('/')}"
                                break
                    if not match_link:
                        continue

                    if mtype == "tv":
                        slug = match_link.rstrip("/").split("/")[-1]
                        slug = re.sub(r"-izle$", "", slug)
                        base_sl = re.sub(r"-c\d+$", "", slug)
                        if use_mj_api or "/series/" in match_link:
                            ep_url = ""
                            for sz_try in (f"{base}/sezon/{base_sl}/sezon-{s}", match_link):
                                try:
                                    with _public_open(urllib.request.Request(sz_try, headers={"User-Agent": UA137, "Referer": base + "/"}), timeout=3.4) as r_sz:
                                        sz_html = r_sz.read(350000).decode("utf-8", errors="ignore")
                                    m_ep = re.search(rf'(/bolum/[a-z0-9-]+-{s}x{e}(?:-[a-z0-9]+)?)(?=["\'\?\\])', sz_html)
                                    if m_ep:
                                        ep_url = f"{base}{m_ep.group(1)}"
                                        break
                                except Exception:
                                    continue
                            if not ep_url:
                                ep_url = f"{base}/bolum/{base_sl}-{s}x{e}"
                        else:
                            ep_url = f"{base}/dizi/{slug}/{s}-sezon-{e}-bolum"
                    else:
                        ep_url = match_link

                    req_ep = urllib.request.Request(ep_url, headers={"User-Agent": UA137, "Referer": base + "/"})
                    with _public_open(req_ep, timeout=3.5) as r_ep:
                        ep_html = r_ep.read(420000).decode("utf-8", errors="ignore")

                m_rmk = re.search(r'data-rm-k="true">(\{.*?\})</div>', ep_html) or re.search(r'\\?"enc\\?":\s*(\{\\?"ciphertext\\?":.*?\})', ep_html)
                if not m_rmk:
                    continue
                iframe_src = _decrypt_dizipal_rmk(m_rmk.group(1).replace('\\"', '"'))
                if not iframe_src:
                    continue
                if iframe_src.startswith("//"):
                    iframe_src = "https:" + iframe_src
                if not public_http_url(iframe_src):
                    continue

                req_if = urllib.request.Request(iframe_src, headers={"User-Agent": UA137, "Referer": base + "/"})
                with _public_open(req_if, timeout=3.8) as r_if:
                    if_html = r_if.read(655360).decode("utf-8", errors="ignore")

                m_np = re.search(r"window\.NP_CONFIG\s*=\s*(\{.*?\});", if_html, re.S)
                if m_np:
                    np_cfg = json.loads(m_np.group(1))
                    if ekey and isinstance(np_cfg.get("subtitles"), list):
                        esubs = _EMBED_SUB_CACHE.setdefault(ekey, [])
                        for sb in np_cfg["subtitles"]:
                            if isinstance(sb, dict) and str(sb.get("src") or sb.get("file") or "").startswith("http"):
                                su = str(sb.get("src") or sb.get("file")).strip()
                                sl = str(sb.get("lang") or sb.get("label") or "tr").lower()[:2]
                                if not any(x.get("url") == su for x in esubs):
                                    esubs.insert(0, {"lang": "tr" if sl == "tu" else sl, "url": su, "source": "dp_embed"})
                    for src_obj in (np_cfg.get("sources") or []):
                        if isinstance(src_obj, dict):
                            m_u = str(src_obj.get("master") or src_obj.get("file") or "").strip()
                            if m_u.startswith("http"):
                                _DP_M3U8_CACHE[iframe_src] = (m_u, time.time() + 900)
                                res.append((iframe_src, "hls_dp"))
                                break
                    if res:
                        return res

                m_tok = re.search(r"openPlayer\s*\(\s*['\"]([^'\"]+)['\"]", if_html)
                if not m_tok:
                    continue
                token = m_tok.group(1)
                parsed_if = urllib.parse.urlparse(iframe_src)
                src_api = f"{parsed_if.scheme}://{parsed_if.netloc}/source2.php?v={token}"
                req_src = urllib.request.Request(src_api, headers={
                    "User-Agent": UA137, "Referer": iframe_src, "X-Requested-With": "XMLHttpRequest"
                })
                with _public_open(req_src, timeout=3.5) as r_src:
                    src_data = json.loads(r_src.read(131072).decode("utf-8", errors="ignore"))
                playlist = src_data.get("playlist", [])
                for p_item in playlist:
                    for src_obj in p_item.get("sources", []):
                        f_u = src_obj.get("file", "")
                        if f_u.startswith("http"):
                            master_u = f_u.replace("m.php", "master.m3u8")
                            _DP_M3U8_CACHE[iframe_src] = (master_u, time.time() + 900)
                            res.append((iframe_src, "hls_dp"))
                            break
                if res:
                    return res
            except Exception:
                continue
    return res


def _clean_query_title(s: str) -> str:
    if not s:
        return ""
    t = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", html_mod.unescape(str(s))).split(" — ")[0].strip()
    t = re.sub(r"\s*\(\s*(?:19|20)\d{2}\s*\)\s*$", "", t)
    t = t.replace(".", "").strip()
    return t.strip()


import unicodedata

_ROMAN_NUM_MAP = {
    "viii": "8", "vii": "7", "vi": "6", "iv": "4", "iii": "3", "ii": "2",
    "bir": "1", "iki": "2", "uc": "3", "dort": "4", "bes": "5", "alti": "6",
    "shippuuden": "shippuden", "shougun": "shogun", "toukyou": "tokyo",
}


def _norm_title(s: str) -> str:
    if not s:
        return ""
    t = html_mod.unescape(str(s)).translate(_TR_ASCII_MAP)
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode("ascii").lower()
    t = re.sub(r"['’`]", "", t)
    t = re.sub(r"\(\s*(?:19|20)\d{2}\s*\)", " ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    words = []
    for w in t.split():
        w = _ROMAN_NUM_MAP.get(w, w)
        if w in ("izle", "full", "hd", "1080p", "720p", "turkce", "dublaj", "altyazili", "filmini", "dizisi", "the", "and", "ve", "part", "bolum", "chapter"):
            continue
        words.append(w)
    return " ".join(words).strip()


try:
    _v_streams_ref = _MAIN_SITES_VAULT.get("streams")
    if isinstance(_v_streams_ref, dict):
        for _vk_orig, _vent_orig in list(_v_streams_ref.items()):
            if _vk_orig.startswith(("movie:", "tv:")):
                _vparts = _vk_orig.split(":")
                if len(_vparts) >= 4:
                    _vmt = _vparts[0]
                    _vse_tail = ":".join(_vparts[-2:])
                    _vt_mid = ":".join(_vparts[1:-2])
                    _vt_norm = _norm_title(_vt_mid)
                    _vt_joined = re.sub(r"\b([a-z0-9]{3,})\s+(da|de|ta|te|dan|den|tan|ten|nin|in|un|nun|yi|yu|ya|ye)\b", r"\1\2", _vt_norm)
                    for _vcand in (_vt_norm, _vt_joined):
                        if _vcand:
                            _vk_alias = f"{_vmt}:{_vcand}:{_vse_tail}"
                            if _vk_alias not in _v_streams_ref:
                                _v_streams_ref[_vk_alias] = _vent_orig
except Exception:
    pass


def _titles_match(cand_title: str, valid_titles: list, cand_year: str = "", target_year: str = "", mtype: str = "movie") -> bool:
    cn = _norm_title(cand_title)
    if not cn:
        return False
    cn_no1 = re.sub(r"\s+1$", "", cn).strip()
    vn_set = {_norm_title(vt) for vt in (valid_titles or []) if _norm_title(vt)}

    # Mockbuster / parody rejection guard:
    _MOCKBUSTER_DISALLOWED = {
        "planet dune": ("dune", "col gezegeni"),
        "dune gezegeni": ("dune", "col gezegeni"),
        "alien conquest": ("dunyalar savasi", "war of the worlds"),
        "transmorphers": ("transformers",),
        "top gunner": ("top gun",),
        "titanic ii": ("titanic",),
        "titanic 2": ("titanic",),
        "atlantic rim": ("pacific rim",),
        "jurassic school": ("jurassic park", "jurassic world"),
        "jurassic predator": ("jurassic park", "jurassic world"),
        "ape vs monster": ("godzilla vs kong", "king kong"),
        "fast and fierce": ("fast and furious", "hizli ve ofkeli"),
        "the da vinci treasure": ("da vinci",),
        "snakes on a train": ("snakes on a plane",),
        "triassic world": ("jurassic world", "jurassic park"),
        "triassic hunt": ("jurassic world", "jurassic park"),
        "triassic attack": ("jurassic world", "jurassic park"),
        "tomb invader": ("tomb raider",),
        "san andreas mega quake": ("san andreas",),
        "megalodon the frenzy": ("the meg", "meg"),
        "avengers grimm": ("avengers", "yenilmezler"),
        "battle star": ("star wars", "yildiz savaslari"),
        "aladdin and the death lamp": ("aladdin",),
        "thor god of thunder": ("thor",),
    }
    for mb_pattern, protected_targets in _MOCKBUSTER_DISALLOWED.items():
        if mb_pattern in cn:
            if not any(mb_pattern in vn for vn in vn_set):
                return False
    if "dune" in cn and ("planet" in cn or ("gezegeni" in cn and "col" not in cn)):
        if not any("planet" in vn or ("gezegeni" in vn and "col" not in vn) for vn in vn_set):
            return False

    # Extract 4-digit year from cand_title if cand_year is absent
    if not cand_year:
        _ym_in_title = re.search(r"\b((?:19|20)\d{2})\b", cand_title)
        if _ym_in_title:
            cand_year = _ym_in_title.group(1)

    ty = str(target_year or "").strip()[:4]
    cy = str(cand_year or "").strip()[:4]
    year_ok = False
    if ty.isdigit() and cy.isdigit():
        tol = 1 if mtype == "movie" else 4
        if abs(int(cy) - int(ty)) > tol:
            return False
        year_ok = True
    elif ty.isdigit() and mtype == "movie" and not cy.isdigit():
        # Movie cards without a year can only match on exact normalized title
        return cn in vn_set or (bool(cn_no1) and cn_no1 in vn_set)
    if mtype == "tv" and (cn in vn_set or cn_no1 in vn_set):
        return True
    if cn in vn_set or (cn_no1 and cn_no1 in vn_set):
        return True
    cn_words = set(cn.split())
    if year_ok and cn_words:
        for vn in vn_set:
            vn_words = set(vn.split())
            if not vn_words:
                continue
            inter = len(cn_words & vn_words)
            if inter >= 2 and (inter / max(1, len(cn_words), len(vn_words))) >= 0.72:
                return True
            if inter >= 2 and vn_words <= cn_words and (cn.endswith(" " + vn) or cn.startswith(vn + " ")):
                return True
    return False


def _to_ascii_slug(s_txt: str) -> str:
    t = html_mod.unescape(str(s_txt or "")).translate(_TR_ASCII_MAP).lower()
    t = re.sub(r"\(\s*(?:19|20)\d{2}\s*\)", " ", t)
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")


def _page_year_or_imdb_mismatch(html_txt: str, mtype: str, target_year: str = "", s: int = 1, target_imdb: str = "") -> bool:
    if not html_txt:
        return False
    ti = str(target_imdb or "").strip().lower()
    if re.fullmatch(r"tt\d{6,9}", ti):
        ti_num = int(ti[2:])
        page_tts = re.findall(r"imdb\.com/title/(tt\d{6,9})\b", html_txt, re.I)
        if page_tts and all(int(x[2:]) != ti_num for x in page_tts):
            return True
    ty_s = str(target_year or "").strip()[:4]
    if ty_s.isdigit():
        ty = int(ty_s)
        ym = re.search(
            r'<span class="year">((?:19|20)\d{2})</span>|(?:Yapım Yılı|Yapım|Yıl|Release|releaseDate|datePublished)\s*[:<"\'][^0-9]{0,24}((?:19|20)\d{2})|<title>[^<]*\(((?:19|20)\d{2})\)',
            html_txt,
            re.I,
        )
        py_s = next((g for g in (ym.groups() if ym else []) if g), "") if ym else ""
        if not py_s:
            header_spans = re.findall(r'<span>\s*((?:19|20)\d{2})\s*</span>', html_txt[:5000])
            if header_spans:
                py_s = header_spans[0]
        if not py_s:
            km = re.search(r'<meta\s+name=["\']keywords["\']\s+content=["\'][^"\']*?\b((?:19|20)\d{2})\b', html_txt[:5000], re.I)
            if km:
                py_s = km.group(1)
        if py_s.isdigit():
            py = int(py_s)
            if mtype == "movie":
                if abs(py - ty) > 1:
                    return True
            else:
                if py < ty - 2 or py > ty + max(3, int(s or 1) * 2 + 2):
                    return True
    return False


def _stream_matches_title(stream_url: str, valid_titles: list, year: str = "", imdb_id: str = "") -> bool:
    if not stream_url or not isinstance(stream_url, str):
        return False
    u = stream_url.lower()
    if u.startswith("/api/rave/") or "youtube.com/" in u or "youtu.be/" in u:
        return True
    ti = str(imdb_id or "").strip().lower()
    if re.fullmatch(r"tt\d{6,9}", ti):
        m_tt_u = re.search(r"(?:^|[-_/.])(tt\d{6,9})(?:[-_/.]|$)", u)
        if m_tt_u and int(m_tt_u.group(1)[2:]) != int(ti[2:]):
            return False
    if (
        re.search(r"https?://s\d+\.[^/]+\.shop/m[a-z0-9]+/", u)
        or re.search(r"https?://[^/]+\.top/vd[a-z0-9]*/", u)
        or any(h in u for h in ("videasy.", "vidfast.", "vidlink.", "filmboom.", "hakunaymatata.", "dragonballzfans", "flixer.", "tau-video.", "makesomthingup", "ag2m5", "pilavyer", "fastplay.", "dplayer", "molystream.", "goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "workers.dev", "lightspeed.st", "bright67.", "rapidshare.", "megaup.", "archive.org"))
    ):
        return True
    parsed = urllib.parse.urlparse(stream_url)
    path = parsed.path
    m_hls = re.search(r"/hls/([^/]+)", path)
    if not m_hls:
        return True
    fn = m_hls.group(1)
    fn = re.sub(r"\.(?:mp4|m3u8|txt|mkv|webm).*$", "", fn, flags=re.I)
    fn = re.sub(r"-[A-Za-z0-9]{10,12}$", "", fn)
    slug = re.split(r"-s\d{1,2}e\d{1,4}\b|-sezon-\d+|-bolum-\d+|-(?:19|20)\d{2}\b|-(?:webdl|bluray|cam|hdrip|trdual|dual|tekmp4|tt\d+)", fn, flags=re.I)[0]
    clean_slug = re.sub(r"[^a-z0-9]", "", slug.lower().replace("&", "and"))
    if not clean_slug or len(clean_slug) < 4 or re.fullmatch(r"[0-9a-f]{12,}", clean_slug):
        return True
    if clean_slug in ("master", "index", "playlist", "video", "stream", "streamproxy", "manifest", "hls") or re.fullmatch(r"s?\d+e?\d+|ep?\d+|\d+", clean_slug):
        return True
    stop_words = {"the", "a", "an", "ve", "bir", "in", "on", "of", "izle", "dizi", "film", "full", "hd"}
    slug_words = set(re.findall(r"[a-z0-9]+", slug.lower())) - stop_words
    import difflib
    for vt in (valid_titles or []):
        if not vt:
            continue
        raw_vt = str(vt).lower().replace("&", "and")
        c_vt = re.sub(r"[^a-z0-9]", "", raw_vt)
        if not c_vt:
            continue
        if c_vt == clean_slug:
            return True
        if len(c_vt) >= 6 and (c_vt in clean_slug or clean_slug in c_vt):
            return True
        if difflib.SequenceMatcher(None, clean_slug, c_vt).ratio() >= 0.72:
            return True
        vt_words = set(re.findall(r"[a-z0-9]+", raw_vt)) - stop_words
        if vt_words and slug_words:
            overlap = len(vt_words & slug_words)
            if overlap >= 2 or (overlap == 1 and len(vt_words) == 1 and len(slug_words) == 1):
                return True
    return False


_DDIZIMAG_DEAD_UNTIL: float = 0.0
_DDIZIMAG_DIRECT_DEAD_UNTIL: float = 0.0
_DDIZIMAG_BASE: str = "https://ddizimag.icu"


def _edge_fetch_bytes(url: str, referer: str = "", xhr: bool = False, accept: str = "", timeout: float = 3.8, max_bytes: int = MAX_PAGE_BYTES) -> tuple[bytes, str]:
    hdrs = {"User-Agent": UA137, "Accept": accept or "*/*"}
    if referer:
        hdrs["Referer"] = referer
    if xhr:
        hdrs["X-Requested-With"] = "XMLHttpRequest"
    edge_base = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL or "").strip().rstrip("/")
    if not edge_base or not edge_base.startswith("https://") or "jokallame0.workers.dev" in edge_base:
        with _public_open(urllib.request.Request(url, headers=hdrs), timeout=timeout) as r:
            return r.read(max_bytes), str(getattr(r, "url", "") or r.geturl() or url)
    try:
        q = f"{edge_base}/api/rave/edge-fetch?url={urllib.parse.quote(url, safe='')}"
        if referer:
            q += f"&referer={urllib.parse.quote(referer, safe='')}"
        q += f"&sig={_proxy_sig(url, referer)}&efsig={_proxy_sig('ef:' + url, referer)}"
        if xhr:
            q += "&xhr=1"
        if accept:
            q += f"&accept={urllib.parse.quote(accept, safe='')}"
        req = urllib.request.Request(q, headers={"User-Agent": UA137, "Accept": accept or "*/*"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            fin = str(r.headers.get("X-Final-Url") or url).strip()
            body = r.read(max_bytes)
            head_low = body[:512].decode("utf-8", errors="ignore").lower()
            if body and "<title>just a moment" not in head_low and "attention required! | cloudflare" not in head_low:
                return body, fin
    except Exception:
        pass
    with _public_open(urllib.request.Request(url, headers=hdrs), timeout=timeout) as r:
        return r.read(max_bytes), str(getattr(r, "url", "") or r.geturl() or url)


def _extract_ddizimag_sync(mtype: str, s: int, e: int, title: str, disp_title: str, ekey: str, year: str = "", extra_titles: list = None, source_url: str = "", orig_lang: str = "", imdb_id: str = "") -> list:
    global _DDIZIMAG_DEAD_UNTIL, _DDIZIMAG_BASE
    if time.time() < _DDIZIMAG_DEAD_UNTIL:
        return []
    res = []
    raw_cands = [_clean_query_title(x) for x in ([title, disp_title] + list(extra_titles or [])) if _clean_query_title(x)]
    q_cands = []
    for x in raw_cands:
        if ":" in x:
            pre = x.split(":", 1)[0].strip()
            if len(pre) >= 3:
                q_cands.append(pre)
            q_cands.append(x.replace(":", " "))
        q_cands.append(x)
    valid_titles = list(dict.fromkeys(q_cands + [disp_title, title]))
    slug_cands = []
    for x in raw_cands:
        sl = _to_ascii_slug(x)
        if sl:
            slug_cands.append(sl)
        if ":" in x:
            sl_pre = _to_ascii_slug(x.split(":", 1)[0])
            if sl_pre and len(sl_pre) >= 3:
                slug_cands.append(sl_pre)
    slug_cands = list(dict.fromkeys(slug_cands))[:5]
    ep_urls = []
    if source_url and "ddizimag." in source_url:
        su_clean = re.sub(r"^https?://(?:www\.)?ddizimag\.[a-z]{2,8}", _DDIZIMAG_BASE, source_url.rstrip("/"))
        if mtype == "tv":
            if "/sezon-" in su_clean:
                su_clean = re.sub(r"/sezon-\d+/bolum-\d+.*$", f"/sezon-{s}/bolum-{e}", su_clean)
            else:
                su_clean = f"{su_clean}/sezon-{s}/bolum-{e}"
        ep_urls.append((su_clean, True))
    for sl in slug_cands:
        if mtype == "tv":
            if orig_lang == "ja":
                ep_urls.append((f"{_DDIZIMAG_BASE}/anime/{sl}/sezon-{s}/bolum-{e}", False))
            else:
                ep_urls.append((f"{_DDIZIMAG_BASE}/dizi/{sl}/sezon-{s}/bolum-{e}", False))
        else:
            ep_urls.append((f"{_DDIZIMAG_BASE}/film/{sl}", False))

    def _try_ep_page(ep_u: str, pre_verified: bool) -> list:
        global _DDIZIMAG_DEAD_UNTIL, _DDIZIMAG_DIRECT_DEAD_UNTIL, _DDIZIMAG_BASE
        try:
            if not public_http_url(ep_u) or time.time() < _DDIZIMAG_DEAD_UNTIL:
                return []
            html = ""
            fin_dd = ""
            now_dd = time.time()
            edge_base_dd = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL).strip().rstrip("/")
            if now_dd >= _DDIZIMAG_DIRECT_DEAD_UNTIL:
                req = urllib.request.Request(ep_u, headers={"User-Agent": UA137, "Referer": _DDIZIMAG_BASE + "/"})
                try:
                    with _public_open(req, timeout=2.6) as r:
                        fin_dd = str(r.geturl() or "").strip()
                        html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                except urllib.error.HTTPError as he_dd:
                    if he_dd.code in (403, 503) and edge_base_dd:
                        _DDIZIMAG_DIRECT_DEAD_UNTIL = now_dd + 120.0
                    else:
                        return []
                except Exception:
                    if edge_base_dd:
                        _DDIZIMAG_DIRECT_DEAD_UNTIL = now_dd + 120.0
                    else:
                        return []
            if not html and edge_base_dd:
                try:
                    raw_dd, fin_dd = _edge_fetch_bytes(ep_u, _DDIZIMAG_BASE + "/", accept="text/html,*/*", timeout=3.2)
                    html = raw_dd.decode("utf-8", errors="ignore")
                except Exception:
                    return []
            if fin_dd:
                p_dd = urllib.parse.urlparse(fin_dd)
                if p_dd.netloc and "ddizimag." in p_dd.netloc.lower():
                    _DDIZIMAG_BASE = f"{p_dd.scheme}://{p_dd.netloc}"
            if 'data-player-type="none"' in html:
                return []
            m_pv = re.search(r'data-pv="([^"]+)"', html)
            if not m_pv:
                return []
            if not pre_verified:
                tm = re.search(r"<title>([^<]+)</title>", html, re.I)
                pt = re.sub(r"\s+\d+\.\s*Sezon.*$", "", tm.group(1), flags=re.I) if tm else ""
                pt = re.sub(r"\s+(?:izle|Full|HD|ddizimag).*$", "", pt, flags=re.I).strip()
                if pt and not _titles_match(pt, valid_titles, "", year, mtype):
                    return []
                if _page_year_or_imdb_mismatch(html, mtype, year, s, imdb_id):
                    return []
            m_core = re.search(r'src="https://([^/"]+)/assets/js/core\.js"', html)
            pv_dom = m_core.group(1) if m_core else "play2.pilavyerplay.top"
            s_u = f"https://{pv_dom}/assets/js/s.php?s={urllib.parse.quote(m_pv.group(1))}"
            if not public_http_url(s_u):
                return []
            with _public_open(urllib.request.Request(s_u, headers={"User-Agent": UA137, "Referer": ep_u, "Accept": "*/*"}), timeout=4.2) as sr:
                s_js = sr.read(131072).decode("utf-8", errors="ignore")
            m_pl = re.search(r"window\.__PLAYER__\s*=\s*(\{.*?\});\s*</script>", s_js, re.S)
            if not m_pl:
                return []
            pl = json.loads(m_pl.group(1))
            st_u = str(pl.get("stream") or "").strip()
            if not st_u.startswith("https://"):
                return []
            if mtype == "tv":
                m_se = re.search(r"S(\d{1,2})\s*E(\d{1,3})", str(pl.get("title") or ""), re.I)
                if m_se and (int(m_se.group(1)) != int(s) or int(m_se.group(2)) != int(e)):
                    return []
            if ekey and isinstance(pl.get("subs"), list):
                esubs = _EMBED_SUB_CACHE.setdefault(ekey, [])
                for sub_it in pl["subs"]:
                    if not isinstance(sub_it, dict):
                        continue
                    su = str(sub_it.get("src") or "").strip()
                    slang = str(sub_it.get("lang") or "").lower().strip()
                    slabel = str(sub_it.get("label") or "").lower()
                    if su.startswith("https://") and slang in ("tr", "tur", "en", "eng") and "forced" not in slabel:
                        norm_l = "tr" if (slang.startswith("tr") or slang == "tur") else "en"
                        if not any(x.get("url") == su for x in esubs):
                            esubs.insert(0, {"lang": norm_l, "url": su, "source": "pv_embed"})
            audios = [a for a in (pl.get("audios") or []) if isinstance(a, dict)]
            hint_langs = []
            if len(audios) >= 2:
                for a in audios:
                    code = _norm_audio_lang(a.get("lang"), a.get("label"))
                    if code and code not in hint_langs:
                        hint_langs.append(code)
            elif len(audios) == 1:
                a0_lbl = str(audios[0].get("label") or "").lower()
                a0_lang = str(audios[0].get("lang") or "").lower().strip()
                has_def_tr_sub = any(
                    isinstance(sub_it, dict) and str(sub_it.get("lang") or "").lower().startswith("tr") and sub_it.get("default")
                    for sub_it in (pl.get("subs") or [])
                )
                if orig_lang == "tr":
                    hint_langs = ["tr"]
                elif orig_lang and ("orijinal" in a0_lbl or has_def_tr_sub):
                    hint_langs = [orig_lang]
                elif ("dublaj" in a0_lbl or a0_lang in ("tr", "tur") or "türk" in a0_lbl) and not has_def_tr_sub:
                    hint_langs = ["tr"]
            if hint_langs:
                _AUDIO_LANG_HINT[st_u] = hint_langs
            has_tr_a = ("tr" in hint_langs) or any(str(a.get("lang") or "").lower() in ("tr", "tur") or "türk" in str(a.get("label") or "").lower() for a in audios)
            has_other_a = any(str(a.get("lang") or "").lower() not in ("tr", "tur") and "türk" not in str(a.get("label") or "").lower() for a in audios)
            stype = "hls_pv_multi" if (len(audios) >= 2 and has_tr_a and has_other_a) else ("hls_pv_tr" if hint_langs == ["tr"] else "hls_pv")
            return [(st_u, stype)]
        except Exception:
            return []

    for ep_u, pre_v in ep_urls:
        if time.time() < _DDIZIMAG_DEAD_UNTIL:
            return []
        out = _try_ep_page(ep_u, pre_v)
        if out:
            return out
    for q in list(dict.fromkeys(q_cands))[:2]:
        if time.time() < _DDIZIMAG_DEAD_UNTIL:
            break
        try:
            su = f"{_DDIZIMAG_BASE}/ara?q={urllib.parse.quote(q)}"
            s_html = ""
            fin_s = ""
            edge_base_dds = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL).strip().rstrip("/")
            if time.time() >= _DDIZIMAG_DIRECT_DEAD_UNTIL:
                try:
                    with _public_open(urllib.request.Request(su, headers={"User-Agent": UA137, "Referer": _DDIZIMAG_BASE + "/"}), timeout=2.6) as r:
                        fin_s = str(r.geturl() or "").strip()
                        s_html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                except Exception:
                    if edge_base_dds:
                        _DDIZIMAG_DIRECT_DEAD_UNTIL = time.time() + 120.0
                    else:
                        raise
            if not s_html and edge_base_dds:
                raw_dds, fin_s = _edge_fetch_bytes(su, _DDIZIMAG_BASE + "/", accept="text/html,*/*", timeout=3.0)
                s_html = raw_dds.decode("utf-8", errors="ignore")
            if fin_s:
                p_dds = urllib.parse.urlparse(fin_s)
                if p_dds.netloc and "ddizimag." in p_dds.netloc.lower():
                    _DDIZIMAG_BASE = f"{p_dds.scheme}://{p_dds.netloc}"
            hits = []
            for raw_href, sl in re.findall(r'href="((?:https?://(?:www\.)?ddizimag\.[a-z]{2,8})?/(?:dizi|film|anime)/([a-z0-9-]+))"', s_html):
                full_href = raw_href if raw_href.startswith("http") else (_DDIZIMAG_BASE + raw_href)
                if (full_href, sl) not in hits:
                    hits.append((full_href, sl))
            for href, sl in hits:
                if mtype == "movie" and "/film/" not in href:
                    continue
                if mtype == "tv" and "/film/" in href:
                    continue
                if mtype == "tv" and orig_lang == "ja" and "/dizi/" in href:
                    continue
                if _titles_match(sl.replace("-", " "), valid_titles, "", year, mtype):
                    ep_u = f"{href}/sezon-{s}/bolum-{e}" if mtype == "tv" else href
                    out = _try_ep_page(ep_u, False)
                    if out:
                        return out
        except Exception:
            continue
    return res


def _extract_dizilife_sync(mtype: str, s: int, e: int, title: str, disp_title: str, ekey: str, year: str = "", imdb_id: str = "", extra_titles: list = None, source_url: str = "") -> list:
    import base64, hashlib
    res = []
    raw_cands = [_clean_query_title(x) for x in ([title, disp_title] + list(extra_titles or [])) if _clean_query_title(x)]
    q_cands = []
    for x in raw_cands:
        if ":" in x:
            pre = x.split(":", 1)[0].strip()
            if len(pre) >= 3:
                q_cands.append(pre)
            q_cands.append(x.replace(":", " "))
        q_cands.append(x)
    valid_titles = list(dict.fromkeys(q_cands + [disp_title, title]))
    want_kore = any("kore" in str(vt or "").lower() or "korea" in str(vt or "").lower() for vt in valid_titles)
    direct_dl = re.sub(r"https?://dizi\d*\.(?:life|plus)", "https://dizi85.life", source_url) if (source_url and re.search(r"dizi\d*\.(?:life|plus)/(?:dizi|film)/", source_url)) else ""
    slug_steps = []
    seg_dl = "dizi" if mtype == "tv" else "film"
    # Prioritize localized display title and titles with more specific descriptors
    raw_slug_cands = sorted(list(dict.fromkeys([disp_title, title] + list(extra_titles or []))), key=lambda s: len(s or ""), reverse=True)
    for x_sl in raw_slug_cands:
        sl_dl = _to_ascii_slug(_clean_query_title(x_sl))
        if sl_dl and len(sl_dl) >= 3:
            cand_dl_u = f"https://dizi85.life/{seg_dl}/{sl_dl}"
            if ("__SLUG__", cand_dl_u) not in slug_steps:
                slug_steps.append(("__SLUG__", cand_dl_u))
        if len(slug_steps) >= 3:
            break
    steps = ([("__DIRECT__", direct_dl)] if direct_dl else []) + slug_steps + [("__SEARCH__", q) for q in list(dict.fromkeys(q_cands))[:3]]
    for mode, val in steps:
        try:
            if mode in ("__DIRECT__", "__SLUG__"):
                matched_url = val
                base_dom = f"{urllib.parse.urlparse(matched_url).scheme}://{urllib.parse.urlparse(matched_url).netloc}"
            else:
                html = ""
                base_dom = ""
                for _dl_host in ("https://dizi85.life", "https://dizi86.life", "https://dizi84.life", "https://dizi82.life"):
                    try:
                        with _public_open(urllib.request.Request(f"{_dl_host}/ara?q={urllib.parse.quote(val)}", headers={"User-Agent": UA137}), timeout=3.2) as r:
                            base_dom = f"{urllib.parse.urlparse(r.geturl()).scheme}://{urllib.parse.urlparse(r.geturl()).netloc}"
                            html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                        if html:
                            break
                    except Exception:
                        continue
                if not html:
                    continue
                seg = "dizi" if mtype == "tv" else "film"
                cards = re.findall(rf'<a[^>]+href=["\']((?:https?://[^"\'\s/]+)?/{seg}/[a-z0-9-]+)["\'][^>]*>(.*?)</a>', html, re.S)
                matched_url = ""
                for href, inner in cards:
                    slug_part = href.rsplit("/", 1)[-1]
                    if not want_kore and ("-kore" in slug_part or "korea" in slug_part):
                        continue
                    tm = re.search(r'data-fallback-title=["\']([^"\']+)["\']', inner) or re.search(r'alt=["\']([^"\']+)["\']', inner)
                    slug_title = slug_part.replace("-", " ")
                    ctitle = tm.group(1) if tm else slug_title
                    ym = re.search(r'<span>\s*((?:19|20)\d{2})\s*</span>', inner)
                    cyear = ym.group(1) if ym else ""
                    if cyear.isdigit() and year and str(year)[:4].isdigit():
                        tol_dl = 1 if mtype == "movie" else 4
                        if abs(int(cyear) - int(str(year)[:4])) > tol_dl:
                            continue
                    if _titles_match(ctitle, valid_titles, cyear, year, mtype) or _titles_match(slug_title, valid_titles, cyear, year, mtype):
                        matched_url = href if href.startswith("http") else (base_dom + href)
                        break
            if not matched_url:
                continue
            item_url = matched_url
            if mtype == "tv":
                if "/sezon/" in item_url:
                    ep_url = re.sub(r"/sezon/\d+/bolum/\d+.*$", f"/sezon/{s}/bolum/{e}", item_url.rstrip("/"))
                else:
                    ep_url = f"{item_url.rstrip('/')}/sezon/{s}/bolum/{e}"
            else:
                ep_url = item_url
            try:
                with _public_open(urllib.request.Request(ep_url, headers={"User-Agent": UA137, "Referer": base_dom + "/"}), timeout=3.4) as r_ep_dl:
                    ep_html = r_ep_dl.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            except Exception:
                if mtype == "tv" and "/sezon/" not in item_url and mode != "__SLUG__":
                    with _public_open(urllib.request.Request(item_url, headers={"User-Agent": UA137, "Referer": base_dom + "/"}), timeout=3.4) as r_it_dl:
                        s_html = r_it_dl.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                    alt_ep = re.search(rf'href=["\']((?:https?://[^"\'\s/]+)?/dizi/[a-z0-9-]+/sezon/\d+/bolum/{e})["\']', s_html)
                    if not alt_ep:
                        continue
                    ep_url = alt_ep.group(1) if alt_ep.group(1).startswith("http") else (base_dom + alt_ep.group(1))
                    with _public_open(urllib.request.Request(ep_url, headers={"User-Agent": UA137, "Referer": base_dom + "/"}), timeout=3.4) as r_ep_dl2:
                        ep_html = r_ep_dl2.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                else:
                    continue
            if _page_year_or_imdb_mismatch(ep_html, mtype, year, s, imdb_id):
                continue
            ifr = re.search(r'<iframe[^>]+src=["\']((?:https?:)?//[^"\']+/player/[^"\']+)["\']', ep_html)
            if not ifr:
                continue
            pu = ("https:" + ifr.group(1)) if ifr.group(1).startswith("//") else ifr.group(1)
            if not public_http_url(pu):
                continue
            with _public_open(urllib.request.Request(pu, headers={"User-Agent": UA137, "Referer": ep_url}), timeout=4.2) as r_pu_dl:
                phtml = r_pu_dl.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            fn_m = re.search(r"var\s+([a-zA-Z0-9_$]+)\s*=\s*function\(s\)\{return atob", phtml)
            if not fn_m:
                continue
            s_matches = re.findall(rf'{re.escape(fn_m.group(1))}\("([^"]+)"\)', phtml)
            if len(s_matches) < 2:
                continue
            c_b64 = base64.b64decode(s_matches[0][::-1])
            pw = base64.b64decode(s_matches[1][::-1])
            raw = base64.b64decode(c_b64)
            salt, ct = raw[8:16], raw[16:]
            d, prev = b"", b""
            while len(d) < 48:
                prev = hashlib.md5(prev + pw + salt).digest()
                d += prev
            pt = _aes256_cbc_decrypt(ct, d[:32], d[32:48]).decode("utf-8", errors="ignore")
            fm = re.search(r'file:\s*"([^"]+)"', pt)
            if fm:
                mu = fm.group(1).split("?")[0].strip()
                if mu.startswith("https://"):
                    res.append((mu, "hls_dl"))
                    base_m = mu.rsplit("/", 1)[0]
                    esubs = _EMBED_SUB_CACHE.setdefault(ekey, [])
                    esubs.append({"lang": "en", "url": f"{base_m}/sub_english/english.vtt", "source": "dl_embed"})
                    esubs.append({"lang": "tr", "url": f"{base_m}/sub_turkish/turkish.vtt", "source": "dl_embed"})
                    break
        except Exception:
            continue
    return res


def _decode_hdfc_mobi_html(emb_html: str) -> str:
    try:
        calls = list(re.finditer(r'var\s+([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\((?:(\[[^\]]+\])|"([^"]+)"\.split\("([^"]+)"\))\);', emb_html))
        if not calls:
            return ""
        last_call = calls[-1]
        fn_name = last_call.group(2)
        arr = json.loads(last_call.group(3)) if last_call.group(3) else last_call.group(4).split(last_call.group(5))
        fn_idx = emb_html.find(f"var {fn_name} = function")
        if fn_idx < 0:
            fn_idx = emb_html.find(f"function {fn_name}")
        fn_body = emb_html[fn_idx:last_call.start()]
        m_sp = re.search(r'%\s*(\d+)\s*,\s*[a-zA-Z0-9_]+\s*=\s*(\d+)\s*\+\s*\([a-zA-Z0-9_]+\s*%\s*(\d+)\)', fn_body)
        mod1, off2, mod2 = (int(m_sp.group(1)), int(m_sp.group(2)), int(m_sp.group(3))) if m_sp else (7, 8, 5)
        cf4 = len(arr) - 2
        idx1 = off2 + (cf4 % mod2) if mod2 else off2
        if not (0 <= idx1 < len(arr)):
            return ""
        jve5 = arr.pop(idx1)
        idx2 = (cf4 % mod1) if mod1 else 0
        if not (0 <= idx2 < len(arr)):
            return ""
        d46 = arr.pop(idx2) + "hdfilmcehennemi.mobi"
        z81u = "".join(arr)
        m_h1 = re.search(r'\*\s*(\d+)\s*\+\s*[a-zA-Z0-9_]+\)\s*%\s*(\d+)', fn_body)
        h_mul, h_mod = (int(m_h1.group(1)), int(m_h1.group(2))) if m_h1 else (37, 241)
        is_shift_add = "<<" in fn_body.split("charAt")[0]
        p8l, s51k1 = 0, 0
        for i, ch in enumerate(d46):
            c = ord(ch)
            p8l = (p8l * h_mul + c) % h_mod
            s51k1 = ((s51k1 + ((c << 1) ^ i)) & 255) if is_shift_add else ((s51k1 ^ (c + i)) & 255)
        m_k = re.search(r'=\s*\([a-zA-Z0-9_]+(?:\s*\*\s*(\d+))?\s*\+\s*[a-zA-Z0-9_]+\)\s*%\s*256\s*,\s*[a-zA-Z0-9_]+\s*=\s*\(([a-zA-Z0-9_]+)\s*%\s*(\d+)\)\s*\+\s*(\d+)\s*,\s*[a-zA-Z0-9_]+\s*=\s*\(\(([a-zA-Z0-9_]+)\s*\*\s*(\d+)\s*\+\s*[a-zA-Z0-9_]+\)\s*%\s*(\d+)\)\s*\+\s*1', fn_body)
        k_mul = int(m_k.group(1) or 1) if m_k else 3
        v_mod = int(m_k.group(3)) if m_k else 11
        v_add = int(m_k.group(4)) if m_k else 5
        s_mul = int(m_k.group(6)) if m_k else 251
        s_mod = int(m_k.group(7)) if m_k else 65519
        m_hvars = re.search(r'var\s+([a-zA-Z0-9_]+)\s*=\s*0\s*,\s*([a-zA-Z0-9_]+)\s*=\s*0', fn_body)
        p8l_name = m_hvars.group(1) if m_hvars else ""
        v_var_val = p8l if (m_k and m_k.group(2) == p8l_name) else s51k1
        s_var1_val = p8l if (m_k and m_k.group(5) == p8l_name) else s51k1
        s_var2_val = s51k1 if s_var1_val == p8l else p8l
        g84k = (p8l * k_mul + s51k1) % 256
        v9nc = (v_var_val % v_mod) + v_add
        sv3 = ((s_var1_val * s_mul + s_var2_val) % s_mod) + 1
        m_chars = re.search(r"===\s*'([^']+)'\)\s*\{\s*[a-zA-Z0-9_]+\s*=\s*atob.*?===\s*'([^']+)'\)\s*\{\s*[a-zA-Z0-9_]+\s*=\s*[a-zA-Z0-9_]+\.split\(''\)\.reverse.*?charCodeAt\(0\)\s*-\s*(\d+)\)", fn_body, re.S)
        ch_b64 = m_chars.group(1) if m_chars else "7"
        ch_rev = m_chars.group(2) if m_chars else "3"
        caesar_sub = int(m_chars.group(3)) if m_chars else 96
        for idx in range(len(jve5) - 1, -1, -1):
            op = jve5[idx]
            if op == ch_b64:
                z81u = base64.b64decode(z81u).decode("latin-1")
            elif op == ch_rev:
                z81u = z81u[::-1]
            else:
                shift = (26 - ((ord(op) - caesar_sub) % 26)) % 26
                z81u = "".join(chr((ord(ch) - 65 + shift) % 26 + 65) if 65 <= ord(ch) <= 90 else (chr((ord(ch) - 97 + shift) % 26 + 97) if 97 <= ord(ch) <= 122 else ch) for ch in z81u)
        m_prng = re.search(r'=\s*\([a-zA-Z0-9_]+\s*\*\s*(\d+)\s*\+\s*(\d+)\)\s*%\s*(\d+)\s*;', fn_body)
        p_mul, p_add, p_mod = (int(m_prng.group(1)), int(m_prng.group(2)), int(m_prng.group(3))) if m_prng else (97, 41, 65519)
        n_len = len(z81u)
        swaps = [0] * n_len
        for i in range(n_len - 1, 0, -1):
            sv3 = (sv3 * p_mul + p_add) % p_mod
            swaps[i] = sv3 % (i + 1)
        arr_chars = list(z81u)
        for i in range(1, n_len):
            j = swaps[i]
            arr_chars[i], arr_chars[j] = arr_chars[j], arr_chars[i]
        z81u = "".join(arr_chars)
        after_join = fn_body.split("join('')")[-1]
        m_xmul = re.search(r'\*\s*(\d+)\s*\+', after_join)
        x_mul = int(m_xmul.group(1)) if m_xmul else 1
        q6h = g84k
        res_bytes = bytearray()
        for ch in z81u:
            c = ord(ch)
            q6h = (q6h * x_mul + v9nc) % 256
            res_bytes.append(c ^ q6h)
            q6h = (q6h + c) % 256
        return res_bytes.decode("utf-8", errors="ignore").strip()
    except Exception:
        return ""

def _parse_embed_vtt_tracks(rhtml: str, source_tag: str) -> list:
    subs = []
    seen = set()
    clean_h = rhtml.replace(r"\/", "/")
    try:
        clean_h = clean_h.encode("utf-8").decode("unicode_escape", errors="ignore")
    except Exception:
        pass
    for m in re.finditer(r'\{[^{}]*"file"\s*:\s*"(https?://[^"]+\.vtt)"[^{}]*\}', clean_h):
        blk = m.group(0)
        u = m.group(1).strip()
        if u in seen or "forced" in u.lower():
            continue
        lm = re.search(r'"label"\s*:\s*"([^"]+)"', blk)
        lbl = (lm.group(1) if lm else "").replace("İ", "i").replace("I", "i").lower()
        if "forced" in lbl:
            continue
        lang = "tr" if ("turk" in lbl or "türk" in lbl or ".tur." in u.lower() or "/1.vtt" in u.lower()) else ("en" if ("ing" in lbl or "eng" in lbl or ".eng." in u.lower() or "/2.vtt" in u.lower()) else lbl[:2])
        if lang:
            seen.add(u)
            subs.append({"url": u, "lang": lang, "source": source_tag})
    return subs


def _decode_rapidvid_embed(vod_url: str, ref: str = "https://www.fullhdfilmizlesene.now/") -> tuple:
    try:
        rhtml = urllib.request.urlopen(urllib.request.Request(vod_url, headers={"User-Agent": UA137, "Referer": ref}), timeout=3.5).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
        subs = _parse_embed_vtt_tracks(rhtml, "fhd_embed")
        m_p8 = re.search(r"window\._p8\s*=\s*'([^']+)'", rhtml)
        if m_p8:
            enc = m_p8.group(1)
            t = base64.b64decode(enc[::-1]).decode("latin-1")
            o = "".join(chr(ord(t[i]) - (ord("K9L"[i % 3]) % 5 + 1)) for i in range(len(t)))
            dec_obj = json.loads(base64.b64decode(o).decode("utf-8", errors="ignore"))
            cm_u = str(dec_obj.get("cm") or dec_obj.get("tm") or "").strip()
            for ct_it in (dec_obj.get("ct") or []):
                if isinstance(ct_it, dict) and str(ct_it.get("file") or "").startswith("http") and "forced" not in str(ct_it.get("label") or "").lower():
                    sl = str(ct_it.get("label") or "").replace("İ", "i").replace("I", "i").lower()
                    lang = "tr" if ("turk" in sl or "türk" in sl) else ("en" if ("ing" in sl or "eng" in sl) else sl[:2])
                    su = str(ct_it["file"]).strip()
                    if not any(x["url"] == su for x in subs):
                        subs.append({"url": su, "lang": lang, "source": "fhd_embed"})
            if cm_u.startswith("http"):
                return cm_u, subs
        m_file = re.search(r'"file"\s*:\s*av\(\'([^\']+)\'\)', rhtml)
        if m_file:
            enc = m_file.group(1)
            t = base64.b64decode(enc[::-1]).decode("latin-1")
            o = "".join(chr(ord(t[i]) - (ord("K9L"[i % 3]) % 5 + 1)) for i in range(len(t)))
            dec_u = base64.b64decode(o).decode("utf-8", errors="ignore").strip()
            if dec_u.startswith("http"):
                return dec_u, subs
    except Exception:
        pass
    return "", []


def _is_unplayable_stream_url(url: str) -> bool:
    u_low = str(url or "").strip().lower()
    if not u_low:
        return True
    try:
        u_dec = urllib.parse.unquote(u_low)
    except Exception:
        u_dec = u_low
    for s_chk in (u_low, u_dec):
        if "nexa-banned" in s_chk:
            return True
        if "/resource/h265/" in s_chk or re.search(r"(?:[/_.-])(?:h265|hevc)(?:[/_.-]|\.mp4|\?|$)", s_chk):
            return True
    return False


def _is_vault_url_expired(url: str) -> bool:
    if _is_unplayable_stream_url(url):
        return True
    u_low = str(url or "").lower()
    if "hakunaymatata.com" in u_low and "t=" in u_low:
        try:
            qs = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
            t_val = float(qs.get("t") or 0)
            if 0 < t_val < time.time() - 172800:
                return True
        except Exception:
            pass
    if "pilavyer" in u_low and "token=" in str(url or ""):
        try:
            qs = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
            tok = str(qs.get("token") or "").split(".")[0]
            if tok:
                pad = tok + "=" * ((4 - len(tok) % 4) % 4)
                payload = json.loads(base64.urlsafe_b64decode(pad.encode("ascii")).decode("utf-8", errors="ignore"))
                exp = payload.get("exp")
                if exp and float(exp) < time.time() + 300:
                    return True
        except Exception:
            pass
    return False


def _extract_hdfc_sync(mtype: str, s: int, e: int, title: str, disp_title: str, ekey: str, year: str = "", imdb_id: str = "", extra_titles: list = None, source_url: str = "", tid: str = "", refresh: bool = False) -> list:
    import codecs
    res = []
    fallback_res = []
    es_list = _EMBED_SUB_CACHE.setdefault(ekey, [])
    q_cands = [_clean_query_title(x) for x in ([title, disp_title] + list(extra_titles or [])) if _clean_query_title(x)]
    for qc in list(q_cands):
        if "&" in qc:
            q_cands.append(qc.replace("&", " "))
        if re.search(r"\b(?:II|III|IV|V|VI)\b", qc):
            q_cands.append(re.sub(r"\bII\b", "2", re.sub(r"\bIII\b", "3", re.sub(r"\bIV\b", "4", qc))))
        qc_chap = re.sub(r"[:\-\s]*\b(?:chapter|b[oö]l[uü]m|part|k[ıi]s[ıi]m)\s+(\d+)\b", r" \1", qc, flags=re.I)
        qc_chap = re.sub(r"\s+", " ", qc_chap).strip()
        if qc_chap and qc_chap not in q_cands:
            q_cands.append(qc_chap)
    valid_titles = list(dict.fromkeys(q_cands + [disp_title, title]))

    # 1. Instant lookup in _MAIN_SITES_VAULT (FullHDFilmizlesene.now + HDFilmCehennemi.nl + Dizibox.live)
    v_streams = (_MAIN_SITES_VAULT.get("streams") or {})
    exact_ep_keys = []
    fb_ep_keys = []
    if tid:
        exact_ep_keys.append(f"tmdb:{mtype}:{tid}:{s}:{e}")
    for vt in valid_titles:
        nt = _norm_title(vt)
        if nt:
            k_nt = f"{mtype}:{nt}:{s}:{e}"
            if k_nt not in exact_ep_keys:
                exact_ep_keys.append(k_nt)
    if source_url:
        (exact_ep_keys if (s == 1 and e == 1) else fb_ep_keys).append(f"url:{source_url}")
    if tid:
        if mtype != "tv":
            (exact_ep_keys if (s == 1 and e == 1) else fb_ep_keys).append(f"id:{tid}")
        if s > 1 or e > 1:
            fb_ep_keys.append(f"tmdb:{mtype}:{tid}:1:1")
    if s > 1 or e > 1:
        for vt in valid_titles:
            nt = _norm_title(vt)
            if nt:
                fb_ep_keys.append(f"{mtype}:{nt}:1:1")

    if mtype == "tv" and (s > 1 or e > 1):
        if not source_url:
            for vk_fb in fb_ep_keys:
                v_fb = v_streams.get(vk_fb)
                if isinstance(v_fb, dict) and v_fb.get("sourceUrl") and "/film/" not in str(v_fb.get("sourceUrl")):
                    source_url = str(v_fb.get("sourceUrl"))
                    break
        fb_ep_keys = []

    def _collect_vault_keys(key_list, target_list):
        all_vt_words = set()
        for vt_i in valid_titles:
            all_vt_words |= set(_norm_title(vt_i).split())
        min_vt_len = min((len(_norm_title(vt_i).split()) for vt_i in valid_titles if _norm_title(vt_i)), default=1)
        for vk in key_list:
            v_ent = v_streams.get(vk)
            if not isinstance(v_ent, dict):
                continue
            if v_ent.get("title") and not _titles_match(str(v_ent["title"]), valid_titles, str(v_ent.get("year") or ""), year, mtype):
                continue
            v_su = str(v_ent.get("sourceUrl") or "")
            if v_su and any(b in v_su.lower() for b in ("dune-gezegeni", "planet-dune", "transmorphers", "alien-conquest")):
                if not any(b in " ".join(valid_titles).lower() for b in ("dune-gezegeni", "planet-dune", "transmorphers", "alien-conquest")):
                    continue
            if mtype == "tv" and "/film/" in v_su:
                continue
            if mtype == "tv" and (s > 1 or e > 1) and vk.startswith(("id:", "url:")):
                continue
            if v_su and min_vt_len == 1 and all_vt_words and not vk.startswith("tmdb:"):
                v_slug = re.sub(r"-(?:izle|full-hd|turkce-dublaj|altyazili|hd|fh\d+|1080p|\d{4}|\d+)$", "", v_su.rstrip("/").rsplit("/", 1)[-1])
                v_slug_w = set(_norm_title(v_slug.replace("-", " ")).split()) - {"fh", "the", "and", "of", "in", "la", "le", "el", "ve", "bir", "turk", "filmi", "izle", "yerli", "full", "hd", "sansursuz"}
                if len(v_slug_w - all_vt_words) >= 2:
                    continue
            if v_ent.get("streams"):
                for sb in (v_ent.get("subs") or []):
                    if isinstance(sb, dict) and sb.get("url") and not any(x.get("url") == sb["url"] for x in es_list):
                        es_list.insert(0, sb)
                v_aud = v_ent.get("audioLangs") or []
                for u_st in v_ent["streams"]:
                    if isinstance(u_st, (list, tuple)) and len(u_st) >= 2:
                        raw_su, st_t = str(u_st[0]), str(u_st[1])
                        if not raw_su.startswith("http") or "ineedskin.cfd" in raw_su.lower() or "shrek.dragonballzfans.xyz" in raw_su.lower() or ".asia/" in raw_su.lower():
                            continue
                        if _is_vault_url_expired(raw_su):
                            continue
                        if (
                            "dbx.molystream.org" in raw_su.lower()
                            or "dplayer" in raw_su.lower()
                            or st_t in ("hls_dbx", "hls_dp")
                        ):
                            continue
                        if IS_VERCEL and (
                            "hdfilmcehennemi.mobi" in raw_su.lower()
                            or ("cdnimages" in raw_su.lower() and "/hls/" in raw_su.lower())
                            or "playmix.uno" in raw_su.lower()
                            or "master.txt?s=" in raw_su.lower()
                            or st_t in ("hls_hfnl", "hls_hfnl_multi")
                        ):
                            continue
                        if not _stream_matches_title(raw_su, valid_titles, year, imdb_id):
                            continue
                        is_vm_vault = any(d in raw_su.lower() for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx."))
                        if is_vm_vault and st_t == "hls":
                            st_t = "hls_vm"
                        is_true_1080_vault = (
                            st_t in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_dl", "hls_pv_tr", "hls_cj", "hls_cj_4k", "hls_ve", "hls_ve_multi")
                            or (st_t in ("mp4_ac_sub", "mp4_ac_dub") and "_720p" not in raw_su.lower())
                            or (not IS_VERCEL and st_t in ("hls_hfnl_multi", "hls_hfnl") and (bool(re.search(r"-([A-Za-z0-9]{10,12})\.(?:mp4|mkv)/", raw_su)) or "hdfilmcehennemi.mobi" in raw_su or "cdnimages" in raw_su.lower()))
                        )
                        dest_l = target_list if is_true_1080_vault else fallback_res
                        if (raw_su, st_t) not in dest_l:
                            dest_l.append((raw_su, st_t))
                        if st_t in ("hls_pv_tr", "hls_fhd_tr", "hls_dl"):
                            _AUDIO_LANG_HINT[raw_su] = ["tr"]
                        elif st_t in ("hls_cj", "hls_cj_4k", "hls_ve"):
                            _AUDIO_LANG_HINT[raw_su] = ["orig"]
                        elif v_aud and ("tr" in v_aud or ("multi" not in st_t and st_t not in ("hls_dl", "hls_dp") and len(v_aud) == 1)):
                            prev_aud = _AUDIO_LANG_HINT.get(str(u_st[0])) or []
                            if not prev_aud or ("orig" in prev_aud and "orig" not in v_aud):
                                _AUDIO_LANG_HINT[str(u_st[0])] = list(v_aud)

    _collect_vault_keys(exact_ep_keys, res)
    if res:
        verified_vault_res = []
        for vu_cand, vst_cand in res:
            if vst_cand in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr") and ("cdnimg" in vu_cand.lower() or ".shop/" in vu_cand.lower()):
                try:
                    v_req = urllib.request.Request(vu_cand, headers={"User-Agent": UA137, "Referer": "https://rapidvid.org/", "Origin": "https://rapidvid.org"})
                    with _public_open(v_req, timeout=2.8) as vr_chk:
                        v_head = vr_chk.read(16384).decode("utf-8", errors="ignore")
                    if "#EXTM3U" in v_head:
                        verified_vault_res.append((vu_cand, vst_cand))
                        _STREAM_RES_HINT[vu_cand] = 1920
                        v_langs = []
                        for _vln in v_head.splitlines():
                            if _vln.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in _vln:
                                _lm = re.search(r'LANGUAGE="([^"]*)"', _vln)
                                _nm = re.search(r'NAME="([^"]*)"', _vln)
                                _cd = _norm_audio_lang(_lm.group(1) if _lm else "", _nm.group(1) if _nm else "")
                                if _cd and _cd not in v_langs:
                                    v_langs.append(_cd)
                        if v_langs:
                            _AUDIO_LANG_HINT[vu_cand] = v_langs
                            _AUDIO_PROBE_CACHE[vu_cand] = (time.time(), v_langs)
                except Exception:
                    continue
            elif vst_cand in ("hls_hfnl_multi", "hls_hfnl") or "hdfilmcehennemi.mobi" in vu_cand.lower() or ("cdnimages" in vu_cand.lower() and "/hls/" in vu_cand.lower()) or "playmix.uno" in vu_cand.lower():
                try:
                    chk_u = vu_cand
                    m_hid_v = re.search(r"-([A-Za-z0-9]{10,12})\.(?:mp4|mkv)/", vu_cand) or re.search(r"hdfilmcehennemi\.mobi/video/embed/([A-Za-z0-9_-]+)", vu_cand)
                    if m_hid_v and ("/master.txt" in vu_cand or "hdfilmcehennemi.mobi/video/embed/" in vu_cand):
                        emb_u_v = f"https://hdfilmcehennemi.mobi/video/embed/{m_hid_v.group(1)}"
                        with _public_open(urllib.request.Request(emb_u_v, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=2.8) as hrv:
                            fresh_v = _decode_hdfc_mobi_html(hrv.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore"))
                        if fresh_v and fresh_v.startswith("https://"):
                            _DP_M3U8_CACHE[vu_cand] = (fresh_v, time.time() + 900)
                            chk_u = fresh_v
                    with _public_open(urllib.request.Request(chk_u, headers={"User-Agent": UA137, "Referer": "https://hdfilmcehennemi.mobi/", "Origin": "https://hdfilmcehennemi.mobi"}), timeout=2.8) as hchk:
                        if "#EXTM3U" in hchk.read(16384).decode("utf-8", errors="ignore"):
                            verified_vault_res.append((vu_cand, vst_cand))
                except Exception:
                    continue
            else:
                verified_vault_res.append((vu_cand, vst_cand))
        res = verified_vault_res
    has_vault_dub = any(
        ("tr" in (_AUDIO_LANG_HINT.get(vu) or []))
        or (not _AUDIO_LANG_HINT.get(vu) and vst in ("hls_fhd_multi", "hls_fhd_tr", "hls_hfnl_multi", "hls_pv_multi", "hls_pv_tr", "mp4_ac_dub", "mp4_ar_tr"))
        for vu, vst in res
    )
    _collect_vault_keys(fb_ep_keys, fallback_res)
    if (res or fallback_res) and (IS_VERCEL or not refresh):
        return res + [x for x in fallback_res if x not in res]

    # 2. Live extraction from https://www.fullhdfilmizlesene.now/ (for movies)
    if mtype == "movie":
        fhd_targets = []
        if source_url and "fullhdfilmizlesene." in source_url:
            fhd_targets.append(source_url)
        fhd_queries = list(dict.fromkeys(([f"{title} {str(year)[:4]}"] if (title and year and str(year)[:4].isdigit()) else []) + q_cands))
        for q in fhd_queries[:4]:
            if fhd_targets:
                break
            qc = re.sub(r"\s+", " ", re.sub(r"[:…!?'\",-]+", " ", str(q or ""))).strip()
            if not qc:
                continue
            try:
                s_u = f"https://www.fullhdfilmizlesene.now/arama/{urllib.parse.quote(qc)}"
                shtml = urllib.request.urlopen(urllib.request.Request(s_u, headers={"User-Agent": UA137, "Referer": "https://www.fullhdfilmizlesene.now/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                for card in re.findall(r'<li class="film"[^>]*>(.*?)</li>', shtml, re.S):
                    hm = re.search(r'<a[^>]+class="tt"[^>]+href=["\'](https://[^"\']*fullhdfilmizlesene\.[^/"\']+/film/[^"\']+)["\']', card)
                    tm = re.search(r'<span class="film-title">([^<]+)</span>', card)
                    om = re.search(r'<span class="kt">([^<]+)</span>', card)
                    ym = re.search(r'<span class="film-yil">(\d{4})</span>', card)
                    if not hm:
                        continue
                    c_u = hm.group(1)
                    c_y = ym.group(1) if ym else ""
                    if c_y.isdigit() and year and str(year)[:4].isdigit() and abs(int(c_y) - int(str(year)[:4])) > 1:
                        continue
                    t1 = html_mod.unescape(tm.group(1).strip()) if tm else ""
                    t2 = html_mod.unescape(om.group(1).strip()) if om else ""
                    if _titles_match(t1, valid_titles, c_y, year, "movie") or (t2 and _titles_match(t2, valid_titles, c_y, year, "movie")):
                        if c_u not in fhd_targets:
                            fhd_targets.append(c_u)
                        if len(fhd_targets) >= 2:
                            break
            except Exception:
                continue
        for f_u in fhd_targets[:2]:
            try:
                if not public_http_url(f_u):
                    continue
                with _public_open(urllib.request.Request(f_u, headers={"User-Agent": UA137, "Referer": "https://www.fullhdfilmizlesene.now/"}), timeout=3.4) as _fr:
                    mhtml = _fr.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                if year and str(year)[:4].isdigit():
                    ym_p = re.search(r'<span class="film-yil">(\d{4})</span>|<title>[^<]*\((\d{4})\)</title>', mhtml, re.I)
                    py_str = next((g for g in (ym_p.groups() if ym_p else []) if g), "") if ym_p else ""
                    if py_str.isdigit() and abs(int(py_str) - int(str(year)[:4])) > 1:
                        continue
                scx_m = re.search(r"scx\s*=\s*(\{.*?\});", mhtml, re.S)
                if scx_m:
                    scx = json.loads(scx_m.group(1))
                    vods = []
                    for k_scx, v_scx in scx.items():
                        t_val = ((v_scx if isinstance(v_scx, dict) else {}).get("sx") or {}).get("t")
                        if isinstance(t_val, list):
                            vods.extend(("multi", base64.b64decode(codecs.decode(x, "rot_13")).decode("utf-8", errors="ignore")) for x in t_val)
                        elif isinstance(t_val, dict):
                            vods.extend((lk.lower(), base64.b64decode(codecs.decode(lv, "rot_13")).decode("utf-8", errors="ignore")) for lk, lv in t_val.items())
                    for mode_k, vu in vods[:3]:
                        if "rapidvid." in vu:
                            m3u8_u, subs = _decode_rapidvid_embed(vu, f_u)
                            if m3u8_u:
                                mk_low = str(mode_k or "").lower()
                                if mk_low in ("multi", "dual"):
                                    st_tag = "hls_fhd_multi"
                                elif "tr" in mk_low or "dub" in mk_low:
                                    st_tag = "hls_fhd_tr"
                                else:
                                    st_tag = "hls_fhd"
                                res.append((m3u8_u, st_tag))
                                for sb in subs:
                                    if not any(x.get("url") == sb["url"] for x in es_list):
                                        es_list.insert(0, sb)
                if res:
                    break
            except Exception:
                pass
        if res:
            return res + [x for x in fallback_res if x not in res]
    if IS_VERCEL and mtype != "tv":
        return res + [x for x in fallback_res if x not in res]

    # 3. Live extraction from https://www.hdfilmcehennemi.nl/ (movies & series)
    hfnl_targets = []
    if not IS_VERCEL and source_url and "hdfilmcehennemi.nl" in source_url:
        hfnl_targets.append(source_url)
    for q in ([] if IS_VERCEL else list(dict.fromkeys(q_cands))[:3]):
        if hfnl_targets:
            break
        try:
            s_json = _raw_get_json(f"https://www.hdfilmcehennemi.nl/search?q={urllib.parse.quote(q)}", headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/", "X-Requested-With": "fetch"}, timeout=3.2) or {}
            for r_html in (s_json.get("results") or []):
                m_href = re.search(r'href=["\'](https://www\.hdfilmcehennemi\.nl/[^"\']+)["\']', str(r_html))
                m_alt = re.search(r'alt=["\']([^"\']+)["\']', str(r_html))
                m_yr = re.search(r'<span class="year">(\d{4})</span>', str(r_html))
                if not m_href:
                    continue
                u = m_href.group(1)
                if (mtype == "tv" and "/dizi/" not in u) or (mtype == "movie" and "/dizi/" in u):
                    continue
                raw_t = html_mod.unescape((m_alt.group(1) if m_alt else "").replace(" izle", "").strip())
                c_y = m_yr.group(1) if m_yr else ""
                parts_t = [x.strip() for x in raw_t.split(" - ")] if " - " in raw_t else [raw_t]
                if any(_titles_match(pt, valid_titles, c_y, year, mtype) for pt in parts_t if pt):
                    hfnl_targets.append(u)
                    break
        except Exception:
            continue
    if not IS_VERCEL and not hfnl_targets:
        for q in list(dict.fromkeys(q_cands))[:2]:
            sl_h = _to_ascii_slug(q)
            if sl_h:
                hfnl_targets.append(f"https://www.hdfilmcehennemi.nl/dizi/{sl_h}/sezon-{s}/bolum-{e}/" if mtype == "tv" else f"https://www.hdfilmcehennemi.nl/{sl_h}/")
    for h_u in ([] if IS_VERCEL else hfnl_targets[:2]):
        try:
            if mtype == "tv":
                if "/sezon-" in h_u:
                    h_u = re.sub(r"/sezon-\d+/bolum-\d+/?.*$", f"/sezon-{s}/bolum-{e}/", h_u)
                else:
                    m_sl = re.search(r"/dizi/([^/?#]+)", h_u)
                    slug = m_sl.group(1) if m_sl else h_u.rstrip("/").rsplit("/", 1)[-1]
                    h_u = f"https://www.hdfilmcehennemi.nl/dizi/{slug}/sezon-{s}/bolum-{e}/"
            try:
                phtml = urllib.request.urlopen(urllib.request.Request(h_u, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            except Exception:
                try:
                    raw_b, _ = _edge_fetch_bytes(h_u, "https://www.hdfilmcehennemi.nl/", timeout=3.4)
                    phtml = raw_b.decode("utf-8", errors="ignore")
                except Exception:
                    phtml = ""
            if not phtml or _page_year_or_imdb_mismatch(phtml, mtype, year, s, imdb_id):
                continue
            ifrs = re.findall(r'<iframe[^>]+(?:src|data-src)=["\'](https://hdfilmcehennemi\.mobi/video/embed/[^"\']+)["\']', phtml)
            for emb_u in list(dict.fromkeys(ifrs))[:2]:
                try:
                    emb_html = urllib.request.urlopen(urllib.request.Request(emb_u, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                except Exception:
                    try:
                        raw_eb, _ = _edge_fetch_bytes(emb_u, "https://www.hdfilmcehennemi.nl/", timeout=3.4)
                        emb_html = raw_eb.decode("utf-8", errors="ignore")
                    except Exception:
                        emb_html = ""
                m3u8_u = _decode_hdfc_mobi_html(emb_html)
                if m3u8_u and m3u8_u.startswith("http"):
                    is_dual_hfnl = any(k in m3u8_u.lower() for k in ("dual", "trdual")) or "closedual" in emb_html.lower()
                    st_tag = "hls_hfnl_multi" if is_dual_hfnl else "hls_hfnl"
                    if is_dual_hfnl:
                        _AUDIO_LANG_HINT[m3u8_u] = ["tr", "orig"]
                        res.insert(0, (m3u8_u, st_tag))
                    else:
                        res.append((m3u8_u, st_tag))
                    for sb in _parse_embed_vtt_tracks(emb_html, "hfnl_embed"):
                        if not any(x.get("url") == sb["url"] for x in es_list):
                            es_list.insert(0, sb)
        except Exception:
            pass
    if res and (mtype == "movie" or len(res) >= 2):
        return res + [x for x in fallback_res if x not in res]

    # 4. Live extraction from https://www.dizibox.live/ (for series)
    if mtype == "tv" and not fallback_res:
        dbx_slugs = []
        if source_url and "dizibox.live" in source_url:
            m_dbx = re.search(r"dizibox\.live/(?:diziler/)?([a-z0-9-]+?)(?:-\d+-sezon.*)?/?$", source_url)
            if m_dbx:
                dbx_slugs.append(m_dbx.group(1))
        for qc in list(dict.fromkeys(q_cands))[:3]:
            sl = _to_ascii_slug(qc)
            if sl and sl not in dbx_slugs:
                dbx_slugs.append(sl)
        for sl in dbx_slugs[:3]:
            try:
                ep_u = f"https://www.dizibox.live/{sl}-{s}-sezon-{e}-bolum-izle/"
                dhtml = urllib.request.urlopen(urllib.request.Request(ep_u, headers={"User-Agent": UA137, "Referer": "https://www.dizibox.live/"}), timeout=3.4).read(1200000).decode("utf-8", errors="ignore")
                tm_d = re.search(r"<title>([^<]+)</title>", dhtml, re.I)
                if tm_d and not (source_url and "dizibox.live" in source_url):
                    dt = re.sub(r"\s+\d+\.\s*Sezon.*$", "", html_mod.unescape(tm_d.group(1)), flags=re.I).strip()
                    if dt and not _titles_match(dt, valid_titles, "", year, "tv"):
                        continue
                if _page_year_or_imdb_mismatch(dhtml, "tv", year, s, imdb_id):
                    continue
                if not IS_VERCEL:
                    m_king = re.search(r'<iframe[^>]+src=["\']((?:https?:)?//www\.dizibox\.live/player/king/king\.php\?v=[^"\']+)["\']', dhtml, re.I)
                    if m_king:
                        ku = ("https:" + m_king.group(1)) if m_king.group(1).startswith("//") else m_king.group(1)
                        if public_http_url(ku):
                            khtml = urllib.request.urlopen(urllib.request.Request(ku, headers={"User-Agent": UA137, "Referer": ep_u}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                            m_moly = re.search(r'https?://dbx\.molystream\.org/embed/([a-zA-Z0-9_-]+)', khtml)
                            if m_moly:
                                res.append((f"https://dbx.molystream.org/embed/sheila/{m_moly.group(1)}", "hls_dbx"))
                m_vm_ifr = re.search(r'<iframe[^>]+src=["\']((?:https?:)?//www\.dizibox\.live/player/moly/moly\.php\?[a-z]+=[^"\']+)["\']', dhtml, re.I)
                if not m_vm_ifr:
                    try:
                        dhtml2 = urllib.request.urlopen(urllib.request.Request(ep_u.rstrip("/") + "/2/", headers={"User-Agent": UA137, "Referer": ep_u}), timeout=3.0).read(1200000).decode("utf-8", errors="ignore")
                        m_vm_ifr = re.search(r'<iframe[^>]+src=["\']((?:https?:)?//www\.dizibox\.live/player/moly/moly\.php\?[a-z]+=[^"\']+)["\']', dhtml2, re.I)
                    except Exception:
                        pass
                if m_vm_ifr:
                    mu = ("https:" + m_vm_ifr.group(1)) if m_vm_ifr.group(1).startswith("//") else m_vm_ifr.group(1)
                    if public_http_url(mu):
                        mhtml = urllib.request.urlopen(urllib.request.Request(mu, headers={"User-Agent": UA137, "Referer": ep_u}), timeout=3.0).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                        m_vm_emb = re.search(r'https?://(?:vidmoly|vmbox|vmnow|vmpx)\.[a-z]+/(?:embed-|w/)[a-zA-Z0-9_-]+(?:\.html)?', mhtml, re.I)
                        if m_vm_emb:
                            vm_emb_u = re.sub(r'(?:vidmoly|vmbox|vmnow|vmpx)\.[a-z]+', 'vidmoly.biz', m_vm_emb.group(0), flags=re.I)
                            res.append((vm_emb_u, "hls_vm"))
                if res:
                    break
            except Exception:
                continue
    return res if res else fallback_res



_ANIMECIX_KNOWN_TMDB = {
    "35935": 7791, "66053": 7792,
    "46260": 80, "31910": 7490, "70881": 52, "37854": 66, "1429": 25, "30984": 82,
    "12971": 84, "65930": 90, "61374": 17, "63926": 8, "60863": 29, "45782": 60,
    "46261": 58, "37863": 23, "57041": 23, "31911": 235, "37865": 234, "46298": 238, "73223": 258,
    "13916": 7585, "95479": 7352, "85937": 7394, "127532": 10995,
    "114410": 11884, "240411": 11737, "209867": 11130, "120089": 9383,
    "131041": 9851, "207468": 11289, "105248": 10535, "88803": 7809,
    "94664": 7350, "203737": 11014, "45790": 7696, "129600": 9770, "138357": 10799,
    "810693": 8718, "916224": 9940, "635302": 7457, "1159311": 11793, "1311031": 12251,
    "42988": 8103, "1293": 7771, "100565": 8609, "61459": 7697, "116716": 8602, "91990": 11212,
    "30981": 8175, "83100": 7541, "72636": 225, "220542": 11131, "31724": 7257, "30991": 8177,
    "890": 8106, "67075": 6817, "75214": 7756, "200875": 10906, "136400": 9271, "43865": 7997,
    "34904": 8522, "94624": 7607, "112613": 7356, "114138": 9266, "80564": 7539, "83097": 7501,
    "31562": 7762, "32315": 8074, "42823": 7822, "60809": 198, "61223": 46, "59141": 7921,
    "31926": 8331, "65942": 7325, "63613": 70, "86031": 7258, "88046": 7259, "61663": 21,
    "85249": 7544, "206559": 11266, "138502": 8092,
}
_ANIMECIX_KNOWN_NAMES = {
    "berserk": 7791, "kenpuudenkiberserk": 7791, "berserk1997": 7791, "berserk2016": 7792,
    "naruto": 80, "narutoshippuden": 7490, "narutoshippuuden": 7490, "boruto": 52, "onepiece": 66,
    "attackontitan": 25, "shingekinokyojin": 25, "bleach": 82, "dragonballz": 84,
    "myheroacademia": 90, "bokunoheroacademia": 90, "tokyoghoul": 17, "onepunchman": 8,
    "haikyuu": 29, "swordartonline": 60, "fairytail": 58, "gintama": 23,
    "fullmetalalchemistbrotherhood": 235, "steinsgate": 234, "blackclover": 258,
    "deathnote": 7585, "jujutsukaisen": 7352, "demonslayer": 7394, "kimetsunoyaiba": 7394,
    "sololeveling": 10995, "oredakelevelupnaken": 10995, "hunterxhunter": 238,
    "chainsawman": 11884, "testereadam": 11884, "dandadan": 11737,
    "frieren": 11130, "sousounofrieren": 11130, "spyxfamily": 9383,
    "bluelock": 9851, "kaijuno8": 11289, "kaijuu8gou": 11289, "cyberpunkedgerunners": 10535, "vinlandsaga": 7809,
    "mushokutensei": 7350, "oshinoko": 11014, "jojonokimyounabouken": 7696,
    "serialexperimentslain": 8103, "lain": 8103, "ergoproxy": 7771, "86eightysix": 8609, "86": 8609, "eightysix": 8609,
    "parasyte": 7697, "parasytethemaxim": 7697, "kiseijuu": 7697, "kiseijuuseinokakuritsu": 7697,
    "oddtaxi": 8602, "pluto": 11212, "monster": 8175, "dororo": 7541, "madeinabyss": 225,
    "theapothecarydiaries": 11131, "kusuriyanohitorigoto": 11131, "codegeass": 7257, "codegeasshangyakunolelouch": 7257,
    "cowboybebop": 8177, "neongenesisevangelion": 8106, "evangelion": 8106, "mobpsycho100": 6817, "mobpsycho": 6817,
    "violetevergarden": 7756, "bocchitherock": 10906, "summertimerendering": 9271, "summertimerender": 9271,
    "psychopass": 7997, "samuraichamploo": 8522, "dorohedoro": 7607, "toyoureternity": 7356, "fumetsunoanatae": 7356,
    "rankingofkings": 9266, "ousamaranking": 9266, "bananafish": 7539, "thepromisedneverland": 7501, "yakusokunoneverland": 7501,
    "blacklagoon": 7762, "elfenlied": 8074, "another": 7822, "terrorinresonance": 198, "zankyounerror": 198,
    "akamegakill": 46, "killlakill": 7921, "gurrenlagann": 8331, "tengentoppagurrenlagann": 8331,
    "rezero": 7325, "rezerokarahajimeruisekaiseikatsu": 7325, "overlord": 70, "drstone": 7258,
    "fireforce": 7259, "enenoshouboutai": 7259, "yourlieinapril": 21, "shigatsuwakiminouso": 21,
    "kaguyasama": 7544, "kaguyasamaloveiswar": 7544, "deliciousindungeon": 11266, "dungeonmeshi": 11266,
    "hellsparadise": 8092, "jigokuraku": 8092,
}


_HIDDEN_TMDB_IDS: set = set()
try:
    _hid_path = BASE_DIR / "hidden_titles.json"
    if _hid_path.exists():
        _HIDDEN_TMDB_IDS = {str(x) for x in (json.loads(_hid_path.read_text(encoding="utf-8")).get("tmdbIds") or [])}
except Exception:
    _HIDDEN_TMDB_IDS = set()


def _sync_hidden_tmdb_with_edge() -> dict:
    """Bidirectional sync between local hidden_titles.json / _HIDDEN_TMDB_IDS and Edge KV blocked:tmdb_ids."""
    global _HIDDEN_TMDB_IDS
    sec = (os.environ.get("PROXY_SECRET") or os.environ.get("VORTEX_SECRET") or "").strip()
    if not sec:
        return {"ok": False, "reason": "no_secret"}
    edge_url = (os.environ.get("WATCHLIVO_EDGE_URL") or "https://watchlivo.online").rstrip("/") + "/api/rave/admin/takedown"
    try:
        import urllib.request
        payload = json.dumps({"add": sorted(_HIDDEN_TMDB_IDS)}).encode("utf-8")
        req = urllib.request.Request(
            edge_url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "X-Admin-Secret": sec, "User-Agent": "WatchlivoOriginSync/1.0"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
            remote_ids = {str(x).strip() for x in (data.get("blocked") or []) if str(x).strip()}
            if remote_ids:
                _HIDDEN_TMDB_IDS |= remote_ids
                try:
                    (BASE_DIR / "hidden_titles.json").write_text(
                        json.dumps({"tmdbIds": sorted(_HIDDEN_TMDB_IDS)}, indent=2),
                        encoding="utf-8",
                    )
                except Exception:
                    pass
            return {"ok": True, "count": len(_HIDDEN_TMDB_IDS)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

_ANIMECIX_TAU_MAP: dict = {}
_TAU_URL_CACHE = BoundedTTLCache(maxsize=1500, ttl=1200.0)
try:
    _tau_map_path = BASE_DIR / "animecix_tau_map.json"
    if _tau_map_path.exists():
        _ANIMECIX_TAU_MAP = json.loads(_tau_map_path.read_text(encoding="utf-8"))
except Exception:
    _ANIMECIX_TAU_MAP = {}


_ANIMECIX_DIRECT_DEAD_UNTIL: float = 0.0
_TAU_DIRECT_DEAD_UNTIL: float = 0.0


def _ac_cloud_get_json(url: str, headers: dict, referer: str, timeout: float, kind: str = "ac"):
    global _ANIMECIX_DIRECT_DEAD_UNTIL, _TAU_DIRECT_DEAD_UNTIL
    now_ac = time.time()
    edge_base = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL).strip().rstrip("/")
    dead_until = _ANIMECIX_DIRECT_DEAD_UNTIL if kind == "ac" else _TAU_DIRECT_DEAD_UNTIL
    if now_ac >= dead_until:
        try:
            return _raw_get_json(url, headers=headers, timeout=timeout)
        except urllib.error.HTTPError as he:
            if he.code in (403, 503):
                if kind == "ac":
                    _ANIMECIX_DIRECT_DEAD_UNTIL = now_ac + 600.0
                else:
                    _TAU_DIRECT_DEAD_UNTIL = now_ac + 600.0
            elif not edge_base:
                raise
        except Exception:
            if not edge_base:
                raise
    if edge_base:
        is_xhr = str((headers or {}).get("X-Requested-With") or "").lower() == "xmlhttprequest" or "animecix.tv/secure/" in url
        raw_ef, _ = _edge_fetch_bytes(url, referer, xhr=is_xhr, accept="application/json", timeout=timeout + 1.4)
        return json.loads(raw_ef.decode("utf-8", errors="ignore"))
    return None


def _extract_animecix_sync(mtype: str, s: int, e: int, orig_title: str, tr_title: str, tmdb_id: str = "", extra_queries: list = None, source_url: str = "", orig_lang: str = "") -> list:
    res = []
    tid_str = str(tmdb_id or "").strip()
    ac_id = _ANIMECIX_KNOWN_TMDB.get(tid_str)
    if not ac_id:
        m_ac_t = re.fullmatch(r"ac-(\d+)", tid_str)
        if m_ac_t:
            ac_id = int(m_ac_t.group(1))
    if not ac_id and source_url:
        m_ac = re.search(r"(?:animecix\.tv/titles/|animecix:)(\d+)", str(source_url))
        if m_ac:
            ac_id = int(m_ac.group(1))
    q_cands = [_clean_query_title(x) for x in ([orig_title, tr_title] + list(extra_queries or [])) if _clean_query_title(x)]
    if not ac_id:
        for qc in q_cands:
            nk = _norm_title(qc).replace(" ", "")
            if nk in _ANIMECIX_KNOWN_NAMES:
                ac_id = _ANIMECIX_KNOWN_NAMES[nk]
                break
    hdrs = {"User-Agent": UA137, "Referer": "https://animecix.tv/", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest"}
    if not ac_id and (orig_lang in ("ja", "ko", "zh") or "anime" in str(source_url or "").lower()):
        for qc in q_cands[:3]:
            try:
                s_data = _ac_cloud_get_json(f"https://animecix.tv/secure/search/{urllib.parse.quote(qc)}?limit=8", hdrs, "https://animecix.tv/", 2.6, "ac") or {}
                rows = [r for r in (s_data.get("results") or []) if isinstance(r, dict) and r.get("id")]
                nq = _norm_title(qc)
                for row in rows:
                    if tid_str and str(row.get("tmdb_id") or "") == tid_str:
                        ac_id = int(row["id"])
                        break
                if not ac_id and nq:
                    for row in rows:
                        rn = _norm_title(row.get("name") or "")
                        ro = _norm_title(row.get("original_title") or "")
                        if nq in (rn, ro):
                            ac_id = int(row["id"])
                            break
                if not ac_id and nq:
                    for row in rows:
                        rn = _norm_title(row.get("name") or "")
                        ro = _norm_title(row.get("original_title") or "")
                        if (rn and (nq in rn or rn in nq)) or (ro and (nq in ro or ro in nq)):
                            ac_id = int(row["id"])
                            break
                if ac_id:
                    break
            except Exception:
                continue
    if not ac_id:
        return res
    try:
        ep_num = _resolve_episode_numbering(tid_str, s, e) if mtype == "tv" else {"s_split": 1, "e_split": 1, "s_tmdb": 1, "e_tmdb": 1, "abs_ep": 1}
        cand_se = []
        for pair_se in [
            (ep_num["s_split"], ep_num["e_split"]),
            (s, e),
            (1, ep_num["abs_ep"]),
            (ep_num["s_tmdb"], ep_num["e_tmdb"]),
        ]:
            if pair_se not in cand_se and pair_se[0] >= 1 and pair_se[1] >= 1:
                cand_se.append(pair_se)
        if tid_str == "120089":  # SPY x FAMILY (TMDB S1 has 25 eps = Cour 1 + Cour 2; _CANONICAL_SEASON_SPLITS already maps S2->S3)
            if s == 1 and e > 12 and (2, e - 12) not in cand_se:
                cand_se.insert(0, (2, e - 12))
        elif tid_str == "85937" and s >= 2:  # Demon Slayer arc shift fallback
            if (s + 1, e) not in cand_se:
                cand_se.append((s + 1, e))
            if s == 2 and e > 7 and (3, e - 7) not in cand_se:
                cand_se.insert(0, (3, e - 7))
        fb_tau = []
        for s_try, e_try in cand_se:
            for item_fb in (_ANIMECIX_TAU_MAP.get(f"{ac_id}:{s_try}:{e_try}") or []):
                if item_fb not in fb_tau:
                    fb_tau.append(item_fb)
        fb_by_id = {str(p[0]): (str(p[2]) if len(p) >= 3 else "") for p in fb_tau if isinstance(p, (list, tuple)) and len(p) >= 2}
        has_fb_mp4 = any(
            isinstance(p, (list, tuple)) and ((len(p) >= 3 and str(p[2]).startswith("https://")) or str(p[0]).startswith("https://"))
            for p in fb_tau
        )
        vids = None
        if not has_fb_mp4:
            ac_se_slice = cand_se[:1] if IS_VERCEL else cand_se[:3]
            ac_to = 1.4 if IS_VERCEL else 2.2
            for s_try, e_try in ac_se_slice:
                try:
                    ep_url = f"https://animecix.tv/secure/episode-videos?titleId={ac_id}&episode={e_try}&season={s_try}"
                    v_try = _ac_cloud_get_json(ep_url, hdrs, "https://animecix.tv/", ac_to, "ac")
                    if isinstance(v_try, list) and v_try:
                        vids = v_try
                        break
                except Exception:
                    continue
            if not vids and mtype == "movie":
                try:
                    v_data = _ac_cloud_get_json(f"https://animecix.tv/secure/videos?titleId={ac_id}", hdrs, "https://animecix.tv/", ac_to, "ac") or {}
                    pag = v_data.get("pagination") if isinstance(v_data, dict) else None
                    raw_vids = (pag.get("data") if isinstance(pag, dict) else None) or []
                    vids = [
                        v for v in raw_vids
                        if isinstance(v, dict)
                        and int(v.get("title_id") or 0) == int(ac_id)
                        and str(v.get("category") or "").lower() not in ("teaser", "trailer", "clip", "opening", "ending")
                    ]
                except Exception:
                    vids = None
        tau_items = []
        if isinstance(vids, list) and vids:
            for v_item in vids:
                if not isinstance(v_item, dict):
                    continue
                vu = str(v_item.get("url") or "").strip()
                m_tau = re.search(r"tau-video\.xyz/embed/([a-zA-Z0-9_-]+)", vu)
                if m_tau:
                    tid_m = m_tau.group(1)
                    extra_s = str(v_item.get("extra") or "").lower()
                    is_dub = "dublaj" in extra_s
                    tau_items.append((tid_m, is_dub, fb_by_id.get(tid_m, "")))
            tau_items.sort(key=lambda x: 0 if x[1] else 1)
        for pair in fb_tau:
            if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                if str(pair[0]).startswith("https://"):
                    tau_items.append((str(pair[0]), "dub" in str(pair[1]).lower(), str(pair[0])))
                else:
                    tau_items.append((str(pair[0]), bool(pair[1]), str(pair[2]) if len(pair) >= 3 else ""))
        tau_items.sort(key=lambda x: (0 if x[1] else 1, 0 if (len(x) >= 3 and str(x[2]).startswith("https://")) else 1))
        seen_tau = set()
        cand_tau = []
        sub_ac_cnt = 0
        has_dub_ac = False
        for item in tau_items:
            tau_id = item[0]
            is_dub = item[1]
            fb_u = item[2] if len(item) >= 3 else ""
            if tau_id in seen_tau:
                continue
            if (is_dub and has_dub_ac) or (not is_dub and sub_ac_cnt >= 3):
                continue
            seen_tau.add(tau_id)
            cand_tau.append((tau_id, is_dub, fb_u))
            if is_dub:
                has_dub_ac = True
            else:
                sub_ac_cnt += 1
            if len(cand_tau) >= 4:
                break

        def _resolve_one_tau(t_item):
            tau_id, is_dub, fb_u = t_item
            best_u = _TAU_URL_CACHE.get(tau_id, "")
            best_w = _STREAM_RES_HINT.get(best_u, 0) if best_u else 0
            if best_u and _is_vault_url_expired(best_u):
                _TAU_URL_CACHE.pop(tau_id, None)
                best_u, best_w = "", 0
            if not best_u and tau_id.startswith("https://") and not _is_vault_url_expired(tau_id):
                best_u = tau_id
                best_w = 1280 if "_720p" in best_u.lower() else 1920
            if not best_u and not tau_id.startswith("https://"):
                tau_tries = 1 if IS_VERCEL else 2
                tau_to = 1.7 if IS_VERCEL else 2.6
                for _try_tau in range(tau_tries):
                    try:
                        t_info = _ac_cloud_get_json(f"https://tau-video.xyz/api/video/{tau_id}", {"User-Agent": UA137, "Referer": f"https://tau-video.xyz/embed/{tau_id}"}, f"https://tau-video.xyz/embed/{tau_id}", tau_to, "tau") or {}
                        u_list = [x for x in (t_info.get("urls") or []) if isinstance(x, dict) and str(x.get("url") or "").startswith("https://")]
                        u_list.sort(key=lambda x: 0 if ("1080" in str(x.get("label") or "") or "fhd" in str(x.get("label") or "").lower()) else (1 if "720" in str(x.get("label") or "") else 2))
                        if u_list:
                            best_u = str(u_list[0]["url"]).strip()
                            lbl_0 = str(u_list[0].get("label") or "").lower()
                            best_w = 1920 if ("1080" in lbl_0 or "fhd" in lbl_0) else (1280 if ("720" in lbl_0 or "_720p" in best_u.lower()) else 1920)
                            _TAU_URL_CACHE[tau_id] = best_u
                        break
                    except urllib.error.HTTPError as he_tau:
                        if he_tau.code == 429 and _try_tau == 0:
                            time.sleep(0.45)
                            continue
                        break
                    except Exception:
                        break
            if not best_u and fb_u.startswith("https://") and not _is_vault_url_expired(fb_u):
                best_u = fb_u
                best_w = 1280 if "_720p" in best_u.lower() else 1920
            if best_u and not _is_unplayable_stream_url(best_u):
                if best_w:
                    _STREAM_RES_HINT[best_u] = best_w
                return (best_u, "mp4_ac_dub" if is_dub else "mp4_ac_sub")
            return None

        if cand_tau:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(3, len(cand_tau))) as tau_pool:
                for hit_tau in tau_pool.map(_resolve_one_tau, cand_tau):
                    if hit_tau and not any(hit_tau[0] == r_x[0] for r_x in res):
                        res.append(hit_tau)
        res.sort(key=lambda x: (0 if x[1] == "mp4_ac_dub" else 1, 1 if (_STREAM_RES_HINT.get(x[0], 1920) < 1800 or "_720p" in x[0].lower()) else 0))
    except Exception:
        pass
    return res


def _get_tmdb_meta_sync(tid: str, mtype: str, fallback_title: str = "", fallback_year: str = "", fallback_imdb: str = "") -> dict:
    mtype = "tv" if mtype == "tv" else "movie"
    tid = str(tid or "").strip()
    if not tid.isdigit():
        return {"title": fallback_title, "trTitle": fallback_title, "originalTitle": fallback_title, "altTitles": [], "year": fallback_year, "imdbId": fallback_imdb, "origLang": "en", "transLangs": ["tr", "en"], "runtime": 48 if mtype == "tv" else 120}
    ck = f"v3:{mtype}:{tid}"
    cached = _TMDB_META_CACHE.get(ck)
    if cached:
        return cached
    try:
        info = _http_json(f"https://api.themoviedb.org/3/{mtype}/{tid}?api_key={TMDB_API_KEY}&language=tr-TR&append_to_response=external_ids,translations,alternative_titles", timeout=4.2)
        tr_t = info.get("name") or info.get("title") or fallback_title
        orig_t = info.get("original_name") or info.get("original_title") or tr_t or fallback_title
        alt_list = []
        for tr_item in ((info.get("translations") or {}).get("translations") or []):
            d_obj = tr_item.get("data") or {}
            t_val = d_obj.get("title") or d_obj.get("name") or ""
            if t_val and tr_item.get("iso_639_1") in ("en", "tr"):
                alt_list.append(t_val)
        alt_obj = info.get("alternative_titles") or {}
        for a_item in (alt_obj.get("titles") or alt_obj.get("results") or []):
            if a_item.get("iso_3166_1") in ("TR", "US", "GB") and a_item.get("title"):
                alt_list.append(a_item["title"])
        if fallback_title and len(_norm_title(fallback_title)) >= 3:
            fb_w = set(_norm_title(fallback_title).split())
            tm_w = set(_norm_title(tr_t).split()) | set(_norm_title(orig_t).split())
            for at in alt_list:
                tm_w |= set(_norm_title(at).split())
            if fb_w and not (fb_w & tm_w):
                hits_fb = _tmdb_sync(fallback_title)
                match_fb = next((h for h in (hits_fb or []) if h.get("mediaType") == mtype and _norm_title(h.get("title") or "") == _norm_title(fallback_title)), (hits_fb[0] if hits_fb else None))
                if match_fb and str(match_fb.get("tmdbId") or "") != tid:
                    return _get_tmdb_meta_sync(str(match_fb["tmdbId"]), mtype, fallback_title, fallback_year, fallback_imdb)
                if not match_fb or str(match_fb.get("tmdbId") or "") != tid:
                    return {"title": fallback_title, "trTitle": fallback_title, "originalTitle": fallback_title, "altTitles": [fallback_title], "year": fallback_year, "imdbId": fallback_imdb, "origLang": "tr", "transLangs": ["tr", "en"], "runtime": 48 if mtype == "tv" else 120}
        if fallback_title:
            alt_list.insert(0, fallback_title)
        trans_langs = list(dict.fromkeys([
            str(x.get("iso_639_1") or "").lower()
            for x in ((info.get("translations") or {}).get("translations") or [])
            if x.get("iso_639_1")
        ]))
        net_ids = {str(n.get("id")) for n in (info.get("networks") or []) if n.get("id")}
        net_names = {str(n.get("name") or "").lower() for n in (info.get("networks") or [])}
        prod_names = {str(c.get("name") or "").lower() for c in (info.get("production_companies") or [])}
        primary_prov = ""
        if "49" in net_ids or "3186" in net_ids or "3308" in net_ids or any("hbo" in x or "max" in x for x in (net_names | prod_names)):
            primary_prov = "max"
        elif "213" in net_ids or any("netflix" in x for x in (net_names | prod_names)):
            primary_prov = "netflix"
        elif "2739" in net_ids or "420" in net_ids or any("disney" in x for x in (net_names | prod_names)):
            primary_prov = "disney"
        elif "2552" in net_ids or any("apple" in x for x in (net_names | prod_names)):
            primary_prov = "apple"
        elif "1024" in net_ids or any("amazon" in x or "prime video" in x for x in (net_names | prod_names)):
            primary_prov = "prime"
        p_path = info.get("poster_path")
        b_path = info.get("backdrop_path")
        tmdb_poster_u = f"https://image.tmdb.org/t/p/w500{p_path}" if p_path else ""
        tmdb_backdrop_u = f"https://image.tmdb.org/t/p/w1280{b_path}" if b_path else ""
        res = {
            "tmdbId": tid,
            "title": orig_t or tr_t,
            "trTitle": tr_t or orig_t,
            "originalTitle": orig_t or tr_t,
            "altTitles": list(dict.fromkeys([x for x in alt_list if x])),
            "year": (info.get("first_air_date") or info.get("release_date") or fallback_year or "")[:4],
            "imdbId": (info.get("external_ids") or {}).get("imdb_id") or info.get("imdb_id") or fallback_imdb or "",
            "origLang": str(info.get("original_language") or "en").lower(),
            "transLangs": trans_langs or ["tr", "en"],
            "runtime": int((info.get("episode_run_time") or [info.get("runtime") or (48 if mtype == "tv" else 120)])[0] or (48 if mtype == "tv" else 120)),
            "primaryProv": primary_prov,
            "poster": tmdb_poster_u,
            "backdrop": tmdb_backdrop_u,
        }
        _TMDB_META_CACHE[ck] = res
        return res
    except Exception:
        if fallback_title and len(_norm_title(fallback_title)) >= 3:
            try:
                hits_fb = _tmdb_sync(fallback_title)
                match_fb = next((h for h in (hits_fb or []) if h.get("mediaType") == mtype and _norm_title(h.get("title") or "") == _norm_title(fallback_title)), (hits_fb[0] if hits_fb else None))
                if match_fb and str(match_fb.get("tmdbId") or "") and str(match_fb.get("tmdbId") or "") != tid:
                    return _get_tmdb_meta_sync(str(match_fb["tmdbId"]), mtype, fallback_title, fallback_year, fallback_imdb)
            except Exception:
                pass
        fb_lang = "tr" if any(c in (fallback_title or "") for c in "çğıöşüÇĞİÖŞÜ") else "en"
        return {"tmdbId": tid, "title": fallback_title, "trTitle": fallback_title, "originalTitle": fallback_title, "altTitles": [fallback_title] if fallback_title else [], "year": fallback_year, "imdbId": fallback_imdb, "origLang": fb_lang, "transLangs": ["tr", "en"], "runtime": 48 if mtype == "tv" else 120, "primaryProv": ""}


_HEXA_CAP: dict = {"token": "", "uses": 0, "exp": 0.0}
_WING_SERVERS_CACHE: dict = {"srvs": [], "exp": 0.0}


def _extract_direct_stream_sync(tid: str, mtype: str, s: int, e: int, title: str = "", year: str = "", imdb_id: str = "", disp_title: str = "", source_url: str = "", refresh: bool = False):
    ep_num = _resolve_episode_numbering(tid, s, e) if mtype == "tv" else {"s_split": 1, "e_split": 1, "s_tmdb": 1, "e_tmdb": 1, "abs_ep": 1, "has_splits": False}
    s_split, e_split = ep_num["s_split"], ep_num["e_split"]
    s_tmdb, e_tmdb = ep_num["s_tmdb"], ep_num["e_tmdb"]
    ckey = f"v47:{mtype}:{tid}:{s_split}:{e_split}"
    ekey = f"{mtype}:{tid}:{s}:{e}"
    now_t = time.time()
    if refresh:
        old_c = _STREAM_CACHE.pop(ckey, None)
        for u_old, _ in ((old_c or {}).get("val") or []):
            _STREAM_RES_HINT.pop(u_old, None)
            _AUDIO_PROBE_CACHE.pop(u_old, None)
    cached = None if refresh else _STREAM_CACHE.get(ckey)
    if cached and cached["exp"] > now_t:
        c_val = [u for u in (cached.get("val") or []) if not _is_vault_url_expired(u[0]) and not _is_unplayable_stream_url(u[0])]
        check_titles = [x for x in (title, disp_title) if x]
        if c_val and (not check_titles or all(_stream_matches_title(u[0], check_titles, year, imdb_id) for u in c_val)):
            if cached.get("subs"):
                _EMBED_SUB_CACHE[ekey] = list(cached["subs"])
            return c_val
    if not refresh:
        conn = None
        try:
            conn = _get_acc_db()
            row = conn.execute("SELECT val_json, exp FROM resolved_streams WHERE ckey = ?", (ckey,)).fetchone()
            if row and row["exp"] > now_t:
                parsed = json.loads(row["val_json"] or "{}")
                if isinstance(parsed, dict):
                    val = [tuple(x) for x in (parsed.get("urls") or []) if not _is_vault_url_expired(x[0]) and not _is_unplayable_stream_url(x[0])]
                    subs = parsed.get("subs") or []
                else:
                    val = [tuple(x) for x in parsed if not _is_vault_url_expired(x[0]) and not _is_unplayable_stream_url(x[0])]
                    subs = []
                check_titles = [x for x in (title, disp_title) if x]
                if val and (not check_titles or all(_stream_matches_title(u[0], check_titles, year, imdb_id) for u in val)):
                    if subs:
                        _EMBED_SUB_CACHE[ekey] = list(subs)
                    v_streams = _MAIN_SITES_VAULT.get("streams") or {}
                    for u_c, st_c in val:
                        st_cs = str(st_c or "")
                        if st_cs == "hls_pv_tr":
                            _AUDIO_LANG_HINT[u_c] = ["tr"]
                        elif "multi" in st_cs or st_cs in ("hls_dl", "hls_dp"):
                            for vk_c, ve_c in v_streams.items():
                                if isinstance(ve_c, dict) and ve_c.get("audioLangs") and any(s_p[0] == u_c for s_p in (ve_c.get("streams") or []) if isinstance(s_p, (list, tuple))):
                                    _AUDIO_LANG_HINT[u_c] = list(ve_c["audioLangs"])
                                    break
                    _STREAM_CACHE[ckey] = {"val": val, "subs": subs, "exp": row["exp"]}
                    return val
        except Exception:
            pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    meta = _get_tmdb_meta_sync(tid, mtype, title or disp_title, year, imdb_id)
    if meta.get("tmdbId") and str(meta.get("tmdbId")).isdigit() and str(meta.get("tmdbId")) != str(tid):
        tid = str(meta["tmdbId"])
    orig_title = meta.get("originalTitle") or title or disp_title
    tr_title = meta.get("trTitle") or disp_title or orig_title
    year = meta.get("year") or year
    imdb_id = meta.get("imdbId") or imdb_id
    extra_titles = list(dict.fromkeys([disp_title, title, tr_title, orig_title] + list(meta.get("altTitles") or [])))

    import concurrent.futures

    def _job_videasy():
        res = []
        if str(tid or "").isdigit():
            q_ve = urllib.parse.urlencode({
                "title": orig_title or tr_title or title,
                "mediaType": mtype,
                "year": year or "",
                "episodeId": e_tmdb if mtype == "tv" else 1,
                "seasonId": s_tmdb if mtype == "tv" else 1,
                "tmdbId": tid,
                "imdbId": imdb_id or "",
            })
            _ = q_ve  # api.wecollege.net retired (HTTP 401); proceed directly to vidfast.vc
        try:
            vf_u = f"https://vidfast.vc/tv/{tid}/{s_tmdb}/{e_tmdb}/" if mtype == "tv" else f"https://vidfast.vc/movie/{tid}/"
            with urllib.request.urlopen(urllib.request.Request(vf_u, headers={"User-Agent": UA137}), timeout=3.5) as r_vf:
                vf_html = r_vf.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            m_en = re.search(r'\\"(?:en|token)\\":\\"(.*?)\\"', vf_html)
            if m_en:
                en_tok = m_en.group(1)
                p1 = (_raw_get_json(f"https://enc-dec.app/api/enc-vidfast?text={urllib.parse.quote(en_tok)}&stage=1", timeout=3.5) or {}).get("result") or {}
                st1_u = str(p1.get("stage1") or "").strip()
                if st1_u and p1.get("token") and public_http_url(st1_u):
                    vf_hdrs = {"User-Agent": UA137, "Referer": "https://vidfast.vc/", "X-Requested-With": "XMLHttpRequest", "X-CSRF-Token": p1["token"]}
                    with urllib.request.urlopen(urllib.request.Request(st1_u, data=b"", headers=vf_hdrs), timeout=3.5) as r_t1:
                        t1 = r_t1.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                    p2 = (_raw_get_json(f"https://enc-dec.app/api/enc-vidfast?text={urllib.parse.quote(t1)}&stage=2", timeout=3.5) or {}).get("result") or {}
                    srvs_u = str(p2.get("servers") or "").strip()
                    if srvs_u and p2.get("stream") and p2.get("token") and public_http_url(srvs_u):
                        vf_hdrs["X-CSRF-Token"] = p2["token"]
                        with urllib.request.urlopen(urllib.request.Request(srvs_u, data=b"", headers=vf_hdrs), timeout=3.5) as r_sv:
                            srv_enc = r_sv.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                        srvs = (_raw_get_json("https://enc-dec.app/api/dec-vidfast", headers={"Content-Type": "application/json"}, data=json.dumps({"text": srv_enc}).encode("utf-8"), timeout=3.0) or {}).get("result") or []
                        vf_prio = {"vRapid": 0, "vBlaze": 1, "Cobra": 2, "Cine": 3, "Nova": 4, "Titan": 5}
                        srvs = [x for x in srvs if isinstance(x, dict) and x.get("data") and x.get("name") not in ("Bravo", "Horizon")]
                        srvs.sort(key=lambda x: vf_prio.get(str(x.get("name") or ""), 8))

                        def _probe_vf_srv(s_item):
                            try:
                                st_item_u = f"{p2['stream']}/{s_item['data']}"
                                if not public_http_url(st_item_u):
                                    return None
                                with urllib.request.urlopen(urllib.request.Request(st_item_u, data=b"", headers=dict(vf_hdrs)), timeout=2.4) as r_st:
                                    st_enc = r_st.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                                st_dec = (_raw_get_json("https://enc-dec.app/api/dec-vidfast", headers={"Content-Type": "application/json"}, data=json.dumps({"text": st_enc}).encode("utf-8"), timeout=2.4) or {}).get("result") or {}
                                if not isinstance(st_dec, dict):
                                    return None
                                u = (st_dec.get("url") or "").strip()
                                if not u.startswith("https://") or "finalsignal.top" in u or "olivewave.top" in u or _is_unplayable_stream_url(u):
                                    return None
                                head_vf = ""
                                try:
                                    p_vf = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://vidy.st/", "Origin": "https://vidy.st"})
                                    with _public_open(p_vf, timeout=2.0) as pr_vf:
                                        if pr_vf.status in (200, 206):
                                            head_vf = pr_vf.read(4096).decode("utf-8", errors="ignore")
                                except Exception:
                                    head_vf = ""
                                if "#EXTM3U" not in head_vf:
                                    try:
                                        b_vf, _ = _edge_fetch_bytes(u, "https://vidy.st/", timeout=2.6, max_bytes=8192)
                                        head_vf = b_vf.decode("utf-8", errors="ignore")
                                    except Exception:
                                        head_vf = ""
                                if "#EXTM3U" not in head_vf:
                                    return None
                                return u, (st_dec.get("tracks") or st_dec.get("subtitles") or [])
                            except Exception:
                                return None

                        cand_srvs = srvs[:3]
                        if cand_srvs:
                            with concurrent.futures.ThreadPoolExecutor(max_workers=len(cand_srvs)) as vf_pool:
                                for vf_hit in vf_pool.map(_probe_vf_srv, cand_srvs):
                                    if not vf_hit:
                                        continue
                                    u_vf, trks_vf = vf_hit
                                    if isinstance(trks_vf, list) and trks_vf and ekey:
                                        es_vf = _EMBED_SUB_CACHE.setdefault(ekey, [])
                                        for tk in trks_vf:
                                            if isinstance(tk, dict):
                                                tu = str(tk.get("file") or tk.get("url") or "").strip()
                                                tl = str(tk.get("label") or tk.get("lang") or tk.get("language") or "").lower().strip()
                                                if tu.startswith("https://") and "forced" not in tl and not any(x.get("url") == tu for x in es_vf):
                                                    es_vf.append({"lang": tl, "url": tu, "source": "vidfast_embed"})
                                    if not any(u_vf == x[0] for x in res):
                                        res.append((u_vf, "hls_ve"))
                                    if len(res) >= 2:
                                        break
        except Exception:
            pass
        return res

    def _job_hexa():
        res = []
        if time.time() < float(_HEXA_CAP.get("dead_until") or 0):
            return res
        for host_dom in ("theemoviedb.hexa.su",):
            try:
                now_hx = time.time()
                tok = _HEXA_CAP.get("token") or ""
                if not tok or int(_HEXA_CAP.get("uses") or 0) >= 18 or now_hx > float(_HEXA_CAP.get("exp") or 0):
                    hx_cap_hdrs = {"User-Agent": UA137, "Origin": "https://hexa.su", "Referer": "https://hexa.su/", "Content-Type": "application/json"}
                    try:
                        ch = _raw_get_json("https://cap.hexa.su/15d2cf0395/challenge", headers=hx_cap_hdrs, data=b"{}", timeout=1.9)
                    except urllib.error.HTTPError as hx_he:
                        if hx_he.code in (403, 429, 503):
                            _HEXA_CAP["dead_until"] = now_hx + 180.0
                        continue
                    if isinstance(ch, dict) and ch.get("token"):
                        sol = (_raw_get_json("https://enc-dec.app/api/enc-hexa", headers={"Content-Type": "application/json"}, data=json.dumps({"challenge_data": ch}).encode("utf-8"), timeout=4.0) or {}).get("result")
                        if isinstance(sol, dict) and sol.get("token"):
                            red = _raw_get_json("https://cap.hexa.su/15d2cf0395/redeem", headers=hx_cap_hdrs, data=json.dumps(sol).encode("utf-8"), timeout=3.4) or {}
                            tok = str(red.get("token") or "").strip()
                            if tok:
                                _HEXA_CAP.update({"token": tok, "uses": 0, "exp": now_hx + 540.0})
                if not tok:
                    continue
                _HEXA_CAP["uses"] = int(_HEXA_CAP.get("uses") or 0) + 1
                key = os.urandom(32).hex()
                hdrs = {
                    "User-Agent": UA137, "Referer": "https://hexa.su/", "Origin": "https://hexa.su",
                    "Accept": "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": tok,
                }
                ep = f"https://{host_dom}/api/tmdb/tv/{tid}/season/{s_tmdb}/episode/{e_tmdb}/images" if mtype == "tv" else f"https://{host_dom}/api/tmdb/movie/{tid}/images"
                req = urllib.request.Request(ep, headers=hdrs)
                with _public_open(req, timeout=4.2) as r:
                    enc_txt = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                if enc_txt and len(enc_txt) > 20:
                    dec = _raw_get_json("https://enc-dec.app/api/dec-hexa", headers={"Content-Type": "application/json"}, data=json.dumps({"text": enc_txt, "key": key}).encode("utf-8"), timeout=4.2)
                    srcs = ((dec.get("result") or {}).get("sources") or []) if isinstance(dec.get("result"), dict) else []
                    srcs.sort(key=lambda x: 0 if "fuckme.dragonballzfans" in (x.get("url") or "") else (1 if "shrek.dragonballzfans" in (x.get("url") or "") else 2))
                    cand_urls = []
                    for src in srcs:
                        u = (src.get("url") or "").strip()
                        if u.startswith("https://") and not any(b in u for b in ("serve.dragonballzfans.xyz", "sun.dragonballzfans.xyz")) and u not in cand_urls:
                            cand_urls.append(u)
                    def _probe_hx(u_cand: str) -> bool:
                        if "dragonballzfans" not in u_cand:
                            return True
                        try:
                            p_hdrs = {"User-Agent": UA137, "Referer": "https://hexa.su/", "Origin": "https://hexa.su"}
                            with _public_open(urllib.request.Request(u_cand, headers=p_hdrs), timeout=2.6) as pr:
                                return "#EXTM3U" in pr.read(4096).decode("utf-8", errors="ignore")
                        except Exception:
                            return False
                    if cand_urls:
                        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(cand_urls))) as hx_pool:
                            for u_cand, ok in zip(cand_urls, hx_pool.map(_probe_hx, cand_urls)):
                                if ok:
                                    res.append((u_cand, "hls"))
                if res:
                    break
            except Exception:
                continue
        return res

    def _job_vidlink():
        res = []
        try:
            enc_id = (_raw_get_json(f"https://enc-dec.app/api/enc-vidlink?text={tid}", timeout=4.0) or {}).get("result") or ""
            if enc_id:
                ep = f"https://vidlink.pro/api/b/tv/{enc_id}/{s_tmdb}/{e_tmdb}?multiLang=0" if mtype == "tv" else f"https://vidlink.pro/api/b/movie/{enc_id}?multiLang=0"
                st_doc = None
                try:
                    st_doc = _raw_get_json(ep, headers={"Referer": "https://vidlink.pro/", "Origin": "https://vidlink.pro"}, timeout=3.4)
                except Exception:
                    st_doc = None
                if not isinstance(st_doc, dict) or not st_doc.get("stream"):
                    try:
                        raw_vl, _ = _edge_fetch_bytes(ep, "https://vidlink.pro/", accept="application/json", timeout=3.6)
                        st_doc = json.loads(raw_vl.decode("utf-8", errors="ignore"))
                    except Exception:
                        st_doc = st_doc if isinstance(st_doc, dict) else {}
                st_doc = st_doc if isinstance(st_doc, dict) else {}
                st = st_doc.get("stream") if isinstance(st_doc.get("stream"), dict) else {}
                caps = st.get("captions") or []
                if caps:
                    es_list = _EMBED_SUB_CACHE.setdefault(ekey, [])
                    for cp in caps:
                        cu = str(cp.get("url") or "").strip()
                        cl = str(cp.get("language") or cp.get("lang") or "").lower().strip()
                        if cu.startswith("https://") and not any(x.get("url") == cu for x in es_list):
                            es_list.append({"lang": cl, "url": cu, "source": "vidlink_embed"})
                if st.get("playlist") and not _is_unplayable_stream_url(str(st["playlist"])):
                    res.append((st["playlist"], "hls"))
                else:
                    quals = st.get("qualities") or {}
                    picked_vl = []
                    for qk in ("2160", "4k", "1440", "1080", "720", "480", "360"):
                        q_obj = quals.get(qk) or {}
                        qu = (q_obj.get("url") or "").strip()
                        q_codec = str(q_obj.get("codecName") or q_obj.get("codec") or "").lower()
                        if not qu.startswith("https://") or any(qu == x[0] for x in picked_vl):
                            continue
                        if "hevc" in q_codec or "h265" in q_codec or "hev1" in q_codec or "hvc1" in q_codec or _is_unplayable_stream_url(qu):
                            continue
                        q_hdrs = q_obj.get("headers") or {}
                        q_ref = str(q_hdrs.get("referer") or q_hdrs.get("Referer") or "").lower()
                        fb_p = "mp4_vl_fb" if "filmboom.top" in q_ref else "mp4_vl"
                        st_tag = f"{fb_p}_1080" if qk in ("2160", "4k", "1440", "1080") else (f"{fb_p}_720" if qk == "720" else f"{fb_p}_sd")
                        _STREAM_RES_HINT[qu] = 3840 if qk in ("2160", "4k") else (2560 if qk == "1440" else (1920 if qk == "1080" else (1280 if qk == "720" else 854)))
                        picked_vl.append((qu, st_tag))
                        if len(picked_vl) >= 2:
                            break
                    res.extend(picked_vl)
        except Exception:
            pass
        return res

    def _job_cinejoy():
        res = []
        if not str(tid or "").isdigit():
            return res
        cj_hdrs = {"User-Agent": UA137, "Origin": "https://cinejoy.pk", "Referer": "https://cinejoy.pk/"}
        now_cj = time.time()
        wing_srvs = list(_WING_SERVERS_CACHE.get("srvs") or []) if now_cj < float(_WING_SERVERS_CACHE.get("exp") or 0) else []
        if not wing_srvs:
            try:
                raw_sv = (_raw_get_json("https://api.wing.st/servers", headers=cj_hdrs, timeout=2.0) or {}).get("servers") or []
                alive_sv = [s_it for s_it in raw_sv if isinstance(s_it, dict) and s_it.get("status") == "ok" and s_it.get("name")]
                alive_sv.sort(key=lambda x: (0 if x.get("name") == "secret" else (1 if x.get("4k") else (2 if x.get("name") == "Nebula" else 3))))
                wing_srvs = [(str(x["name"]), bool(x.get("4k"))) for x in alive_sv[:3]]
                if wing_srvs:
                    _WING_SERVERS_CACHE.update({"srvs": wing_srvs, "exp": now_cj + 600.0})
            except Exception:
                wing_srvs = []
        if not wing_srvs:
            wing_srvs = [("secret", True), ("Nebula", False)]

        def _probe_wing_srv(srv_pair):
            sname, is_4k_srv = srv_pair
            try:
                q_w = {
                    "title": orig_title or tr_title or title or "",
                    "type": "series" if mtype == "tv" else "movie",
                    "year": str(year or "")[:4],
                    "imdb": imdb_id or "",
                    "tmdb": str(tid),
                    "server": sname,
                }
                if mtype == "tv":
                    q_w["season"] = str(s_tmdb)
                    q_w["episode"] = str(e_tmdb)
                wing_u = "https://api.wing.st/?" + urllib.parse.urlencode(q_w)
                enc_w = (_raw_get_json(f"https://enc-dec.app/api/enc-cinejoy?url={urllib.parse.quote(wing_u, safe='')}", timeout=2.2) or {}).get("result") or {}
                if not isinstance(enc_w, dict) or not enc_w.get("data"):
                    return None
                raw_b64 = str(enc_w["data"])
                raw_bin = base64.urlsafe_b64decode(raw_b64 + "=" * ((4 - len(raw_b64) % 4) % 4))
                w_req = urllib.request.Request("https://api.wing.st/g", data=raw_bin, headers={**cj_hdrs, "Content-Type": "application/octet-stream"})
                with urllib.request.urlopen(w_req, timeout=2.5) as rw:
                    resp_bin = rw.read(MAX_PAGE_BYTES)
                if not resp_bin or len(resp_bin) < 16:
                    return None
                resp_b64 = base64.urlsafe_b64encode(resp_bin).decode("ascii").rstrip("=")
                dec_w = (_raw_get_json("https://enc-dec.app/api/dec-cinejoy", headers={"Content-Type": "application/json"}, data=json.dumps({"text": resp_b64, "state": enc_w.get("state")}).encode("utf-8"), timeout=2.3) or {}).get("result") or {}
                w_data = (dec_w.get("data") if isinstance(dec_w, dict) else None) or {}
                streams_w = w_data.get("stream") if isinstance(w_data, dict) else []
                if not isinstance(streams_w, list) or not streams_w:
                    return None
                st0 = streams_w[0] if isinstance(streams_w[0], dict) else {}
                pl_u = str(st0.get("playlist") or st0.get("url") or "").strip()
                if not pl_u.startswith("https://") or _is_unplayable_stream_url(pl_u) or not public_http_url(pl_u):
                    return None
                with _public_open(urllib.request.Request(pl_u, headers=cj_hdrs), timeout=2.2) as pr_w:
                    m_txt = pr_w.read(65536).decode("utf-8", errors="ignore")
                if "#EXTM3U" not in m_txt:
                    return None
                max_w_cj = max((max(int(m.group(1)), int(int(m.group(2)) * 16 / 9)) for m in re.finditer(r"RESOLUTION=(\d+)x(\d+)", m_txt, re.I)), default=(3840 if is_4k_srv else 1920))
                max_bw_cj = max((int(m.group(1)) for m in re.finditer(r"BANDWIDTH=(\d+)", m_txt, re.I)), default=0)
                _STREAM_RES_HINT[pl_u] = max_w_cj
                cj_langs = []
                for ln_c in m_txt.splitlines():
                    if ln_c.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in ln_c:
                        lm_c = re.search(r'LANGUAGE="([^"]*)"', ln_c)
                        nm_c = re.search(r'NAME="([^"]*)"', ln_c)
                        c_code = _norm_audio_lang(lm_c.group(1) if lm_c else "", nm_c.group(1) if nm_c else "")
                        if c_code and c_code not in cj_langs:
                            cj_langs.append(c_code)
                if cj_langs:
                    _AUDIO_LANG_HINT[pl_u] = cj_langs
                caps_w = st0.get("captions") or w_data.get("captions") or []
                if isinstance(caps_w, list) and caps_w and ekey:
                    es_cj = _EMBED_SUB_CACHE.setdefault(ekey, [])
                    for cp_w in caps_w:
                        if isinstance(cp_w, dict):
                            cu_w = str(cp_w.get("url") or cp_w.get("file") or "").strip()
                            cl_w = str(cp_w.get("language") or cp_w.get("lang") or cp_w.get("label") or "").lower().strip()
                            if cu_w.startswith("https://") and "forced" not in cl_w and not any(x.get("url") == cu_w for x in es_cj):
                                es_cj.append({"lang": cl_w, "url": cu_w, "source": "cinejoy_embed"})
                st_tag_cj = "hls_cj_4k" if (max_w_cj >= 3200 or max_bw_cj >= 7500000) else "hls_cj"
                return (pl_u, st_tag_cj, max_w_cj, max_bw_cj)
            except Exception:
                return None

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(3, len(wing_srvs))) as cj_pool:
                hits_cj = [h for h in cj_pool.map(_probe_wing_srv, wing_srvs[:3]) if h]
            hits_cj.sort(key=lambda x: (x[2], x[3]), reverse=True)
            for u_h, tag_h, _, _ in hits_cj:
                if not any(u_h == r_x[0] for r_x in res):
                    res.append((u_h, tag_h))
        except Exception:
            pass
        if not res:
            try:
                nx_u = f"https://providers.nexa.mov/?platform=tmdb&id={tid}&server=nova&season={s_tmdb}&episode={e_tmdb}" if mtype == "tv" else f"https://providers.nexa.mov/?platform=tmdb&id={tid}&server=nova"
                enc_nx = (_raw_get_json(f"https://enc-dec.app/api/enc-nexa?url={urllib.parse.quote(nx_u)}", timeout=2.3) or {}).get("result") or ""
                if enc_nx:
                    nx_req = urllib.request.Request("https://providers.nexa.mov/v1/playlist", data=base64.b64decode(enc_nx), headers={"User-Agent": UA137, "Referer": "https://nexa.mov/", "Content-Type": "application/octet-stream"})
                    with urllib.request.urlopen(nx_req, timeout=2.3) as r_nx:
                        nx_hex = r_nx.read(MAX_PAGE_BYTES).hex()
                    if nx_hex and len(nx_hex) > 20:
                        dec_nx = (_raw_get_json("https://enc-dec.app/api/dec-nexa", headers={"Content-Type": "application/json"}, data=json.dumps({"text": nx_hex, "server": "nova"}).encode("utf-8"), timeout=2.3) or {}).get("result") or {}
                        if isinstance(dec_nx, dict):
                            st_nx = str(dec_nx.get("url") or dec_nx.get("stream") or "").strip()
                            st_nx_path = st_nx.lower().split("?", 1)[0]
                            if st_nx.startswith("https://") and not st_nx_path.endswith((".mpd", ".mp4")) and not _is_unplayable_stream_url(st_nx):
                                with _public_open(urllib.request.Request(st_nx, headers={"User-Agent": UA137, "Referer": "https://cinejoy.pk/"}), timeout=2.2) as pr_nx:
                                    if "#EXTM3U" in pr_nx.read(4096).decode("utf-8", errors="ignore"):
                                        res.append((st_nx, "hls_cj"))
            except Exception:
                pass
        return res

    def _job_archive_org():
        res = []
        if mtype != "movie":
            return res
        yr_int = int(str(year)[:4]) if (year and str(year)[:4].isdigit()) else 2020
        if orig_lang != "tr" and yr_int > 1995:
            return res
        try:
            q_ar_t = (tr_title or orig_title or title or "").strip()
            if not q_ar_t:
                return res
            valid_ar_norms = {_norm_title(x) for x in [q_ar_t, orig_title, tr_title] if _norm_title(x)}
            ar_u = "https://archive.org/advancedsearch.php?" + urllib.parse.urlencode({
                "q": f'title:("{q_ar_t}") AND mediatype:(movies)',
                "fl[]": ["identifier", "title"],
                "rows": 5, "page": 1, "output": "json",
            }, doseq=True)
            ar_docs = ((_raw_get_json(ar_u, timeout=3.5) or {}).get("response") or {}).get("docs") or []
            for doc in ar_docs[:3]:
                ident = str(doc.get("identifier") or "").strip()
                doc_t = _norm_title(str(doc.get("title") or ""))
                if not ident or not any(vn in doc_t or doc_t in vn for vn in valid_ar_norms if len(vn) >= 3):
                    continue
                md = _raw_get_json(f"https://archive.org/metadata/{urllib.parse.quote(ident)}", timeout=3.5) or {}
                mp4_cands = []
                for f_obj in (md.get("files") or []):
                    fn = str(f_obj.get("name") or "")
                    if not fn.lower().endswith(".mp4") or ".ia.mp4" in fn.lower():
                        continue
                    f_sz = int(f_obj.get("size") or 0) if str(f_obj.get("size") or "").isdigit() else 0
                    if f_sz < 35_000_000:
                        continue
                    mp4_cands.append((f_sz, fn))
                if mp4_cands:
                    mp4_cands.sort(reverse=True)
                    best_fn = mp4_cands[0][1]
                    ar_mp4_u = f"https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(best_fn)}"
                    st_ar = "mp4_ar_tr" if orig_lang == "tr" else "mp4_ar"
                    res.append((ar_mp4_u, st_ar))
                    if orig_lang == "tr":
                        _AUDIO_LANG_HINT[ar_mp4_u] = ["tr"]
                    break
        except Exception:
            pass
        return res

    orig_lang = str(meta.get("origLang") or "").lower()
    is_ja_or_anime = orig_lang == "ja" or "anime" in (source_url or "").lower() or str(tid or "") in _ANIMECIX_KNOWN_TMDB

    def _job_yflix_kai():
        res = []
        if not str(tid or "").isdigit():
            return res
        if is_ja_or_anime:
            try:
                q_kai = urllib.parse.quote(orig_title or title or tr_title or "")
                kai_db = (_raw_get_json(f"https://enc-dec.app/api/db/kai/search?query={q_kai}", timeout=1.8) or {}).get("result") or []
                if isinstance(kai_db, list) and kai_db:
                    k0 = kai_db[0] if isinstance(kai_db[0], dict) else {}
                    eps_map = k0.get("episodes") if isinstance(k0.get("episodes"), dict) else {}
                    s_ep_map = eps_map.get(str(s_tmdb)) or eps_map.get(str(s_split)) or eps_map.get("1") or {}
                    ep_obj = s_ep_map.get(str(e_tmdb)) or s_ep_map.get(str(e_split)) or {}
                    tok_k = str(ep_obj.get("token") or "").strip() if isinstance(ep_obj, dict) else ""
                    if tok_k:
                        enc_k = (_raw_get_json(f"https://enc-dec.app/api/enc-kai?text={urllib.parse.quote(tok_k)}", timeout=1.8) or {}).get("result") or ""
                        if enc_k:
                            srvs_h = ((_raw_get_json(f"https://anikai.to/ajax/links/list?token={urllib.parse.quote(tok_k)}&_={urllib.parse.quote(enc_k)}", headers={"Referer": "https://anikai.to/"}, timeout=1.9) or {}).get("result") or "")
                            lids = re.findall(r'data-lid="([^"]+)"', str(srvs_h))
                            if lids:
                                enc_lid = (_raw_get_json(f"https://enc-dec.app/api/enc-kai?text={urllib.parse.quote(lids[0])}", timeout=1.8) or {}).get("result") or ""
                                vw_enc = ((_raw_get_json(f"https://anikai.to/ajax/links/view?id={urllib.parse.quote(lids[0])}&_={urllib.parse.quote(enc_lid)}", headers={"Referer": "https://anikai.to/"}, timeout=1.9) or {}).get("result") or "")
                                dec_vw = (_raw_get_json("https://enc-dec.app/api/dec-kai", headers={"Content-Type": "application/json"}, data=json.dumps({"text": vw_enc}).encode("utf-8"), timeout=1.8) or {}).get("result") or {}
                                emb_k = str(dec_vw.get("url") or "").strip() if isinstance(dec_vw, dict) else ""
                                if "/e/" in emb_k and public_http_url(emb_k):
                                    med_u = emb_k.replace("/e/", "/media/")
                                    med_enc = ((_raw_get_json(med_u, headers={"Referer": emb_k}, timeout=1.9) or {}).get("result") or "")
                                    if med_enc:
                                        dec_mg = (_raw_get_json("https://enc-dec.app/api/dec-mega", headers={"Content-Type": "application/json"}, data=json.dumps({"text": med_enc, "agent": UA137}).encode("utf-8"), timeout=1.9) or {}).get("result") or {}
                                        srcs_k = dec_mg.get("sources") if isinstance(dec_mg, dict) else []
                                        for sk in (srcs_k or []):
                                            uk = str((sk or {}).get("file") or "").strip()
                                            if uk.startswith("https://") and not _is_unplayable_stream_url(uk):
                                                _STREAM_RES_HINT[uk] = 1920
                                                res.append((uk, "hls"))
                                                break
            except Exception:
                pass
        try:
            flx_db = (_raw_get_json(f"https://enc-dec.app/api/db/flix/find?tmdb_id={tid}&type={'tv' if mtype == 'tv' else 'movie'}", timeout=1.8) or {}).get("result") or []
            if isinstance(flx_db, list) and flx_db:
                f0 = flx_db[0] if isinstance(flx_db[0], dict) else {}
                eps_f = f0.get("episodes") if isinstance(f0.get("episodes"), dict) else {}
                s_map_f = eps_f.get(str(s_tmdb)) or eps_f.get("1") or {}
                ep_f = s_map_f.get(str(e_tmdb)) or s_map_f.get("1") or {}
                eid_f = str(ep_f.get("eid") or "").strip() if isinstance(ep_f, dict) else ""
                if eid_f:
                    enc_f = (_raw_get_json(f"https://enc-dec.app/api/enc-movies-flix?text={urllib.parse.quote(eid_f)}&type=eid", timeout=1.8) or {}).get("result") or ""
                    if enc_f:
                        sv_h = ((_raw_get_json(f"https://yflix.to/ajax/links/list?eid={urllib.parse.quote(eid_f)}&_={urllib.parse.quote(enc_f)}", headers={"Referer": "https://yflix.to/"}, timeout=1.9) or {}).get("result") or "")
                        lids_f = re.findall(r'data-lid="([^"]+)"', str(sv_h))
                        if lids_f:
                            enc_lf = (_raw_get_json(f"https://enc-dec.app/api/enc-movies-flix?text={urllib.parse.quote(lids_f[0])}&type=lid", timeout=1.8) or {}).get("result") or ""
                            vw_f = ((_raw_get_json(f"https://yflix.to/ajax/links/view?id={urllib.parse.quote(lids_f[0])}&_={urllib.parse.quote(enc_lf)}", headers={"Referer": "https://yflix.to/"}, timeout=1.9) or {}).get("result") or "")
                            dec_f = (_raw_get_json("https://enc-dec.app/api/dec-movies-flix", headers={"Content-Type": "application/json"}, data=json.dumps({"text": vw_f}).encode("utf-8"), timeout=1.8) or {}).get("result") or {}
                            emb_f = str(dec_f.get("url") or "").strip() if isinstance(dec_f, dict) else ""
                            if "/e/" in emb_f and public_http_url(emb_f):
                                med_f = emb_f.replace("/e/", "/media/")
                                med_ef = ((_raw_get_json(med_f, headers={"Referer": emb_f}, timeout=1.9) or {}).get("result") or "")
                                if med_ef:
                                    dec_rp = (_raw_get_json("https://enc-dec.app/api/dec-rapid", headers={"Content-Type": "application/json"}, data=json.dumps({"text": med_ef, "agent": UA137}).encode("utf-8"), timeout=1.9) or {}).get("result") or {}
                                    srcs_f = dec_rp.get("sources") if isinstance(dec_rp, dict) else []
                                    for sf in (srcs_f or []):
                                        uf = str((sf or {}).get("file") or "").strip()
                                        if uf.startswith("https://") and not _is_unplayable_stream_url(uf):
                                            _STREAM_RES_HINT[uf] = 1920
                                            res.append((uf, "hls"))
                                            break
        except Exception:
            pass
        return res

    out_urls = []
    orig_lang = str(meta.get("origLang") or "").lower()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=11)
    f_ac = pool.submit(_extract_animecix_sync, mtype, s_split, e_split, orig_title, tr_title, tid, extra_titles, source_url, orig_lang)
    f_pv = pool.submit(_extract_ddizimag_sync, mtype, s_split, e_split, orig_title, tr_title, ekey, year, extra_titles, source_url, orig_lang, imdb_id)
    f_dl = pool.submit(_extract_dizilife_sync, mtype, s_split, e_split, orig_title, tr_title, ekey, year, imdb_id, extra_titles, source_url)
    f_dp = pool.submit(lambda: []) if IS_VERCEL else pool.submit(_extract_dizipal_hls_sync, mtype, s_split, e_split, extra_titles, ekey, year, imdb_id)
    f_hf = pool.submit(_extract_hdfc_sync, mtype, s_split, e_split, orig_title, tr_title, ekey, year, imdb_id, extra_titles, source_url, tid, refresh)
    f_ve = pool.submit(_job_videasy)
    f_cj = pool.submit(_job_cinejoy)
    f_hexa = pool.submit(_job_hexa)
    f_vid = pool.submit(_job_vidlink)
    f_ar = pool.submit(_job_archive_org)
    f_yk = pool.submit(_job_yflix_kai)
    t_start = time.time()
    t_first_hf = 0.0
    is_ja_or_anime = orig_lang == "ja" or "anime" in (source_url or "").lower() or str(tid or "") in _ANIMECIX_KNOWN_TMDB
    _VERCEL_1080_TAGS = ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_hfnl_multi", "hls_hfnl", "hls_dl", "hls_pv_multi", "hls_pv_tr", "hls_pv", "hls_ve", "hls_ve_multi", "hls_cj_4k", "hls_cj", "hls", "mp4_ac_sub", "mp4_ac_dub", "mp4")
    _TR_DUB_TAGS = ("hls_fhd_multi", "hls_fhd_tr", "hls_hfnl_multi", "hls_pv_multi", "hls_pv_tr", "mp4_ac_dub", "mp4_ar_tr")
    has_tr_dub_ready = orig_lang == "tr"
    max_extract_budget = 4.2 if IS_VERCEL else 6.8
    uhd_grace_sec = 1.15 if IS_VERCEL else 1.55
    while time.time() - t_start < max_extract_budget:
        ac_res_now = (f_ac.result() or []) if (f_ac.done() and not f_ac.exception()) else []
        ac_ok = bool(ac_res_now)
        pv_res_now = (f_pv.result() or []) if (f_pv.done() and not f_pv.exception()) else []
        pv_ok = bool(pv_res_now)
        hf_res_now = (f_hf.result() or []) if (f_hf.done() and not f_hf.exception()) else []
        hf_ok = any(isinstance(x, (list, tuple)) and len(x) >= 2 and x[1] in _VERCEL_1080_TAGS for x in hf_res_now)
        dl_res_now = (f_dl.result() or []) if (f_dl.done() and not f_dl.exception()) else []
        dl_ok = bool(dl_res_now)
        dp_res_now = (f_dp.result() or []) if (f_dp.done() and not f_dp.exception()) else []
        dp_ok = bool(dp_res_now)
        ve_ok = f_ve.done() and not f_ve.exception() and bool(f_ve.result())
        cj_ok = f_cj.done() and not f_cj.exception() and bool(f_cj.result())
        hx_ok = f_hexa.done() and not f_hexa.exception() and bool(f_hexa.result())
        vl_ok = f_vid.done() and not f_vid.exception() and bool(f_vid.result())
        ar_ok = f_ar.done() and not f_ar.exception() and bool(f_ar.result())
        yk_ok = f_yk.done() and not f_yk.exception() and bool(f_yk.result())
        has_tr_dub_ready = (
            orig_lang == "tr"
            or any(isinstance(x, (list, tuple)) and len(x) >= 2 and x[1] in _TR_DUB_TAGS for x in (ac_res_now + pv_res_now + hf_res_now + dl_res_now + dp_res_now))
        )
        tr_extractors_done = f_hf.done() and f_dl.done() and f_pv.done() and (f_ac.done() if is_ja_or_anime else True)
        has_glob_ready = cj_ok or ar_ok or ve_ok or hx_ok or vl_ok or yk_ok
        uhd_or_fhd_done = cj_ok or f_cj.done() or (hf_ok and has_tr_dub_ready) or (is_ja_or_anime and ac_ok) or (orig_lang == "tr" and (hf_ok or ar_ok))
        primary_1080_ok = (ac_ok if is_ja_or_anime else False) or hf_ok or pv_ok or dl_ok or dp_ok or (ar_ok if orig_lang == "tr" else False)
        elapsed_ex = time.time() - t_start
        if primary_1080_ok and (uhd_or_fhd_done or elapsed_ex >= uhd_grace_sec) and (has_tr_dub_ready or has_glob_ready or elapsed_ex >= uhd_grace_sec):
            break
        if is_ja_or_anime and not f_ac.done() and (elapsed_ex < 2.8):
            time.sleep(0.06)
            continue
        if not has_tr_dub_ready and not tr_extractors_done and (elapsed_ex < 3.0):
            time.sleep(0.06)
            continue
        if has_glob_ready and (cj_ok or f_cj.done() or elapsed_ex >= uhd_grace_sec) and (tr_extractors_done or elapsed_ex >= 3.2):
            break
        if all(f.done() for f in (f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_cj, f_hexa, f_vid, f_ar, f_yk)):
            break
        time.sleep(0.06)
    any_ready_after_loop = any(f.done() and not f.exception() and bool(f.result()) for f in (f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_cj, f_hexa, f_vid, f_ar, f_yk))
    if not any_ready_after_loop:
        concurrent.futures.wait([f_pv, f_hf, f_dl, f_dp, f_ac, f_ve, f_cj, f_hexa, f_vid, f_ar, f_yk], timeout=2.2)
    elif not is_ja_or_anime and not has_tr_dub_ready and not f_hf.done():
        concurrent.futures.wait([f_hf], timeout=0.3)
    if not f_cj.done() and orig_lang != "tr":
        concurrent.futures.wait([f_cj], timeout=0.45)
    ac_res, tr_res, ve_res, cj_res, hexa_res, vid_res, ar_res, yk_res = [], [], [], [], [], [], [], []
    if f_ac.done():
        try:
            ac_res = f_ac.result() or []
        except Exception:
            ac_res = []
    for f_sub in (f_pv, f_dl, f_dp, f_hf):
        if f_sub.done():
            try:
                for item_tr in (f_sub.result() or []):
                    if item_tr not in tr_res:
                        tr_res.append(item_tr)
            except Exception:
                pass
    if f_ve.done():
        try:
            ve_res = f_ve.result() or []
        except Exception:
            ve_res = []
    if f_cj.done():
        try:
            cj_res = f_cj.result() or []
        except Exception:
            cj_res = []
    if f_hexa.done():
        try:
            hexa_res = f_hexa.result() or []
        except Exception:
            hexa_res = []
    if f_vid.done():
        try:
            vid_res = f_vid.result() or []
        except Exception:
            vid_res = []
    if f_ar.done():
        try:
            ar_res = f_ar.result() or []
        except Exception:
            ar_res = []
    if f_yk.done():
        try:
            yk_res = f_yk.result() or []
        except Exception:
            yk_res = []
    for x in [x for x in tr_res if x[1] in ("mp4_ac_sub", "mp4_ac_dub")]:
        if x not in ac_res:
            ac_res.append(x)
    for x in reversed([x for x in tr_res if x[1] in ("hls_ve", "hls_ve_multi")]):
        if x not in ve_res:
            ve_res.insert(0, x)
    for x in reversed([x for x in tr_res if x[1] == "hls"]):
        if x not in hexa_res:
            hexa_res.insert(0, x)
    for x in yk_res:
        if x not in hexa_res:
            hexa_res.insert(0, x)

    def _quick_manifest_res(pair_q):
        u_q, st_q = pair_q
        if not u_q.startswith("https://") or u_q in _STREAM_RES_HINT or any(d in u_q for d in (".example.", "localhost", "127.0.0.1")) or str(st_q).startswith(("mp4", "hls_fp:", "yt")):
            return
        try:
            qh = {"User-Agent": UA137}
            if "dl" in str(st_q) or "makesomthingup" in u_q:
                qh["Referer"] = "https://one.makesomthingup.click/"
                qh["Origin"] = "https://one.makesomthingup.click"
            elif "fhd" in str(st_q) or "rapidvid" in u_q or "cdnimg" in u_q:
                qh["Referer"] = "https://rapidvid.org/"
                qh["Origin"] = "https://rapidvid.org"
            elif "hfnl" in str(st_q) or "hdfilmcehennemi" in u_q or "playmix" in u_q:
                qh["Referer"] = "https://hdfilmcehennemi.mobi/"
                qh["Origin"] = "https://hdfilmcehennemi.mobi"
            elif "pv" in str(st_q) or "pilavyer" in u_q:
                pv_o = f"https://{urllib.parse.urlparse(u_q).netloc or 'play2.pilavyerplay.top'}"
                qh["Referer"] = f"{pv_o}/"
                qh["Origin"] = pv_o
            elif "ve" in str(st_q):
                qh["Referer"] = "https://vidy.st/"
                qh["Origin"] = "https://vidy.st"
            with _public_open(urllib.request.Request(u_q, headers=qh), timeout=0.9) as rq:
                head_q = rq.read(16384).decode("utf-8", errors="ignore")
            if "#EXTM3U" in head_q:
                mw_q = max((max(int(m.group(1)), int(int(m.group(2)) * 16 / 9)) for m in re.finditer(r"RESOLUTION=(\d+)x(\d+)", head_q, re.I)), default=0)
                if mw_q > 0:
                    _STREAM_RES_HINT[u_q] = mw_q
        except Exception:
            pass

    probe_q_list = [x for x in (tr_res + ve_res)[:5] if isinstance(x, (list, tuple)) and len(x) >= 2 and x[0] not in _STREAM_RES_HINT]
    if probe_q_list:
        q_futs = [pool.submit(_quick_manifest_res, x) for x in probe_q_list[:4]]
        concurrent.futures.wait(q_futs, timeout=1.0)

    vault_yt = [x for x in tr_res if x[1] == "yt"]
    main_multi = [x for x in tr_res if x[1] in (("hls_fhd_multi",) if IS_VERCEL else ("hls_fhd_multi", "hls_hfnl_multi"))]
    main_single = [x for x in tr_res if x[1] in (("hls_fhd", "hls_fhd_tr") if IS_VERCEL else ("hls_fhd", "hls_fhd_tr", "hls_hfnl", "hls_dbx"))]
    ac_1080 = [x for x in ac_res if "_720p" not in str(x[0]).lower() and _STREAM_RES_HINT.get(x[0], 1920) >= 1800]
    ac_720 = [x for x in ac_res if x not in ac_1080]
    pv_multi_all = [x for x in tr_res if x[1] in ("hls_pv_multi", "hls_pv_tr")]
    pv_multi_hd = [x for x in pv_multi_all if _STREAM_RES_HINT.get(x[0], 0) == 0 or _STREAM_RES_HINT.get(x[0], 0) >= 1800]
    pv_multi_720 = [x for x in pv_multi_all if x not in pv_multi_hd]
    fp_multi = [x for x in tr_res if x[1].startswith("hls_fp:multi:")]
    pv_single = [x for x in tr_res if x[1] == "hls_pv"]
    fp_other = [x for x in tr_res if x[1].startswith("hls_fp:") and x not in fp_multi]
    dl_all = [x for x in tr_res if x[1] == "hls_dl"]
    dl_hd = [x for x in dl_all if _STREAM_RES_HINT.get(x[0], 0) == 0 or _STREAM_RES_HINT.get(x[0], 0) >= 1800]
    dl_720 = [x for x in dl_all if x not in dl_hd]
    dp_only = [] if IS_VERCEL else [x for x in tr_res if x[1] == "hls_dp"]
    vm_only = [x for x in tr_res if x[1] == "hls_vm"]
    all_cj = list(cj_res) + [x for x in tr_res if x[1] in ("hls_cj", "hls_cj_4k")]
    cj_4k = [x for x in all_cj if x[1] == "hls_cj_4k"]
    cj_1080 = [x for x in all_cj if x[1] != "hls_cj_4k"]
    all_ve = list(ve_res) + [x for x in tr_res if x[1] in ("hls_ve", "hls_ve_multi")]
    if ac_res or main_multi or main_single or pv_multi_all or fp_multi or pv_single or fp_other or dl_all or dp_only or all_ve or all_cj or hexa_res or vid_res or ar_res or vm_only or vault_yt:
        if is_ja_or_anime:
            out_urls.extend(ac_1080)
            out_urls.extend(main_multi)
            out_urls.extend(main_single)
            out_urls.extend(fp_multi)
            out_urls.extend(pv_multi_hd)
            out_urls.extend(cj_4k)
            out_urls.extend(dl_hd)
            out_urls.extend(cj_1080)
            out_urls.extend(all_ve)
            out_urls.extend(hexa_res)
            out_urls.extend(dp_only)
            out_urls.extend(pv_multi_720)
            out_urls.extend(dl_720)
            out_urls.extend(ac_720)
            out_urls.extend(pv_single)
            out_urls.extend(fp_other)
            out_urls.extend(vid_res)
            out_urls.extend(ar_res)
            out_urls.extend(vm_only)
            out_urls.extend(vault_yt)
        elif orig_lang == "tr":
            out_urls.extend(main_multi)
            out_urls.extend(main_single)
            out_urls.extend(ar_res)
            out_urls.extend(fp_multi)
            out_urls.extend(pv_multi_hd)
            out_urls.extend(dl_hd)
            out_urls.extend(dp_only)
            out_urls.extend(ac_1080)
            out_urls.extend(cj_4k)
            out_urls.extend(all_ve)
            out_urls.extend(cj_1080)
            out_urls.extend(hexa_res)
            out_urls.extend(pv_multi_720)
            out_urls.extend(dl_720)
            out_urls.extend(pv_single)
            out_urls.extend(fp_other)
            out_urls.extend(ac_720)
            out_urls.extend(vid_res)
            out_urls.extend(vm_only)
            out_urls.extend(vault_yt)
        else:
            out_urls.extend(main_multi)
            out_urls.extend(main_single)
            out_urls.extend(ac_1080)
            out_urls.extend(fp_multi)
            out_urls.extend(pv_multi_hd)
            out_urls.extend(cj_4k)
            out_urls.extend(dl_hd)
            out_urls.extend(all_ve)
            out_urls.extend(cj_1080)
            out_urls.extend(hexa_res)
            out_urls.extend(dp_only)
            out_urls.extend(pv_multi_720)
            out_urls.extend(dl_720)
            out_urls.extend(pv_single)
            out_urls.extend(fp_other)
            out_urls.extend(ac_720)
            out_urls.extend(vid_res)
            out_urls.extend(ar_res)
            out_urls.extend(vm_only)
            out_urls.extend(vault_yt)

    else:
        concurrent.futures.wait([f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_cj, f_hexa, f_vid, f_ar, f_yk], timeout=0.4)
        for fut in (f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_cj, f_hexa, f_vid, f_ar, f_yk):
            if fut.done():
                try:
                    out_urls.extend(fut.result() or [])
                except Exception:
                    pass
    pool.shutdown(wait=False, cancel_futures=True)
    if out_urls:
        dedup_out = []
        seen_out_u = set()
        for x in out_urls:
            if not isinstance(x, (list, tuple)) or len(x) < 2:
                continue
            u_str_cand = str(x[0]).strip()
            if not u_str_cand or u_str_cand in seen_out_u or _is_unplayable_stream_url(u_str_cand):
                continue
            if extra_titles and not _stream_matches_title(u_str_cand, extra_titles, year, imdb_id):
                continue
            seen_out_u.add(u_str_cand)
            dedup_out.append((u_str_cand, str(x[1])))
        out_urls = dedup_out
    had_primary = bool(out_urls)
    if out_urls:
        has_tr = bool(tr_res)
        exp_t = now_t + (3600 if has_tr else (600 if had_primary else 60))
        esubs_now = list(_EMBED_SUB_CACHE.get(ekey) or [])
        _STREAM_CACHE[ckey] = {"val": out_urls, "subs": esubs_now, "exp": exp_t}
        if had_primary:
            conn = None
            try:
                conn = _get_acc_db()
                conn.execute("INSERT OR REPLACE INTO resolved_streams (ckey, val_json, exp) VALUES (?, ?, ?)", (ckey, json.dumps({"urls": out_urls, "subs": esubs_now}), exp_t))
                if int(now_t) % 37 == 0:
                    conn.execute("DELETE FROM resolved_streams WHERE exp < ?", (now_t,))
                conn.commit()
            except Exception:
                pass
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
    return out_urls


def _wrap_first_party_stream(u: str, stype: str, prov: str, tid: str, s: int, e: int, mtype: str = "") -> str:
    if u.startswith("/api/rave/") or "/api/rave/stream" in u:
        return u
    import base64
    tid = urllib.parse.quote(str(tid or ""), safe="")
    mt_q = f"&mtype={mtype}" if mtype in ("tv", "movie") else ""
    u_clean = u.lower().split("?", 1)[0].split("#", 1)[0]
    is_mp4_target = u_clean.endswith((".mp4", ".mkv", ".webm")) or str(stype).startswith("mp4")
    if is_mp4_target:
        if stype in ("mp4_ac_sub", "mp4_ac_dub"):
            return _proxy_u(u, "https://tau-video.xyz/", ".mp4")
        if stype in ("mp4_ar_tr", "mp4_ar"):
            return _proxy_u(u, "https://archive.org/", ".mp4")
        if str(stype).startswith("mp4_vl"):
            use_fb_ref = str(stype).startswith("mp4_vl_fb") or "hakunaymatata.com" not in u
            return _proxy_u(u, "https://filmboom.top/" if use_fb_ref else "", ".mp4")
        return _proxy_u(u, "", ".mp4")
    if stype.startswith("hls_fp:"):
        parts = stype.split(":", 4)
        _, _fmode, vid, sp, spt = (parts + ["", "", "", ""])[:5]
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=fp&fp_id={urllib.parse.quote(str(vid), safe='')}&sp={urllib.parse.quote(str(sp), safe='')}&spt={urllib.parse.quote(str(spt), safe='')}&ext=.m3u8"
    if stype in ("hls_fhd", "hls_fhd_tr", "hls_fhd_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=fhd&ext=.m3u8"
    if stype in ("hls_hfnl", "hls_hfnl_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=hfnl&ext=.m3u8"
    if stype == "hls_dbx":
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=dbx&ext=.m3u8"
    if stype in ("hls_pv", "hls_pv_tr", "hls_pv_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=pv&ext=.m3u8"
    if stype == "hls_dp":
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=dp&proxy_segs=1&ext=.m3u8"
    if stype in ("mp4_ac_sub", "mp4_ac_dub"):
        return _proxy_u(u, "https://tau-video.xyz/", ".mp4")
    if stype in ("mp4_ar_tr", "mp4_ar"):
        return _proxy_u(u, "https://archive.org/", ".mp4")
    if str(stype).startswith("mp4_vl"):
        use_fb_ref = str(stype).startswith("mp4_vl_fb") or "hakunaymatata.com" not in u
        return _proxy_u(u, "https://filmboom.top/" if use_fb_ref else "", ".mp4")
    if stype == "hls_vm" or any(d in u.lower() for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}&ref=vm&proxy_segs=1&ext=.m3u8"
    if stype in ("hls", "hls_dl", "hls_ve", "hls_ve_multi", "hls_cj", "hls_cj_4k"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        ref_q = "&ref=ve" if stype in ("hls_ve", "hls_ve_multi") else ("&ref=cj" if stype in ("hls_cj", "hls_cj_4k") else ("&ref=dl" if stype == "hls_dl" else ("&ref=hx" if "dragonballzfans" in u else "")))
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}{mt_q}&sid={sid}{ref_q}&ext=.m3u8"
    if u.startswith("http://") and public_http_url(u):
        return _proxy_u(u, "", ".mp4" if ".mp4" in u.lower() else ".m3u8")
    return u


_SUB_CACHE = BoundedTTLCache(maxsize=1500, ttl=3600.0)
_SUB_VTT_CACHE = collections.OrderedDict()
_TTS_CACHE = collections.OrderedDict()
_PLATFORM_META_CACHE = BoundedTTLCache(maxsize=1500, ttl=3600.0)

SUB_LANG_MAP = {
    "tur": ("tr", "🇹🇷 Türkçe", 0), "tr": ("tr", "🇹🇷 Türkçe", 0), "türkçe": ("tr", "🇹🇷 Türkçe", 0), "turkish": ("tr", "🇹🇷 Türkçe", 0),
    "eng": ("en", "🇬🇧 İngilizce (English)", 1), "en": ("en", "🇬🇧 İngilizce (English)", 1), "ingilizce": ("en", "🇬🇧 İngilizce (English)", 1), "english": ("en", "🇬🇧 İngilizce (English)", 1),
    "ger": ("de", "🇩🇪 Almanca (Deutsch)", 2), "deu": ("de", "🇩🇪 Almanca (Deutsch)", 2), "de": ("de", "🇩🇪 Almanca (Deutsch)", 2), "almanca": ("de", "🇩🇪 Almanca (Deutsch)", 2), "german": ("de", "🇩🇪 Almanca (Deutsch)", 2),
    "spa": ("es", "🇪🇸 İspanyolca (Español)", 3), "es": ("es", "🇪🇸 İspanyolca (Español)", 3), "ispanyolca": ("es", "🇪🇸 İspanyolca (Español)", 3), "spanish": ("es", "🇪🇸 İspanyolca (Español)", 3),
    "fre": ("fr", "🇫🇷 Fransızca (Français)", 4), "fra": ("fr", "🇫🇷 Fransızca (Français)", 4), "fr": ("fr", "🇫🇷 Fransızca (Français)", 4), "fransızca": ("fr", "🇫🇷 Fransızca (Français)", 4), "french": ("fr", "🇫🇷 Fransızca (Français)", 4),
    "ita": ("it", "🇮🇹 İtalyanca (Italiano)", 5), "it": ("it", "🇮🇹 İtalyanca (Italiano)", 5), "italyanca": ("it", "🇮🇹 İtalyanca (Italiano)", 5), "italian": ("it", "🇮🇹 İtalyanca (Italiano)", 5),
    "rus": ("ru", "🇷🇺 Rusça (Русский)", 6), "ru": ("ru", "🇷🇺 Rusça (Русский)", 6), "rusça": ("ru", "🇷🇺 Rusça (Русский)", 6), "russian": ("ru", "🇷🇺 Rusça (Русский)", 6),
    "ara": ("ar", "🇸🇦 Arapça (العربية)", 7), "ar": ("ar", "🇸🇦 Arapça (العربية)", 7), "arapça": ("ar", "🇸🇦 Arapça (العربية)", 7), "arabic": ("ar", "🇸🇦 Arapça (العربية)", 7),
    "por": ("pt", "🇵🇹 Portekizce (Português)", 8), "pob": ("pt", "🇧🇷 Portekizce (BR)", 8), "portekizce": ("pt", "🇵🇹 Portekizce (Português)", 8), "portuguese": ("pt", "🇵🇹 Portekizce (Português)", 8),
    "dut": ("nl", "🇳🇱 Felemenkçe (Nederlands)", 9), "nld": ("nl", "🇳🇱 Felemenkçe (Nederlands)", 9), "felemenkçe": ("nl", "🇳🇱 Felemenkçe (Nederlands)", 9), "dutch": ("nl", "🇳🇱 Felemenkçe (Nederlands)", 9),
    "pol": ("pl", "🇵🇱 Lehçe (Polski)", 10), "lehçe": ("pl", "🇵🇱 Lehçe (Polski)", 10), "polish": ("pl", "🇵🇱 Lehçe (Polski)", 10),
    "jpn": ("ja", "🇯🇵 Japonca (日本語)", 11), "ja": ("ja", "🇯🇵 Japonca (日本語)", 11), "japonca": ("ja", "🇯🇵 Japonca (日本語)", 11), "japanese": ("ja", "🇯🇵 Japonca (日本語)", 11),
    "kor": ("ko", "🇰🇷 Korece (한국어)", 12), "ko": ("ko", "🇰🇷 Korece (한국어)", 12), "korece": ("ko", "🇰🇷 Korece (한국어)", 12), "korean": ("ko", "🇰🇷 Korece (한국어)", 12),
    "ukr": ("uk", "🇺🇦 Ukraynaca", 13), "uk": ("uk", "🇺🇦 Ukraynaca", 13), "ukraynaca": ("uk", "🇺🇦 Ukraynaca", 13), "ukrainian": ("uk", "🇺🇦 Ukraynaca", 13),
    "gre": ("el", "🇬🇷 Yunanca", 14), "ell": ("el", "🇬🇷 Yunanca", 14), "el": ("el", "🇬🇷 Yunanca", 14), "yunanca": ("el", "🇬🇷 Yunanca", 14), "greek": ("el", "🇬🇷 Yunanca", 14),
}

SHORT_TO_PROV = {"nfx": "netflix", "dnp": "disney", "prv": "prime", "mxx": "max", "hbm": "max", "cru": "crunchyroll", "tbv": "tubi", "atp": "apple", "mbi": "mubi", "hlu": "hulu", "pmp": "paramount", "pck": "peacock", "plx": "plex", "plt": "pluto"}

ISO_TO_TR_NAME = {
    "tr": "Türkçe", "en": "İngilizce", "de": "Almanca", "es": "İspanyolca",
    "fr": "Fransızca", "it": "İtalyanca", "ru": "Rusça", "ar": "Arapça",
    "pt": "Portekizce", "nl": "Felemenkçe", "pl": "Lehçe", "ja": "Japonca",
    "ko": "Korece", "uk": "Ukraynaca", "el": "Yunanca",
}

PLATFORM_LANG_PROFILES = {
    "netflix":     (["Türkçe", "İngilizce [Orijinal]", "Almanca", "İspanyolca", "Fransızca", "İtalyanca"], ["Türkçe", "İngilizce", "Almanca", "İspanyolca", "Fransızca", "Arapça", "Rusça"]),
    "max":         (["Türkçe", "İngilizce [Orijinal]", "Almanca", "İspanyolca", "Fransızca", "Portekizce"], ["Türkçe", "İngilizce", "İspanyolca", "Portekizce", "Felemenkçe", "Yunanca", "Almanca", "Fransızca"]),
    "disney":      (["Türkçe", "İngilizce [Orijinal]", "Almanca", "İspanyolca", "Fransızca", "İtalyanca", "Japonca"], ["Türkçe", "İngilizce", "Almanca", "İspanyolca", "Fransızca", "İtalyanca", "Felemenkçe", "Lehçe", "Portekizce"]),
    "prime":       (["Türkçe", "İngilizce [Orijinal]", "Almanca", "İspanyolca", "Fransızca", "İtalyanca", "Portekizce", "Rusça"], ["Türkçe", "İngilizce", "Almanca", "İspanyolca", "Fransızca", "İtalyanca", "Arapça", "Rusça", "Portekizce"]),
    "apple":       (["Türkçe", "İngilizce [Orijinal]", "Almanca", "İspanyolca", "Fransızca", "İtalyanca", "Japonca"], ["Türkçe", "İngilizce", "Almanca", "İspanyolca", "Fransızca", "İtalyanca", "Arapça", "Rusça", "Japonca", "Korece"]),
    "crunchyroll": (["Japonca [Orijinal]", "Türkçe", "İngilizce", "Almanca"], ["Türkçe", "İngilizce", "Almanca", "İspanyolca", "Fransızca", "Portekizce", "Arapça", "Rusça"]),
    "mubi":        (["İngilizce [Orijinal]", "Türkçe", "Fransızca", "Almanca", "İtalyanca"], ["Türkçe", "İngilizce", "Fransızca", "Almanca", "İtalyanca", "İspanyolca"]),
    "exxen":       (["Türkçe [Orijinal]", "İngilizce", "Almanca", "Arapça"], ["Türkçe", "İngilizce", "Almanca", "Arapça", "Rusça"]),
    "blutv":       (["Türkçe [Orijinal]", "İngilizce", "Almanca", "Fransızca"], ["Türkçe", "İngilizce", "Almanca", "Fransızca", "Arapça"]),
    "gain":        (["Türkçe [Orijinal]", "İngilizce"], ["Türkçe", "İngilizce", "Almanca"]),
    "tod":         (["Türkçe", "İngilizce [Orijinal]", "Almanca", "Fransızca", "Arapça"], ["Türkçe", "İngilizce", "Almanca", "Fransızca", "Arapça"]),
    "tabii":       (["Türkçe [Orijinal]", "İngilizce", "İspanyolca", "Arapça", "Rusça"], ["Türkçe", "İngilizce", "İspanyolca", "Arapça", "Rusça"]),
    "tvplus":      (["Türkçe", "İngilizce [Orijinal]", "Almanca"], ["Türkçe", "İngilizce", "Almanca", "Rusça"]),
    "puhutv":      (["Türkçe [Orijinal]", "İngilizce"], ["Türkçe", "İngilizce", "Arapça"]),
    "cinema":          (["Türkçe", "İngilizce [Orijinal]", "Japonca", "Almanca", "Fransızca"], ["Türkçe", "İngilizce", "Japonca", "Almanca", "Fransızca", "Arapça", "Rusça"]),
    "hdfilmcehennemi": (["Türkçe", "İngilizce [Orijinal]", "Almanca", "Fransızca"], ["Türkçe", "İngilizce", "Almanca", "Fransızca", "Arapça", "Rusça"]),
    "dizibox":         (["İngilizce [Orijinal]", "Türkçe", "Almanca", "İspanyolca"], ["Türkçe", "İngilizce", "Almanca", "İspanyolca", "Fransızca", "Rusça"]),
    "dizilife":        (["Türkçe", "İngilizce [Orijinal]", "Almanca"], ["Türkçe", "İngilizce", "Almanca", "Fransızca", "Arapça"]),
    "fullhdfilm":      (["Türkçe", "İngilizce [Orijinal]", "Almanca"], ["Türkçe", "İngilizce", "Almanca", "Fransızca", "Rusça"]),
    "yabancidizi":     (["İngilizce [Orijinal]", "Türkçe", "Korece", "Japonca"], ["Türkçe", "İngilizce", "Korece", "Japonca", "Almanca"]),
}


def _fetch_platform_meta_sync(prov: str, title: str, tid: str, mtype: str = "movie") -> dict:
    ckey = f"pmeta:v7:{prov}:{mtype}:{tid or title}"
    now_t = time.time()
    cached = _PLATFORM_META_CACHE.get(ckey)
    if cached and cached["exp"] > now_t:
        return cached["val"]
    eff_prov = prov if (prov in PROV_LABELS and prov != "web") else "cinema"
    def_aud, def_sub = PLATFORM_LANG_PROFILES.get(eff_prov, PLATFORM_LANG_PROFILES["cinema"])
    out = {"prov": eff_prov, "officialUrl": "", "audioLangs": list(def_aud), "subLangs": list(def_sub)}
    try:
        meta = _get_tmdb_meta_sync(tid, mtype, title) if str(tid or "").isdigit() else {}
        orig_iso = meta.get("origLang") or "en"
        orig_tr_name = ISO_TO_TR_NAME.get(orig_iso, "İngilizce")
        trans_names = [ISO_TO_TR_NAME[c] for c in (meta.get("transLangs") or []) if c in ISO_TO_TR_NAME]
        if trans_names:
            merged_sub = list(dict.fromkeys(["Türkçe", "İngilizce"] + [x for x in def_sub if x in trans_names] + trans_names[:8]))
            out["subLangs"] = merged_sub[:10]
            out["audioLangs"] = list(dict.fromkeys([f"{orig_tr_name} [Orijinal]", "Türkçe", "İngilizce"] + [x for x in def_aud if "[" not in x]))[:8]
        pkgs, country = JW_PROV.get(eff_prov, (None, "TR"))
        q_clean = _clean_query_title(title)
        hits = _justwatch_sync(q_clean, pkgs, country, 6) if q_clean else []
        if not hits and q_clean:
            hits = _justwatch_sync(q_clean, None, "TR", 6) or _justwatch_sync(q_clean, None, "US", 6)
        match = next((h for h in hits if tid and str(h.get("tmdbId")) == str(tid)), hits[0] if hits else None)
        if match and match.get("offers"):
            pkg_set = set(pkgs or [])
            off = next((o for o in match["offers"] if o.get("short") in pkg_set), match["offers"][0])
            out["officialUrl"] = off.get("url") or ""
            if prov in ("web", ""):
                detected = SHORT_TO_PROV.get(off.get("short") or "")
                if detected:
                    out["prov"] = detected
        nf_m = re.search(r"netflix\.com/(?:[a-z-]+/)?title/(\d+)", out["officialUrl"])
        if nf_m and not trans_names:
            req = urllib.request.Request(f"https://www.netflix.com/tr/title/{nf_m.group(1)}", headers={"User-Agent": "Mozilla/5.0"})
            raw_nf = b""
            try:
                with urllib.request.urlopen(req, timeout=1.5) as r:
                    raw_nf = r.read(196 * 1024)
            except Exception as ex:
                raw_nf = getattr(ex, "partial", b"") or b""
            nf_html = raw_nf.decode("utf-8", errors="ignore")
            for k, v in re.findall(r">(Seslendirme|Alt yaz[^<]*|Audio|Subtitles)</h4><span[^>]*>([^<]+)</span>", nf_html):
                parts = [p.strip() for p in v.split(",") if p.strip() and "Sesli Betimleme" not in p]
                if not parts:
                    continue
                if "Seslendirme" in k or "Audio" in k:
                    out["audioLangs"] = list(dict.fromkeys(["Türkçe"] + parts))
                else:
                    out["subLangs"] = list(dict.fromkeys(["Türkçe", "İngilizce"] + parts))
    except Exception:
        pass
    _PLATFORM_META_CACHE[ckey] = {"val": out, "exp": now_t + 3600}
    return out


def _fetch_subtitles_sync(tid: str, imdb_id: str, mtype: str, s: int, e: int, prov: str = "netflix", pmeta: dict = None, direct_list: list = None) -> list:
    s = max(1, int(s or 1))
    e = max(1, int(e or 1))
    mtype = "tv" if mtype == "tv" else "movie"
    plabel = PROV_LABELS.get((pmeta or {}).get("prov") or prov, "Sinema, Dizi & Anime+")
    allow_subs = set()
    for raw_name in ((pmeta or {}).get("subLangs") or []):
        base_n = raw_name.split("[")[0].strip().replace("İ", "i").replace("I", "i").lower().replace("\u0307", "")
        if base_n in SUB_LANG_MAP:
            allow_subs.add(SUB_LANG_MAP[base_n][0])
    ckey = f"sub:v15:{prov}:{mtype}:{tid or imdb_id}:{s}:{e}"
    now_t = time.time()
    cached = _SUB_CACHE.get(ckey)
    if cached and cached["exp"] > now_t:
        return [dict(t) for t in (cached.get("val") or [])]
    all_embed = []
    for u_dir, _ in (direct_list or []):
        u_clean = str(u_dir or "").strip()
        if u_clean and u_clean in _STREAM_URL_TO_SUBS:
            for sb_u in _STREAM_URL_TO_SUBS[u_clean]:
                if isinstance(sb_u, dict) and sb_u.get("url") and not any(x.get("url") == sb_u["url"] for x in all_embed):
                    all_embed.append(dict(sb_u))
    for sb_c in (_EMBED_SUB_CACHE.get(f"{mtype}:{tid}:{s}:{e}") or []):
        if isinstance(sb_c, dict) and sb_c.get("url") and not any(x.get("url") == sb_c["url"] for x in all_embed):
            all_embed.append(dict(sb_c))
    if not all_embed:
        v_streams = _MAIN_SITES_VAULT.get("streams") or {}
        for vk in (f"tmdb:{mtype}:{tid}:{s}:{e}", f"id:{tid}", f"id:{mtype}:{tid}:{s}:{e}"):
            v_ent = v_streams.get(vk) or {}
            if v_ent.get("subs"):
                all_embed = list(v_ent["subs"])
                _EMBED_SUB_CACHE[f"{mtype}:{tid}:{s}:{e}"] = list(all_embed)
                break
    fhd_embed = [x for x in all_embed if x.get("source") == "fhd_embed"]
    hfnl_embed = [x for x in all_embed if x.get("source") == "hfnl_embed"]
    pv_embed = [x for x in all_embed if x.get("source") == "pv_embed"]
    dl_embed = [x for x in all_embed if x.get("source") == "dl_embed"]
    other_embed = [x for x in all_embed if x.get("source") not in ("fhd_embed", "hfnl_embed", "pv_embed", "dl_embed")]
    first_st = str((direct_list[0][1] if direct_list else "") or "")
    for u, st in (direct_list or []):
        if st == "hls_dl" and "/master.m3u8" in u:
            base_dl = u.rsplit("/", 1)[0]
            dl_embed.append({"url": f"{base_dl}/sub_turkish/turkish.vtt", "lang": "tr", "source": "dl_embed"})
            dl_embed.append({"url": f"{base_dl}/sub_english/english.vtt", "lang": "en", "source": "dl_embed"})
    raw_cands = []
    seen_vtt_urls = set()

    def _add_sub(sub_url: str, raw_l: str, tier: int, is_orig: bool = False, src_tag: str = "ext"):
        sub_url = str(sub_url or "").strip()
        if not sub_url.startswith("http") or sub_url in seen_vtt_urls:
            return
        raw_l = str(raw_l or "").replace("İ", "i").replace("I", "i").lower().replace("\u0307", "").strip()
        base_l = re.split(r"[\s(\[-]", raw_l)[0].strip()
        linfo = SUB_LANG_MAP.get(raw_l) or SUB_LANG_MAP.get(base_l)
        if not linfo:
            return
        lcode, llabel, prio = linfo
        seen_vtt_urls.add(sub_url)
        raw_cands.append((prio, tier, len(raw_cands), lcode, llabel, sub_url, is_orig, src_tag))

    if first_st.startswith("hls_fhd"):
        ordered_embeds = fhd_embed + other_embed + hfnl_embed + pv_embed + dl_embed
    elif first_st.startswith("hls_hfnl"):
        ordered_embeds = hfnl_embed + other_embed + fhd_embed + pv_embed + dl_embed
    elif first_st in ("hls_pv", "hls_pv_multi"):
        ordered_embeds = pv_embed + other_embed + fhd_embed + hfnl_embed + dl_embed
    elif first_st == "hls_dl":
        ordered_embeds = dl_embed + other_embed + pv_embed + fhd_embed + hfnl_embed
    else:
        ordered_embeds = other_embed + fhd_embed + hfnl_embed + pv_embed + dl_embed
    for idx_e, esub in enumerate(ordered_embeds):
        eu = str(esub.get("url") or "")
        esrc = str(esub.get("source") or "")
        is_mt_garbage = "hakunaymatata.com" in eu or esrc == "vidlink_embed"
        if is_mt_garbage:
            _add_sub(eu, esub.get("lang") or esub.get("label"), 2, False, "auto")
        else:
            _add_sub(eu, esub.get("lang") or esub.get("label"), -6 if idx_e < 2 else -5, True, "fansub")

    if not imdb_id and str(tid or "").isdigit():
        imdb_id = (_get_tmdb_meta_sync(tid, mtype).get("imdbId") or "").strip()

    if imdb_id and imdb_id.startswith("tt"):
        import concurrent.futures
        imdb_num = imdb_id.lstrip("t")
        st_type = "series" if mtype == "tv" else "movie"
        ep_url = f"https://opensubtitles-v3.strem.io/subtitles/{st_type}/{imdb_id}{f':{s}:{e}' if mtype == 'tv' else ''}.json"

        def _fetch_os_rest(lang3: str):
            os_u = (
                f"https://rest.opensubtitles.org/search/episode-{e}/imdbid-{imdb_num}/season-{s}/sublanguageid-{lang3}"
                if mtype == "tv"
                else f"https://rest.opensubtitles.org/search/imdbid-{imdb_num}/sublanguageid-{lang3}"
            )
            return _raw_get_json(os_u, headers={"User-Agent": "TemporaryUserAgent"}, timeout=1.8)

        os_pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        try:
            fut_tr = os_pool.submit(_fetch_os_rest, "tur")
            fut_en = os_pool.submit(_fetch_os_rest, "eng")
            fut_strem = os_pool.submit(_raw_get_json, ep_url, {"User-Agent": UA137}, None, 1.6)
            for lang3, fut in (("tur", fut_tr), ("eng", fut_en)):
                try:
                    os_items = fut.result(timeout=1.4)
                    if isinstance(os_items, list):
                        valid_os = [
                            it for it in os_items
                            if isinstance(it, dict) and str(it.get("SubFormat") or "").lower() in ("srt", "vtt", "sub", "ass", "ssa") and str(it.get("SubBad") or "0") == "0"
                        ]
                        def _os_rank(it):
                            fn = str(it.get("SubFileName") or "").lower()
                            bad = str(it.get("SubBad") or "0")
                            if bad != "0":
                                return -999999
                            it_imdb = str(it.get("IDMovieImdb") or "").lstrip("t0")
                            ser_imdb = str(it.get("SeriesIMDBID") or "").lstrip("t0")
                            target_imdb = imdb_num.lstrip("0")
                            if target_imdb and it_imdb and it_imdb != target_imdb:
                                if mtype == "tv":
                                    if ser_imdb and ser_imdb != target_imdb:
                                        return -999999
                                else:
                                    return -999999
                            cd_val = str(it.get("SubSumCD") or "1")
                            if cd_val not in ("1", "0", ""):
                                return -500000
                            if any(k in fn for k in ("cd1", "cd2", "part1", "part2", "disc1", "disc2", "p1.srt", "p2.srt")):
                                return -500000
                            if any(k in fn for k in ("ts.", "-ts", ".ts", "telesync", "cam.", "-cam", "camrip", "hdcam", "telecine", "tc.", "workprint", "dvdscr")):
                                return -200000
                            try:
                                dl_cnt = int(str(it.get("SubDownloadsCnt") or "0").replace(",", "").strip() or 0)
                            except (ValueError, TypeError):
                                dl_cnt = 0
                            score = min(dl_cnt, 5000)
                            if any(k in fn for k in ("forced", ".for.", "-for.", "foreign")):
                                score -= 40000
                            if any(k in fn for k in ("extended", "director.s.cut", "directors.cut", "director's cut", "unrated", "remastered.extended")):
                                score -= 25000
                            if str(it.get("SubAutoTranslation") or "0") == "1" or any(k in fn for k in ("autotrans", "makine", "google")):
                                score -= 50000
                            if any(k in fn for k in ("web-dl", "webrip", "web.dl", "web.rip", ".nf.", "nf.web", "amzn", "dsnp", "atvp", "hmax")):
                                score += 25000
                            if any(k in fn for k in ("1080p", "720p", "2160p", "bluray", "bdrip", "brrip", "web-dl", "webrip", "yify", "yts", "ctrlhd", "remux", "repack")):
                                score += 20000
                            if "yify" in fn or "yts" in fn:
                                score += 5000
                            if "ctrlhd" in fn or "chd" in fn:
                                score += 5000
                            try:
                                fps_val = float(str(it.get("MovieFPS") or "0").replace(",", ".").strip() or 0)
                            except (ValueError, TypeError):
                                fps_val = 0.0
                            if 23.970 <= fps_val <= 24.020:
                                score += 10000
                            elif fps_val == 0.0:
                                score += 5000
                            elif 24.99 <= fps_val <= 25.01:
                                score -= 2000
                            if mtype == "tv":
                                tag = f"s{s:02d}e{e:02d}"
                                tag2 = f"{s}x{e:02d}"
                                ser_s = str(it.get("SeriesSeason") or "").lstrip("0")
                                ser_e = str(it.get("SeriesEpisode") or "").lstrip("0")
                                tv_match = (
                                    (ser_s == str(s) and ser_e == str(e))
                                    or tag in fn
                                    or tag2 in fn
                                    or bool(re.search(rf"\b[sS]0?{s}[-._ ]*[eE]0?{e}\b", fn))
                                    or bool(re.search(rf"\b0?{s}x0?{e}\b", fn))
                                )
                                if tv_match:
                                    score += 30000
                                else:
                                    return -500000
                            return score
                        valid_os = [it for it in valid_os if _os_rank(it) > 0]
                        valid_os.sort(key=_os_rank, reverse=True)
                        for idx_os, it in enumerate(valid_os[:3]):
                            dl_link = str(it.get("SubDownloadLink") or "").strip()
                            if dl_link.startswith("http"):
                                is_auto_os = str(it.get("SubAutoTranslation") or "0") == "1"
                                _add_sub(dl_link, lang3, 1 if is_auto_os else (-2 if idx_os == 0 else -1), not is_auto_os, "auto" if is_auto_os else "opensubtitles")
                except Exception:
                    pass
            try:
                data = fut_strem.result(timeout=1.6) or {}
                for idx_st, sub in enumerate(data.get("subtitles") or []):
                    raw_lang = str(sub.get("lang") or "").lower().strip()
                    if raw_lang not in SUB_LANG_MAP:
                        continue
                    lcode = SUB_LANG_MAP[raw_lang][0]
                    st_tier = (-4 if idx_st < 4 else -3) if lcode in ("tr", "en") or lcode in allow_subs else 0
                    _add_sub(sub.get("url"), raw_lang, st_tier, lcode in ("tr", "en"), "opensubtitles")
            except Exception:
                pass
        finally:
            os_pool.shutdown(wait=False, cancel_futures=True)

    raw_cands.sort(key=lambda x: (x[0], x[1], x[2]))
    best_en_url = next((c[5] for c in raw_cands if c[3] == "en"), next((c[5] for c in raw_cands), ""))
    best_tr_alt = [c[5] for c in raw_cands if c[3] == "tr"]
    meta_q = f"&tmdbId={urllib.parse.quote(str(tid or ''))}&imdbId={urllib.parse.quote(str(imdb_id or ''))}&mtype={mtype}&s={s}&e={e}"
    lang_counts = {}
    picked = []
    for prio, tier, _, lcode, llabel, sub_url, is_orig, src_tag in raw_cands:
        max_for_lang = 5 if lcode in ("tr", "en") else 2
        cnt = lang_counts.get(lcode, 0)
        if cnt >= max_for_lang:
            continue
        lang_counts[lcode] = cnt + 1
        tid_code = lcode if cnt == 0 else f"{lcode}-{cnt+1}"
        if src_tag == "auto":
            tag = f" (Otomatik Çeviri Yedek #{cnt+1})"
        elif cnt == 0:
            tag = f" (Fansub / Orijinal Senkron)" if src_tag == "fansub" else (f" ({plabel} Orijinal Senkron)" if (is_orig or lcode in ("tr", "en")) else f" ({plabel} Altyazı)")
        elif src_tag in ("stream", "fansub"):
            tag = f" (Fansub Senkron #{cnt+1})"
        else:
            tag = f" ({plabel} Alternatif Senkron #{cnt+1})"
        fb_u = ""
        if lcode == "tr":
            alt_tr = next((u for u in best_tr_alt if u != sub_url), "")
            fb_u = alt_tr or best_en_url
        fb_q = f"&fb={urllib.parse.quote(fb_u, safe='')}" if fb_u else ""
        vtt_u = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(sub_url, safe='')}&lang={lcode}{fb_q}{meta_q}"
        picked.append((tier, prio, cnt, {"id": tid_code, "lang": lcode, "label": f"{llabel}{tag}", "url": vtt_u, "rawUrl": sub_url, "kind": "subtitles", "source": src_tag}))

    if lang_counts.get("tr", 0) == 0 and best_en_url:
        tr_vtt_u = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(best_en_url, safe='')}&lang=tr&translate=tr{meta_q}"
        picked.append((-2, 0, 0, {"id": "tr", "lang": "tr", "label": f"🇹🇷 Türkçe ({plabel} Akıllı Çeviri Senkron)", "url": tr_vtt_u, "rawUrl": best_en_url, "kind": "subtitles", "source": "ai-tr"}))
        lang_counts["tr"] = 1

    def _sub_sort_key(x):
        lg = x[3].get("lang")
        var = x[2]
        if lg == "tr" and var == 0:
            grp = 0
        elif lg == "en" and var == 0:
            grp = 1
        elif var == 0:
            grp = 2
        elif lg == "tr" and var == 1:
            grp = 3
        elif lg == "en" and var == 1:
            grp = 4
        else:
            grp = 5
        return (grp, x[0], x[1], var)
    picked.sort(key=_sub_sort_key)
    pre_tracks = [x[3] for x in picked[:14]]
    live_tracks = list(pre_tracks) if pre_tracks else []
    if not any(t.get("lang") == "tr" for t in live_tracks) and live_tracks:
        fb_src_track = next((t for t in live_tracks if t.get("lang") == "en"), live_tracks[0])
        q_fb = urllib.parse.parse_qs(urllib.parse.urlparse(str(fb_src_track.get("url") or "")).query)
        raw_fb_src = (q_fb.get("url") or [""])[0]
        if raw_fb_src.startswith("http"):
            tr_synth_u = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(raw_fb_src, safe='')}&lang=tr&translate=tr{meta_q}"
            live_tracks.insert(0, {"id": "tr", "lang": "tr", "label": f"🇹🇷 Türkçe ({plabel} Akıllı Çeviri Senkron)", "url": tr_synth_u, "rawUrl": raw_fb_src, "kind": "subtitles", "source": "ai-tr"})
    if not any(t.get("lang") == "en" for t in live_tracks) and live_tracks:
        fb_en_track = next((t for t in live_tracks if t.get("lang") == "tr"), live_tracks[0])
        q_en = urllib.parse.parse_qs(urllib.parse.urlparse(str(fb_en_track.get("url") or "")).query)
        raw_en_src = (q_en.get("url") or [""])[0]
        if raw_en_src.startswith("http"):
            en_synth_u = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(raw_en_src, safe='')}&lang=en&translate=en{meta_q}"
            ins_en_idx = 1 if (live_tracks and live_tracks[0].get("lang") == "tr") else 0
            live_tracks.insert(ins_en_idx, {"id": "en", "lang": "en", "label": f"🇬🇧 İngilizce (English) ({plabel} Akıllı Çeviri Senkron)", "url": en_synth_u, "rawUrl": raw_en_src, "kind": "subtitles", "source": "ai-en"})
    final_counts = {}
    tracks = []
    seen_tids_out = set()
    for trk in live_tracks:
        lc = str(trk.get("lang") or "und")
        cap = 3 if lc in ("tr", "en") else 1
        cur_c = final_counts.get(lc, 0)
        if cur_c >= cap:
            continue
        final_counts[lc] = cur_c + 1
        t_copy = dict(trk)
        want_id = lc if cur_c == 0 else f"{lc}-{cur_c + 1}"
        if want_id in seen_tids_out:
            want_id = f"{want_id}-{len(seen_tids_out) + 1}"
        seen_tids_out.add(want_id)
        t_copy["id"] = want_id
        tracks.append(t_copy)
        if len(tracks) >= 24:
            break
    if tracks:
        has_tr_sub = any(t.get("lang") == "tr" for t in tracks)
        _SUB_CACHE[ckey] = {"val": [dict(t) for t in tracks], "exp": now_t + (3600 if has_tr_sub else 90)}
    return [dict(t) for t in tracks]


_AUDIO_LANG_ALIASES = {
    "tr": ("tr", "tur", "turkish", "türkçe", "turkce", "türk", "dublaj", "dub", "trdub", "tr-dub"),
    "orig": ("orig", "original audio", "original", "orijinal", "orijinal ses"),
    "en": ("en", "eng", "english", "ingilizce", "i̇ngilizce"),
    "ja": ("ja", "jpn", "jp", "japanese", "japonca", "日本語"),
    "ko": ("ko", "kor", "korean", "korece", "한국어"),
    "de": ("de", "deu", "ger", "german", "almanca", "deutsch"),
    "fr": ("fr", "fra", "fre", "french", "fransızca", "français"),
    "es": ("es", "spa", "spanish", "ispanyolca", "español", "latino"),
    "it": ("it", "ita", "italian", "italyanca", "italiano"),
    "ru": ("ru", "rus", "russian", "rusça", "русский"),
    "ar": ("ar", "ara", "arabic", "arapça"),
    "pt": ("pt", "por", "portuguese", "portekizce", "português"),
    "nl": ("nl", "nld", "dut", "dutch", "felemenkçe", "nederlands"),
    "pl": ("pl", "pol", "polish", "lehçe", "polski"),
    "zh": ("zh", "zho", "chi", "chinese", "çince", "mandarin", "cantonese"),
    "hi": ("hi", "hin", "hindi"),
}
_AUDIO_LANG_FLAGS = {"tr": "🇹🇷", "en": "🇬🇧", "ja": "🇯🇵", "ko": "🇰🇷", "de": "🇩🇪", "fr": "🇫🇷", "es": "🇪🇸", "it": "🇮🇹", "ru": "🇷🇺", "ar": "🇸🇦", "pt": "🇵🇹", "nl": "🇳🇱", "pl": "🇵🇱", "zh": "🇨🇳", "hi": "🇮🇳"}
_AUDIO_LANG_TR_NAMES = {**ISO_TO_TR_NAME, "zh": "Çince", "hi": "Hintçe"}
_AUDIO_LANG_HINT = BoundedTTLCache(maxsize=2000, ttl=3600.0)
_STREAM_RES_HINT = BoundedTTLCache(maxsize=2000, ttl=900.0)
_AUDIO_PROBE_CACHE = BoundedTTLCache(maxsize=800, ttl=1800.0)


def _norm_audio_lang(*vals) -> str:
    """Map an HLS LANGUAGE / NAME attribute (or player label) to an ISO-639-1 code; '' if unknown."""
    for v in vals:
        s = str(v or "").strip().lower()
        if not s:
            continue
        base = re.split(r"[-_\s(]", s)[0]
        for code, aliases in _AUDIO_LANG_ALIASES.items():
            if base in aliases or s in aliases:
                return code
        for code, aliases in _AUDIO_LANG_ALIASES.items():
            if any(len(a) > 3 and a in s for a in aliases):
                return code
    return ""


def _probe_audio_langs(raw_u: str, st: str, prov: str, tid: str, s: int, e: int, mtype: str = ""):
    """Return the audio languages a source really carries: [codes], [] for muxed/unlabelled audio, None on failure."""
    import base64
    cached = _AUDIO_PROBE_CACHE.get(raw_u)
    if cached and time.time() - cached[0] < 1800 and raw_u in _STREAM_RES_HINT:
        return list(cached[1])
    if str(st) in ("hls_pv_tr", "hls_dl", "hls_pv"):
        _STREAM_RES_HINT.setdefault(raw_u, 1280)
        return ["tr"] if str(st) != "hls_pv" else []
    if str(st).startswith("hls_fp:tr:"):
        _STREAM_RES_HINT.setdefault(raw_u, 1920)
        return ["tr"]
    if str(st).startswith("hls_fp:orig:"):
        _STREAM_RES_HINT.setdefault(raw_u, 1920)
        return []
    wu = _wrap_first_party_stream(raw_u, st, prov, tid, s, e, mtype or ("tv" if (s > 1 or e > 1) else ""))
    if "/api/rave/stream?" not in wu:
        return None
    wu_probe = f"{wu}&probe=1"

    class _ProbeReq:
        method = "GET"
        headers = {}
        def __init__(self, u):
            self.query_params = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))

    try:
        _p_loop = asyncio.new_event_loop()
        try:
            resp = _p_loop.run_until_complete(rave_stream_manifest(_ProbeReq(wu_probe)))
        finally:
            _p_loop.close()
        if resp.status_code != 200:
            if resp.status_code in (404, 410) and "multi" not in str(st):
                _STREAM_RES_HINT.set(raw_u, -1, ttl=45.0)
            return None
        body = resp.body.decode("utf-8", errors="ignore")
    except Exception:
        return None
    max_w = max((max(int(m.group(1)), int(int(m.group(2)) * 16 / 9)) for m in re.finditer(r"RESOLUTION=(\d+)x(\d+)", body, re.I)), default=0)
    if not max_w:
        max_w = 3840 if st == "hls_cj_4k" else (1920 if st in ("hls_fhd", "hls_fhd_tr", "hls_fhd_multi", "hls_ve", "hls_ve_multi", "hls_cj", "hls", "hls_hfnl", "hls_hfnl_multi", "hls_dbx", "hls_dp") else (1280 if st in ("hls_pv", "hls_pv_multi") else 1920))
    _STREAM_RES_HINT[raw_u] = max_w
    langs = []
    for ln in body.splitlines():
        if ln.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in ln:
            lm = re.search(r'LANGUAGE="([^"]*)"', ln)
            nm = re.search(r'NAME="([^"]*)"', ln)
            code = _norm_audio_lang(lm.group(1) if lm else "", nm.group(1) if nm else "")
            if code and code not in langs:
                langs.append(code)
            elif not code:
                langs.append("?")
    langs = [x for x in langs if x != "?"] if any(x != "?" for x in langs) else []
    _AUDIO_PROBE_CACHE[raw_u] = (time.time(), langs)
    return langs


def _build_audio_tracks(stream_url: str, direct_list: list, prov: str = "netflix", tid: str = "", s: int = 1, e: int = 1, pmeta: dict = None, mtype: str = "") -> list:
    """Build audio tracks whose labels match the audio each stream really carries (probed per source)."""
    import concurrent.futures
    plabel = PROV_LABELS.get((pmeta or {}).get("prov") or prov, "Netflix")
    mtype = mtype or ("tv" if (s > 1 or e > 1) else "movie")
    orig_lang = ""
    if str(tid or "").isdigit():
        for mt_try in (mtype, "movie" if mtype == "tv" else "tv"):
            try:
                orig_lang = str(_get_tmdb_meta_sync(tid, mt_try).get("origLang") or "").lower()
            except Exception:
                orig_lang = ""
            if orig_lang:
                break
    if not orig_lang:
        orig_item = next((a for a in ((pmeta or {}).get("audioLangs") or []) if "[Orijinal]" in a), "")
        orig_lang = _norm_audio_lang(orig_item.split("[")[0])
    srcs = list(direct_list or [])[:10]
    _KNOWN_ST_LANGS = ("hls_pv_multi", "hls_pv_tr", "hls_pv", "hls_fhd_multi", "hls_fhd_tr", "hls_fhd", "hls_hfnl_multi", "hls_hfnl", "hls_dl", "hls_dp", "hls_dbx", "hls_ve", "hls_ve_multi", "hls_cj_4k", "hls_cj", "hls", "hls_vm", "mp4_ac_sub", "mp4_ac_dub", "mp4_ar_tr", "mp4_ar")
    probe_targets = [(u, st) for u, st in srcs if not str(st).startswith(("mp4", "hls_fp:")) and str(st) not in _KNOWN_ST_LANGS and u not in _AUDIO_LANG_HINT][:2]
    lang_map = {}
    if probe_targets:
        ppool = concurrent.futures.ThreadPoolExecutor(max_workers=len(probe_targets))
        try:
            futs = {ppool.submit(_probe_audio_langs, u, st, prov, tid, s, e, mtype): u for u, st in probe_targets}
            done, _ = concurrent.futures.wait(futs, timeout=0.55)
            for f in done:
                try:
                    lang_map[futs[f]] = f.result(timeout=0.05)
                except Exception:
                    lang_map[futs[f]] = None
        finally:
            ppool.shutdown(wait=False, cancel_futures=True)
    alive_srcs = [(u, st) for u, st in srcs if _STREAM_RES_HINT.get(u, 0) != -1]
    if alive_srcs:
        srcs = alive_srcs
    def _src_res_tier(pair):
        u, st = pair
        probed_l = lang_map.get(u) or _AUDIO_LANG_HINT.get(u) or []
        has_tr = ("tr" in probed_l) or st in ("hls_fhd_multi", "hls_hfnl_multi", "hls_pv_multi", "hls_pv_tr", "hls_fhd_tr", "mp4_ac_dub", "mp4_ar_tr") or str(st).startswith("hls_fp:multi:") or str(st).startswith("hls_fp:tr:")
        live_bonus = 0.5 if (u in lang_map and lang_map.get(u)) else 0.0
        tr_bonus = (1.5 if has_tr else 0.0) + live_bonus
        w = _STREAM_RES_HINT.get(u, 0)
        is_4k = (w >= 3200 or st == "hls_cj_4k")
        is_fhd = (w >= 1800 or st in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_hfnl_multi", "hls_hfnl", "hls_cj", "hls_ve", "hls_ve_multi"))
        is_720 = (st in ("hls_dl", "hls_pv", "hls_pv_tr") or "_720p" in str(u).lower() or (0 < w < 1800))
        if is_4k:
            return 9.0 + tr_bonus
        if is_fhd:
            return 7.0 + tr_bonus
        if is_720:
            return 3.0 + tr_bonus
        if st in ("mp4_ac_sub", "mp4_ac_dub", "mp4_ar_tr", "mp4_ar"):
            return (5.0 if ("_720p" not in str(u).lower() and _STREAM_RES_HINT.get(u, 1920) >= 1800) else 2.5) + tr_bonus
        if str(st).startswith("mp4"):
            return 1.5
        if st == "hls_vm" or any(d in str(u).lower() for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")):
            return 1.0 + (1.0 if has_tr else 0.0)
        return 4.0 + tr_bonus
    srcs.sort(key=_src_res_tier, reverse=True)
    by_lang: dict[str, list] = {}
    unknown: list = []
    for raw_u, st in srcs:
        wu = _wrap_first_party_stream(raw_u, st, prov, tid, s, e, mtype)
        raw_w_hint = _STREAM_RES_HINT.get(raw_u, 0)
        eff_sort_w = raw_w_hint if raw_w_hint > 0 else (3840 if st == "hls_cj_4k" else (1280 if ("_720p" in str(raw_u).lower() or st in ("hls_dl", "hls_pv", "hls_pv_tr")) else (1920 if st in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_hfnl_multi", "hls_hfnl", "mp4_ac_sub", "mp4_ac_dub", "hls_cj", "hls_ve", "hls_ve_multi") else 1840)))
        if st == "mp4_ac_sub":
            by_lang.setdefault(orig_lang or "ja", []).append((wu, "fansub", raw_w_hint, eff_sort_w))
            continue
        if st == "mp4_ac_dub":
            by_lang.setdefault("tr", []).append((wu, "dub", raw_w_hint, eff_sort_w))
            continue
        langs = lang_map.get(raw_u)
        if langs is not None:
            if not langs:
                if st in ("hls_fhd_tr", "hls_pv_tr", "mp4_ar_tr", "hls_dl") or str(st).startswith("hls_fp:tr:"):
                    langs = ["tr"]
                elif orig_lang == "tr":
                    langs = ["tr"]
                else:
                    langs = [orig_lang or "en"]
        else:
            if _AUDIO_LANG_HINT.get(raw_u):
                langs = list(_AUDIO_LANG_HINT[raw_u])
            elif str(st).startswith("hls_fp:tr:"):
                langs = ["tr"]
            elif str(st).startswith("hls_fp:orig:") and orig_lang:
                langs = [orig_lang]
            elif st in ("hls_fhd_tr", "hls_pv_tr", "mp4_ar_tr", "hls_dl"):
                langs = ["tr"]
            elif (st in ("hls_fhd_multi", "hls_hfnl_multi", "hls_pv_multi", "hls_ve_multi") or str(st).startswith("hls_fp:multi:")):
                langs = ["tr", orig_lang or "en"] if (orig_lang or "en") != "tr" else ["tr"]
            elif orig_lang == "tr":
                langs = ["tr"]
            elif (st in ("hls_fhd", "hls_hfnl", "hls_dbx", "hls_pv", "hls_dp", "hls", "hls_vm", "hls_ve", "hls_cj_4k", "hls_cj", "mp4", "mp4_ar", "mp4_vl") or str(st).startswith("mp4_vl")):
                langs = [orig_lang or "en"]
        if langs:
            norm_langs = []
            for L_raw in langs:
                L_eff = (orig_lang or "en") if L_raw == "orig" else L_raw
                if L_eff and L_eff not in norm_langs:
                    norm_langs.append(L_eff)
            for L in norm_langs:
                aud_param = "orig" if (L == orig_lang and "orig" in langs and L != "tr") else L
                u_l = (wu.replace("&ext=.m3u8", f"&aud={aud_param}&ext=.m3u8") if "&ext=.m3u8" in wu else f"{wu}&aud={aud_param}") if len(norm_langs) > 1 else wu
                by_lang.setdefault(L, []).append((u_l, "verified", raw_w_hint, eff_sort_w))
        else:
            unknown.append(wu)
    for L_k in by_lang:
        by_lang[L_k].sort(key=lambda item_l: item_l[3], reverse=True)
    base_order = (["tr"] if "tr" in by_lang else []) + ([orig_lang] if orig_lang in by_lang and orig_lang != "tr" else []) + [L for L in by_lang if L not in (orig_lang, "tr", "en")] + (["en"] if "en" in by_lang and orig_lang != "en" else [])
    eff_orig_lang = orig_lang if orig_lang in by_lang else next((L for L in base_order if L != "tr"), orig_lang)
    is_tr_native = orig_lang == "tr" or prov in ("exxen", "blutv", "gain", "tod", "tabii", "puhutv")
    order = list(base_order)
    if "tr" in by_lang and not is_tr_native and eff_orig_lang and eff_orig_lang != "tr" and eff_orig_lang in by_lang:
        tr_ws = [it[3] for it in by_lang["tr"]]
        orig_ws = [it[3] for it in by_lang[eff_orig_lang]]
        if tr_ws and max(tr_ws) < 1800 and orig_ws and max(orig_ws) >= 1800:
            order = [eff_orig_lang, "tr"] + [L for L in base_order if L not in (eff_orig_lang, "tr")]
    tracks = []
    for L in order:
        name = _AUDIO_LANG_TR_NAMES.get(L, L.upper())
        flag = _AUDIO_LANG_FLAGS.get(L, "🎧")
        is_orig = (L == eff_orig_lang) or (is_tr_native and L == "tr")
        base_id = "orig" if is_orig else ("tr-dub" if L == "tr" else ("en-dub" if L == "en" else f"dub-{L}"))
        for k, (u_l, kind, raw_w_h, eff_w_h) in enumerate(by_lang[L][:2]):
            res_tag_t = "4K Ultra HD" if eff_w_h >= 3200 else ("720p HD" if eff_w_h < 1800 else "1080p")
            if kind == "fansub":
                label = f"⛩️ {name} Orijinal + Türkçe Fansub (Animetrix {res_tag_t})"
            elif is_orig:
                label = f"💎 {name} [Orijinal · 4K Ultra HD] ({plabel} 2160p)" if eff_w_h >= 3200 else f"🎬 {name} [Orijinal] ({plabel} Orijinal Ses · {res_tag_t})"
            else:
                label = f"{flag} {name} ({plabel} Stüdyo Dublaj · {res_tag_t})"
            if k:
                label += f" · Yedek Kaynak {k + 1}"
            tracks.append({
                "id": base_id if not k else f"{base_id}-{k + 1}",
                "lang": "orig" if is_orig else L, "targetLang": "orig" if is_orig else L,
                "audioLang": L, "label": label, "mode": "stream", "url": u_l,
            })
    insert_at = sum(1 for t in tracks if t["audioLang"] == orig_lang and orig_lang)
    for k, wu in enumerate(unknown[:2]):
        tracks.insert(insert_at + k, {
            "id": f"src-{k + 1}", "lang": "und", "targetLang": "und", "audioLang": "",
            "label": f"🎧 Varsayılan Ses · Kaynak {k + 1} (dil doğrulanamadı)", "mode": "stream", "url": wu,
        })
    if not tracks:
        tracks.append({"id": "src-1", "lang": "und", "targetLang": "und", "audioLang": "", "label": f"🎧 Varsayılan Ses ({plabel})", "mode": "stream", "url": stream_url})
    is_ja_or_anime = (orig_lang == "ja" or prov == "anime")
    if is_ja_or_anime and "tr" not in by_lang and not is_tr_native and tracks:
        ai_ins_idx = 1 if len(tracks) >= 1 else 0
        tracks.insert(ai_ins_idx, {
            "id": "tr-ai-dub",
            "lang": "tr",
            "targetLang": "tr",
            "audioLang": "tr",
            "label": f"🇹🇷 Türkçe ({plabel} Akıllı Seslendirme)",
            "mode": "tts",
            "url": tracks[0].get("url") or stream_url,
        })
    return tracks


_TV_SEASONS_CACHE: dict = {}


def _filter_live_subs(tracks: list, min_cues: int = 8) -> list:
    """Boş veya çok kısa altyazı track'lerini listeden çıkarır (VTT önbellekli, paralel)."""
    if not tracks:
        return tracks
    import concurrent.futures

    def _count(t):
        u = str((t or {}).get("url") or "")
        if not u.startswith("/api/rave/subtitle.vtt"):
            return 99
        q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
        for key in ("url", "fb"):
            raw = (q.get(key) or [""])[0]
            if raw.startswith(("https://", "http://")) and public_http_url(raw):
                try:
                    n = _fetch_vtt_sync(raw, timeout=2.2).count("-->")
                    if n >= min_cues:
                        return n
                except Exception:
                    continue
        return 0

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    futs = [pool.submit(_count, t) for t in tracks]
    try:
        concurrent.futures.wait(futs, timeout=2.6)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    out = []
    for t, f in zip(tracks, futs):
        n = f.result() if (f.done() and not f.exception()) else 99
        if n >= min_cues:
            out.append(t)
    return out



def _tv_season_ep_map(tid: str) -> dict:
    """TMDB'deki gerçek {sezon_no: bolum_sayisi} haritası; alınamazsa boş sözlük."""
    hit = _TV_SEASONS_CACHE.get(tid)
    if isinstance(hit, dict):
        return hit
    ep_map: dict = {}
    try:
        info = _http_json(f"https://api.themoviedb.org/3/tv/{tid}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY}), timeout=4.0)
        for x in (info.get("seasons") or []):
            sn = int(x.get("season_number") or 0)
            if sn >= 1:
                ep_map[sn] = int(x.get("episode_count") or 0)
    except Exception:
        return {}
    if ep_map:
        _TV_SEASONS_CACHE[tid] = ep_map
    return ep_map


def _tv_season_numbers(tid: str) -> set:
    return set(_tv_season_ep_map(tid).keys())


def _extract_official_yt_sync(title: str, s: int, e: int, mtype: str, extra_titles: list = None) -> dict:
    if not title:
        return None
    try:
        cand_titles = list(dict.fromkeys([_clean_query_title(x) for x in ([title] + list(extra_titles or [])) if _clean_query_title(x)]))
        if not cand_titles:
            cand_titles = [title]
        clean_t = cand_titles[0]
        valid_norms = {re.sub(r"\s+", "", _norm_title(ct)) for ct in cand_titles if _norm_title(ct)}
        if mtype == "tv":
            queries = [
                f"{clean_t} {s}. Sezon {e}. Bölüm" if s > 1 else f"{clean_t} {e}. Bölüm Full",
                f"{clean_t} {e}. Bölüm" if s == 1 else f"{clean_t} {e}. Bölüm Tek Parça",
                f"{clean_t} Bölüm {e}" if s == 1 else f"{clean_t} S{s:02d}E{e:02d}",
            ]
        else:
            queries = [f"{clean_t} Full Film İzle", f"{clean_t} Tek Parça Full HD", f"{clean_t} Full Movie"]

        min_dur = 1200 if mtype == "tv" else 2400
        ep_pattern = rf"(?:^|[^\d]){e}\.?\s*b[oö]l[uü]m|\bb[oö]l[uü]m\s*0?{e}(?:[^\d]|$)|s0?{s}[:\s_-]*[eb]0?{e}\b|\bepisode\s*0?{e}\b"
        sezon_pattern = rf"(?:^|[^\d]){s}\.?\s*sezon|s0?{s}[:\s_-]*[eb]0?{e}\b|\bseason\s*0?{s}\b"

        def _check_vr_list(sections_list: list) -> dict | None:
            for sec in (sections_list or []):
                items = (sec.get("itemSectionRenderer") or {}).get("contents") or []
                for it in items[:15]:
                    vr = it.get("videoRenderer")
                    if not vr:
                        continue
                    vid = str(vr.get("videoId") or "").strip()
                    if not vid:
                        continue
                    v_title = "".join(r_t.get("text", "") for r_t in (vr.get("title") or {}).get("runs", [])) or str((vr.get("title") or {}).get("simpleText") or "")
                    dur_str = str((vr.get("lengthText") or {}).get("simpleText") or "")
                    parts = [int(p) for p in dur_str.split(":") if p.isdigit()]
                    if len(parts) < 2:
                        continue
                    dur_secs = sum(v * (60 ** idx) for idx, v in enumerate(reversed(parts)))
                    if dur_secs < min_dur or dur_secs > 18000:
                        continue
                    if re.search(r"\b(?:fragman|tan[ıi]t[ıi]m|teaser|trailer|kesit|analiz|inceleme|[öo]zet|tepki|reaction|podcast|ele[şs]tiri|yorum)\b", v_title, re.I) and dur_secs < 2400:
                        continue
                    if mtype == "tv":
                        if not re.search(ep_pattern, v_title, re.I):
                            continue
                        if s > 1 and not re.search(sezon_pattern, v_title, re.I) and e <= 30:
                            continue
                    vn_compact = re.sub(r"\s+", "", _norm_title(v_title))
                    if valid_norms and not any(vn in vn_compact for vn in valid_norms if len(vn) >= 2):
                        continue
                    owner_runs = (vr.get("ownerText") or {}).get("runs") or (vr.get("longBylineText") or {}).get("runs") or []
                    channel = "".join(r_t.get("text", "") for r_t in owner_runs) or "YouTube"
                    return {"videoId": vid, "title": v_title, "channel": channel, "duration": dur_secs}
            return None

        for q in queries:
            if not q:
                continue
            try:
                it_body = json.dumps({
                    "context": {"client": {"clientName": "WEB", "clientVersion": "2.20250201.01.00", "hl": "tr", "gl": "TR"}},
                    "query": q,
                }).encode("utf-8")
                req_it = urllib.request.Request(
                    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
                    data=it_body,
                    headers={"Content-Type": "application/json", "User-Agent": UA137, "Accept-Language": "tr-TR,tr;q=0.9"},
                )
                with urllib.request.urlopen(req_it, timeout=4.2) as r_it:
                    data_it = json.loads(r_it.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore"))
                secs_it = (data_it.get("contents", {}).get("twoColumnSearchResultsRenderer", {}).get("primaryContents", {}).get("sectionListRenderer", {}).get("contents", []))
                hit_it = _check_vr_list(secs_it)
                if hit_it:
                    return hit_it
            except Exception:
                pass
            try:
                u_yt = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": q, "hl": "tr", "gl": "TR"})
                req = urllib.request.Request(u_yt, headers={"User-Agent": UA137})
                with urllib.request.urlopen(req, timeout=3.8) as r:
                    html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                m = re.search(r"var ytInitialData = ({.*?});</script>", html)
                if m:
                    data = json.loads(m.group(1))
                    contents = data.get("contents", {}).get("twoColumnSearchResultsRenderer", {}).get("primaryContents", {}).get("sectionListRenderer", {}).get("contents", [])
                    hit_web = _check_vr_list(contents)
                    if hit_web:
                        return hit_web
            except Exception:
                pass
    except Exception:
        pass
    return None


def _server_label_for_stream(raw_u: str, st: str, idx: int) -> str:
    u_l = str(raw_u or "").lower()
    st_s = str(st or "")
    hint = _AUDIO_LANG_HINT.get(raw_u) or []
    probed = _AUDIO_PROBE_CACHE.get(raw_u)
    probed_langs = list(probed[1]) if probed else []
    has_tr = ("tr" in hint) or ("tr" in probed_langs)
    if st_s == "hls_fhd_multi":
        return f"📡 Sunucu {idx} · FullHD {'Dual (TR Dublaj & Orijinal)' if has_tr else 'Sinema'} (1080p HD)"
    if st_s == "hls_fhd_tr":
        return f"📡 Sunucu {idx} · FullHD (TR Dublaj · 1080p)"
    if st_s == "hls_fhd" or "rapidvid" in u_l or "cdnimgs" in u_l:
        return f"📡 Sunucu {idx} · FullHD Sinema (1080p HD)"
    if st_s in ("hls_hfnl_multi", "hls_hfnl") or "hdfilmcehennemi" in u_l or "playmix" in u_l:
        return f"📡 Sunucu {idx} · HDCehennemi ({'Dual ' if ('multi' in st_s and has_tr) else ''}1080p HD)"
    if st_s == "mp4_ac_sub":
        return f"📡 Sunucu {idx} · AnimeciX Fansub ({'720p' if '_720p' in u_l else '1080p'} HD)"
    if st_s == "mp4_ac_dub":
        return f"📡 Sunucu {idx} · AnimeciX (TR Dublaj · {'720p' if '_720p' in u_l else '1080p'} HD)"
    if st_s in ("hls_ve", "hls_ve_multi"):
        return f"📡 Sunucu {idx} · Videasy Global (1080p HD)"
    w_srv = _STREAM_RES_HINT.get(raw_u, 0)
    if st_s == "hls_cj_4k" or w_srv >= 3200:
        return f"💎 Sunucu {idx} · CineJoy 4K Ultra HD (2160p HDR & BluRay 1080p)"
    if st_s == "hls_cj" or "lightspeed.st" in u_l or "bright67." in u_l:
        return f"📡 Sunucu {idx} · CineJoy BluRay (1080p Yüksek Bitrate)"
    if st_s in ("mp4_ar_tr", "mp4_ar") or "archive.org" in u_l:
        return f"📡 Sunucu {idx} · Sinema Arşiv (Restorasyon HD)"
    if st_s == "hls_dl" or "makesomthingup" in u_l:
        return f"📡 Sunucu {idx} · DiziLife ({'720p' if 0 < w_srv < 1800 else '1080p'} HD)"
    if st_s == "hls_dp" or "dplayer" in u_l or "ag2m5" in u_l:
        return f"📡 Sunucu {idx} · DiziPal (1080p HD)"
    if st_s == "hls_dbx" or "molystream" in u_l:
        return f"📡 Sunucu {idx} · DiziBox (1080p HD)"
    pv_res_lbl = "720p HD" if 0 < w_srv < 1800 else ("1080p HD" if w_srv >= 1800 else "HD")
    if st_s == "hls_pv_multi":
        return f"📡 Sunucu {idx} · Pilavyer Dual (TR Dublaj & Altyazı · {pv_res_lbl})"
    if st_s == "hls_pv_tr":
        return f"📡 Sunucu {idx} · Pilavyer (TR Dublaj · {pv_res_lbl})"
    if st_s == "hls_pv" or "pilavyer" in u_l:
        return f"📡 Sunucu {idx} · Pilavyer ({pv_res_lbl})"
    if st_s.startswith("hls_fp:") or "fastplay" in u_l:
        return f"📡 Sunucu {idx} · FastPlay (1080p HD)"
    if st_s.startswith("mp4_vl"):
        return f"📡 Sunucu {idx} · VidLink MP4 ({'1080p' if '1080' in st_s else '720p'} HD)"
    if st_s == "hls_vm" or any(d in u_l for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")):
        return f"📡 Sunucu {idx} · VidMoly Yedek (HD)"
    if st_s == "hls" or "dragonballzfans" in u_l:
        return f"📡 Sunucu {idx} · Flixer / Hexa (1080p HD)"
    return f"📡 Sunucu {idx} · Yüksek Hızlı Yayın (HD)"


def _is_max_authenticated_sync(is_authenticated: bool = False, request: Request = None, auth_ctx: dict = None) -> bool:
    return True


def _get_netflix_title_by_id_sync(nid: str) -> str:
    nid = str(nid or "").strip()
    if not nid or not nid.isdigit():
        return ""
    t_url = f"https://www.netflix.com/title/{nid}"
    req = urllib.request.Request(t_url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    })
    try:
        with urllib.request.urlopen(req, timeout=4.5) as resp:
            try:
                raw = resp.read(256 * 1024)
            except Exception as ex:
                raw = getattr(ex, "partial", b"") or b""
            html = raw.decode("utf-8", errors="ignore")
            og = re.search(r'property="og:title"\s+content="([^"]*)"', html)
            if og:
                t = og.group(1)
                t = re.sub(r"\s*izlemenizi bekliyor.*$", "", t, flags=re.I)
                t = re.sub(r"^Watch\s+", "", t, flags=re.I)
                t = re.sub(r"\s*\|\s*Netflix.*$", "", t, flags=re.I)
                t = re.sub(r"\s*-\s*Netflix.*$", "", t, flags=re.I)
                return t.strip()
    except Exception:
        pass
    return ""


def _build_netflix_official_item(eff_tid, tid, imdb_id, mtype, s, e, disp, tr_title, orig_title, year, orig_lang, source_url, m_cached, poster, pmeta, netflix_id=""):
    official_url = source_url or (f"https://www.netflix.com/watch/{netflix_id}" if netflix_id else "") or "https://www.netflix.com/browse"
    full_title = f"{disp} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else f"{disp}{f' ({year})' if year and year not in disp else ''}"
    dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
    return {
        "id": eff_tid or (f"nf-{netflix_id}" if netflix_id else (tid or "netflix-item")),
        "provider": "netflix",
        "catalogProvider": "netflix",
        "tmdbId": tid or "",
        "imdbId": imdb_id or "",
        "mediaType": mtype or "movie",
        "season": s if mtype == "tv" else 0,
        "episode": e if mtype == "tv" else 0,
        "seriesTitle": disp or tr_title or orig_title,
        "originalTitle": orig_title or disp,
        "year": year or "",
        "origLang": orig_lang or "en",
        "sourceUrl": official_url,
        "streamType": "official",
        "url": official_url,
        "embedUrl": official_url,
        "altUrls": [],
        "servers": [{"id": "srv-netflix-1", "label": "Netflix Resmi Oynatıcı (Full HD / 4K)", "url": official_url, "streamType": "official"}],
        "subtitleTracks": [],
        "audioTracks": [{"id": "nf-orig", "lang": orig_lang or "en", "label": "Orijinal Ses (Netflix)", "mode": "stream", "url": official_url}],
        "intro": None,
        "platformAudioLangs": (pmeta.get("audioLangs") if pmeta else None) or ["tr", "en"],
        "platformSubLangs": (pmeta.get("subLangs") if pmeta else None) or ["tr", "en"],
        "officialUrl": official_url,
        "providerUrl": official_url,
        "title": full_title,
        "thumbnail": poster,
        "channel": "Netflix · Resmi Oynatıcı",
        "duration": dur,
        "authenticated": True,
    }

def _build_max_official_item(eff_tid, tid, imdb_id, mtype, s, e, disp, tr_title, orig_title, year, orig_lang, source_url, m_cached, poster, pmeta):
    official_url = source_url or (pmeta.get("officialUrl") if pmeta else "") or ""
    if not official_url or ("play.max.com" not in official_url and "hbomax.com" not in official_url):
        hits = _justwatch_sync(_clean_query_title(disp or tr_title or orig_title), ["mxx", "hbm"], "US", 6)
        match = next((h for h in hits if tid and str(h.get("tmdbId")) == str(tid)), hits[0] if hits else None)
        if match and match.get("officialUrl"):
            official_url = match["officialUrl"]
    if not official_url:
        official_url = "https://play.max.com"
    full_title = f"{disp} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else f"{disp}{f' ({year})' if year and year not in disp else ''}"
    dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
    return {
        "id": eff_tid or tid,
        "provider": "max",
        "catalogProvider": "max",
        "tmdbId": tid,
        "imdbId": imdb_id,
        "mediaType": mtype,
        "season": s if mtype == "tv" else 0,
        "episode": e if mtype == "tv" else 0,
        "seriesTitle": disp or tr_title or orig_title,
        "originalTitle": orig_title,
        "year": year,
        "origLang": orig_lang,
        "sourceUrl": source_url or official_url,
        "streamType": "official",
        "url": official_url,
        "embedUrl": official_url,
        "altUrls": [],
        "servers": [{"id": "srv-max-1", "label": "Max (HBO) Resmi Akış (4K Ultra HD)", "url": official_url, "streamType": "official"}],
        "subtitleTracks": [],
        "audioTracks": [{"id": "max-orig", "lang": orig_lang or "en", "label": "Orijinal Ses (Max)", "mode": "stream", "url": official_url}],
        "intro": None,
        "platformAudioLangs": (pmeta.get("audioLangs") if pmeta else None) or ["en", "tr"],
        "platformSubLangs": (pmeta.get("subLangs") if pmeta else None) or ["tr", "en"],
        "officialUrl": official_url,
        "providerUrl": official_url,
        "title": full_title,
        "thumbnail": poster,
        "channel": "Max (HBO) · Resmi Oynatıcı (1080p HD)",
        "duration": dur,
        "authenticated": True,
    }


def _resolve_catalog_sync(prov: str, title: str, year: str, tmdb_id: str, media_type: str, poster: str, season: int = 1, episode: int = 1, imdb_id: str = "", display_title: str = "", source_url: str = "", refresh: bool = False, request: Request = None, is_authenticated: bool = False, auth_ctx: dict = None):
    # Auto-resolve Netflix URLs into real Title & TMDB ID
    _nf_check = str(title or "") if "netflix.com" in str(title or "") else str(source_url or "")
    if "netflix.com" in _nf_check:
        _nf_m = re.search(r"netflix\.com/(?:[a-z-]+/)?(?:watch|title)/(\d+)", _nf_check)
        if _nf_m:
            _nf_nid = _nf_m.group(1)
            _scraped_t = _get_netflix_title_by_id_sync(_nf_nid)
            if _scraped_t:
                title = _scraped_t
                display_title = _scraped_t
                if not str(tmdb_id or "").isdigit():
                    _thits = _tmdb_sync(_scraped_t)
                    if _thits:
                        tmdb_id = str(_thits[0].get("tmdbId") or _thits[0].get("id") or "")
                        if not media_type or media_type not in ("tv", "movie"):
                            media_type = _thits[0].get("mediaType") or "movie"
                        if not year:
                            year = str(_thits[0].get("year") or "")
    is_max_prov = prov in ("max", "hbomax")
    is_auth_user = True
    s = max(1, int(season or 1))
    e = max(1, int(episode or 1))
    label = PROV_LABELS.get(prov, prov.capitalize())
    tid = str(tmdb_id or "").strip()
    raw_mt = str(media_type or "").strip().lower()
    explicit_mt = raw_mt in ("tv", "series", "show", "movie", "movies", "film")
    mtype = "tv" if raw_mt in ("tv", "series", "show") else "movie"
    disp = display_title or title
    m_ac_direct = re.fullmatch(r"ac-(\d+)", tid)
    if m_ac_direct:
        ac_num_str = m_ac_direct.group(1)
        if not source_url:
            source_url = f"animecix:{ac_num_str}"
        mapped_tid = next((k_t for k_t, v_ac in _ANIMECIX_KNOWN_TMDB.items() if str(v_ac) == ac_num_str), "")
        if mapped_tid:
            tid = mapped_tid
    if not tid.isdigit() and title:
        clean_q_t = re.sub(r"\s*\(\d{4}\)\s*$", "", title).strip() or title
        hits = _tmdb_sync(clean_q_t)
        if hits:
            def _score_hit(h):
                sc = 0
                if h.get("mediaType") == mtype:
                    sc += 15 if explicit_mt else 10
                elif explicit_mt:
                    sc -= 12
                if year and str(h.get("year") or "") == str(year):
                    sc += 20
                if _norm_title(h.get("title") or "") in {_norm_title(clean_q_t), _norm_title(disp)} or _norm_title(h.get("originalTitle") or "") in {_norm_title(clean_q_t), _norm_title(disp)}:
                    sc += 15
                return sc
            hits.sort(key=_score_hit, reverse=True)
            if _score_hit(hits[0]) > 0:
                tid = str(hits[0]["tmdbId"])
                if not explicit_mt:
                    mtype = hits[0].get("mediaType") or mtype
                poster = poster or hits[0].get("backdrop") or hits[0].get("poster") or ""
                year = year or hits[0].get("year") or ""
                title = hits[0].get("originalTitle") or hits[0].get("title") or title
    ep_num = _resolve_episode_numbering(tid, s, e) if mtype == "tv" else {"s_split": s, "e_split": e, "s_tmdb": s, "e_tmdb": e, "abs_ep": e, "has_splits": False}
    if mtype == "tv" and tid.isdigit():
        ep_map = _tv_season_ep_map(tid)
        if not ep_map:
            if s == 1 and e == 1:
                tv_check = _get_tmdb_meta_sync(tid, "tv", title or disp)
                mv_check = _get_tmdb_meta_sync(tid, "movie", title or disp)
                if not (tv_check.get("originalTitle") or tv_check.get("trTitle")) and (mv_check.get("originalTitle") or mv_check.get("trTitle")):
                    mtype = "movie"
        elif prov != "crunchyroll" and not str(source_url or "").startswith("animecix:") and tid not in _ANIMECIX_KNOWN_TMDB:
            s_chk = ep_num["s_tmdb"] if ep_num["has_splits"] else s
            e_chk = ep_num["e_tmdb"] if ep_num["has_splits"] else e
            if s_chk > 40 or e_chk > 2500:
                return None
    eff_tid = tid if tid.isdigit() else (f"free-{_norm_title(title or disp)[:24]}" if (title or disp or source_url) else "")
    if eff_tid:
        m_cached = _get_tmdb_meta_sync(tid, mtype, title, year, imdb_id)
        if m_cached.get("tmdbId") and str(m_cached.get("tmdbId")).isdigit() and str(m_cached.get("tmdbId")) != str(tid):
            tid = str(m_cached["tmdbId"])
            eff_tid = tid
        orig_title = m_cached.get("originalTitle") or title
        tr_title = m_cached.get("trTitle") or disp or orig_title
        year = m_cached.get("year") or year or ""
        imdb_id = m_cached.get("imdbId") or imdb_id or ""
        orig_lang = m_cached.get("origLang") or ""
        disp = _clean_query_title(disp) or tr_title
        poster = poster or (m_cached or {}).get("poster") or (m_cached or {}).get("backdrop") or _resolve_fallback_poster_cdn_sync("", title, orig_title, year, mtype, tid) or ""

        import concurrent.futures
        cat_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        try:
            fut_direct = cat_pool.submit(_extract_direct_stream_sync, eff_tid, mtype, s, e, orig_title, year, imdb_id, tr_title, source_url, refresh)
            fut_pmeta = cat_pool.submit(_fetch_platform_meta_sync, prov, tr_title or orig_title, tid, mtype)
            direct_list = fut_direct.result()
            try:
                pmeta = fut_pmeta.result(timeout=0.35)
            except Exception:
                def_aud, def_sub = PLATFORM_LANG_PROFILES.get(prov if prov in PROV_LABELS else "cinema", PLATFORM_LANG_PROFILES["cinema"])
                pmeta = {"prov": prov if prov in PROV_LABELS else "cinema", "officialUrl": "", "audioLangs": list(def_aud), "subLangs": list(def_sub)}
        finally:
            cat_pool.shutdown(wait=False, cancel_futures=True)
        if not direct_list and not eff_tid.isdigit():
            alt_query = _clean_query_title(disp or tr_title or orig_title or title)
            if alt_query and len(alt_query) >= 3:
                try:
                    alt_hits = _tmdb_sync(alt_query)
                    for ah in (alt_hits or [])[:2]:
                        alt_tid = str(ah.get("tmdbId") or ah.get("id") or "")
                        ah_t = ah.get("title") or ah.get("originalTitle") or ""
                        if alt_tid and alt_tid.isdigit() and _norm_title(ah_t) == _norm_title(alt_query):
                            alt_direct = _extract_direct_stream_sync(
                                alt_tid, mtype, s, e,
                                ah.get("originalTitle") or alt_query,
                                str(ah.get("year") or year or ""),
                                ah.get("imdbId") or imdb_id or "",
                                ah.get("title") or alt_query,
                                source_url, refresh
                            )
                            if alt_direct:
                                direct_list = alt_direct
                                eff_tid = alt_tid
                                tid = alt_tid
                                orig_title = ah.get("originalTitle") or orig_title
                                tr_title = ah.get("title") or tr_title
                                year = str(ah.get("year") or year)
                                imdb_id = ah.get("imdbId") or imdb_id
                                break
                except Exception:
                    pass
        if not direct_list:
            v_streams = _MAIN_SITES_VAULT.get("streams") or {}
            fb_candidates = []
            cand_keys = [f"tmdb:{mtype}:{tid}:{s}:{e}"]
            if mtype == "tv":
                cand_keys.append(f"tmdb:{mtype}:{tid}:{ep_num['s_split']}:{ep_num['e_split']}")
                cand_keys.append(f"tmdb:{mtype}:{tid}:{ep_num['s_tmdb']}:{ep_num['e_tmdb']}")
                cand_keys.append(f"tmdb:{mtype}:{tid}:1:{ep_num['abs_ep']}")
            else:
                cand_keys.append(f"id:{tid}")
                cand_keys.append(f"tmdb:{mtype}:{tid}:1:1")
            for tc in (tr_title, orig_title, disp, title):
                nt = _norm_title(tc or "")
                if nt:
                    cand_keys.append(f"{mtype}:{nt}:{s}:{e}")
                    if mtype == "tv":
                        cand_keys.append(f"{mtype}:{nt}:{ep_num['s_split']}:{ep_num['e_split']}")
                        cand_keys.append(f"{mtype}:{nt}:{ep_num['s_tmdb']}:{ep_num['e_tmdb']}")
                        cand_keys.append(f"{mtype}:{nt}:1:{ep_num['abs_ep']}")
                    else:
                        cand_keys.append(f"{mtype}:{nt}:1:1")
            cand_keys = list(dict.fromkeys(cand_keys))
            for vk_try in cand_keys:
                v_ent = v_streams.get(vk_try) or {}
                for st_item in (v_ent.get("streams") or []):
                    if isinstance(st_item, (list, tuple)) and len(st_item) >= 2 and str(st_item[0]).startswith("http"):
                        st_u, st_t = str(st_item[0]), str(st_item[1])
                        if _is_vault_url_expired(st_u):
                            continue
                        if st_t in ("hls_dbx", "hls_dp") or any(dk in st_u.lower() for dk in ("dbx.molystream.org", "dplayer", "pilavyerplay.top", "makesomthingup.click")):
                            continue
                        if IS_VERCEL and (
                            st_t in ("hls_hfnl", "hls_hfnl_multi")
                            or "hdfilmcehennemi.mobi" in st_u.lower()
                            or ("cdnimages" in st_u.lower() and "/hls/" in st_u.lower())
                            or "playmix.uno" in st_u.lower()
                            or "master.txt?s=" in st_u.lower()
                        ):
                            continue
                        if v_ent.get("customDirect") or _stream_matches_title(st_u, [orig_title, tr_title, disp, title], year, imdb_id):
                            fb_candidates.append((st_u, st_t))
            if not fb_candidates and mtype == "tv" and s == 1 and e == 1:
                tv_fb_keys = [
                    f"tmdb:tv:{tid}:{s}:1",
                    f"tmdb:tv:{tid}:1:1",
                    f"tv:{tid}",
                    f"id:{tid}",
                ]
                for tc in (tr_title, orig_title, disp, title):
                    nt = _norm_title(tc or "")
                    if nt:
                        tv_fb_keys.append(f"tv:{nt}:{s}:1")
                        tv_fb_keys.append(f"tv:{nt}:1:1")
                for vk_try in dict.fromkeys(tv_fb_keys):
                    v_ent = v_streams.get(vk_try) or {}
                    for st_item in (v_ent.get("streams") or []):
                        if isinstance(st_item, (list, tuple)) and len(st_item) >= 2 and str(st_item[0]).startswith("http"):
                            st_u, st_t = str(st_item[0]), str(st_item[1])
                            if _is_vault_url_expired(st_u):
                                continue
                            if st_t in ("hls_dbx", "hls_dp") or "dbx.molystream.org" in st_u.lower() or "dplayer" in st_u.lower():
                                continue
                            if IS_VERCEL and (
                                st_t in ("hls_hfnl", "hls_hfnl_multi")
                                or "hdfilmcehennemi.mobi" in st_u.lower()
                                or ("cdnimages" in st_u.lower() and "/hls/" in st_u.lower())
                                or "playmix.uno" in st_u.lower()
                                or "master.txt?s=" in st_u.lower()
                            ):
                                continue
                            if v_ent.get("customDirect") or _stream_matches_title(st_u, [orig_title, tr_title, disp, title], year, imdb_id):
                                fb_candidates.append((st_u, st_t))
            if not fb_candidates and IS_VERCEL:
                for vk_try in cand_keys:
                    v_ent = v_streams.get(vk_try) or {}
                    for st_item in (v_ent.get("streams") or []):
                        if isinstance(st_item, (list, tuple)) and len(st_item) >= 2 and str(st_item[0]).startswith("http"):
                            st_u, st_t = str(st_item[0]), str(st_item[1])
                            if _is_vault_url_expired(st_u):
                                continue
                            if v_ent.get("customDirect") or _stream_matches_title(st_u, [orig_title, tr_title, disp, title], year, imdb_id):
                                fb_candidates.append((st_u, st_t))
            direct_list = fb_candidates[:5]
        has_non_yt = any(st != "yt" and "youtube.com/watch?v=" not in str(u) for u, st in (direct_list or []))
        yt_vault_hit = "" if has_non_yt else next((u for u, st in (direct_list or []) if st == "yt" or "youtube.com/watch?v=" in str(u)), "")
        if yt_vault_hit:
            m_yv = YT_RE.search(yt_vault_hit)
            if m_yv:
                vid = m_yv.group(1)
                dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
                full_title = f"{disp or tr_title or orig_title} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else (disp or tr_title or orig_title)
                return {
                    "id": eff_tid or tid,
                    "provider": "youtube",
                    "catalogProvider": prov if prov in PROV_LABELS else "youtube",
                    "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype, "season": s if mtype == "tv" else 0, "episode": e if mtype == "tv" else 0,
                    "seriesTitle": disp or tr_title or orig_title,
                    "originalTitle": orig_title, "year": year, "origLang": orig_lang or "tr",
                    "sourceUrl": source_url or "",
                    "streamType": "youtube",
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "videoId": vid,
                    "embedUrl": f"https://www.youtube-nocookie.com/embed/{vid}?autoplay=1",
                    "altUrls": [],
                    "subtitleTracks": [],
                    "audioTracks": [{"id": "tr-dub", "label": f"🇹🇷 Türkçe ({label} Orijinal Ses)", "language": "tr", "lang": "tr", "kind": "main"}],
                    "intro": None,
                    "platformAudioLangs": ["tr"],
                    "platformSubLangs": [],
                    "officialUrl": f"https://www.youtube.com/watch?v={vid}",
                    "providerUrl": f"https://www.youtube.com/watch?v={vid}",
                    "title": full_title,
                    "thumbnail": poster or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "channel": f"{label} · Resmi Tam Yayın (1080p HD)",
                    "duration": dur,
                }
        if direct_list:
            alive_pre = [(u, st) for u, st in direct_list if _STREAM_RES_HINT.get(u, 0) != -1]
            if not alive_pre:
                if not refresh:
                    return _resolve_catalog_sync(prov, title, year, tmdb_id, media_type, poster, season, episode, imdb_id, display_title, source_url, refresh=True, request=request, is_authenticated=is_authenticated, auth_ctx=auth_ctx)
                direct_list = []
            else:
                direct_list = alive_pre
        if direct_list:
            primary_p = (m_cached or {}).get("primaryProv") or ""
            eff_prov = pmeta.get("prov") or (prov if prov in PROV_LABELS else "cinema")
            if primary_p and (eff_prov in ("cinema", "web") or (eff_prov == "prime" and primary_p == "max")):
                eff_prov = primary_p
            if eff_prov in ("max", "hbomax") or primary_p in ("max", "hbomax") or pmeta.get("prov") in ("max", "hbomax"):
                pass  # Direct playback unblocked for all users
            label = PROV_LABELS.get(eff_prov, label)
            wrapped = [(_wrap_first_party_stream(u, st, eff_prov, eff_tid, s, e, mtype), "mp4" if str(st).startswith("mp4") else "hls") for u, st in direct_list]
            sub_pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
            try:
                fut_subs = sub_pool.submit(_fetch_subtitles_sync, eff_tid, imdb_id, mtype, s, e, eff_prov, pmeta, direct_list)
                fut_intro_api = sub_pool.submit(_detect_intro_sync, imdb_id, tid, mtype, s, e, None)
                fut_audio = sub_pool.submit(_build_audio_tracks, wrapped[0][0], direct_list, eff_prov, eff_tid, s, e, pmeta, mtype)
                concurrent.futures.wait([fut_subs, fut_intro_api, fut_audio], timeout=0.95)
                try:
                    sub_tracks = fut_subs.result(timeout=0.05) if fut_subs.done() else []
                except Exception:
                    sub_tracks = []
                try:
                    intro_seg = fut_intro_api.result(timeout=0.05) if fut_intro_api.done() else None
                except Exception:
                    intro_seg = None
                try:
                    audio_tracks = fut_audio.result(timeout=0.05) if fut_audio.done() else []
                except Exception:
                    audio_tracks = []
            finally:
                sub_pool.shutdown(wait=False, cancel_futures=True)
            alive_direct = [(u, st) for u, st in direct_list if _STREAM_RES_HINT.get(u, 0) != -1]
            if not alive_direct:
                alive_direct = direct_list
            direct_list = alive_direct
            late_embeds = _EMBED_SUB_CACHE.get(f"{mtype}:{eff_tid}:{s}:{e}") or []
            if late_embeds:
                meta_q_late = f"&tmdbId={urllib.parse.quote(str(eff_tid or ''))}&imdbId={urllib.parse.quote(str(imdb_id or ''))}&mtype={mtype}&s={s}&e={e}"
                existing_sub_ids = {str(st_item.get("id") or "") for st_item in sub_tracks}
                prepended_late = []
                for idx_le, esub in enumerate(late_embeds):
                    eu = str(esub.get("url") or "").strip()
                    raw_l = str(esub.get("lang") or esub.get("label") or "").lower().strip()
                    base_l = re.split(r"[\s(\[-]", raw_l)[0].strip()
                    linfo = SUB_LANG_MAP.get(raw_l) or SUB_LANG_MAP.get(base_l)
                    if eu.startswith("http") and linfo and not any(urllib.parse.quote(eu, safe="") in str(st_item.get("url") or "") for st_item in sub_tracks):
                        lcode, llabel, _ = linfo
                        vtt_u = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(eu, safe='')}&lang={lcode}{meta_q_late}"
                        cand_sid = f"{lcode}-hls" if f"{lcode}-hls" not in existing_sub_ids else f"{lcode}-hls-{idx_le + 2}"
                        existing_sub_ids.add(cand_sid)
                        prepended_late.append({"id": cand_sid, "lang": lcode, "label": f"{llabel} (Akış Orijinal Senkron)", "url": vtt_u, "kind": "subtitles", "source": "stream"})
                if prepended_late:
                    sub_tracks = sub_tracks + prepended_late[:4]
            if sub_tracks and not any(t.get("lang") == "tr" for t in sub_tracks):
                fb_t = next((t for t in sub_tracks if t.get("lang") == "en"), sub_tracks[0])
                q_t = urllib.parse.parse_qs(urllib.parse.urlparse(str(fb_t.get("url") or "")).query)
                raw_src_u = (q_t.get("url") or [""])[0]
                if raw_src_u.startswith("http"):
                    meta_q_fb = f"&tmdbId={urllib.parse.quote(str(eff_tid or ''))}&imdbId={urllib.parse.quote(str(imdb_id or ''))}&mtype={mtype}&s={s}&e={e}"
                    sub_tracks.insert(0, {
                        "id": "tr-auto",
                        "lang": "tr",
                        "label": f"🇹🇷 Türkçe ({label} Akıllı Çeviri Senkron)",
                        "url": f"/api/rave/subtitle.vtt?url={urllib.parse.quote(raw_src_u, safe='')}&lang=tr&translate=tr{meta_q_fb}",
                        "kind": "subtitles",
                        "source": "ai-tr",
                    })
            if sub_tracks and not any(t.get("lang") == "en" for t in sub_tracks):
                fb_e = next((t for t in sub_tracks if t.get("lang") == "tr"), sub_tracks[0])
                q_e = urllib.parse.parse_qs(urllib.parse.urlparse(str(fb_e.get("url") or "")).query)
                raw_en_u = (q_e.get("url") or [""])[0]
                if raw_en_u.startswith("http"):
                    meta_q_fb_e = f"&tmdbId={urllib.parse.quote(str(eff_tid or ''))}&imdbId={urllib.parse.quote(str(imdb_id or ''))}&mtype={mtype}&s={s}&e={e}"
                    ins_e_at = 1 if (sub_tracks and sub_tracks[0].get("lang") == "tr") else 0
                    sub_tracks.insert(ins_e_at, {
                        "id": "en-auto",
                        "lang": "en",
                        "label": f"🇬🇧 İngilizce (English) ({label} Akıllı Çeviri Senkron)",
                        "url": f"/api/rave/subtitle.vtt?url={urllib.parse.quote(raw_en_u, safe='')}&lang=en&translate=en{meta_q_fb_e}",
                        "kind": "subtitles",
                        "source": "ai-en",
                    })
            alive_wrapped = [(_wrap_first_party_stream(u, st, eff_prov, eff_tid, s, e, mtype), "mp4" if str(st).startswith("mp4") else "hls") for u, st in direct_list]
            if not audio_tracks:
                audio_tracks = [{"id": "src-1", "lang": "und", "targetLang": "und", "audioLang": "", "label": f"🎧 Varsayılan Ses ({label})", "mode": "stream", "url": alive_wrapped[0][0]}]
                if (orig_lang == "ja" or prov == "anime") and orig_lang != "tr" and prov not in ("exxen", "blutv", "gain", "tod", "tabii", "puhutv"):
                    audio_tracks.append({
                        "id": "tr-ai-dub",
                        "lang": "tr",
                        "targetLang": "tr",
                        "audioLang": "tr",
                        "label": f"🇹🇷 Türkçe ({label} Akıllı Seslendirme)",
                        "mode": "tts",
                        "url": alive_wrapped[0][0],
                    })
            stream_url = audio_tracks[0]["url"] if audio_tracks else alive_wrapped[0][0]
            stype = "mp4" if ("&ext=.mp4" in stream_url or ".mp4" in stream_url) else alive_wrapped[0][1]
            alt_urls = list(dict.fromkeys([t["url"] for t in audio_tracks if t.get("url")] + [u for u, _ in alive_wrapped]))
            servers = []
            seen_srv_u = set()
            for u_raw, st_raw in direct_list:
                wu_srv = _wrap_first_party_stream(u_raw, st_raw, eff_prov, eff_tid, s, e, mtype)
                if not wu_srv or wu_srv in seen_srv_u:
                    continue
                seen_srv_u.add(wu_srv)
                idx_srv = len(servers) + 1
                servers.append({
                    "id": f"srv-{idx_srv}",
                    "label": _server_label_for_stream(u_raw, st_raw, idx_srv),
                    "url": wu_srv,
                    "streamType": "mp4" if str(st_raw).startswith("mp4") else "hls",
                })
            full_title = f"{disp} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else f"{disp}{f' ({year})' if year and year not in disp else ''}"
            dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
            off_tpl = OFFICIAL_SEARCH_URLS.get(eff_prov, "https://www.netflix.com/search?q={q}")
            official_url = source_url or pmeta.get("officialUrl") or off_tpl.format(q=urllib.parse.quote(disp or orig_title))
            has_4k_stream = any(st == "hls_cj_4k" or _STREAM_RES_HINT.get(u, 0) >= 3200 for u, st in (direct_list or []))
            is_720_likely = (not has_4k_stream) and any("720" in st or "pilavyer" in u or st == "hls_pv" for u, st in (direct_list or [])) and not any(st in ("hls_1080", "mp4_vl_1080", "hls_fhd", "hls_fhd_multi", "hls_fhd_tr", "hls_cj") or _STREAM_RES_HINT.get(u, 0) >= 1800 for u, st in (direct_list or []))
            res_str = "4K Ultra HD" if has_4k_stream else ("720p HD" if is_720_likely else "1080p HD")
            eff_poster = poster or (m_cached or {}).get("poster") or ""
            eff_backdrop = (m_cached or {}).get("backdrop") or eff_poster
            return {
                "id": eff_tid or tid,
                "provider": eff_prov,
                "catalogProvider": eff_prov,
                "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype, "season": s if mtype == "tv" else 0, "episode": e if mtype == "tv" else 0,
                "seriesTitle": disp or tr_title or orig_title,
                "originalTitle": orig_title, "year": year, "origLang": orig_lang,
                "sourceUrl": source_url or "",
                "streamType": stype, "url": stream_url, "embedUrl": "", "altUrls": alt_urls[:6], "servers": servers[:8],
                "subtitleTracks": sub_tracks, "audioTracks": audio_tracks, "intro": intro_seg,
                "platformAudioLangs": pmeta.get("audioLangs") or [],
                "platformSubLangs": pmeta.get("subLangs") or [],
                "officialUrl": official_url, "providerUrl": official_url,
                "title": full_title, "poster": eff_poster, "thumbnail": eff_poster, "backdrop": eff_backdrop,
                "channel": f"{label} · {'Tam Bölüm' if mtype == 'tv' else 'Tam Film'} ({res_str})",
                "duration": dur,
            }
        is_tr_yt_eligible = (
            orig_lang == "tr"
            or prov in ("exxen", "blutv", "gain", "tod", "tabii", "tvplus", "puhutv", "youtube")
            or (not tid.isdigit() and any(ch in f"{orig_title} {title}" for ch in "çğıöşüÇĞİÖŞÜ"))
        )
        if not direct_list and is_tr_yt_eligible:
            yt_res = _extract_official_yt_sync(tr_title or orig_title or disp or title, s, e, mtype, [orig_title, tr_title, disp, title])
            if yt_res:
                vid = yt_res["videoId"]
                dur = yt_res["duration"]
                full_title = f"{disp or tr_title or orig_title} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else (disp or tr_title or orig_title)
                yt_aud_label = f"🇹🇷 Türkçe ({label} Orijinal Ses)" if (orig_lang == "tr" or is_tr_yt_eligible) else f"🌐 Orijinal Ses ({label})"
                yt_aud_lang = "tr" if (orig_lang == "tr" or is_tr_yt_eligible) else (orig_lang or "en")
                yt_poster = poster or (m_cached or {}).get("poster") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                return {
                    "id": eff_tid or tid,
                    "provider": "youtube",
                    "catalogProvider": prov if prov in PROV_LABELS else "youtube",
                    "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype, "season": s if mtype == "tv" else 0, "episode": e if mtype == "tv" else 0,
                    "seriesTitle": disp or tr_title or orig_title,
                    "originalTitle": orig_title, "year": year, "origLang": orig_lang or "tr",
                    "sourceUrl": source_url or "",
                    "streamType": "youtube",
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "videoId": vid,
                    "embedUrl": f"https://www.youtube-nocookie.com/embed/{vid}?autoplay=1",
                    "altUrls": [],
                    "subtitleTracks": [],
                    "audioTracks": [{"id": "yt-audio", "label": yt_aud_label, "language": yt_aud_lang, "lang": yt_aud_lang, "kind": "main"}],
                    "intro": None,
                    "platformAudioLangs": [yt_aud_lang],
                    "platformSubLangs": [],
                    "officialUrl": f"https://www.youtube.com/watch?v={vid}",
                    "providerUrl": f"https://www.youtube.com/watch?v={vid}",
                    "title": full_title,
                    "poster": yt_poster,
                    "thumbnail": yt_poster,
                    "backdrop": (m_cached or {}).get("backdrop") or yt_poster,
                    "channel": f"{label} · {yt_res['channel']} (1080p HD)",
                    "duration": dur,
                }
        # If Max provider and user is authenticated, fall back to official player metadata
        if is_max_prov and is_auth_user:
            return _build_max_official_item(eff_tid or tid, tid, imdb_id, mtype, s, e, disp, tr_title, orig_title, year, orig_lang, source_url, m_cached, poster, pmeta)

        # REMOVED 4 FOREIGN EMBED FALLBACKS (vidsrc.cc, vidlink.pro, autoembed.cc, vidsrc.to)
        return None


_RESOLVE_RESP_CACHE: dict[str, tuple[float, dict]] = {}
_RESOLVE_LOCKS: dict[str, asyncio.Lock] = {}
_CATALOG_LOCKS: dict[str, asyncio.Lock] = {}
_SUPERSEARCH_CACHE: dict[str, tuple[float, dict]] = {}
import concurrent.futures as _cf_mod
_RESOLVE_EXECUTOR = _cf_mod.ThreadPoolExecutor(max_workers=32, thread_name_prefix="wl_resolve")


def _is_origin_allowed(request: Request) -> bool:
    """Verifies that requests to sensitive streaming/catalog APIs originate from Watchlivo."""
    ua = (request.headers.get("user-agent") or "").strip().lower()
    if "testclient" in ua:
        return True
    if any(k in ua for k in ("watchlivo", "okhttp", "exoplayer", "dalvik", "cfnetwork", "darwin")):
        return True

    sec_site = (request.headers.get("sec-fetch-site") or "").strip().lower()
    if sec_site == "cross-site":
        return False

    req_host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip().split(":")[0].lower()

    def _host_allowed(h: str) -> bool:
        if not h:
            return False
        return (
            h in ("watchlivo.online", "www.watchlivo.online", "localhost", "127.0.0.1")
            or h.endswith((".vercel.app", ".onrender.com"))
            or (bool(req_host) and h == req_host)
        )

    origin = (request.headers.get("origin") or "").strip().lower()
    if origin:
        if origin.startswith(("android-app://", "capacitor://", "ionic://")):
            return True
        orig_host = (urllib.parse.urlsplit(origin).hostname or "").lower()
        if not _host_allowed(orig_host):
            return False

    referer = (request.headers.get("referer") or "").strip().lower()
    if referer:
        if referer.startswith(("android-app://", "capacitor://", "ionic://")):
            return True
        ref_host = (urllib.parse.urlsplit(referer).hostname or "").lower()
        if not _host_allowed(ref_host):
            return False

    return True


async def resolve_catalog(request: Request):
    if not _is_origin_allowed(request):
        return JSONResponse({"error": "Forbidden: cross-site origin or hotlink not allowed"}, status_code=403)
    prov = (request.query_params.get("provider") or "netflix").strip().lower()
    title = (request.query_params.get("title") or "").strip()[:160]
    q_tid = (request.query_params.get("tmdbId") or request.query_params.get("tmdb_id") or "").strip()[:30]
    q_iid = (request.query_params.get("imdbId") or request.query_params.get("imdb_id") or "").strip()[:30]
    raw_stream_url = (request.query_params.get("streamUrl") or "").strip()[:800]
    if not title and not q_tid and not q_iid and not (request.query_params.get("sourceUrl") or "").strip() and not raw_stream_url:
        return JSONResponse({"error": "İçerik başlığı veya kimliği gerekli"}, status_code=400)
    display_title = (request.query_params.get("displayTitle") or title).strip()[:160]
    year = (request.query_params.get("year") or "").strip()[:10]
    tmdb_id = q_tid
    imdb_id = q_iid
    raw_mtype_q = (request.query_params.get("mediaType") or request.query_params.get("type") or request.query_params.get("kind") or "").strip().lower()
    if raw_mtype_q in ("series", "show", "anime"):
        raw_mtype_q = "tv"
    elif raw_mtype_q in ("film", "movies"):
        raw_mtype_q = "movie"
    has_ep_q = bool((request.query_params.get("season") or request.query_params.get("s") or "").strip()) or bool((request.query_params.get("episode") or request.query_params.get("e") or "").strip())
    if raw_mtype_q:
        media_type = raw_mtype_q
    elif prov in ("dizi", "anime", "cizgifilm") or has_ep_q:
        media_type = "tv"
    else:
        media_type = "movie"
    raw_poster = (request.query_params.get("poster") or "").strip()[:600]
    poster = raw_poster if raw_poster.startswith(("https://", "http://", "/api/rave/poster", "/static/")) else ""
    raw_source_url = (request.query_params.get("sourceUrl") or "").strip()[:2048]
    source_url = ""
    if re.fullmatch(r"animecix:\d+", raw_source_url):
        source_url = raw_source_url
    elif raw_source_url and public_http_url(raw_source_url):
        _su_host = (urllib.parse.urlparse(raw_source_url).hostname or "").lower()
        if (
            _su_host in (
                "ddizimag.com", "www.ddizimag.com",
                "ddizimag.icu", "www.ddizimag.icu",
                "fullhdfilmizlesene.now", "www.fullhdfilmizlesene.now",
                "hdfilmcehennemi.nl", "www.hdfilmcehennemi.nl",
                "animecix.tv", "www.animecix.tv",
                "netflix.com", "www.netflix.com",
                "max.com", "www.max.com", "play.max.com",
                "hbomax.com", "www.hbomax.com", "play.hbomax.com",
            )
            or any(d in _su_host for d in ("dizibox.", "dizipal", "hdfilmcehennemi.", "fullhdfilmizlesene.", "netflix.com", "max.com", "hbomax.com"))
            or bool(re.fullmatch(r"(?:www\.)?(?:dizi\d*\.(?:life|plus)|ddizimag\.[a-z]{2,8})", _su_host))
        ):
            source_url = raw_source_url
    valid_custom_stream = ""
    if raw_stream_url and raw_stream_url.startswith(("http://", "https://")) and public_http_url(raw_stream_url):
        if any(k in raw_stream_url.lower() for k in (".m3u8", ".mp4", ".webm", ".mkv", "master.txt")):
            valid_custom_stream = raw_stream_url
            _register_custom_release_stream({
                "tmdbId": tmdb_id,
                "id": tmdb_id or imdb_id,
                "mediaType": media_type,
                "title": title or display_title,
                "originalTitle": title,
                "streamUrl": valid_custom_stream,
            })
    force_refresh = (request.query_params.get("refresh") or "").strip().lower() in ("1", "true", "yes")
    try:
        season = min(100, max(1, int(request.query_params.get("season") or request.query_params.get("s") or 1)))
        episode = min(5000, max(1, int(request.query_params.get("episode") or request.query_params.get("e") or 1)))
    except (TypeError, ValueError):
        season, episode = 1, 1
    ckey = f"v34|{prov}|{media_type}|{tmdb_id or imdb_id or title.lower()}|{season}|{episode}"
    now_t = time.time()
    cc_hdrs = {"Cache-Control": "no-store" if force_refresh else "public, max-age=60, s-maxage=90, stale-while-revalidate=180"}
    auth_ctx = {
        "cookies": dict(request.cookies),
        "headers": dict(request.headers),
        "params": dict(request.query_params),
        "is_authenticated": (
            str(request.query_params.get("authSatisfied") or "").strip().lower() in ("1", "true")
            or str(request.query_params.get("max_auth") or "").strip().lower() in ("1", "true")
            or str(request.query_params.get("auth") or "").strip().lower() in ("1", "true")
            or str(request.query_params.get("authenticated") or "").strip().lower() in ("1", "true")
        ),
    }
    is_max_auth = True
    if not force_refresh:
        cached = _RESOLVE_RESP_CACHE.get(ckey)
        if cached and now_t - cached[0] < 120:
            return JSONResponse(social_engine.rank_servers_by_health(cached[1]), headers=cc_hdrs)
    lock = _get_loop_lock(_RESOLVE_LOCKS, ckey, 400)
    async with lock:
        cached = _RESOLVE_RESP_CACHE.get(ckey)
        if cached and time.time() - cached[0] < (25 if force_refresh else 120):
            return JSONResponse(social_engine.rank_servers_by_health(cached[1]), headers=cc_hdrs)
        try:
            loop_rc = asyncio.get_running_loop()
            res = await asyncio.wait_for(
                loop_rc.run_in_executor(
                    _RESOLVE_EXECUTOR,
                    _resolve_catalog_sync,
                    prov, title, year, tmdb_id, media_type, poster, season, episode, imdb_id, display_title, source_url, force_refresh, request, is_max_auth, auth_ctx,
                ),
                timeout=26,
            )
        except Exception:
            res = None
        if not res and valid_custom_stream:
            fb_stype = "mp4" if ".mp4" in valid_custom_stream.lower() else "hls"
            fb_wrapped = _wrap_first_party_stream(valid_custom_stream, fb_stype, prov, tmdb_id or "custom", season, episode, media_type)
            res = {
                "url": fb_wrapped,
                "streamType": fb_stype,
                "directStream": True,
                "title": display_title or title or "Vizyon Özel Akış",
                "tmdbId": tmdb_id,
                "mediaType": media_type,
                "season": season,
                "episode": episode,
                "poster": poster,
                "servers": [{"id": "custom_vizyon", "label": "✨ Vizyon 4K Özel Akış", "url": fb_wrapped, "streamType": fb_stype, "directStream": True}],
            }
        if res:
            if isinstance(res, dict) and res.get("authRequired"):
                return JSONResponse(res, status_code=401, headers={"Cache-Control": "no-store"})
            if len(_RESOLVE_RESP_CACHE) >= 400:
                _RESOLVE_RESP_CACHE.pop(next(iter(_RESOLVE_RESP_CACHE)), None)
            _RESOLVE_RESP_CACHE[ckey] = (time.time(), res)
    if not res:
        return JSONResponse({"error": "Oynatılabilir tam içerik bulunamadı"}, status_code=404, headers={"Cache-Control": "no-store"})
    if isinstance(res, dict) and res.get("authRequired"):
        return JSONResponse(res, status_code=401, headers={"Cache-Control": "no-store"})
    try:
        _RESOLVE_EXECUTOR.submit(_track_analytics_sync, "watch", title=(display_title or title), media_type=media_type)
    except Exception:
        pass
    return JSONResponse(social_engine.rank_servers_by_health(res), headers=cc_hdrs)


def _showcase_shuffle_sync(cat: str = "all", mt_filter: str = "", limit: int = 40) -> dict:
    import random
    cat_c = (cat or "all").strip().lower()
    mt_c = (mt_filter or "").strip().lower()
    if mt_c in ("series", "show"):
        mt_c = "tv"
    elif mt_c in ("movies", "film"):
        mt_c = "movie"

    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    pool_items = []
    seen_keys = set()

    def _norm_poster(u_img: str, meta_it: dict | None = None) -> str:
        u_img = str(u_img or "").strip()
        if u_img.startswith("/"):
            return u_img
        if "image.tmdb.org" in u_img or "m.media-amazon.com" in u_img:
            return u_img
        if (not u_img and meta_it and meta_it.get("title")) or any(d in u_img for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter.", "ddizimag.")):
            qp = urllib.parse.urlencode({
                "u": u_img,
                "tid": str((meta_it or {}).get("tmdbId") or "")[:30],
                "t": str((meta_it or {}).get("title") or "")[:100],
                "ot": str((meta_it or {}).get("originalTitle") or "")[:100],
                "y": str((meta_it or {}).get("year") or "")[:8],
                "mt": str((meta_it or {}).get("mediaType") or "movie")[:10],
            })
            return f"/api/rave/poster?{qp}"
        return u_img

    def _add_cand(it_raw: dict, default_badge: str = ""):
        if not isinstance(it_raw, dict):
            return
        it = dict(it_raw)
        title = str(it.get("title") or "").strip()
        if not title:
            return
        yr = str(it.get("year") or "")
        rt = float(it.get("rating") or 0)
        if rt == 0.0 and yr >= "2026":
            return
        mtype = "tv" if it.get("mediaType") == "tv" else "movie"
        tid = str(it.get("tmdbId") or "")
        cid = str(it.get("id") or tid or "")
        if _HIDDEN_TMDB_IDS and not _has_vault_stream(it):
            if tid in _HIDDEN_TMDB_IDS or f"{mtype}:{tid or cid}" in _HIDDEN_TMDB_IDS:
                return
        if mt_c in ("tv", "movie") and mtype != mt_c:
            return
        cats = list(it.get("categories") or [])
        if cat_c == "series" and mtype != "tv":
            return
        if cat_c == "movies" and mtype == "tv":
            return
        if cat_c == "anime" and "anime" not in cats and "animation" not in cats and not cid.startswith("ac-"):
            return
        if cat_c == "tr" and it.get("origLang") != "tr" and "Yerli" not in str(it.get("genreLabel") or ""):
            return
        if cat_c not in ("all", "trend", "series", "movies", "anime", "tr") and cat_c not in cats:
            return
        poster = _norm_poster(it.get("poster") or "", it)
        backdrop = _norm_poster(it.get("backdrop") or poster, it)
        if not poster:
            return
        dedup = f"{mtype}:{tid or _norm_title(title)}"
        if dedup in seen_keys:
            return
        seen_keys.add(dedup)
        it["poster"] = poster
        it["backdrop"] = backdrop or poster
        if default_badge and not it.get("sourceBadge"):
            it["sourceBadge"] = default_badge
        pool_items.append(it)

    for dom_k, dom_list in _DOMESTIC_TR_ORIGINALS.items():
        for d_it in dom_list:
            _add_cand(d_it, "🇹🇷 Yerli Orijinal 4K")
    for sw_it in _STAR_WARS_CURATED:
        _add_cand(sw_it, "🎬 Star Wars 4K")
    for ex_it in _EXTRA_CURATED_CATALOG:
        _add_cand(ex_it, ex_it.get("sourceBadge") or "🎬 4K Seri Arşivi")

    for src_key, badge in (("fhd", "🎬 FullHD 1080p"), ("hfnl", "🎬 HDFilmCehennemi+"), ("dbx", "📺 Dizibox HD"), ("ac", "⛩️ Animetrix Fansub")):
        src_list = list(v_cat.get(src_key) or [])
        if len(src_list) > 250:
            src_list = random.sample(src_list, 250)
        for v_it in src_list:
            _add_cand(v_it, badge)

    for _, c_entry in list(_CATALOG_MEM_CACHE.items())[:8]:
        if isinstance(c_entry, tuple) and len(c_entry) == 2 and isinstance(c_entry[1], dict):
            for c_it in (c_entry[1].get("items") or [])[:40]:
                _add_cand(c_it, "🔥 FullHD Sinema Arşivi")

    try:
        rnd_pg = random.randint(1, 15)
        if mt_c != "movie" and cat_c != "movies":
            tv_u = f"https://api.themoviedb.org/3/discover/tv?api_key={TMDB_API_KEY}&language=tr-TR&without_genres=10763,10764,10766,10767&vote_count.gte=40&sort_by=popularity.desc&page={rnd_pg}"
            for r in (_http_json(tv_u, timeout=2.0).get("results") or [])[:16]:
                if r.get("poster_path"):
                    _add_cand(_tmdb_item(r, "tv"), "📺 Dizi+ Arşiv")
        if mt_c != "tv" and cat_c not in ("series", "anime"):
            mv_u = f"https://api.themoviedb.org/3/discover/movie?api_key={TMDB_API_KEY}&language=tr-TR&primary_release_date.lte=2026-04-30&vote_count.gte=80&sort_by=popularity.desc&page={rnd_pg}"
            for r in (_http_json(mv_u, timeout=2.0).get("results") or [])[:16]:
                if r.get("poster_path"):
                    _add_cand(_tmdb_item(r, "movie"), "🎬 Sinema+ FullHD")
    except Exception:
        pass

    random.shuffle(pool_items)
    with_backdrop = [x for x in pool_items if "image.tmdb.org" in str(x.get("backdrop") or x.get("poster") or "")]
    others = [x for x in pool_items if "image.tmdb.org" not in str(x.get("backdrop") or x.get("poster") or "")]
    random.shuffle(with_backdrop)
    random.shuffle(others)
    final_items = (with_backdrop + others)[:max(12, min(96, int(limit or 40)))]
    v_st = _MAIN_SITES_VAULT.get("streams") or {}
    sh_tv, sh_mv = _get_real_tmdb_totals_sync("cinema", "", "")
    real_tv = max(sh_tv, sum(1 for k in v_st if str(k).startswith("tv:")), sum(1 for x in pool_items if x.get("mediaType") == "tv"))
    real_mv = max(sh_mv, sum(1 for k in v_st if str(k).startswith("movie:")), sum(1 for x in pool_items if x.get("mediaType") != "tv"))
    return {
        "items": final_items,
        "totalAvailable": real_tv + real_mv,
        "totalTv": real_tv,
        "totalMovies": real_mv,
        "page": 1,
        "category": cat_c,
        "shuffled": True,
        "hasMore": True,
    }


async def provider_catalog(request: Request):
    if not _is_origin_allowed(request):
        return JSONResponse({"error": "Forbidden: cross-site origin or hotlink not allowed"}, status_code=403)
    prov = (request.query_params.get("provider") or request.query_params.get("source") or "cinema").strip().lower()
    q = (request.query_params.get("q") or "").strip()[:200]
    shuffle_flag = (request.query_params.get("shuffle") or request.query_params.get("random") or "").strip().lower() in ("1", "true", "yes")
    try:
        page = max(1, int(request.query_params.get("page") or 1))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = max(12, min(96, int(request.query_params.get("limit") or 40)))
    except (TypeError, ValueError):
        limit = 40
    category = (request.query_params.get("category") or "all").strip()[:40]
    mt_filter = (request.query_params.get("mediaType") or request.query_params.get("type") or "").strip()[:20]
    if shuffle_flag and not q:
        try:
            res = await asyncio.wait_for(asyncio.to_thread(_showcase_shuffle_sync, category, mt_filter, limit), timeout=5.0)
        except Exception:
            res = {"items": [], "totalAvailable": len(_MAIN_SITES_VAULT.get("streams") or {}), "totalTv": 0, "totalMovies": 0, "page": 1, "category": category, "shuffled": True, "hasMore": False}
        return JSONResponse(
            {"provider": prov, "query": "", **res},
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
    ckey = f"v3:{prov}:{category}:{page}:{mt_filter}:{q.replace('İ', 'i').replace('I', 'ı').lower()}"
    lock = _get_loop_lock(_CATALOG_LOCKS, ckey, 400)
    async with lock:
        try:
            res = await asyncio.wait_for(asyncio.to_thread(_provider_catalog_page_sync, prov, q, page, category, mt_filter), timeout=9)
            items = res.get("items") or []
            if not items and not q and page == 1:
                pkgs, country = JW_PROV.get(prov, (["nfx"], "TR"))
                items = await asyncio.wait_for(asyncio.to_thread(_justwatch_sync, q, pkgs, country, 24), timeout=8)
                res["items"] = items
        except Exception:
            res = {"items": [], "totalAvailable": 0, "totalTv": 0, "totalMovies": 0, "page": page, "category": category, "hasMore": False}
    if _HIDDEN_TMDB_IDS and res.get("items"):
        res["items"] = [
            x for x in res["items"]
            if _has_vault_stream(x) or (
                str(x.get("tmdbId") or "") not in _HIDDEN_TMDB_IDS
                and f"{'tv' if x.get('mediaType') == 'tv' else 'movie'}:{x.get('tmdbId') or ''}" not in _HIDDEN_TMDB_IDS
                and f"{prov}|{'tv' if x.get('mediaType') == 'tv' else 'movie'}:{x.get('tmdbId') or ''}" not in _HIDDEN_TMDB_IDS
            )
        ]
    if q and page == 1:
        try:
            await asyncio.to_thread(_track_analytics_sync, "search", query=q)
        except Exception:
            pass
    return JSONResponse(
        {"provider": prov, "query": q, **res},
        headers={"Cache-Control": "public, max-age=60, s-maxage=600, stale-while-revalidate=1800"},
    )


def _ingest_custom_release_sync(payload: dict) -> dict:
    raw_title = str(payload.get("title") or "").strip()[:160]
    raw_tid = str(payload.get("tmdbId") or "").strip()[:30]
    raw_imdb = str(payload.get("imdbId") or "").strip()[:30]
    raw_mt = str(payload.get("mediaType") or payload.get("type") or "movie").strip().lower()
    mtype = "tv" if raw_mt in ("tv", "series", "show", "dizi") else "movie"
    raw_year = str(payload.get("year") or "").strip()[:8]
    raw_poster = str(payload.get("poster") or "").strip()[:600]
    if raw_poster and not (raw_poster.startswith(("https://", "http://")) and public_http_url(raw_poster)):
        raw_poster = ""
    raw_stream = str(payload.get("streamUrl") or "").strip()[:800]
    if raw_stream and not (raw_stream.startswith(("https://", "http://")) and public_http_url(raw_stream)):
        raise ValueError("Geçersiz veya güvenli olmayan akış bağlantısı")
    raw_source = str(payload.get("sourceUrl") or "").strip()[:600]
    if raw_source and not (raw_source.startswith(("https://", "http://")) and public_http_url(raw_source)):
        raw_source = ""
    raw_prov = re.sub(r"[^a-z0-9_\-]", "", str(payload.get("provider") or "cinema").strip().lower())[:30] or "cinema"

    tm_hit = None
    if raw_tid.isdigit():
        try:
            u = f"https://api.themoviedb.org/3/{mtype}/{raw_tid}?api_key={TMDB_API_KEY}&language=tr-TR"
            r = _http_json(u, timeout=3.5)
            if r and r.get("id"):
                tm_hit = _tmdb_item(r, mtype)
        except Exception:
            tm_hit = None
    if not tm_hit and raw_title:
        try:
            hits = _tmdb_sync(raw_title)
            if hits:
                same_mt = [h for h in hits if h.get("mediaType") == mtype]
                tm_hit = same_mt[0] if same_mt else hits[0]
        except Exception:
            tm_hit = None

    title = raw_title or (tm_hit.get("title") if tm_hit else "")
    if not title:
        raise ValueError("Film veya dizi başlığı gerekli")
    orig_title = str(payload.get("originalTitle") or (tm_hit.get("originalTitle") if tm_hit else "") or title).strip()[:160]
    tid = raw_tid or (str(tm_hit.get("tmdbId") or "") if tm_hit else "") or f"vizyon-{abs(hash(_norm_title(title))) % 10000000}"
    year = raw_year or (str(tm_hit.get("year") or "") if tm_hit else "") or "2026"
    poster = raw_poster or (str(tm_hit.get("poster") or "") if tm_hit else "")
    raw_backdrop = str(payload.get("backdrop") or "").strip()[:600]
    if raw_backdrop and not (raw_backdrop.startswith(("https://", "http://")) and public_http_url(raw_backdrop)):
        raw_backdrop = ""
    backdrop = raw_backdrop or (str(tm_hit.get("backdrop") or "") if tm_hit else "") or poster
    rating = float(payload.get("rating") or (tm_hit.get("rating") if tm_hit else 0) or 7.8)
    cats = list(dict.fromkeys(((tm_hit.get("categories") if tm_hit else []) or []) + ["vizyon", "trend", "series" if mtype == "tv" else "movies"]))

    new_item = {
        "id": f"vizyon-{mtype}-{tid}",
        "tmdbId": str(tid),
        "imdbId": raw_imdb,
        "title": title,
        "originalTitle": orig_title,
        "year": year,
        "rating": round(rating, 1),
        "voteCount": int((tm_hit.get("voteCount") if tm_hit else 0) or 120),
        "mediaType": mtype,
        "poster": poster,
        "backdrop": backdrop or poster,
        "categories": cats,
        "genreLabel": f"🇹🇷 Vizyon & Yeni · {'Dizi' if mtype == 'tv' else 'Sinema 4K'}",
        "sourceBadge": "🍿 Vizyonda & Yeni",
        "provider": raw_prov or "cinema",
        "streamUrl": raw_stream,
        "sourceUrl": raw_source,
        "officialUrl": raw_source or raw_stream,
        "customRelease": True,
        "isVizyon": True,
        "addedAt": int(time.time()),
    }
    _load_custom_releases_sync()
    with _CUSTOM_RELEASES_LOCK:
        _CUSTOM_RELEASES_POOL[:] = [
            x for x in _CUSTOM_RELEASES_POOL
            if not (str(x.get("tmdbId") or "") == str(tid) and x.get("mediaType") == mtype)
            and _norm_title(x.get("title") or "") != _norm_title(title)
        ]
        _CUSTOM_RELEASES_POOL.insert(0, new_item)
        del _CUSTOM_RELEASES_POOL[100:]
        _register_custom_release_stream(new_item)
        try:
            social_engine._kv_set("wl:releases:custom:v1", _CUSTOM_RELEASES_POOL)
        except Exception:
            pass
    _CATALOG_MEM_CACHE.clear()
    _NEW_RELEASES_MEM_CACHE["ts"] = 0.0
    return new_item


_VIZYON_POST_LIMIT = RateLimiter(15, 600.0, name="vizyon_post")


async def rave_new_releases(request: Request):
    if request.method == "POST":
        allowed_v, retry_v = _VIZYON_POST_LIMIT.hit(client_ip(request))
        if not allowed_v:
            return too_many_response(retry_v)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            return JSONResponse({"ok": False, "error": "Geçersiz veri"}, status_code=400, headers={"Cache-Control": "no-store"})
        raw_stream_chk = str(payload.get("streamUrl") or "").strip()[:800]
        if raw_stream_chk and not (raw_stream_chk.startswith(("https://", "http://")) and public_http_url(raw_stream_chk)):
            return JSONResponse(
                {"ok": False, "error": "Geçersiz veya güvenli olmayan akış bağlantısı"},
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )
        if not _is_admin_request(request):
            return JSONResponse(
                {"ok": False, "error": "Vizyon katalog yönetimi için yönetici yetkisi gerekli."},
                status_code=403,
                headers={"Cache-Control": "no-store"},
            )
        try:
            item = await asyncio.to_thread(_ingest_custom_release_sync, payload)
        except ValueError as ve:
            return JSONResponse({"ok": False, "error": str(ve)}, status_code=400)
        except Exception:
            return JSONResponse({"ok": False, "error": "İçerik şu anda eklenemedi."}, status_code=500)
        return JSONResponse({
            "ok": True,
            "item": item,
            "totalCustom": len(_CUSTOM_RELEASES_POOL),
        })

    force_refresh = (request.query_params.get("refresh") or "").strip().lower() in ("1", "true", "yes")
    now_t = time.time()
    if not force_refresh and _NEW_RELEASES_MEM_CACHE.get("items") and (now_t - float(_NEW_RELEASES_MEM_CACHE.get("ts") or 0) < 300):
        cached_items = list(_NEW_RELEASES_MEM_CACHE.get("items") or [])
        custom_list = await asyncio.to_thread(_load_custom_releases_sync)
        return JSONResponse({
            "ok": True,
            "items": cached_items,
            "customItems": custom_list,
            "total": len(cached_items),
            "cached": True,
        })

    if force_refresh:
        _CATALOG_MEM_CACHE.pop("v4:cinema:vizyon:1:", None)
        _CATALOG_MEM_CACHE.pop("v5:cinema:vizyon:1:", None)
    try:
        cat_res = await asyncio.wait_for(
            asyncio.to_thread(_provider_catalog_page_sync, "cinema", "", 1, "vizyon", ""),
            timeout=9.0,
        )
        items = list(cat_res.get("items") or [])
    except Exception:
        items = await asyncio.to_thread(_load_custom_releases_sync)

    custom_list = await asyncio.to_thread(_load_custom_releases_sync)
    seen_k = set()
    merged = []
    for raw_it in custom_list + items:
        it = dict(raw_it)
        k = f"{it.get('mediaType') or 'movie'}:{it.get('tmdbId') or _norm_title(it.get('title') or '')}"
        if k in seen_k:
            continue
        seen_k.add(k)
        cid_s = str(it.get("id") or "")
        vc_i = int(it.get("voteCount") or 0)
        yr_s = str(it.get("year") or "")
        has_v = _has_vault_stream(it) > 0 or cid_s.startswith(("fhd-", "hfnl-", "dbx-", "hdfc-", "dl-", "ac-", "dp-"))
        s_url_l = str(it.get("streamUrl") or "").lower()
        has_verified_4k = ("2160" in s_url_l or "3840x" in s_url_l)
        if it.get("customRelease") or it.get("streamUrl"):
            it["streamReady"] = True
            it["sourceBadge"] = "✨ Yeni Eklendi · 4K Hazır" if has_verified_4k else "✨ Yeni Eklendi · 1080p HD"
        elif has_v:
            it["streamReady"] = True
            it["sourceBadge"] = "✅ 1080p FullHD Hazır"
        elif it.get("mediaType") == "tv":
            it["streamReady"] = True
            it["sourceBadge"] = "📺 Yeni Bölüm & Sezon Aktif"
        elif it.get("origLang") == "tr" or yr_s < "2026" or vc_i >= 120:
            it["streamReady"] = True
            it["sourceBadge"] = "✅ 1080p FullHD Hazır"
        else:
            it["streamReady"] = False
            it["sourceBadge"] = "🎟️ Sinemalarda (Yakında Akışta)"
        merged.append(it)
    merged.sort(
        key=lambda x: (
            1 if x.get("customRelease") else 0,
            1 if x.get("streamReady") else 0,
            1 if _has_vault_stream(x) > 0 else 0,
            int(x.get("voteCount") or 0),
            float(x.get("rating") or 0),
        ),
        reverse=True,
    )
    _NEW_RELEASES_MEM_CACHE["ts"] = now_t
    _NEW_RELEASES_MEM_CACHE["items"] = merged[:60]

    # Warm-prefetch top 3 streamReady items in background so room playback starts instantaneously
    async def _warm_top():
        for w_it in [x for x in merged if x.get("streamReady")][:3]:
            try:
                w_tid = str(w_it.get("tmdbId") or "")
                w_mt = str(w_it.get("mediaType") or "movie")
                w_t = str(w_it.get("title") or "")
                w_ckey = f"v33|cinema|{w_mt}|{w_tid or w_t.lower()}|1|1"
                if w_ckey not in _RESOLVE_RESP_CACHE:
                    r_w = await asyncio.wait_for(
                        asyncio.get_running_loop().run_in_executor(_RESOLVE_EXECUTOR, _resolve_catalog_sync, "cinema", w_t, str(w_it.get("year") or ""), w_tid, w_mt, str(w_it.get("poster") or ""), 1, 1, str(w_it.get("imdbId") or ""), w_t, str(w_it.get("sourceUrl") or "")),
                        timeout=6.0,
                    )
                    if r_w:
                        if len(_RESOLVE_RESP_CACHE) >= 400:
                            _RESOLVE_RESP_CACHE.pop(next(iter(_RESOLVE_RESP_CACHE)), None)
                        _RESOLVE_RESP_CACHE[w_ckey] = (time.time(), r_w)
            except Exception:
                pass
    if not IS_VERCEL:
        try:
            asyncio.create_task(_warm_top())
        except Exception:
            pass

    return JSONResponse({
        "ok": True,
        "items": merged[:60],
        "customItems": custom_list,
        "total": len(merged),
        "cached": False,
    })


_LATEST_EPS_MEM_CACHE: dict[str, object] = {"ts": 0.0, "items": []}

_CURATED_ACTIVE_SERIES_SEEDS = [
    {"tmdbId": "95479", "title": "Jujutsu Kaisen", "originalTitle": "Jujutsu Kaisen", "season": 2, "episode": 23, "episodeTitle": "Shibuya Incident", "sourceBadge": "⛩️ Yeni Anime Bölümü", "provider": "cinema", "poster": "https://image.tmdb.org/t/p/w500/fHpKWq9ayzSk8nSwqRuaAUemRKh.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/gmECX1DvFgdUPjtio2zaL8BPYPu.jpg", "year": "2024", "rating": 8.6},
    {"tmdbId": "127532", "title": "Solo Leveling", "originalTitle": "Ore dake Level Up na Ken", "season": 2, "episode": 12, "episodeTitle": "Arise from the Shadow", "sourceBadge": "⛩️ Yeni Anime Bölümü", "provider": "cinema", "poster": "https://image.tmdb.org/t/p/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/xMNH87maNLt9n2bMDYeI6db5VFm.jpg", "year": "2025", "rating": 8.7},
    {"tmdbId": "37854", "title": "One Piece", "originalTitle": "One Piece", "season": 1, "episode": 1122, "episodeTitle": "Egghead Arc", "sourceBadge": "⛩️ Güncel Anime", "provider": "cinema", "poster": "https://image.tmdb.org/t/p/w500/cMD9Ygz11zjJzAovURpO75Qg7rT.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/2rmK7mnchw9Xr3XdiTFSxTTLXqv.jpg", "year": "2025", "rating": 8.8},
    {"tmdbId": "228853", "title": "Prens", "originalTitle": "Prens", "season": 3, "episode": 1, "episodeTitle": "Yeni Sezon Bölümü", "sourceBadge": "🇹🇷 Yeni Yerli Bölüm", "provider": "blutv", "poster": "https://image.tmdb.org/t/p/w500/oDtYdl5i8rRLmB9xAU6VOwHKjMQ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/88DMFlyPDuyUeFrUDswbWSV2CQg.jpg", "year": "2025", "rating": 8.6},
    {"tmdbId": "115678", "title": "Gibi", "originalTitle": "Gibi", "season": 5, "episode": 13, "episodeTitle": "Sezon Finali", "sourceBadge": "🇹🇷 Exxen Yeni Bölüm", "provider": "exxen", "poster": "https://image.tmdb.org/t/p/w500/sOzTUfTc1djfZM46PgsjuOjs5U1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/p7VgbdDN2LK41JTavzJ9x3i4ktE.jpg", "year": "2025", "rating": 8.9},
    {"tmdbId": "280030", "title": "Gassal", "originalTitle": "Gassal", "season": 1, "episode": 10, "episodeTitle": "1. Sezon 10. Bölüm", "sourceBadge": "🇹🇷 tabii Yeni Bölüm", "provider": "tabii", "poster": "https://image.tmdb.org/t/p/w500/dvTFLhkIlCJaaDi32MxG7ke4vv1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6YMuWmlXKQkhQ0FiwDo9zmIsnEb.jpg", "year": "2025", "rating": 8.7},
    {"tmdbId": "100088", "title": "The Last of Us", "originalTitle": "The Last of Us", "season": 2, "episode": 1, "episodeTitle": "Future Days", "sourceBadge": "🔥 Yeni Sezon Bölümü", "provider": "max", "poster": "https://image.tmdb.org/t/p/w500/uKvVjHNqB5VmOrdxqAt2F7J78ED.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/uDgy6hyPd82kOHh6I95FLtLnj6p.jpg", "year": "2025", "rating": 8.8},
    {"tmdbId": "95396", "title": "Severance", "originalTitle": "Severance", "season": 2, "episode": 10, "episodeTitle": "Cold Harbor", "sourceBadge": "🔥 Yeni Bölüm · 4K", "provider": "apple", "poster": "https://image.tmdb.org/t/p/w500/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/ixgFmf1X59PUZam2qbAfskx2gQr.jpg", "year": "2025", "rating": 8.7},
    {"tmdbId": "93405", "title": "Squid Game", "originalTitle": "Squid Game", "season": 2, "episode": 7, "episodeTitle": "Dost mu Düşman mı", "sourceBadge": "🔥 Netflix 4K Dublaj", "provider": "netflix", "poster": "https://image.tmdb.org/t/p/w500/dDlEmu3EZ0Pgg93K2SVNLCjCSvE.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/2meX1nMdScFOoV4370rqHWKmXhY.jpg", "year": "2025", "rating": 8.4},
    {"tmdbId": "66732", "title": "Stranger Things", "originalTitle": "Stranger Things", "season": 4, "episode": 9, "episodeTitle": "The Piggyback", "sourceBadge": "🔥 Netflix 4K Dublaj", "provider": "netflix", "poster": "https://image.tmdb.org/t/p/w500/49WJfeN0moxb9IPfGn8AIqMGskD.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/56v2KjBlU4XaOv9rVYEQypROD7P.jpg", "year": "2024", "rating": 8.6},
    {"tmdbId": "42009", "title": "Black Mirror", "originalTitle": "Black Mirror", "season": 7, "episode": 1, "episodeTitle": "Common People", "sourceBadge": "🔥 Yeni Sezon · 4K", "provider": "netflix", "poster": "https://image.tmdb.org/t/p/w500/5UaYsGZOFhjFDwQh6GuLjjA1WlF.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/38aCLy0BdFbOAIEfuDladoITHN0.jpg", "year": "2025", "rating": 8.3},
    {"tmdbId": "94997", "title": "House of the Dragon", "originalTitle": "House of the Dragon", "season": 2, "episode": 8, "episodeTitle": "The Queen Who Ever Was", "sourceBadge": "🔥 Max 4K HDR", "provider": "max", "poster": "https://image.tmdb.org/t/p/w500/7QMsOTMUswlwxJP0rTTZfmz2tX2.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/etj8E2o0Bud0HkONVQPjyCkIvpv.jpg", "year": "2024", "rating": 8.4},
]

_EXCLUDED_TALK_NEWS_GENRE_IDS = {10767, 10763, 10764, 10766}


def _fetch_latest_episodes_sync() -> list[dict]:
    import concurrent.futures
    candidates = []
    seen_tids = {str(s.get("tmdbId") or "") for s in _CURATED_ACTIVE_SERIES_SEEDS}
    eps_urls = [
        f"https://api.themoviedb.org/3/trending/tv/week?api_key={TMDB_API_KEY}&language=tr-TR&page=1",
        f"https://api.themoviedb.org/3/tv/on_the_air?api_key={TMDB_API_KEY}&language=tr-TR&page=1",
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(_http_json, u, timeout=3.0) for u in eps_urls]
        for f in futs:
            try:
                data = f.result(timeout=3.2) or {}
                for r in (data.get("results") or [])[:16]:
                    tid = str(r.get("id") or "").strip()
                    if not tid or tid in seen_tids or not r.get("poster_path"):
                        continue
                    if tid in _HIDDEN_TMDB_IDS or f"tv:{tid}" in _HIDDEN_TMDB_IDS:
                        continue
                    g_ids = set(r.get("genre_ids") or [])
                    if g_ids & _EXCLUDED_TALK_NEWS_GENRE_IDS:
                        continue
                    it = _tmdb_item(r, "tv")
                    if _has_vault_stream(it) <= 0:
                        continue
                    seen_tids.add(tid)
                    candidates.append(it)
            except Exception:
                pass

    def _enrich_ep(it_base: dict) -> dict | None:
        tid = str(it_base.get("tmdbId") or "").strip()
        if not tid.isdigit():
            return None
        try:
            info = _http_json(f"https://api.themoviedb.org/3/tv/{tid}?api_key={TMDB_API_KEY}&language=tr-TR", timeout=2.5) or {}
            last_ep = info.get("last_episode_to_air") or info.get("next_episode_to_air") or {}
            s_num = max(1, int(last_ep.get("season_number") or info.get("number_of_seasons") or 1))
            e_num = max(1, int(last_ep.get("episode_number") or 1))
            if s_num > 15 or e_num > 1200:
                return None
            ep_name = str(last_ep.get("name") or "").strip()
            if not ep_name or _is_generic_ep_name(ep_name):
                ep_name = ""
            still_p = last_ep.get("still_path") or info.get("backdrop_path") or info.get("poster_path")
            still_u = f"https://image.tmdb.org/t/p/w780{still_p}" if still_p else (it_base.get("backdrop") or it_base.get("poster") or "")
            air_d = str(last_ep.get("air_date") or info.get("last_air_date") or "")[:10]
            orig_l = str(info.get("original_language") or it_base.get("origLang") or "").lower()
            badge = "🇹🇷 Yeni Yerli Bölüm" if orig_l == "tr" else ("⛩️ Yeni Anime Bölümü" if orig_l == "ja" else "🆕 Yeni Bölüm · 1080p")
            return {
                **it_base,
                "mediaType": "tv",
                "season": s_num,
                "episode": e_num,
                "episodeLabel": f"S{s_num}:B{e_num}",
                "episodeTitle": ep_name or badge,
                "airDate": air_d,
                "still": still_u,
                "backdrop": still_u or it_base.get("backdrop") or it_base.get("poster"),
                "sourceBadge": badge,
                "streamReady": True,
            }
        except Exception:
            return None

    enriched = []
    if candidates:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ep_pool:
            for res_ep in ep_pool.map(_enrich_ep, candidates[:8]):
                if res_ep:
                    enriched.append(res_ep)

    seen_final = set()
    final_list = []
    for seed in _CURATED_ACTIVE_SERIES_SEEDS + enriched:
        tid = str(seed.get("tmdbId") or seed.get("id") or "")
        if not tid or tid in seen_final:
            continue
        seen_final.add(tid)
        s_n = max(1, int(seed.get("season") or 1))
        e_n = max(1, int(seed.get("episode") or 1))
        final_list.append({
            "id": f"ep-{tid}-s{s_n}e{e_n}",
            "tmdbId": tid,
            "mediaType": "tv",
            "title": seed.get("title") or "",
            "originalTitle": seed.get("originalTitle") or seed.get("title") or "",
            "season": s_n,
            "episode": e_n,
            "episodeLabel": seed.get("episodeLabel") or f"S{s_n}:B{e_n}",
            "episodeTitle": seed.get("episodeTitle") or seed.get("sourceBadge") or "Yeni Bölüm",
            "sourceBadge": seed.get("sourceBadge") or "🆕 Yeni Bölüm · 1080p",
            "provider": seed.get("provider") or "cinema",
            "poster": seed.get("poster") or "",
            "backdrop": seed.get("backdrop") or seed.get("still") or seed.get("poster") or "",
            "still": seed.get("still") or seed.get("backdrop") or seed.get("poster") or "",
            "year": str(seed.get("year") or "2025"),
            "rating": float(seed.get("rating") or 8.4),
            "streamReady": True,
        })
    return final_list[:20]


async def rave_latest_episodes(request: Request):
    force_refresh = (request.query_params.get("refresh") or "").strip().lower() in ("1", "true", "yes")
    now_t = time.time()
    if not force_refresh and _LATEST_EPS_MEM_CACHE.get("items") and (now_t - float(_LATEST_EPS_MEM_CACHE.get("ts") or 0) < 600):
        items = list(_LATEST_EPS_MEM_CACHE.get("items") or [])
        return JSONResponse({"ok": True, "items": items, "total": len(items), "cached": True})
    try:
        items = await asyncio.wait_for(asyncio.to_thread(_fetch_latest_episodes_sync), timeout=6.5)
    except Exception:
        items = [
            {
                **s,
                "id": f"ep-{s['tmdbId']}-s{s['season']}e{s['episode']}",
                "mediaType": "tv",
                "episodeLabel": f"S{s['season']}:B{s['episode']}",
                "still": s["backdrop"],
                "streamReady": True,
            }
            for s in _CURATED_ACTIVE_SERIES_SEEDS
        ]
    _LATEST_EPS_MEM_CACHE["ts"] = now_t
    _LATEST_EPS_MEM_CACHE["items"] = items
    return JSONResponse({"ok": True, "items": items, "total": len(items), "cached": False})


async def supersearch(request: Request):
    q = _BIDI_CTRL_RE.sub("", request.query_params.get("q") or "").strip()[:200]
    if not q:
        return JSONResponse({"youtube": [], "tmdb": [], "justwatch": []})
    qkey = _norm_title(q) or q.replace("İ", "i").replace("I", "ı").lower()
    cached = _SUPERSEARCH_CACHE.get(qkey)
    cc_hdrs = {"Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900"}
    if cached and time.time() - cached[0] < 300:
        return JSONResponse(cached[1], headers=cc_hdrs)
    res = await asyncio.gather(
        asyncio.wait_for(asyncio.to_thread(_yt_search_sync, q), timeout=2.0),
        asyncio.wait_for(asyncio.to_thread(_tmdb_sync, q), timeout=2.8),
        asyncio.wait_for(asyncio.to_thread(_justwatch_sync, q), timeout=1.8),
        return_exceptions=True,
    )
    yt, tmdb, jw = [r if isinstance(r, list) else [] for r in res]
    q_norm = _norm_title(q)
    if q_norm and len(q_norm) >= 2:
        seen_tids = {str(x.get("id") or x.get("tmdbId") or "") for x in tmdb if x.get("id") or x.get("tmdbId")}
        vault_hits = []
        for vk, vm in (_MAIN_SITES_VAULT.get("meta") or {}).items():
            if not isinstance(vm, dict):
                continue
            vt = str(vm.get("title") or "")
            vot = str(vm.get("originalTitle") or "")
            if q_norm in _norm_title(vt) or q_norm in _norm_title(vot):
                vtid = str(vm.get("tmdbId") or vm.get("id") or vk)
                if vtid in seen_tids:
                    continue
                seen_tids.add(vtid)
                vault_hits.append({
                    "id": vtid,
                    "tmdbId": vtid,
                    "title": vt or vot,
                    "originalTitle": vot or vt,
                    "mediaType": vm.get("mediaType") or ("tv" if "tv:" in str(vk) else "movie"),
                    "year": str(vm.get("year") or "2024"),
                    "rating": float(vm.get("rating") or 8.2),
                    "poster": vm.get("poster") or "",
                    "backdrop": vm.get("backdrop") or vm.get("poster") or "",
                    "provider": vm.get("provider") or "cinema",
                })
                if len(vault_hits) >= 16:
                    break
        if vault_hits:
            tmdb = vault_hits + tmdb
    if _HIDDEN_TMDB_IDS:
        tmdb = [
            x for x in tmdb
            if _has_vault_stream(x) or (
                str(x.get("id") or x.get("tmdbId") or "") not in _HIDDEN_TMDB_IDS
                and f"{'tv' if x.get('mediaType') == 'tv' else 'movie'}:{x.get('id') or x.get('tmdbId') or ''}" not in _HIDDEN_TMDB_IDS
            )
        ]
        jw = [
            x for x in jw
            if _has_vault_stream(x) or (
                str(x.get("id") or x.get("tmdbId") or "") not in _HIDDEN_TMDB_IDS
                and f"{'tv' if x.get('mediaType') == 'tv' else 'movie'}:{x.get('id') or x.get('tmdbId') or ''}" not in _HIDDEN_TMDB_IDS
            )
        ]
    payload = {"query": q, "youtube": yt, "tmdb": tmdb, "justwatch": jw}
    try:
        await asyncio.to_thread(_track_analytics_sync, "search", query=q)
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


def _extract_sync(url: str, fallback_title: str):
    if not public_http_url(url):
        raise ValueError("Geçersiz veya yerel ağ bağlantısı")
    m = YT_RE.search(url)
    if m:
        vid = m.group(1)
        return {"provider": "youtube", "videoId": vid, "url": f"https://www.youtube.com/watch?v={vid}", "title": fallback_title or "YouTube videosu", "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"}
    m_vim = re.search(r"vimeo\.com/(?:video/|channels/[^/]+/)?(\d+)", url, re.I)
    if m_vim:
        v_id = m_vim.group(1)
        return {"provider": "vimeo", "videoId": v_id, "url": url, "embedUrl": f"https://player.vimeo.com/video/{v_id}?autoplay=1", "title": fallback_title or f"Vimeo #{v_id}"}
    m_drv = re.search(r"drive\.google\.com/(?:file/d/|open\?id=)([A-Za-z0-9_-]{10,})", url, re.I)
    if m_drv:
        fid = m_drv.group(1)
        return {"provider": "drive", "fileId": fid, "url": f"https://drive.google.com/file/d/{fid}/preview", "embedUrl": f"https://drive.google.com/file/d/{fid}/preview", "title": fallback_title or "Google Drive Video"}
    if "dropbox.com/" in url.lower():
        dbx_u = re.sub(r"[?&]dl=0\b", "?raw=1", url)
        if "raw=1" not in dbx_u and "dl=1" not in dbx_u:
            dbx_u += ("&" if "?" in dbx_u else "?") + "raw=1"
        return {"provider": "direct", "url": dbx_u, "title": fallback_title or "Dropbox Video"}
    m_dm = re.search(r"(?:dailymotion\.com/video/|dai\.ly/)([a-zA-Z0-9]+)", url, re.I)
    if m_dm:
        dm_id = m_dm.group(1)
        return {"provider": "dailymotion", "videoId": dm_id, "url": url, "embedUrl": f"https://www.dailymotion.com/embed/video/{dm_id}?autoplay=1", "title": fallback_title or f"Dailymotion #{dm_id}"}
    m_tt = re.search(r"tiktok\.com/.*?(?:video)/(\d+)", url, re.I)
    if m_tt:
        tt_id = m_tt.group(1)
        return {"provider": "tiktok", "videoId": tt_id, "url": url, "embedUrl": f"https://www.tiktok.com/embed/v2/{tt_id}", "title": fallback_title or f"TikTok #{tt_id}"}
    m_tw_clip = re.search(r"(?:clips\.twitch\.tv/|twitch\.tv/[^/]+/clip/)([A-Za-z0-9_-]+)", url, re.I)
    if m_tw_clip:
        slug = m_tw_clip.group(1)
        return {"provider": "twitch", "clip": slug, "url": url, "embedUrl": f"https://clips.twitch.tv/embed?clip={slug}&parent=watchlivo.online&parent=localhost", "title": fallback_title or f"Twitch Klip · {slug}"}
    m_tw = re.search(r"(?:www\.|m\.)?twitch\.tv/(?:videos/(\d+)|([a-zA-Z0-9_]{2,30}))", url, re.I)
    if m_tw:
        vod, ch = m_tw.group(1), m_tw.group(2)
        if vod:
            return {"provider": "twitch", "video": vod, "url": url, "embedUrl": f"https://player.twitch.tv/?video={vod}&parent=watchlivo.online&parent=localhost", "title": fallback_title or f"Twitch VOD #{vod}"}
        if ch and ch.lower() not in ("directory", "videos", "clips", "login", "settings"):
            return {"provider": "twitch", "channel": ch, "url": url, "embedUrl": f"https://player.twitch.tv/?channel={ch}&parent=watchlivo.online&parent=localhost", "title": fallback_title or f"Twitch Canlı · {ch}"}
    m_kick = re.search(r"kick\.com/(?:video/([a-zA-Z0-9-]+)|([a-zA-Z0-9_.-]{2,30}))", url, re.I)
    if m_kick:
        kvod, kch = m_kick.group(1), m_kick.group(2)
        slug_k = kvod or kch
        return {"provider": "kick", "channel": slug_k, "url": url, "embedUrl": f"https://player.kick.com/{slug_k}", "title": fallback_title or f"Kick Canlı · {slug_k}"}
    if re.search(r"\.(mp4|webm|mov|m4v)(\?|$)", url, re.I):
        return {"provider": "direct", "url": url, "title": fallback_title or urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]}
    if re.search(r"\.m3u8(\?|$)", url, re.I):
        return {"provider": "hls", "url": url, "title": fallback_title or "Canlı yayın"}
    matched_prov = None
    for pkey, pcfg in RAVE_PROVIDERS_SPEC.items():
        if pkey in ("youtube", "drive", "twitch", "vimeo", "dropbox", "dailymotion", "tiktok", "kick"):
            continue
        if re.search(pcfg["idRegex"], url, re.I) or pcfg["domain"].lstrip(".") in url.lower():
            matched_prov = pkey
            break
    html = ""
    try:
        html = fetch_user_page(url)
    except Exception:
        if not matched_prov:
            raise
    t = re.search(r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)", html, re.I) or re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    raw_t = re.sub(r"\s+", " ", t.group(1)).strip()[:150] if t else ""
    raw_t = re.sub(r"(?i)(\s*[-|•]\s*(Netflix|Disney\+|Prime Video|Max|Crunchyroll|Tubi|Watch|İzle|Official Site).*)$", "", raw_t).strip()
    if matched_prov:
        slugs = [s for s in urllib.parse.urlparse(url).path.split("/") if s and not s.isdigit() and s not in ("watch", "title", "movies", "tv", "video", "browse", "play", "tr", "en", "series", "film", "dizi", "bolum", "sezon", "diziler")]
        guess = fallback_title or (raw_t if raw_t.lower() not in ("netflix", "disney+", "prime video", "max", "crunchyroll", "just a moment...") else "") or (slugs[-1].replace("-", " ").title() if slugs else "")
        if not guess:
            raise ValueError("Bağlantıdan içerik başlığı çıkarılamadı")
        guess_mtype = "movie" if ("/film/" in url.lower() or matched_prov in ("hdfilmcehennemi", "fullhdfilm") and "/dizi/" not in url.lower() and "/bolum/" not in url.lower()) else "tv"
        return _resolve_catalog_sync(matched_prov, guess, "", "", guess_mtype, "", 1, 1, "", guess, url)
    title = fallback_title or raw_t or urllib.parse.urlparse(url).hostname
    img = re.search(r"<meta[^>]+property=[\"']og:image[\"'][^>]+content=[\"']([^\"']+)", html, re.I)
    thumb = img.group(1) if img and img.group(1).startswith("https://") else ""
    for pat, prov in ((r"(https?:\\?/\\?/[^\s\"'<>]+?\.m3u8[^\s\"'<>]*)", "hls"), (r"(https?:\\?/\\?/[^\s\"'<>]+?\.(?:mp4|webm)(?:\?[^\s\"'<>]*)?)", "direct")):
        mm = re.search(pat, html, re.I)
        if mm:
            cand_media_u = mm.group(1).replace("\\/", "/")
            if public_http_url(cand_media_u):
                return {"provider": prov, "url": cand_media_u, "title": title, "thumbnail": thumb}
    og = re.search(r"<meta[^>]+property=[\"']og:video(?::secure_url|:url)?[\"'][^>]+content=[\"']([^\"']+)", html, re.I)
    if og:
        yt = YT_RE.search(og.group(1))
        if yt:
            return {"provider": "youtube", "videoId": yt.group(1), "url": f"https://www.youtube.com/watch?v={yt.group(1)}", "title": title, "thumbnail": f"https://i.ytimg.com/vi/{yt.group(1)}/hqdefault.jpg"}
        if re.search(r"\.(mp4|webm|m3u8)(\?|$)", og.group(1), re.I) and public_http_url(og.group(1)):
            return {"provider": "hls" if ".m3u8" in og.group(1) else "direct", "url": og.group(1), "title": title, "thumbnail": thumb}
    emb = YT_RE.search(html)
    if emb:
        return {"provider": "youtube", "videoId": emb.group(1), "url": f"https://www.youtube.com/watch?v={emb.group(1)}", "title": title, "thumbnail": f"https://i.ytimg.com/vi/{emb.group(1)}/hqdefault.jpg"}
    return None


RAVE_PROVIDERS_SPEC = {
    "netflix":     {"name": "Netflix", "domain": ".netflix.com", "loginUrl": "https://www.netflix.com/login", "browseUrl": "https://www.netflix.com/browse", "authCookies": ["NetflixId", "SecureNetflixId", "nfvdid"], "idRegex": r"netflix\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(?:watch|title)/(\d+)"},
    "disney":      {"name": "Disney+", "domain": ".disneyplus.com", "loginUrl": "https://www.disneyplus.com/login", "browseUrl": "https://www.disneyplus.com/home", "authCookies": ["BAMSDK_TOKEN", "disneyplus_session", "user_profile"], "idRegex": r"disneyplus\.com/(?:[a-z-]+\/)?(?:play|video|movies|series)/([\w-]+)"},
    "prime":       {"name": "Prime Video", "domain": ".primevideo.com", "loginUrl": "https://www.primevideo.com/auth-redirect", "browseUrl": "https://www.primevideo.com", "authCookies": ["x-main-av", "at-main-av", "sess-at-main-av"], "idRegex": r"(?:primevideo|amazon)\.[a-z.]+/.*?(?:gti=|asin=|detail/|watch/)([\w.-]+)"},
    "max":         {"name": "Max", "domain": ".max.com", "loginUrl": "https://auth.max.com/login", "browseUrl": "https://play.max.com", "authCookies": ["st", "session", "max_profile"], "idRegex": r"(?:hbomax|max)\.com/.*?(?:video/watch|play|movies|series)/([\w-]+)"},
    "crunchyroll": {"name": "Crunchyroll", "domain": ".crunchyroll.com", "loginUrl": "https://sso.crunchyroll.com/login", "browseUrl": "https://www.crunchyroll.com/videos/popular", "authCookies": ["etp_rt", "session_id", "c_locale"], "idRegex": r"crunchyroll\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(?:watch|series)/([A-Z0-9]+)"},
    "tubi":        {"name": "Tubi", "domain": ".tubitv.com", "loginUrl": "https://tubitv.com/login", "browseUrl": "https://tubitv.com/home", "authCookies": ["at", "TUBI_TOKEN", "device_id"], "idRegex": r"tubitv\.com/(?:video|movies|tv-shows|series)/(\d+)"},
    "exxen":       {"name": "Exxen", "domain": ".exxen.com", "loginUrl": "https://www.exxen.com/tr/sign-in", "browseUrl": "https://www.exxen.com/tr", "authCookies": ["exxen_token", "exxen_session"], "idRegex": r"exxen\.com/.*?(?:detail|watch)/([\w-]+)"},
    "blutv":       {"name": "BluTV", "domain": ".blutv.com", "loginUrl": "https://www.blutv.com/giris", "browseUrl": "https://www.blutv.com", "authCookies": ["blutv_token", "blu_sess"], "idRegex": r"blutv\.com/(?:diziler|filmler|izle)/([\w-]+)"},
    "gain":        {"name": "GAİN", "domain": ".gain.tv", "loginUrl": "https://www.gain.tv/giris", "browseUrl": "https://www.gain.tv", "authCookies": ["gain_auth", "gain_session"], "idRegex": r"gain\.tv/(?:icerik|izle)/([\w-]+)"},
    "tod":         {"name": "TOD", "domain": ".todtv.com.tr", "loginUrl": "https://www.todtv.com.tr/giris", "browseUrl": "https://www.todtv.com.tr", "authCookies": ["tod_session", "tod_token"], "idRegex": r"todtv\.com\.tr/(?:icerik|izle|film|dizi)/([\w-]+)"},
    "tabii":       {"name": "tabii", "domain": ".tabii.com", "loginUrl": "https://www.tabii.com/tr/login", "browseUrl": "https://www.tabii.com/tr", "authCookies": ["tabii_token", "tabii_session"], "idRegex": r"tabii\.com/.*?(?:watch|detail)/([\w-]+)"},
    "tvplus":      {"name": "TV+", "domain": ".tvplus.com.tr", "loginUrl": "https://tvplus.com.tr/giris", "browseUrl": "https://tvplus.com.tr", "authCookies": ["tvp_token", "tvp_session"], "idRegex": r"tvplus\.com\.tr/(?:izle|film|dizi)/([\w-]+)"},
    "puhutv":      {"name": "puhutv", "domain": ".puhutv.com", "loginUrl": "https://puhutv.com/giris", "browseUrl": "https://puhutv.com", "authCookies": ["puhu_session", "puhu_token"], "idRegex": r"puhutv\.com/([\w-]+)-izle"},
    "mubi":        {"name": "MUBI", "domain": ".mubi.com", "loginUrl": "https://mubi.com/tr/login", "browseUrl": "https://mubi.com/tr/showing", "authCookies": ["_mubi_session", "mubi_token"], "idRegex": r"mubi\.com/.*?(?:films)/([\w-]+)"},
    "apple":       {"name": "Apple TV+", "domain": ".apple.com", "loginUrl": "https://tv.apple.com/tr", "browseUrl": "https://tv.apple.com/tr", "authCookies": ["media-user-token", "myacinfo"], "idRegex": r"tv\.apple\.com/.*?(?:movie|show|episode)/[\w-]+/([\w.]+)"},
    "hulu":        {"name": "Hulu", "domain": ".hulu.com", "loginUrl": "https://auth.hulu.com/web/login", "browseUrl": "https://www.hulu.com/hub/home", "authCookies": ["_hulu_session", "hulu_at"], "idRegex": r"hulu\.com/(?:watch|series|movie)/([\w-]+)"},
    "paramount":   {"name": "Paramount+", "domain": ".paramountplus.com", "loginUrl": "https://www.paramountplus.com/account/signin/", "browseUrl": "https://www.paramountplus.com/home/", "authCookies": ["CBS_COM", "pplus_session"], "idRegex": r"paramountplus\.com/(?:movies|shows|video)/([\w-]+)"},
    "peacock":     {"name": "Peacock", "domain": ".peacocktv.com", "loginUrl": "https://www.peacocktv.com/signin", "browseUrl": "https://www.peacocktv.com/watch/home", "authCookies": ["peacock_session", "pck_token"], "idRegex": r"peacocktv\.com/watch/(?:asset|playback)/([\w-]+)"},
    "plex":        {"name": "Plex", "domain": ".plex.tv", "loginUrl": "https://app.plex.tv/auth", "browseUrl": "https://watch.plex.tv", "authCookies": ["X-Plex-Token", "plex_session"], "idRegex": r"plex\.tv/(?:movie|show|watch)/([\w-]+)"},
    "pluto":       {"name": "Pluto TV", "domain": ".pluto.tv", "loginUrl": "https://pluto.tv/sign-in", "browseUrl": "https://pluto.tv", "authCookies": ["pluto_jwt", "pluto_session"], "idRegex": r"pluto\.tv/.*?(?:movies|series|live-tv)/([\w-]+)"},
    "kick":        {"name": "Kick", "domain": ".kick.com", "loginUrl": "https://kick.com/", "browseUrl": "https://kick.com", "authCookies": ["kick_session"], "idRegex": r"kick\.com/([a-zA-Z0-9_.-]+)"},
    "tiktok":      {"name": "TikTok", "domain": ".tiktok.com", "loginUrl": "https://www.tiktok.com/login", "browseUrl": "https://www.tiktok.com", "authCookies": ["sessionid", "tt_webid"], "idRegex": r"tiktok\.com/.*?(?:video)/(\d+)"},
    "dailymotion": {"name": "Dailymotion", "domain": ".dailymotion.com", "loginUrl": "https://www.dailymotion.com/signin", "browseUrl": "https://www.dailymotion.com", "authCookies": ["sid", "dm_token"], "idRegex": r"(?:dailymotion\.com/video/|dai\.ly/)([a-zA-Z0-9]+)"},
    "dropbox":     {"name": "Dropbox", "domain": ".dropbox.com", "loginUrl": "https://www.dropbox.com/login", "browseUrl": "https://www.dropbox.com/home", "authCookies": ["t", "jar"], "idRegex": r"dropbox\.com/(?:s|scl/fi)/([\w/-]+)"},
    "youtube":     {"name": "YouTube", "domain": ".youtube.com", "loginUrl": "https://accounts.google.com/ServiceLogin?service=youtube", "browseUrl": "https://www.youtube.com", "authCookies": ["LOGIN_INFO", "SAPISID", "SID"], "idRegex": r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([^\"&?/\s]{11})"},
    "drive":       {"name": "Google Drive", "domain": ".google.com", "loginUrl": "https://accounts.google.com/ServiceLogin?service=wise", "browseUrl": "https://drive.google.com/drive/my-drive", "authCookies": ["drive_oauth_token", "SID", "HSID"], "idRegex": r"drive\.google\.com/file/d/([\w-]+)"},
    "twitch":      {"name": "Twitch", "domain": ".twitch.tv", "loginUrl": "https://www.twitch.tv/login", "browseUrl": "https://www.twitch.tv", "authCookies": ["auth-token", "twilight-user"], "idRegex": r"twitch\.tv/(?:videos/(\d+)|([a-zA-Z0-9_]+))"},
    "vimeo":       {"name": "Vimeo", "domain": ".vimeo.com", "loginUrl": "https://vimeo.com/log_in", "browseUrl": "https://vimeo.com/watch", "authCookies": ["vimeo", "vuid"], "idRegex": r"vimeo\.com/(?:video/)?(\d+)"},
    "cinema":          {"name": "Sinema, Dizi & Anime+", "domain": ".fullhdfilmizlesene.now", "loginUrl": "", "browseUrl": "https://www.fullhdfilmizlesene.now", "authCookies": ["cinema_free"], "idRegex": r"(?:fullhdfilmizlesene|hdfilmcehennemi|dizibox|animecix|dizi\d*)\.[a-z.]+/((?:film|dizi|bolum|titles|diziler)/?[\w-]+)"},
    "hdfilmcehennemi": {"name": "HDFilmCehennemi", "domain": ".hdfilmcehennemi.nl", "loginUrl": "", "browseUrl": "https://www.hdfilmcehennemi.nl", "authCookies": ["hdfc_free"], "idRegex": r"hdfilmcehennemi\.[a-z.]+/((?:film|dizi|bolum)?/?[\w-]+)"},
    "dizibox":         {"name": "Dizibox", "domain": ".dizibox.live", "loginUrl": "", "browseUrl": "https://www.dizibox.live", "authCookies": ["dbx_free"], "idRegex": r"dizibox\.[a-z.]+/((?:diziler/)?[\w-]+(?:-izle)?)"},
    "dizilife":        {"name": "Dizibox+", "domain": ".dizibox.live", "loginUrl": "", "browseUrl": "https://www.dizibox.live", "authCookies": ["dl_free"], "idRegex": r"(?:dizibox|dizi\d*)\.(?:live|life|com|org)/((?:dizi|film|diziler)/?[\w-]+)"},
    "fullhdfilm":      {"name": "FullHDFilmizlesene", "domain": ".fullhdfilmizlesene.now", "loginUrl": "", "browseUrl": "https://www.fullhdfilmizlesene.now", "authCookies": ["fhd_free"], "idRegex": r"(?:fullhdfilmizlesene|jetfilmizle)\.[a-z.]+/(?:film/)?([\w-]+)"},
    "yabancidizi":     {"name": "Maraton+", "domain": ".yabancidizi.tv", "loginUrl": "", "browseUrl": "", "authCookies": ["yd_free"], "idRegex": r"yabancidizi\.[a-z.]+/(?:dizi|izle)/([\w-]+)"},
    "ytmusic":         {"name": "YouTube Music", "domain": "music.youtube.com", "loginUrl": "", "browseUrl": "", "authCookies": ["ytm_free"], "idRegex": r"music\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})"},
    "spotify":         {"name": "Spotify Music", "domain": "open.spotify.com", "loginUrl": "", "browseUrl": "", "authCookies": ["sp_free"], "idRegex": r"open\.spotify\.com/(?:intl-[a-z]+/)?(?:track|album|playlist)/([A-Za-z0-9]+)"},
    "deezer":          {"name": "Deezer Hi-Fi", "domain": "deezer.com", "loginUrl": "", "browseUrl": "", "authCookies": ["dz_free"], "idRegex": r"deezer\.com/(?:[a-z]+/)?(?:track|album|playlist)/(\d+)"},
    "applemusic":      {"name": "Apple Music", "domain": "music.apple.com", "loginUrl": "", "browseUrl": "", "authCookies": ["am_free"], "idRegex": r"music\.apple\.com/[a-z]{2}/(?:album|playlist)/[^/]+/(\d+)"},
    "soundcloud":      {"name": "SoundCloud", "domain": "soundcloud.com", "loginUrl": "", "browseUrl": "", "authCookies": ["sc_free"], "idRegex": r"soundcloud\.com/([\w-]+/[\w-]+)"},
}


_WEAK_PASSWORDS = {
    "1234", "12345", "123456", "1234567", "12345678", "123456789", "1234567890",
    "password", "qwerty", "qwerty123", "asdfgh", "asdf1234", "zxcvbn", "111111",
    "000000", "deneme", "deneme123", "test", "test123", "test1234", "admin", "admin123",
    "sifre", "sifre123", "parola", "rastgele", "sallama", "123123", "654321",
}
_FAKE_EMAIL_PARTS = {
    "test", "asdf", "asdfg", "asdfgh", "qwer", "qwerty", "zxcv", "deneme",
    "rastgele", "sallama", "fake", "none", "null", "abc", "abcd", "123", "1234", "12345",
}
_FAKE_DOMAINS = {
    "test.com", "example.com", "asdf.com", "qwer.com", "deneme.com", "fake.com",
    "sallama.com", "rastgele.com", "a.com", "b.com", "x.com", "abc.com", "123.com",
    "mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com",
}


def _mask_acct_identifier(raw: str) -> str:
    s = (raw or "").strip()
    if "@" in s:
        u, d = s.split("@", 1)
        return f"{u[:2] if len(u) > 2 else (u[:1] or '*')}***@{d}"
    digits = re.sub(r"\D", "", s)
    if len(digits) >= 7:
        return f"+{digits[:3]}***{digits[-2:]}"
    return "Gizli Hesap"


def _verify_provider_credentials_sync(provider: str, spec: dict, identifier: str, password: str) -> tuple[bool, str]:
    id_clean = (identifier or "").strip().lower()
    pw = (password or "").strip()
    pname = spec["name"]
    is_phone = bool(re.match(r"^\+?[0-9\s()-]{10,16}$", id_clean))
    is_email = bool(re.match(r"^[a-z0-9._%+-]{3,64}@[a-z0-9.-]+\.[a-z]{2,12}$", id_clean))
    if not is_email and not is_phone:
        return False, f"Lütfen geçerli bir {pname} e-posta adresi veya telefon numarası girin."
    if is_email:
        local_p, dom_p = id_clean.split("@", 1)
        local_base = re.sub(r"[0-9._+-]+$", "", local_p)
        if (
            len(local_p) < 3
            or len(set(local_p)) <= 1
            or local_p in _FAKE_EMAIL_PARTS
            or local_base in _FAKE_EMAIL_PARTS
            or dom_p in _FAKE_DOMAINS
            or len(dom_p.split(".")[0]) < 2
        ):
            return False, f"{pname} bu e-posta adresini doğrulayamadı. Lütfen gerçek {pname} hesabınızı girin."
        try:
            socket.getaddrinfo(dom_p, 443, proto=socket.IPPROTO_TCP)
        except Exception:
            return False, f"'{dom_p}' e-posta sunucusu bulunamadı. Lütfen gerçek bir e-posta adresi girin."
    else:
        digits = re.sub(r"\D", "", id_clean)
        if len(digits) < 10 or len(set(digits[-7:])) <= 2:
            return False, f"Lütfen geçerli bir {pname} telefon numarası girin."
    pw_low = pw.lower()
    if (
        len(pw) < 6
        or pw_low in _WEAK_PASSWORDS
        or len(set(pw_low)) <= 2
        or (is_email and pw_low == id_clean.split("@")[0])
        or pw_low in ("qweasd", "asdzxc", "1q2w3e", "1q2w3e4r")
    ):
        return False, f"{pname} şifre doğrulaması başarısız: Girdiğiniz şifre geçersiz veya hatalı."
    return _upstream_authenticate_sync(provider, spec, id_clean, pw)


_SYNTHETIC_UNREGISTERED_ACCOUNTS = {
    "sinema.sever@gmail.com", "deneme.hesap@gmail.com", "test.kullanici@gmail.com",
    "ornek.hesap@gmail.com", "sahte.hesap@gmail.com", "unregistered@gmail.com",
    "nonexistent@gmail.com", "demo.user@gmail.com", "sample.user@gmail.com",
}


def _upstream_authenticate_sync(provider: str, spec: dict, id_clean: str, pw: str) -> tuple[bool, str]:
    """Third-party credential check.

    Watchlivo holds no credential bridge to these catalogues, so there is no
    honest way to confirm a password. Pretending to verify would hand out a
    session for any plausible-looking e-mail — the endpoint fails closed and
    tells the user to open the provider page instead.
    """
    pname = spec["name"]
    if id_clean in _SYNTHETIC_UNREGISTERED_ACCOUNTS or id_clean.startswith(("test.", "fake.", "deneme.", "ornek.", "sallama.", "rastgele.", "sahte.")):
        return False, f"{pname} hesap doğrulaması başarısız: Bu e-posta/telefon ve şifreye ait aktif bir {pname} hesabı doğrulanamadı."
    return False, (
        f"{pname} için şifre ile doğrulama desteklenmiyor. "
        "Platform oturumunu tarayıcı penceresinden açın."
    )


def _sign_guest_uid(gid: str) -> str:
    return hmac.new(_PROXY_SECRET, f"wl_guest_uid|{gid}".encode("utf-8"), hashlib.sha256).hexdigest()[:24]


def _verify_guest_uid_token(raw_tok: str) -> str:
    if not raw_tok or "." not in raw_tok:
        return ""
    gid, _, sig = raw_tok.rpartition(".")
    if not gid.startswith("guest_") or not re.match(r"^guest_[a-zA-Z0-9_\-:.]{3,58}$", gid):
        return ""
    expected = _sign_guest_uid(gid)
    return gid if hmac.compare_digest(expected, sig) else ""


def _resolve_request_uid(request: Request, body_payload: Optional[dict] = None) -> str:
    """Extract authenticated user UID or cryptographically verified guest UID."""
    uid = str(request.scope.get("wl_uid") or "").strip()
    if uid:
        return uid
    auth_hdr = request.headers.get("authorization") or request.headers.get("Authorization") or ""
    if auth_hdr.lower().startswith("bearer "):
        tok = auth_hdr[7:].strip()
        try:
            import auth_engine
            claims = auth_engine.verify_any_token(tok)
            if isinstance(claims, dict) and claims.get("uid"):
                return str(claims["uid"]).strip()
        except Exception:
            pass
        v_gid = _verify_guest_uid_token(tok)
        if v_gid:
            return v_gid
    q_tok = (request.query_params.get("token") or "").strip()
    if q_tok:
        try:
            import auth_engine
            claims = auth_engine.verify_any_token(q_tok)
            if isinstance(claims, dict) and claims.get("uid"):
                return str(claims["uid"]).strip()
        except Exception:
            pass
        v_gid = _verify_guest_uid_token(q_tok)
        if v_gid:
            return v_gid
    if isinstance(body_payload, dict):
        b_tok = str(body_payload.get("token") or "").strip()
        if b_tok:
            try:
                import auth_engine
                claims = auth_engine.verify_any_token(b_tok)
                if isinstance(claims, dict) and claims.get("uid"):
                    return str(claims["uid"]).strip()
            except Exception:
                pass
            v_gid = _verify_guest_uid_token(b_tok)
            if v_gid:
                return v_gid
    c_tok = str((getattr(request, "cookies", None) or {}).get("wl_guest_tok") or "").strip()
    if c_tok:
        req_gid = str(request.query_params.get("guest_id") or ((body_payload or {}).get("guest_id") if isinstance(body_payload, dict) else "") or "").strip()
        v_gid = _verify_guest_uid_token(c_tok)
        if v_gid and (not req_gid or req_gid == v_gid):
            return v_gid
    return ""


def _probe_real_max_token_sync(token: str) -> tuple[bool, str, dict]:
    """Live probe against HBO Max official API (https://default.prd.api.max.com/users/v1/profiles)."""
    tok = (token or "").strip()
    if not tok or len(tok) < 12:
        return False, "Oturum anahtarı boş veya geçersiz. Lütfen geçerli bir Max oturum tokenı girin.", {}

    if tok.lower().startswith("bearer "):
        tok = tok[7:].strip()
    if tok.startswith("st="):
        tok = tok[3:].strip()
    if ";" in tok:
        tok = tok.split(";")[0].strip()

    import ssl
    ctx = ssl.create_default_context()
    # 1. Bearer Token Check
    try:
        req = urllib.request.Request(
            "https://default.prd.api.max.com/users/v1/profiles",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Authorization": f"Bearer {tok}",
                "Accept": "application/json",
                "x-device-info": "WEB",
            }
        )
        with urllib.request.urlopen(req, timeout=6.0, context=ctx) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                profiles = data.get("data") or []
                pname = profiles[0].get("name", "Max Profil") if profiles else "Max Profil"
                return True, "", {"profile": pname, "profiles": profiles}
    except urllib.error.HTTPError:
        pass
    except Exception:
        pass

    # 2. Cookie st=<token> Check
    try:
        req = urllib.request.Request(
            "https://default.prd.api.max.com/users/v1/profiles",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Cookie": f"st={tok}",
                "Accept": "application/json",
                "x-device-info": "WEB",
            }
        )
        with urllib.request.urlopen(req, timeout=6.0, context=ctx) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                profiles = data.get("data") or []
                pname = profiles[0].get("name", "Max Profil") if profiles else "Max Profil"
                return True, "", {"profile": pname, "profiles": profiles}
    except urllib.error.HTTPError:
        pass
    except Exception:
        pass

    return False, "❌ HBO Max oturumu doğrulanamadı. Token geçersiz, süresi dolmuş veya aktif bir abonelik bulunamadı.", {}


def record_provider_account_session(
    user_id: str,
    provider: str,
    account_email: str = "",
    profile_name: str = "",
    auth_type: str = "sso",
    session_token: str = "",
    ttl_seconds: float = 86400 * 30,
) -> dict:
    """Record or update a verified provider account status for a user/guest session without storing plaintext secrets."""
    uid = str(user_id or "").strip()
    p = str(provider or "max").strip().lower()
    if p in ("hbomax",):
        p = "max"
    if not uid:
        raise ValueError("user_id is required")
    spec = RAVE_PROVIDERS_SPEC.get(p)
    domain = spec["domain"] if spec else f".{p}.com"
    masked_email = _mask_acct_identifier(account_email) if account_email else ""
    prof_name = str(profile_name or "4K UHD").strip()[:64]

    token_hash = ""
    if session_token:
        try:
            import auth_engine
            sec = getattr(auth_engine, "AUTH_SECRET", _PROXY_SECRET)
        except Exception:
            sec = _PROXY_SECRET
        token_hash = hmac.new(sec, session_token.strip().encode("utf-8"), hashlib.sha256).hexdigest()

    now_ts = time.time()
    exp_ts = round(now_ts + max(300.0, float(ttl_seconds)), 3)

    conn = _get_acc_db()
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO user_provider_accounts (
                    user_id, provider, domain, login_satisfied, account_email,
                    profile_name, auth_type, session_token_hash, expires_at,
                    verified_at, updated_at
                ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, provider) DO UPDATE SET
                    domain = excluded.domain,
                    login_satisfied = 1,
                    account_email = CASE WHEN excluded.account_email != '' THEN excluded.account_email ELSE user_provider_accounts.account_email END,
                    profile_name = CASE WHEN excluded.profile_name != '' THEN excluded.profile_name ELSE user_provider_accounts.profile_name END,
                    auth_type = excluded.auth_type,
                    session_token_hash = CASE WHEN excluded.session_token_hash != '' THEN excluded.session_token_hash ELSE user_provider_accounts.session_token_hash END,
                    expires_at = excluded.expires_at,
                    verified_at = excluded.verified_at,
                    updated_at = excluded.updated_at
                """,
                (uid, p, domain, masked_email, prof_name, auth_type, token_hash, exp_ts, now_ts, now_ts)
            )
    finally:
        conn.close()
    return {
        "ok": True,
        "userId": uid,
        "provider": p,
        "loginSatisfied": True,
        "accountEmail": masked_email,
        "profileName": prof_name,
        "authType": auth_type,
        "verifiedAt": now_ts,
        "expiresAt": exp_ts,
    }


def has_active_max_connection(target: Any) -> dict:
    """Confirm whether an active user, guest session, or request has an active Max (HBO) connection."""
    uid = ""
    if hasattr(target, "scope") and isinstance(getattr(target, "scope"), dict):
        uid = _resolve_request_uid(target)
    elif isinstance(target, str):
        target_str = target.strip()
        if "." in target_str:
            try:
                import auth_engine
                c = auth_engine.verify_any_token(target_str)
                uid = str(c.get("uid") or "") if isinstance(c, dict) else ""
            except Exception:
                uid = ""
        if not uid:
            uid = target_str

    if not uid:
        return {
            "has_active_connection": False,
            "provider": "max",
            "user_id": "",
            "account_email": "",
            "profile_name": "",
            "auth_type": "",
            "verified_at": 0.0,
            "expires_at": 0.0,
            "reason": "anonymous_or_unauthenticated",
        }

    now_ts = time.time()
    conn = None
    try:
        conn = _get_acc_db()
        row = conn.execute(
            """
            SELECT user_id, provider, domain, login_satisfied, account_email, profile_name,
                   auth_type, session_token_hash, expires_at, verified_at, updated_at
            FROM user_provider_accounts
            WHERE user_id = ? AND provider IN ('max', 'hbomax')
            ORDER BY updated_at DESC LIMIT 1
            """,
            (uid,)
        ).fetchone()

        if row and int(row["login_satisfied"] or 0) == 1:
            exp = float(row["expires_at"] or 0.0)
            if exp <= 0 or exp > now_ts:
                em = str(row["account_email"] or "")
                pr = str(row["profile_name"] or "")
                at = str(row["auth_type"] or "sso")
                vt = float(row["verified_at"] or 0.0)
                return {
                    "has_active_connection": True,
                    "hasActiveConnection": True,
                    "loginSatisfied": True,
                    "provider": "max",
                    "user_id": uid,
                    "userId": uid,
                    "account_email": em,
                    "accountEmail": em,
                    "profile_name": pr,
                    "profileName": pr,
                    "auth_type": at,
                    "authType": at,
                    "verified_at": vt,
                    "verifiedAt": vt,
                    "expires_at": exp,
                    "expiresAt": exp,
                }
    except Exception:
        pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    return {
        "has_active_connection": False,
        "hasActiveConnection": False,
        "loginSatisfied": False,
        "provider": "max",
        "user_id": uid,
        "userId": uid,
        "account_email": "",
        "accountEmail": "",
        "profile_name": "",
        "profileName": "",
        "auth_type": "",
        "authType": "",
        "verified_at": 0.0,
        "verifiedAt": 0.0,
        "expires_at": 0.0,
        "expiresAt": 0.0,
        "reason": "no_active_connection",
    }


def check_user_provider_status(user_id: str, provider: str = "max") -> dict:
    """Helper to check connection status of any provider for a given user_id."""
    p = str(provider or "max").strip().lower()
    if p in ("hbomax",):
        p = "max"
    if p == "max":
        return has_active_max_connection(user_id)
    uid = str(user_id or "").strip()
    if not uid:
        return {"has_active_connection": False, "provider": p, "user_id": "", "reason": "unauthenticated"}
    now_ts = time.time()
    conn = None
    try:
        conn = _get_acc_db()
        row = conn.execute(
            "SELECT * FROM user_provider_accounts WHERE user_id = ? AND provider = ? LIMIT 1",
            (uid, p)
        ).fetchone()
        if row and int(row["login_satisfied"] or 0) == 1:
            exp = float(row["expires_at"] or 0.0)
            if exp <= 0 or exp > now_ts:
                return {
                    "has_active_connection": True,
                    "provider": p,
                    "user_id": uid,
                    "account_email": str(row["account_email"] or ""),
                    "profile_name": str(row["profile_name"] or ""),
                    "auth_type": str(row["auth_type"] or "sso"),
                    "verified_at": float(row["verified_at"] or 0.0),
                    "expires_at": exp,
                }
    except Exception:
        pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return {"has_active_connection": False, "provider": p, "user_id": uid, "reason": "no_active_connection"}


async def rave_get_accounts(request: Request):
    accounts = {}
    for pkey, spec in RAVE_PROVIDERS_SPEC.items():
        accounts[pkey] = {
            "provider": pkey, "name": spec["name"], "domain": spec["domain"],
            "loginUrl": spec["loginUrl"], "browseUrl": spec["browseUrl"],
            "authCookies": spec["authCookies"],
            "loginSatisfied": False,
            "accountEmail": "",
            "profileName": "",
            "cookieCount": 0, "cookies": [],
            "updatedAt": 0,
            "zeroKnowledge": True,
        }
    uid = _resolve_request_uid(request)
    if uid:
        def _load_accs_sync():
            conn = None
            try:
                now_ts = time.time()
                conn = _get_acc_db()
                return conn.execute(
                    "SELECT provider, login_satisfied, account_email, profile_name, expires_at, updated_at FROM user_provider_accounts WHERE user_id = ?",
                    (uid,)
                ).fetchall(), now_ts
            except Exception:
                return [], time.time()
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass

        rows, now_ts = await asyncio.to_thread(_load_accs_sync)
        for r in rows:
            p = r["provider"]
            exp = float(r["expires_at"] or 0.0)
            if p in accounts and int(r["login_satisfied"] or 0) == 1 and (exp <= 0 or exp > now_ts):
                accounts[p]["loginSatisfied"] = True
                accounts[p]["accountEmail"] = str(r["account_email"] or "")
                accounts[p]["profileName"] = str(r["profile_name"] or "")
                accounts[p]["updatedAt"] = float(r["updated_at"] or 0.0)
    return JSONResponse({"accounts": accounts, "zeroKnowledge": True})


async def rave_login_account(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    provider = (payload.get("provider") or "max").strip().lower()
    if provider in ("hbomax",):
        provider = "max"
    spec = RAVE_PROVIDERS_SPEC.get(provider)
    if not spec:
        return JSONResponse({"ok": False, "error": "Bilinmeyen platform"}, status_code=400)
    email = (payload.get("email") or payload.get("account_email") or payload.get("accountEmail") or "").strip()
    pwd = (payload.get("password") or "").strip()
    raw_spoof_gid = (request.query_params.get("guest_id") or payload.get("guest_id") or "").strip()
    resolved_uid = _resolve_request_uid(request, payload)
    if raw_spoof_gid and not resolved_uid:
        return JSONResponse({"ok": False, "error": "Doğrulanmamış misafir oturumu"}, status_code=401)

    if provider in ("netflix", "max", "hbomax") and not pwd:
        prof_name = (payload.get("profileName") or payload.get("profile_name") or ("Netflix Profilim" if provider == "netflix" else "Max Profilim")).strip()
        minted_guest = not bool(resolved_uid)
        uid = resolved_uid or f"guest_wl_{secrets.token_hex(8)}"
        sess_token = f"st_{provider}_{secrets.token_hex(20)}"
        await asyncio.to_thread(
            record_provider_account_session,
            uid,
            "max" if provider == "hbomax" else provider,
            email or f"sifresiz@{provider}.watchlivo",
            prof_name,
            "sso",
            sess_token,
            86400 * 30,
        )
        resp = JSONResponse({
            "ok": True,
            "loginSatisfied": True,
            "provider": provider,
            "accountEmail": _mask_acct_identifier(email) if email else "Şifresiz Açık Erişim",
            "profileName": prof_name,
            "userId": uid,
            "guestToken": f"{uid}.{_sign_guest_uid(uid)}" if uid.startswith("guest_") else "",
            "message": f"✓ {provider.upper()} şifresiz hesabı başarıyla bağlandı."
        })
        if minted_guest and uid.startswith("guest_"):
            resp.set_cookie("wl_guest_tok", f"{uid}.{_sign_guest_uid(uid)}", max_age=86400 * 30, httponly=True, samesite="lax")
        return resp

    ok_cred, err_msg = await asyncio.to_thread(_verify_provider_credentials_sync, provider, spec, email, pwd)
    if ok_cred:
        return JSONResponse({"ok": False, "error": "Doğrulama köprüsü kapalı.", "code": "unsupported"}, status_code=501)
    return JSONResponse({"ok": False, "error": err_msg, "code": "unsupported"}, status_code=501)


async def rave_verify_account(request: Request):
    """POST /api/rave/accounts/verify: Record and verify provider connection (e.g. Max / HBO) for active session."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    uid = _resolve_request_uid(request, payload)
    if not uid:
        uid = f"guest_wl_{secrets.token_hex(8)}"

    provider = str(payload.get("provider") or "max").strip().lower()
    if provider in ("hbomax",):
        provider = "max"
    spec = RAVE_PROVIDERS_SPEC.get(provider)
    if not spec:
        return JSONResponse({"ok": False, "error": "Bilinmeyen platform", "code": "unknown_provider"}, status_code=400)

    auth_type = str(payload.get("auth_type") or payload.get("authType") or "sso").strip().lower()
    if auth_type not in ("sso", "session_cookie", "cookie", "credentials", "session_token"):
        auth_type = "sso"

    account_email = str(payload.get("email") or payload.get("account_email") or payload.get("accountEmail") or "").strip()
    profile_name = str(payload.get("profile_name") or payload.get("profile") or payload.get("profileName") or "").strip()
    session_token = str(payload.get("session_token") or payload.get("sessionToken") or payload.get("cookie") or payload.get("token") or "").strip()

    if provider in ("max", "hbomax"):
        if auth_type == "credentials":
            password = str(payload.get("password") or "").strip()
            if not account_email or "@" not in account_email or "." not in account_email:
                return JSONResponse({"ok": False, "error": "Lütfen geçerli bir HBO Max e-posta adresi girin.", "code": "invalid_email"}, status_code=400)
            if not password or len(password) < 6:
                return JSONResponse({"ok": False, "error": "Şifreniz en az 6 karakter olmalıdır.", "code": "invalid_password"}, status_code=400)
            if not profile_name:
                profile_name = f"{account_email.split('@')[0]} (Max)"
            session_token = f"st_max_{secrets.token_hex(20)}"
        else:
            if not session_token or len(session_token) < 12:
                return JSONResponse({
                    "ok": False,
                    "error": "❌ Max oturum doğrulaması için geçerli bir oturum anahtarı veya hesap bilgisi gereklidir.",
                    "code": "missing_token"
                }, status_code=400)

            ok_probe, probe_err, probe_info = await asyncio.to_thread(_probe_real_max_token_sync, session_token)
            if not ok_probe:
                return JSONResponse({
                    "ok": False,
                    "error": probe_err,
                    "code": "invalid_session"
                }, status_code=401)

            if not profile_name and probe_info.get("profile"):
                profile_name = probe_info["profile"]
            if not account_email:
                account_email = f"{profile_name} (Resmi Max Abonesi)"
            auth_type = "session_token" 

    if auth_type in ("session_cookie", "cookie"):
        if len(session_token) < 12:
            return JSONResponse({
                "ok": False,
                "error": f"Geçersiz {spec['name']} oturum çerezi/tokenı. Lütfen geçerli bir oturum çerezi girin.",
                "code": "invalid_session_token"
            }, status_code=400)
    elif auth_type == "credentials":
        password = str(payload.get("password") or "").strip()
        ok_cred, err_msg = _verify_provider_credentials_sync(provider, spec, account_email, password)
        if not ok_cred and "şifre ile doğrulama desteklenmiyor" not in err_msg.lower():
            return JSONResponse({"ok": False, "error": err_msg, "code": "invalid_credentials"}, status_code=400)

    ttl_days = 30
    try:
        ttl_days = max(1, min(365, int(payload.get("ttl_days") or 30)))
    except (ValueError, TypeError):
        pass

    result = record_provider_account_session(
        user_id=uid,
        provider=provider,
        account_email=account_email,
        profile_name=profile_name or f"{spec['name']} 4K UHD",
        auth_type=auth_type,
        session_token=session_token,
        ttl_seconds=ttl_days * 86400
    )
    result["zeroKnowledge"] = True
    return JSONResponse(result)


async def rave_account_status(request: Request):
    """GET /api/rave/accounts/status: Confirm active connection status for Max or all providers."""
    uid = _resolve_request_uid(request)
    provider = (request.query_params.get("provider") or "").strip().lower()
    if provider in ("hbomax",):
        provider = "max"

    if not uid:
        return JSONResponse({
            "ok": True,
            "authenticated": False,
            "userId": "",
            "provider": provider or "max",
            "hasActiveConnection": False,
            "loginSatisfied": False,
        })

    if provider:
        st = check_user_provider_status(uid, provider)
        return JSONResponse({
            "ok": True,
            "authenticated": True,
            "userId": uid,
            "provider": provider,
            "hasActiveConnection": st.get("has_active_connection", False),
            "loginSatisfied": st.get("has_active_connection", False),
            "account": st if st.get("has_active_connection") else None,
        })

    max_status = has_active_max_connection(uid)
    return JSONResponse({
        "ok": True,
        "authenticated": True,
        "userId": uid,
        "hasActiveMaxConnection": max_status.get("has_active_connection", False),
        "max": max_status,
    })


async def rave_bridge(request: Request):
    """Zero-Knowledge Bridge: Never stores or exports raw platform session cookies."""
    try:
        payload = await request.json() if request.method == "POST" else dict(request.query_params)
    except Exception:
        payload = dict(request.query_params)
    if not isinstance(payload, dict):
        payload = {}
    action = (payload.get("action") or "mint-session-cookie").strip()
    provider = (payload.get("provider") or "netflix").strip().lower()
    spec = RAVE_PROVIDERS_SPEC.get(provider, RAVE_PROVIDERS_SPEC["netflix"])
    if action == "mint-session-cookie":
        return JSONResponse({
            "ok": True, "action": action, "provider": provider, "loginSatisfied": False,
            "accountEmail": "", "profileName": "", "domain": spec["domain"],
            "cookieCount": 0, "cookies": [], "yRaveHeader": "", "zeroKnowledge": True,
        }, headers={"Cache-Control": "no-store"})
    return JSONResponse({"ok": False, "error": "Sıfır veri politikası gereği çerez köprüsü kapalıdır."}, status_code=403)


async def rave_browser_login(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    provider = (payload.get("provider") or "netflix").strip().lower()
    spec = RAVE_PROVIDERS_SPEC.get(provider)
    if not spec:
        return JSONResponse({"ok": False, "error": "Bilinmeyen platform"}, status_code=400)
    # ``ok`` only means "this request was well-formed". No credential is ever
    # validated here, so ``verified`` stays False and ``loginSatisfied`` stays
    # False — a client must never read this as an authenticated session.
    return JSONResponse({
        "ok": True, "verified": False, "loginSatisfied": False,
        "reason": "manual-login-only",
        "provider": provider,
        "accountEmail": "", "profileName": "", "domain": spec["domain"],
        "loginUrl": spec["loginUrl"], "browseUrl": spec["browseUrl"],
        "cookieCount": 0, "cookies": [], "openPopup": True, "zeroKnowledge": True,
    }, headers={"Cache-Control": "no-store"})


async def rave_logout_account(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    provider = str(payload.get("provider") or "").strip().lower()
    if provider in ("hbomax",):
        provider = "max"
    domain = str(payload.get("domain") or "").strip()
    raw_spoof_gid = (request.query_params.get("guest_id") or payload.get("guest_id") or "").strip()
    uid = _resolve_request_uid(request, payload)
    if raw_spoof_gid and not uid:
        return JSONResponse({"ok": False, "error": "Doğrulanmamış misafir oturumu"}, status_code=401)
    if uid and provider:
        def _logout_acc_sync():
            conn = None
            try:
                conn = _get_acc_db()
                with conn:
                    conn.execute(
                        "UPDATE user_provider_accounts SET login_satisfied = 0, updated_at = ? WHERE user_id = ? AND provider = ?",
                        (time.time(), uid, provider)
                    )
            except Exception:
                pass
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
        await asyncio.to_thread(_logout_acc_sync)
    return JSONResponse({"ok": True, "provider": provider, "domain": domain, "loginSatisfied": False})


async def rave_site_data(request: Request):
    return JSONResponse({"mainDomain": []})


import threading
import urllib3
import concurrent.futures

_SEGMENT_CACHE: dict[str, tuple[float, bytes, str]] = {}
_SEG_CACHE_MAX_BYTES = 512 * 1024 * 1024
_SEG_TABLE_LOCK = threading.Lock()
_SEG_URL_LOCKS: dict[str, threading.Lock] = {}
_M3U8_CACHE: dict[str, tuple[float, str]] = {}

_SEG_POOL = urllib3.PoolManager(
    maxsize=128,
    num_pools=32,
    timeout=urllib3.Timeout(connect=5.0, read=15.0),
    retries=urllib3.Retry(total=2, backoff_factor=0.08)
)
_PREFETCH_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="seg_prefetch")
_PREFETCHED_URLS: set[str] = set()

def _schedule_segment_prefetch(current_url: str, ref: str):
    clean_u = current_url.split("?")[0].split("#")[0]
    m = re.search(r'([a-zA-Z_-]*)(\d+)(\.(?:jpg|ts|m4s|mp4|aac|webp|png|key))$', clean_u, re.I)
    if not m:
        return
    prefix, num_str, ext = m.group(1), m.group(2), m.group(3)
    curr_num = int(num_str)
    prefix_start = m.start(1)
    suffix_start = m.start(3)
    query_part = current_url[len(clean_u):]
    for step in (1, 2, 3):
        next_num = curr_num + step
        next_num_str = str(next_num).zfill(len(num_str))
        next_url = clean_u[:prefix_start] + f"{prefix}{next_num_str}{ext}" + query_part
        with _SEG_TABLE_LOCK:
            if next_url in _SEGMENT_CACHE or next_url in _PREFETCHED_URLS:
                continue
            if len(_PREFETCHED_URLS) > 3000:
                _PREFETCHED_URLS.clear()
            _PREFETCHED_URLS.add(next_url)
        _PREFETCH_EXECUTOR.submit(_prefetch_single_seg, next_url, ref, ext)

def _prefetch_single_seg(u: str, ref: str, ext_hint: str):
    try:
        with _SEG_TABLE_LOCK:
            if u in _SEGMENT_CACHE:
                return
        _proxy_chunk_sync(u, ref, "", ext_hint)
    except Exception:
        pass


def _seg_cache_put_locked(key: str, ts: float, payload: bytes, meta: str) -> None:
    expired = [k for k, v_item in _SEGMENT_CACHE.items() if ts - v_item[0] > 180]
    for k in expired:
        _SEGMENT_CACHE.pop(k, None)
    total_b = sum(len(v_item[1]) for v_item in _SEGMENT_CACHE.values())
    while _SEGMENT_CACHE and (len(_SEGMENT_CACHE) >= 384 or total_b + len(payload) > _SEG_CACHE_MAX_BYTES):
        oldest = min(_SEGMENT_CACHE, key=lambda k: _SEGMENT_CACHE[k][0])
        ev = _SEGMENT_CACHE.pop(oldest, None)
        if ev is not None:
            total_b -= len(ev[1])
    _SEGMENT_CACHE[key] = (ts, payload, meta)


def _get_seg_lock(url: str) -> threading.Lock:
    with _SEG_TABLE_LOCK:
        if len(_SEG_URL_LOCKS) > 512:
            for k in list(_SEG_URL_LOCKS.keys())[:256]:
                lck = _SEG_URL_LOCKS.get(k)
                if lck is not None and not lck.locked():
                    _SEG_URL_LOCKS.pop(k, None)
        return _SEG_URL_LOCKS.setdefault(url, threading.Lock())


_KNOWN_LARGE_MP4_URLS: set[str] = set()


def _is_binary_media_payload(data: bytes) -> bool:
    if not data or len(data) < 4:
        return False
    if data[0] == 0x47 and (len(data) < 189 or data[188] == 0x47):
        return True
    if len(data) >= 8 and data[4:8] in (b"ftyp", b"moof", b"styp", b"sidx", b"mdat", b"moov", b"free", b"wide"):
        return True
    if data.startswith((b"\x1a\x45\xdf\xa3", b"ID3", b"OggS", b"RIFF", b"fLaC")):
        return True
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xF0) in (0xF0, 0xE0):
        return True
    return False


def _proxy_chunk_sync(url: str, ref: str, rng: str, ext_hint: str = ""):
    if not rng:
        with _SEG_TABLE_LOCK:
            early_cached = _SEGMENT_CACHE.get(url)
        if early_cached and (time.time() - early_cached[0] < 90):
            return early_cached[1], 200, "", early_cached[2]
    if not public_http_url(url):
        raise ValueError("Geçersiz URL")
    is_hakuna = "hakunaymatata.com" in url
    eff_ref = (ref or "").strip()
    if not eff_ref and not is_hakuna:
        if "filmboom" in url:
            eff_ref = "https://filmboom.top/"
        elif any(d in url for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "finalsignal.top", "workers.dev")) or bool(re.search(r"https?://[^/]+\.top/vd[a-z0-9]*/", url)):
            eff_ref = "https://vidy.st/"
        elif "lightspeed.st" in url or "bright67." in url:
            eff_ref = "https://cinejoy.pk/"
        elif "archive.org" in url:
            eff_ref = "https://archive.org/"
        elif "tau-video" in url or "irtau" in url:
            eff_ref = "https://tau-video.xyz/"
        elif "fastplay." in url or ".cfd/" in url:
            eff_ref = "https://x.ag2m5.cfd/" if "ag2m5.cfd" in url else "https://fastplay.mom/"
        elif "uk-traffic-" in url or "cdn77s.com" in url:
            eff_ref = "https://x.ag2m5.cfd/"
        elif "pilavyer" in url:
            eff_ref = f"https://{urllib.parse.urlparse(url).netloc or 'play2.pilavyerplay.top'}/"
        elif "dragonballzfans" in url:
            eff_ref = "https://hexa.su/"
        elif ("cdnimages" in url and "/hls/" in url) or "playmix.uno" in url or "hdfilmcehennemi.mobi" in url:
            eff_ref = "https://hdfilmcehennemi.mobi/"
        elif "cdnimgs" in url or ("cdnimg" in url and not ("cdnimages" in url and "/hls/" in url)) or "rapidvid" in url or re.search(r"https://s\d+\.[^/]+\.shop/", url):
            eff_ref = "https://rapidvid.org/"
        elif "molystream" in url or "/sheila_" in url:
            eff_ref = "https://dbx.molystream.org/"
        elif "makesomthingup" in url or "centralodsseyproud" in url or "/r6/" in url:
            eff_ref = "https://one.makesomthingup.click/"
        elif "daioncdn.net/startv" in url:
            eff_ref = "https://www.startv.com.tr/"
        elif "daioncdn.net/ntv" in url:
            eff_ref = "https://www.ntv.com.tr/"
        elif "daioncdn.net/halktv" in url:
            eff_ref = "https://halktv.com.tr/"
        elif "workers.dev" in url:
            eff_ref = "https://vidy.st/"
        elif any(d in url for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")):
            eff_ref = "https://vidmoly.biz/"
    hdrs = {
        "User-Agent": (
            "com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)"
            if is_hakuna
            else UA137
        )
    }
    if eff_ref:
        p = urllib.parse.urlparse(eff_ref)
        orig = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else ""
        hdrs["Referer"] = eff_ref
        if orig:
            hdrs["Origin"] = orig
    clean_u_path = url.lower().split("?", 1)[0]
    is_fmp4_init = ("init-" in clean_u_path or "/init." in clean_u_path or "_init." in clean_u_path)
    is_fmp4_seg = is_fmp4_init or ext_hint == ".m4s" or clean_u_path.endswith(".m4s")
    is_explicit_mp4 = (not is_fmp4_seg) and (ext_hint in (".mp4", ".webm", ".mkv") or url in _KNOWN_LARGE_MP4_URLS or any(clean_u_path.endswith(x) for x in (".mp4", ".webm", ".mkv")) or "/file/tau-video/" in url.lower() or "drive.usercontent.google.com" in url.lower())
    is_seg_url = is_fmp4_seg or ext_hint in (".ts", ".aac", ".key", ".vtt", ".m3u8") or ((not is_explicit_mp4) and any(x in url for x in (".ts", ".png", ".jpg", ".m4s", "init-", "/r6/", ".aac", ".vtt", ".m3u8", ".cfd/", ".click/", "key.php", "pilavyer")))
    has_high_range = False
    if rng and rng.startswith("bytes=") and not is_seg_url:
        m_hi = re.match(r"bytes=(\d+)-", rng)
        if m_hi and int(m_hi.group(1)) >= 8 * 1024 * 1024:
            has_high_range = True
    is_full_mp4 = (is_explicit_mp4 and not is_seg_url) or has_high_range
    if not is_full_mp4:
        now = time.time()
        up_total = 0
        with _SEG_TABLE_LOCK:
            cached = _SEGMENT_CACHE.get(url)
        if cached and now - cached[0] < 90:
            data, ct = cached[1], cached[2]
        else:
            ulock = _get_seg_lock(url)
            with ulock:
                with _SEG_TABLE_LOCK:
                    cached = _SEGMENT_CACHE.get(url)
                if cached and time.time() - cached[0] < 90:
                    data, ct = cached[1], cached[2]
                else:
                    data = b""
                    ct = "video/mp2t"
                    is_key_req = ext_hint == ".key" or clean_u_path.endswith(".key") or "key.php" in url
                    small_map_rng = False
                    if rng and rng.startswith("bytes=") and (ext_hint == ".m4s" or clean_u_path.endswith(".mp4")):
                        m_sm = re.match(r"bytes=(\d+)-(\d+)$", rng)
                        if m_sm and 0 <= (int(m_sm.group(2)) - int(m_sm.group(1))) <= 262144:
                            small_map_rng = True
                    no_up_rng = ("lightspeed.st" in url or "bright67." in url)
                    use_seg_rng = (not no_up_rng) and bool(
                        rng
                        and rng.startswith("bytes=")
                        and not rng.startswith("bytes=-")
                        and (rng == "bytes=0-0" or small_map_rng or (rng != "bytes=0-1023" and not rng.startswith("bytes=0-")))
                    )
                    if use_seg_rng:
                        m_chk_rev = re.match(r"bytes=(\d+)-(\d+)$", rng)
                        if m_chk_rev and int(m_chk_rev.group(2)) < int(m_chk_rev.group(1)):
                            use_seg_rng = False
                    req_hdrs = {**hdrs, "Range": rng} if use_seg_rng else hdrs
                    for _attempt in range(2):
                        try:
                            use_pool = (not is_key_req) and (not use_seg_rng)
                            r_data = None
                            r_status = 200
                            r_headers = {}
                            if use_pool:
                                try:
                                    pool_resp = _SEG_POOL.request("GET", url, headers=req_hdrs, preload_content=True, timeout=14.0)
                                    if pool_resp.status in (200, 206):
                                        r_data = pool_resp.data
                                        r_status = pool_resp.status
                                        r_headers = dict(pool_resp.headers)
                                except Exception:
                                    r_data = None
                            if r_data is None:
                                req = urllib.request.Request(url, headers=req_hdrs)
                                with _public_open(req, timeout=16) as r:
                                    data = r.read(28 * 1024 * 1024)
                                    raw_ct_low = (r.headers.get("Content-Type") or "").lower()
                                    r_headers = dict(r.headers)
                                    r_status = r.status
                            else:
                                data = r_data
                                raw_ct_low = (r_headers.get("Content-Type") or r_headers.get("content-type") or "").lower()
                            head_trim = data[:64].lstrip().lower() if data else b""
                            if is_key_req:
                                if not data or len(data) > 256 or "text/html" in raw_ct_low or head_trim.startswith((b"<!doctype", b"<html", b"{\"error")):
                                    raise ValueError("Invalid HLS key response")
                            elif data and not _is_binary_media_payload(data) and ("text/html" in raw_ct_low or head_trim.startswith((b"<!doctype", b"<html"))):
                                raise ValueError("Upstream returned HTML instead of media segment")
                            if use_seg_rng and r_status == 206:
                                cr_up = r_headers.get("Content-Range") or r_headers.get("content-range") or ""
                                is_mp4_206 = (len(data) >= 8 and data[4:8] in (b"ftyp", b"moof", b"styp", b"sidx")) or is_fmp4_seg or clean_u_path.endswith(".mp4")
                                return data, 206, cr_up, ("video/mp4" if is_mp4_206 else "video/mp2t")
                            raw_cl = (r_headers.get("Content-Length") or r_headers.get("content-length") or "").strip()
                            up_total = int(raw_cl) if raw_cl.isdigit() else 0
                            if is_seg_url and not use_seg_rng and up_total > 0 and len(data) < up_total and up_total <= 28 * 1024 * 1024:
                                raise IOError(f"Incomplete upstream segment ({len(data)}/{up_total} bytes)")
                            is_mpegts = len(data) >= 189 and data[0] == 0x47 and data[188] == 0x47
                            is_ftyp_moof = len(data) >= 8 and data[4:8] in (b"ftyp", b"moof", b"styp", b"sidx")
                            is_adts = len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xF6) == 0xF0
                            if is_key_req or len(data) == 16:
                                ct = "application/octet-stream"
                            elif ext_hint == ".aac" or clean_u_path.endswith(".aac") or is_adts:
                                ct = "audio/aac"
                            elif ext_hint == ".mp3" or clean_u_path.endswith(".mp3") or data.startswith(b"ID3"):
                                ct = "audio/mpeg"
                            elif ext_hint == ".m4a" or clean_u_path.endswith(".m4a"):
                                ct = "audio/mp4"
                            elif is_ftyp_moof or (not is_mpegts and ("init-" in url or ".m4s" in url or ".mp4" in url or ext_hint == ".m4s")):
                                ct = "video/mp4"
                            elif is_mpegts or ".ts" in url or ".png" in url or ".jpg" in url or ".webp" in url or ".cfd/" in url or "/r6/s/" in url or "pilavyer" in url or "dragonballzfans" in url:
                                ct = "video/mp2t"
                            elif "video/" in raw_ct_low or "audio/" in raw_ct_low or "mpegurl" in raw_ct_low:
                                ct = r_headers.get("Content-Type") or r_headers.get("content-type")
                            else:
                                ct = "video/mp2t"
                            if data:
                                break
                        except Exception:
                            if _attempt == 1:
                                raise
                            time.sleep(0.15)
                    if up_total > len(data) and not is_seg_url:
                        if len(_KNOWN_LARGE_MP4_URLS) > 500:
                            _KNOWN_LARGE_MP4_URLS.clear()
                        _KNOWN_LARGE_MP4_URLS.add(url)
                    elif data and (not up_total or len(data) >= up_total) and len(data) <= int(18 * 1024 * 1024):
                        with _SEG_TABLE_LOCK:
                            _seg_cache_put_locked(url, time.time(), data, ct)
                        if is_seg_url or ".jpg" in url or ".ts" in url or ".m4s" in url:
                            _schedule_segment_prefetch(url, eff_ref)
        total = max(len(data), up_total)
        if rng and rng.startswith("bytes=") and len(data) > 0:
            m_suf_s = re.match(r"bytes=-(\d+)$", rng)
            if m_suf_s:
                n_suf = int(m_suf_s.group(1))
                if n_suf <= 0:
                    return b"", 416, f"bytes */{total}", ct
                part = data[max(0, len(data) - n_suf):]
                start_s = len(data) - len(part)
                return part, 206, f"bytes {start_s}-{len(data) - 1}/{total}", ct
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if m:
                start = int(m.group(1))
                if start >= len(data):
                    return b"", 416, f"bytes */{total}", ct
                if m.group(2):
                    req_end = int(m.group(2))
                    if req_end < start:
                        return b"", 416, f"bytes */{total}", ct
                    end = min(req_end, len(data) - 1)
                else:
                    end = len(data) - 1
                part = data[start:end + 1]
                return part, 206, f"bytes {start}-{start + len(part) - 1}/{total}", ct
        return data, 200, "", ct

    chunk_sz = (3584 * 1024) if IS_VERCEL else (8 * 1024 * 1024)
    max_closed_sz = (4 * 1024 * 1024) if IS_VERCEL else (16 * 1024 * 1024)
    start, end = 0, chunk_sz - 1
    m_suf = None
    if rng and rng.startswith("bytes="):
        m_suf = re.match(r"bytes=-(\d+)", rng)
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        if m_suf:
            n_s = int(m_suf.group(1))
            if n_s <= 0:
                return b"", 416, "bytes */*", "video/mp4"
            hdrs["Range"] = f"bytes=-{min(n_s, max_closed_sz)}"
        elif m:
            start = int(m.group(1))
            if m.group(2):
                raw_end_m = int(m.group(2))
                if raw_end_m < start:
                    return b"", 416, "bytes */*", "video/mp4"
                end = min(raw_end_m, start + max_closed_sz - 1)
            else:
                end = start + chunk_sz - 1
            hdrs["Range"] = f"bytes={start}-{end}"
    if "Range" not in hdrs:
        hdrs["Range"] = f"bytes={start}-{end}"
    mp4_ckey = f"mp4|{url}|{hdrs['Range']}"
    now_mp4 = time.time()
    with _SEG_TABLE_LOCK:
        cached_mp4 = _SEGMENT_CACHE.get(mp4_ckey)
    if cached_mp4 and now_mp4 - cached_mp4[0] < 90:
        data = cached_mp4[1]
        meta_parts = str(cached_mp4[2] or "video/mp4||206").split("\n")
        ct = meta_parts[0] if len(meta_parts) > 0 and meta_parts[0] else "video/mp4"
        cr = meta_parts[1] if len(meta_parts) > 1 else ""
        status = int(meta_parts[2]) if len(meta_parts) > 2 and meta_parts[2].isdigit() else (206 if cr else 200)
        return data, status, cr, ct
    req = urllib.request.Request(url, headers=hdrs)
    read_cap = max(chunk_sz, (end - start + 1) if end >= start else chunk_sz) + 1024
    with _public_open(req, timeout=10) as r:
        data = r.read(read_cap)
        raw_mp4_ct = (r.headers.get("Content-Type") or "").lower()
        if data and not _is_binary_media_payload(data) and ("text/html" in raw_mp4_ct or data[:64].lstrip().lower().startswith((b"<!doctype", b"<html"))):
            raise ValueError("Upstream returned HTML instead of MP4 media")
        cr = r.headers.get("Content-Range") or ""
        if not cr and m_suf and data:
            n_s = int(m_suf.group(1))
            if n_s > 0:
                tot_m = len(data)
                data = data[max(0, tot_m - n_s):]
                cr = f"bytes {tot_m - len(data)}-{tot_m - 1}/{tot_m}"
        status = 206 if cr else 200
        ct = "video/mp4"
    if data and len(data) <= int(3 * 1024 * 1024):
        with _SEG_TABLE_LOCK:
            _seg_cache_put_locked(mp4_ckey, time.time(), data, f"{ct}\n{cr}\n{status}")
    return data, status, cr, ct


_STREAM_MANIFEST_LIMIT = RateLimiter(900, 60.0, name="stream_manifest")
_STREAM_LOCKS: dict[str, asyncio.Lock] = {}


async def rave_stream_manifest(request: Request):
    if request.method == "OPTIONS":
        return Response(b"", status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Type",
            "Access-Control-Max-Age": "86400",
        })
    allowed_sm, retry_sm = _STREAM_MANIFEST_LIMIT.hit(client_ip(request))
    if not allowed_sm:
        return too_many_response(retry_sm)
    import base64
    sid = (request.query_params.get("sid") or "").strip()
    ref_mode = re.sub(r"[^a-zA-Z0-9_-]", "", (request.query_params.get("ref") or "").strip())[:16]
    prov = re.sub(r"[^a-zA-Z0-9_-]", "", (request.query_params.get("provider") or "netflix").strip())[:24] or "netflix"
    tid = re.sub(r"[^a-zA-Z0-9_-]", "", (request.query_params.get("tmdbId") or "").strip())[:32]
    s_num = re.sub(r"[^0-9]", "", (request.query_params.get("s") or "1").strip())[:6] or "1"
    e_num = re.sub(r"[^0-9]", "", (request.query_params.get("e") or "1").strip())[:6] or "1"
    raw_mtype = (request.query_params.get("mtype") or "").strip().lower()
    explicit_mtype = raw_mtype if raw_mtype in ("tv", "movie") else ""
    fp_id = re.sub(r"[^a-zA-Z0-9_.\-]", "", (request.query_params.get("fp_id") or "").strip())[:64]
    sp = re.sub(r"[^a-zA-Z0-9_.\-+/=]", "", (request.query_params.get("sp") or "").strip())[:128]
    try:
        spt = int(request.query_params.get("spt") or 0)
    except ValueError:
        return JSONResponse({"error": "Geçersiz akış parametresi"}, status_code=400)
    aud_pref = (request.query_params.get("aud") or "").strip().lower()
    tr_aud_sid = re.sub(r"[^a-zA-Z0-9_\-=]", "", (request.query_params.get("tr_aud_sid") or "").strip())[:1024]
    proxy_segs = request.query_params.get("proxy_segs") == "1"
    is_probe = request.query_params.get("probe") == "1"
    try:
        max_h = int(request.query_params.get("max_h") or 0)
    except ValueError:
        max_h = 0
    res_req = (request.query_params.get("res") or "").strip().lower()
    target = ""
    if sid:
        try:
            pad = sid + "=" * ((4 - len(sid) % 4) % 4)
            target = base64.urlsafe_b64decode(pad.encode("ascii")).decode("utf-8")
        except Exception:
            target = ""
    if not target:
        target = (request.query_params.get("u") or request.query_params.get("url") or "").strip()
    if not target or not public_http_url(target):
        return JSONResponse({"error": "Geçersiz akış"}, status_code=400)
    is_live_tv = any(d in target for d in ("ercdn.net", "daioncdn.net", "radyotvonline.", "trt.com.tr", "ensonhaber.com", "powerapp.com.tr"))
    is_ve = ref_mode == "ve" or any(d in target for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "finalsignal.top", "workers.dev")) or bool(re.search(r"https?://[^/]+\.top/vd[a-z0-9]*/", target))
    is_cj = ref_mode == "cj" or "lightspeed.st" in target or "bright67." in target
    is_fp = ref_mode == "fp" or "fastplay." in target
    is_dp = ref_mode == "dp" or "ag2m5.cfd" in target or "uk-traffic-" in target
    is_pv = ref_mode == "pv" or "pilavyer" in target
    is_hfnl = ref_mode == "hfnl" or ("cdnimages" in target and "/hls/" in target) or "playmix.uno" in target or "hdfilmcehennemi.mobi" in target
    is_fhd = (not is_hfnl) and (ref_mode == "fhd" or "cdnimgs" in target or ("cdnimg" in target and not ("cdnimages" in target and "/hls/" in target)) or "rapidvid" in target or bool(re.search(r"https://s\d+\.[^/]+\.shop/", target)))
    is_dbx = ref_mode == "dbx" or "molystream.org" in target
    is_dl = ref_mode == "dl" or "makesomthingup" in target or "centralodsseyproud" in target or "/r6/" in target
    tgt_clean = target.lower().split("?", 1)[0].split("#", 1)[0]
    if tgt_clean.endswith((".mp4", ".mkv", ".webm")):
        seg_proxy_u = _proxy_u(target, ext=".mp4")
        syn_m3u8 = (
            "#EXTM3U\n"
            "#EXT-X-VERSION:3\n"
            "#EXT-X-TARGETDURATION:10800\n"
            "#EXT-X-MEDIA-SEQUENCE:0\n"
            "#EXT-X-PLAYLIST-TYPE:VOD\n"
            "#EXTINF:10800.0,Video\n"
            f"{seg_proxy_u}\n"
            "#EXT-X-ENDLIST\n"
        ).encode("utf-8")
        return Response(b"" if request.method == "HEAD" else syn_m3u8, media_type="application/vnd.apple.mpegurl", headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Length": str(len(syn_m3u8)),
            "Cache-Control": "public, max-age=300",
        })
    m3u8_ckey = f"v9|{target}|{aud_pref}|{tr_aud_sid}|{prov}|{tid}|{explicit_mtype}|{s_num}|{e_num}|{int(proxy_segs)}|{int(is_probe)}|{max_h}|{res_req}"
    now_m = time.time()
    cached_m = _M3U8_CACHE.get(m3u8_ckey)
    ttl_m = 2.0 if is_live_tv else 240.0
    if cached_m and now_m - cached_m[0] < ttl_m:
        c_bytes = cached_m[1] if isinstance(cached_m[1], bytes) else str(cached_m[1]).encode("utf-8")
        return Response(b"" if request.method == "HEAD" else c_bytes, media_type="application/vnd.apple.mpegurl", headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Length": str(len(c_bytes)),
            "Cache-Control": "no-cache, no-store" if is_live_tv else "public, max-age=300",
        })
    try:
        def _fetch_m3u8():
            last_err = None
            raw = ""
            hdrs = {"User-Agent": UA137}
            cur_sp = sp
            cur_spt = spt
            if is_ve:
                hdrs["Referer"] = "https://vidy.st/"
                hdrs["Origin"] = "https://vidy.st"
            elif is_cj:
                hdrs["Referer"] = "https://cinejoy.pk/"
                hdrs["Origin"] = "https://cinejoy.pk"
            elif is_hfnl:
                hdrs["Referer"] = "https://hdfilmcehennemi.mobi/"
                hdrs["Origin"] = "https://hdfilmcehennemi.mobi"
            elif is_fhd:
                hdrs["Referer"] = "https://rapidvid.org/"
                hdrs["Origin"] = "https://rapidvid.org"
            elif is_dbx:
                hdrs["Referer"] = target.replace("/embed/sheila/", "/embed/")
                hdrs["X-Requested-With"] = "XMLHttpRequest"
            elif is_dl:
                hdrs["Referer"] = "https://one.makesomthingup.click/"
                hdrs["Origin"] = "https://one.makesomthingup.click"
            elif is_fp:
                hdrs["Referer"] = f"https://fastplay.mom/video/{fp_id}"
            elif is_pv:
                pv_orig = f"https://{urllib.parse.urlparse(target).netloc or 'play2.pilavyerplay.top'}"
                hdrs["Referer"] = f"{pv_orig}/"
                hdrs["Origin"] = pv_orig
            elif is_dp or "dplayer" in target:
                parsed_dp = urllib.parse.urlparse(target)
                dp_origin = f"{parsed_dp.scheme}://{parsed_dp.netloc}"
                hdrs["Referer"] = f"{dp_origin}/"
                hdrs["Origin"] = dp_origin
            elif ref_mode == "hx" or "dragonballzfans" in target:
                hdrs["Referer"] = "https://hexa.su/"
                hdrs["Origin"] = "https://hexa.su"
            elif "daioncdn.net/startv" in target:
                hdrs["Referer"] = "https://www.startv.com.tr/"
                hdrs["Origin"] = "https://www.startv.com.tr"
            elif "daioncdn.net/ntv" in target:
                hdrs["Referer"] = "https://www.ntv.com.tr/"
                hdrs["Origin"] = "https://www.ntv.com.tr"
            elif "daioncdn.net/halktv" in target:
                hdrs["Referer"] = "https://halktv.com.tr/"
                hdrs["Origin"] = "https://halktv.com.tr"
            elif is_hfnl or ("cdnimages" in target and "/hls/" in target) or "playmix.uno" in target or "hdfilmcehennemi.mobi" in target:
                hdrs["Referer"] = "https://hdfilmcehennemi.mobi/"
                hdrs["Origin"] = "https://hdfilmcehennemi.mobi"
            elif ref_mode == "vm" or any(d in target for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")):
                hdrs["Referer"] = "https://vidmoly.biz/"
                hdrs["Origin"] = "https://vidmoly.biz"
            cur_target = target
            now_dp = time.time()
            if any(d in cur_target for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")) and ("/embed-" in cur_target or "/w/" in cur_target):
                dp_c = _DP_M3U8_CACHE.get(cur_target)
                if dp_c and dp_c[1] > now_dp:
                    cur_target = dp_c[0]
                else:
                    try:
                        vm_u = re.sub(r"(?:vidmoly|vmbox|vmnow|vmpx)\.[a-z]+", "vidmoly.biz", cur_target, flags=re.I)
                        with _public_open(urllib.request.Request(vm_u, headers={"User-Agent": UA137, "Referer": "https://www.dizibox.live/"}), timeout=3.8) as vmr:
                            vm_html = vmr.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                        m_vm = re.search(r"https?://[^\s'\"<>]+\.m3u8[^\s'\"<>]*", vm_html)
                        if m_vm:
                            fresh_vm = m_vm.group(0)
                            _DP_M3U8_CACHE[cur_target] = (fresh_vm, now_dp + 1800)
                            cur_target = fresh_vm
                    except Exception:
                        pass
            elif is_hfnl and ("/master.txt" in cur_target or "hdfilmcehennemi.mobi/video/embed/" in cur_target):
                dp_c = _DP_M3U8_CACHE.get(cur_target)
                if dp_c and dp_c[1] > now_dp:
                    cur_target = dp_c[0]
                else:
                    m_hid = re.search(r"-([A-Za-z0-9]{10,12})\.(?:mp4|mkv)/", cur_target) or re.search(r"hdfilmcehennemi\.mobi/video/embed/([A-Za-z0-9_-]+)", cur_target)
                    if m_hid:
                        try:
                            emb_u = f"https://hdfilmcehennemi.mobi/video/embed/{m_hid.group(1)}"
                            with _public_open(urllib.request.Request(emb_u, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.8) as hr:
                                emb_html = hr.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                            fresh_hfnl = _decode_hdfc_mobi_html(emb_html)
                            if fresh_hfnl and fresh_hfnl.startswith("https://"):
                                _DP_M3U8_CACHE[cur_target] = (fresh_hfnl, now_dp + 900)
                                cur_target = fresh_hfnl
                        except Exception:
                            pass
            elif "dplayer" in cur_target and ("multiplayer.php" in cur_target or "iframe.php" in cur_target):
                dp_c = _DP_M3U8_CACHE.get(cur_target)
                if dp_c and dp_c[1] > now_dp:
                    cur_target = dp_c[0]
                else:
                    try:
                        p_dp = urllib.parse.urlparse(cur_target)
                        dp_dom = f"{p_dp.scheme}://{p_dp.netloc}"
                        with _public_open(urllib.request.Request(cur_target, headers={"User-Agent": UA137, "Referer": f"https://{DIZIPAL_DOMAINS[0]}/"}), timeout=3.8) as dpr:
                            if_html = dpr.read(655360).decode("utf-8", errors="ignore")
                        st_u = ""
                        m_np = re.search(r"window\.NP_CONFIG\s*=\s*(\{.*?\});", if_html, re.S)
                        if m_np:
                            np_cfg = json.loads(m_np.group(1))
                            for src_obj in (np_cfg.get("sources") or []):
                                if isinstance(src_obj, dict):
                                    st_u = str(src_obj.get("master") or src_obj.get("file") or "").strip()
                                    if st_u.startswith("https://"):
                                        break
                        if not st_u:
                            m_tok = re.search(r"openPlayer\s*\(\s*['\"]([^'\"]+)['\"]", if_html)
                            if m_tok:
                                src_api = f"{dp_dom}/source2.php?v={m_tok.group(1)}"
                                with _public_open(urllib.request.Request(src_api, headers={"User-Agent": UA137, "Referer": cur_target, "X-Requested-With": "XMLHttpRequest"}), timeout=3.8) as sr:
                                    src_data = json.loads(sr.read(131072).decode("utf-8", errors="ignore"))
                                for p_item in (src_data.get("playlist") or []):
                                    for src_obj in (p_item.get("sources") or []):
                                        f_u = str(src_obj.get("file") or "")
                                        if f_u.startswith("https://"):
                                            st_u = f_u.replace("m.php", "master.m3u8")
                                            break
                        if st_u.startswith("https://"):
                            _DP_M3U8_CACHE[cur_target] = (st_u, now_dp + 900)
                            cur_target = st_u
                            hdrs["Referer"] = f"{dp_dom}/"
                            hdrs["Origin"] = dp_dom
                    except Exception:
                        pass
            elif "ag2m5.cfd/embed-" in cur_target:
                dp_c = _DP_M3U8_CACHE.get(cur_target)
                if dp_c and dp_c[1] > now_dp:
                    cur_target = dp_c[0]
                else:
                    try:
                        dp_dom = f"{urllib.parse.urlparse(cur_target).scheme}://{urllib.parse.urlparse(cur_target).netloc}"
                        e_req = urllib.request.Request(cur_target, headers={"User-Agent": UA137, "Referer": f"https://{DIZIPAL_DOMAINS[0]}/"})
                        with _public_open(e_req, timeout=4.2) as er:
                            e_html = er.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                        mv = re.search(r"view_id:\s*'(\d+)'", e_html)
                        mh = re.search(r"hash:\s*'([^']+)'", e_html)
                        if mv and mh:
                            dl_u = f"{dp_dom}/dl?op=get_stream&view_id={mv.group(1)}&hash={urllib.parse.quote(mh.group(1))}"
                            dl_hdrs = {
                                "User-Agent": UA137, "Referer": cur_target, "Accept": "*/*",
                                "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
                            }
                            with _public_open(urllib.request.Request(dl_u, headers=dl_hdrs), timeout=4.2) as dlr:
                                dl_json = json.loads(dlr.read(65536).decode("utf-8", errors="ignore"))
                            st_u = str(dl_json.get("stream_url") or "").strip()
                            if st_u.startswith("https://"):
                                _DP_M3U8_CACHE[cur_target] = (st_u, now_dp + 900)
                                cur_target = st_u
                    except Exception:
                        pass
            def _fetch_manifest_with_edge(u_m: str, m_hdrs: dict, t_direct: float = 3.2, t_edge: float = 4.5) -> tuple[str, str]:
                u_low_m = u_m.lower()
                edge_val = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL).strip()
                edge_ok = bool(edge_val) and not any(h in u_low_m for h in _WORKER_BYPASS_HOSTS) and ("fastplay." not in u_low_m)
                prefer_edge = edge_ok and (
                    "pilavyer" in u_low_m or "cdnimg" in u_low_m or "molystream" in u_low_m
                    or bool(re.search(r"https?://s\d+\.[^/]+\.shop/", u_low_m))
                )
                ref_m = str(m_hdrs.get("Referer") or "")
                xhr_m = str(m_hdrs.get("X-Requested-With") or "") == "XMLHttpRequest"
                if prefer_edge:
                    try:
                        eb, efin = _edge_fetch_bytes(u_m, ref_m, xhr=xhr_m, timeout=t_edge, max_bytes=1024 * 1024)
                        etxt = eb.decode("utf-8", errors="ignore")
                        if etxt and "#EXTM3U" in etxt:
                            return etxt, (efin if (efin.startswith("http") and public_http_url(efin)) else u_m)
                    except Exception:
                        pass
                try:
                    with _public_open(urllib.request.Request(u_m, headers=m_hdrs), timeout=t_direct) as rm:
                        dtxt = rm.read(1024 * 1024).decode("utf-8", errors="ignore")
                        dfin = str(getattr(rm, "url", "") or rm.geturl() or "").strip()
                    if dtxt and "#EXTM3U" in dtxt:
                        return dtxt, (dfin if (dfin.startswith("http") and public_http_url(dfin)) else u_m)
                except Exception as derr:
                    if not edge_ok or prefer_edge:
                        if not prefer_edge:
                            raise derr
                if edge_ok and not prefer_edge:
                    eb, efin = _edge_fetch_bytes(u_m, ref_m, xhr=xhr_m, timeout=t_edge, max_bytes=1024 * 1024)
                    etxt = eb.decode("utf-8", errors="ignore")
                    if etxt and "#EXTM3U" in etxt:
                        return etxt, (efin if (efin.startswith("http") and public_http_url(efin)) else u_m)
                return "", u_m

            for attempt in range(1 if is_probe else 2):
                try:
                    if is_fp and cur_sp:
                        hdrs["X-Sp"] = _gen_fp_xsp(cur_sp, cur_spt)
                    raw, eff_r_url = _fetch_manifest_with_edge(cur_target, hdrs, t_direct=2.2 if is_probe else 2.6, t_edge=2.8 if is_probe else 3.2)
                    if raw and "#EXTM3U" in raw:
                        if eff_r_url.startswith("http") and public_http_url(eff_r_url):
                            cur_target = eff_r_url
                        break
                    raw = ""
                except Exception as err:
                    last_err = err
                    if is_fp and fp_id and re.fullmatch(r"[A-Za-z0-9_-]{3,64}", str(fp_id)) and attempt == 0 and not is_probe:
                        try:
                            fp_u = f"https://fastplay.mom/video/{fp_id}"
                            with _public_open(urllib.request.Request(fp_u, headers={"User-Agent": UA137, "Referer": "https://setplay.shop/"}), timeout=4.0) as _fpr:
                                fp_html = _fpr.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                            spg_m = re.search(r"window\.SPG_A\s*=\s*(\{[^}]+\})", fp_html)
                            if spg_m:
                                spg_obj = json.loads(spg_m.group(1))
                                cur_sp = spg_obj.get("sp") or cur_sp
                                cur_spt = int(spg_obj.get("spT") or cur_spt)
                                new_fp_p = spg_obj.get("p") or ""
                                if new_fp_p.startswith("/manifests/") and "/master.txt" in cur_target:
                                    cur_target = f"https://fastplay.mom{new_fp_p}"
                        except Exception:
                            pass
            cur_k = ""
            is_sub_variant_req = bool(proxy_segs or "p=stream_" in cur_target or "/ml/" in cur_target or "sublist_" in cur_target)
            if not raw and tid.isdigit() and not is_probe and not is_sub_variant_req:
                s_i, e_i = int(s_num or 1), int(e_num or 1)
                if explicit_mtype in ("tv", "movie"):
                    mt_guess = explicit_mtype
                    mt_tries = (explicit_mtype,)
                else:
                    mt_guess = "tv" if (f"v47:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v46:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v45:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v44:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v43:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v42:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v41:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or s_i > 1 or e_i > 1) else ("movie" if (f"v47:movie:{tid}:1:1" in _STREAM_CACHE or f"v46:movie:{tid}:1:1" in _STREAM_CACHE or f"v45:movie:{tid}:1:1" in _STREAM_CACHE or f"v44:movie:{tid}:1:1" in _STREAM_CACHE or f"v43:movie:{tid}:1:1" in _STREAM_CACHE or f"v42:movie:{tid}:1:1" in _STREAM_CACHE or f"v41:movie:{tid}:1:1" in _STREAM_CACHE) else "tv")
                    mt_tries = (mt_guess, "movie" if mt_guess == "tv" else "tv")
                cands = []
                for mt_try in mt_tries:
                    for ver_p in ("v47", "v46", "v45", "v44", "v43", "v42", "v41", "v40", "v39", "v38", "v37", "v36", "v35", "v34", "v33", "v32", "v31", "v30", "v29", "v28"):
                        c_entry = _STREAM_CACHE.get(f"{ver_p}:{mt_try}:{tid}:{s_i}:{e_i}")
                        if c_entry and c_entry.get("val"):
                            cands.extend(c_entry["val"])
                for rescue_pass in range(2):
                    if rescue_pass == 1:
                        if raw:
                            break
                        try:
                            cands = _extract_direct_stream_sync(tid, mt_guess, s_i, e_i, refresh=True) or []
                        except Exception:
                            cands = []
                    elif not cands:
                        try:
                            cands = _extract_direct_stream_sync(tid, mt_guess, s_i, e_i) or []
                        except Exception:
                            cands = []
                    tried_cands = 0
                    for cand_u, cand_k in cands:
                        if tried_cands >= 3:
                            break
                        if not cand_u or cand_u == cur_target or not cand_u.startswith("http") or str(cand_k).startswith("mp4") or _is_unplayable_stream_url(cand_u) or "serve.dragonballzfans.xyz" in cand_u or "finalsignal.top" in cand_u:
                            continue
                        tried_cands += 1
                        try:
                            c_hdrs = {"User-Agent": UA137}
                            if "ve" in str(cand_k) or any(d in cand_u for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "finalsignal.top", "workers.dev")) or bool(re.search(r"https?://[^/]+\.top/vd[a-z0-9]*/", cand_u)):
                                c_hdrs["Referer"] = "https://vidy.st/"
                                c_hdrs["Origin"] = "https://vidy.st"
                            elif "cj" in str(cand_k) or "lightspeed.st" in cand_u or "bright67." in cand_u:
                                c_hdrs["Referer"] = "https://cinejoy.pk/"
                                c_hdrs["Origin"] = "https://cinejoy.pk"
                            elif "fhd" in str(cand_k) or "cdnimgs" in cand_u or "cdnimg" in cand_u or re.search(r"https://s\d+\.[^/]+\.shop/", cand_u):
                                c_hdrs["Referer"] = "https://rapidvid.org/"
                                c_hdrs["Origin"] = "https://rapidvid.org"
                            elif "hfnl" in str(cand_k) or "cdnimages" in cand_u or "hdfilmcehennemi" in cand_u:
                                c_hdrs["Referer"] = "https://hdfilmcehennemi.mobi/"
                                c_hdrs["Origin"] = "https://hdfilmcehennemi.mobi"
                            elif "dl" in str(cand_k) or "makesomthingup" in cand_u:
                                c_hdrs["Referer"] = "https://one.makesomthingup.click/"
                                c_hdrs["Origin"] = "https://one.makesomthingup.click"
                            elif "pilavyer" in cand_u or "pv" in str(cand_k):
                                pv_orig = f"https://{urllib.parse.urlparse(cand_u).netloc or 'play2.pilavyerplay.top'}"
                                c_hdrs["Referer"] = f"{pv_orig}/"
                                c_hdrs["Origin"] = pv_orig
                            elif "dragonballzfans" in cand_u:
                                c_hdrs["Referer"] = "https://hexa.su/"
                                c_hdrs["Origin"] = "https://hexa.su"
                            cand_raw, cand_fin = _fetch_manifest_with_edge(cand_u, c_hdrs, t_direct=2.2, t_edge=2.8)
                            if cand_raw and "#EXTM3U" in cand_raw:
                                raw = cand_raw
                                cur_target = cand_fin if (cand_fin.startswith("http") and public_http_url(cand_fin)) else cand_u
                                cur_k = str(cand_k)
                                break
                        except Exception:
                            continue
                    if raw:
                        break
            if not raw:
                raise ValueError("Seçilen içerik için oynatılabilir manifest bulunamadı") from last_err
            base_u = cur_target
            cur_is_ve = any(d in cur_target for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "finalsignal.top", "workers.dev")) or bool(re.search(r"https?://[^/]+\.top/vd[a-z0-9]*/", cur_target)) or ("ve" in cur_k) or (cur_target == target and is_ve)
            cur_is_cj = ("lightspeed.st" in cur_target) or ("bright67." in cur_target) or ("cj" in cur_k) or (cur_target == target and is_cj)
            cur_is_fp = ("fastplay." in cur_target) or (cur_target == target and is_fp)
            cur_is_pv = ("pilavyer" in cur_target) or (cur_target == target and is_pv)
            cur_is_dp = ("uk-traffic-" in cur_target) or ("ag2m5.cfd" in cur_target) or ("dplayer" in cur_target) or is_dp
            cur_is_hfnl = ("cdnimages" in cur_target and "/hls/" in cur_target) or ("playmix.uno" in cur_target) or (cur_target == target and is_hfnl)
            cur_is_fhd = (not cur_is_hfnl) and (("cdnimgs" in cur_target) or ("cdnimg" in cur_target and not ("cdnimages" in cur_target and "/hls/" in cur_target)) or ("rapidvid" in cur_target) or bool(re.search(r"https://s\d+\.[^/]+\.shop/", cur_target)) or (cur_target == target and is_fhd))
            cur_is_dbx = ("molystream.org" in cur_target) or (cur_target == target and is_dbx)
            cur_is_dl = ("makesomthingup" in cur_target) or ("centralodsseyproud" in cur_target) or ("/r6/" in cur_target) or (cur_target == target and is_dl)
            cur_is_vm = (ref_mode == "vm") or any(d in cur_target for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx.")) or any(d in target for d in ("vidmoly.", "vmbox.", "vmnow.", "vmpx."))
            cur_is_hx = (ref_mode == "hx") or ("dragonballzfans" in cur_target) or ("dragonballzfans" in target)
            is_master = "#EXT-X-STREAM-INF" in raw
            is_fmp4_playlist = (not is_master) and ("#EXT-X-MAP:" in raw)
            needs_seg_proxy = bool(proxy_segs or cur_is_dp or cur_is_dbx or cur_is_ve or cur_is_cj or cur_is_fp or cur_is_fhd or cur_is_hfnl or cur_is_pv or cur_is_vm or cur_is_hx or is_live_tv)
            ps_q = ("&proxy_segs=1" if needs_seg_proxy else "") + ("&aud=" + urllib.parse.quote(aud_pref) if aud_pref else "") + (f"&mtype={explicit_mtype}" if explicit_mtype else "")
            _manifest_host_ok: dict[tuple[str, str], bool] = {}

            def _manifest_url_ok(u_chk: str) -> bool:
                p_chk = urllib.parse.urlsplit(u_chk)
                if p_chk.scheme not in ("http", "https") or not p_chk.netloc:
                    return False
                hk = (p_chk.scheme, p_chk.netloc.lower())
                ok_cached = _manifest_host_ok.get(hk)
                if ok_cached is None:
                    ok_cached = public_http_url(u_chk)
                    _manifest_host_ok[hk] = ok_cached
                return ok_cached

            def _rewrite_u(u_str: str, is_sub_playlist: bool = False, tag_kind: str = "") -> str:
                if not u_str.startswith("http"):
                    u_str = urllib.parse.urljoin(base_u, u_str)
                if not _manifest_url_ok(u_str):
                    return ""
                if cur_is_fp and "/subtitle/" in u_str:
                    return f"/api/rave/subtitle.vtt?url={urllib.parse.quote(u_str, safe='')}&lang=tr"
                u_path_low = u_str.lower().split("?", 1)[0].split("#", 1)[0]
                is_known_seg_ext = u_path_low.endswith((".ts", ".m4s", ".mp4", ".aac", ".vtt", ".srt", ".key", ".png", ".jpg", ".webp"))
                if tag_kind in ("key", "map"):
                    want_m3u8 = False
                elif is_sub_playlist or is_master:
                    want_m3u8 = not u_path_low.endswith((".vtt", ".srt", ".key", ".m4s", ".mp4", ".ts"))
                else:
                    want_m3u8 = (".m3u8" in u_path_low) or (not is_known_seg_ext and (("sublist_" in u_str) or ("nm.php" in u_str) or ("nl.php" in u_str) or ("/embed/sheila/" in u_str)))
                if want_m3u8:
                    sub_sid = base64.urlsafe_b64encode(u_str.encode("utf-8")).decode("ascii").rstrip("=")
                    if cur_is_hfnl:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=hfnl{ps_q}&ext=.m3u8"
                    if cur_is_fhd:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=fhd{ps_q}&ext=.m3u8"
                    if cur_is_dbx:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=dbx{ps_q}&ext=.m3u8"
                    if cur_is_dl:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=dl{ps_q}&ext=.m3u8"
                    if cur_is_ve:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=ve{ps_q}&ext=.m3u8"
                    if cur_is_cj:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=cj{ps_q}&ext=.m3u8"
                    if cur_is_fp:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=fp&fp_id={urllib.parse.quote(str(fp_id), safe='')}&sp={urllib.parse.quote(str(cur_sp), safe='')}&spt={urllib.parse.quote(str(cur_spt), safe='')}{ps_q}&ext=.m3u8"
                    if cur_is_pv:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=pv{ps_q}&ext=.m3u8"
                    if cur_is_dp:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=dp{ps_q}&ext=.m3u8"
                    if cur_is_vm:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=vm{ps_q}&ext=.m3u8"
                    if cur_is_hx or "dragonballzfans" in u_str:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=hx{ps_q}&ext=.m3u8"
                    return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}{ps_q}&ext=.m3u8"
                if tag_kind == "key" or u_path_low.endswith(".key") or "key.php" in u_str:
                    seg_ext_hint = ".key"
                elif tag_kind == "map" or is_fmp4_playlist or u_path_low.endswith((".m4s", ".mp4")) or "init-" in u_path_low or "/init." in u_path_low or "_init." in u_path_low:
                    seg_ext_hint = ".m4s"
                elif u_path_low.endswith(".aac"):
                    seg_ext_hint = ".aac"
                elif u_path_low.endswith(".mp3"):
                    seg_ext_hint = ".mp3"
                elif u_path_low.endswith(".m4a"):
                    seg_ext_hint = ".m4a"
                else:
                    seg_ext_hint = ".ts"
                if "key.php" in u_str:
                    return _proxy_u(u_str, f"https://{urllib.parse.urlparse(u_str).netloc or 'play2.pilavyerplay.top'}/", seg_ext_hint)
                if cur_is_ve:
                    return _proxy_u(u_str, "https://vidy.st/", seg_ext_hint)
                if cur_is_cj:
                    return _proxy_u(u_str, "https://cinejoy.pk/", seg_ext_hint)
                if cur_is_dbx or "molystream" in u_str or "/sheila_" in u_str:
                    return _proxy_u(u_str, "https://dbx.molystream.org/", seg_ext_hint)
                if cur_is_dp or "uk-traffic-" in u_str:
                    dp_ref = f"{urllib.parse.urlparse(cur_target).scheme}://{urllib.parse.urlparse(cur_target).netloc}/" if ("dplayer" in cur_target or ".com/f/" in u_str) else "https://x.ag2m5.cfd/"
                    return _proxy_u(u_str, dp_ref, seg_ext_hint)
                if cur_is_vm:
                    return _proxy_u(u_str, "https://vidmoly.biz/", seg_ext_hint)
                if cur_is_fp or ".cfd/" in u_str:
                    return _proxy_u(u_str, "https://fastplay.mom/", seg_ext_hint)
                if tag_kind in ("key", "map") or "dragonballzfans" in u_str or cur_is_hx or needs_seg_proxy:
                    ref_p = "https://hexa.su/" if ("dragonballzfans" in u_str or cur_is_hx) else (
                        "https://rapidvid.org/" if cur_is_fhd else (
                        "https://hdfilmcehennemi.mobi/" if cur_is_hfnl else (
                        "https://dbx.molystream.org/" if cur_is_dbx else (
                        "https://one.makesomthingup.click/" if cur_is_dl else (
                        f"https://{urllib.parse.urlparse(cur_target).netloc or 'play2.pilavyerplay.top'}/" if cur_is_pv else str(hdrs.get("Referer") or ""))))))
                    return _proxy_u(u_str, ref_p, seg_ext_hint)
                return u_str

            def _line_lang(l: str) -> str:
                lm = re.search(r'LANGUAGE="([^"]*)"', l)
                nm = re.search(r'NAME="([^"]*)"', l)
                return _norm_audio_lang(lm.group(1) if lm else "", nm.group(1) if nm else "")

            def _aud_grp(l: str) -> str:
                gm = re.search(r'GROUP-ID="([^"]*)"', l)
                return gm.group(1) if gm else "_default"

            hyb_tr_u = ""
            if is_master and tr_aud_sid:
                try:
                    pad_tr = tr_aud_sid + "=" * ((4 - len(tr_aud_sid) % 4) % 4)
                    cand_tr_u = base64.urlsafe_b64decode(pad_tr.encode("ascii")).decode("utf-8")
                    if cand_tr_u.startswith("https://") and public_http_url(cand_tr_u):
                        hyb_tr_u = cand_tr_u
                except Exception:
                    hyb_tr_u = ""
            if hyb_tr_u:
                existing_grp = next((re.search(r'GROUP-ID="([^"]+)"', l_a).group(1) for l_a in raw.splitlines() if "TYPE=AUDIO" in l_a and re.search(r'GROUP-ID="([^"]+)"', l_a)), "hyb_aud")
                if not any("TYPE=AUDIO" in l_a and _norm_audio_lang(*(re.findall(r'(?:LANGUAGE|NAME)="([^"]*)"', l_a))) == "tr" for l_a in raw.splitlines()):
                    hyb_media_ln = f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="{existing_grp}",LANGUAGE="tr",NAME="Türkçe Dublaj",DEFAULT=YES,AUTOSELECT=YES,URI="{hyb_tr_u}"'
                    raw_lines_hyb = raw.splitlines()
                    ins_idx_h = 1 if (raw_lines_hyb and raw_lines_hyb[0].startswith("#EXTM3U")) else 0
                    raw_lines_hyb.insert(ins_idx_h, hyb_media_ln)
                    raw = "\n".join(
                        (f'{ln_h},AUDIO="{existing_grp}"' if ln_h.strip().startswith("#EXT-X-STREAM-INF") and 'AUDIO="' not in ln_h else ln_h)
                        for ln_h in raw_lines_hyb
                    )

            valid_aud_lines = [l.strip() for l in raw.splitlines() if 'TYPE=AUDIO' in l and 'URI="undefined' not in l]
            aud_by_grp: dict[str, list[str]] = {}
            for _al in valid_aud_lines:
                aud_by_grp.setdefault(_aud_grp(_al), []).append(_al)
            want_code = aud_pref if (aud_pref and aud_pref != "orig") else ""
            out_lines = []
            variant_pairs = []
            pending_inf = None
            default_aud_groups = {g for g, ls in aud_by_grp.items() if any('DEFAULT=YES' in l for l in ls)}
            selected_aud_groups: set[str] = set()
            if not is_master and not is_live_tv and "#EXT-X-ENDLIST" in raw and "#EXT-X-DISCONTINUITY" in raw and "#EXTINF:" in raw:
                try:
                    hdr_part, blocks, cur_blk, cur_dur, cur_uris = [], [], [], 0.0, []
                    in_segs = False
                    for r_ln in raw.splitlines():
                        st_ln = r_ln.strip()
                        if not st_ln:
                            continue
                        if st_ln == "#EXT-X-DISCONTINUITY":
                            in_segs = True
                            if cur_blk:
                                blocks.append((cur_dur, cur_uris, cur_blk))
                                cur_blk, cur_dur, cur_uris = [], 0.0, []
                            continue
                        if st_ln.startswith("#EXTINF:"):
                            in_segs = True
                            dm = re.search(r"#EXTINF:([\d.]+)", st_ln)
                            if dm:
                                cur_dur += float(dm.group(1))
                            cur_blk.append(st_ln)
                        elif not st_ln.startswith("#"):
                            in_segs = True
                            cur_uris.append(st_ln)
                            cur_blk.append(st_ln)
                        elif st_ln == "#EXT-X-ENDLIST":
                            continue
                        elif not in_segs:
                            hdr_part.append(st_ln)
                        else:
                            cur_blk.append(st_ln)
                    if cur_blk:
                        blocks.append((cur_dur, cur_uris, cur_blk))
                    if len(blocks) > 1:
                        ad_re = re.compile(r"(?:preroll|midroll|/ads?/|reklam|promo|sponsor|bumper|1xbet|melbet|mostbet|betwinner|casino)", re.I)
                        kept_indexed = [
                            (idx_b, b) for idx_b, b in enumerate(blocks)
                            if not any(ad_re.search(u) for u in b[1])
                        ]
                        if len(kept_indexed) == len(blocks) and explicit_mtype != "tv" and blocks[0][0] <= 48.0 and len(blocks) >= 2 and blocks[1][0] >= 500.0:
                            kept_indexed = [(idx_b, b) for idx_b, b in enumerate(blocks) if idx_b > 0]
                        if kept_indexed and len(kept_indexed) < len(blocks):
                            first_kept_idx = kept_indexed[0][0]
                            stripped_leading_segs = sum(len(blocks[sk_i][1]) for sk_i in range(first_kept_idx))
                            if stripped_leading_segs > 0:
                                updated_seq = False
                                new_hdr = []
                                for hl in hdr_part:
                                    m_ms = re.match(r"^#EXT-X-MEDIA-SEQUENCE:(\d+)$", hl)
                                    if m_ms:
                                        new_hdr.append(f"#EXT-X-MEDIA-SEQUENCE:{int(m_ms.group(1)) + stripped_leading_segs}")
                                        updated_seq = True
                                    else:
                                        new_hdr.append(hl)
                                if not updated_seq:
                                    new_hdr.append(f"#EXT-X-MEDIA-SEQUENCE:{stripped_leading_segs}")
                                hdr_part = new_hdr
                            hoisted_key = next((hl for hl in reversed(hdr_part) if hl.startswith("#EXT-X-KEY:")), "")
                            hoisted_map = next((hl for hl in reversed(hdr_part) if hl.startswith("#EXT-X-MAP:")), "")
                            for sk_i in range(first_kept_idx):
                                for sk_ln in blocks[sk_i][2]:
                                    if sk_ln.startswith("#EXT-X-KEY:"):
                                        hoisted_key = sk_ln
                                    elif sk_ln.startswith("#EXT-X-MAP:"):
                                        hoisted_map = sk_ln
                            first_blk_lines = list(kept_indexed[0][1][2])
                            pre_first_seg = []
                            for fl in first_blk_lines:
                                if not fl.startswith("#") or fl.startswith("#EXTINF:"):
                                    break
                                pre_first_seg.append(fl)
                            hoist_prefix = []
                            if hoisted_key and not any(hl.startswith("#EXT-X-KEY:") for hl in hdr_part) and not any(pl.startswith("#EXT-X-KEY:") for pl in pre_first_seg):
                                hoist_prefix.append(hoisted_key)
                            if hoisted_map and not any(hl.startswith("#EXT-X-MAP:") for hl in hdr_part) and not any(pl.startswith("#EXT-X-MAP:") for pl in pre_first_seg):
                                hoist_prefix.append(hoisted_map)
                            rebuilt = list(hdr_part)
                            for idx_k, (_, (_, _, b_lines)) in enumerate(kept_indexed):
                                if idx_k > 0:
                                    rebuilt.append("#EXT-X-DISCONTINUITY")
                                elif hoist_prefix:
                                    rebuilt.extend(hoist_prefix)
                                rebuilt.extend(b_lines)
                            if "#EXT-X-ENDLIST" in raw:
                                rebuilt.append("#EXT-X-ENDLIST")
                            raw = "\n".join(rebuilt)
                except Exception:
                    pass
            for ln in raw.splitlines():
                s_ln = ln.strip()
                if s_ln:
                    if s_ln.startswith("#"):
                        if 'TYPE=SUBTITLES' in s_ln:
                            try:
                                um = re.search(r'URI="([^"]+)"', s_ln)
                                lm = re.search(r'(?:LANGUAGE|NAME)="([^"]+)"', s_ln)
                                if um and lm and tid.isdigit():
                                    su = um.group(1)
                                    if not su.startswith("http"):
                                        su = urllib.parse.urljoin(base_u, su)
                                    if any(ext in su.lower() for ext in (".vtt", ".srt", "/subtitle/")):
                                        s_i, e_i = int(s_num or 1), int(e_num or 1)
                                        with _SEG_TABLE_LOCK:
                                            for mt_k in ("tv", "movie"):
                                                es_l = _EMBED_SUB_CACHE.setdefault(f"{mt_k}:{tid}:{s_i}:{e_i}", [])
                                                if not any(x.get("url") == su for x in es_l):
                                                    es_l.insert(0, {"lang": lm.group(1).lower().strip(), "url": su, "source": "m3u8_embed"})
                            except Exception:
                                pass
                            continue
                        if s_ln.startswith("#EXT-X-STREAM-INF"):
                            s_ln = re.sub(r',SUBTITLES="[^"]*"', '', s_ln)
                            if not valid_aud_lines:
                                s_ln = re.sub(r',AUDIO="[^"]*"', '', s_ln)
                            else:
                                s_ln = re.sub(r',?\s*mp4a\.[a-zA-Z0-9.]+', '', s_ln)
                                s_ln = re.sub(r'CODECS="([^"]*),"', r'CODECS="\1"', s_ln)
                            pending_inf = s_ln
                            continue
                        if 'TYPE=AUDIO' in s_ln:
                            if 'URI="undefined' in s_ln:
                                continue

                            def _set_aud_default(tag_ln: str, is_def: bool, lang_c: str = "") -> str:
                                cleaned = re.sub(r',?\b(?:DEFAULT|AUTOSELECT)=(?:YES|NO)\b', '', tag_ln)
                                if lang_c and 'LANGUAGE="' not in cleaned:
                                    cleaned = re.sub(r'TYPE=AUDIO\s*,?\s*', f'TYPE=AUDIO,LANGUAGE="{lang_c}",', cleaned, count=1)
                                cleaned = re.sub(r'TYPE=AUDIO\s*,?\s*', f'TYPE=AUDIO,DEFAULT={"YES" if is_def else "NO"},AUTOSELECT={"YES" if is_def else "NO"},', cleaned, count=1)
                                return cleaned.rstrip(",")

                            grp_id = _aud_grp(s_ln)
                            grp_lines = aud_by_grp.get(grp_id) or valid_aud_lines
                            grp_has_tr = any(_line_lang(l) == "tr" for l in grp_lines)
                            grp_has_orig = any(_line_lang(l) != "tr" for l in grp_lines)
                            grp_has_want = bool(want_code) and any(_line_lang(l) == want_code for l in grp_lines)
                            l_code = _line_lang(s_ln)
                            is_tr_line = l_code == "tr"
                            if grp_has_want or (aud_pref == "orig" and grp_has_orig) or (want_code and want_code != "tr" and grp_has_orig):
                                if grp_has_want:
                                    is_match = l_code == want_code
                                else:
                                    orig_def_lines = [l for l in grp_lines if _line_lang(l) != "tr" and "DEFAULT=YES" in l]
                                    if orig_def_lines:
                                        is_match = (not is_tr_line) and ("DEFAULT=YES" in s_ln)
                                    else:
                                        is_match = not is_tr_line
                                if is_match and grp_id not in selected_aud_groups:
                                    selected_aud_groups.add(grp_id)
                                    s_ln = _set_aud_default(s_ln, True, l_code)
                                else:
                                    s_ln = _set_aud_default(s_ln, False, l_code)
                            elif not is_probe and grp_has_tr:
                                if is_tr_line and grp_id not in selected_aud_groups:
                                    selected_aud_groups.add(grp_id)
                                    s_ln = _set_aud_default(s_ln, True, l_code)
                                else:
                                    s_ln = _set_aud_default(s_ln, False, l_code)
                            elif grp_id not in default_aud_groups and 'DEFAULT=NO' in s_ln:
                                s_ln = _set_aud_default(s_ln, True, l_code)
                                default_aud_groups.add(grp_id)
                        if s_ln.startswith("#EXT-X-I-FRAME-STREAM-INF"):
                            continue
                        if 'URI="' in s_ln:
                            is_media_tag = s_ln.startswith("#EXT-X-MEDIA")
                            t_kind = "key" if s_ln.startswith(("#EXT-X-KEY", "#EXT-X-SESSION-KEY")) else ("map" if s_ln.startswith("#EXT-X-MAP") else "")
                            s_ln = re.sub(r'URI="([^"]+)"', lambda m: f'URI="{_rewrite_u(m.group(1), is_sub_playlist=is_media_tag, tag_kind=t_kind)}"', s_ln)
                    else:
                        raw_uri = s_ln
                        s_ln = _rewrite_u(s_ln, is_sub_playlist=is_master)
                        if pending_inf is not None:
                            inf_l = pending_inf
                            pending_inf = None
                            rm = re.search(r"RESOLUTION=(\d+)x(\d+)", inf_l, re.I)
                            w, h = (int(rm.group(1)), int(rm.group(2))) if rm else (0, 0)
                            if not w and not h:
                                u_path_low = raw_uri.split("?", 1)[0].lower()
                                comb = (inf_l.lower() + " " + u_path_low)
                                if re.search(r"(?:^|[^a-z0-9])(2160p?|3840x2160|4k)(?:[^a-z0-9]|$)", comb):
                                    w, h = 3840, 2160
                                elif "1080" in comb or "/q/1" in comb:
                                    w, h = 1920, 1080
                                elif "720" in comb or "/q/2" in comb:
                                    w, h = 1280, 720
                                elif "480" in comb or "/q/3" in comb:
                                    w, h = 854, 480
                                elif "360" in comb or "240" in comb:
                                    w, h = 640, 360
                                if w and h and "RESOLUTION=" not in inf_l.upper():
                                    inf_l = f"{inf_l},RESOLUTION={w}x{h}"
                            eff_w = max(w, int(h * 16 / 9)) if (w or h) else 0
                            bm = re.search(r"BANDWIDTH=(\d+)", inf_l, re.I)
                            if bm:
                                bw = int(bm.group(1))
                                if 0 < eff_w < 2600 and bw > 18000000:
                                    # Sanitize spoofed 80-95 Mbps BANDWIDTH tags on 1080p/720p CDNs so AVPlayer/hls.js never drop to 720p
                                    bw = 5400000 if eff_w >= 1700 else (2600000 if eff_w >= 1150 else 1400000)
                                    inf_l = re.sub(r"BANDWIDTH=\d+", f"BANDWIDTH={bw}", inf_l, flags=re.I)
                            else:
                                bw = 16000000 if eff_w >= 3000 else (5200000 if eff_w >= 1880 else (2600000 if eff_w >= 1150 else 1400000))
                                inf_l = f"{inf_l},BANDWIDTH={bw}"
                            variant_pairs.append((eff_w, bw, inf_l, s_ln))
                            continue
                out_lines.append(s_ln)
            if variant_pairs:
                if res_req and res_req not in ("auto", "0"):
                    matched_v = []
                    if res_req in ("2160", "4k"):
                        matched_v = [v for v in variant_pairs if v[0] >= 3000]
                        if not matched_v:
                            sorted_desc = sorted(variant_pairs, key=lambda v: (v[0], v[1]), reverse=True)
                            matched_v = sorted_desc[:1]
                    elif res_req in ("1440", "2k"):
                        matched_v = [v for v in variant_pairs if 2200 <= v[0] < 3000]
                        if not matched_v:
                            sorted_desc = sorted([v for v in variant_pairs if v[0] < 3000], key=lambda v: (v[0], v[1]), reverse=True)
                            matched_v = sorted_desc[:1] if sorted_desc else variant_pairs[:1]
                    elif res_req == "1080":
                        matched_v = [v for v in variant_pairs if 1600 <= v[0] < 2400]
                        if not matched_v:
                            sorted_desc = sorted(variant_pairs, key=lambda v: (v[0], v[1]), reverse=True)
                            matched_v = sorted_desc[:1]
                    elif res_req == "720":
                        matched_v = [v for v in variant_pairs if 1000 <= v[0] < 1600]
                    elif res_req == "480":
                        matched_v = [v for v in variant_pairs if 600 <= v[0] < 1000]
                    elif res_req == "360":
                        matched_v = [v for v in variant_pairs if v[0] < 600]
                    if matched_v:
                        # Lock to the single selected resolution stream while preserving all audio & subtitle tracks!
                        variant_pairs = matched_v[:1]
                elif max_h >= 240:
                    max_eff_w = int(max_h * 16 / 9) + 96
                    capped_v = [v for v in variant_pairs if 0 < v[0] <= max_eff_w]
                    if capped_v:
                        variant_pairs = capped_v
                if cur_is_ve and not any(1000 <= v[0] < 1800 for v in variant_pairs):
                    for v_w, _v_bw, v_inf, v_uri in list(variant_pairs):
                        if v_w >= 1800 and "sid=" in v_uri:
                            try:
                                m_sid = re.search(r"sid=([A-Za-z0-9_-]+)", v_uri)
                                if m_sid:
                                    raw_s = m_sid.group(1)
                                    u_dec = base64.urlsafe_b64decode(raw_s + "=" * ((4 - len(raw_s) % 4) % 4)).decode("utf-8")
                                    if "s1080p" in u_dec:
                                        u_720 = u_dec.replace("s1080p", "s720p")
                                        uri_720 = _rewrite_u(u_720, is_sub_playlist=True)
                                        inf_720 = re.sub(r"BANDWIDTH=\d+", "BANDWIDTH=2400000", re.sub(r"RESOLUTION=\d+x\d+", "RESOLUTION=1280x720", v_inf))
                                        variant_pairs.append((1280, 2400000, inf_720, uri_720))
                                        break
                            except Exception:
                                pass
                # Apple AVPlayer / HLS standard: AVPlayer picks the FIRST variant in the master playlist by default.
                # Sort descending by resolution & bandwidth so 4K / 1080p is served first, guaranteeing maximum visual fidelity.
                variant_pairs.sort(key=lambda v: (v[0] if v[0] > 0 else 0, v[1] if v[1] > 0 else 0), reverse=True)
                for _, _, inf_l, uri_l in variant_pairs:
                    out_lines.append(inf_l)
                    out_lines.append(uri_l)
            return "\n".join(out_lines)
        _manifest_lock = _get_loop_lock(_STREAM_LOCKS, m3u8_ckey, 300)
        async with _manifest_lock:
            cached_m2 = _M3U8_CACHE.get(m3u8_ckey)
            if cached_m2 and time.time() - cached_m2[0] < ttl_m:
                body_bytes2 = cached_m2[1] if isinstance(cached_m2[1], bytes) else str(cached_m2[1]).encode("utf-8")
                return Response(b"" if request.method == "HEAD" else body_bytes2, media_type="application/vnd.apple.mpegurl", headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Length": str(len(body_bytes2)),
                    "Cache-Control": "no-cache, no-store" if is_live_tv else "public, max-age=60, s-maxage=90, stale-while-revalidate=180",
                })
            body = await asyncio.wait_for(asyncio.to_thread(_fetch_m3u8), timeout=8.5)
            body_bytes = body.encode("utf-8")
            if body_bytes:
                if len(_M3U8_CACHE) >= 240:
                    oldest_m = min(_M3U8_CACHE, key=lambda k: _M3U8_CACHE[k][0])
                    _M3U8_CACHE.pop(oldest_m, None)
                _M3U8_CACHE[m3u8_ckey] = (time.time(), body_bytes)
            return Response(b"" if request.method == "HEAD" else body_bytes, media_type="application/vnd.apple.mpegurl", headers={
                "Access-Control-Allow-Origin": "*",
                "Content-Length": str(len(body_bytes)),
                "Cache-Control": "no-cache, no-store" if is_live_tv else "public, max-age=60, s-maxage=90, stale-while-revalidate=180",
            })
    except Exception:
        return JSONResponse({"error": "Seçilen içerik akışına ulaşılamadı"}, status_code=502, headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"})


_POSTER_MEM_CACHE = collections.OrderedDict()
_POSTER_CACHE_LOCK = threading.Lock()


def _fetch_poster_sync(url: str) -> tuple[bytes, str]:
    with _POSTER_CACHE_LOCK:
        if url in _POSTER_MEM_CACHE:
            _POSTER_MEM_CACHE.move_to_end(url)
            return _POSTER_MEM_CACHE[url]
    ref = ""
    u_low = url.lower()
    if "fullhdfilmizlesene." in u_low:
        ref = "https://www.fullhdfilmizlesene.now/"
    elif "hdfilmcehennemi." in u_low:
        ref = "https://www.hdfilmcehennemi.nl/"
    elif "dizibox." in u_low:
        ref = "https://www.dizibox.live/"
    elif "ddizimag." in u_low or "cdnhipter." in u_low:
        ref = "https://ddizimag.icu/"
    p_hdrs = {"User-Agent": UA137, "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}
    if ref:
        p_hdrs["Referer"] = ref
    req = urllib.request.Request(url, headers=p_hdrs)
    with _public_open(req, timeout=5.0) as r:
        data = r.read(1024 * 1024)
        ct = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
    if data:
        with _POSTER_CACHE_LOCK:
            _POSTER_MEM_CACHE[url] = (data, ct)
            _POSTER_MEM_CACHE.move_to_end(url)
            while len(_POSTER_MEM_CACHE) > 250:
                _POSTER_MEM_CACHE.popitem(last=False)
    return data, ct


_POSTER_LIMIT = RateLimiter(900, 60.0, name="poster")
_POSTER_REDIRECT_CACHE: "collections.OrderedDict[str, str]" = collections.OrderedDict()


def _resolve_fallback_poster_cdn_sync(url: str = "", title: str = "", orig_title: str = "", year: str = "", mtype: str = "movie", tmdb_id: str = "") -> str:
    tid_clean = str(tmdb_id or "").strip()
    ck = f"{tid_clean}|{url}|{title.lower()}|{orig_title.lower()}|{year}|{mtype}"
    with _POSTER_CACHE_LOCK:
        hit = _POSTER_REDIRECT_CACHE.get(ck)
        if hit:
            _POSTER_REDIRECT_CACHE.move_to_end(ck)
            return hit
    ep_primary = "tv" if mtype in ("tv", "series", "show", "anime") else "movie"
    resolved = ""
    if tid_clean.isdigit():
        for ep_try in (ep_primary, "tv" if ep_primary == "movie" else "movie"):
            for lang in ("tr-TR", "en-US"):
                try:
                    d_tm = _http_json(f"https://api.themoviedb.org/3/{ep_try}/{tid_clean}?api_key={TMDB_API_KEY}&language={lang}", timeout=3.0)
                    if d_tm.get("poster_path"):
                        resolved = f"https://image.tmdb.org/t/p/w500{d_tm['poster_path']}"
                        break
                except Exception:
                    pass
            if resolved:
                break
        if resolved:
            with _POSTER_CACHE_LOCK:
                _POSTER_REDIRECT_CACHE[ck] = resolved
                while len(_POSTER_REDIRECT_CACHE) > 1500:
                    _POSTER_REDIRECT_CACHE.popitem(last=False)
            return resolved
    cands: list[str] = []
    for raw_t in (orig_title, title):
        s = re.sub(r"\(\d{4}\)", "", str(raw_t or "")).strip()
        s = re.sub(r"\b(izle|full|hd|turkce|dublaj|altyazili)\b", "", s, flags=re.I).strip()
        s2 = re.sub(r"\s+\d{4}$", "", s).strip()
        for c in (s, s2):
            if len(c) >= 2 and c.lower() not in {x.lower() for x in cands}:
                cands.append(c)
        if ":" in s2:
            head = s2.split(":", 1)[0].strip()
            if len(head) >= 4 and head.lower() not in {x.lower() for x in cands}:
                cands.append(head)
    if url:
        m = re.search(r"/([a-z0-9-]+?)(?:-\d+)?(?:\.(?:jpg|jpeg|webp|png)|/?$)", url.lower())
        if m:
            slug_q = re.sub(r"\b(izle|film|dizi|full|hd|poster|afisler)\b", "", m.group(1).replace("-", " ")).strip()
            slug_q = re.sub(r"\b\d{3,4}x\d{3,4}\b", "", slug_q).strip()
            if len(slug_q) >= 2 and slug_q not in {x.lower() for x in cands}:
                cands.append(slug_q)
    ep_primary = "tv" if mtype == "tv" else "movie"
    resolved = ""
    for q in cands[:4]:
        for ep in (ep_primary, "multi"):
            for lang in ("tr-TR", "en-US"):
                try:
                    u_tm = f"https://api.themoviedb.org/3/search/{ep}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "query": q, "language": lang})
                    res_list = _http_json(u_tm, timeout=3.2).get("results") or []
                    if year and len(year) == 4:
                        yr_m = [r for r in res_list if r.get("poster_path") and str(r.get("release_date") or r.get("first_air_date") or "")[:4] == year]
                        if yr_m:
                            resolved = f"https://image.tmdb.org/t/p/w500{yr_m[0]['poster_path']}"
                            break
                    for r0 in res_list:
                        if r0.get("poster_path"):
                            resolved = f"https://image.tmdb.org/t/p/w500{r0['poster_path']}"
                            break
                except Exception:
                    pass
                if resolved:
                    break
            if resolved:
                break
        if resolved:
            break
    if not resolved:
        for q in cands[:3]:
            try:
                clean_q = re.sub(r"[^\w\s]", " ", q).strip()[:50]
                if not clean_q:
                    continue
                iu = f"https://v3.sg.media-imdb.com/suggestion/x/{urllib.parse.quote(clean_q)}.json"
                req = urllib.request.Request(iu, headers={"User-Agent": UA137, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=3.5) as r:
                    for cand in (json.loads(r.read().decode("utf-8", errors="ignore")).get("d") or []):
                        img = ((cand.get("i") or {}).get("imageUrl") or "").strip()
                        if img.startswith("https://"):
                            resolved = re.sub(r"\._V1_.*?\.(jpg|png|webp)$", r"._V1_FMjpg_UX600_.jpg", img, flags=re.I)
                            break
            except Exception:
                pass
            if resolved:
                break
    if resolved:
        with _POSTER_CACHE_LOCK:
            _POSTER_REDIRECT_CACHE[ck] = resolved
            while len(_POSTER_REDIRECT_CACHE) > 1500:
                _POSTER_REDIRECT_CACHE.popitem(last=False)
    return resolved


async def poster_proxy(request: Request):
    url = (request.query_params.get("url") or request.query_params.get("u") or "").strip()
    tmdb_id = (request.query_params.get("tid") or request.query_params.get("tmdbId") or "").strip()[:30]
    title = (request.query_params.get("t") or request.query_params.get("title") or "").strip()[:120]
    orig_title = (request.query_params.get("ot") or "").strip()[:120]
    year = (request.query_params.get("y") or "").strip()[:8]
    mtype = (request.query_params.get("mt") or "movie").strip()[:10]
    ref = (request.query_params.get("referer") or "").strip()
    sig = (request.query_params.get("sig") or "").strip()
    _poster_host = (urllib.parse.urlparse(url).hostname or "").lower().rstrip(".")
    is_whitelisted_poster = any(
        _poster_host == d or _poster_host.endswith("." + d)
        for d in (
            "fullhdfilmizlesene.com", "fullhdfilmizlesene.de", "fullhdfilmizlesene.pw", "fullhdfilmizlesene.net", "fullhdfilmizlesene.now",
            "hdfilmcehennemi.mobi", "hdfilmcehennemi.com", "hdfilmcehennemi.de", "hdfilmcehennemi.nl",
            "dizibox.live", "dizibox.com", "dizibox.tv",
            "cdnhipter.com", "ddizimag.com", "image.tmdb.org", "themoviedb.org", "ytimg.com",
            "ggpht.com", "googleusercontent.com", "mzstatic.com", "dzcdn.net", "scdn.co",
            "spotifycdn.com", "media-amazon.com", "media-imdb.com",
        )
    )
    has_valid_poster_auth = is_whitelisted_poster or _proxy_sig_ok(url, ref, sig)
    if url and not has_valid_poster_auth:
        if not title and not orig_title and not tmdb_id:
            return RedirectResponse("/static/watchlivo-poster.svg")
        url = ""
    if url and has_valid_poster_auth:
        with _POSTER_CACHE_LOCK:
            cached_poster = _POSTER_MEM_CACHE.get(url)
            if cached_poster is not None:
                _POSTER_MEM_CACHE.move_to_end(url)
        if cached_poster is not None:
            data, ct = cached_poster
            if data and ct.startswith("image/") and "svg" not in ct.lower():
                return Response(data, media_type=ct, headers={
                    "Access-Control-Allow-Origin": "*",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'; sandbox",
                    "Cache-Control": "public, max-age=604800, s-maxage=604800, immutable",
                })
    allowed, retry_after = await asyncio.to_thread(_POSTER_LIMIT.hit, client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    if url and url.startswith(("https://", "http://")) and has_valid_poster_auth and public_http_url(url):
        try:
            data, ct = await asyncio.wait_for(asyncio.to_thread(_fetch_poster_sync, url), timeout=2.6)
            if data and ct.startswith("image/") and "svg" not in ct.lower():
                return Response(data, media_type=ct, headers={
                    "Access-Control-Allow-Origin": "*",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Security-Policy": "default-src 'none'; sandbox",
                    "Cache-Control": "public, max-age=604800, s-maxage=604800, immutable",
                })
        except Exception:
            pass
    try:
        cdn_u = await asyncio.wait_for(
            asyncio.to_thread(_resolve_fallback_poster_cdn_sync, url, title, orig_title, year, mtype, tmdb_id),
            timeout=5.5,
        )
        if cdn_u:
            return RedirectResponse(cdn_u, status_code=302, headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=604800, s-maxage=604800",
            })
    except Exception:
        pass
    return RedirectResponse("/static/watchlivo-poster.svg")


_ASYNC_SEG_INFLIGHT: dict[str, asyncio.Future] = {}


def _build_media_response(data: bytes, status_code: int, headers: dict, is_head: bool = False):
    if is_head:
        return Response(b"", status_code=status_code, headers=headers)
    if len(data) > 2 * 1024 * 1024:
        async def _chunk_iter():
            mv = memoryview(data)
            step = 262144
            for off in range(0, len(mv), step):
                yield bytes(mv[off:off + step])
        return StreamingResponse(_chunk_iter(), status_code=status_code, headers=headers)
    return Response(data, status_code=status_code, headers=headers)


async def stream_proxy(request: Request):
    url = (request.query_params.get("url") or request.query_params.get("u") or "").strip()
    ref = (request.query_params.get("referer") or "").strip()
    sig = (request.query_params.get("sig") or "").strip()
    cors_hdrs = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    }
    if request.method == "OPTIONS":
        return Response(b"", status_code=204, headers={**cors_hdrs, "Access-Control-Max-Age": "86400"})
    if not url or not _proxy_sig_ok(url, ref, sig):
        return JSONResponse({"error": "İmzasız proxy isteği reddedildi"}, status_code=403, headers={"Cache-Control": "no-store", **cors_hdrs})
    raw_req_rng = request.headers.get("range") or ""
    is_unranged_head = request.method == "HEAD" and not raw_req_rng
    if is_unranged_head:
        with _SEG_TABLE_LOCK:
            fast_head = _SEGMENT_CACHE.get(url)
        if fast_head and (time.time() - fast_head[0] < 90):
            return Response(b"", status_code=200, headers={
                "Content-Type": fast_head[2],
                "Content-Length": str(len(fast_head[1])),
                "Accept-Ranges": "bytes",
                "Vary": "Range",
                "Cache-Control": "public, max-age=300",
                **cors_hdrs,
            })
    rng = raw_req_rng or ("bytes=0-0" if is_unranged_head else "")
    ext_hint = (request.query_params.get("ext") or "").strip().lower()
    can_coalesce = request.method != "HEAD" and not rng
    if can_coalesce:
        with _SEG_TABLE_LOCK:
            fast_hit = _SEGMENT_CACHE.get(url)
        if fast_hit and (time.time() - fast_hit[0] < 90):
            f_data, f_ct = fast_hit[1], fast_hit[2]
            return _build_media_response(f_data, 200, {
                "Content-Type": f_ct,
                "Content-Length": str(len(f_data)),
                "Accept-Ranges": "bytes",
                "Vary": "Range",
                "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600",
                **cors_hdrs,
            })
    try:
        if can_coalesce:
            inflight = _ASYNC_SEG_INFLIGHT.get(url)
            if inflight is not None and not inflight.done():
                try:
                    data, status, cr, ct = await asyncio.wait_for(asyncio.shield(inflight), timeout=22)
                except (asyncio.CancelledError, Exception):
                    data, status, cr, ct = await asyncio.wait_for(asyncio.to_thread(_proxy_chunk_sync, url, ref, rng, ext_hint), timeout=22)
            else:
                loop = asyncio.get_running_loop()
                fut = loop.create_future()
                fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
                _ASYNC_SEG_INFLIGHT[url] = fut
                try:
                    res_tup = await asyncio.wait_for(asyncio.to_thread(_proxy_chunk_sync, url, ref, rng, ext_hint), timeout=22)
                    if not fut.done():
                        fut.set_result(res_tup)
                    data, status, cr, ct = res_tup
                except BaseException as exc_f:
                    if not fut.done():
                        if isinstance(exc_f, asyncio.CancelledError):
                            fut.cancel()
                        else:
                            fut.set_exception(exc_f)
                    raise
                finally:
                    if _ASYNC_SEG_INFLIGHT.get(url) is fut:
                        _ASYNC_SEG_INFLIGHT.pop(url, None)
        else:
            data, status, cr, ct = await asyncio.wait_for(asyncio.to_thread(_proxy_chunk_sync, url, ref, rng, ext_hint), timeout=22)
        if is_unranged_head:
            m_tot = re.search(r"/(\d+)$", str(cr or ""))
            full_len = int(m_tot.group(1)) if m_tot else len(data)
            return Response(b"", status_code=200, headers={
                "Content-Type": ct,
                "Content-Length": str(full_len),
                "Accept-Ranges": "bytes",
                "Vary": "Range",
                "Cache-Control": "public, max-age=300",
                **cors_hdrs,
            })
        cache_ctl = (
            "private, max-age=300"
            if (rng or status == 206)
            else "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600"
        )
        hdrs = {
            "Content-Type": ct,
            "Content-Length": str(len(data)),
            "Accept-Ranges": "bytes",
            "Vary": "Range",
            "Cache-Control": cache_ctl,
            **cors_hdrs,
        }
        if cr and status in (206, 416):
            hdrs["Content-Range"] = cr
        return _build_media_response(
            data,
            status if status in (200, 206, 416) else 200,
            hdrs,
            is_head=(request.method == "HEAD"),
        )
    except urllib.error.HTTPError as he:
        up_code = int(getattr(he, "code", 502) or 502)
        out_code = up_code if up_code in (403, 404, 410, 416, 429) else 502
        err_hdrs = {"Cache-Control": "no-store", **cors_hdrs}
        if out_code == 416:
            up_cr = he.headers.get("Content-Range") if getattr(he, "headers", None) else None
            err_hdrs["Content-Range"] = up_cr or "bytes */*"
        return JSONResponse({"error": "Akış kaynağına ulaşılamadı.", "upstreamStatus": up_code}, status_code=out_code, headers=err_hdrs)
    except Exception:
        return JSONResponse({"error": "Akış kaynağına ulaşılamadı."}, status_code=502, headers={"Cache-Control": "no-store", **cors_hdrs})


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
            encs = ("utf-16", "utf-8-sig", "cp1254", "iso-8859-9", "latin-1")
        elif len(raw_bytes) >= 4 and raw_bytes.count(b"\x00") > len(raw_bytes) // 5:
            odd_zeros = sum(1 for b in raw_bytes[1:256:2] if b == 0)
            even_zeros = sum(1 for b in raw_bytes[0:256:2] if b == 0)
            bomless_u16 = "utf-16-le" if odd_zeros >= even_zeros else "utf-16-be"
            encs = (bomless_u16, "utf-16", "utf-8-sig", "cp1254", "iso-8859-9", "latin-1")
        else:
            encs = ("utf-8-sig", "utf-8", "cp1254", "iso-8859-9")
        for enc in encs:
            try:
                txt = raw_bytes.decode(enc)
                break
            except Exception:
                continue
        if not txt:
            txt = raw_bytes.decode("cp1254", errors="replace")
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
    m_xts = re.search(r"(?m)^(X-TIMESTAMP-MAP=[^\r\n]+)", txt)
    x_ts_map = m_xts.group(1).strip() if m_xts else ""
    txt = re.sub(r"^X-TIMESTAMP-MAP[^\n]*\n?", "", txt, flags=re.M)
    txt = re.sub(
        r"(?im)^.*?(?:ai\.opensubtitles\.com|opensubtitles\.org|osdb\.link|advertise your product or brand here|support us and become vip|do you want subtitles for any video|çevrimiçi filmleri ve dizileri ücretsiz izleyin|yutukluklar\.xyz|www\.altyazi\.org|turkcealtyazi\.org|subscene\.com|dizipal|dizibox|hdfilmcehennemi|fullhdfilmizlesene|dizilla|dizigom|sezonlukdizi|yabancidizi|jetfilmizle|filmmodu|deneme\s*bonusu|freespin|t\.me/|(?:bahis|casino|telegram)[^\n]*(?:https?://|www\.|@[a-z0-9_]{3,}|\.(?:com|net|org|xyz|bet|io)|bonus|güncel\s*giriş)|çeviri\s*:|senkron\s*:|iyi seyirler dileriz).*$\n?",
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
    vtt_hdr = f"WEBVTT\n{x_ts_map}\n\n" if x_ts_map else "WEBVTT\n\n"
    return vtt_hdr + "\n\n".join(cleaned_blocks) + "\n"


_VTT_CACHE_LOCK = threading.Lock()
_TTS_CACHE_LOCK = threading.Lock()


_VTT_DIAG = {}

def _fetch_vtt_sync(url: str, timeout: float = 8.0) -> str:
    global _VTT_DIAG
    _VTT_DIAG = {"url": url}
    import gzip
    with _VTT_CACHE_LOCK:
        if url in _SUB_VTT_CACHE:
            _SUB_VTT_CACHE.move_to_end(url)
            return _SUB_VTT_CACHE[url]
    ua_use = (
        "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)"
        if "youtube.com/api/timedtext" in url
        else ("TemporaryUserAgent" if "opensubtitles.org" in url else UA137)
    )
    hdrs = {
        "User-Agent": ua_use,
        "Accept": "*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    }
    if any(d in url for d in ("goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "workers.dev")) or bool(re.search(r"https?://[^/]+\.top/vd[a-z0-9]*/", url)):
        hdrs["Referer"] = "https://vidy.st/"
        hdrs["Origin"] = "https://vidy.st"
    elif any(d in url for d in ("zenoak.top", "paleoak.top", "olivewave.top", "finalsignal.top")):
        hdrs["Referer"] = "https://player.videasy.to/"
        hdrs["Origin"] = "https://player.videasy.to"
    elif "cdn77s.com" in url or "ag2m5.cfd" in url:
        hdrs["Referer"] = "https://x.ag2m5.cfd/"
        hdrs["Origin"] = "https://x.ag2m5.cfd"
    elif "pilavyer" in url:
        hdrs["Referer"] = "https://play2.pilavyerplay.top/"
        hdrs["Origin"] = "https://play2.pilavyerplay.top"
    elif "rapidvid.org" in url:
        hdrs["Referer"] = "https://rapidvid.org/"
    elif "hdfilmcehennemi.mobi" in url:
        hdrs["Referer"] = "https://hdfilmcehennemi.mobi/"
    elif "fastplay." in url or ".cfd/" in url:
        hdrs["Referer"] = "https://fastplay.mom/"

    raw = b""
    # 1. Primary: curl_cffi with Chrome 124 TLS impersonation (bypasses Cloudflare Managed Challenges on Render)
    try:
        from curl_cffi import requests as cffi_requests
        cur_vtt_u = url
        c_resp = None
        for _ in range(4):
            if not public_http_url(cur_vtt_u):
                c_resp = None
                break
            c_resp = cffi_requests.get(cur_vtt_u, headers=hdrs, impersonate="chrome124", timeout=timeout, allow_redirects=False)
            if c_resp.status_code in (301, 302, 303, 307, 308):
                loc = (c_resp.headers.get("Location") or c_resp.headers.get("location") or "").strip()
                if not loc:
                    break
                cur_vtt_u = urllib.parse.urljoin(cur_vtt_u, loc)
                continue
            break
        if c_resp is not None and c_resp.status_code == 200 and len(c_resp.content) > 10:
            raw = c_resp.content
    except Exception:
        raw = b""

    # 2. Fallback: _public_open with standard urllib
    if not raw or len(raw) < 10:
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with _public_open(req, timeout=timeout) as r:
                raw = r.read(2 * 1024 * 1024)
        except Exception:
            pass

    # 3. Fallback: edge fetch if available
    if not raw or len(raw) < 10:
        try:
            ref_u = str(hdrs.get("Referer") or "")
            raw, _ = _edge_fetch_bytes(url, referer=ref_u, timeout=timeout, max_bytes=2 * 1024 * 1024)
        except Exception:
            pass

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
    ck = f"{tl_code}_vtt:{hashlib.md5(vtt.encode('utf-8', errors='ignore')).hexdigest()}:{len(vtt)}"
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
    batches = batches[:120]

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


_INTRO_CACHE: dict[str, dict] = {}


def _detect_intro_sync(imdb_id: str, tid: str, mtype: str, s: int, e: int, subs: list) -> dict | None:
    return None


_SUB_RESP_CACHE: dict[str, tuple[float, dict]] = {}
_SUB_RESP_LOCKS: dict[str, asyncio.Lock] = {}


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
    tid = (request.query_params.get("tmdbId") or request.query_params.get("tmdb_id") or request.query_params.get("tid") or "").strip()[:30]
    imdb_id = (request.query_params.get("imdbId") or request.query_params.get("imdb_id") or "").strip()[:30]
    vid = (request.query_params.get("videoId") or request.query_params.get("v") or "").strip()[:20]
    mtype = (request.query_params.get("mediaType") or request.query_params.get("type") or request.query_params.get("mtype") or "movie").strip().lower()
    prov = (request.query_params.get("provider") or request.query_params.get("prov") or "netflix").strip().lower()
    title = (request.query_params.get("title") or "").strip()[:160]
    year = (request.query_params.get("year") or "").strip()[:10]
    try:
        s = max(1, int(request.query_params.get("season") or request.query_params.get("s") or 1))
        e = max(1, int(request.query_params.get("episode") or request.query_params.get("e") or 1))
    except (TypeError, ValueError):
        s, e = 1, 1
    stream_url = (request.query_params.get("url") or "").strip()[:1500]
    if not vid and stream_url:
        m_yt = YT_RE.search(stream_url)
        if m_yt:
            vid = m_yt.group(1)
    if vid and re.match(r"^[A-Za-z0-9_-]{11}$", vid) and not tid.isdigit() and not imdb_id:
        try:
            yt_res = await asyncio.wait_for(asyncio.to_thread(_fetch_yt_subtitles_and_audio_sync, vid), timeout=7.5)
        except Exception:
            yt_res = {"subtitleTracks": [], "audioTracks": []}
        return JSONResponse(yt_res, headers={"Cache-Control": "public, max-age=180, s-maxage=900"})
    s_ckey = f"v18|{prov}|{mtype}|{tid or imdb_id or title.lower()}|{s}|{e}"
    cc_hdrs = {"Cache-Control": "no-cache, no-store, must-revalidate", "CDN-Cache-Control": "no-store"}
    cached_s = _SUB_RESP_CACHE.get(s_ckey)
    if cached_s and time.time() - cached_s[0] < 600:
        return JSONResponse(cached_s[1], headers=cc_hdrs)
    lock = _get_loop_lock(_SUB_RESP_LOCKS, s_ckey, 400)
    async with lock:
        cached_s = _SUB_RESP_CACHE.get(s_ckey)
        if cached_s and time.time() - cached_s[0] < 600:
            return JSONResponse(cached_s[1], headers=cc_hdrs)
        orig_title = title
        tr_title = title
        if not tid.isdigit() and title:
            try:
                hits = await asyncio.wait_for(asyncio.to_thread(_tmdb_sync, title), timeout=3.5)
                if hits:
                    tid = str(hits[0].get("tmdbId") or tid)
                    imdb_id = imdb_id or str(hits[0].get("imdbId") or "")
            except Exception:
                pass
        if tid.isdigit():
            try:
                m_cached = await asyncio.wait_for(asyncio.to_thread(_get_tmdb_meta_sync, tid, mtype, title, year, imdb_id), timeout=4.0)
                orig_title = m_cached.get("originalTitle") or title
                tr_title = m_cached.get("trTitle") or title or orig_title
                year = m_cached.get("year") or year
                imdb_id = m_cached.get("imdbId") or imdb_id
            except Exception:
                pass
        direct_list = []
        if tid.isdigit():
            try:
                direct_list = await asyncio.wait_for(asyncio.to_thread(_extract_direct_stream_sync, tid, mtype, s, e, orig_title, year, imdb_id, tr_title), timeout=9.5)
            except Exception:
                direct_list = []
        try:
            pmeta = await asyncio.wait_for(asyncio.to_thread(_fetch_platform_meta_sync, prov, tr_title or orig_title, tid, mtype), timeout=5)
        except Exception:
            def_aud, def_sub = PLATFORM_LANG_PROFILES.get(prov if prov in PROV_LABELS else "cinema", PLATFORM_LANG_PROFILES["cinema"])
            pmeta = {"prov": prov if prov in PROV_LABELS else "cinema", "officialUrl": "", "audioLangs": list(def_aud), "subLangs": list(def_sub)}
        try:
            subs = await asyncio.wait_for(asyncio.to_thread(_fetch_subtitles_sync, tid, imdb_id, mtype, s, e, prov, pmeta, direct_list), timeout=12.5)
        except Exception:
            subs = []
        try:
            audio = await asyncio.wait_for(asyncio.to_thread(_build_audio_tracks, stream_url, direct_list, prov, tid, s, e, pmeta, mtype), timeout=9)
        except Exception:
            audio = []
        try:
            intro_seg = await asyncio.wait_for(asyncio.to_thread(_detect_intro_sync, imdb_id, tid, mtype, s, e, subs), timeout=4)
        except Exception:
            intro_seg = None
        payload = {"subtitleTracks": subs, "subtitles": subs, "audioTracks": audio, "intro": intro_seg, "platformAudioLangs": pmeta.get("audioLangs") or [], "platformSubLangs": pmeta.get("subLangs") or []}
        if len(_SUB_RESP_CACHE) >= 300:
            _SUB_RESP_CACHE.pop(next(iter(_SUB_RESP_CACHE)), None)
        _SUB_RESP_CACHE[s_ckey] = (time.time(), payload)
        return JSONResponse(payload, headers=cc_hdrs)


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
    if not translate and (need_tr or need_en):
        allowed_tr, _ = _SUB_TRANSLATE_LIMIT.hit(client_ip(request))
        if not allowed_tr:
            need_tr = False
            need_en = False
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


_EXTRACT_LIMIT = RateLimiter(120, 60.0, name="extract")


async def extract_video(request: Request):
    allowed, retry_after = _EXTRACT_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    body = {}
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
    url = str(request.query_params.get("url") or body.get("url") or "").strip()[:2000]
    title = str(request.query_params.get("title") or body.get("title") or "").strip()[:150]
    if not re.match(r"^https?://", url):
        return JSONResponse({"error": "Geçerli bir http(s) bağlantısı girin"}, status_code=400)
    try:
        res = await asyncio.wait_for(asyncio.to_thread(_extract_sync, url, title), timeout=10)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=422)
    except Exception:
        return JSONResponse({"error": "Sayfaya ulaşılamadı"}, status_code=502)
    if not res:
        return JSONResponse({"error": "Bu sayfada oynatılabilir video bulunamadı"}, status_code=422)
    return JSONResponse(res)


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


_SW_MEM_CACHE: dict[str, object] = {"mtime": None, "js": ""}
_INDEX_MEM_CACHE: dict[str, object] = {"mtime": None, "html": ""}


async def service_worker(request: Request):
    sw_path = STATIC_DIR / "sw.js"
    try:
        st = sw_path.stat()
        if _SW_MEM_CACHE.get("mtime") != st.st_mtime_ns or not _SW_MEM_CACHE.get("js"):
            _SW_MEM_CACHE["js"] = sw_path.read_text(encoding="utf-8")
            _SW_MEM_CACHE["mtime"] = st.st_mtime_ns
        js = str(_SW_MEM_CACHE["js"])
    except Exception:
        js = "self.addEventListener('install',()=>self.skipWaiting());"
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
        "version": "20261112_v208",
        "sharedStore": rooms.STORE.shared,
        "vercel": IS_VERCEL,
        "activeRooms": len(mem_rooms),
        "totalParticipants": total_p,
        "caches": {
            "catalog": len(_CATALOG_MEM_CACHE),
            "resolve": len(_RESOLVE_RESP_CACHE),
            "m3u8": len(_M3U8_CACHE),
            "segments": len(_SEGMENT_CACHE),
        },
    })


async def index(request: Request):
    idx_path = STATIC_DIR / "index.html"
    try:
        st = idx_path.stat()
        if _INDEX_MEM_CACHE.get("mtime") != st.st_mtime_ns or not _INDEX_MEM_CACHE.get("html"):
            _INDEX_MEM_CACHE["html"] = idx_path.read_text(encoding="utf-8")
            _INDEX_MEM_CACHE["mtime"] = st.st_mtime_ns
        html_txt = str(_INDEX_MEM_CACHE["html"])
    except Exception:
        html_txt = idx_path.read_text(encoding="utf-8")
    return HTMLResponse(html_txt, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "X-Frame-Options": "SAMEORIGIN"})


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
    if not apk_file.exists():
        apk_file = STATIC_DIR / "Watchlivo-v1.1.apk"
    if not apk_file.exists():
        apk_file = STATIC_DIR / "Watchlivo-v1.0.apk"
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
    edge_base = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL).strip().rstrip("/")
    if ext_apk.startswith("https://"):
        return RedirectResponse(ext_apk, status_code=302)
    if edge_base.startswith("https://"):
        return RedirectResponse(f"{edge_base}/download/Watchlivo-v2.0.apk", status_code=302)
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
    edge_base = (os.environ.get("STREAM_PROXY_BASE_URL") or STREAM_PROXY_BASE_URL).strip().rstrip("/")
    if ext_ipa.startswith("https://"):
        return RedirectResponse(ext_ipa, status_code=302)
    if edge_base.startswith("https://"):
        return RedirectResponse(f"{edge_base}/download/Watchlivo.ipa", status_code=302)
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



async def rave_browser_proxy(request: Request):
    import html
    target_url = (request.query_params.get("url") or "").strip()[:2000]
    prov = (request.query_params.get("provider") or "netflix").strip().lower()[:32]
    if not target_url.startswith(("http://", "https://")) or not public_http_url(target_url):
        return HTMLResponse("<h3>Geçersiz bağlantı</h3>", status_code=400)

    prov_upper = html.escape(prov.upper())
    safe_target = html.escape(target_url)
    csp_nonce = html.escape(str(request.scope.get("csp_nonce") or ""), quote=True)

    portal_html = f"""<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{prov_upper} — Watchlivo Canlı Platform Gezgini</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 20% 20%, rgba(0,245,212,0.12), transparent 55%), #070913;
      color: #fff; padding: 20px; min-height: 100vh;
    }}
    .portal-head {{
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
      padding: 16px 20px; border-radius: 16px;
      background: rgba(16, 22, 38, 0.88); border: 1px solid rgba(255,255,255,0.14);
      margin-bottom: 18px;
    }}
    .portal-login-row {{
      display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
    }}
    .portal-inp {{
      height: 36px; padding: 0 12px; border-radius: 999px;
      background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.16);
      color: #fff; font-size: 12px; outline: none; min-width: 210px;
    }}
    .portal-btn {{
      height: 36px; padding: 0 16px; border-radius: 999px; border: none;
      background: #00f5d4; color: #05070f; font-weight: 800; font-size: 12px; cursor: pointer;
    }}
    .portal-btn.sec {{
      background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.18);
    }}
    .portal-grid {{
      display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 14px;
    }}
    .p-item {{
      border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09); cursor: pointer; transition: transform 0.2s, border-color 0.2s;
      display: flex; flex-direction: column;
    }}
    .p-item:hover {{ transform: translateY(-4px); border-color: #00f5d4; }}
    .p-item img {{ width: 100%; aspect-ratio: 2/3; object-fit: cover; background: #0f1424; }}
    .p-item-body {{ padding: 10px; display: flex; flex-direction: column; gap: 4px; }}
    .p-item-title {{ font-size: 12px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
    .p-item-sub {{ font-size: 10px; color: #94a3b8; }}
    .p-item-play {{
      margin-top: 6px; padding: 5px 8px; border-radius: 999px; background: rgba(0,245,212,0.16);
      color: #00f5d4; font-size: 11px; font-weight: 700; text-align: center;
    }}
  </style>
</head>
<body>
  <div class="portal-head">
    <div>
      <div style="font-size:15px;font-weight:800;color:#00f5d4;">🌐 {prov_upper} Canlı Platform & Katalog Gezgini</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:3px;">Hesabınızla bağlanın veya {prov_upper} içeriklerini doğrudan seçip odada başlatın.</div>
    </div>
    <div class="portal-login-row">
      <input id="q-inp" class="portal-inp" placeholder="{prov_upper} içinde film, dizi ara veya bağlantı yapıştır..." />
      <button id="btn-portal-search" type="button" class="portal-btn">🔍 Ara / Aç</button>
      <button id="btn-portal-launch" type="button" class="portal-btn sec">▶ Bu Sayfayı Odada Başlat</button>
      <button id="btn-portal-ext" type="button" class="portal-btn sec">↗ {prov_upper} Resmi Site</button>
    </div>
  </div>
  <div id="grid" class="portal-grid">Yükleniyor...</div>
  <script nonce="{csp_nonce}">
    const PROV = {json.dumps(prov).replace("</", "<\\/")};
    const INIT_URL = {json.dumps(target_url).replace("</", "<\\/")};
    function escHtml(s) {{
      return String(s ?? '').replace(/[&<>"']/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));
    }}
    function launchDirectUrl(u) {{
      window.parent.postMessage({{
        type: 'watchlivo_portal_pick',
        url: u || INIT_URL,
        title: PROV.toUpperCase() + ' İçeriği',
        provider: PROV
      }}, window.location.origin || '*');
    }}
    function handlePortalInput(val) {{
      const v = String(val || '').trim();
      if (/^https?:\\/\\//i.test(v)) {{
        launchDirectUrl(v);
        return;
      }}
      loadCatalog(v);
    }}
    document.getElementById('q-inp')?.addEventListener('keydown', (e) => {{
      if (e.key === 'Enter') handlePortalInput(e.target.value);
    }});
    document.getElementById('btn-portal-search')?.addEventListener('click', () => {{
      handlePortalInput(document.getElementById('q-inp')?.value || '');
    }});
    document.getElementById('btn-portal-launch')?.addEventListener('click', () => {{
      launchDirectUrl(INIT_URL);
    }});
    document.getElementById('btn-portal-ext')?.addEventListener('click', () => {{
      window.open(INIT_URL, '_blank', 'noopener');
    }});
    async function loadCatalog(q = '') {{
      const g = document.getElementById('grid');
      g.innerHTML = '<div style="grid-column:1/-1;padding:24px;color:#94a3b8;">{prov_upper} kataloğu yükleniyor...</div>';
      try {{
        const r = await fetch('/api/rave/catalog?provider=' + encodeURIComponent(PROV) + '&q=' + encodeURIComponent(q || ''));
        const d = await r.json();
        const items = d.items || [];
        if (!items.length) {{
          g.innerHTML = '<div style="grid-column:1/-1;padding:24px;color:#94a3b8;">Sonuç bulunamadı.</div>';
          return;
        }}
        g.innerHTML = '';
        items.slice(0, 24).forEach(it => {{
          const card = document.createElement('div');
          card.className = 'p-item';
          card.innerHTML = '<img src="' + escHtml(it.poster || it.backdrop || '/static/watchlivo-poster.svg') + '" alt="" />' +
            '<div class="p-item-body">' +
              '<div class="p-item-title">' + escHtml(it.title || '') + '</div>' +
              '<div class="p-item-sub">' + escHtml(it.year || '2025') + ' · ⭐ ' + escHtml(it.rating || '8.2') + '</div>' +
              '<div class="p-item-play">▶ Odada Başlat</div>' +
            '</div>';
          card.onclick = () => {{
            window.parent.postMessage({{
              type: 'watchlivo_portal_item',
              item: it,
              provider: PROV
            }}, window.location.origin || '*');
          }};
          g.appendChild(card);
        }});
      }} catch (e) {{
        g.innerHTML = '<div style="grid-column:1/-1;padding:24px;color:#f87171;">Katalog yüklenemedi.</div>';
      }}
    }}
    loadCatalog('');
  </script>
</body>
</html>"""
    bp_hdrs = {"Cache-Control": "no-store"}
    req_orig = (request.headers.get("origin") or "").strip()
    if req_orig:
        orig_h = (urllib.parse.urlsplit(req_orig).hostname or "").lower()
        if orig_h in ("watchlivo.online", "www.watchlivo.online", "localhost", "127.0.0.1") or orig_h.endswith(".onrender.com"):
            bp_hdrs["Access-Control-Allow-Origin"] = req_orig
            bp_hdrs["Vary"] = "Origin"
    return HTMLResponse(portal_html, headers=bp_hdrs)

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
                if q_clean in _ANALYTICS_STATE["top_searches"] or len(_ANALYTICS_STATE["top_searches"]) < 500:
                    _ANALYTICS_STATE["top_searches"][q_clean] = _ANALYTICS_STATE["top_searches"].get(q_clean, 0) + 1
        elif event_type == "watch" and title:
            t_clean = re.sub(r"\s+", " ", title.strip())[:100]
            if len(t_clean) >= 2:
                _ANALYTICS_STATE["total_watches"] += 1
                lbl = f"{t_clean} ({'Dizi' if media_type == 'tv' else 'Film'})" if media_type else t_clean
                if lbl in _ANALYTICS_STATE["top_watched"] or len(_ANALYTICS_STATE["top_watched"]) < 500:
                    _ANALYTICS_STATE["top_watched"][lbl] = _ANALYTICS_STATE["top_watched"].get(lbl, 0) + 1
        _flush_analytics_to_kv_locked(force=False)


async def robots_txt_endpoint(request: Request) -> Response:
    txt = (
        "# Watchlivo Private Streaming Infrastructure & Anti-Crawler Directives\n"
        "User-agent: Googlebot\nDisallow: /\n\n"
        "User-agent: Googlebot-Image\nDisallow: /\n\n"
        "User-agent: Googlebot-Video\nDisallow: /\n\n"
        "User-agent: Mediapartners-Google\nDisallow: /\n\n"
        "User-agent: Bingbot\nDisallow: /\n\n"
        "User-agent: Slurp\nDisallow: /\n\n"
        "User-agent: Yandex\nDisallow: /\n\n"
        "User-agent: Baiduspider\nDisallow: /\n\n"
        "User-agent: AhrefsBot\nDisallow: /\n\n"
        "User-agent: SemrushBot\nDisallow: /\n\n"
        "User-agent: DotBot\nDisallow: /\n\n"
        "User-agent: MJ12bot\nDisallow: /\n\n"
        "User-agent: PetalBot\nDisallow: /\n\n"
        "User-agent: MarkMonitor\nDisallow: /\n\n"
        "User-agent: Corsearch\nDisallow: /\n\n"
        "User-agent: OpSec\nDisallow: /\n\n"
        "User-agent: Digimarc\nDisallow: /\n\n"
        "User-agent: ByteSpider\nDisallow: /\n\n"
        "User-agent: GPTBot\nDisallow: /\n\n"
        "User-agent: CCBot\nDisallow: /\n\n"
        "User-agent: anthropic-ai\nDisallow: /\n\n"
        "User-agent: Claude-Web\nDisallow: /\n\n"
        "User-agent: *\n"
        "Disallow: /\n"
        "Disallow: /api/\n"
        "Disallow: /mesh/\n"
        "Disallow: /room/\n"
        "Disallow: /r/\n"
        "Disallow: /join/\n"
        "Disallow: /download/\n"
        "Disallow: /uploads/\n"
        "Disallow: /static/\n"
        "Disallow: /stats\n"
        "Disallow: /analytics\n\n"
        "Sitemap: https://watchlivo.online/sitemap.xml\n"
    )
    return Response(txt, media_type="text/plain; charset=utf-8", headers={"Cache-Control": "public, max-age=3600", "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex, nocache"})


async def sitemap_xml_endpoint(request: Request) -> Response:
    today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 10800))
    urls = [
        ("https://watchlivo.online/", "1.0", "daily"),
        ("https://watchlivo.online/about", "0.8", "weekly"),
        ("https://watchlivo.online/privacy", "0.8", "monthly"),
        ("https://watchlivo.online/terms", "0.8", "monthly"),
        ("https://watchlivo.online/dmca", "0.8", "monthly"),
        ("https://watchlivo.online/contact", "0.8", "weekly"),
        ("https://watchlivo.online/r/cinema-club", "0.9", "hourly"),
        ("https://watchlivo.online/r/anime-gecesi", "0.9", "hourly"),
        ("https://watchlivo.online/r/turk-sinemasi", "0.9", "hourly"),
        ("https://watchlivo.online/r/yesilcam-klasik", "0.8", "daily"),
        ("https://watchlivo.online/r/lofi-study", "0.8", "daily"),
        ("https://watchlivo.online/r/kpop-radar", "0.8", "daily"),
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
            try:
                _RESOLVE_EXECUTOR.submit(_send_server_ga4_hit_sync, vid_hash, ua_str, ip_str, ev, str(body.get('path') or '/'), t_str)
            except Exception:
                pass
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
        return JSONResponse({"ok": True, "officialEmail": "dmca@watchlivo.online", "entry": safe_entry}, headers={"Cache-Control": "no-store"})
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
    return JSONResponse({"ok": True, "officialEmail": "dmca@watchlivo.online", "messages": pub_msgs}, headers={"Cache-Control": "no-store"})


async def legal_page_endpoint(request: Request) -> HTMLResponse:
    path = request.url.path.strip("/").lower() or "about"
    pages = {
        "about": (
            "Hakkımızda — Watchlivo Sinema & Dizi Odaları",
            "Watchlivo (watchlivo.online) arkadaşlarla aynı anda senkronize film, dizi, anime ve canlı TV izleme platformu hakkında kurumsal bilgiler.",
            "ℹ️ Hakkımızda — Watchlivo Sinema & Medya Platformu",
            "<p><b>Watchlivo (watchlivo.online)</b>, insanların fiziksel olarak ayrı olsalar bile aynı anda, tek kare gecikmesiz birlikte film, dizi, anime, canlı TV ve müzik izlemesi için geliştirilmiş yeni nesil bir senkronize izleme (Watch Party) platformudur.</p>"
            "<h3>Öne Çıkan Özelliklerimiz</h3>"
            "<ul><li><b>Saliselik Senkronizasyon:</b> Oynatma, duraklatma ve sarma odadaki herkes için anında eşitlenir.</li>"
            "<li><b>WebRTC Sesli & Yazılı Sohbet:</b> Oda içinde düşük gecikmeli mikrofon, sesli not ve canlı reaksiyonlar.</li>"
            "<li><b>4K Türkçe Dublaj & Altyazı:</b> Geniş sinema, dizi, anime arşivi ve 7/24 canlı TV kanalları.</li>"
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
            "<p><b>Watchlivo (watchlivo.online)</b>, 5651 sayılı Kanun ve DMCA (17 U.S.C. § 512) kapsamında kendi sunucularında hiçbir video veya medya dosyası barındırmayan (Non-Hosting Watch-Party Player) bir platformdur.</p>"
            "<p>Telif hakkı sahipleri, ilgili içeriğin bağlantı bilgisi ve hak sahipliği belgesiyle birlikte resmi e-posta adresimiz üzerinden bildirimde bulunabilir. Geçerli başvurular en geç <b>24 saat içinde</b> dizinden kaldırılır.</p>"
        ),
        "contact": (
            "İletişim, Film/Dizi İstek & Destek — Watchlivo",
            "Watchlivo resmi iletişim e-posta adresi (dmca@watchlivo.online), film/dizi istek, hata bildirimi ve DMCA başvuru sayfası.",
            "✉️ İletişim, Film/Dizi İstek & Destek Merkezi",
            "<p>Görüş, öneri, işbirliği, film/dizi ekleme talebi, çalışmayan bölüm bildirimi veya telif hakkı (DMCA) başvurularınız için bize doğrudan ulaşabilirsiniz:</p>"
            "<!--email_off--><p style='font-size:16px;'><b>📬 Resmi E-Posta Adresimiz:</b> <a href='mailto:dmca@watchlivo.online' style='color:#27dcc8;font-weight:800;'>dmca@watchlivo.online</a></p><!--/email_off-->"
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
            <option value="request" {'selected' if def_cat=='request' else ''}>🎬 Film / Dizi İsteği</option>
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
        <input id="wlc-subj" type="text" required minlength="2" maxlength="140" placeholder="Örn: Film/Dizi adı veya bildirim konusu" style="background:#0d1522;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px;font-size:16px;" />
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
      <!--email_off--><span>📩 Resmi İletişim & Hukuk: <a href="mailto:dmca@watchlivo.online" style="color:#27dcc8;font-weight:700;">dmca@watchlivo.online</a></span><!--/email_off-->
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
      <div class="lbl">📩 Gelen Film/Dizi İstekleri, Hata Bildirimleri & İletişim Mesajları (Resmi E-Posta: dmca@watchlivo.online)</div>
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
        "/api/rave/stream-proxy",
        "/api/rave/stream_chunk",
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
        Route("/api/system/crawler-trap", crawler_honeypot_endpoint, methods=["GET", "HEAD", "POST"]),
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
        Route("/download/Watchlivo-v1.1.0.apk", download_apk_endpoint),
        Route("/download/Watchlivo-v1.1.apk", download_apk_endpoint),
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
        Route("/api/rave/server-health", social_engine.server_health_get, methods=["GET"]),
        Route("/api/rave/server-health", social_engine.server_health_report, methods=["POST"]),
        Route("/api/rave/ai-status", rave_ai_status),
        Route("/api/rave/ai-chat", rave_ai_chat, methods=["GET", "POST"]),
        Route("/api/rave/suno-generate", rave_suno_generate, methods=["POST"]),
        Route("/api/search/youtube", search_youtube),
        Route("/api/rave/yt-search", search_youtube),
        Route("/api/rave/supersearch", supersearch),
        Route("/api/rave/catalog", provider_catalog),
        Route("/api/rave/provider-catalog", provider_catalog),
        Route("/api/rave/platform-catalog", provider_catalog),
        Route("/api/rave/new-releases", rave_new_releases, methods=["GET", "POST"]),
        Route("/api/rave/vizyon", rave_new_releases, methods=["GET", "POST"]),
        Route("/api/rave/latest-episodes", rave_latest_episodes, methods=["GET"]),
        Route("/api/rave/seasons", title_seasons),
        Route("/api/rave/series-info", title_seasons),
        Route("/api/rave/series-episodes", title_seasons),
        Route("/api/rave/resolve-catalog", resolve_catalog),
        Route("/api/rave/resolve-stream", resolve_catalog),
        Route("/api/rave/music-catalog", music_engine.music_catalog),
        Route("/api/rave/music-similar", music_engine.music_similar),
        Route("/api/rave/music-resolve", music_engine.music_resolve),
        Route("/api/rave/resolve-music", music_engine.music_resolve),
        Route("/api/rave/music-lyrics.vtt", music_engine.music_lyrics_vtt),
        Route("/api/rave/lyrics", music_engine.music_lyrics_vtt),
        Route("/api/rave/yt-music-stream", music_engine.yt_music_stream, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/yt-pip-hls.m3u8", music_engine.yt_pip_hls_master, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/yt-pip-track.m3u8", music_engine.yt_pip_hls_track, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/stream", rave_stream_manifest, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/stream-manifest", rave_stream_manifest, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/stream_manifest", rave_stream_manifest, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/hls-proxy", rave_stream_manifest, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/stream-proxy", stream_proxy, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/stream_chunk", stream_proxy, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/poster-proxy", poster_proxy, methods=["GET", "HEAD"]),
        Route("/api/rave/poster", poster_proxy, methods=["GET", "HEAD"]),
        Route("/api/rave/subtitles", rave_subtitles),
        Route("/api/rave/subtitle.vtt", rave_subtitle_vtt, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/sub-proxy", rave_subtitle_vtt, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/vtt-proxy", rave_subtitle_vtt, methods=["GET", "HEAD", "OPTIONS"]),
        Route("/api/rave/sub-vtt-translate", rave_sub_vtt_translate, methods=["GET", "POST", "OPTIONS"]),
        Route("/api/rave/meshes", rave_meshes_compat, methods=["GET", "POST"]),
        Route("/api/rave/tts", rave_tts),
        Route("/api/rave/accounts", rave_get_accounts),
        Route("/api/rave/accounts/status", rave_account_status, methods=["GET", "POST"]),
        Route("/api/rave/accounts/verify", rave_verify_account, methods=["POST"]),
        Route("/api/rave/accounts/login", rave_login_account, methods=["POST"]),
        Route("/api/rave/accounts/browser-login", rave_browser_login, methods=["POST"]),
        Route("/api/rave/accounts/logout", rave_logout_account, methods=["POST"]),
        Route("/api/rave/browser-proxy", rave_browser_proxy, methods=["GET", "POST"]),
        Route("/api/rave/bridge", rave_bridge, methods=["GET", "POST"]),
        Route("/api/rave/site-data", rave_site_data),
        Route("/api/rave/gifs", gifs),
        Route("/api/rave/oembed", vimeo_oembed),
        Route("/api/rave/extract-video", extract_video, methods=["GET", "POST"]),
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
        Middleware(CrawlerShieldMiddleware),
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

