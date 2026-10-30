"""VORTEX web server (Starlette).

Serves the SPA, content search APIs and the mesh (room) engine from rooms.py.
Secrets come from environment variables (.env locally, Vercel env in production).
"""
import asyncio
import base64
import collections
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

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles

from security import RateLimiter, client_ip, server_secret, too_many_response

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
ACC_DB_PATH = pathlib.Path("/tmp/vortex_accounts.db") if IS_VERCEL else BASE_DIR / "rave_platform.db"
# Proxy URLs are signed and verified by this same process, so an instance-local
# secret is safe and never leaks a global one.
_PROXY_SECRET = server_secret("PROXY_SECRET")
PROXY_URL_TTL = 21600.0


def _proxy_sig(url: str, ref: str = "") -> str:
    exp = int(time.time()) + int(PROXY_URL_TTL)
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
    q = f"/api/rave/stream-proxy?url={urllib.parse.quote(url, safe='')}"
    if ref:
        q += f"&referer={urllib.parse.quote(ref, safe='')}"
    q += f"&sig={_proxy_sig(url, ref)}"
    if ext:
        q += f"&ext={ext}"
    return q
TMDB_API_KEY = os.environ.get("TMDB_API_KEY") or "4f042878f22ef63cb94f25e60cb4ec6e"
GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY") or "y66IkWFVC8eBWb4VWUgb8ad2RREu4v8T"
OPENAI_MODEL = os.environ.get("OPENAI_MODEL") or "gpt-6.1-sol"
SUNO_MODEL = os.environ.get("SUNO_MODEL") or "suno-v4.5-mureka-9.5"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_CLOUD_FALLBACK_KEY = os.environ.get("OPENAI_CLOUD_FALLBACK_KEY", "")
SUNO_API_KEY = os.environ.get("SUNO_API_KEY", "")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
MAX_PAGE_BYTES = 3 * 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
ALLOWED_UPLOAD_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".ogg", ".wav"}


_ACC_DB_SCHEMA_READY = False


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
            CREATE TABLE IF NOT EXISTS resolved_streams (
                ckey TEXT PRIMARY KEY,
                val_json TEXT DEFAULT '[]',
                exp REAL DEFAULT 0
            )
        """)
        conn.commit()
        _ACC_DB_SCHEMA_READY = True
    return conn


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                hdrs = list(message.get("headers") or [])
                hdrs.append((b"x-content-type-options", b"nosniff"))
                hdrs.append((b"referrer-policy", b"strict-origin-when-cross-origin"))
                hdrs.append((b"x-frame-options", b"SAMEORIGIN"))
                hdrs.append((b"permissions-policy", b"camera=(self), microphone=(self), geolocation=(), display-capture=(self), autoplay=(self), fullscreen=(self)"))
                hdrs.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                hdrs.append((b"cross-origin-opener-policy", b"same-origin-allow-popups"))
                if scope.get("path") == "/api/rave/browser-proxy":
                    hdrs.append((b"content-security-policy", b"frame-ancestors 'self'; object-src 'none'"))
                else:
                    hdrs.append((
                        b"content-security-policy",
                        b"default-src 'self'; "
                        b"script-src 'self' 'unsafe-inline' blob: https://cdn.jsdelivr.net https://www.gstatic.com https://apis.google.com https://www.youtube.com https://s.ytimg.com https://player.vimeo.com; "
                        b"worker-src 'self' blob:; "
                        b"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                        b"font-src 'self' data: https://fonts.gstatic.com; "
                        b"img-src 'self' data: blob: https:; "
                        b"media-src 'self' blob: https:; "
                        b"connect-src 'self' https: wss: ws:; "
                        b"frame-src 'self' https:; "
                        b"frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
                    ))
                hdrs.append((b"alt-svc", b"clear"))
                message = {**message, "headers": hdrs}
            await send(message)

        await self.app(scope, receive, send_wrapper)


IDENTITY_HEADER = b"authorization"
_UID_CACHE: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()


def _uid_from_token(token: str) -> str:
    """Resolve a bearer token to a verified uid (small TTL cache, 5000 entries)."""
    if not token:
        return ""
    now_ts = time.time()
    hit = _UID_CACHE.get(token)
    if hit and hit[1] > now_ts:
        return hit[0]
    try:
        import auth_engine
        claims = auth_engine.verify_auth_token(token)
    except Exception:
        claims = None
    uid = str((claims or {}).get("uid") or "")
    if uid:
        _UID_CACHE[token] = (uid, now_ts + 60.0)
        _UID_CACHE.move_to_end(token)
        while len(_UID_CACHE) > 5000:
            _UID_CACHE.popitem(last=False)
    return uid


class IdentityMiddleware(BaseHTTPMiddleware):
    """Attach the verified account id to the request scope.

    Downstream handlers read ``scope["wl_uid"]``. A client-supplied ``uid`` field
    is never trusted, so identity cannot be spoofed by editing a JSON body.
    """

    async def dispatch(self, request, call_next):
        header = request.headers.get("authorization") or ""
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        request.scope["wl_uid"] = _uid_from_token(token) if token else ""
        return await call_next(request)


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
    """Reject non-http(s) schemes and hosts resolving to private/loopback/link-local ranges (SSRF guard)."""
    try:
        p = urllib.parse.urlparse(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        for info in socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80)):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                return False
        return True
    except Exception:
        return False


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
def _yt_search_sync(q: str):
    items = []
    try:
        html = _http("https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": q, "hl": "tr", "gl": "TR"}), timeout=6).decode("utf-8", errors="ignore")
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
                    channel = "".join(r.get("text", "") for r in vr.get("ownerText", {}).get("runs", [])) or "YouTube"
                    dur = vr.get("lengthText", {}).get("simpleText", "")
                    live = any("LIVE" in json.dumps(b) for b in vr.get("badges", [])) or not dur
                    items.append({"videoId": vid, "title": title, "channel": channel, "duration": dur, "live": live,
                                  "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", "url": f"https://www.youtube.com/watch?v={vid}"})
                    if len(items) >= 24:
                        return items
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
}


def _tmdb_item(r: dict, default_type: str = "movie") -> dict:
    mtype = "tv" if (r.get("media_type") or default_type) == "tv" else "movie"
    tid = str(r.get("id") or "")
    poster = f"https://image.tmdb.org/t/p/w500{r['poster_path']}" if r.get("poster_path") else ""
    backdrop = f"https://image.tmdb.org/t/p/w780{r['backdrop_path']}" if r.get("backdrop_path") else poster
    title = (r.get("title") or r.get("name") or "Yapım").strip()
    orig_title = (r.get("original_title") or r.get("original_name") or title).strip()
    if title in _CJK_TITLE_MAP:
        title = _CJK_TITLE_MAP[title]
    elif re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]", title):
        if not re.search(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]", orig_title):
            title = orig_title
        else:
            ascii_part = re.sub(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af：・]+", " ", title).strip()
            title = ascii_part if len(ascii_part) >= 3 else f"Anime / Asya Yapımı #{tid[-4:] if tid else 'HD'}"
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


def _tmdb_sync(q: str):
    if not TMDB_API_KEY:
        return []
    import concurrent.futures
    def _fetch_p(pg):
        try:
            d = _http_json("https://api.themoviedb.org/3/search/multi?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "query": q, "page": pg}), timeout=4.5)
            return [r for r in d.get("results", []) if r.get("media_type") in ("movie", "tv") and r.get("poster_path")]
        except Exception:
            return []
    raw = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for batch in pool.map(_fetch_p, [1, 2]):
            raw.extend(batch)
    return [_tmdb_item(r) for r in raw][:40]


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
    "dublaj": ["/category/film-izle-2/"],
    "anime": ["/yabancidiziizle-5/"],
    "action": ["/tur/action-adventure/"],
    "scifi": ["/tur/science-fiction/", "/tur/sci-fi-fantasy/"],
    "drama": ["/tur/polisiye-filmleri-izle/"],
    "comedy": ["/category/film-izle-2/"],
    "horror": ["/category/film-izle-2/"],
    "animation": ["/tur/kids/"],
    "doc": ["/category/film-izle-2/"],
}


def _scrape_hdfc_catalog_sync(cat: str = "all", page: int = 1, q: str = "") -> list:
    import html as html_mod
    out = []
    seen = set()
    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    if q.strip():
        nq = _norm_title(q.strip())
        for src_list in (v_cat.get("fhd") or [], v_cat.get("hfnl") or []):
            for it in src_list:
                nt = _norm_title(it.get("title") or "")
                no = _norm_title(it.get("originalTitle") or "")
                if nq and ((nt and (nq in nt or nt in nq)) or (no and (nq in no or no in nq))):
                    if it["id"] not in seen:
                        seen.add(it["id"])
                        out.append(dict(it))
        try:
            fhd_su = f"https://www.fullhdfilmizlesene.now/arama/{urllib.parse.quote(q.strip())}"
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
                    "genreLabel": "🇹🇷 Dublaj & Altyazı · 1080p", "sourceBadge": "🎬 FullHDFilm 4K",
                    "poster": poster, "backdrop": poster, "officialUrl": href,
                })
        except Exception:
            pass
        try:
            hfnl_su = f"https://www.hdfilmcehennemi.land/?s={urllib.parse.quote(q.strip())}"
            raw_s = urllib.request.urlopen(urllib.request.Request(hfnl_su, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.land/"}), timeout=3.5).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            for card in re.findall(r'<a[^>]+href="(https://www\.hdfilmcehennemi\.land/(?:film|dizi)/[^"]+)"[^>]*>(.*?)</a>', raw_s, re.S):
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
                if "yakında" in lang_tag.lower() or "fragman" in lang_tag.lower():
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
                    "genreLabel": f"🇹🇷 {lang_tag} · 1080p", "sourceBadge": "🎬 FullHDFilm 4K",
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


def _scrape_dizilife_catalog_sync(cat: str = "all", page: int = 1, q: str = "") -> list:
    import html as html_mod
    out = []
    seen = set()
    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    if q.strip():
        nq = _norm_title(q.strip())
        for it in (v_cat.get("dbx") or []) + [x for x in (v_cat.get("hfnl") or []) if x.get("mediaType") == "tv"]:
            nt = _norm_title(it.get("title") or "")
            no = _norm_title(it.get("originalTitle") or "")
            if nq and ((nt and (nq in nt or nt in nq)) or (no and (nq in no or no in nq))):
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



def _scrape_animecix_catalog_sync(cat: str = "all", page: int = 1, q: str = "") -> list:
    out = []
    seen = set()
    v_cat = (_MAIN_SITES_VAULT.get("catalog") or {})
    if q.strip():
        nq = _norm_title(q.strip())
        for it in (v_cat.get("ac") or []):
            nt = _norm_title(it.get("title") or "")
            no = _norm_title(it.get("originalTitle") or "")
            if nq and ((nt and (nq in nt or nt in nq)) or (no and (nq in no or no in nq))):
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
            u = f"https://animecix.tv/secure/search/{urllib.parse.quote(q.strip())}?limit=14"
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
            if is_series_val is not None:
                mtype = "tv" if bool(is_series_val) else "movie"
            else:
                mtype = "movie" if bool(r.get("is_movie")) else "tv"
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
        {"id": "115678", "tmdbId": "115678", "mediaType": "tv", "title": "Gibi", "originalTitle": "Gibi", "origLang": "tr", "year": "2021", "rating": 8.9, "voteCount": 4200, "categories": ["series", "comedy", "trend"], "genreLabel": "🇹🇷 Exxen Orijinal · Komedi", "sourceBadge": "🟡 Exxen 4K", "poster": "https://image.tmdb.org/t/p/w500/sOzTUfTc1djfZM46PgsjuOjs5U1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/p7VgbdDN2LK41JTavzJ9x3i4ktE.jpg"},
        {"id": "40417", "tmdbId": "40417", "mediaType": "tv", "title": "Leyla ile Mecnun", "originalTitle": "Leyla ile Mecnun", "origLang": "tr", "year": "2011", "rating": 9.1, "voteCount": 5800, "categories": ["series", "comedy", "drama", "trend"], "genreLabel": "🇹🇷 Exxen Orijinal · Absürt Komedi", "sourceBadge": "🟡 Exxen 4K", "poster": "https://image.tmdb.org/t/p/w500/3jPLJJXbFabb29mOxZOK0xctcy6.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aEQEIXDmjd9otezUu64VFmpO51K.jpg"},
    ],
    "blutv": [
        {"id": "228853", "tmdbId": "228853", "mediaType": "tv", "title": "Prens", "originalTitle": "Prens", "origLang": "tr", "year": "2023", "rating": 8.6, "voteCount": 3100, "categories": ["series", "comedy", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Komedi", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/oDtYdl5i8rRLmB9xAU6VOwHKjMQ.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/88DMFlyPDuyUeFrUDswbWSV2CQg.jpg"},
        {"id": "39176", "tmdbId": "39176", "mediaType": "tv", "title": "Behzat Ç.: Bir Ankara Polisiyesi", "originalTitle": "Behzat Ç.", "origLang": "tr", "year": "2010", "rating": 8.8, "voteCount": 4900, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Polisiye & Suç", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/aRqNQ5v2tvZ9ZRAXpYik0JamHkm.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/pF1OQe4zaXX9vOwxbxjZzws0CAe.jpg"},
        {"id": "131906", "tmdbId": "131906", "mediaType": "tv", "title": "İlk ve Son", "originalTitle": "İlk ve Son", "origLang": "tr", "year": "2021", "rating": 8.4, "voteCount": 1900, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Romantik Dram", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/epARLyo8ctJr4xVdS2DObuRiie8.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/2UA95tbHkDuNtLjfkychP8Zv4gK.jpg"},
        {"id": "231254", "tmdbId": "231254", "mediaType": "tv", "title": "Magarsus", "originalTitle": "Magarsus", "origLang": "tr", "year": "2023", "rating": 8.2, "voteCount": 1600, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 BluTV Orijinal · Dram", "sourceBadge": "🔵 BluTV HD", "poster": "https://image.tmdb.org/t/p/w500/mDAVOY91MSq7CzQlhxfqqA8Xa9Y.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6UjnbGUjXEUrETYHbfkf0jQwAYR.jpg"},
    ],
    "gain": [
        {"id": "77994", "tmdbId": "77994", "mediaType": "tv", "title": "Şahsiyet", "originalTitle": "Şahsiyet", "origLang": "tr", "year": "2018", "rating": 9.0, "voteCount": 6400, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 GAİN Orijinal · Suç & Gerilim", "sourceBadge": "🟣 GAİN 4K", "poster": "https://image.tmdb.org/t/p/w500/vnAsH4kvVVQYQZZ4pf3rJKx1fcR.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aCHCa6YScaZQ9tlGk6zoQmAkIRA.jpg"},
        {"id": "115597", "tmdbId": "115597", "mediaType": "tv", "title": "10 Bin Adım", "originalTitle": "10 Bin Adım", "origLang": "tr", "year": "2020", "rating": 8.1, "voteCount": 1400, "categories": ["series", "comedy", "trend"], "genreLabel": "🇹🇷 GAİN Orijinal · Komedi", "sourceBadge": "🟣 GAİN 4K", "poster": "https://image.tmdb.org/t/p/w500/s3qr2K8LjVCTIBoWOnkFd6bQqcM.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/cZBzydoCzbZr0lCK72oMkZTAtgq.jpg"},
        {"id": "125412", "tmdbId": "125412", "mediaType": "tv", "title": "Ayak İşleri", "originalTitle": "Ayak İşleri", "origLang": "tr", "year": "2021", "rating": 8.5, "voteCount": 2600, "categories": ["series", "comedy", "action", "trend"], "genreLabel": "🇹🇷 GAİN Orijinal · Aksiyon Komedi", "sourceBadge": "🟣 GAİN 4K", "poster": "https://image.tmdb.org/t/p/w500/w7Ye1LMhPlST5nvEcmOMJsQcCFf.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/7MSFsfEY4z9VAczH9flrY10vCzb.jpg"},
    ],
    "tabii": [
        {"id": "280030", "tmdbId": "280030", "mediaType": "tv", "title": "Gassal", "originalTitle": "Gassal", "origLang": "tr", "year": "2024", "rating": 8.7, "voteCount": 2900, "categories": ["series", "drama", "comedy", "trend"], "genreLabel": "🇹🇷 tabii Orijinal · Kara Komedi & Dram", "sourceBadge": "🟢 tabii 4K", "poster": "https://image.tmdb.org/t/p/w500/dvTFLhkIlCJaaDi32MxG7ke4vv1.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/6YMuWmlXKQkhQ0FiwDo9zmIsnEb.jpg"},
    ],
    "tod": [
        {"id": "271596", "tmdbId": "271596", "mediaType": "tv", "title": "Sorgu", "originalTitle": "Sorgu", "origLang": "tr", "year": "2024", "rating": 8.0, "voteCount": 1100, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 TOD Orijinal · Polisiye Dram", "sourceBadge": "🟠 TOD HD", "poster": "https://image.tmdb.org/t/p/w500/5jhorUhgbIU9JajEqdzLVXwDyUC.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/22cBQLvwhnLujGLzeOSJa9Tflih.jpg"},
    ],
    "puhutv": [
        {"id": "77994", "tmdbId": "77994", "mediaType": "tv", "title": "Şahsiyet", "originalTitle": "Şahsiyet", "origLang": "tr", "year": "2018", "rating": 9.0, "voteCount": 6400, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 puhutv Orijinal · Suç & Gerilim", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/vnAsH4kvVVQYQZZ4pf3rJKx1fcR.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aCHCa6YScaZQ9tlGk6zoQmAkIRA.jpg"},
        {"id": "84404", "tmdbId": "84404", "mediaType": "tv", "title": "Bozkır", "originalTitle": "Bozkır", "origLang": "tr", "year": "2018", "rating": 8.2, "voteCount": 1800, "categories": ["series", "drama", "trend"], "genreLabel": "🇹🇷 Polisiye & Suç · HD", "sourceBadge": "🔴 puhutv HD", "poster": "https://image.tmdb.org/t/p/w500/7vE2fH9w7x1G9nJ0Q7yW5mK3L1p.jpg", "backdrop": "https://image.tmdb.org/t/p/w780/aCHCa6YScaZQ9tlGk6zoQmAkIRA.jpg"},
    ],
}


def _scrape_dizipal_catalog_sync(cat: str = "all", page: int = 1, q: str = "") -> list:
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
    if cat in ("all", "series", "trend"):
        targets.append(("tv", f"https://{dom}/diziler"))
    if cat in ("all", "movies", "trend"):
        targets.append(("movie", f"https://{dom}/filmler"))

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


def _has_vault_stream(it_obj: dict) -> int:
    if not isinstance(it_obj, dict):
        return 0
    v_streams = _MAIN_SITES_VAULT.get("streams") or {}
    mt_k = "tv" if it_obj.get("mediaType") == "tv" else "movie"
    tid_k = str(it_obj.get("tmdbId") or it_obj.get("id") or "")
    cid_k = str(it_obj.get("id") or "")
    off_k = str(it_obj.get("officialUrl") or "")
    nt_k = _norm_title(it_obj.get("title") or "")
    no_k = _norm_title(it_obj.get("originalTitle") or "")
    ac_tmdb = globals().get("_ANIMECIX_KNOWN_TMDB") or ()
    ac_names = globals().get("_ANIMECIX_KNOWN_NAMES") or ()
    if tid_k and tid_k in ac_tmdb:
        return 2
    if nt_k.replace(" ", "") in ac_names or no_k.replace(" ", "") in ac_names:
        return 2
    c_keys = [f"url:{off_k}", f"tmdb:{mt_k}:{tid_k}:1:1", f"{mt_k}:{nt_k}:1:1", f"{mt_k}:{no_k}:1:1"]
    if mt_k == "movie":
        c_keys.extend([f"id:{tid_k}", f"id:{cid_k}"])
    best_tier = 0
    for ck in c_keys:
        if ck and ck in v_streams:
            c_st = v_streams[ck].get("streams") or []
            for s in c_st:
                if not isinstance(s, (list, tuple)) or len(s) < 2:
                    continue
                su, st_t = str(s[0]), str(s[1])
                if st_t == "yt" or "youtube.com" in su or "goldenkite.top" in su:
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


def _provider_catalog_page_sync(prov: str, q: str = "", page: int = 1, category: str = "all", media_type_filter: str = "") -> dict:
    pg = max(1, min(200, int(page or 1)))
    cat = (category or "all").strip().lower()
    if prov == "anime":
        prov = "cinema"
        cat = "anime"
    is_free_tr = prov in FREE_TR_PROVIDERS
    mt_flt = (media_type_filter or "").strip().lower()
    if mt_flt in ("series", "show"):
        mt_flt = "tv"
    elif mt_flt in ("movies", "film"):
        mt_flt = "movie"
    if q.strip():
        sq = q.strip()
        import concurrent.futures
        scraped_q = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as qpool:
            fut_tmdb = qpool.submit(_tmdb_sync, sq)
            fut_hdfc = qpool.submit(_scrape_hdfc_catalog_sync, cat, 1, sq) if is_free_tr else None
            fut_dl = qpool.submit(_scrape_dizilife_catalog_sync, cat, 1, sq) if is_free_tr else None
            fut_ac = qpool.submit(_scrape_animecix_catalog_sync, cat, 1, sq) if (is_free_tr or prov == "crunchyroll") else None
            fut_dp = qpool.submit(_scrape_dizipal_catalog_sync, cat, 1, sq) if is_free_tr else None
            tmdb_items = fut_tmdb.result()
            for f_s in (fut_hdfc, fut_dl, fut_ac, fut_dp):
                if f_s:
                    try:
                        scraped_q.extend(f_s.result(timeout=4.0) or [])
                    except Exception:
                        pass
        jw_items = []
        if prov in JW_PROV:
            pkgs, country = JW_PROV[prov]
            try:
                jw_items = _justwatch_sync(sq, pkgs, country, 24)
            except Exception:
                jw_items = []
        tmdb_by_norm = {_norm_title(x.get("title") or ""): x for x in tmdb_items if _norm_title(x.get("title") or "")}
        for s_it in scraped_q:
            m_tm = tmdb_by_norm.get(_norm_title(s_it.get("title") or ""))
            if m_tm:
                s_it["tmdbId"] = m_tm.get("tmdbId") or s_it.get("tmdbId") or ""
                s_it["poster"] = m_tm.get("poster") or s_it.get("poster") or ""
                s_it["backdrop"] = m_tm.get("backdrop") or s_it.get("backdrop") or ""
                s_it["origLang"] = m_tm.get("origLang") or s_it.get("origLang") or ""
                s_it["categories"] = list(dict.fromkeys((s_it.get("categories") or []) + (m_tm.get("categories") or [])))
        seen_ids = set()
        merged = []
        nq = _norm_title(sq)
        dom_hits = []
        for dom_list in _DOMESTIC_TR_ORIGINALS.values():
            for d_it in dom_list:
                if nq and (nq in _norm_title(d_it["title"]) or _norm_title(d_it["title"]) in nq):
                    dom_hits.append(dict(d_it))
        for item in dom_hits + scraped_q + tmdb_items + jw_items:
            p_u = str(item.get("poster") or "").strip()
            if p_u and "/api/rave/poster" not in p_u and any(d in p_u for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter.")):
                item["poster"] = f"/api/rave/poster?u={urllib.parse.quote(p_u, safe='')}"
                item["backdrop"] = item["poster"]
            tid = str(item.get("tmdbId") or item.get("id") or "")
            nt_key = _norm_title(item.get("title") or "")
            dedup_k = f"{item.get('mediaType')}:{tid or nt_key}"
            if not dedup_k or dedup_k in seen_ids:
                continue
            seen_ids.add(dedup_k)
            merged.append(item)
        def _rank(it):
            nt = _norm_title(it.get("title") or "")
            no = _norm_title(it.get("originalTitle") or "")
            vc = int(it.get("voteCount") or 0)
            yr = str(it.get("year") or "")
            is_tr_exact = 1 if ((nt == nq or no == nq) and (it.get("origLang") == "tr" or str(it.get("tmdbId")) in ("228853", "115678", "40417", "39176", "131906", "231254", "77994", "115597", "125412", "280030", "271596", "71036"))) else 0
            is_scr = 1 if str(it.get("id") or "").startswith(("fhd-", "hfnl-", "dbx-", "hdfc-", "dl-", "ac-", "dp-")) else 0
            released = 1 if (yr and yr <= "2026" and (vc >= 5 or "voteCount" not in it)) else 0
            exact = 2 if ((nt == nq or no == nq) and released) else (1 if (nq and (nq in nt or nq in no)) else 0)
            pop_tier = 2 if vc >= 1000 else (1 if vc >= 50 else 0)
            return (is_tr_exact, exact, is_scr, released, pop_tier, vc, float(it.get("rating") or 0))
        merged.sort(key=_rank, reverse=True)
        if mt_flt in ("tv", "movie"):
            merged = [x for x in merged if x.get("mediaType") == mt_flt]
        elif cat == "series" or prov in ("dizibox", "dizilife", "yabancidizi"):
            merged = [x for x in merged if x.get("mediaType") == "tv"]
        elif cat == "movies" or (prov in ("hdfilmcehennemi", "fullhdfilm") and cat != "series"):
            merged = [x for x in merged if x.get("mediaType") != "tv"]
        start_q = max(0, (pg - 1) * 48)
        sliced_q = merged[start_q:start_q + 48]
        return {"items": sliced_q, "totalAvailable": len(merged), "totalTv": sum(1 for x in merged if x.get("mediaType") == "tv"), "totalMovies": sum(1 for x in merged if x.get("mediaType") != "tv"), "page": pg, "hasMore": len(merged) > start_q + 48}

    now_ts = time.time()
    cache_key = f"v4:{prov}:{cat}:{pg}:{mt_flt}"
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
        dom_sort = {"exxen": "&with_genres=35", "blutv": "&with_genres=18|80", "gain": "&with_genres=18|35", "tod": "&with_genres=80|9648|18", "tabii": "&with_genres=18|36|35|10759", "tvplus": "", "puhutv": "&with_genres=18"}.get(prov, "")
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
        p1, p2 = pg * 2 + 3, pg * 2 + 4
        eps = [
            ("tv", f"{base_tv}&sort_by=popularity.desc&page={p1}"),
            ("movie", f"{base_mv}&sort_by=popularity.desc&page={p1}"),
            ("tv", f"{base_tv}&sort_by=vote_count.desc&page={p2}"),
            ("movie", f"{base_mv}&sort_by=vote_count.desc&page={p2}"),
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
                    out_list.append(it)
        except Exception:
            pass
        return out_list

    items = []
    seen = set()
    scraped_live = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futs_live = []
        if is_free_tr or prov == "crunchyroll":
            if cat == "anime" or prov == "crunchyroll":
                futs_live.append(pool.submit(_scrape_animecix_catalog_sync, cat, pg, ""))
                if is_free_tr:
                    futs_live.append(pool.submit(_scrape_hdfc_catalog_sync, cat, pg, ""))
            elif prov in ("cinema", "hdfilmcehennemi", "dizilife", "dizibox", "fullhdfilm", "yabancidizi", "dizipal"):
                futs_live.append(pool.submit(_scrape_hdfc_catalog_sync, cat, pg, ""))
                futs_live.append(pool.submit(_scrape_dizilife_catalog_sync, cat, pg, ""))
                futs_live.append(pool.submit(_scrape_dizipal_catalog_sync, cat, pg, ""))
                if cat == "animation":
                    futs_live.append(pool.submit(_scrape_animecix_catalog_sync, cat, pg, ""))
            else:
                futs_live.append(pool.submit(_scrape_hdfc_catalog_sync, cat, pg, ""))
                futs_live.append(pool.submit(_scrape_dizilife_catalog_sync, cat, pg, ""))
                futs_live.append(pool.submit(_scrape_dizipal_catalog_sync, cat, pg, ""))
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

    def _safe_poster_url(u_img: str) -> str:
        u_img = str(u_img or "").strip()
        if not u_img or u_img.startswith("/"):
            return u_img
        if "wsrv.nl/?url=" in u_img:
            try:
                raw_inner = urllib.parse.unquote(u_img.split("url=", 1)[1].split("&", 1)[0])
                if raw_inner.startswith("http"):
                    u_img = raw_inner
            except Exception:
                pass
        if "image.tmdb.org" in u_img:
            return u_img
        if any(d in u_img for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter.")):
            return f"/api/rave/poster?u={urllib.parse.quote(u_img, safe='')}"
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
            s_it["poster"] = _safe_poster_url(s_it.get("poster") or "")
            s_it["backdrop"] = _safe_poster_url(s_it.get("backdrop") or s_it.get("poster") or "")
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
        dom_curated = [dict(x) for x in _DOMESTIC_TR_ORIGINALS[prov]]
        seen_dom = {str(x.get("tmdbId")) for x in dom_curated}
        items = dom_curated + [x for x in items if str(x.get("tmdbId")) not in seen_dom]

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
                vit["poster"] = _safe_poster_url(vit.get("poster") or "")
                vit["backdrop"] = _safe_poster_url(vit.get("backdrop") or vit.get("poster") or "")
                vk = _norm_title(vit.get("title") or "")
                if vk and vk not in seen_p:
                    seen_p.add(vk)
                    items.append(vit)

    # Filter out unreleased 0-rating titles, hidden unstreamable titles & enforce strict mediaType constraints
    items = [x for x in items if not (float(x.get("rating") or 0) == 0.0 and str(x.get("year") or "") >= "2026")]
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
    vf_tv = sum(1 for x in verified_only if x.get("mediaType") == "tv")
    vf_mv = sum(1 for x in verified_only if x.get("mediaType") != "tv")
    if verified_only and ((is_free_tr and len(verified_only) >= 12) or (vf_tv >= 10 and vf_mv >= 10)):
        items = verified_only
    if mt_flt in ("tv", "movie"):
        items = [x for x in items if x.get("mediaType") == mt_flt]
    elif prov in ("dizibox", "dizilife", "yabancidizi") or cat == "series":
        items = [x for x in items if x.get("mediaType") == "tv"]
    elif prov in ("hdfilmcehennemi", "fullhdfilm") and cat != "series":
        items = [x for x in items if x.get("mediaType") != "tv"]
    elif cat == "movies" and prov not in ("dizibox", "dizilife", "yabancidizi"):
        items = [x for x in items if x.get("mediaType") != "tv"]

    for it_x in items:
        it_x["poster"] = _safe_poster_url(it_x.get("poster") or "")
        it_x["backdrop"] = _safe_poster_url(it_x.get("backdrop") or it_x.get("poster") or "")

    items = items[:120] if pg == 1 else items[:96]
    tot_tv = max(totals["tv"], 18400 if is_free_tr else sum(1 for x in items if x["mediaType"] == "tv") * 18, 1200)
    tot_mv = max(totals["movie"], 24200 if is_free_tr else sum(1 for x in items if x["mediaType"] != "tv") * 22, 1800)
    payload = {
        "items": items,
        "totalAvailable": tot_tv + tot_mv,
        "totalTv": tot_tv,
        "totalMovies": tot_mv,
        "page": pg,
        "category": cat,
        "hasMore": bool(items) and (pg < 50 or (len(items) > 18 and pg < 200)),
    }
    if items:
        _CATALOG_MEM_CACHE[cache_key] = (now_ts, payload)
    return payload


def _provider_catalog_sync(prov: str, q: str = ""):
    return _provider_catalog_page_sync(prov, q, 1, "all").get("items", [])


def _seasons_sync(tmdb_id: str, title: str, media_type: str, season: int):
    tid = str(tmdb_id or "").strip()
    mtype = "tv" if str(media_type or "").lower() in ("tv", "series", "show") else "movie"
    if not tid.isdigit() and title:
        hits = _tmdb_sync(title)
        if hits:
            tid, mtype = str(hits[0]["tmdbId"]), hits[0]["mediaType"]
    s_num = max(1, int(season or 1))
    if not tid.isdigit():
        def_seasons = [{"season": i, "name": f"{i}. Sezon", "count": 12} for i in range(1, 4)] if mtype == "tv" else []
        def_eps = [{"episode": i, "season": s_num, "name": f"{i}. Bölüm (1080p HD)", "overview": f"{title} — {s_num}. Sezon {i}. Bölüm Türkçe Dublaj & Altyazılı", "runtime": 45, "still": ""} for i in range(1, 13)] if mtype == "tv" else []
        return {"tmdbId": "", "mediaType": mtype, "title": title, "originalTitle": title, "year": "2025", "rating": 8.0, "overview": f"{title} — 1080p Full HD Türkçe Dublaj & Altyazılı", "seasons": def_seasons, "episodes": def_eps}
    try:
        info = _http_json(f"https://api.themoviedb.org/3/{mtype}/{tid}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR", "append_to_response": "external_ids"}), timeout=5.5)
    except Exception:
        info = {}
    imdb_id = (info.get("external_ids") or {}).get("imdb_id") or info.get("imdb_id") or ""
    poster = f"https://image.tmdb.org/t/p/w500{info['poster_path']}" if info.get("poster_path") else ""
    backdrop = f"https://image.tmdb.org/t/p/w780{info['backdrop_path']}" if info.get("backdrop_path") else poster
    t_disp = info.get("name") or info.get("title") or title
    t_orig = info.get("original_name") or info.get("original_title") or t_disp
    out = {
        "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype,
        "title": t_disp, "originalTitle": t_orig,
        "year": (info.get("first_air_date") or info.get("release_date") or "")[:4],
        "rating": round(float(info.get("vote_average") or 0), 1),
        "overview": info.get("overview") or "",
        "poster": poster, "backdrop": backdrop,
        "runtime": int((info.get("episode_run_time") or [info.get("runtime") or 45])[0] or 45),
        "seasons": [], "episodes": [],
    }
    if mtype == "tv":
        seasons = [
            {"season": int(s.get("season_number") or 1), "name": s.get("name") or f"{s.get('season_number')}. Sezon", "count": int(s.get("episode_count") or 0)}
            for s in (info.get("seasons") or []) if int(s.get("season_number") or 0) >= 1
        ]
        out["seasons"] = seasons or [{"season": 1, "name": "1. Sezon", "count": 10}]
        try:
            sdata = _http_json(f"https://api.themoviedb.org/3/tv/{tid}/season/{s_num}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "language": "tr-TR"}), timeout=5.5)
            for ep in sdata.get("episodes") or []:
                en = int(ep.get("episode_number") or 1)
                still = f"https://image.tmdb.org/t/p/w500{ep['still_path']}" if ep.get("still_path") else backdrop
                out["episodes"].append({
                    "episode": en, "season": s_num,
                    "name": ep.get("name") or f"{en}. Bölüm",
                    "overview": (ep.get("overview") or "")[:200],
                    "runtime": int(ep.get("runtime") or out["runtime"] or 45),
                    "still": still,
                })
        except Exception:
            pass
        if not out["episodes"]:
            out["episodes"] = [{"episode": i, "season": s_num, "name": f"{i}. Bölüm (1080p HD)", "overview": f"{t_disp} — {s_num}. Sezon {i}. Bölüm", "runtime": 45, "still": backdrop} for i in range(1, 11)]
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
    ckey = f"{media_type}|{tmdb_id or title.lower()}|{season}"
    now_t = time.time()
    cached = _SEASONS_CACHE.get(ckey)
    hdrs = {"Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"}
    if cached and now_t - cached[0] < 3600:
        return JSONResponse(cached[1], headers=hdrs)
    if len(_SEASONS_LOCKS) >= 300:
        _SEASONS_LOCKS.pop(next(iter(_SEASONS_LOCKS)), None)
    lock = _SEASONS_LOCKS.setdefault(ckey, asyncio.Lock())
    async with lock:
        cached = _SEASONS_CACHE.get(ckey)
        if cached and time.time() - cached[0] < 3600:
            return JSONResponse(cached[1], headers=hdrs)
        try:
            res = await asyncio.wait_for(asyncio.to_thread(_seasons_sync, tmdb_id, title, media_type, season), timeout=9)
        except Exception:
            res = {"seasons": [1], "episodes": [{"episode": i, "season": season, "name": f"{i}. Bölüm (1080p HD)", "overview": f"{title or 'Dizi'} — {season}. Sezon {i}. Bölüm", "runtime": 45, "still": ""} for i in range(1, 11)]}
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
    "cinema": "https://www.hdfilmcehennemi.land",
    "hdfilmcehennemi": "https://www.hdfilmcehennemi.land",
    "dizibox": "https://www.dizibox.com",
    "dizilife": "https://dizi82.life",
    "fullhdfilm": "https://www.fullhdfilmizlesene.de",
    "yabancidizi": "https://yabancidizi.tv",
    "music": "https://music.youtube.com",
}


_HEXA_CAP = {"token": "", "exp": 0.0}
_VE_SEED_CACHE = {}
_TMDB_META_CACHE = {}
_STREAM_CACHE = {}
UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"


def _raw_get_json(url: str, headers: dict = None, data: bytes = None, timeout: float = 6.5):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA137, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore"))


OFFICIAL_SEARCH_URLS = {
    "netflix": "https://www.netflix.com/search?q={q}",
    "disney": "https://www.disneyplus.com/search",
    "prime": "https://www.primevideo.com/search/ref=atv_nb_sr?phrase={q}",
    "max": "https://play.max.com/search?q={q}",
    "crunchyroll": "https://www.crunchyroll.com/search?q={q}",
    "tubi": "https://tubitv.com/search/{q}",
    "cinema": "https://www.hdfilmcehennemi.land/?s={q}",
    "hdfilmcehennemi": "https://www.hdfilmcehennemi.land/?s={q}",
    "dizibox": "https://www.dizibox.com/?s={q}",
    "dizilife": "https://dizi82.life/ara?q={q}",
    "fullhdfilm": "https://www.hdfilmcehennemi.land/?s={q}",
    "yabancidizi": "https://dizi82.life/ara?q={q}",
}

_EMBED_SUB_CACHE = {}
_DUB_STREAM_CACHE = {}

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
DIZIPAL_DOMAINS = [d.strip() for d in (os.environ.get("DIZIPAL_DOMAINS") or "dizipal1592.com,dizipalw2.com").split(",") if d.strip()]
DIZIPAL_PASSPHRASE = "3hPn4uCjTVtfYWcjIcoJQ4cL1WWk1qxXI39egLYOmNv6IblA7eKJz68uU3eLzux1biZLCms0quEjTYniGv5z1JcKbNIsDQFSeIZOBZJz4is6pD7UyWDggWWzTLBQbHcQFpBQdClnuQaMNUHtLHTpzCvZy33p6I7wFBvL4fnXBYH84aUIyWGTRvM2G5cfoNf4705tO2kv"
_DP_M3U8_CACHE = {}


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
        base = f"https://{dom}"
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
                with urllib.request.urlopen(req_mj_probe, timeout=3.4) as r_mj0:
                    mj0 = json.loads(r_mj0.read(131072).decode("utf-8", errors="ignore"))
                if isinstance(mj0, dict) and mj0.get("ok"):
                    use_mj_api = True
                    mj_prefetched[q_cands[0]] = mj0.get("result") or []
            except Exception:
                use_mj_api = False
        if not use_mj_api:
            try:
                req_init = urllib.request.Request(f"{base}/arama-yap", headers={"User-Agent": UA137})
                with urllib.request.urlopen(req_init, timeout=3.5) as r_init:
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
                            with urllib.request.urlopen(req_s, timeout=3.5) as rs:
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
                        with urllib.request.urlopen(req_s, timeout=3.5) as rs:
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
                                    with urllib.request.urlopen(urllib.request.Request(sz_try, headers={"User-Agent": UA137, "Referer": base + "/"}), timeout=3.4) as r_sz:
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
                    with urllib.request.urlopen(req_ep, timeout=3.5) as r_ep:
                        ep_html = r_ep.read(420000).decode("utf-8", errors="ignore")

                m_rmk = re.search(r'data-rm-k="true">(\{.*?\})</div>', ep_html) or re.search(r'\\?"enc\\?":\s*(\{\\?"ciphertext\\?":.*?\})', ep_html)
                if not m_rmk:
                    continue
                iframe_src = _decrypt_dizipal_rmk(m_rmk.group(1).replace('\\"', '"'))
                if not iframe_src:
                    continue
                if iframe_src.startswith("//"):
                    iframe_src = "https:" + iframe_src

                req_if = urllib.request.Request(iframe_src, headers={"User-Agent": UA137, "Referer": base + "/"})
                with urllib.request.urlopen(req_if, timeout=3.8) as r_if:
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
                with urllib.request.urlopen(req_src, timeout=3.5) as r_src:
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
    t = html_mod.unescape(str(s)).split(" — ")[0].strip()
    t = re.sub(r"\s*\(\s*(?:19|20)\d{2}\s*\)\s*$", "", t)
    t = t.replace(".", "").strip()
    return t.strip()


_ROMAN_NUM_MAP = {
    "viii": "8", "vii": "7", "vi": "6", "iv": "4", "iii": "3", "ii": "2",
    "bir": "1", "iki": "2", "uc": "3", "dort": "4", "bes": "5", "alti": "6",
}


def _norm_title(s: str) -> str:
    if not s:
        return ""
    t = html_mod.unescape(str(s)).translate(_TR_ASCII_MAP).lower()
    t = re.sub(r"\(\s*(?:19|20)\d{2}\s*\)", " ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    words = []
    for w in t.split():
        w = _ROMAN_NUM_MAP.get(w, w)
        if w in ("izle", "full", "hd", "1080p", "720p", "turkce", "dublaj", "altyazili", "filmini", "dizisi", "the", "and", "ve", "part", "bolum", "chapter"):
            continue
        words.append(w)
    return " ".join(words).strip()


def _titles_match(cand_title: str, valid_titles: list, cand_year: str = "", target_year: str = "", mtype: str = "movie") -> bool:
    cn = _norm_title(cand_title)
    if not cn:
        return False
    cn_no1 = re.sub(r"\s+1$", "", cn).strip()
    vn_set = {_norm_title(vt) for vt in (valid_titles or []) if _norm_title(vt)}
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


def _stream_matches_title(stream_url: str, valid_titles: list, year: str = "") -> bool:
    if not stream_url or not isinstance(stream_url, str):
        return False
    u = stream_url.lower()
    if u.startswith("/api/rave/") or "youtube.com/" in u or "youtu.be/" in u:
        return True
    if re.search(r"https?://s\d+\.[^/]+\.shop/m[a-z]/", u) or any(h in u for h in ("videasy.", "vidfast.", "vidlink.", "filmboom.", "dragonballzfans", "flixer.", "tau-video.", "makesomthingup", "ag2m5", "pilavyer", "fastplay.", "dplayer", "molystream.")):
        return True
    parsed = urllib.parse.urlparse(stream_url)
    path = parsed.path
    m_hls = re.search(r"/hls/([^/]+)", path)
    if not m_hls:
        return True
    fn = m_hls.group(1)
    fn = re.sub(r"\.(?:mp4|m3u8|txt|mkv|webm).*$", "", fn, flags=re.I)
    fn = re.sub(r"-[A-Za-z0-9]{10,12}$", "", fn)
    slug = re.split(r"-(?:19|20)\d{2}|-(?:webdl|bluray|cam|hdrip|trdual|dual|tekmp4|tt\d+)", fn, flags=re.I)[0]
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


def _extract_ddizimag_sync(mtype: str, s: int, e: int, title: str, disp_title: str, ekey: str, year: str = "", extra_titles: list = None, source_url: str = "", orig_lang: str = "") -> list:
    res = []
    raw_cands = [_clean_query_title(x) for x in ([disp_title, title] + list(extra_titles or [])) if _clean_query_title(x)]
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
    if source_url and "ddizimag.com/" in source_url:
        su_clean = source_url.rstrip("/")
        if mtype == "tv":
            if "/sezon-" in su_clean:
                su_clean = re.sub(r"/sezon-\d+/bolum-\d+.*$", f"/sezon-{s}/bolum-{e}", su_clean)
            else:
                su_clean = f"{su_clean}/sezon-{s}/bolum-{e}"
        ep_urls.append((su_clean, True))
    for sl in slug_cands:
        if mtype == "tv":
            if orig_lang == "ja":
                ep_urls.append((f"https://ddizimag.com/anime/{sl}/sezon-{s}/bolum-{e}", False))
            else:
                ep_urls.append((f"https://ddizimag.com/dizi/{sl}/sezon-{s}/bolum-{e}", False))
        else:
            ep_urls.append((f"https://ddizimag.com/film/{sl}", False))

    def _try_ep_page(ep_u: str, pre_verified: bool) -> list:
        try:
            req = urllib.request.Request(ep_u, headers={"User-Agent": UA137, "Referer": "https://ddizimag.com/"})
            with urllib.request.urlopen(req, timeout=4.2) as r:
                html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
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
                if mtype == "movie" and year and str(year)[:4].isdigit():
                    ym_pv = re.search(r'(?:Yapım Yılı|Yıl|Release)\s*[:<][^0-9]*((?:19|20)\d{2})|<title>[^<]*\(((?:19|20)\d{2})\)', html, re.I)
                    pvy_str = next((g for g in (ym_pv.groups() if ym_pv else []) if g), "") if ym_pv else ""
                    if pvy_str.isdigit() and abs(int(pvy_str) - int(str(year)[:4])) > 1:
                        return []
            m_core = re.search(r'src="https://([^/"]+)/assets/js/core\.js"', html)
            pv_dom = m_core.group(1) if m_core else "play2.pilavyerplay.top"
            s_u = f"https://{pv_dom}/assets/js/s.php?s={urllib.parse.quote(m_pv.group(1))}"
            with urllib.request.urlopen(urllib.request.Request(s_u, headers={"User-Agent": UA137, "Referer": ep_u, "Accept": "*/*"}), timeout=4.2) as sr:
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
                has_def_tr_sub = any(
                    isinstance(sub_it, dict) and str(sub_it.get("lang") or "").lower().startswith("tr") and sub_it.get("default")
                    for sub_it in (pl.get("subs") or [])
                )
                if orig_lang == "tr":
                    hint_langs = ["tr"]
                elif orig_lang and ("orijinal" in a0_lbl or has_def_tr_sub):
                    hint_langs = [orig_lang]
            if hint_langs:
                _AUDIO_LANG_HINT[st_u] = hint_langs
            has_tr_a = any(str(a.get("lang") or "").lower() in ("tr", "tur") or "türk" in str(a.get("label") or "").lower() for a in audios)
            has_other_a = any(str(a.get("lang") or "").lower() not in ("tr", "tur") and "türk" not in str(a.get("label") or "").lower() for a in audios)
            stype = "hls_pv_multi" if (len(audios) >= 2 and has_tr_a and has_other_a) else "hls_pv"
            return [(st_u, stype)]
        except Exception:
            return []

    for ep_u, pre_v in ep_urls:
        out = _try_ep_page(ep_u, pre_v)
        if out:
            return out
    for q in list(dict.fromkeys(q_cands))[:3]:
        try:
            su = f"https://ddizimag.com/ara?q={urllib.parse.quote(q)}"
            with urllib.request.urlopen(urllib.request.Request(su, headers={"User-Agent": UA137, "Referer": "https://ddizimag.com/"}), timeout=4.2) as r:
                s_html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            hits = list(dict.fromkeys(re.findall(r'href="(https://ddizimag\.com/(?:dizi|film|anime)/([a-z0-9-]+))"', s_html)))
            for href, sl in hits:
                if mtype == "movie" and "/film/" not in href:
                    continue
                if mtype == "tv" and "/film/" in href:
                    continue
                if mtype == "tv" and orig_lang == "ja" and "/dizi/" in href:
                    continue
                if _titles_match(sl.replace("-", " "), valid_titles, "", year, mtype):
                    ep_u = f"{href}/sezon-{s}/bolum-{e}" if mtype == "tv" else href
                    out = _try_ep_page(ep_u, True)
                    if out:
                        return out
        except Exception:
            continue
    return res


def _extract_dizilife_sync(mtype: str, s: int, e: int, title: str, disp_title: str, ekey: str, year: str = "", imdb_id: str = "", extra_titles: list = None, source_url: str = "") -> list:
    import base64, hashlib
    res = []
    raw_cands = [_clean_query_title(x) for x in ([disp_title, title] + list(extra_titles or [])) if _clean_query_title(x)]
    q_cands = []
    for x in raw_cands:
        if ":" in x:
            pre = x.split(":", 1)[0].strip()
            if len(pre) >= 3:
                q_cands.append(pre)
            q_cands.append(x.replace(":", " "))
        q_cands.append(x)
    valid_titles = list(dict.fromkeys(q_cands + [disp_title, title]))
    direct_dl = source_url if (source_url and re.search(r"dizi\d*\.life/(?:dizi|film)/", source_url)) else ""
    steps = ([("__DIRECT__", direct_dl)] if direct_dl else []) + [("__SEARCH__", q) for q in list(dict.fromkeys(q_cands))[:3]]
    for mode, val in steps:
        try:
            if mode == "__DIRECT__":
                matched_url = val
                base_dom = f"{urllib.parse.urlparse(matched_url).scheme}://{urllib.parse.urlparse(matched_url).netloc}"
            else:
                su = f"https://dizi82.life/ara?q={urllib.parse.quote(val)}"
                r = urllib.request.urlopen(urllib.request.Request(su, headers={"User-Agent": UA137}), timeout=4.2)
                base_dom = f"{urllib.parse.urlparse(r.geturl()).scheme}://{urllib.parse.urlparse(r.geturl()).netloc}"
                html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                seg = "dizi" if mtype == "tv" else "film"
                cards = re.findall(rf'<a[^>]+href=["\']((?:https?://[^"\'\s/]+)?/{seg}/[a-z0-9-]+)["\'][^>]*>(.*?)</a>', html, re.S)
                matched_url = ""
                for href, inner in cards:
                    tm = re.search(r'data-fallback-title=["\']([^"\']+)["\']', inner) or re.search(r'alt=["\']([^"\']+)["\']', inner)
                    slug_title = href.rsplit("/", 1)[-1].replace("-", " ")
                    ctitle = tm.group(1) if tm else slug_title
                    ym = re.search(r'<span>\s*((?:19|20)\d{2})\s*</span>', inner)
                    cyear = ym.group(1) if ym else ""
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
                ep_html = urllib.request.urlopen(urllib.request.Request(ep_url, headers={"User-Agent": UA137, "Referer": base_dom + "/"}), timeout=4.2).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            except Exception:
                if mtype == "tv" and "/sezon/" not in item_url:
                    s_html = urllib.request.urlopen(urllib.request.Request(item_url, headers={"User-Agent": UA137, "Referer": base_dom + "/"}), timeout=4.2).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                    alt_ep = re.search(rf'href=["\']((?:https?://[^"\'\s/]+)?/dizi/[a-z0-9-]+/sezon/\d+/bolum/{e})["\']', s_html)
                    if not alt_ep:
                        continue
                    ep_url = alt_ep.group(1) if alt_ep.group(1).startswith("http") else (base_dom + alt_ep.group(1))
                    ep_html = urllib.request.urlopen(urllib.request.Request(ep_url, headers={"User-Agent": UA137, "Referer": base_dom + "/"}), timeout=4.2).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                else:
                    continue
            ifr = re.search(r'<iframe[^>]+src=["\']((?:https?:)?//[^"\']+/player/[^"\']+)["\']', ep_html)
            if not ifr:
                continue
            pu = ("https:" + ifr.group(1)) if ifr.group(1).startswith("//") else ifr.group(1)
            phtml = urllib.request.urlopen(urllib.request.Request(pu, headers={"User-Agent": UA137, "Referer": ep_url}), timeout=4.2).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
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
        jve5 = arr.pop(off2 + (cf4 % mod2))
        d46 = arr.pop(cf4 % mod1) + "hdfilmcehennemi.mobi"
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


def _is_vault_url_expired(url: str) -> bool:
    u_low = str(url or "").lower()
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
    q_cands = [_clean_query_title(x) for x in ([disp_title, title] + list(extra_titles or [])) if _clean_query_title(x)]
    for qc in list(q_cands):
        if "&" in qc:
            q_cands.append(qc.replace("&", " "))
        if re.search(r"\b(?:II|III|IV|V|VI)\b", qc):
            q_cands.append(re.sub(r"\bII\b", "2", re.sub(r"\bIII\b", "3", re.sub(r"\bIV\b", "4", qc))))
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

    if mtype != "tv":
        fb_ep_keys = []
    elif s > 1 or e > 1:
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
            v_su = str(v_ent.get("sourceUrl") or "")
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
                        if not raw_su.startswith("http") or "ineedskin.cfd" in raw_su.lower() or "shrek.dragonballzfans.xyz" in raw_su.lower() or "goldenkite.top" in raw_su.lower():
                            continue
                        if _is_vault_url_expired(raw_su):
                            continue
                        if IS_VERCEL and (
                            "dbx.molystream.org" in raw_su.lower()
                            or "dplayer" in raw_su.lower()
                            or "hdfilmcehennemi.mobi" in raw_su.lower()
                            or ("cdnimages" in raw_su.lower() and "/hls/" in raw_su.lower())
                            or "playmix.uno" in raw_su.lower()
                            or "master.txt?s=" in raw_su.lower()
                            or st_t in ("hls_dbx", "hls_dp", "hls_hfnl", "hls_hfnl_multi")
                        ):
                            continue
                        if "dplayer" in raw_su.lower() and "multiplayer.php" not in raw_su.lower() and "iframe.php" not in raw_su.lower():
                            continue
                        if not _stream_matches_title(raw_su, valid_titles):
                            continue
                        is_true_1080_vault = (
                            not refresh and (
                                st_t in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr")
                                or (IS_VERCEL and st_t == "hls_dl")
                                or (st_t == "hls" and "fuckme.dragonballzfans.xyz" in raw_su.lower())
                                or (st_t in ("mp4_ac_sub", "mp4_ac_dub") and "_720p" not in raw_su.lower())
                                or (not IS_VERCEL and st_t in ("hls_hfnl_multi", "hls_hfnl") and (bool(re.search(r"-([A-Za-z0-9]{10,12})\.(?:mp4|mkv)/", raw_su)) or "hdfilmcehennemi.mobi" in raw_su))
                                or (not IS_VERCEL and st_t == "hls_dp" and ("multiplayer.php" in raw_su or "iframe.php" in raw_su))
                            )
                        )
                        dest_l = target_list if is_true_1080_vault else fallback_res
                        if (raw_su, st_t) not in dest_l:
                            dest_l.append((raw_su, st_t))
                        if v_aud:
                            prev_aud = _AUDIO_LANG_HINT.get(str(u_st[0])) or []
                            if not prev_aud or ("orig" in prev_aud and "orig" not in v_aud):
                                _AUDIO_LANG_HINT[str(u_st[0])] = list(v_aud)

    _collect_vault_keys(exact_ep_keys, res)
    if res and not refresh:
        return res + [x for x in fallback_res if x not in res]
    _collect_vault_keys(fb_ep_keys, fallback_res)

    # 2. Live extraction from https://www.fullhdfilmizlesene.now/ (for movies)
    if mtype == "movie":
        fhd_targets = []
        if source_url and "fullhdfilmizlesene." in source_url:
            fhd_targets.append(source_url)
        for q in list(dict.fromkeys(q_cands))[:3]:
            if fhd_targets:
                break
            qc = re.sub(r"\s+", " ", re.sub(r"[:…!?'\",-]+", " ", str(q or ""))).strip()
            if not qc:
                continue
            try:
                s_u = f"https://www.fullhdfilmizlesene.now/arama/{urllib.parse.quote(qc)}"
                shtml = urllib.request.urlopen(urllib.request.Request(s_u, headers={"User-Agent": UA137, "Referer": "https://www.fullhdfilmizlesene.now/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                for card in re.findall(r'<li class="film"[^>]*>(.*?)</li>', shtml, re.S):
                    hm = re.search(r'<a[^>]+class="tt"[^>]+href=["\'](https://www\.fullhdfilmizlesene\.now/film/[^"\']+)["\']', card)
                    tm = re.search(r'<span class="film-title">([^<]+)</span>', card)
                    om = re.search(r'<span class="kt">([^<]+)</span>', card)
                    ym = re.search(r'<span class="film-yil">(\d{4})</span>', card)
                    if not hm:
                        continue
                    c_u = hm.group(1)
                    c_y = ym.group(1) if ym else ""
                    t1 = html_mod.unescape(tm.group(1).strip()) if tm else ""
                    t2 = html_mod.unescape(om.group(1).strip()) if om else ""
                    if _titles_match(t1, valid_titles, c_y, year, "movie") or (t2 and _titles_match(t2, valid_titles, c_y, year, "movie")):
                        fhd_targets.append(c_u)
                        break
            except Exception:
                continue
        for f_u in fhd_targets[:2]:
            try:
                mhtml = urllib.request.urlopen(urllib.request.Request(f_u, headers={"User-Agent": UA137, "Referer": "https://www.fullhdfilmizlesene.now/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
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
                                st_tag = "hls_fhd_multi" if mode_k in ("multi", "dual") else ("hls_fhd_tr" if "tr" in mode_k else "hls_fhd")
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
    if IS_VERCEL:
        return res + [x for x in fallback_res if x not in res]

    # 3. Live extraction from https://www.hdfilmcehennemi.nl/ (movies & series)
    hfnl_targets = []
    if source_url and "hdfilmcehennemi.nl" in source_url:
        hfnl_targets.append(source_url)
    for q in list(dict.fromkeys(q_cands))[:3]:
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
    if not hfnl_targets:
        for q in list(dict.fromkeys(q_cands))[:2]:
            sl_h = _to_ascii_slug(q)
            if sl_h:
                hfnl_targets.append(f"https://www.hdfilmcehennemi.nl/dizi/{sl_h}/sezon-{s}/bolum-{e}/" if mtype == "tv" else f"https://www.hdfilmcehennemi.nl/{sl_h}/")
    for h_u in hfnl_targets[:2]:
        try:
            if mtype == "tv":
                if "/sezon-" in h_u:
                    h_u = re.sub(r"/sezon-\d+/bolum-\d+/?.*$", f"/sezon-{s}/bolum-{e}/", h_u)
                else:
                    slug = h_u.rstrip("/").rsplit("/", 1)[-1]
                    h_u = f"https://www.hdfilmcehennemi.nl/dizi/{slug}/sezon-{s}/bolum-{e}/"
            phtml = urllib.request.urlopen(urllib.request.Request(h_u, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            if mtype == "movie" and year and str(year)[:4].isdigit():
                ym_h = re.search(r'<span class="year">(\d{4})</span>|releaseDate["\']?\s*:\s*["\'](\d{4})|<title>[^<]*\((\d{4})\)', phtml, re.I)
                hy_str = next((g for g in (ym_h.groups() if ym_h else []) if g), "") if ym_h else ""
                if hy_str.isdigit() and abs(int(hy_str) - int(str(year)[:4])) > 1:
                    continue
            ifrs = re.findall(r'<iframe[^>]+(?:src|data-src)=["\'](https://hdfilmcehennemi\.mobi/video/embed/[^"\']+)["\']', phtml)
            for emb_u in list(dict.fromkeys(ifrs))[:2]:
                emb_html = urllib.request.urlopen(urllib.request.Request(emb_u, headers={"User-Agent": UA137, "Referer": "https://www.hdfilmcehennemi.nl/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                m3u8_u = _decode_hdfc_mobi_html(emb_html)
                if m3u8_u and m3u8_u.startswith("http"):
                    is_dual_hfnl = any(k in m3u8_u.lower() for k in ("dual", "trdual")) or "closedual" in emb_html.lower() or "dual" in phtml.lower()
                    st_tag = "hls_hfnl_multi" if is_dual_hfnl else "hls_hfnl"
                    res.append((m3u8_u, st_tag))
                    for sb in _parse_embed_vtt_tracks(emb_html, "hfnl_embed"):
                        if not any(x.get("url") == sb["url"] for x in es_list):
                            es_list.insert(0, sb)
        except Exception:
            pass
    if res and (mtype == "movie" or len(res) >= 2):
        return res + [x for x in fallback_res if x not in res]

    # 4. Live extraction from https://www.dizibox.live/ (for series)
    if mtype == "tv":
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
                dhtml = urllib.request.urlopen(urllib.request.Request(ep_u, headers={"User-Agent": UA137, "Referer": "https://www.dizibox.live/"}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                tm_d = re.search(r"<title>([^<]+)</title>", dhtml, re.I)
                if tm_d and not (source_url and "dizibox.live" in source_url):
                    dt = re.sub(r"\s+\d+\.\s*Sezon.*$", "", html_mod.unescape(tm_d.group(1)), flags=re.I).strip()
                    if dt and not _titles_match(dt, valid_titles, "", year, "tv"):
                        continue
                m_king = re.search(r'<iframe[^>]+src=["\']((?:https?:)?//www\.dizibox\.live/player/king/king\.php\?v=[^"\']+)["\']', dhtml, re.I)
                if m_king:
                    ku = ("https:" + m_king.group(1)) if m_king.group(1).startswith("//") else m_king.group(1)
                    khtml = urllib.request.urlopen(urllib.request.Request(ku, headers={"User-Agent": UA137, "Referer": ep_u}), timeout=3.4).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                    m_moly = re.search(r'https?://dbx\.molystream\.org/embed/([a-zA-Z0-9_-]+)', khtml)
                    if m_moly:
                        res.append((f"https://dbx.molystream.org/embed/sheila/{m_moly.group(1)}", "hls_dbx"))
                        break
            except Exception:
                continue
    return res if res else fallback_res



_ANIMECIX_KNOWN_TMDB = {
    "35935": 7791, "66053": 7792,
    "46260": 80, "31910": 80, "70881": 52, "37854": 66, "1429": 25, "30984": 82,
    "12971": 84, "65930": 90, "61374": 17, "63926": 8, "60863": 29, "45782": 60,
    "46261": 58, "37863": 23, "31911": 235, "37865": 234, "46298": 238, "73223": 258,
    "13916": 7585, "95479": 7352, "85937": 7394, "127532": 10995, "46299": 85,
}
_ANIMECIX_KNOWN_NAMES = {
    "berserk": 7791, "kenpuudenkiberserk": 7791, "berserk1997": 7791, "berserk2016": 7792,
    "naruto": 80, "narutoshippuden": 80, "boruto": 52, "onepiece": 66,
    "attackontitan": 25, "shingekinokyojin": 25, "bleach": 82, "dragonballz": 84,
    "myheroacademia": 90, "bokunoheroacademia": 90, "tokyoghoul": 17, "onepunchman": 8,
    "haikyuu": 29, "swordartonline": 60, "fairytail": 58, "gintama": 23,
    "fullmetalalchemistbrotherhood": 235, "steinsgate": 238, "blackclover": 258,
    "deathnote": 7585, "jujutsukaisen": 7352, "demonslayer": 7394, "kimetsunoyaiba": 7394,
    "sololeveling": 10995, "hunterxhunter": 85,
}


_HIDDEN_TMDB_IDS: set = set()
try:
    _hid_path = BASE_DIR / "hidden_titles.json"
    if _hid_path.exists():
        _HIDDEN_TMDB_IDS = {str(x) for x in (json.loads(_hid_path.read_text(encoding="utf-8")).get("tmdbIds") or [])}
except Exception:
    _HIDDEN_TMDB_IDS = set()

_ANIMECIX_TAU_MAP: dict = {}
try:
    _tau_map_path = BASE_DIR / "animecix_tau_map.json"
    if _tau_map_path.exists():
        _ANIMECIX_TAU_MAP = json.loads(_tau_map_path.read_text(encoding="utf-8"))
except Exception:
    _ANIMECIX_TAU_MAP = {}


def _extract_animecix_sync(mtype: str, s: int, e: int, orig_title: str, tr_title: str, tmdb_id: str = "", extra_queries: list = None, source_url: str = "", orig_lang: str = "") -> list:
    res = []
    ac_id = _ANIMECIX_KNOWN_TMDB.get(str(tmdb_id or ""))
    if not ac_id and "animecix.tv/titles/" in str(source_url or ""):
        m_ac = re.search(r"animecix\.tv/titles/(\d+)", str(source_url))
        if m_ac:
            ac_id = int(m_ac.group(1))
    q_cands = [ _clean_query_title(x) for x in ([orig_title, tr_title] + list(extra_queries or [])) if _clean_query_title(x) ]
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
                s_data = _raw_get_json(f"https://animecix.tv/secure/search/{urllib.parse.quote(qc)}?limit=6", headers=hdrs, timeout=2.8) or {}
                for row in (s_data.get("results") or []):
                    if isinstance(row, dict) and row.get("id"):
                        rn = _norm_title(row.get("name") or "")
                        ro = _norm_title(row.get("original_title") or "")
                        nq = _norm_title(qc)
                        if str(row.get("tmdb_id") or "") == str(tmdb_id) or (nq and (nq == rn or nq == ro or nq in rn or rn in nq or (ro and (nq in ro or ro in nq)))):
                            ac_id = int(row["id"])
                            break
                if ac_id:
                    break
            except Exception:
                continue
    if not ac_id:
        return res
    try:
        vids = None
        try:
            ep_url = f"https://animecix.tv/secure/episode-videos?titleId={ac_id}&episode={e}&season={s}"
            vids = _raw_get_json(ep_url, headers=hdrs, timeout=2.5)
        except Exception:
            vids = None
        if not vids and s == 1 and e == 1:
            try:
                t_data = _raw_get_json(f"https://animecix.tv/secure/titles/{ac_id}?titleId={ac_id}", headers=hdrs, timeout=2.5) or {}
                vids = ((t_data.get("title") or {}).get("videos") if isinstance(t_data, dict) else None) or []
            except Exception:
                vids = None
        fb_tau = _ANIMECIX_TAU_MAP.get(f"{ac_id}:{s}:{e}") or []
        fb_by_id = {str(p[0]): (str(p[2]) if len(p) >= 3 else "") for p in fb_tau if isinstance(p, (list, tuple)) and len(p) >= 2}
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
            tau_items.sort(key=lambda x: 1 if x[1] else 0)
        for pair in fb_tau:
            if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                if str(pair[0]).startswith("https://"):
                    tau_items.append((str(pair[0]), "dub" in str(pair[1]).lower(), str(pair[0])))
                else:
                    tau_items.append((str(pair[0]), bool(pair[1]), str(pair[2]) if len(pair) >= 3 else ""))
        seen_tau = set()
        for item in tau_items:
            tau_id = item[0]
            is_dub = item[1]
            fb_u = item[2] if len(item) >= 3 else ""
            if tau_id in seen_tau or len(res) >= 3:
                continue
            seen_tau.add(tau_id)
            try:
                best_u = ""
                if not tau_id.startswith("https://"):
                    try:
                        t_info = _raw_get_json(f"https://tau-video.xyz/api/video/{tau_id}", headers={"User-Agent": UA137, "Referer": f"https://tau-video.xyz/embed/{tau_id}"}, timeout=2.8) or {}
                        u_list = [x for x in (t_info.get("urls") or []) if isinstance(x, dict) and str(x.get("url") or "").startswith("https://")]
                        u_list.sort(key=lambda x: 0 if "1080" in str(x.get("label") or "") else (1 if "720" in str(x.get("label") or "") else 2))
                        if u_list:
                            best_u = str(u_list[0]["url"]).strip()
                    except Exception:
                        best_u = ""
                if not best_u and fb_u.startswith("https://"):
                    best_u = fb_u
                if best_u:
                    res.append((best_u, "mp4_ac_dub" if is_dub else "mp4_ac_sub"))
            except Exception:
                continue
        res.sort(key=lambda x: (1 if "_720p" in x[0].lower() else 0, 1 if x[1] == "mp4_ac_dub" else 0))
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
        res = {
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
        }
        _TMDB_META_CACHE[ck] = res
        return res
    except Exception:
        return {"title": fallback_title, "trTitle": fallback_title, "originalTitle": fallback_title, "altTitles": [], "year": fallback_year, "imdbId": fallback_imdb, "origLang": "en", "transLangs": ["tr", "en"], "runtime": 48 if mtype == "tv" else 120, "primaryProv": ""}


def _extract_direct_stream_sync(tid: str, mtype: str, s: int, e: int, title: str = "", year: str = "", imdb_id: str = "", disp_title: str = "", source_url: str = "", refresh: bool = False):
    ckey = f"v32:{mtype}:{tid}:{s}:{e}"
    ekey = f"{mtype}:{tid}:{s}:{e}"
    now_t = time.time()
    if refresh:
        old_c = _STREAM_CACHE.pop(ckey, None)
        for u_old, _ in ((old_c or {}).get("val") or []):
            _STREAM_RES_HINT.pop(u_old, None)
            _AUDIO_PROBE_CACHE.pop(u_old, None)
    cached = None if refresh else _STREAM_CACHE.get(ckey)
    if cached and cached["exp"] > now_t:
        c_val = [u for u in (cached.get("val") or []) if not _is_vault_url_expired(u[0])]
        check_titles = [x for x in (title, disp_title) if x]
        if c_val and (not check_titles or all(_stream_matches_title(u[0], check_titles) for u in c_val)):
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
                    val = [tuple(x) for x in (parsed.get("urls") or []) if not _is_vault_url_expired(x[0])]
                    subs = parsed.get("subs") or []
                else:
                    val = [tuple(x) for x in parsed if not _is_vault_url_expired(x[0])]
                    subs = []
                check_titles = [x for x in (title, disp_title) if x]
                if val and (not check_titles or all(_stream_matches_title(u[0], check_titles) for u in val)):
                    if subs:
                        _EMBED_SUB_CACHE[ekey] = list(subs)
                    v_streams = _MAIN_SITES_VAULT.get("streams") or {}
                    for u_c, _ in val:
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
    orig_title = meta.get("originalTitle") or title or disp_title
    tr_title = meta.get("trTitle") or disp_title or orig_title
    year = meta.get("year") or year
    imdb_id = meta.get("imdbId") or imdb_id
    extra_titles = list(dict.fromkeys([disp_title, title, tr_title, orig_title] + list(meta.get("altTitles") or [])))

    import concurrent.futures

    def _job_videasy():
        res = []
        try:
            vf_u = f"https://vidfast.vc/tv/{tid}/{s}/{e}/" if mtype == "tv" else f"https://vidfast.vc/movie/{tid}/"
            with urllib.request.urlopen(urllib.request.Request(vf_u, headers={"User-Agent": UA137}), timeout=3.8) as r_vf:
                vf_html = r_vf.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            m_en = re.search(r'\\"(?:en|token)\\":\\"(.*?)\\"', vf_html)
            if m_en:
                en_tok = m_en.group(1)
                p1 = (_raw_get_json(f"https://enc-dec.app/api/enc-vidfast?text={urllib.parse.quote(en_tok)}&stage=1", timeout=3.8) or {}).get("result") or {}
                if p1.get("stage1") and p1.get("token"):
                    vf_hdrs = {"User-Agent": UA137, "Referer": "https://vidfast.vc/", "X-Requested-With": "XMLHttpRequest", "X-CSRF-Token": p1["token"]}
                    with urllib.request.urlopen(urllib.request.Request(p1["stage1"], data=b"", headers=vf_hdrs), timeout=3.8) as r_t1:
                        t1 = r_t1.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                    p2 = (_raw_get_json(f"https://enc-dec.app/api/enc-vidfast?text={urllib.parse.quote(t1)}&stage=2", timeout=3.8) or {}).get("result") or {}
                    if p2.get("servers") and p2.get("stream") and p2.get("token"):
                        vf_hdrs["X-CSRF-Token"] = p2["token"]
                        with urllib.request.urlopen(urllib.request.Request(p2["servers"], data=b"", headers=vf_hdrs), timeout=3.8) as r_sv:
                            srv_enc = r_sv.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                        srvs = (_raw_get_json("https://enc-dec.app/api/dec-vidfast", headers={"Content-Type": "application/json"}, data=json.dumps({"text": srv_enc}).encode("utf-8"), timeout=3.8) or {}).get("result") or []
                        srvs = [x for x in srvs if isinstance(x, dict) and x.get("data")]
                        srvs.sort(key=lambda x: 0 if x.get("name") == "vRapid" else (1 if x.get("name") == "Bravo" else (2 if x.get("name") == "Horizon" else 3)))
                        for s_item in srvs[:4]:
                            try:
                                with urllib.request.urlopen(urllib.request.Request(f"{p2['stream']}/{s_item['data']}", data=b"", headers=vf_hdrs), timeout=2.8) as r_st:
                                    st_enc = r_st.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                                st_dec = (_raw_get_json("https://enc-dec.app/api/dec-vidfast", headers={"Content-Type": "application/json"}, data=json.dumps({"text": st_enc}).encode("utf-8"), timeout=2.8) or {}).get("result") or {}
                                u = (st_dec.get("url") or "").strip() if isinstance(st_dec, dict) else ""
                                if u.startswith("https://") and "finalsignal.top" not in u and "olivewave.top" not in u and not any(u == x[0] for x in res):
                                    res.append((u, "hls_ve"))
                                    break
                            except Exception:
                                continue
        except Exception:
            pass
        return res

    def _job_hexa():
        res = []
        for host_dom in ("theemoviedb.hexa.su",):
            try:
                cap = _raw_get_json(f"https://enc-dec.app/api/enc-hexa?_={int(time.time()*1000)}", timeout=3.8)
                tok = (cap.get("result") or {}).get("token") or ""
                if not tok:
                    continue
                key = os.urandom(32).hex()
                hdrs = {
                    "User-Agent": UA137, "Referer": "https://hexa.su/", "Origin": "https://hexa.su",
                    "Accept": "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": tok,
                }
                ep = f"https://{host_dom}/api/tmdb/tv/{tid}/season/{s}/episode/{e}/images" if mtype == "tv" else f"https://{host_dom}/api/tmdb/movie/{tid}/images"
                req = urllib.request.Request(ep, headers=hdrs)
                with urllib.request.urlopen(req, timeout=4.2) as r:
                    enc_txt = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                if enc_txt and len(enc_txt) > 20:
                    dec = _raw_get_json("https://enc-dec.app/api/dec-hexa", headers={"Content-Type": "application/json"}, data=json.dumps({"text": enc_txt, "key": key}).encode("utf-8"), timeout=4.2)
                    srcs = ((dec.get("result") or {}).get("sources") or []) if isinstance(dec.get("result"), dict) else []
                    srcs.sort(key=lambda x: 0 if "fuckme.dragonballzfans" in (x.get("url") or "") else 1)
                    cand_urls = []
                    for src in srcs:
                        u = (src.get("url") or "").strip()
                        if u.startswith("https://") and not any(b in u for b in ("serve.dragonballzfans.xyz", "shrek.dragonballzfans.xyz", "sun.dragonballzfans.xyz")) and u not in cand_urls:
                            cand_urls.append(u)
                    def _probe_hx(u_cand: str) -> bool:
                        if "dragonballzfans" not in u_cand:
                            return True
                        try:
                            p_hdrs = {"User-Agent": UA137, "Referer": "https://flixer.su/", "Origin": "https://flixer.su"}
                            with urllib.request.urlopen(urllib.request.Request(u_cand, headers=p_hdrs), timeout=2.2) as pr:
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
                ep = f"https://vidlink.pro/api/b/tv/{enc_id}/{s}/{e}?multiLang=0" if mtype == "tv" else f"https://vidlink.pro/api/b/movie/{enc_id}?multiLang=0"
                st = (_raw_get_json(ep, headers={"Referer": "https://vidlink.pro/", "Origin": "https://vidlink.pro"}, timeout=4.5) or {}).get("stream") or {}
                caps = st.get("captions") or []
                if caps:
                    es_list = _EMBED_SUB_CACHE.setdefault(ekey, [])
                    for cp in caps:
                        cu = str(cp.get("url") or "").strip()
                        cl = str(cp.get("language") or cp.get("lang") or "").lower().strip()
                        if cu.startswith("https://"):
                            es_list.append({"lang": cl, "url": cu, "source": "vidlink_embed"})
                if st.get("playlist"):
                    res.append((st["playlist"], "hls"))
                else:
                    quals = st.get("qualities") or {}
                    chosen_qk, chosen_qu = "", ""
                    for prefer_h264 in (True, False):
                        for qk in ("1080", "720", "1440", "2160", "4k", "480", "360"):
                            qu = (quals.get(qk) or {}).get("url") or ""
                            if qu.startswith("https://"):
                                if prefer_h264 and "/resource/h265/" in qu.lower():
                                    continue
                                chosen_qk, chosen_qu = qk, qu
                                break
                        if chosen_qu:
                            break
                    if chosen_qu:
                        ref = "" if "hakunaymatata.com" in chosen_qu else (((quals.get(chosen_qk) or {}).get("headers") or {}).get("referer") or "https://filmboom.top/")
                        st_tag = "mp4_vl_1080" if chosen_qk in ("2160", "4k", "1440", "1080") else ("mp4_vl_720" if chosen_qk == "720" else "mp4_vl_sd")
                        res.append((_proxy_u(chosen_qu, ref, ".mp4"), st_tag))
        except Exception:
            pass
        return res

    out_urls = []
    orig_lang = str(meta.get("origLang") or "").lower()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    f_ac = pool.submit(_extract_animecix_sync, mtype, s, e, orig_title, tr_title, tid, extra_titles, source_url, orig_lang)
    f_pv = pool.submit(_extract_ddizimag_sync, mtype, s, e, orig_title, tr_title, ekey, year, extra_titles, source_url, orig_lang)
    f_dl = pool.submit(_extract_dizilife_sync, mtype, s, e, orig_title, tr_title, ekey, year, imdb_id, extra_titles, source_url)
    f_dp = pool.submit(lambda: []) if IS_VERCEL else pool.submit(_extract_dizipal_hls_sync, mtype, s, e, extra_titles, ekey, year, imdb_id)
    f_hf = pool.submit(_extract_hdfc_sync, mtype, s, e, orig_title, tr_title, ekey, year, imdb_id, extra_titles, source_url, tid, refresh)
    f_ve = pool.submit(_job_videasy)
    f_hexa = pool.submit(_job_hexa)
    f_vid = pool.submit(_job_vidlink)
    t_start = time.time()
    t_first_hf = 0.0
    is_ja_or_anime = orig_lang == "ja" or "anime" in (source_url or "").lower()
    _VERCEL_1080_TAGS = (
        (("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_dl", "hls", "mp4_ac_sub", "mp4_ac_dub", "mp4") if orig_lang == "tr" else ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls", "mp4_ac_sub", "mp4_ac_dub", "mp4"))
        if IS_VERCEL
        else ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr", "hls_hfnl_multi", "hls_hfnl", "hls_dbx", "hls_dp", "hls", "mp4_ac_sub", "mp4_ac_dub", "mp4")
    )
    while time.time() - t_start < 5.6:
        ac_ok = f_ac.done() and not f_ac.exception() and bool(f_ac.result())
        pv_ok = f_pv.done() and not f_pv.exception() and bool(f_pv.result())
        hf_res_now = (f_hf.result() or []) if (f_hf.done() and not f_hf.exception()) else []
        hf_ok = any(isinstance(x, (list, tuple)) and len(x) >= 2 and x[1] in _VERCEL_1080_TAGS for x in hf_res_now)
        dl_ok = f_dl.done() and not f_dl.exception() and bool(f_dl.result())
        dp_ok = f_dp.done() and not f_dp.exception() and bool(f_dp.result())
        ve_ok = f_ve.done() and not f_ve.exception() and bool(f_ve.result())
        hx_ok = f_hexa.done() and not f_hexa.exception() and bool(f_hexa.result())
        vl_ok = f_vid.done() and not f_vid.exception() and bool(f_vid.result())
        has_glob_ready = ve_ok or (hx_ok and f_ve.done()) or (vl_ok and f_ve.done() and f_hexa.done())
        if is_ja_or_anime and not f_ac.done() and (time.time() - t_start < 2.2):
            time.sleep(0.08)
            continue
        primary_1080_ok = (ac_ok if is_ja_or_anime else False) or hf_ok or ((dl_ok if IS_VERCEL else (dp_ok or dl_ok)) if orig_lang == "tr" else False)
        if primary_1080_ok and t_first_hf == 0.0:
            t_first_hf = time.time()
        if primary_1080_ok and (has_glob_ready or (time.time() - t_first_hf >= 0.45)):
            break
        if has_glob_ready and f_hf.done() and (bool(hf_res_now) or (f_pv.done() and f_dl.done())):
            break
        if f_pv.done() and f_hf.done() and f_dl.done() and f_dp.done() and f_ac.done() and (hf_ok or ac_ok or has_glob_ready or (time.time() - t_start >= 4.6)):
            break
        if all(f.done() for f in (f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_hexa, f_vid)):
            break
        time.sleep(0.10)
    if not any(f.done() and not f.exception() and bool(f.result()) for f in (f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_hexa, f_vid)):
        concurrent.futures.wait([f_pv, f_hf, f_dl, f_dp, f_ac, f_ve, f_hexa, f_vid], timeout=3.2)
    ac_res, tr_res, ve_res, hexa_res, vid_res = [], [], [], [], []
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
    for x in [x for x in tr_res if x[1] in ("mp4_ac_sub", "mp4_ac_dub")]:
        if x not in ac_res:
            ac_res.append(x)
    for x in reversed([x for x in tr_res if x[1] in ("hls_ve", "hls_ve_multi")]):
        if x not in ve_res:
            ve_res.insert(0, x)
    for x in reversed([x for x in tr_res if x[1] == "hls" and "shrek." not in str(x[0]).lower()]):
        if x not in hexa_res:
            hexa_res.insert(0, x)
    vault_yt = [x for x in tr_res if x[1] == "yt"]
    main_multi = [x for x in tr_res if x[1] in (("hls_fhd_multi",) if IS_VERCEL else ("hls_fhd_multi", "hls_hfnl_multi"))]
    main_single = [x for x in tr_res if x[1] in (("hls_fhd", "hls_fhd_tr") if IS_VERCEL else ("hls_fhd", "hls_fhd_tr", "hls_hfnl", "hls_dbx"))]
    ac_1080 = [x for x in ac_res if "_720p" not in str(x[0]).lower()]
    ac_720 = [x for x in ac_res if "_720p" in str(x[0]).lower()]
    pv_multi = [x for x in tr_res if x[1] == "hls_pv_multi"]
    fp_multi = [x for x in tr_res if x[1].startswith("hls_fp:multi:")]
    pv_single = [x for x in tr_res if x[1] == "hls_pv"]
    fp_other = [x for x in tr_res if x[1].startswith("hls_fp:") and x not in fp_multi]
    dl_only = [x for x in tr_res if x[1] == "hls_dl"]
    dp_only = [] if IS_VERCEL else [x for x in tr_res if x[1] == "hls_dp"]
    if ac_res or main_multi or main_single or pv_multi or fp_multi or pv_single or fp_other or dl_only or dp_only or ve_res or hexa_res or vid_res or vault_yt:
        if is_ja_or_anime:
            out_urls.extend(ac_1080)
            out_urls.extend(main_multi)
            out_urls.extend(main_single)
            out_urls.extend(ve_res)
            out_urls.extend(hexa_res)
            out_urls.extend(dp_only)
            out_urls.extend(dl_only)
            out_urls.extend(ac_720)
            out_urls.extend(fp_multi)
            out_urls.extend(pv_multi)
            out_urls.extend(pv_single)
            out_urls.extend(fp_other)
            out_urls.extend(vid_res)
            out_urls.extend(vault_yt)
        elif orig_lang == "tr":
            out_urls.extend(main_multi)
            out_urls.extend(main_single)
            out_urls.extend(dl_only)
            out_urls.extend(dp_only)
            out_urls.extend(ac_1080)
            out_urls.extend(ve_res)
            out_urls.extend(hexa_res)
            out_urls.extend(fp_multi)
            out_urls.extend(pv_multi)
            out_urls.extend(pv_single)
            out_urls.extend(fp_other)
            out_urls.extend(ac_720)
            out_urls.extend(vid_res)
            out_urls.extend(vault_yt)
        else:
            out_urls.extend(main_multi)
            out_urls.extend(main_single)
            out_urls.extend(ac_1080)
            out_urls.extend(ve_res)
            out_urls.extend(hexa_res)
            out_urls.extend(dl_only)
            out_urls.extend(dp_only)
            out_urls.extend(fp_multi)
            out_urls.extend(pv_multi)
            out_urls.extend(pv_single)
            out_urls.extend(fp_other)
            out_urls.extend(ac_720)
            out_urls.extend(vid_res)
            out_urls.extend(vault_yt)

    else:
        concurrent.futures.wait([f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_hexa, f_vid], timeout=4.0)
        for fut in (f_ac, f_pv, f_dl, f_dp, f_hf, f_ve, f_hexa, f_vid):
            if fut.done():
                try:
                    out_urls.extend(fut.result() or [])
                except Exception:
                    pass
    pool.shutdown(wait=False, cancel_futures=True)
    if extra_titles and out_urls:
        out_urls = [x for x in out_urls if isinstance(x, (list, tuple)) and len(x) >= 2 and _stream_matches_title(str(x[0]), extra_titles)]
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


def _wrap_first_party_stream(u: str, stype: str, prov: str, tid: str, s: int, e: int) -> str:
    if u.startswith("/api/rave/"):
        return u
    import base64
    tid = urllib.parse.quote(str(tid or ""), safe="")
    if stype.startswith("hls_fp:"):
        parts = stype.split(":", 4)
        _, _fmode, vid, sp, spt = (parts + ["", "", "", ""])[:5]
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}&ref=fp&fp_id={vid}&sp={sp}&spt={spt}&ext=.m3u8"
    if stype in ("hls_fhd", "hls_fhd_tr", "hls_fhd_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}&ref=fhd&ext=.m3u8"
    if stype in ("hls_hfnl", "hls_hfnl_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}&ref=hfnl&ext=.m3u8"
    if stype == "hls_dbx":
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}&ref=dbx&ext=.m3u8"
    if stype in ("hls_pv", "hls_pv_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}&ref=pv&ext=.m3u8"
    if stype == "hls_dp":
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}&ref=dp&proxy_segs=1&ext=.m3u8"
    if stype in ("mp4_ac_sub", "mp4_ac_dub"):
        return _proxy_u(u, "https://tau-video.xyz/", ".mp4")
    if stype == "mp4_vl":
        return _proxy_u(u, "" if "hakunaymatata.com" in u else "https://filmboom.top/", ".mp4")
    if stype in ("hls", "hls_dl", "hls_ve", "hls_ve_multi"):
        sid = base64.urlsafe_b64encode(u.encode("utf-8")).decode("ascii").rstrip("=")
        ref_q = "&ref=ve" if stype in ("hls_ve", "hls_ve_multi") else ("&ref=dl" if stype == "hls_dl" else ("&ref=hx" if "dragonballzfans" in u else ""))
        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s}&e={e}&sid={sid}{ref_q}&ext=.m3u8"
    return u


_SUB_CACHE = {}
_SUB_VTT_CACHE = collections.OrderedDict()
_TTS_CACHE = collections.OrderedDict()
_PLATFORM_META_CACHE = {}

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
        base_n = raw_name.split("[")[0].strip().replace("İ", "i").replace("I", "ı").lower()
        if base_n in SUB_LANG_MAP:
            allow_subs.add(SUB_LANG_MAP[base_n][0])
    ckey = f"sub:v14:{prov}:{mtype}:{tid or imdb_id}:{s}:{e}"
    now_t = time.time()
    cached = _SUB_CACHE.get(ckey)
    if cached and cached["exp"] > now_t:
        return cached["val"]
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
        raw_l = str(raw_l or "").lower().strip()
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
            return _raw_get_json(os_u, headers={"User-Agent": "TemporaryUserAgent"}, timeout=2.4)

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as os_pool:
            fut_tr = os_pool.submit(_fetch_os_rest, "tur")
            fut_en = os_pool.submit(_fetch_os_rest, "eng")
            fut_strem = os_pool.submit(_raw_get_json, ep_url, None, 2.4)
            for lang3, fut in (("tur", fut_tr), ("eng", fut_en)):
                try:
                    os_items = fut.result(timeout=2.5)
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
                                _add_sub(dl_link, lang3, 1 if is_auto_os else (-4 if idx_os == 0 else -3), not is_auto_os, "auto" if is_auto_os else "opensubtitles")
                except Exception:
                    pass
            try:
                data = fut_strem.result(timeout=2.5) or {}
                for sub in (data.get("subtitles") or []):
                    raw_lang = str(sub.get("lang") or "").lower().strip()
                    if raw_lang not in SUB_LANG_MAP:
                        continue
                    lcode = SUB_LANG_MAP[raw_lang][0]
                    _add_sub(sub.get("url"), raw_lang, 0 if lcode in allow_subs else 1, False, "opensubtitles")
            except Exception:
                pass

    raw_cands.sort(key=lambda x: (x[0], x[1], x[2]))
    best_en_url = next((c[5] for c in raw_cands if c[3] == "en"), next((c[5] for c in raw_cands), ""))
    best_tr_alt = [c[5] for c in raw_cands if c[3] == "tr"]
    meta_q = f"&tmdbId={urllib.parse.quote(str(tid or ''))}&imdbId={urllib.parse.quote(str(imdb_id or ''))}&mtype={mtype}&s={s}&e={e}"
    lang_counts = {}
    picked = []
    for prio, tier, _, lcode, llabel, sub_url, is_orig, src_tag in raw_cands:
        max_for_lang = 3 if lcode in ("tr", "en") else 1
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
        picked.append((tier, prio, cnt, {"id": tid_code, "lang": lcode, "label": f"{llabel}{tag}", "url": vtt_u, "kind": "subtitles", "source": src_tag}))

    if lang_counts.get("tr", 0) == 0 and best_en_url:
        tr_vtt_u = f"/api/rave/subtitle.vtt?url={urllib.parse.quote(best_en_url, safe='')}&lang=tr&translate=tr{meta_q}"
        picked.append((-2, 0, 0, {"id": "tr", "lang": "tr", "label": f"🇹🇷 Türkçe ({plabel} Akıllı Çeviri Senkron)", "url": tr_vtt_u, "kind": "subtitles", "source": "ai-tr"}))
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
    tracks = [x[3] for x in picked[:24]]
    if tracks:
        has_tr_sub = any(t.get("lang") == "tr" for t in tracks)
        _SUB_CACHE[ckey] = {"val": tracks, "exp": now_t + (3600 if has_tr_sub else 90)}
    return tracks


_AUDIO_LANG_ALIASES = {
    "tr": ("tr", "tur", "turkish", "türkçe", "turkce", "türk"),
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
_AUDIO_LANG_HINT: dict[str, list] = {}
_STREAM_RES_HINT: dict[str, int] = {}
_AUDIO_PROBE_CACHE: dict[str, tuple[float, list]] = {}


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


def _probe_audio_langs(raw_u: str, st: str, prov: str, tid: str, s: int, e: int):
    """Return the audio languages a source really carries: [codes], [] for muxed/unlabelled audio, None on failure."""
    import base64
    if raw_u in _AUDIO_LANG_HINT and _AUDIO_LANG_HINT[raw_u] and raw_u in _STREAM_RES_HINT:
        return list(_AUDIO_LANG_HINT[raw_u])
    if str(st).startswith("hls_fp:tr:"):
        _STREAM_RES_HINT.setdefault(raw_u, 1920)
        return ["tr"]
    if str(st).startswith("hls_fp:orig:"):
        _STREAM_RES_HINT.setdefault(raw_u, 1920)
        return []
    cached = _AUDIO_PROBE_CACHE.get(raw_u)
    if cached and time.time() - cached[0] < 1800 and raw_u in _STREAM_RES_HINT:
        return list(cached[1])
    wu = _wrap_first_party_stream(raw_u, st, prov, tid, s, e)
    if "/api/rave/stream?" not in wu:
        return None
    wu_probe = f"{wu}&probe=1"

    class _ProbeReq:
        method = "GET"
        headers = {}
        def __init__(self, u):
            self.query_params = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))

    try:
        resp = asyncio.run(rave_stream_manifest(_ProbeReq(wu_probe)))
        if resp.status_code != 200:
            _STREAM_RES_HINT[raw_u] = -1
            return None
        body = resp.body.decode("utf-8", errors="ignore")
    except Exception:
        _STREAM_RES_HINT[raw_u] = -1
        return None
    max_w = max((max(int(m.group(1)), int(int(m.group(2)) * 16 / 9)) for m in re.finditer(r"RESOLUTION=(\d+)x(\d+)", body, re.I)), default=0)
    if not max_w:
        max_w = 1920 if st in ("hls_fhd", "hls_fhd_tr", "hls_fhd_multi", "hls_ve", "hls_ve_multi", "hls", "hls_hfnl", "hls_hfnl_multi", "hls_dbx", "hls_dp") else (1280 if st in ("hls_pv", "hls_pv_multi") else 1920)
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
    if len(_AUDIO_PROBE_CACHE) > 600:
        _AUDIO_PROBE_CACHE.pop(next(iter(_AUDIO_PROBE_CACHE)), None)
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
    srcs = list(direct_list or [])[:8]
    probe_targets = [(u, st) for u, st in srcs if not str(st).startswith("mp4")][:6]
    lang_map = {}
    if probe_targets:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(probe_targets)) as ppool:
            futs = {ppool.submit(_probe_audio_langs, u, st, prov, tid, s, e): u for u, st in probe_targets}
            done, _ = concurrent.futures.wait(futs, timeout=4.8)
            for f in done:
                try:
                    lang_map[futs[f]] = f.result()
                except Exception:
                    lang_map[futs[f]] = None
    alive_srcs = [(u, st) for u, st in srcs if _STREAM_RES_HINT.get(u, 0) != -1]
    if alive_srcs:
        srcs = alive_srcs
    def _src_res_tier(pair):
        u, st = pair
        if st in ("mp4_ac_sub", "mp4_ac_dub"):
            return 3 if "_720p" not in str(u).lower() else 1
        if str(st).startswith("mp4"):
            if st == "mp4_vl_sd":
                return 0.2
            if st == "mp4_vl_720":
                return 0.7
            return 0.6 if "%2fh265%2f" in str(u).lower() or "/h265/" in str(u).lower() else 1.2
        w = _STREAM_RES_HINT.get(u, 0)
        if w > 0:
            if w >= 1880 and st in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr"):
                return 4
            if w >= 2500:
                return 3
            return 2 if w >= 1880 else 1.5
        if st in ("hls_fhd_multi", "hls_fhd", "hls_fhd_tr"):
            return 4
        return 2 if st in ("hls_ve", "hls_ve_multi", "hls", "hls_hfnl", "hls_hfnl_multi", "hls_dbx", "hls_dp") else 1.5
    srcs.sort(key=_src_res_tier, reverse=True)
    by_lang: dict[str, list] = {}
    unknown: list = []
    for raw_u, st in srcs:
        wu = _wrap_first_party_stream(raw_u, st, prov, tid, s, e)
        if st == "mp4_ac_sub":
            by_lang.setdefault(orig_lang or "ja", []).append((wu, "fansub"))
            continue
        if st == "mp4_ac_dub":
            by_lang.setdefault("tr", []).append((wu, "dub"))
            continue
        langs = lang_map.get(raw_u)
        if not langs and _AUDIO_LANG_HINT.get(raw_u):
            langs = list(_AUDIO_LANG_HINT[raw_u])
        if not langs and str(st).startswith("hls_fp:tr:"):
            langs = ["tr"]
        if not langs and str(st).startswith("hls_fp:orig:") and orig_lang:
            langs = [orig_lang]
        if not langs and st == "hls_fhd_tr":
            langs = ["tr"]
        if not langs and orig_lang == "tr":
            langs = ["tr"]
        if not langs and (st in ("hls_fhd", "hls_hfnl", "hls_dbx", "hls_pv", "hls_dl", "hls_dp", "hls", "hls_ve", "mp4", "mp4_vl") or str(st).startswith("mp4_vl")):
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
                by_lang.setdefault(L, []).append((u_l, "verified"))
        else:
            unknown.append(wu)
    order = ([orig_lang] if orig_lang in by_lang else []) + [L for L in by_lang if L not in (orig_lang, "tr", "en")] + [L for L in ("tr", "en") if L in by_lang and L != orig_lang]
    eff_orig_lang = orig_lang if orig_lang in by_lang else next((L for L in order if L != "tr"), orig_lang)
    is_tr_native = orig_lang == "tr" or prov in ("exxen", "blutv", "gain", "tod", "tabii", "puhutv")
    tracks = []
    for L in order:
        name = _AUDIO_LANG_TR_NAMES.get(L, L.upper())
        flag = _AUDIO_LANG_FLAGS.get(L, "🎧")
        is_orig = (L == eff_orig_lang) or (is_tr_native and L == "tr")
        base_id = "orig" if is_orig else ("tr-dub" if L == "tr" else ("en-dub" if L == "en" else f"dub-{L}"))
        for k, (u_l, kind) in enumerate(by_lang[L][:2]):
            if kind == "fansub":
                label = f"⛩️ {name} Orijinal + Türkçe Fansub (Animetrix 1080p)"
            elif is_orig:
                label = f"🎬 {name} [Orijinal] ({plabel} Orijinal Ses)"
            else:
                label = f"{flag} {name} ({plabel} Stüdyo Dublaj · 1080p)"
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
                    n = _fetch_vtt_sync(raw).count("-->")
                    if n >= min_cues:
                        return n
                except Exception:
                    continue
        return 0

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    futs = [pool.submit(_count, t) for t in tracks]
    try:
        concurrent.futures.wait(futs, timeout=6.0)
    finally:
        pool.shutdown(wait=False)
    out = []
    for t, f in zip(tracks, futs):
        n = f.result() if (f.done() and not f.exception()) else 99
        if n >= min_cues:
            out.append(t)
    return out



def _tv_season_numbers(tid: str) -> set:
    """TMDB'deki gerçek sezon numaraları; alınamazsa boş küme (doğrulama atlanır)."""
    hit = _TV_SEASONS_CACHE.get(tid)
    if hit is not None:
        return hit
    nums: set = set()
    try:
        info = _http_json(f"https://api.themoviedb.org/3/tv/{tid}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY}), timeout=4.0)
        nums = {int(x.get("season_number") or 0) for x in (info.get("seasons") or []) if int(x.get("season_number") or 0) >= 1}
    except Exception:
        return set()
    _TV_SEASONS_CACHE[tid] = nums
    return nums


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
                f"{clean_t} {s}. Sezon {e}. Bölüm" if s > 1 else f"{clean_t} {e}. Bölüm",
                f"{clean_t} {e}. Bölüm" if s == 1 else f"{clean_t} S{s:02d}E{e:02d}",
                f"{e}. Bölüm {clean_t}" if s == 1 else "",
            ]
        else:
            queries = [f"{clean_t} Full Film İzle", f"{clean_t} Tek Parça Full HD", f"{clean_t} Full Movie"]

        for q in queries:
            if not q:
                continue
            try:
                u_yt = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": q, "hl": "tr", "gl": "TR"})
                req = urllib.request.Request(u_yt, headers={"User-Agent": UA137})
                with urllib.request.urlopen(req, timeout=3.8) as r:
                    html = r.read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
                m = re.search(r"var ytInitialData = ({.*?});</script>", html)
                if m:
                    data = json.loads(m.group(1))
                    contents = data.get("contents", {}).get("twoColumnSearchResultsRenderer", {}).get("primaryContents", {}).get("sectionListRenderer", {}).get("contents", [])
                    for sec in contents:
                        items = sec.get("itemSectionRenderer", {}).get("contents", [])
                        for it in items[:10]:
                            vr = it.get("videoRenderer")
                            if not vr:
                                continue
                            v_title = "".join(r_t.get("text", "") for r_t in vr.get("title", {}).get("runs", []))
                            dur_str = vr.get("lengthText", {}).get("simpleText", "")
                            parts = dur_str.split(":")
                            if len(parts) < 2:
                                continue
                            dur_secs = (int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])) if len(parts) == 3 else (int(parts[0]) * 60 + int(parts[1]) if len(parts) == 2 else 0)
                            if dur_secs < (1400 if mtype == "tv" else 2400):
                                continue
                            if mtype == "tv":
                                ep_pattern = rf"(?:^|[^\d]){e}\.?\s*b[oö]l[uü]m|s0?{s}e0?{e}|\bepisode\s*0?{e}\b"
                                if not re.search(ep_pattern, v_title, re.I):
                                    continue
                                if s > 1 and not re.search(rf"(?:^|[^\d]){s}\.?\s*sezon|s0?{s}e0?{e}|\bseason\s*0?{s}\b", v_title, re.I):
                                    continue
                            vn_compact = re.sub(r"\s+", "", _norm_title(v_title))
                            if valid_norms and not any(vn in vn_compact for vn in valid_norms if len(vn) >= 2):
                                continue
                            channel = "".join(r_t.get("text", "") for r_t in vr.get("ownerText", {}).get("runs", [])) or "YouTube"
                            vid = vr.get("videoId")
                            if vid:
                                return {"videoId": vid, "title": v_title, "channel": channel, "duration": dur_secs}
            except Exception:
                pass
            try:
                it_rows = music_engine._yt_innertube_search_sync(q, 10) or []
                for r_it in it_rows:
                    vid = r_it.get("videoId")
                    v_title = str(r_it.get("title") or r_it.get("songTitle") or "")
                    dur_secs = int(r_it.get("duration") or 0)
                    if not vid or dur_secs < (1400 if mtype == "tv" else 2400):
                        continue
                    if mtype == "tv":
                        ep_pattern = rf"(?:^|[^\d]){e}\.?\s*b[oö]l[uü]m|s0?{s}e0?{e}|\bepisode\s*0?{e}\b"
                        if not re.search(ep_pattern, v_title, re.I):
                            continue
                    vn_compact = re.sub(r"\s+", "", _norm_title(v_title))
                    if valid_norms and not any(vn in vn_compact for vn in valid_norms if len(vn) >= 2):
                        continue
                    return {"videoId": vid, "title": v_title, "channel": str(r_it.get("artist") or "YouTube"), "duration": dur_secs}
            except Exception:
                pass
    except Exception:
        pass
    return None


def _server_label_for_stream(raw_u: str, st: str, idx: int) -> str:
    u_l = str(raw_u or "").lower()
    st_s = str(st or "")
    if st_s == "hls_fhd_multi":
        return f"📡 Sunucu {idx} · FullHD Dual (TR Dublaj & Orijinal · 1080p)"
    if st_s == "hls_fhd_tr":
        return f"📡 Sunucu {idx} · FullHD (TR Dublaj · 1080p)"
    if st_s == "hls_fhd" or "rapidvid" in u_l or "cdnimgs" in u_l:
        return f"📡 Sunucu {idx} · FullHD Sinema (1080p HD)"
    if st_s in ("hls_hfnl_multi", "hls_hfnl") or "hdfilmcehennemi" in u_l or "playmix" in u_l:
        return f"📡 Sunucu {idx} · HDCehennemi ({'Dual ' if 'multi' in st_s else ''}1080p HD)"
    if st_s == "mp4_ac_sub":
        return f"📡 Sunucu {idx} · AnimeciX Fansub ({'720p' if '_720p' in u_l else '1080p'} HD)"
    if st_s == "mp4_ac_dub":
        return f"📡 Sunucu {idx} · AnimeciX (TR Dublaj · {'720p' if '_720p' in u_l else '1080p'} HD)"
    if st_s in ("hls_ve", "hls_ve_multi"):
        return f"📡 Sunucu {idx} · VidFast Global (1080p HD)"
    if st_s == "hls_dl" or "makesomthingup" in u_l:
        return f"📡 Sunucu {idx} · DiziLife (1080p HD)"
    if st_s == "hls_dp" or "dplayer" in u_l or "ag2m5" in u_l:
        return f"📡 Sunucu {idx} · DiziPal (1080p HD)"
    if st_s == "hls_dbx" or "molystream" in u_l:
        return f"📡 Sunucu {idx} · DiziBox (1080p HD)"
    if st_s == "hls_pv_multi":
        return f"📡 Sunucu {idx} · Pilavyer Dual (TR Dublaj & Altyazı · HD)"
    if st_s == "hls_pv" or "pilavyer" in u_l:
        return f"📡 Sunucu {idx} · Pilavyer (HD)"
    if st_s.startswith("hls_fp:") or "fastplay" in u_l:
        return f"📡 Sunucu {idx} · FastPlay (1080p HD)"
    if st_s.startswith("mp4_vl"):
        return f"📡 Sunucu {idx} · VidLink MP4 ({'1080p' if '1080' in st_s else '720p'} HD)"
    if st_s == "hls" or "dragonballzfans" in u_l:
        return f"📡 Sunucu {idx} · Flixer / Hexa (1080p HD)"
    return f"📡 Sunucu {idx} · Yüksek Hızlı Yayın (HD)"


def _resolve_catalog_sync(prov: str, title: str, year: str, tmdb_id: str, media_type: str, poster: str, season: int = 1, episode: int = 1, imdb_id: str = "", display_title: str = "", source_url: str = "", refresh: bool = False):
    s = max(1, int(season or 1))
    e = max(1, int(episode or 1))
    label = PROV_LABELS.get(prov, prov.capitalize())
    tid = str(tmdb_id or "").strip()
    mtype = "tv" if media_type == "tv" else "movie"
    disp = display_title or title
    if not tid.isdigit() and title:
        hits = _tmdb_sync(title)
        if hits:
            def _score_hit(h):
                sc = 0
                if h.get("mediaType") == mtype:
                    sc += 10
                if year and str(h.get("year") or "") == str(year):
                    sc += 20
                if _norm_title(h.get("title") or "") in {_norm_title(title), _norm_title(disp)} or _norm_title(h.get("originalTitle") or "") in {_norm_title(title), _norm_title(disp)}:
                    sc += 15
                return sc
            hits.sort(key=_score_hit, reverse=True)
            if _score_hit(hits[0]) > 0:
                tid = str(hits[0]["tmdbId"])
                mtype = hits[0].get("mediaType") or mtype
                poster = poster or hits[0].get("backdrop") or hits[0].get("poster") or ""
                year = year or hits[0].get("year") or ""
                title = hits[0].get("originalTitle") or hits[0].get("title") or title
    if mtype == "tv" and tid.isdigit() and prov != "crunchyroll" and not str(source_url or "").startswith("animecix:"):
        tv_seasons = _tv_season_numbers(tid)
        if tv_seasons and s not in tv_seasons:
            return None
    eff_tid = tid if tid.isdigit() else (f"free-{_norm_title(title or disp)[:24]}" if (title or disp or source_url) else "")
    if eff_tid:
        m_cached = _get_tmdb_meta_sync(tid, mtype, title, year, imdb_id)
        orig_title = m_cached.get("originalTitle") or title
        tr_title = m_cached.get("trTitle") or disp or orig_title
        year = m_cached.get("year") or year or ""
        imdb_id = m_cached.get("imdbId") or imdb_id or ""
        orig_lang = m_cached.get("origLang") or ""
        disp = _clean_query_title(disp) or tr_title
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as cat_pool:
            fut_direct = cat_pool.submit(_extract_direct_stream_sync, eff_tid, mtype, s, e, orig_title, year, imdb_id, tr_title, source_url, refresh)
            fut_pmeta = cat_pool.submit(_fetch_platform_meta_sync, prov, tr_title or orig_title, tid, mtype)
            direct_list = fut_direct.result()
            try:
                pmeta = fut_pmeta.result(timeout=2.2)
            except Exception:
                def_aud, def_sub = PLATFORM_LANG_PROFILES.get(prov if prov in PROV_LABELS else "cinema", PLATFORM_LANG_PROFILES["cinema"])
                pmeta = {"prov": prov if prov in PROV_LABELS else "cinema", "officialUrl": "", "audioLangs": list(def_aud), "subLangs": list(def_sub)}
        if not direct_list:
            v_streams = _MAIN_SITES_VAULT.get("streams") or {}
            fb_candidates = []
            cand_keys = [f"tmdb:{mtype}:{tid}:{s}:{e}"]
            if mtype != "tv":
                cand_keys.append(f"id:{tid}")
                cand_keys.append(f"tmdb:{mtype}:{tid}:1:1")
            for tc in (tr_title, orig_title, disp, title):
                nt = _norm_title(tc or "")
                if nt:
                    cand_keys.append(f"{mtype}:{nt}:{s}:{e}")
                    if mtype != "tv":
                        cand_keys.append(f"{mtype}:{nt}:1:1")
            for vk_try in cand_keys:
                v_ent = v_streams.get(vk_try) or {}
                for st_item in (v_ent.get("streams") or []):
                    if isinstance(st_item, (list, tuple)) and len(st_item) >= 2 and str(st_item[0]).startswith("http"):
                        st_u, st_t = str(st_item[0]), str(st_item[1])
                        if _is_vault_url_expired(st_u):
                            continue
                        if IS_VERCEL and (
                            st_t in ("hls_dbx", "hls_dp", "hls_hfnl", "hls_hfnl_multi")
                            or "dbx.molystream.org" in st_u.lower()
                            or "dplayer" in st_u.lower()
                            or "hdfilmcehennemi.mobi" in st_u.lower()
                            or ("cdnimages" in st_u.lower() and "/hls/" in st_u.lower())
                            or "playmix.uno" in st_u.lower()
                            or "master.txt?s=" in st_u.lower()
                        ):
                            continue
                        if _stream_matches_title(st_u, [orig_title, tr_title, disp, title]):
                            fb_candidates.append((st_u, st_t))
            direct_list = fb_candidates[:3]
        has_non_yt = any(st != "yt" and "youtube.com/watch?v=" not in str(u) for u, st in (direct_list or []))
        yt_vault_hit = "" if has_non_yt else next((u for u, st in (direct_list or []) if st == "yt" or "youtube.com/watch?v=" in str(u)), "")
        if yt_vault_hit:
            m_yv = YT_RE.search(yt_vault_hit)
            if m_yv:
                vid = m_yv.group(1)
                dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
                full_title = f"{disp or tr_title or orig_title} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else (disp or tr_title or orig_title)
                return {
                    "provider": "youtube",
                    "catalogProvider": prov if prov in PROV_LABELS else "youtube",
                    "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype, "season": s, "episode": e,
                    "seriesTitle": disp or tr_title or orig_title,
                    "originalTitle": orig_title, "year": year, "origLang": orig_lang or "tr",
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
        if not direct_list:
            yt_res = _extract_official_yt_sync(tr_title or orig_title or disp or title, s, e, mtype, [orig_title, tr_title, disp, title])
            if yt_res:
                vid = yt_res["videoId"]
                dur = yt_res["duration"]
                full_title = f"{disp or tr_title or orig_title} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else (disp or tr_title or orig_title)
                return {
                    "provider": "youtube",
                    "catalogProvider": prov if prov in PROV_LABELS else "youtube",
                    "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype, "season": s, "episode": e,
                    "seriesTitle": disp or tr_title or orig_title,
                    "originalTitle": orig_title, "year": year, "origLang": orig_lang or "tr",
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
                    "channel": f"{label} · {yt_res['channel']} (1080p HD)",
                    "duration": dur,
                }
        if direct_list:
            primary_p = (m_cached or {}).get("primaryProv") or ""
            eff_prov = pmeta.get("prov") or (prov if prov in PROV_LABELS else "cinema")
            if primary_p and (eff_prov in ("cinema", "web") or (eff_prov == "prime" and primary_p == "max")):
                eff_prov = primary_p
            label = PROV_LABELS.get(eff_prov, label)
            wrapped = [(_wrap_first_party_stream(u, st, eff_prov, eff_tid, s, e), "mp4" if str(st).startswith("mp4") else "hls") for u, st in direct_list]
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as sub_pool:
                fut_subs = sub_pool.submit(_fetch_subtitles_sync, eff_tid, imdb_id, mtype, s, e, eff_prov, pmeta, direct_list)
                fut_intro_api = sub_pool.submit(_detect_intro_sync, imdb_id, tid, mtype, s, e, None)
                fut_audio = sub_pool.submit(_build_audio_tracks, wrapped[0][0], direct_list, eff_prov, eff_tid, s, e, pmeta, mtype)
                try:
                    sub_tracks = fut_subs.result(timeout=5.5)
                except Exception:
                    sub_tracks = []
                try:
                    intro_seg = fut_intro_api.result(timeout=1.5)
                except Exception:
                    intro_seg = None
                try:
                    audio_tracks = fut_audio.result(timeout=5.5)
                except Exception:
                    audio_tracks = []
            if not intro_seg and sub_tracks:
                intro_seg = _detect_intro_sync(imdb_id, tid, mtype, s, e, sub_tracks)
            sub_tracks = _filter_live_subs(sub_tracks)
            alive_wrapped = [(_wrap_first_party_stream(u, st, eff_prov, eff_tid, s, e), "mp4" if str(st).startswith("mp4") else "hls") for u, st in direct_list if _STREAM_RES_HINT.get(u, 0) != -1] or wrapped
            if not audio_tracks:
                audio_tracks = [{"id": "src-1", "lang": "und", "targetLang": "und", "audioLang": "", "label": f"🎧 Varsayılan Ses ({label})", "mode": "stream", "url": alive_wrapped[0][0]}]
            stream_url = audio_tracks[0]["url"] if audio_tracks else alive_wrapped[0][0]
            stype = "mp4" if ("&ext=.mp4" in stream_url or ".mp4" in stream_url) else alive_wrapped[0][1]
            alt_urls = list(dict.fromkeys([t["url"] for t in audio_tracks if t.get("url")] + [_wrap_first_party_stream(u, st, eff_prov, eff_tid, s, e) for u, st in direct_list if _STREAM_RES_HINT.get(u, 0) != -1])) or [u for u, _ in wrapped]
            servers = []
            seen_srv_u = set()
            for u_raw, st_raw in direct_list:
                if _STREAM_RES_HINT.get(u_raw, 0) == -1 and len(alive_wrapped) > 0:
                    continue
                wu_srv = _wrap_first_party_stream(u_raw, st_raw, eff_prov, eff_tid, s, e)
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
            is_720_likely = any("720" in st or "pilavyer" in u or st == "hls_pv" for u, st in (direct_list or [])) and not any(st in ("hls_1080", "mp4_vl_1080", "hls_fhd", "hls_fhd_multi", "hls_fhd_tr") for _, st in (direct_list or []))
            res_str = "720p HD" if is_720_likely else "1080p HD"
            return {
                "provider": eff_prov,
                "catalogProvider": eff_prov,
                "tmdbId": tid, "imdbId": imdb_id, "mediaType": mtype, "season": s, "episode": e,
                "seriesTitle": disp or tr_title or orig_title,
                "originalTitle": orig_title, "year": year, "origLang": orig_lang,
                "streamType": stype, "url": stream_url, "embedUrl": "", "altUrls": alt_urls[:6], "servers": servers[:8],
                "subtitleTracks": sub_tracks, "audioTracks": audio_tracks, "intro": intro_seg,
                "platformAudioLangs": pmeta.get("audioLangs") or [],
                "platformSubLangs": pmeta.get("subLangs") or [],
                "officialUrl": official_url, "providerUrl": official_url,
                "title": full_title, "thumbnail": poster,
                "channel": f"{label} · {'Tam Bölüm' if mtype == 'tv' else 'Tam Film'} ({res_str})",
                "duration": dur,
            }
        # REMOVED 4 FOREIGN EMBED FALLBACKS (vidsrc.cc, vidlink.pro, autoembed.cc, vidsrc.to)
        return None


_RESOLVE_RESP_CACHE: dict[str, tuple[float, dict]] = {}
_RESOLVE_LOCKS: dict[str, asyncio.Lock] = {}
_CATALOG_LOCKS: dict[str, asyncio.Lock] = {}
_SUPERSEARCH_CACHE: dict[str, tuple[float, dict]] = {}


async def resolve_catalog(request: Request):
    prov = (request.query_params.get("provider") or "netflix").strip().lower()
    title = (request.query_params.get("title") or "Sinema").strip()[:160]
    display_title = (request.query_params.get("displayTitle") or title).strip()[:160]
    year = (request.query_params.get("year") or "").strip()[:10]
    tmdb_id = (request.query_params.get("tmdbId") or "").strip()[:30]
    imdb_id = (request.query_params.get("imdbId") or "").strip()[:30]
    media_type = (request.query_params.get("mediaType") or request.query_params.get("type") or "movie").strip().lower()
    poster = (request.query_params.get("poster") or "").strip()[:600]
    source_url = (request.query_params.get("sourceUrl") or "").strip()[:600]
    force_refresh = (request.query_params.get("refresh") or "").strip().lower() in ("1", "true", "yes")
    try:
        season = max(1, int(request.query_params.get("season") or request.query_params.get("s") or 1))
        episode = max(1, int(request.query_params.get("episode") or request.query_params.get("e") or 1))
    except (TypeError, ValueError):
        season, episode = 1, 1
    ckey = f"v21|{prov}|{media_type}|{tmdb_id or imdb_id or title.lower()}|{season}|{episode}"
    now_t = time.time()
    cc_hdrs = {"Cache-Control": "no-store" if force_refresh else "public, max-age=60, s-maxage=90, stale-while-revalidate=180"}
    if not force_refresh:
        cached = _RESOLVE_RESP_CACHE.get(ckey)
        if cached and now_t - cached[0] < 120:
            return JSONResponse(cached[1], headers=cc_hdrs)
    lock = _RESOLVE_LOCKS.setdefault(ckey, asyncio.Lock())
    async with lock:
        if not force_refresh:
            cached = _RESOLVE_RESP_CACHE.get(ckey)
            if cached and time.time() - cached[0] < 120:
                return JSONResponse(cached[1], headers=cc_hdrs)
        try:
            res = await asyncio.wait_for(asyncio.to_thread(_resolve_catalog_sync, prov, title, year, tmdb_id, media_type, poster, season, episode, imdb_id, display_title, source_url, force_refresh), timeout=18)
        except Exception:
            res = None
        if res:
            if len(_RESOLVE_RESP_CACHE) >= 400:
                _RESOLVE_RESP_CACHE.pop(next(iter(_RESOLVE_RESP_CACHE)), None)
            _RESOLVE_RESP_CACHE[ckey] = (time.time(), res)
    if not res:
        return JSONResponse({"error": "Oynatılabilir tam içerik bulunamadı"}, status_code=404)
    return JSONResponse(res, headers=cc_hdrs)


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

    def _norm_poster(u_img: str) -> str:
        u_img = str(u_img or "").strip()
        if not u_img or u_img.startswith("/"):
            return u_img
        if "image.tmdb.org" in u_img:
            return u_img
        if any(d in u_img for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter.")):
            return f"/api/rave/poster?u={urllib.parse.quote(u_img, safe='')}"
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
        poster = _norm_poster(it.get("poster") or "")
        backdrop = _norm_poster(it.get("backdrop") or poster)
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

    for src_key, badge in (("fhd", "🎬 FullHDFilm 4K"), ("hfnl", "🎬 HDFilmCehennemi+"), ("dbx", "📺 Dizibox HD"), ("ac", "⛩️ Animetrix Fansub")):
        src_list = list(v_cat.get(src_key) or [])
        if len(src_list) > 250:
            src_list = random.sample(src_list, 250)
        for v_it in src_list:
            _add_cand(v_it, badge)

    for _, c_entry in list(_CATALOG_MEM_CACHE.items())[:8]:
        if isinstance(c_entry, tuple) and len(c_entry) == 2 and isinstance(c_entry[1], dict):
            for c_it in (c_entry[1].get("items") or [])[:40]:
                _add_cand(c_it, "🔥 4K Sinema Arşivi")

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
                    _add_cand(_tmdb_item(r, "movie"), "🎬 Sinema+ 4K")
    except Exception:
        pass

    random.shuffle(pool_items)
    with_backdrop = [x for x in pool_items if "image.tmdb.org" in str(x.get("backdrop") or x.get("poster") or "")]
    others = [x for x in pool_items if "image.tmdb.org" not in str(x.get("backdrop") or x.get("poster") or "")]
    random.shuffle(with_backdrop)
    random.shuffle(others)
    final_items = (with_backdrop + others)[:max(12, min(96, int(limit or 40)))]
    return {
        "items": final_items,
        "totalAvailable": 42600,
        "totalTv": 18400,
        "totalMovies": 24200,
        "page": 1,
        "category": cat_c,
        "shuffled": True,
        "hasMore": True,
    }


async def provider_catalog(request: Request):
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
            res = {"items": [], "totalAvailable": 42600, "totalTv": 18400, "totalMovies": 24200, "page": 1, "category": category, "shuffled": True, "hasMore": True}
        return JSONResponse(
            {"provider": prov, "query": "", **res},
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
    ckey = f"v3:{prov}:{category}:{page}:{mt_filter}:{q.lower()}"
    lock = _CATALOG_LOCKS.setdefault(ckey, asyncio.Lock())
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
    return JSONResponse(
        {"provider": prov, "query": q, **res},
        headers={"Cache-Control": "public, max-age=60, s-maxage=600, stale-while-revalidate=1800"},
    )


async def supersearch(request: Request):
    q = (request.query_params.get("q") or "").strip()[:200]
    if not q:
        return JSONResponse({"youtube": [], "tmdb": [], "justwatch": []})
    qkey = q.lower()
    cached = _SUPERSEARCH_CACHE.get(qkey)
    cc_hdrs = {"Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900"}
    if cached and time.time() - cached[0] < 300:
        return JSONResponse(cached[1], headers=cc_hdrs)
    res = await asyncio.gather(asyncio.to_thread(_yt_search_sync, q), asyncio.to_thread(_tmdb_sync, q), asyncio.to_thread(_justwatch_sync, q), return_exceptions=True)
    yt, tmdb, jw = [r if isinstance(r, list) else [] for r in res]
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
        guess = fallback_title or (raw_t if raw_t.lower() not in ("netflix", "disney+", "prime video", "max", "crunchyroll", "just a moment...") else "") or (slugs[-1].replace("-", " ").title() if slugs else "Stranger Things")
        guess_mtype = "movie" if ("/film/" in url.lower() or matched_prov in ("hdfilmcehennemi", "fullhdfilm") and "/dizi/" not in url.lower() and "/bolum/" not in url.lower()) else "tv"
        return _resolve_catalog_sync(matched_prov, guess, "", "", guess_mtype, "", 1, 1, "", guess, url)
    title = fallback_title or raw_t or urllib.parse.urlparse(url).hostname
    img = re.search(r"<meta[^>]+property=[\"']og:image[\"'][^>]+content=[\"']([^\"']+)", html, re.I)
    thumb = img.group(1) if img and img.group(1).startswith("https://") else ""
    for pat, prov in ((r"(https?:\\?/\\?/[^\s\"'<>]+?\.m3u8[^\s\"'<>]*)", "hls"), (r"(https?:\\?/\\?/[^\s\"'<>]+?\.(?:mp4|webm)(?:\?[^\s\"'<>]*)?)", "direct")):
        mm = re.search(pat, html, re.I)
        if mm:
            return {"provider": prov, "url": mm.group(1).replace("\\/", "/"), "title": title, "thumbnail": thumb}
    og = re.search(r"<meta[^>]+property=[\"']og:video(?::secure_url|:url)?[\"'][^>]+content=[\"']([^\"']+)", html, re.I)
    if og:
        yt = YT_RE.search(og.group(1))
        if yt:
            return {"provider": "youtube", "videoId": yt.group(1), "url": f"https://www.youtube.com/watch?v={yt.group(1)}", "title": title, "thumbnail": f"https://i.ytimg.com/vi/{yt.group(1)}/hqdefault.jpg"}
        if re.search(r"\.(mp4|webm|m3u8)(\?|$)", og.group(1), re.I):
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
    "pluto":       {"name": "Pluto TV", "domain": ".pluto.tv", "loginUrl": "https://pluto.tv/ sign-in", "browseUrl": "https://pluto.tv", "authCookies": ["pluto_jwt", "pluto_session"], "idRegex": r"pluto\.tv/.*?(?:movies|series|live-tv)/([\w-]+)"},
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
    return JSONResponse({"accounts": accounts, "zeroKnowledge": True})


async def rave_login_account(request: Request):
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
    email = (payload.get("email") or "").strip()
    pwd = (payload.get("password") or "").strip()
    ok_cred, err_msg = await asyncio.to_thread(_verify_provider_credentials_sync, provider, spec, email, pwd)
    if ok_cred:
        return JSONResponse({"ok": False, "error": "Doğrulama köprüsü kapalı.", "code": "unsupported"}, status_code=501)
    return JSONResponse({"ok": False, "error": err_msg, "code": "unsupported"}, status_code=501)


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
    payload = await request.json()
    provider = (payload.get("provider") or "").strip().lower()
    domain = (payload.get("domain") or "").strip()
    return JSONResponse({"ok": True, "provider": provider, "domain": domain, "loginSatisfied": False})


async def rave_site_data(request: Request):
    return JSONResponse({"mainDomain": []})


import threading
_SEGMENT_CACHE: dict[str, tuple[float, bytes, str]] = {}
_SEG_TABLE_LOCK = threading.Lock()
_SEG_URL_LOCKS: dict[str, threading.Lock] = {}
_M3U8_CACHE: dict[str, tuple[float, str]] = {}


def _get_seg_lock(url: str) -> threading.Lock:
    with _SEG_TABLE_LOCK:
        if len(_SEG_URL_LOCKS) > 256:
            _SEG_URL_LOCKS.clear()
        return _SEG_URL_LOCKS.setdefault(url, threading.Lock())


def _proxy_chunk_sync(url: str, ref: str, rng: str):
    if not public_http_url(url):
        raise ValueError("Geçersiz URL")
    is_hakuna = "hakunaymatata.com" in url
    eff_ref = "" if is_hakuna else (ref or "").strip()
    if not eff_ref and not is_hakuna:
        if "filmboom" in url:
            eff_ref = "https://filmboom.top/"
        elif any(d in url for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "finalsignal.top")):
            eff_ref = "https://player.videasy.to/"
        elif "tau-video" in url:
            eff_ref = "https://tau-video.xyz/"
        elif "fastplay." in url or ".cfd/" in url:
            eff_ref = "https://x.ag2m5.cfd/" if "ag2m5.cfd" in url else "https://fastplay.mom/"
        elif "uk-traffic-" in url or "cdn77s.com" in url:
            eff_ref = "https://x.ag2m5.cfd/"
        elif "pilavyer" in url:
            eff_ref = f"https://{urllib.parse.urlparse(url).netloc or 'play2.pilavyerplay.top'}/"
        elif "dragonballzfans" in url:
            eff_ref = "https://flixer.su/"
        elif ("cdnimages" in url and "/hls/" in url) or "playmix.uno" in url or "hdfilmcehennemi.mobi" in url:
            eff_ref = "https://hdfilmcehennemi.mobi/"
        elif "cdnimgs" in url or ("cdnimage" in url and not ("cdnimages" in url and "/hls/" in url)) or "rapidvid" in url or re.search(r"https://s\d+\.[^/]+\.shop/m", url):
            eff_ref = "https://rapidvid.org/"
        elif "molystream" in url or "/sheila_" in url:
            eff_ref = "https://dbx.molystream.org/"
        elif "makesomthingup" in url or "centralodsseyproud" in url or "/r6/" in url:
            eff_ref = "https://one.makesomthingup.click/"
    hdrs = {
        "User-Agent": (
            "com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)"
            if is_hakuna
            else UA137
        )
    }
    if eff_ref and not is_hakuna:
        p = urllib.parse.urlparse(eff_ref)
        orig = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else ""
        hdrs["Referer"] = eff_ref
        if orig:
            hdrs["Origin"] = orig
    clean_u_path = url.lower().split("?", 1)[0]
    is_explicit_mp4 = any(clean_u_path.endswith(x) for x in (".mp4", ".webm", ".mkv")) or "/file/tau-video/" in url.lower()
    is_seg_url = (not is_explicit_mp4) and any(x in url for x in (".ts", ".png", ".jpg", ".m4s", "init-", "/r6/", ".aac", ".vtt", ".m3u8", ".cfd/", ".click/", "key.php", "pilavyer"))
    has_high_range = False
    if rng and rng.startswith("bytes="):
        m_hi = re.match(r"bytes=(\d+)-", rng)
        if m_hi and int(m_hi.group(1)) >= 8 * 1024 * 1024:
            has_high_range = True
        elif rng.startswith("bytes=-"):
            has_high_range = True
    is_full_mp4 = (is_explicit_mp4 and not is_seg_url) or has_high_range
    if not is_full_mp4:
        now = time.time()
        with _SEG_TABLE_LOCK:
            cached = _SEGMENT_CACHE.get(url)
        if cached and now - cached[0] < 45:
            data, ct = cached[1], cached[2]
        else:
            ulock = _get_seg_lock(url)
            with ulock:
                with _SEG_TABLE_LOCK:
                    cached = _SEGMENT_CACHE.get(url)
                if cached and time.time() - cached[0] < 45:
                    data, ct = cached[1], cached[2]
                else:
                    data = b""
                    ct = "video/mp2t"
                    for _attempt in range(2):
                        try:
                            req = urllib.request.Request(url, headers=hdrs)
                            with _public_open(req, timeout=8) as r:
                                data = r.read(15 * 1024 * 1024)
                                is_mpegts = len(data) >= 189 and data[0] == 0x47 and data[188] == 0x47
                                raw_ct = (r.headers.get("Content-Type") or "").lower()
                                if len(data) == 16 or "key.php" in url:
                                    ct = "application/octet-stream"
                                elif is_mpegts or ".ts" in url or ".png" in url or ".cfd/" in url or "/r6/s/" in url or "pilavyer" in url:
                                    ct = "video/mp2t"
                                elif "init-" in url or ".m4s" in url or ".mp4" in url:
                                    ct = "video/mp4"
                                elif "video/" in raw_ct or "audio/" in raw_ct or "mpegurl" in raw_ct:
                                    ct = r.headers.get("Content-Type")
                                else:
                                    ct = "video/mp2t"
                            if data:
                                break
                        except Exception:
                            if _attempt == 1:
                                raise
                            time.sleep(0.15)
                    if data and len(data) <= int(2.5 * 1024 * 1024):
                        with _SEG_TABLE_LOCK:
                            now_ts = time.time()
                            expired = [k for k, v_item in _SEGMENT_CACHE.items() if now_ts - v_item[0] > 45]
                            for k in expired:
                                _SEGMENT_CACHE.pop(k, None)
                            while len(_SEGMENT_CACHE) >= 28:
                                oldest = min(_SEGMENT_CACHE, key=lambda k: _SEGMENT_CACHE[k][0])
                                _SEGMENT_CACHE.pop(oldest, None)
                            _SEGMENT_CACHE[url] = (now_ts, data, ct)
        total = len(data)
        if rng and rng.startswith("bytes=") and total > 0:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if m:
                start = int(m.group(1))
                if start >= total:
                    return b"", 416, f"bytes */{total}", ct
                end = int(m.group(2)) if m.group(2) else (total - 1)
                end = min(max(start, end), total - 1)
                part = data[start:end + 1]
                return part, 206, f"bytes {start}-{start + len(part) - 1}/{total}", ct
        return data, 200, "", ct

    chunk_sz = 2560 * 1024
    start, end = 0, chunk_sz - 1
    if rng and rng.startswith("bytes="):
        m_suf = re.match(r"bytes=-(\d+)", rng)
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        if m_suf:
            hdrs["Range"] = f"bytes=-{min(int(m_suf.group(1)), chunk_sz)}"
        elif m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else start + chunk_sz - 1
            if end - start >= chunk_sz:
                end = start + chunk_sz - 1
            hdrs["Range"] = f"bytes={start}-{end}"
    if "Range" not in hdrs:
        hdrs["Range"] = f"bytes={start}-{end}"
    req = urllib.request.Request(url, headers=hdrs)
    with _public_open(req, timeout=10) as r:
        data = r.read(chunk_sz + 1024)
        cr = r.headers.get("Content-Range") or ""
        status = 206 if cr else 200
        return data, status, cr, "video/mp4"


async def rave_stream_manifest(request: Request):
    import base64
    sid = (request.query_params.get("sid") or "").strip()
    ref_mode = (request.query_params.get("ref") or "").strip()
    prov = (request.query_params.get("provider") or "netflix").strip()
    tid = (request.query_params.get("tmdbId") or "").strip()
    s_num = (request.query_params.get("s") or "1").strip()
    e_num = (request.query_params.get("e") or "1").strip()
    fp_id = (request.query_params.get("fp_id") or "").strip()
    sp = (request.query_params.get("sp") or "").strip()
    try:
        spt = int(request.query_params.get("spt") or 0)
    except ValueError:
        return JSONResponse({"error": "Geçersiz akış parametresi"}, status_code=400)
    aud_pref = (request.query_params.get("aud") or "").strip().lower()
    proxy_segs = request.query_params.get("proxy_segs") == "1"
    is_probe = request.query_params.get("probe") == "1"
    target = ""
    if sid:
        try:
            pad = sid + "=" * ((4 - len(sid) % 4) % 4)
            target = base64.urlsafe_b64decode(pad.encode("ascii")).decode("utf-8")
        except Exception:
            target = ""
    if not target:
        target = (request.query_params.get("u") or "").strip()
    if not target or not public_http_url(target):
        return JSONResponse({"error": "Geçersiz akış"}, status_code=400)
    is_live_tv = any(d in target for d in ("ercdn.net", "daioncdn.net", "radyotvonline.", "trt.com.tr", "ensonhaber.com", "powerapp.com.tr"))
    is_ve = ref_mode == "ve" or any(d in target for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "finalsignal.top"))
    is_fp = ref_mode == "fp" or "fastplay." in target
    is_dp = ref_mode == "dp" or "ag2m5.cfd" in target or "uk-traffic-" in target
    is_pv = ref_mode == "pv" or "pilavyer" in target
    is_hfnl = ref_mode == "hfnl" or ("cdnimages" in target and "/hls/" in target) or "playmix.uno" in target or "hdfilmcehennemi.mobi" in target
    is_fhd = (not is_hfnl) and (ref_mode == "fhd" or "cdnimgs" in target or ("cdnimage" in target and not ("cdnimages" in target and "/hls/" in target)) or "rapidvid" in target or bool(re.search(r"https://s\d+\.[^/]+\.shop/m", target)))
    is_dbx = ref_mode == "dbx" or "molystream.org" in target
    is_dl = ref_mode == "dl" or "makesomthingup" in target or "centralodsseyproud" in target or "/r6/" in target
    m3u8_ckey = f"v2|{target}|{aud_pref}|{prov}|{tid}|{s_num}|{e_num}|{int(proxy_segs)}"
    now_m = time.time()
    cached_m = _M3U8_CACHE.get(m3u8_ckey)
    ttl_m = 2.0 if is_live_tv else 240.0
    if cached_m and now_m - cached_m[0] < ttl_m:
        return Response(cached_m[1], media_type="application/vnd.apple.mpegurl", headers={
            "Access-Control-Allow-Origin": "*",
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
                hdrs["Referer"] = "https://player.videasy.to/"
                hdrs["Origin"] = "https://player.videasy.to"
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
                hdrs["Referer"] = "https://flixer.su/"
                hdrs["Origin"] = "https://flixer.su"
            cur_target = "https://shrek.dragonballzfans.xyz/" + target.split("serve.dragonballzfans.xyz/", 1)[1] if "serve.dragonballzfans.xyz/" in target else target
            now_dp = time.time()
            if is_hfnl and ("/master.txt" in cur_target or "hdfilmcehennemi.mobi/video/embed/" in cur_target):
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
            for attempt in range(1 if is_probe else 2):
                try:
                    if is_fp and cur_sp:
                        hdrs["X-Sp"] = _gen_fp_xsp(cur_sp, cur_spt)
                    req = urllib.request.Request(cur_target, headers=hdrs)
                    with _public_open(req, timeout=4.2 if is_probe else 5.5) as r:
                        raw = r.read(512 * 1024).decode("utf-8", errors="ignore")
                    if raw and "#EXTM3U" in raw:
                        break
                    raw = ""
                except Exception as err:
                    last_err = err
                    if is_fp and fp_id and attempt == 0 and not is_probe:
                        try:
                            fp_u = f"https://fastplay.mom/video/{fp_id}"
                            fp_html = urllib.request.urlopen(urllib.request.Request(fp_u, headers={"User-Agent": UA137, "Referer": "https://setplay.shop/"}), timeout=4.0).read(MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
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
            if not raw and tid.isdigit() and not is_probe:
                s_i, e_i = int(s_num or 1), int(e_num or 1)
                mt_guess = "tv" if (f"v32:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or f"v31:tv:{tid}:{s_i}:{e_i}" in _STREAM_CACHE or s_i > 1 or e_i > 1) else ("movie" if (f"v32:movie:{tid}:1:1" in _STREAM_CACHE or f"v31:movie:{tid}:1:1" in _STREAM_CACHE) else "tv")
                cands = []
                for mt_try in (mt_guess, "movie" if mt_guess == "tv" else "tv"):
                    for ver_p in ("v32", "v31", "v30", "v29", "v28"):
                        c_entry = _STREAM_CACHE.get(f"{ver_p}:{mt_try}:{tid}:{s_i}:{e_i}")
                        if c_entry and c_entry.get("val"):
                            cands.extend(c_entry["val"])
                if not cands:
                    try:
                        cands = _extract_direct_stream_sync(tid, mt_guess, s_i, e_i) or []
                    except Exception:
                        cands = []
                for cand_u, cand_k in cands:
                    if not cand_u or cand_u == cur_target or not cand_u.startswith("http") or str(cand_k).startswith("mp4") or "serve.dragonballzfans.xyz" in cand_u or "finalsignal.top" in cand_u:
                        continue
                    try:
                        c_hdrs = {"User-Agent": UA137}
                        if "ve" in str(cand_k) or any(d in cand_u for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "finalsignal.top")):
                            c_hdrs["Referer"] = "https://player.videasy.to/"
                            c_hdrs["Origin"] = "https://player.videasy.to"
                        elif "fhd" in str(cand_k) or "cdnimgs" in cand_u or "cdnimage" in cand_u or re.search(r"https://s\d+\.[^/]+\.shop/m", cand_u):
                            c_hdrs["Referer"] = "https://rapidvid.org/"
                            c_hdrs["Origin"] = "https://rapidvid.org"
                        elif "dl" in str(cand_k) or "makesomthingup" in cand_u:
                            c_hdrs["Referer"] = "https://one.makesomthingup.click/"
                            c_hdrs["Origin"] = "https://one.makesomthingup.click"
                        elif "pilavyer" in cand_u or "pv" in str(cand_k):
                            pv_orig = f"https://{urllib.parse.urlparse(cand_u).netloc or 'play2.pilavyerplay.top'}"
                            c_hdrs["Referer"] = f"{pv_orig}/"
                            c_hdrs["Origin"] = pv_orig
                        elif "dragonballzfans" in cand_u:
                            c_hdrs["Referer"] = "https://flixer.su/"
                            c_hdrs["Origin"] = "https://flixer.su"
                        with _public_open(urllib.request.Request(cand_u, headers=c_hdrs), timeout=3.6) as r2:
                            cand_raw = r2.read(512 * 1024).decode("utf-8", errors="ignore")
                        if cand_raw and "#EXTM3U" in cand_raw:
                            raw = cand_raw
                            cur_target = cand_u
                            cur_k = str(cand_k)
                            break
                    except Exception:
                        continue
            if not raw:
                raise ValueError("Seçilen içerik için oynatılabilir manifest bulunamadı") from last_err
            base_u = cur_target
            cur_is_ve = any(d in cur_target for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "finalsignal.top")) or ("ve" in cur_k) or (cur_target == target and is_ve)
            cur_is_fp = ("fastplay." in cur_target) or (cur_target == target and is_fp)
            cur_is_pv = ("pilavyer" in cur_target) or (cur_target == target and is_pv)
            cur_is_dp = ("uk-traffic-" in cur_target) or ("ag2m5.cfd" in cur_target) or ("dplayer" in cur_target) or is_dp
            cur_is_hfnl = ("cdnimages" in cur_target and "/hls/" in cur_target) or ("playmix.uno" in cur_target) or (cur_target == target and is_hfnl)
            cur_is_fhd = (not cur_is_hfnl) and (("cdnimgs" in cur_target) or ("cdnimage" in cur_target and not ("cdnimages" in cur_target and "/hls/" in cur_target)) or ("rapidvid" in cur_target) or bool(re.search(r"https://s\d+\.[^/]+\.shop/m", cur_target)) or (cur_target == target and is_fhd))
            cur_is_dbx = ("molystream.org" in cur_target) or (cur_target == target and is_dbx)
            cur_is_dl = ("makesomthingup" in cur_target) or ("centralodsseyproud" in cur_target) or ("/r6/" in cur_target) or (cur_target == target and is_dl)
            is_master = "#EXT-X-STREAM-INF" in raw
            ps_q = ("&proxy_segs=1" if (proxy_segs or cur_is_dp or cur_is_hfnl or cur_is_dbx or cur_is_dl) else "") + ("&aud=" + urllib.parse.quote(aud_pref) if aud_pref else "")
            def _rewrite_u(u_str: str, is_sub_playlist: bool = False) -> str:
                if not u_str.startswith("http"):
                    u_str = urllib.parse.urljoin(base_u, u_str)
                if cur_is_fp and "/subtitle/" in u_str:
                    return f"/api/rave/subtitle.vtt?url={urllib.parse.quote(u_str, safe='')}&lang=tr"
                want_m3u8 = is_sub_playlist or is_master or (".m3u8" in u_str) or ("/manifests/" in u_str) or ("/index-" in u_str) or ("sublist_" in u_str) or ("nm.php" in u_str) or ("nl.php" in u_str) or ("/l.php" in u_str) or ("/m.php" in u_str) or ("/q/" in u_str) or ("/embed/sheila/" in u_str)
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
                    if cur_is_fp:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=fp&fp_id={fp_id}&sp={cur_sp}&spt={cur_spt}{ps_q}&ext=.m3u8"
                    if cur_is_pv:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=pv{ps_q}&ext=.m3u8"
                    if cur_is_dp:
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=dp{ps_q}&ext=.m3u8"
                    if "dragonballzfans" in cur_target or ref_mode == "hx":
                        return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}&ref=hx{ps_q}&ext=.m3u8"
                    return f"/api/rave/stream?provider={prov}&tmdbId={tid}&s={s_num}&e={e_num}&sid={sub_sid}{ps_q}&ext=.m3u8"
                if "key.php" in u_str:
                    return _proxy_u(u_str, f"https://{urllib.parse.urlparse(u_str).netloc or 'play2.pilavyerplay.top'}/")
                if cur_is_ve:
                    return _proxy_u(u_str, "https://player.videasy.to/", ".ts")
                if cur_is_hfnl or ("cdnimages" in u_str and "/hls/" in u_str):
                    return _proxy_u(u_str, "https://hdfilmcehennemi.mobi/", ".ts")
                if cur_is_dbx or "molystream" in u_str or "/sheila_" in u_str:
                    return _proxy_u(u_str, "https://dbx.molystream.org/", ".ts")
                if cur_is_dl or "makesomthingup" in u_str or "centralodsseyproud" in u_str or "/r6/" in u_str:
                    return _proxy_u(u_str, "https://one.makesomthingup.click/", ".ts")
                if cur_is_dp or "uk-traffic-" in u_str:
                    dp_ref = f"{urllib.parse.urlparse(cur_target).scheme}://{urllib.parse.urlparse(cur_target).netloc}/" if ("dplayer" in cur_target or ".com/f/" in u_str) else "https://x.ag2m5.cfd/"
                    return _proxy_u(u_str, dp_ref, ".ts")
                if cur_is_fp or ".cfd/" in u_str:
                    return _proxy_u(u_str, "https://fastplay.mom/", ".ts")
                if "dragonballzfans" in u_str or proxy_segs:
                    ref_p = "https://flixer.su/" if "dragonballzfans" in u_str else (
                        "https://rapidvid.org/" if cur_is_fhd else (
                        "https://hdfilmcehennemi.mobi/" if cur_is_hfnl else (
                        "https://dbx.molystream.org/" if cur_is_dbx else (
                        "https://one.makesomthingup.click/" if cur_is_dl else (
                        f"https://{urllib.parse.urlparse(cur_target).netloc or 'play2.pilavyerplay.top'}/" if cur_is_pv else "")))))
                    return _proxy_u(u_str, ref_p, ".ts")
                return u_str

            def _line_lang(l: str) -> str:
                lm = re.search(r'LANGUAGE="([^"]*)"', l)
                nm = re.search(r'NAME="([^"]*)"', l)
                return _norm_audio_lang(lm.group(1) if lm else "", nm.group(1) if nm else "")

            valid_aud_lines = [l.strip() for l in raw.splitlines() if 'TYPE=AUDIO' in l and 'URI="undefined' not in l]
            has_tr_aud = any(_line_lang(l) == "tr" for l in valid_aud_lines)
            has_orig_aud = any(_line_lang(l) != "tr" for l in valid_aud_lines)
            want_code = aud_pref if (aud_pref and aud_pref != "orig") else ""
            has_want = bool(want_code) and any(_line_lang(l) == want_code for l in valid_aud_lines)
            out_lines = []
            variant_pairs = []
            pending_inf = None
            has_default_aud = any('DEFAULT=YES' in l for l in valid_aud_lines)
            selected_aud_set = False
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
                            pending_inf = s_ln
                            continue
                        if 'TYPE=AUDIO' in s_ln:
                            if 'URI="undefined' in s_ln:
                                continue
                            l_code = _line_lang(s_ln)
                            is_tr_line = l_code == "tr"
                            if has_want or (aud_pref == "orig" and has_orig_aud) or (want_code and want_code != "tr" and has_orig_aud):
                                is_match = (l_code == want_code) if has_want else (not is_tr_line)
                                if is_match and not selected_aud_set:
                                    selected_aud_set = True
                                    s_ln = re.sub(r'DEFAULT=(?:YES|NO)', 'DEFAULT=YES', s_ln)
                                    s_ln = re.sub(r'AUTOSELECT=(?:YES|NO)', 'AUTOSELECT=YES', s_ln)
                                    if "DEFAULT=YES" not in s_ln:
                                        s_ln = s_ln.replace("TYPE=AUDIO,", "TYPE=AUDIO,DEFAULT=YES,AUTOSELECT=YES,", 1)
                                else:
                                    s_ln = re.sub(r'DEFAULT=(?:YES|NO)', 'DEFAULT=NO', s_ln)
                                    s_ln = re.sub(r'AUTOSELECT=(?:YES|NO)', 'AUTOSELECT=NO', s_ln)
                            elif not has_default_aud and 'DEFAULT=NO' in s_ln:
                                s_ln = s_ln.replace('DEFAULT=NO', 'DEFAULT=YES', 1)
                                has_default_aud = True
                        if s_ln.startswith("#EXT-X-I-FRAME-STREAM-INF"):
                            continue
                        if 'URI="' in s_ln:
                            is_media_tag = s_ln.startswith("#EXT-X-MEDIA")
                            s_ln = re.sub(r'URI="([^"]+)"', lambda m: f'URI="{_rewrite_u(m.group(1), is_sub_playlist=is_media_tag)}"', s_ln)
                    else:
                        raw_uri = s_ln
                        s_ln = _rewrite_u(s_ln, is_sub_playlist=is_master)
                        if pending_inf is not None:
                            inf_l = pending_inf
                            pending_inf = None
                            rm = re.search(r"RESOLUTION=(\d+)x(\d+)", inf_l, re.I)
                            w, h = (int(rm.group(1)), int(rm.group(2))) if rm else (0, 0)
                            if not w and not h:
                                comb = (inf_l + " " + raw_uri).lower()
                                if "2160" in comb or "4k" in comb:
                                    w, h = 3840, 2160
                                elif "1080" in comb or "/q/1" in comb:
                                    w, h = 1920, 1080
                                elif "720" in comb or "/q/2" in comb:
                                    w, h = 1280, 720
                                elif "480" in comb or "/q/3" in comb:
                                    w, h = 854, 480
                                elif "360" in comb or "240" in comb:
                                    w, h = 640, 360
                            eff_w = max(w, int(h * 16 / 9)) if (w or h) else 0
                            bm = re.search(r"BANDWIDTH=(\d+)", inf_l, re.I)
                            bw = int(bm.group(1)) if bm else 2500000
                            if eff_w >= 3000 and bw > 20000000:
                                bw = 12000000
                                inf_l = re.sub(r"BANDWIDTH=\d+", f"BANDWIDTH={bw}", inf_l)
                            elif 1880 <= eff_w < 3000 and bw > 8500000:
                                bw = 4500000
                                inf_l = re.sub(r"BANDWIDTH=\d+", f"BANDWIDTH={bw}", inf_l)
                            elif 1150 <= eff_w < 1880 and bw > 5000000:
                                bw = 2500000
                                inf_l = re.sub(r"BANDWIDTH=\d+", f"BANDWIDTH={bw}", inf_l)
                            variant_pairs.append((eff_w, bw, inf_l, s_ln))
                            continue
                out_lines.append(s_ln)
            if variant_pairs:
                has_fhd_var = any(v[0] >= 1880 for v in variant_pairs)
                if has_fhd_var:
                    variant_pairs = [v for v in variant_pairs if v[0] >= 1880]
                else:
                    has_hd_var = any(v[0] >= 1150 for v in variant_pairs)
                    if has_hd_var:
                        variant_pairs = [v for v in variant_pairs if v[0] >= 1150 or v[0] == 0]
                variant_pairs.sort(key=lambda v: (v[0], v[1]), reverse=True)
                for _, _, inf_l, uri_l in variant_pairs:
                    out_lines.append(inf_l)
                    out_lines.append(uri_l)
            return "\n".join(out_lines)
        body = await asyncio.wait_for(asyncio.to_thread(_fetch_m3u8), timeout=15.0)
        if body:
            if len(_M3U8_CACHE) >= 240:
                oldest_m = min(_M3U8_CACHE, key=lambda k: _M3U8_CACHE[k][0])
                _M3U8_CACHE.pop(oldest_m, None)
            _M3U8_CACHE[m3u8_ckey] = (time.time(), body)
        return Response(body, media_type="application/vnd.apple.mpegurl", headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=60, s-maxage=90, stale-while-revalidate=180",
        })
    except Exception:
        return JSONResponse({"error": "Seçilen içerik akışına ulaşılamadı"}, status_code=502, headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"})


_POSTER_MEM_CACHE = collections.OrderedDict()


def _fetch_poster_sync(url: str) -> tuple[bytes, str]:
    if url in _POSTER_MEM_CACHE:
        _POSTER_MEM_CACHE.move_to_end(url)
        return _POSTER_MEM_CACHE[url]
    ref = "https://www.fullhdfilmizlesene.now/"
    if "hdfilmcehennemi." in url:
        ref = "https://www.hdfilmcehennemi.nl/"
    elif "dizibox." in url:
        ref = "https://www.dizibox.live/"
    req = urllib.request.Request(url, headers={"User-Agent": UA137, "Referer": ref, "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"})
    with _public_open(req, timeout=5.0) as r:
        data = r.read(1024 * 1024)
        ct = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
    if data:
        _POSTER_MEM_CACHE[url] = (data, ct)
        while len(_POSTER_MEM_CACHE) > 250:
            _POSTER_MEM_CACHE.popitem(last=False)
    return data, ct


_POSTER_LIMIT = RateLimiter(120, 60.0, name="poster")


async def poster_proxy(request: Request):
    url = (request.query_params.get("url") or request.query_params.get("u") or "").strip()
    ref = (request.query_params.get("referer") or "").strip()
    sig = (request.query_params.get("sig") or "").strip()
    is_whitelisted_poster = any(d in url.lower() for d in ("fullhdfilmizlesene.", "hdfilmcehennemi.", "dizibox.", "cdnhipter."))
    if not is_whitelisted_poster and not _proxy_sig_ok(url, ref, sig):
        return RedirectResponse("/static/watchlivo-poster.svg")
    allowed, retry_after = _POSTER_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    if not url.startswith(("https://", "http://")) or not public_http_url(url):
        return RedirectResponse("/static/watchlivo-poster.svg")
    try:
        data, ct = await asyncio.wait_for(asyncio.to_thread(_fetch_poster_sync, url), timeout=6.0)
        if data and ct.startswith("image/"):
            return Response(data, media_type=ct, headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=604800, s-maxage=604800, immutable",
            })
    except Exception:
        pass
    return RedirectResponse("/static/watchlivo-poster.svg")


async def stream_proxy(request: Request):
    url = (request.query_params.get("url") or "").strip()
    ref = (request.query_params.get("referer") or "").strip()
    sig = (request.query_params.get("sig") or "").strip()
    cors_hdrs = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    }
    if not url or not _proxy_sig_ok(url, ref, sig):
        return JSONResponse({"error": "İmzasız proxy isteği reddedildi"}, status_code=403, headers={"Cache-Control": "no-store", **cors_hdrs})
    rng = request.headers.get("range") or ("bytes=0-1023" if request.method == "HEAD" else "")
    try:
        data, status, cr, ct = await asyncio.wait_for(asyncio.to_thread(_proxy_chunk_sync, url, ref, rng), timeout=12)
        hdrs = {
            "Content-Type": ct,
            "Content-Length": str(len(data)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600, immutable",
            **cors_hdrs,
        }
        if cr and status in (206, 416):
            hdrs["Content-Range"] = cr
        return Response(b"" if request.method == "HEAD" else data, status_code=status if status in (200, 206, 416) else 200, headers=hdrs)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502, headers=cors_hdrs)


def _srt_to_vtt(raw_bytes) -> str:
    txt = ""
    if isinstance(raw_bytes, str):
        txt = raw_bytes
    else:
        for enc in ("utf-8-sig", "utf-8", "cp1254", "latin-1"):
            try:
                txt = raw_bytes.decode(enc)
                break
            except Exception:
                continue
    txt = txt.replace("\r\n", "\n").replace("\r", "\n").strip()
    if "<p " in txt and "begin=" in txt:
        cues = []
        for idx, m in enumerate(re.finditer(r'<p[^>]*\bbegin=["\']([^"\']+)["\'][^>]*\bend=["\']([^"\']+)["\'][^>]*>(.*?)</p>', txt, re.I | re.S), 1):
            b = m.group(1).replace(",", ".")
            e = m.group(2).replace(",", ".")
            body = re.sub(r"<br\s*/?>", "\n", m.group(3), flags=re.I)
            body = re.sub(r"<[^>]+>", "", body).strip()
            if body:
                cues.append(f"{idx}\n{b} --> {e}\n{body}")
        return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    if "<text " in txt and "start=" in txt:
        import html as _html_mod
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
            body = _html_mod.unescape(re.sub(r"<[^>]+>", " ", m.group(3) or "")).strip()
            if body:
                cues.append(f"{idx}\n{_fmt_sec(st_f)} --> {_fmt_sec(st_f + max(0.5, dur_f))}\n{body}")
        return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    txt = re.sub(r"\{\\[^}]*\}", "", txt)
    if "[Events]" in txt or re.search(r"(?m)^Dialogue:\s*\d+,", txt):
        cues = []
        for idx, m in enumerate(re.finditer(r"(?m)^Dialogue:\s*[^,]*,(\d+:\d{2}:\d{2}[.,]\d{2,3}),(\d+:\d{2}:\d{2}[.,]\d{2,3}),(?:[^,]*,){6}(.+)$", txt), 1):
            def _norm_ass_ts(ts_s: str) -> str:
                ts_s = ts_s.replace(",", ".")
                parts = ts_s.split(":")
                hh = int(parts[0])
                mm = int(parts[1])
                ss_p = parts[2].split(".")
                ss = int(ss_p[0])
                ms_raw = (ss_p[1] if len(ss_p) > 1 else "000").ljust(3, "0")[:3]
                return f"{hh:02d}:{mm:02d}:{ss:02d}.{ms_raw}"
            b_ts = _norm_ass_ts(m.group(1))
            e_ts = _norm_ass_ts(m.group(2))
            body = re.sub(r"\\[nN]", "\n", m.group(3)).replace("\\h", " ")
            body = html_mod.unescape(re.sub(r"<[^>]+>", "", body)).strip()
            if body:
                cues.append(f"{idx}\n{b_ts} --> {e_ts}\n{body}")
        if cues:
            return "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    txt = html_mod.unescape(txt)
    txt = re.sub(r"^X-TIMESTAMP-MAP[^\n]*\n?", "", txt, flags=re.M)
    txt = re.sub(r"(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})", r"\1.\2 --> \3.\4", txt)
    txt = re.sub(r"(?m)^(\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}[.,]\d{3})", lambda m: f"00:{m.group(1).replace(',', '.')} --> 00:{m.group(2).replace(',', '.')}", txt)
    txt = re.sub(
        r"(?im)^.*?(?:ai\.opensubtitles\.com|opensubtitles\.org|osdb\.link|advertise your product or brand here|support us and become vip|do you want subtitles for any video|çevrimiçi filmleri ve dizileri ücretsiz izleyin|yutukluklar\.xyz|www\.altyazi\.org|turkcealtyazi\.org|subscene\.com|çeviri\s*:|senkron\s*:|iyi seyirler dileriz).*$\n?",
        "",
        txt,
    )
    txt = re.sub(r"[♪♫♬♩]+", " ", txt)
    txt = re.sub(r"(?im)^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$\n?", "", txt)
    if not txt.startswith("WEBVTT"):
        txt = "WEBVTT\n\n" + txt
    return txt + "\n"


def _fetch_vtt_sync(url: str) -> str:
    import gzip
    if url in _SUB_VTT_CACHE:
        _SUB_VTT_CACHE.move_to_end(url)
        return _SUB_VTT_CACHE[url]
    ua_use = (
        "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)"
        if "youtube.com/api/timedtext" in url
        else ("TemporaryUserAgent" if "opensubtitles.org" in url else UA137)
    )
    hdrs = {"User-Agent": ua_use, "Accept": "*/*"}
    if any(d in url for d in ("zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "finalsignal.top")):
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
        hdrs["Origin"] = "https://rapidvid.org"
    elif "hdfilmcehennemi.mobi" in url:
        hdrs["Referer"] = "https://hdfilmcehennemi.mobi/"
        hdrs["Origin"] = "https://hdfilmcehennemi.mobi"
    elif "fastplay." in url or ".cfd/" in url:
        hdrs["Referer"] = "https://fastplay.mom/"
        hdrs["Origin"] = "https://fastplay.mom"
    req = urllib.request.Request(url, headers=hdrs)
    with _public_open(req, timeout=8.0) as r:
        raw = r.read(2 * 1024 * 1024)
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass
    vtt = _srt_to_vtt(raw)
    _SUB_VTT_CACHE[url] = vtt
    while len(_SUB_VTT_CACHE) > 40:
        _SUB_VTT_CACHE.popitem(last=False)
    return vtt


def _translate_vtt_to_tr_sync(vtt: str) -> str:
    ck = f"tr_vtt:{hashlib.md5(vtt[:4096].encode('utf-8', errors='ignore')).hexdigest()}:{len(vtt)}"
    if ck in _SUB_VTT_CACHE:
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

    def _tr_batch(b_tuple):
        b_idxs, b_txts = b_tuple
        joined = "\n ||| \n".join(b_txts)
        u = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q={urllib.parse.quote(joined)}"
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
    _SUB_VTT_CACHE[ck] = res_vtt
    return res_vtt


_INTRO_CACHE: dict[str, dict] = {}


def _detect_intro_sync(imdb_id: str, tid: str, mtype: str, s: int, e: int, subs: list) -> dict | None:
    if mtype != "tv":
        return None
    ck = f"v2:{imdb_id or tid}:{mtype}:{s}:{e}"
    if ck in _INTRO_CACHE:
        return _INTRO_CACHE[ck]
    if imdb_id and imdb_id.startswith("tt"):
        try:
            u = f"https://api.introdb.app/intro?imdb_id={urllib.parse.quote(imdb_id)}&season={s}&episode={e}"
            req = urllib.request.Request(u, headers={"User-Agent": UA137, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=2.2) as r:
                d = json.loads(r.read().decode("utf-8", errors="ignore"))
                s_sec = float(d.get("start_sec") or 0)
                e_sec = float(d.get("end_sec") or 0)
                if 0.0 <= s_sec <= 210.0 and 15.0 <= (e_sec - s_sec) <= 95.0 and e_sec <= 260.0:
                    res = {"start": round(max(2.0, s_sec), 1), "end": round(e_sec, 1), "label": "⏩ İntroyu Atla"}
                    _INTRO_CACHE[ck] = res
                    return res
        except Exception:
            pass
    if subs:
        credit_re = re.compile(r"(çeviri|altyazı|subtitle|opensubtitles|synced|iyi seyirler|www\.|http)", re.I)
        sdh_re = re.compile(r"^(?:\[[^\]]+\]|\([^)]+\)|♪.*♪)$", re.S)
        for sub_item in subs[:4]:
            try:
                t_url = sub_item.get("url") or ""
                if "url=" in t_url:
                    raw_u = urllib.parse.parse_qs(urllib.parse.urlparse(t_url).query).get("url", [""])[0]
                else:
                    raw_u = t_url
                if not raw_u.startswith("http"):
                    continue
                vtt = _fetch_vtt_sync(raw_u)
                cues = []
                for m in re.finditer(r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\n([^\n]+(?:\n[^\n]+)?)", vtt):
                    st = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0
                    et = int(m.group(5)) * 3600 + int(m.group(6)) * 60 + int(m.group(7)) + int(m.group(8)) / 1000.0
                    txt = re.sub(r"<[^>]+>", "", m.group(9)).strip()
                    if txt and et > st:
                        cues.append((st, et, txt))
                    if len(cues) >= 80:
                        break
                if len(cues) < 15:
                    continue
                spoken = [(st, et, tx) for st, et, tx in cues if not credit_re.search(tx) and not sdh_re.match(tx)]
                credits = [(st, et, tx) for st, et, tx in cues if credit_re.search(tx) and 15 <= st <= 195]
                if spoken:
                    first_st = spoken[0][0]
                    if credits:
                        c_st, c_et, _ = credits[0]
                        prev_s = [x for x in spoken if x[1] <= c_st + 2]
                        next_s = [x for x in spoken if x[0] >= c_et - 1]
                        g_start = prev_s[-1][1] + 1.0 if prev_s else 2.0
                        g_end = next_s[0][0] - 1.0 if next_s else (c_et + 5.0)
                        if 2.0 <= g_start <= 190.0 and 18.0 <= (g_end - g_start) <= 90.0 and g_end <= 245.0:
                            res = {"start": round(max(2.0, g_start), 1), "end": round(g_end, 1), "label": "⏩ İntroyu Atla"}
                            _INTRO_CACHE[ck] = res
                            return res
                    if 18.0 <= first_st <= 85.0:
                        res = {"start": 2.0, "end": round(first_st - 1.0, 1), "label": "⏩ İntroyu Atla"}
                        _INTRO_CACHE[ck] = res
                        return res
                    for i in range(len(spoken) - 1):
                        if spoken[i][1] > 190:
                            break
                        gap = spoken[i + 1][0] - spoken[i][1]
                        if 24.0 <= gap <= 88.0 and (spoken[i + 1][0] - 1.0) <= 245.0:
                            res = {"start": round(spoken[i][1] + 1.0, 1), "end": round(spoken[i + 1][0] - 1.0, 1), "label": "⏩ İntroyu Atla"}
                            _INTRO_CACHE[ck] = res
                            return res
            except Exception:
                continue
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
    s_ckey = f"v17|{prov}|{mtype}|{tid or imdb_id or title.lower()}|{s}|{e}"
    cc_hdrs = {"Cache-Control": "no-cache, no-store, must-revalidate", "CDN-Cache-Control": "no-store"}
    cached_s = _SUB_RESP_CACHE.get(s_ckey)
    if cached_s and time.time() - cached_s[0] < 600:
        return JSONResponse(cached_s[1], headers=cc_hdrs)
    lock = _SUB_RESP_LOCKS.setdefault(s_ckey, asyncio.Lock())
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
            subs = await asyncio.wait_for(asyncio.to_thread(_fetch_subtitles_sync, tid, imdb_id, mtype, s, e, prov, pmeta, direct_list), timeout=8)
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
        subs = await asyncio.to_thread(_filter_live_subs, subs)
        payload = {"subtitleTracks": subs, "subtitles": subs, "audioTracks": audio, "intro": intro_seg, "platformAudioLangs": pmeta.get("audioLangs") or [], "platformSubLangs": pmeta.get("subLangs") or []}
        if len(_SUB_RESP_CACHE) >= 300:
            _SUB_RESP_CACHE.pop(next(iter(_SUB_RESP_CACHE)), None)
        _SUB_RESP_CACHE[s_ckey] = (time.time(), payload)
        return JSONResponse(payload, headers=cc_hdrs)


async def rave_subtitle_vtt(request: Request):
    url = (request.query_params.get("url") or "").strip()
    fb = (request.query_params.get("fb") or "").strip()
    lang = (request.query_params.get("lang") or "").strip().lower()
    translate = (request.query_params.get("translate") or "").strip().lower()
    if not url.startswith(("https://", "http://")) or not public_http_url(url):
        return Response("WEBVTT\n\n", media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*"})
    vtt = ""
    need_tr = (translate == "tr")
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
            vtt = await asyncio.wait_for(asyncio.to_thread(_translate_vtt_to_tr_sync, vtt), timeout=8.5)
        except Exception:
            pass
    if not vtt or not vtt.startswith("WEBVTT"):
        vtt = "WEBVTT\n\n"
    if vtt.count("-->") < 1:
        return Response("WEBVTT\n\n", status_code=404, media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})
    return Response(vtt.encode("utf-8"), media_type="text/vtt; charset=utf-8", headers={
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    })


def _fetch_tts_mp3_sync(text: str, lang: str = "tr") -> bytes:
    ck = f"{lang}:{text[:180]}"
    if ck in _TTS_CACHE:
        _TTS_CACHE.move_to_end(ck)
        return _TTS_CACHE[ck]
    q = urllib.parse.quote(text[:180])
    u = f"https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl={urllib.parse.quote(lang[:5])}&q={q}"
    req = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://translate.google.com/"})
    with urllib.request.urlopen(req, timeout=4.5) as r:
        data = r.read(256 * 1024)
    if data:
        _TTS_CACHE[ck] = data
        while len(_TTS_CACHE) > 120:
            _TTS_CACHE.popitem(last=False)
    return data


async def rave_tts(request: Request):
    text = (request.query_params.get("q") or request.query_params.get("text") or "").strip()[:180]
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


_EXTRACT_LIMIT = RateLimiter(45, 60.0, name="extract")


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


def _uploads_dir_size() -> int:
    total = 0
    try:
        for entry in UPLOADS_DIR.iterdir():
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        return 0
    return total


async def upload_file(request: Request):
    if IS_VERCEL:
        return JSONResponse({"error": "Dosya yükleme bulut sürümünde kapalı. Dosyanı Google Drive'a yükleyip bağlantısını kullanabilirsin."}, status_code=501)
    # Uploads are expensive (disk, bandwidth): verified accounts only.
    uid = str(request.scope.get("wl_uid") or "")
    if not uid:
        return JSONResponse({"error": "Yükleme için giriş yapmalısın."}, status_code=401)
    allowed, retry_after = _UPLOAD_LIMIT.hit(uid)
    if not allowed:
        return too_many_response(retry_after)
    length = int(request.headers.get("content-length") or 0)
    if length > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "Dosya 1 GB sınırını aşıyor"}, status_code=413)
    if _uploads_dir_size() + max(0, length) > MAX_UPLOADS_TOTAL_BYTES:
        return JSONResponse({"error": "Sunucu depolama alanı dolu. Lütfen daha sonra tekrar dene."}, status_code=507)
    form = await request.form(max_part_size=MAX_UPLOAD_BYTES)
    file = form.get("file")
    if not file or not getattr(file, "filename", None):
        return JSONResponse({"error": "Dosya bulunamadı"}, status_code=400)
    ext = pathlib.Path(file.filename).suffix.lower()
    if ext not in ALLOWED_UPLOAD_EXTS:
        return JSONResponse({"error": f"Desteklenmeyen dosya türü: {ext}"}, status_code=400)
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    size = 0
    with open(UPLOADS_DIR / name, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                (UPLOADS_DIR / name).unlink(missing_ok=True)
                return JSONResponse({"error": "Dosya 1 GB sınırını aşıyor"}, status_code=413)
            out.write(chunk)
    return JSONResponse({"url": f"/uploads/{name}", "filename": pathlib.Path(file.filename).name[:120], "size": size})


async def manifest_json(request: Request):
    return JSONResponse({
        "name": "Watchlivo — Birlikte Sinema, Dizi & Müzik", "short_name": "Watchlivo", "description": "Arkadaşlarınla aynı anda, tek kare gecikmesiz izle — web, telefon ve masaüstü.",
        "start_url": "/", "display": "standalone", "background_color": "#080A0F", "theme_color": "#080A0F", "orientation": "any",
        "icons": [
            {"src": "/static/watchlivo-logo.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable"},
            {"src": "/static/watchlivo-icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": "/static/watchlivo-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    })


async def service_worker(request: Request):
    js = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.registration.unregister()));"
    return Response(js, media_type="application/javascript", headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


async def health(request: Request):
    mem_rooms = getattr(rooms.STORE, "rooms", {}) or {}
    total_p = sum(len((r.get("participants") or {})) for r in mem_rooms.values() if isinstance(r, dict))
    return JSONResponse({
        "ok": True,
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
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"), headers={"Cache-Control": "no-cache", "X-Frame-Options": "SAMEORIGIN"})


async def download_apk_endpoint(request: Request):
    if IS_VERCEL:
        return RedirectResponse(
            "https://github.com/mephisto-mert/watchlivo/raw/main/static/Watchlivo-v1.1.apk",
            status_code=302,
        )
    apk_file = STATIC_DIR / "Watchlivo-v1.1.apk"
    if not apk_file.exists():
        apk_file = STATIC_DIR / "Watchlivo-v1.0.apk"
    if apk_file.exists():
        return FileResponse(
            apk_file,
            media_type="application/vnd.android.package-archive",
            filename="Watchlivo-v1.1.0.apk",
            headers={"Content-Disposition": 'attachment; filename="Watchlivo-v1.1.0.apk"'},
        )
    return RedirectResponse(
        "https://github.com/mephisto-mert/watchlivo/raw/main/static/Watchlivo-v1.1.apk",
        status_code=302,
    )


async def download_windows_endpoint(request: Request):
    if IS_VERCEL:
        return RedirectResponse(
            "https://github.com/mephisto-mert/watchlivo/raw/main/static/Watchlivo.exe",
            status_code=302,
        )
    exe_file = STATIC_DIR / "Watchlivo.exe"
    if exe_file.exists():
        return FileResponse(
            exe_file,
            media_type="application/vnd.microsoft.portable-executable",
            filename="Watchlivo.exe",
            headers={"Content-Disposition": 'attachment; filename="Watchlivo.exe"'},
        )
    return RedirectResponse(
        "https://github.com/mephisto-mert/watchlivo/raw/main/static/Watchlivo.exe",
        status_code=302,
    )


async def download_ipa_endpoint(request: Request):
    ipa_file = STATIC_DIR / "Watchlivo.ipa"
    if ipa_file.exists() and not IS_VERCEL:
        return FileResponse(
            ipa_file,
            media_type="application/octet-stream",
            filename="Watchlivo.ipa",
            headers={"Content-Disposition": 'attachment; filename="Watchlivo.ipa"'},
        )
    return RedirectResponse(
        "https://github.com/mephisto-mert/watchlivo/raw/main/static/Watchlivo.ipa",
        status_code=302,
    )


async def download_ios_endpoint(request: Request):
    cfg_file = STATIC_DIR / "Watchlivo.mobileconfig"
    if cfg_file.exists():
        return FileResponse(
            cfg_file,
            media_type="application/x-apple-aspen-config",
            filename="Watchlivo.mobileconfig",
            headers={"Content-Disposition": 'attachment; filename="Watchlivo.mobileconfig"'},
        )
    return RedirectResponse(
        "https://github.com/mephisto-mert/watchlivo/raw/main/static/Watchlivo.mobileconfig",
        status_code=302,
    )


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
    """Return (uid, error_response). AI calls cost money, so they need an account."""
    uid = str(request.scope.get("wl_uid") or "")
    if not uid:
        return "", JSONResponse({"ok": False, "error": "Yapay zeka özellikleri için giriş yapmalısın."}, status_code=401)
    allowed, retry_after = limiter.hit(uid)
    if not allowed:
        return uid, too_many_response(retry_after)
    return uid, None


def _call_openai_sync(prompt: str, model: str) -> dict:
    use_model = (model or OPENAI_MODEL or "gpt-6.1-sol").split()[0].strip()
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
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def rave_ai_chat(request: Request):
    _uid, guard = _ai_guard(request, _AI_LIMIT)
    if guard:
        return guard
    try:
        body = await request.json()
    except Exception:
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
      <button class="portal-btn" onclick="handlePortalInput(document.getElementById('q-inp').value)">🔍 Ara / Aç</button>
      <button class="portal-btn sec" onclick="launchDirectUrl({json.dumps(target_url)})">▶ Bu Sayfayı Odada Başlat</button>
      <button class="portal-btn sec" onclick="window.open({json.dumps(target_url)}, '_blank', 'noopener')">↗ {prov_upper} Resmi Site</button>
    </div>
  </div>
  <div id="grid" class="portal-grid">Yükleniyor...</div>
  <script>
    const PROV = {json.dumps(prov)};
    const INIT_URL = {json.dumps(target_url)};
    function launchDirectUrl(u) {{
      window.parent.postMessage({{
        type: 'watchlivo_portal_pick',
        url: u || INIT_URL,
        title: PROV.toUpperCase() + ' İçeriği',
        provider: PROV
      }}, '*');
    }}
    function handlePortalInput(val) {{
      const v = String(val || '').trim();
      if (/^https?:\\/\\//i.test(v)) {{
        launchDirectUrl(v);
        return;
      }}
      loadCatalog(v);
    }}
    document.getElementById('q-inp').addEventListener('keydown', (e) => {{
      if (e.key === 'Enter') handlePortalInput(e.target.value);
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
          card.innerHTML = '<img src="' + (it.poster || it.backdrop || '/static/watchlivo-poster.svg') + '" alt="" />' +
            '<div class="p-item-body">' +
              '<div class="p-item-title">' + (it.title || '') + '</div>' +
              '<div class="p-item-sub">' + (it.year || '2025') + ' · ⭐ ' + (it.rating || '8.2') + '</div>' +
              '<div class="p-item-play">▶ Odada Başlat</div>' +
            '</div>';
          card.onclick = () => {{
            window.parent.postMessage({{
              type: 'watchlivo_portal_item',
              item: it,
              provider: PROV
            }}, '*');
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
    return HTMLResponse(portal_html, headers={
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
    })

import auth_engine
import music_engine

app = Starlette(
    routes=[
        Route("/", index),
        Route("/manifest.json", manifest_json),
        Route("/sw.js", service_worker),
        Route("/api/health", health),
        Route("/download/apk", download_apk_endpoint),
        Route("/download/ipa", download_ipa_endpoint),
        Route("/download/ios", download_ios_endpoint),
        Route("/download/windows", download_windows_endpoint),
        Route("/download/exe", download_windows_endpoint),
        Route("/api/auth/register", auth_engine.auth_register, methods=["POST"]),
        Route("/api/auth/login", auth_engine.auth_login, methods=["POST"]),
        Route("/api/auth/oauth", auth_engine.auth_oauth, methods=["POST"]),
        Route("/api/auth/phone/send-code", auth_engine.auth_phone_send_code, methods=["POST"]),
        Route("/api/auth/phone/verify-code", auth_engine.auth_phone_verify_code, methods=["POST"]),
        Route("/api/auth/email-action", auth_engine.auth_email_action, methods=["POST"]),
        Route("/api/auth/profile", auth_engine.auth_profile, methods=["POST"]),
        Route("/api/auth/me", auth_engine.auth_me, methods=["GET"]),
        Route("/api/rave/ai-status", rave_ai_status),
        Route("/api/rave/ai-chat", rave_ai_chat, methods=["GET", "POST"]),
        Route("/api/rave/suno-generate", rave_suno_generate, methods=["POST"]),
        Route("/api/search/youtube", search_youtube),
        Route("/api/rave/supersearch", supersearch),
        Route("/api/rave/catalog", provider_catalog),
        Route("/api/rave/provider-catalog", provider_catalog),
        Route("/api/rave/platform-catalog", provider_catalog),
        Route("/api/rave/seasons", title_seasons),
        Route("/api/rave/series-info", title_seasons),
        Route("/api/rave/resolve-catalog", resolve_catalog),
        Route("/api/rave/resolve-stream", resolve_catalog),
        Route("/api/rave/music-catalog", music_engine.music_catalog),
        Route("/api/rave/music-similar", music_engine.music_similar),
        Route("/api/rave/music-resolve", music_engine.music_resolve),
        Route("/api/rave/resolve-music", music_engine.music_resolve),
        Route("/api/rave/music-lyrics.vtt", music_engine.music_lyrics_vtt),
        Route("/api/rave/lyrics", music_engine.music_lyrics_vtt),
        Route("/api/rave/yt-music-stream", music_engine.yt_music_stream, methods=["GET", "HEAD"]),
        Route("/api/rave/stream", rave_stream_manifest),
        Route("/api/rave/stream-proxy", stream_proxy, methods=["GET", "HEAD"]),
        Route("/api/rave/poster-proxy", poster_proxy, methods=["GET", "HEAD"]),
        Route("/api/rave/poster", poster_proxy, methods=["GET", "HEAD"]),
        Route("/api/rave/subtitles", rave_subtitles),
        Route("/api/rave/subtitle.vtt", rave_subtitle_vtt),
        Route("/api/rave/sub-proxy", rave_subtitle_vtt),
        Route("/api/rave/tts", rave_tts),
        Route("/api/rave/accounts", rave_get_accounts),
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
        Route("/api/rooms/create", rooms.create_room, methods=["POST"]),
        Route("/api/rooms/{room_id}", rooms.room_info),
        Route("/api/rooms/{room_id}/sync", rooms.http_sync, methods=["GET", "POST"]),
        Route("/api/rooms/{room_id}/poll", rooms.http_sync, methods=["GET", "POST"]),
        Route("/api/rooms/{room_id}/action", rooms.http_sync, methods=["POST"]),
        WebSocketRoute("/ws/{room_id}", rooms.ws_endpoint),
        Mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR), check_dir=False), name="uploads"),
        Mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static"),
    ],
    middleware=[Middleware(SecurityHeaders), Middleware(IdentityMiddleware)],
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

