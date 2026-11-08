"""Watchlivo Auth & Account Engine — Rave Login / ProfileSetupPopUp / UserHeader parity.

Provides:
- POST /api/auth/register (Email + @handle + Password + Avatar/Color)
- POST /api/auth/login    (Email or @handle + Password)
- POST /api/auth/oauth    (Rave Social Sign-In: Google, Apple, X)
- POST /api/auth/profile  (Profile & Handle update)
- GET  /api/auth/me       (Stateless HMAC token + DB verification)
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from typing import Any, Dict, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse

IS_VERCEL = bool(os.environ.get("VERCEL"))
BASE_DIR = pathlib.Path(__file__).parent.resolve()
AUTH_DB_PATH = pathlib.Path("/tmp/watchlivo_auth.db") if IS_VERCEL else BASE_DIR / "rave_platform.db"

from security import BoundedTTLCache, RateLimiter, client_ip, constant_time_eq, server_secret, too_many_response

# Fail-closed: no public fallback secret. Without AUTH_SECRET the process uses an
# unguessable per-instance value (or refuses to boot with WATCHLIVO_STRICT_SECRETS=1).
AUTH_SECRET = server_secret("AUTH_SECRET") if len((os.environ.get("AUTH_SECRET") or "").strip()) >= 16 else server_secret("VORTEX_SECRET")
TOKEN_TTL = int(os.environ.get("AUTH_TOKEN_TTL") or 60 * 60 * 24 * 7)
_LOGIN_LIMIT = RateLimiter(20, 300.0, name="login")
_ACCT_LOGIN_LIMIT = RateLimiter(10, 300.0, name="login_acct")
_REGISTER_LIMIT = RateLimiter(15, 900.0, name="register")
_OTP_LIMIT = RateLimiter(5, 600.0, name="otp_send")
_OTP_VERIFY_LIMIT = RateLimiter(10, 600.0, name="otp_verify")
_RESET_LIMIT = RateLimiter(5, 3600.0, name="reset")
_PW_CHANGE_LIMIT = RateLimiter(10, 600.0, name="pw_change")
_PASSWORD_RESET_PENDING = BoundedTTLCache(maxsize=1000, default_ttl=3600.0)
_DELETED_UIDS = BoundedTTLCache(maxsize=4096, default_ttl=86400 * 30)
_USER_REVOKED_AFTER = BoundedTTLCache(maxsize=4096, default_ttl=TOKEN_TTL)

HANDLE_RE = re.compile(r"^[a-z0-9_.\-]{2,24}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")
AVATAR_DATA_RE = re.compile(r"^data:image/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)
AVATAR_URL_RE = re.compile(r"^(?:https://|/static/|/uploads/)[^\s<>\"'\\]+$")


def _is_valid_avatar_url(val: str) -> bool:
    s = str(val or "").strip()
    if not s:
        return True
    low = s.lower()
    if "svg" in low[:40] or "javascript:" in low or "vbscript:" in low or "data:text/" in low:
        return False
    if low.startswith("data:"):
        if len(s) > 45000:
            return False
        m = AVATAR_DATA_RE.match(s)
        if not m:
            return False
        try:
            raw = base64.b64decode(re.sub(r"\s+", "", m.group(1)), validate=True)
            return 8 <= len(raw) <= 36000 and b"<svg" not in raw[:512].lower()
        except Exception:
            return False
    if len(s) > 500 or not AVATAR_URL_RE.match(s):
        return False
    clean_path = low.split("?", 1)[0].split("#", 1)[0]
    if clean_path.endswith((".svg", ".svgz", ".html", ".htm", ".xml", ".xhtml")):
        return False
    return True


def _clean_color(val: Any, default: str = "#00f5d4") -> str:
    s = str(val or "").strip()[:16]
    return s if HEX_COLOR_RE.match(s) else default

FIREBASE_API_KEY = (
    os.environ.get("FIREBASE_API_KEY")
    or os.environ.get("NEXT_PUBLIC_FIREBASE_API_KEY")
    or "AIzaSyAeyDRstvjN8c_D08U8CrqopcFT0_fz9fo"
).strip()
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID") or "watchlivo-38ab6"
FIREBASE_AUTH_DOMAIN = os.environ.get("FIREBASE_AUTH_DOMAIN") or "watchlivo-38ab6.firebaseapp.com"
GOOGLE_OAUTH_CLIENT_ID = (
    os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
    or "1034129375158-watchlivo.apps.googleusercontent.com"
)


def _firebase_auth_req(endpoint: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not FIREBASE_API_KEY:
        return None
    url = f"https://identitytoolkit.googleapis.com/v1/{endpoint}?key={FIREBASE_API_KEY}"
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Firebase-Locale": "tr"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return None
    except Exception:
        return None


def _supabase_cfg():
    sb_url = (os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    sb_key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        or ""
    ).strip()
    return (sb_url, sb_key) if (sb_url and sb_key) else (None, None)


def _supabase_auth_req(path: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    sb_url, sb_key = _supabase_cfg()
    if not sb_url or not sb_key:
        return None
    try:
        req = urllib.request.Request(
            f"{sb_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "apikey": sb_key,
                "Authorization": f"Bearer {sb_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


_AUTH_DB_SCHEMA_READY = False
_AUTH_DB_READY_PATH = ""
_AUTH_DB_LOCK = threading.Lock()


def _get_db() -> sqlite3.Connection:
    global _AUTH_DB_SCHEMA_READY, _AUTH_DB_READY_PATH
    cur_path = str(AUTH_DB_PATH)
    conn = sqlite3.connect(cur_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout=5000")
    except Exception:
        pass
    if not _AUTH_DB_SCHEMA_READY or _AUTH_DB_READY_PATH != cur_path:
        with _AUTH_DB_LOCK:
            if not _AUTH_DB_SCHEMA_READY or _AUTH_DB_READY_PATH != cur_path:
                try:
                    try:
                        conn.execute("PRAGMA journal_mode=WAL")
                    except Exception:
                        pass
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS watchlivo_users (
                            uid TEXT PRIMARY KEY,
                            email TEXT UNIQUE,
                            handle TEXT UNIQUE,
                            name TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            salt TEXT NOT NULL,
                            color TEXT DEFAULT '#00f5d4',
                            avatar TEXT DEFAULT '🎬',
                            auth_provider TEXT DEFAULT 'email',
                            verified INTEGER DEFAULT 1,
                            created_at REAL DEFAULT 0,
                            updated_at REAL DEFAULT 0,
                            bio TEXT DEFAULT '',
                            status_text TEXT DEFAULT '',
                            status_emoji TEXT DEFAULT '🍿',
                            avatar_url TEXT DEFAULT '',
                            hide_watching INTEGER DEFAULT 0,
                            hide_friends INTEGER DEFAULT 0,
                            hide_location INTEGER DEFAULT 0,
                            password_set INTEGER DEFAULT 0,
                            tokens_valid_after REAL DEFAULT 0
                        )
                    """)
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS watchlivo_deleted_users (
                            uid TEXT PRIMARY KEY,
                            deleted_at REAL DEFAULT 0
                        )
                    """)
                    for col_def in [
                        "bio TEXT DEFAULT ''",
                        "status_text TEXT DEFAULT ''",
                        "status_emoji TEXT DEFAULT '🍿'",
                        "avatar_url TEXT DEFAULT ''",
                        "hide_watching INTEGER DEFAULT 0",
                        "hide_friends INTEGER DEFAULT 0",
                        "hide_location INTEGER DEFAULT 0",
                        "password_set INTEGER DEFAULT 0",
                        "tokens_valid_after REAL DEFAULT 0",
                    ]:
                        try:
                            conn.execute(f"ALTER TABLE watchlivo_users ADD COLUMN {col_def}")
                        except Exception:
                            pass
                    conn.commit()
                    _AUTH_DB_SCHEMA_READY = True
                    _AUTH_DB_READY_PATH = cur_path
                except Exception:
                    conn.close()
                    raise
    return conn


# ---------------------------------------------------------------------------
# User store: Upstash Redis REST (persistent, shared across serverless instances)
# with SQLite fallback for local development.
# Keys: {prefix}user:{uid} -> JSON row, {prefix}email:{email} -> uid, {prefix}handle:{handle} -> uid

def _kv_cfg():
    url = (os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL") or "").rstrip("/")
    tok = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN") or ""
    return (url, tok) if (url and tok) else (None, None)


def _kv(*cmd):
    url, tok = _kv_cfg()
    if not url or not tok:
        return None
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps([str(c) for c in cmd]).encode("utf-8"),
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            out = json.loads(r.read().decode("utf-8"))
        if isinstance(out, dict) and out.get("error"):
            return None
        return out.get("result") if isinstance(out, dict) else None
    except (OSError, TimeoutError, ValueError, RuntimeError, urllib.error.URLError):
        return None


def _kp() -> str:
    return os.environ.get("WL_KV_PREFIX") or "wl:"


def store_backend() -> str:
    return "redis" if _kv_cfg()[0] else "sqlite"


def _user_get(uid: str) -> Optional[Dict[str, Any]]:
    if not uid:
        return None
    if store_backend() == "redis":
        raw = _kv("GET", f"{_kp()}user:{uid}")
        return json.loads(raw) if raw else None
    conn = _get_db()
    try:
        row = conn.execute("SELECT * FROM watchlivo_users WHERE uid = ?", (uid,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _uid_for(kind: str, value: str) -> Optional[str]:
    if not value or kind not in ("email", "handle"):
        return None
    if store_backend() == "redis":
        return _kv("GET", f"{_kp()}{kind}:{value}")
    conn = _get_db()
    try:
        row = conn.execute(f"SELECT uid FROM watchlivo_users WHERE {kind} = ?", (value,)).fetchone()
        return row["uid"] if row else None
    finally:
        conn.close()


def _claim_handle(handle: str, uid: str) -> str:
    """Reserve a unique handle for uid; appends a random suffix on collision."""
    cand = handle
    for _ in range(6):
        if store_backend() == "redis":
            if _kv("SET", f"{_kp()}handle:{cand}", uid, "NX") == "OK" or _kv("GET", f"{_kp()}handle:{cand}") == uid:
                return cand
        else:
            owner = _uid_for("handle", cand)
            if not owner or owner == uid:
                return cand
        cand = f"{handle[:18]}_{secrets.token_hex(2)}"
    raise RuntimeError("Benzersiz kullanıcı adı ayrılamadı")


_ALLOWED_USER_COLS = frozenset({
    "uid", "email", "handle", "name", "password_hash", "salt",
    "color", "avatar", "auth_provider", "verified", "created_at", "updated_at",
    "bio", "status_text", "status_emoji", "avatar_url",
    "hide_watching", "hide_friends", "hide_location",
    "password_set", "tokens_valid_after",
})


def is_uid_deleted(uid: str) -> bool:
    if not uid:
        return False
    if _DELETED_UIDS.get(uid):
        return True
    if store_backend() == "redis":
        raw = _kv("GET", f"{_kp()}del_uid:{uid}")
        if raw:
            _DELETED_UIDS.set(uid, float(raw) if str(raw).replace(".", "", 1).isdigit() else time.time())
            return True
        return False
    try:
        conn = _get_db()
        try:
            row = conn.execute("SELECT deleted_at FROM watchlivo_deleted_users WHERE uid = ?", (uid,)).fetchone()
            if row:
                _DELETED_UIDS.set(uid, float(row["deleted_at"] or time.time()))
                return True
        finally:
            conn.close()
    except Exception:
        pass
    return False


def clear_uid_deleted(uid: str) -> None:
    if not uid:
        return
    _DELETED_UIDS.delete(uid)
    _USER_REVOKED_AFTER.delete(uid)
    if store_backend() == "redis":
        _kv("DEL", f"{_kp()}del_uid:{uid}")
        _kv("DEL", f"{_kp()}rev_uid:{uid}")
    else:
        try:
            conn = _get_db()
            try:
                conn.execute("DELETE FROM watchlivo_deleted_users WHERE uid = ?", (uid,))
                conn.commit()
            finally:
                conn.close()
        except Exception:
            pass


def _user_delete(uid: str) -> bool:
    if not uid:
        return False
    now_ts = round(time.time(), 3)
    row = _user_get(uid)
    _DELETED_UIDS.set(uid, now_ts)
    _USER_REVOKED_AFTER.set(uid, now_ts)
    if store_backend() == "redis":
        if row:
            if row.get("email"):
                _kv("DEL", f"{_kp()}email:{row['email']}")
            if row.get("handle"):
                _kv("DEL", f"{_kp()}handle:{row['handle']}")
        _kv("DEL", f"{_kp()}user:{uid}")
        _kv("SREM", f"{_kp()}uids", uid)
        _kv("SET", f"{_kp()}del_uid:{uid}", str(now_ts), "EX", 86400 * 30)
        _kv("SET", f"{_kp()}rev_uid:{uid}", str(now_ts), "EX", TOKEN_TTL)
    else:
        conn = _get_db()
        try:
            conn.execute("DELETE FROM watchlivo_users WHERE uid = ?", (uid,))
            conn.execute("INSERT OR REPLACE INTO watchlivo_deleted_users (uid, deleted_at) VALUES (?, ?)", (uid, now_ts))
            conn.commit()
        finally:
            conn.close()
    try:
        import social_engine
        social_engine._SOCIAL_USERS.pop(uid, None)
        social_engine._PRESENCE_MAP.pop(uid, None)
        social_engine._kv_set(f"wl:soc:u:{uid}", {}, ttl_sec=1)
        social_engine._kv_set(f"wl:soc:pres:{uid}", {"uid": uid, "state": "offline", "roomId": "", "lastSeen": 0}, ttl_sec=60)
        s_dir = social_engine._load_social_dir()
        if isinstance(s_dir, dict) and uid in s_dir:
            s_dir.pop(uid, None)
            social_engine._kv_set("wl:soc:dir", s_dir, ttl_sec=2592000)
    except Exception:
        pass
    return True


def _user_create(row: Dict[str, Any]) -> bool:
    """Insert a new user. Returns False when the e-mail is already registered."""
    uid, email = row["uid"], row["email"]
    if store_backend() == "redis":
        if _kv("SET", f"{_kp()}email:{email}", uid, "NX") != "OK":
            return False
        row["handle"] = _claim_handle(row["handle"], uid)
        _kv("SET", f"{_kp()}user:{uid}", json.dumps(row, ensure_ascii=False))
        try:
            _kv("SADD", f"{_kp()}uids", uid)
        except Exception:
            pass
        return True
    if _uid_for("email", email):
        return False
    row["handle"] = _claim_handle(row["handle"], uid)
    conn = _get_db()
    try:
        cols = [c for c in row.keys() if c in _ALLOWED_USER_COLS]
        conn.execute(f"INSERT INTO watchlivo_users ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", [row[c] for c in cols])
        conn.commit()
        return True
    finally:
        conn.close()


def _user_update(uid: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    cur = _user_get(uid)
    if not cur:
        return None
    new_handle = fields.get("handle")
    if new_handle and new_handle != cur.get("handle"):
        fields["handle"] = _claim_handle(new_handle, uid)
        if store_backend() == "redis" and cur.get("handle"):
            _kv("DEL", f"{_kp()}handle:{cur['handle']}")
    cur.update(fields)
    cur["updated_at"] = time.time()
    if store_backend() == "redis":
        _kv("SET", f"{_kp()}user:{uid}", json.dumps(cur, ensure_ascii=False))
        try:
            _kv("SADD", f"{_kp()}uids", uid)
        except Exception:
            pass
        return cur
    conn = _get_db()
    try:
        sets = [k for k in cur.keys() if k != "uid" and k in _ALLOWED_USER_COLS]
        try:
            conn.execute(f"UPDATE watchlivo_users SET {', '.join(f'{k} = ?' for k in sets)} WHERE uid = ?", [cur[k] for k in sets] + [uid])
        except sqlite3.IntegrityError:
            cur["handle"] = f"{str(cur.get('handle') or 'uye')[:18]}_{secrets.token_hex(2)}"
            conn.execute(f"UPDATE watchlivo_users SET {', '.join(f'{k} = ?' for k in sets)} WHERE uid = ?", [cur[k] for k in sets] + [uid])
        conn.commit()
        return cur
    finally:
        conn.close()


def _tr_fold(s: str) -> str:
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


def _strip_discrim_tag(s: str) -> str:
    return re.sub(r"#[a-zA-Z0-9]{1,8}$", "", str(s or "").strip()).strip()


def _norm_handle(raw: str, fallback_name: str = "") -> str:
    cleaned_raw = _strip_discrim_tag(str(raw or "").strip().lstrip("@"))
    h = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold(cleaned_raw))[:24].strip("._-")
    if len(h) < 2 and fallback_name:
        cleaned_fb = _strip_discrim_tag(str(fallback_name or "").strip()).replace(" ", "_")
        h = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold(cleaned_fb))[:20].strip("._-")
    if len(h) < 2:
        h = "uye_" + secrets.token_hex(3)
    return h


def _hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()


def _pw_verifier(uid: str, password: str) -> str:
    return hmac.new(AUTH_SECRET, f"wl-pw-v1:{uid}:{password}".encode("utf-8"), hashlib.sha256).hexdigest()[:24]


def _new_salt() -> str:
    """Cryptographically random per-account salt (never derived from the uid)."""
    return secrets.token_hex(16)


def _sync_user_to_social(user: Dict[str, Any]) -> None:
    try:
        import social_engine
        uid = str(user.get("uid") or "").strip()
        if not uid:
            return
        raw_h = str(user.get("handle") or "").strip().lstrip("@")
        social_engine._register_social_dir({
            "uid": uid,
            "name": str(user.get("name") or "Üye"),
            "handle": f"@{raw_h}" if raw_h else "@uye",
            "color": str(user.get("color") or "#00f5d4"),
            "avatar": str(user.get("avatar") or "🎬"),
            "avatarUrl": str(user.get("avatarUrl") or ""),
            "bio": str(user.get("bio") or ""),
            "statusEmoji": str(user.get("statusEmoji") or "🍿"),
            "statusText": str(user.get("statusText") or ""),
        })
        su = social_engine._SOCIAL_USERS.get(uid) or social_engine._kv_get(f"wl:soc:u:{uid}", None, max_age=3.0)
        if isinstance(su, dict) and su.get("uid"):
            su["name"] = str(user.get("name") or su.get("name") or "Üye")[:32]
            if raw_h:
                su["handle"] = f"@{raw_h}"
            if user.get("color"):
                su["color"] = str(user.get("color"))[:16]
            if "avatarUrl" in user:
                su["avatarUrl"] = str(user.get("avatarUrl") or "")[:45000]
            priv = su.setdefault("privacy", {"presenceVisibility": "friends", "hideWatching": False, "allowInvites": "friends"})
            if "hideWatching" in user:
                priv["hideWatching"] = bool(user.get("hideWatching"))
            social_engine._SOCIAL_USERS[uid] = su
            social_engine._kv_set(f"wl:soc:u:{uid}", su, ttl_sec=2592000)
    except Exception:
        pass


def sign_auth_token(user: Dict[str, Any], pw_verifier: str = "", issued_override: Optional[float] = None) -> str:
    """Mint a short-lived HMAC session token."""
    issued = round(float(issued_override if issued_override is not None else time.time()), 3)
    raw_av = str(user.get("avatar") or "🎬")
    safe_av = "📷" if (raw_av.startswith("data:image/") or len(raw_av) > 120) else raw_av
    raw_av_url = str(user.get("avatarUrl") or "").strip()
    safe_av_url = raw_av_url if (raw_av_url and not raw_av_url.startswith("data:") and len(raw_av_url) <= 500) else ""
    payload = {
        "uid": user["uid"],
        "email": user.get("email", ""),
        "handle": str(user.get("handle") or "").lstrip("@"),
        "name": user.get("name", ""),
        "color": user.get("color", "#00f5d4"),
        "avatar": safe_av,
        "avatarUrl": safe_av_url,
        "bio": str(user.get("bio") or "")[:160],
        "statusText": str(user.get("statusText") or "")[:60],
        "statusEmoji": str(user.get("statusEmoji") or "🍿")[:12],
        "hideWatching": bool(user.get("hideWatching", False)),
        "hideFriends": bool(user.get("hideFriends", False)),
        "hideLocation": bool(user.get("hideLocation", False)),
        "provider": user.get("authProvider", "email"),
        "verified": bool(user.get("verified", True)),
        "iat": issued,
        "exp": round(issued + TOKEN_TTL, 3),
        "jti": secrets.token_hex(8),
    }
    pwh_val = str(pw_verifier or user.get("_pwh") or "").strip()
    if pwh_val:
        payload["pwh"] = pwh_val[:32]
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(AUTH_SECRET, b64.encode("ascii"), hashlib.sha256).hexdigest()[:32]
    return f"{b64}.{sig}"


def sign_guest_token(guest_uid: str, binding_sig: str = "") -> str:
    """Mint a signed guest session token bound to the caller's guest UID."""
    issued = round(time.time(), 3)
    payload: Dict[str, Any] = {
        "uid": str(guest_uid or "")[:64],
        "guest": True,
        "iat": issued,
        "exp": round(issued + TOKEN_TTL, 3),
        "jti": secrets.token_hex(6),
    }
    if binding_sig:
        payload["gbind"] = str(binding_sig)[:24]
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(AUTH_SECRET, b64.encode("ascii"), hashlib.sha256).hexdigest()[:32]
    return f"{b64}.{sig}"


def _candidate_auth_secrets() -> list[bytes]:
    out = [AUTH_SECRET]
    for sec_name in ("AUTH_SECRET", "VORTEX_SECRET"):
        try:
            cand = server_secret(sec_name)
            if cand not in out:
                out.append(cand)
        except Exception:
            pass
    ent = (os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN") or "").strip()
    if len(ent) >= 24:
        for nm in ("VORTEX_SECRET", "AUTH_SECRET"):
            for tag in ("watchlivo-shared-secret-v4", "watchlivo-hmac-secret-v4"):
                hm = hmac.new(ent.encode("utf-8"), f"{tag}:{nm}".encode("utf-8"), hashlib.sha256)
                for c in (hm.hexdigest()[:32].encode("ascii"), hm.digest()):
                    if c not in out:
                        out.append(c)
            sh = hashlib.sha256(f"watchlivo-deterministic-secret-v2:{nm}:{ent}:default".encode("utf-8"))
            for c in (sh.hexdigest()[:32].encode("ascii"), sh.digest()):
                if c not in out:
                    out.append(c)
    return out


_REVOKED_AUTH_SIGS = BoundedTTLCache(maxsize=5000, default_ttl=TOKEN_TTL)
_REVOKED_NEG_CACHE = BoundedTTLCache(maxsize=5000, default_ttl=2.0)


def revoke_auth_token(token: str) -> None:
    if not token or "." not in token:
        return
    _, sig = token.rsplit(".", 1)
    if not sig:
        return
    exp_ts = time.time() + TOKEN_TTL
    _REVOKED_AUTH_SIGS.set(sig, exp_ts, ttl=TOKEN_TTL)
    _REVOKED_NEG_CACHE.delete(sig)
    if store_backend() == "redis":
        _kv("SET", f"{_kp()}rev:{sig}", str(int(exp_ts)), "EX", TOKEN_TTL)


def revoke_all_user_tokens(uid: str) -> float:
    if not uid:
        return 0.0
    rev_ts = round(time.time(), 3)
    _USER_REVOKED_AFTER.set(uid, rev_ts, ttl=TOKEN_TTL)
    if store_backend() == "redis":
        _kv("SET", f"{_kp()}rev_uid:{uid}", str(rev_ts), "EX", TOKEN_TTL)
        try:
            _user_update(uid, {"tokens_valid_after": rev_ts})
        except Exception:
            pass
    else:
        try:
            conn = _get_db()
            try:
                conn.execute("UPDATE watchlivo_users SET tokens_valid_after = ? WHERE uid = ?", (rev_ts, uid))
                conn.commit()
            finally:
                conn.close()
        except Exception:
            pass
    return rev_ts


def get_user_revoked_after(uid: str) -> float:
    if not uid:
        return 0.0
    cached = _USER_REVOKED_AFTER.get(uid)
    if cached is not None:
        return float(cached)
    val = 0.0
    if store_backend() == "redis":
        raw = _kv("GET", f"{_kp()}rev_uid:{uid}")
        if raw:
            try:
                val = float(raw)
            except Exception:
                val = 0.0
    else:
        try:
            conn = _get_db()
            try:
                row = conn.execute("SELECT tokens_valid_after FROM watchlivo_users WHERE uid = ?", (uid,)).fetchone()
                if row and row["tokens_valid_after"]:
                    val = float(row["tokens_valid_after"])
            finally:
                conn.close()
        except Exception:
            val = 0.0
    _USER_REVOKED_AFTER.set(uid, val, ttl=5.0 if val <= 0 else TOKEN_TTL)
    return val


def verify_any_token(token: str) -> Optional[Dict[str, Any]]:
    if not token or "." not in token or len(token) > 4096:
        return None
    b64, sig = token.rsplit(".", 1)
    now_ts = time.time()
    rev_exp = _REVOKED_AUTH_SIGS.get(sig)
    if rev_exp:
        if float(rev_exp) > now_ts:
            return None
        _REVOKED_AUTH_SIGS.delete(sig)
    elif store_backend() == "redis":
        if not _REVOKED_NEG_CACHE.get(sig):
            raw_rev = _kv("GET", f"{_kp()}rev:{sig}")
            if raw_rev:
                try:
                    r_exp = float(raw_rev)
                    if r_exp > now_ts:
                        _REVOKED_AUTH_SIGS.set(sig, r_exp, ttl=max(1.0, r_exp - now_ts))
                        return None
                except Exception:
                    pass
            _REVOKED_NEG_CACHE.set(sig, now_ts + 2.0, ttl=2.0)
    try:
        b64_bytes = b64.encode("ascii")
    except Exception:
        return None
    matched = any(
        hmac.compare_digest(hmac.new(sec, b64_bytes, hashlib.sha256).hexdigest()[:32], sig)
        for sec in _candidate_auth_secrets()
    )
    if not matched:
        return None
    try:
        pad = "=" * (-len(b64) % 4)
        data = json.loads(base64.urlsafe_b64decode(b64 + pad).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or not data.get("uid"):
        return None
    try:
        if float(data.get("exp") or 0.0) <= now_ts:
            return None
    except (TypeError, ValueError):
        return None
    uid = str(data.get("uid") or "")
    if not data.get("guest"):
        if is_uid_deleted(uid):
            return None
        rev_after = get_user_revoked_after(uid)
        if rev_after > 0 and float(data.get("iat") or 0.0) <= rev_after:
            return None
    return data


def verify_auth_token(token: str) -> Optional[Dict[str, Any]]:
    data = verify_any_token(token)
    if not data or data.get("guest"):
        return None
    return data


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false", "no", "off", "null", "none")
    return bool(v)


def _row_to_user(row: Any) -> Dict[str, Any]:
    d = dict(row) if not isinstance(row, dict) else row
    av_url = str(d.get("avatar_url") or d.get("avatarUrl") or "").strip()
    raw_av = str(d.get("avatar") or "🎬").strip()
    if not av_url and raw_av.startswith(("https://", "/static/", "/uploads/", "data:image/")):
        av_url = raw_av
    return {
        "uid": d.get("uid", ""),
        "email": d.get("email", ""),
        "handle": d.get("handle", ""),
        "name": d.get("name", ""),
        "color": d.get("color") or "#00f5d4",
        "avatar": av_url or raw_av or "🎬",
        "avatarUrl": av_url,
        "bio": str(d.get("bio") or ""),
        "statusText": str(d.get("status_text") or d.get("statusText") or ""),
        "statusEmoji": str(d.get("status_emoji") or d.get("statusEmoji") or "🍿"),
        "hideWatching": _as_bool(d["hide_watching"] if "hide_watching" in d else d.get("hideWatching", False)),
        "hideFriends": _as_bool(d["hide_friends"] if "hide_friends" in d else d.get("hideFriends", False)),
        "hideLocation": _as_bool(d["hide_location"] if "hide_location" in d else d.get("hideLocation", False)),
        "authProvider": d.get("auth_provider") or "email",
        "verified": _as_bool(d.get("verified", 1)),
        "passwordSet": _as_bool(d.get("password_set", 1 if (d.get("auth_provider") or "email") == "email" else 0)),
        "isGuest": False,
    }


async def auth_register(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz istek verisi."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz istek verisi."}, status_code=400)
    name = str(body.get("name") or "").strip()[:24]
    email = str(body.get("email") or "").strip().lower()[:120]
    password = str(body.get("password") or "")[:256]
    color = _clean_color(body.get("color"))
    avatar = str(body.get("avatar") or "🎬").strip()[:8]
    raw_handle = str(body.get("handle") or "").strip()
    if len(name) < 2:
        return JSONResponse({"ok": False, "error": "Görünen ad en az 2 karakter olmalıdır."}, status_code=400)
    if not EMAIL_RE.match(email):
        return JSONResponse({"ok": False, "error": "Lütfen geçerli bir e-posta adresi girin."}, status_code=400)
    if len(password) < 6:
        return JSONResponse({"ok": False, "error": "Şifre en az 6 karakter olmalıdır."}, status_code=400)
    allowed, retry_after = _REGISTER_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    uid = "u_wl_" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:12]
    try:
        existing_em = _uid_for("email", email)
    except Exception:
        existing_em = None
    if existing_em:
        return JSONResponse({"ok": False, "error": "Bu e-posta adresi zaten kayıtlı. Lütfen Giriş Yap sekmesinden şifrenizle giriş yapın."}, status_code=409)
    explicit_h_input = _strip_discrim_tag(raw_handle.lstrip("@").strip())
    if explicit_h_input:
        explicit_norm = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold(explicit_h_input))[:24].strip("._-")
        if len(explicit_norm) < 2:
            return JSONResponse({"ok": False, "error": "Kullanıcı adı en az 2 geçerli harf veya rakam içermelidir."}, status_code=400)
        try:
            owner_h = _uid_for("handle", explicit_norm)
        except Exception:
            owner_h = None
        if owner_h and owner_h != uid:
            return JSONResponse({"ok": False, "error": f"Bu kullanıcı adı (@{explicit_norm}) zaten kullanımda. Lütfen farklı bir kullanıcı adı seçin."}, status_code=409)
        handle = explicit_norm
    else:
        handle = _norm_handle("", name)
    salt = _new_salt()
    pw_hash = _hash_pw(password, salt)
    now_ts = time.time()
    fb_pw = password
    fb_signup = _firebase_auth_req("accounts:signUp", {
        "email": email,
        "password": fb_pw,
        "displayName": name,
        "returnSecureToken": True,
    })
    if fb_signup and fb_signup.get("idToken"):
        _firebase_auth_req("accounts:sendOobCode", {
            "requestType": "VERIFY_EMAIL",
            "idToken": fb_signup["idToken"],
        })
    _supabase_auth_req("/auth/v1/signup", {
        "email": email,
        "password": fb_pw,
        "data": {"name": name, "handle": handle, "color": color, "avatar": avatar},
    })
    row = {
        "uid": uid, "email": email, "handle": handle, "name": name, "password_hash": pw_hash, "salt": salt,
        "color": color, "avatar": avatar, "auth_provider": "email", "verified": 1, "password_set": 1,
        "created_at": now_ts, "updated_at": now_ts,
    }
    try:
        created = _user_create(row)
    except Exception:
        return JSONResponse({"ok": False, "error": "Hesap kaydı şu an yapılamıyor. Lütfen tekrar deneyin."}, status_code=503)
    if not created:
        return JSONResponse({"ok": False, "error": "Bu e-posta adresi zaten kayıtlı. Lütfen Giriş Yap sekmesinden şifrenizle giriş yapın."}, status_code=409)
    clear_uid_deleted(uid)
    user = _row_to_user(row)
    _sync_user_to_social(user)
    token = sign_auth_token(user, pw_verifier=_pw_verifier(uid, password))
    return JSONResponse({"ok": True, "user": user, "authToken": token, "emailSent": True})


async def auth_login(request: Request) -> JSONResponse:
    allowed, retry_after = _LOGIN_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz istek verisi."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz istek verisi."}, status_code=400)
    raw_ident = str(body.get("identifier") or body.get("email") or body.get("handle") or "").strip()[:120]
    identifier = raw_ident.lower()
    password = str(body.get("password") or "")[:256]
    if not identifier or not password:
        return JSONResponse({"ok": False, "error": "E-posta / kullanıcı adı ve şifre zorunludur."}, status_code=400)
    acct_ok, acct_retry = _ACCT_LOGIN_LIMIT.hit(_tr_fold(raw_ident)[:80])
    if not acct_ok:
        return too_many_response(acct_retry)
    is_email = bool(EMAIL_RE.match(identifier))
    clean_h = _norm_handle(raw_ident) if not is_email else ""
    row = None
    try:
        uid = _uid_for("email", identifier) if is_email else (_uid_for("handle", clean_h) or _uid_for("handle", _strip_discrim_tag(identifier.lstrip("@"))))
        row = _user_get(uid) if uid else None
    except sqlite3.OperationalError:
        return JSONResponse({"ok": False, "error": "Veritabanı şu an meşgul. Lütfen tekrar deneyin."}, status_code=503)
    except Exception:
        row = None
    target_email = identifier if is_email else (row.get("email", "") if row else "")
    fb_verified = False
    local_verified = bool(
        row
        and row.get("password_hash")
        and row.get("salt")
        and constant_time_eq(row["password_hash"], _hash_pw(password, row["salt"]))
    )
    if local_verified:
        fb_verified = True
    if not row and store_backend() == "sqlite":
        vault_tok = str(body.get("vaultToken") or "").strip()
        v_claims = verify_auth_token(vault_tok) if vault_tok else None
        if v_claims and v_claims.get("uid") and v_claims.get("pwh") and not is_uid_deleted(str(v_claims["uid"])):
            v_uid = str(v_claims["uid"])
            v_email = str(v_claims.get("email") or "").strip().lower()
            v_handle = _norm_handle(str(v_claims.get("handle") or ""))
            ident_matches = (is_email and v_email == identifier) or (not is_email and clean_h and v_handle == clean_h)
            if ident_matches and hmac.compare_digest(str(v_claims["pwh"]), _pw_verifier(v_uid, password)):
                fb_verified = True
                salt = _new_salt()
                pw_hash = _hash_pw(password, salt)
                row = {
                    "uid": v_uid,
                    "email": v_email or (identifier if is_email else f"{v_uid}@watchlivo.online"),
                    "handle": v_handle or _norm_handle("", str(v_claims.get("name") or "uye")),
                    "name": str(v_claims.get("name") or "Üye")[:24],
                    "password_hash": pw_hash,
                    "salt": salt,
                    "color": _clean_color(v_claims.get("color")),
                    "avatar": str(v_claims.get("avatar") or "🎬")[:120],
                    "avatar_url": str(v_claims.get("avatarUrl") or "")[:500],
                    "bio": str(v_claims.get("bio") or "")[:160],
                    "status_text": str(v_claims.get("statusText") or "")[:60],
                    "status_emoji": str(v_claims.get("statusEmoji") or "🍿")[:12],
                    "hide_watching": 1 if _as_bool(v_claims.get("hideWatching")) else 0,
                    "hide_friends": 1 if _as_bool(v_claims.get("hideFriends")) else 0,
                    "hide_location": 1 if _as_bool(v_claims.get("hideLocation")) else 0,
                    "auth_provider": str(v_claims.get("provider") or "email"),
                    "verified": 1,
                    "password_set": 1,
                    "created_at": time.time(),
                    "updated_at": time.time(),
                }
                try:
                    _user_create(row)
                except Exception:
                    pass
    reset_allowed = bool(target_email and (float(_PASSWORD_RESET_PENDING.get(target_email) or 0.0) > time.time()))
    if not reset_allowed and target_email and store_backend() == "redis":
        try:
            raw_rst = _kv("GET", f"{_kp()}pwreset:{target_email}")
            if raw_rst and float(raw_rst) > time.time():
                reset_allowed = True
        except Exception:
            pass
    cand_uid = "u_wl_" + hashlib.sha256(target_email.encode("utf-8")).hexdigest()[:12] if target_email else ""
    if not fb_verified and (not row or reset_allowed) and target_email and EMAIL_RE.match(target_email) and not is_uid_deleted(cand_uid):
        for cand_pw in ([password, password + "_wl26"] if len(password) < 6 else [password]):
            fb_res = _firebase_auth_req("accounts:signInWithPassword", {
                "email": target_email,
                "password": cand_pw,
                "returnSecureToken": True,
            })
            if fb_res and fb_res.get("idToken"):
                fb_email = str(fb_res.get("email") or target_email).strip().lower()
                if fb_email == target_email:
                    if row:
                        lk = _firebase_auth_req("accounts:lookup", {"idToken": fb_res["idToken"]})
                        lk_users = (lk or {}).get("users") or []
                        if not lk_users or lk_users[0].get("emailVerified") is not True:
                            break
                    fb_verified = True
                    _PASSWORD_RESET_PENDING.delete(target_email)
                    if store_backend() == "redis":
                        _kv("DEL", f"{_kp()}pwreset:{target_email}")
                    salt = _new_salt()
                    pw_hash = _hash_pw(password, salt)
                    if row:
                        row["password_hash"] = pw_hash
                        row["salt"] = salt
                        row["password_set"] = 1
                        row["updated_at"] = time.time()
                        try:
                            _user_update(row["uid"], {"password_hash": pw_hash, "salt": salt, "password_set": 1, "updated_at": row["updated_at"]})
                        except Exception:
                            pass
                    else:
                        disp = str(fb_res.get("displayName") or target_email.split("@")[0])[:24]
                        row = {
                            "uid": cand_uid, "email": target_email,
                            "handle": _norm_handle("", disp),
                            "name": disp, "password_hash": pw_hash, "salt": salt,
                            "color": "#00f5d4", "avatar": "🎬",
                            "auth_provider": "email", "verified": 1, "password_set": 1,
                            "created_at": time.time(), "updated_at": time.time(),
                        }
                        try:
                            _user_create(row)
                        except Exception:
                            pass
                break
    if not row and is_email:
        sb_res = _supabase_auth_req("/auth/v1/token?grant_type=password", {
            "email": identifier,
            "password": password if len(password) >= 6 else (password + "_wl26"),
        })
        if sb_res and isinstance(sb_res.get("user"), dict):
            sb_u = sb_res["user"]
            meta = sb_u.get("user_metadata") or {}
            fb_verified = True
            uid = "u_wl_" + hashlib.sha256(identifier.encode("utf-8")).hexdigest()[:12]
            salt = _new_salt()
            pw_hash = _hash_pw(password, salt)
            row = {
                "uid": uid, "email": identifier,
                "handle": _norm_handle(meta.get("handle") or "", meta.get("name") or identifier.split("@")[0]),
                "name": str(meta.get("name") or identifier.split("@")[0])[:24],
                "password_hash": pw_hash, "salt": salt,
                "color": _clean_color(meta.get("color")), "avatar": str(meta.get("avatar") or "🎬")[:8],
                "auth_provider": "email", "verified": 1, "created_at": time.time(), "updated_at": time.time(),
            }
            try:
                _user_create(row)
            except Exception:
                pass
    if not row:
        return JSONResponse({"ok": False, "error": "Hesap bulunamadı veya bilgiler hatalı."}, status_code=401)
    expected = _hash_pw(password, row["salt"])
    if not fb_verified and not hmac.compare_digest(expected, row["password_hash"]):
        return JSONResponse({"ok": False, "error": "Hesap bulunamadı veya bilgiler hatalı."}, status_code=401)
    user = _row_to_user(row)
    _sync_user_to_social(user)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user, pw_verifier=_pw_verifier(user["uid"], password))})


PROVIDER_ICONS = {
    "google": "🌐",
    "apple": "🍎",
    "github": "🐙",
    "microsoft": "🪟",
    "discord": "💜",
    "x": "𝕏",
    "twitter": "𝕏",
    "phone": "📱",
}


async def auth_oauth(request: Request) -> JSONResponse:
    """Multi-platform OAuth Sign-In (Google, Apple, GitHub, Microsoft, Discord, X) + Firebase idToken lookup."""
    allowed, retry_after = _LOGIN_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    provider = str(body.get("provider") or "google").strip().lower()
    if provider not in PROVIDER_ICONS:
        provider = "google"
    password = str(body.get("password") or "")[:256]
    id_token = str(body.get("idToken") or "").strip()
    fb_email = ""
    fb_name = ""
    # Güvenlik: sahte/doğrulanmamış sosyal hesap oluşturma yok. Geçerli Firebase idToken zorunlu.
    if not id_token:
        return JSONResponse({"ok": False, "error": "Giriş doğrulanamadı. Lütfen sağlayıcı penceresinden giriş yapın."}, status_code=401)
    lk = _firebase_auth_req("accounts:lookup", {"idToken": id_token})
    users = (lk or {}).get("users") or []
    if users:
        u0 = users[0]
        if u0.get("emailVerified") is not False:
            fb_email = str(u0.get("email") or "").strip().lower()
        fb_name = str(u0.get("displayName") or "").strip()[:24]
        fb_phone = re.sub(r"[^\d+]", "", str(u0.get("phoneNumber") or ""))
        if not fb_email and fb_phone:
            digits = fb_phone.lstrip("+")
            fb_email = f"p{digits}@phone.watchlivo.online"
            provider = "phone"
            if not fb_name:
                fb_name = ("Üye " + digits[-4:])[:24]
    elif provider == "google":
        try:
            g_url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib.parse.quote(id_token)}"
            req = urllib.request.Request(g_url, headers={"User-Agent": "WatchlivoAuth/1.0"})
            with urllib.request.urlopen(req, timeout=5) as gr:
                g_info = json.loads(gr.read().decode("utf-8"))
                aud_ok = (not GOOGLE_OAUTH_CLIENT_ID) or (str(g_info.get("aud") or "") == GOOGLE_OAUTH_CLIENT_ID)
                if aud_ok and g_info.get("email") and (str(g_info.get("email_verified")).lower() in ("true", "1")):
                    fb_email = str(g_info.get("email")).strip().lower()
                    fb_name = str(g_info.get("name") or g_info.get("given_name") or "").strip()[:24]
        except Exception:
            pass

    if not fb_email:
        return JSONResponse({"ok": False, "error": "Giriş doğrulanamadı. Oturum süresi dolmuş veya geçersiz."}, status_code=401)
    raw_email = fb_email[:120]
    expected_email = str(body.get("email") or "").strip().lower()
    if expected_email and EMAIL_RE.match(expected_email) and expected_email != raw_email:
        return JSONResponse(
            {"ok": False, "error": f"Yazdığınız e-posta ({expected_email}) ile seçilen Google hesabı ({raw_email}) eşleşmiyor."},
            status_code=401,
        )
    raw_name = (fb_name or str(body.get("name") or "").strip())[:24]
    color = _clean_color(body.get("color"))
    avatar = str(body.get("avatar") or PROVIDER_ICONS.get(provider, "🌐")).strip()[:8]
    if not raw_name:
        raw_name = (raw_email.split("@")[0] if raw_email else f"Watchlivo {provider.capitalize()}")[:24]
    handle = _norm_handle(str(body.get("handle") or ""), raw_name)
    if raw_email and EMAIL_RE.match(raw_email):
        uid = "u_wl_" + hashlib.sha256(raw_email.encode("utf-8")).hexdigest()[:12]
        ex = _user_get(uid)
        if ex:
            if password and len(password) >= 6 and not ex.get("password_set"):
                new_salt = _new_salt()
                new_hash = _hash_pw(password, new_salt)
                ex = _user_update(uid, {"password_hash": new_hash, "salt": new_salt, "password_set": 1}) or ex
            user = _row_to_user(ex)
            return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})
    else:
        uid = "u_wl_" + hashlib.sha256(f"{provider}:{handle}".encode("utf-8")).hexdigest()[:12]
        raw_email = f"{handle}@{provider}.watchlivo.online"
        ex = _user_get(uid)
        if ex:
            user = _row_to_user(ex)
            return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})
    salt = _new_salt()
    pw_hash = _hash_pw(password or _new_salt(), salt)
    now_ts = time.time()
    row = {
        "uid": uid, "email": raw_email, "handle": handle, "name": raw_name, "password_hash": pw_hash, "salt": salt,
        "color": color, "avatar": avatar, "auth_provider": provider, "verified": 1, "password_set": 1 if password else 0,
        "created_at": now_ts, "updated_at": now_ts,
    }
    try:
        _user_create(row)
        clear_uid_deleted(uid)
    except Exception:
        pass
    user = _row_to_user(row)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})


_PHONE_CODES = BoundedTTLCache(maxsize=1000, default_ttl=300.0)


def _clean_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("90") and len(digits) == 12:
        return "+" + digits
    if digits.startswith("0") and len(digits) == 11:
        return "+90" + digits[1:]
    if len(digits) == 10 and digits.startswith("5"):
        return "+90" + digits
    if len(digits) >= 10:
        return "+" + digits
    return ""


def _sms_cfg() -> tuple:
    sid = (os.environ.get("TWILIO_ACCOUNT_SID") or "").strip()
    tok = (os.environ.get("TWILIO_AUTH_TOKEN") or "").strip()
    frm = (os.environ.get("TWILIO_FROM_NUMBER") or "").strip()
    return (sid, tok, frm) if (sid and tok and frm) else ("", "", "")


def _sms_send(phone: str, text: str) -> bool:
    """Send a real SMS through Twilio. Returns False when SMS is not configured."""
    sid, tok, frm = _sms_cfg()
    if not sid:
        return False
    body = urllib.parse.urlencode({"To": phone, "From": frm, "Body": text}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        data=body,
        headers={
            "Authorization": "Basic " + base64.b64encode(f"{sid}:{tok}".encode("utf-8")).decode("ascii"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status in (200, 201)
    except Exception:
        return False


_SMS_DISABLED = JSONResponse(
    {
        "ok": False,
        "error": "SMS ile giriş bu kurulumda etkin değil. Lütfen e-posta ile giriş yapın.",
    },
    status_code=501,
)


async def auth_phone_send_code(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    phone = _clean_phone(str(body.get("phone") or ""))
    if not phone or len(phone) < 11:
        return JSONResponse({"ok": False, "error": "Geçerli bir telefon numarası girin (+90 5XX XXX XX XX)."}, status_code=400)
    allowed, retry_after = _OTP_LIMIT.hit(f"{client_ip(request)}:{phone}")
    if not allowed:
        return too_many_response(retry_after)
    code = f"{secrets.randbelow(900000) + 100000}"
    # Only the hash is kept: a memory dump must not hand out login codes.
    rec = {"hash": _hash_pw(code, phone), "exp": time.time() + 300, "tries": 0}
    _PHONE_CODES[phone] = rec
    if store_backend() == "redis":
        try:
            _kv("SET", f"{_kp()}otp:{phone}", json.dumps(rec), "EX", 300)
        except Exception:
            pass
    has_sms_provider = bool(_sms_cfg()[0])
    if has_sms_provider:
        if not _sms_send(phone, f"Watchlivo giriş kodunuz: {code}"):
            _PHONE_CODES.pop(phone, None)
            return JSONResponse({"ok": False, "error": "SMS gönderilemedi. Lütfen tekrar deneyin."}, status_code=502)
        return JSONResponse({"ok": True, "phone": phone, "expiresIn": 300,
                             "message": "Doğrulama kodu telefonunuza gönderildi."})
    if os.environ.get("WATCHLIVO_DEV_OTP") == "1":
        return JSONResponse({"ok": True, "phone": phone, "code": code, "expiresIn": 300,
                             "message": "Doğrulama kodu oluşturuldu."})
    _PHONE_CODES.pop(phone, None)
    return _SMS_DISABLED


async def auth_phone_verify_code(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    phone = _clean_phone(str(body.get("phone") or ""))
    code = str(body.get("code") or "").strip()[:12]
    color = _clean_color(body.get("color"))
    name = str(body.get("name") or "").strip()[:24]
    if not phone:
        return JSONResponse({"ok": False, "error": "Geçersiz telefon numarası."}, status_code=400)
    allowed, retry_after = _OTP_VERIFY_LIMIT.hit(f"{client_ip(request)}:{phone}")
    if not allowed:
        return too_many_response(retry_after)
    stored = None
    if store_backend() == "redis":
        try:
            raw_otp = _kv("GET", f"{_kp()}otp:{phone}")
            if raw_otp:
                stored = json.loads(raw_otp)
                _PHONE_CODES[phone] = stored
        except Exception:
            stored = None
    if not stored:
        stored = _PHONE_CODES.get(phone)
    if not stored or time.time() > stored.get("exp", 0):
        return JSONResponse({"ok": False, "error": "Doğrulama kodunun süresi dolmuş veya kod gönderilmemiş. Lütfen yeni kod isteyin."}, status_code=400)
    if int(stored.get("tries") or 0) >= 5:
        _PHONE_CODES.pop(phone, None)
        if store_backend() == "redis":
            try:
                _kv("DEL", f"{_kp()}otp:{phone}")
            except Exception:
                pass
        return JSONResponse({"ok": False, "error": "Çok fazla hatalı deneme. Lütfen yeni kod isteyin."}, status_code=429)
    if not hmac.compare_digest(str(stored.get("hash") or ""), _hash_pw(code, phone)):
        stored["tries"] = int(stored.get("tries") or 0) + 1
        if store_backend() == "redis":
            try:
                _kv("SET", f"{_kp()}otp:{phone}", json.dumps(stored), "EX", max(1, int(stored.get("exp", time.time()) - time.time())))
            except Exception:
                pass
        return JSONResponse({"ok": False, "error": "Hatalı doğrulama kodu. Lütfen tekrar deneyin."}, status_code=400)
    _PHONE_CODES.pop(phone, None)
    if store_backend() == "redis":
        try:
            _kv("DEL", f"{_kp()}otp:{phone}")
        except Exception:
            pass

    digits = phone.lstrip("+")
    email = f"p{digits}@phone.watchlivo.online"
    uid = "u_wl_" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:12]
    ex = _user_get(uid)
    if ex:
        user = _row_to_user(ex)
        return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})

    clean_name = "" if name in ("Hesap Girişi", "Misafir", "KinoMisafir") else name
    raw_name = clean_name or ("Üye " + digits[-4:])
    handle = _norm_handle("", raw_name)
    salt = _new_salt()
    pw_hash = _hash_pw(secrets.token_hex(12), salt)
    now_ts = time.time()
    row = {
        "uid": uid, "email": email, "handle": handle, "name": raw_name, "password_hash": pw_hash, "salt": salt,
        "color": color, "avatar": "📱", "auth_provider": "phone", "verified": 1, "created_at": now_ts, "updated_at": now_ts,
    }
    try:
        _user_create(row)
        clear_uid_deleted(uid)
    except Exception:
        pass
    user = _row_to_user(row)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})


async def auth_email_action(request: Request) -> JSONResponse:
    """Firebase Email Actions: Password Reset ('reset_password', 'verify_reset_code'), Magic Link ('magic_link'), Complete Link ('complete_magic_link')."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz istek."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz istek."}, status_code=400)
    action = str(body.get("action") or "").strip().lower()
    if action in ("verify_reset_code", "confirm_reset_password"):
        allowed, retry_after = _RESET_LIMIT.hit(client_ip(request))
        if not allowed:
            return too_many_response(retry_after)
        oob_code = str(body.get("oobCode") or body.get("code") or "").strip()[:256]
        new_pw = str(body.get("newPassword") or body.get("password") or "")[:256]
        if not oob_code:
            return JSONResponse({"ok": False, "error": "Sıfırlama kodu zorunludur."}, status_code=400)
        if len(new_pw) < 6:
            return JSONResponse({"ok": False, "error": "Yeni şifre en az 6 karakter olmalıdır."}, status_code=400)
        res = _firebase_auth_req("accounts:resetPassword", {"oobCode": oob_code, "newPassword": new_pw})
        rst_email = str((res or {}).get("email") or "").strip().lower()
        if not rst_email or not EMAIL_RE.match(rst_email):
            return JSONResponse({"ok": False, "error": "Şifre sıfırlama kodu geçersiz veya süresi dolmuş."}, status_code=401)
        uid = _uid_for("email", rst_email)
        if uid:
            salt = _new_salt()
            pw_hash = _hash_pw(new_pw, salt)
            rev_ts = revoke_all_user_tokens(uid)
            _user_update(uid, {"password_hash": pw_hash, "salt": salt, "password_set": 1, "tokens_valid_after": rev_ts})
            _PASSWORD_RESET_PENDING.delete(rst_email)
            if store_backend() == "redis":
                _kv("DEL", f"{_kp()}pwreset:{rst_email}")
        return JSONResponse({"ok": True, "message": "Şifreniz başarıyla güncellendi. Yeni şifrenizle giriş yapabilirsiniz."})
    email = str(body.get("email") or "").strip().lower()[:120]
    if not EMAIL_RE.match(email):
        return JSONResponse({"ok": False, "error": "Lütfen geçerli bir e-posta adresi girin."}, status_code=400)
    if action == "reset_password":
        allowed, retry_after = _RESET_LIMIT.hit(f"{client_ip(request)}:{email}")
        if not allowed:
            return too_many_response(retry_after)
        existing_uid = _uid_for("email", email)
        if not existing_uid or is_uid_deleted(existing_uid):
            return JSONResponse({"ok": True, "message": f"Eğer {email} adresine bağlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi."})
        _firebase_auth_req("accounts:signUp", {
            "email": email,
            "password": "Wl!" + secrets.token_urlsafe(24),
            "returnSecureToken": True,
        })
        res = _firebase_auth_req("accounts:sendOobCode", {"requestType": "PASSWORD_RESET", "email": email})
        if res and res.get("email"):
            rst_exp = time.time() + 3600.0
            _PASSWORD_RESET_PENDING.set(email, rst_exp, ttl=3600.0)
            if store_backend() == "redis":
                _kv("SET", f"{_kp()}pwreset:{email}", str(int(rst_exp)), "EX", 3600)
            return JSONResponse({"ok": True, "message": f"Şifre sıfırlama bağlantısı {email} adresine gönderildi."})
        return JSONResponse({"ok": False, "error": "Sıfırlama e-postası gönderilemedi. Lütfen adresi kontrol edin."}, status_code=400)
    if action == "magic_link":
        allowed, retry_after = _RESET_LIMIT.hit(f"{client_ip(request)}:{email}")
        if not allowed:
            return too_many_response(retry_after)
        raw_origin = str(body.get("origin") or "https://watchlivo.online").rstrip("/")
        origin = raw_origin if raw_origin in ("https://watchlivo.online", "https://www.watchlivo.online", "http://localhost:8765", "http://127.0.0.1:8765", "http://localhost:8787", "http://127.0.0.1:8787") else "https://watchlivo.online"
        cont_url = f"{origin}/?magic_email={urllib.parse.quote(email)}"
        res = _firebase_auth_req("accounts:sendOobCode", {
            "requestType": "EMAIL_SIGNIN",
            "email": email,
            "continueUrl": cont_url,
            "canHandleCodeInApp": True,
        })
        if res and res.get("email"):
            return JSONResponse({"ok": True, "message": f"Giriş bağlantısı {email} adresine gönderildi (Gelen Kutusu / Spam kontrol edin)."})
        return JSONResponse({"ok": False, "error": "E-posta bağlantısı gönderilemedi."}, status_code=400)
    if action == "complete_magic_link":
        allowed, retry_after = _LOGIN_LIMIT.hit(client_ip(request))
        if not allowed:
            return too_many_response(retry_after)
        oob_code = str(body.get("oobCode") or "").strip()
        if not oob_code:
            return JSONResponse({"ok": False, "error": "Geçersiz giriş kodu."}, status_code=400)
        res = _firebase_auth_req("accounts:signInWithEmailLink", {"email": email, "oobCode": oob_code})
        if not res or not res.get("idToken"):
            return JSONResponse({"ok": False, "error": "E-posta bağlantısı süresi dolmuş veya geçersiz."}, status_code=401)
        uid = "u_wl_" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:12]
        row = _user_get(uid)
        if not row:
            name = email.split("@")[0][:24]
            salt = _new_salt()
            row = {
                "uid": uid, "email": email, "handle": _norm_handle("", name), "name": name,
                "password_hash": _hash_pw(secrets.token_hex(10), salt), "salt": salt,
                "color": "#00f5d4", "avatar": "✉️", "auth_provider": "email", "verified": 1,
                "created_at": time.time(), "updated_at": time.time(),
            }
            try:
                _user_create(row)
            except Exception:
                pass
        user = _row_to_user(row)
        return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})
    return JSONResponse({"ok": False, "error": "Bilinmeyen işlem."}, status_code=400)


async def auth_profile(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz veri."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz veri."}, status_code=400)
    auth_hdr = request.headers.get("Authorization", "")
    token = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else str(body.get("authToken") or "")
    claims = verify_auth_token(token)
    if not claims:
        return JSONResponse({"ok": False, "error": "Oturum doğrulanamadı. Lütfen tekrar giriş yapın."}, status_code=401)
    uid = claims["uid"]
    fields = {}
    name = str(body.get("name") or "").strip()[:24]
    if "name" in body and body.get("name") is not None:
        if len(name) < 2:
            return JSONResponse({"ok": False, "error": "Görünen ad en az 2 karakter olmalıdır."}, status_code=400)
        fields["name"] = name
    raw_h_body = str(body.get("handle") or "").strip()
    if raw_h_body:
        clean_explicit_h = re.sub(r"[^a-z0-9_.\-]", "", _tr_fold(_strip_discrim_tag(raw_h_body.lstrip("@"))))[:24].strip("._-")
        if len(clean_explicit_h) < 2:
            return JSONResponse({"ok": False, "error": "Kullanıcı adı en az 2 geçerli harf veya rakam içermelidir."}, status_code=400)
        owner_uid = _uid_for("handle", clean_explicit_h)
        if owner_uid and owner_uid != uid:
            return JSONResponse({"ok": False, "error": f"Bu kullanıcı adı (@{clean_explicit_h}) zaten kullanımda."}, status_code=409)
        try:
            import social_engine
            for s_uid, s_card in social_engine._load_social_dir().items():
                if s_uid and s_uid != uid and isinstance(s_card, dict):
                    s_h = str(s_card.get("handle") or "").lstrip("@").strip().lower()
                    if s_h == clean_explicit_h and s_uid.startswith("u_wl_"):
                        return JSONResponse({"ok": False, "error": f"Bu kullanıcı adı (@{clean_explicit_h}) zaten kullanımda."}, status_code=409)
        except Exception:
            pass
        fields["handle"] = clean_explicit_h
    color = str(body.get("color") or "").strip()[:16]
    if re.match(r"^#[0-9a-fA-F]{3,8}$", color):
        fields["color"] = color
    if "avatarUrl" in body:
        raw_av_url = str(body.get("avatarUrl") or "").strip()
        if not raw_av_url:
            fields["avatar_url"] = ""
        elif _is_valid_avatar_url(raw_av_url):
            fields["avatar_url"] = raw_av_url
        else:
            return JSONResponse({"ok": False, "error": "Geçersiz profil görseli formatı (yalnızca 45 KB altı PNG/JPEG/WebP/GIF veya HTTPS görsel kabul edilir)."}, status_code=400)
    elif "avatar" in body:
        raw_av_in = str(body.get("avatar") or "").strip()
        if raw_av_in.lower().startswith(("http:", "https:", "data:", "/", "javascript:", "vbscript:")):
            if not _is_valid_avatar_url(raw_av_in):
                return JSONResponse({"ok": False, "error": "Geçersiz profil görseli formatı."}, status_code=400)
            fields["avatar_url"] = raw_av_in
        elif raw_av_in and len(raw_av_in) <= 16 and not re.search(r"[<>\"'\\]", raw_av_in):
            fields["avatar"] = raw_av_in
    if "bio" in body:
        fields["bio"] = str(body.get("bio") or "").strip()[:160]
    if "statusText" in body:
        fields["status_text"] = str(body.get("statusText") or "").strip()[:60]
    if "statusEmoji" in body:
        fields["status_emoji"] = str(body.get("statusEmoji") or "🍿").strip()[:12] or "🍿"
    if "hideWatching" in body:
        fields["hide_watching"] = 1 if _as_bool(body.get("hideWatching")) else 0
    if "hideFriends" in body:
        fields["hide_friends"] = 1 if _as_bool(body.get("hideFriends")) else 0
    if "hideLocation" in body:
        fields["hide_location"] = 1 if _as_bool(body.get("hideLocation")) else 0
    pwh_keep = str(claims.get("pwh") or "")
    upd_failed = False
    try:
        row = _user_update(uid, fields)
    except sqlite3.OperationalError:
        return JSONResponse({"ok": False, "error": "Veritabanı şu an meşgul. Lütfen tekrar deneyin."}, status_code=503)
    except Exception:
        row = None
        upd_failed = True
    if not row:
        if not (IS_VERCEL and store_backend() == "sqlite" and not upd_failed and not is_uid_deleted(uid)):
            return JSONResponse({"ok": False, "error": "Hesap bulunamadı. Lütfen tekrar giriş yapın."}, status_code=401)
        user = {
            "uid": uid,
            "email": claims.get("email", ""),
            "handle": fields.get("handle") or claims.get("handle", "uye"),
            "name": fields.get("name") or claims.get("name", "Üye"),
            "color": fields.get("color") or claims.get("color", "#00f5d4"),
            "avatar": fields.get("avatar_url") or claims.get("avatar", "🎬"),
            "avatarUrl": fields.get("avatar_url") if "avatar_url" in fields else str(claims.get("avatarUrl") or ""),
            "bio": fields.get("bio") if "bio" in fields else str(claims.get("bio") or ""),
            "statusText": fields.get("status_text") if "status_text" in fields else str(claims.get("statusText") or ""),
            "statusEmoji": fields.get("status_emoji") if "status_emoji" in fields else str(claims.get("statusEmoji") or "🍿"),
            "hideWatching": bool(fields["hide_watching"]) if "hide_watching" in fields else bool(claims.get("hideWatching", False)),
            "hideFriends": bool(fields["hide_friends"]) if "hide_friends" in fields else bool(claims.get("hideFriends", False)),
            "hideLocation": bool(fields["hide_location"]) if "hide_location" in fields else bool(claims.get("hideLocation", False)),
            "authProvider": claims.get("provider", "email"),
            "verified": True,
            "passwordSet": True,
            "isGuest": False,
        }
        try:
            salt = _new_salt()
            _user_create({
                "uid": uid,
                "email": user["email"] or f"{uid}@watchlivo.online",
                "handle": user["handle"],
                "name": user["name"],
                "password_hash": _hash_pw(secrets.token_hex(12), salt),
                "salt": salt,
                "color": user["color"],
                "avatar": user["avatar"],
                "avatar_url": user.get("avatarUrl", ""),
                "bio": user.get("bio", ""),
                "status_text": user.get("statusText", ""),
                "status_emoji": user.get("statusEmoji", "🍿"),
                "hide_watching": 1 if user.get("hideWatching") else 0,
                "hide_friends": 1 if user.get("hideFriends") else 0,
                "hide_location": 1 if user.get("hideLocation") else 0,
                "auth_provider": user["authProvider"],
                "verified": 1,
                "password_set": 1,
                "created_at": time.time(),
                "updated_at": time.time(),
            })
        except Exception:
            pass
        _sync_user_to_social(user)
        return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user, pw_verifier=pwh_keep)})
    user = _row_to_user(row)
    _sync_user_to_social(user)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user, pw_verifier=pwh_keep)})


def _purge_uid_cache(token: str = "", uid: str = "") -> None:
    try:
        import server
        if token:
            server._UID_CACHE.pop(token, None)
        if uid:
            stale_keys = [k for k, v in list(server._UID_CACHE.items()) if isinstance(v, tuple) and v[0] == uid]
            for k in stale_keys:
                server._UID_CACHE.pop(k, None)
    except Exception:
        pass


async def auth_change_password(request: Request) -> JSONResponse:
    allowed, retry_after = _PW_CHANGE_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz veri."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz veri."}, status_code=400)
    auth_hdr = request.headers.get("Authorization", "")
    token = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else str(body.get("authToken") or "")
    claims = verify_auth_token(token)
    if not claims:
        return JSONResponse({"ok": False, "error": "Oturum doğrulanamadı. Lütfen tekrar giriş yapın."}, status_code=401)
    uid = str(claims["uid"])
    row = _user_get(uid)
    if not row:
        return JSONResponse({"ok": False, "error": "Hesap bulunamadı."}, status_code=401)
    cur_pw = str(body.get("currentPassword") or body.get("oldPassword") or "")[:256]
    new_pw = str(body.get("newPassword") or body.get("password") or "")[:256]
    if len(new_pw) < 6:
        return JSONResponse({"ok": False, "error": "Yeni şifre en az 6 karakter olmalıdır."}, status_code=400)
    has_pw = bool(row.get("password_set")) or str(row.get("auth_provider") or "") == "email"
    if has_pw:
        if not cur_pw or not constant_time_eq(row["password_hash"], _hash_pw(cur_pw, row["salt"])):
            return JSONResponse({"ok": False, "error": "Mevcut şifreniz hatalı."}, status_code=401)
    salt = _new_salt()
    pw_hash = _hash_pw(new_pw, salt)
    rev_ts = revoke_all_user_tokens(uid)
    if token:
        revoke_auth_token(token)
    _purge_uid_cache(token=token, uid=uid)
    updated = _user_update(uid, {
        "password_hash": pw_hash,
        "salt": salt,
        "password_set": 1,
        "tokens_valid_after": rev_ts,
    }) or {**row, "password_hash": pw_hash, "salt": salt, "password_set": 1, "tokens_valid_after": rev_ts}
    user = _row_to_user(updated)
    fresh_iat = round(max(time.time(), rev_ts + 0.005), 3)
    new_tok = sign_auth_token(user, pw_verifier=_pw_verifier(uid, new_pw), issued_override=fresh_iat)
    return JSONResponse({"ok": True, "user": user, "authToken": new_tok, "message": "Şifreniz başarıyla güncellendi."})


async def auth_delete_account(request: Request) -> JSONResponse:
    auth_hdr = request.headers.get("Authorization", "")
    body: Dict[str, Any] = {}
    if request.method in ("POST", "DELETE"):
        try:
            raw_b = await request.body()
            if raw_b:
                parsed = json.loads(raw_b.decode("utf-8"))
                if isinstance(parsed, dict):
                    body = parsed
        except Exception:
            body = {}
    token = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else str(body.get("authToken") or "")
    claims = verify_auth_token(token)
    if not claims:
        return JSONResponse({"ok": False, "error": "Oturum doğrulanamadı."}, status_code=401)
    uid = str(claims["uid"])
    row = _user_get(uid)
    if not row:
        return JSONResponse({"ok": False, "error": "Hesap bulunamadı."}, status_code=401)
    supplied_pw = str(body.get("password") or "")[:256]
    has_pw = bool(row.get("password_set")) or str(row.get("auth_provider") or "") == "email"
    if supplied_pw and has_pw:
        if not constant_time_eq(row["password_hash"], _hash_pw(supplied_pw, row["salt"])):
            return JSONResponse({"ok": False, "error": "Şifre doğrulanamadı."}, status_code=401)
    if token:
        revoke_auth_token(token)
    _user_delete(uid)
    _purge_uid_cache(token=token, uid=uid)
    return JSONResponse({"ok": True, "deleted": True, "message": "Hesabınız kalıcı olarak silindi."})


async def auth_logout(request: Request) -> JSONResponse:
    auth_hdr = request.headers.get("Authorization", "")
    token = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else ""
    claims = verify_any_token(token) if token else None
    uid = str((claims or {}).get("uid") or "").strip()
    if token:
        revoke_auth_token(token)
    if uid and not (claims or {}).get("guest"):
        revoke_all_user_tokens(uid)
    _purge_uid_cache(token=token, uid=uid)
    if uid:
        try:
            import social_engine
            pres = social_engine._PRESENCE_MAP.get(uid) or {}
            pres.update({"uid": uid, "state": "offline", "roomId": "", "lastSeen": time.time()})
            social_engine._PRESENCE_MAP[uid] = pres
            social_engine._kv_set(f"wl:soc:pres:{uid}", pres, ttl_sec=86400)
        except Exception:
            pass
    return JSONResponse({"ok": True, "loggedOut": True})


async def auth_me(request: Request) -> JSONResponse:
    if request.method == "DELETE":
        return await auth_delete_account(request)
    priv_hdrs = {"Cache-Control": "private, no-store, max-age=0", "Vary": "Authorization"}
    auth_hdr = request.headers.get("Authorization", "")
    token = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else ""
    if not token:
        return JSONResponse({"ok": False, "authenticated": False}, status_code=200, headers=priv_hdrs)
    claims = verify_auth_token(token)
    if not claims:
        return JSONResponse({"ok": False, "authenticated": False}, status_code=401, headers=priv_hdrs)
    pwh_keep = str(claims.get("pwh") or "")
    lookup_failed = False
    try:
        row = _user_get(claims["uid"])
    except sqlite3.OperationalError:
        return JSONResponse({"ok": False, "authenticated": False, "error": "Veritabanı meşgul."}, status_code=503, headers=priv_hdrs)
    except Exception:
        row = None
        lookup_failed = True
    if row:
        u_obj = _row_to_user(row)
        _sync_user_to_social(u_obj)
        return JSONResponse({"ok": True, "authenticated": True, "user": u_obj, "authToken": sign_auth_token(u_obj, pw_verifier=pwh_keep)}, headers=priv_hdrs)
    if not (IS_VERCEL and store_backend() == "sqlite" and not lookup_failed and not is_uid_deleted(str(claims["uid"]))):
        return JSONResponse({"ok": False, "authenticated": False}, status_code=401, headers=priv_hdrs)
    user = {
        "uid": claims["uid"],
        "email": claims.get("email", ""),
        "handle": str(claims.get("handle") or "").lstrip("@") or _norm_handle("", str(claims.get("name") or "uye")),
        "name": claims.get("name") or "Üye",
        "color": claims.get("color", "#00f5d4"),
        "avatar": claims.get("avatarUrl") or claims.get("avatar", "🎬"),
        "avatarUrl": str(claims.get("avatarUrl") or ""),
        "bio": str(claims.get("bio") or ""),
        "statusText": str(claims.get("statusText") or ""),
        "statusEmoji": str(claims.get("statusEmoji") or "🍿"),
        "hideWatching": bool(claims.get("hideWatching", False)),
        "hideFriends": bool(claims.get("hideFriends", False)),
        "hideLocation": bool(claims.get("hideLocation", False)),
        "authProvider": claims.get("provider", "email"),
        "verified": bool(claims.get("verified", True)),
        "passwordSet": True,
        "isGuest": False,
    }
    try:
        salt = _new_salt()
        _user_create({
            "uid": user["uid"],
            "email": user["email"] or f"{user['uid']}@watchlivo.online",
            "handle": user["handle"],
            "name": user["name"],
            "password_hash": _hash_pw(secrets.token_hex(12), salt),
            "salt": salt,
            "color": user["color"],
            "avatar": str(claims.get("avatar") or "🎬"),
            "avatar_url": user["avatarUrl"],
            "bio": user["bio"],
            "status_text": user["statusText"],
            "status_emoji": user["statusEmoji"],
            "hide_watching": 1 if user["hideWatching"] else 0,
            "hide_friends": 1 if user["hideFriends"] else 0,
            "hide_location": 1 if user["hideLocation"] else 0,
            "auth_provider": user["authProvider"],
            "verified": 1 if user["verified"] else 0,
            "password_set": 1,
            "created_at": time.time(),
            "updated_at": time.time(),
        })
    except Exception:
        pass
    _sync_user_to_social(user)
    return JSONResponse({"ok": True, "authenticated": True, "user": user, "authToken": sign_auth_token(user, pw_verifier=pwh_keep)}, headers=priv_hdrs)


def public_user_card(row: Any) -> Dict[str, Any]:
    """Return a public-safe user profile card (never exposes password hash, salt, or private email)."""
    u = _row_to_user(row)
    raw_h = str(u.get("handle") or "").strip().lstrip("@")
    return {
        "uid": str(u.get("uid") or ""),
        "name": str(u.get("name") or "Üye"),
        "handle": f"@{raw_h}" if raw_h else "@uye",
        "color": str(u.get("color") or "#00f5d4"),
        "avatar": str(u.get("avatar") or "🎬"),
        "avatarUrl": str(u.get("avatarUrl") or ""),
        "bio": str(u.get("bio") or ""),
        "statusText": str(u.get("statusText") or ""),
        "statusEmoji": str(u.get("statusEmoji") or "🍿"),
        "hideWatching": bool(u.get("hideWatching", False)),
        "hideFriends": bool(u.get("hideFriends", False)),
        "hideLocation": bool(u.get("hideLocation", False)),
        "verified": bool(u.get("verified", True)),
    }


def resolve_public_user(identifier: str) -> Optional[Dict[str, Any]]:
    """Resolve a registered Watchlivo account by uid, @handle, exact email, or exact display name."""
    raw = str(identifier or "").strip()
    if not raw or len(raw) > 120:
        return None
    try:
        if raw.startswith("u_"):
            row = _user_get(raw)
            if row:
                return public_user_card(row)
        if "@" in raw and not raw.startswith("@"):
            uid_em = _uid_for("email", raw.lower())
            if uid_em:
                row = _user_get(uid_em)
                if row:
                    return public_user_card(row)
        stripped = _strip_discrim_tag(raw.lstrip("@").strip())
        clean_h = stripped.lower()
        folded_h = _tr_fold(stripped)
        norm_h = re.sub(r"[^a-z0-9_.\-]", "", folded_h)[:24].strip("._-")
        for h_cand in dict.fromkeys([clean_h, folded_h, norm_h]):
            if not h_cand or len(h_cand) < 2:
                continue
            uid_h = _uid_for("handle", h_cand)
            if uid_h:
                row = _user_get(uid_h)
                if row:
                    return public_user_card(row)
        raw_stripped = _strip_discrim_tag(raw)
        raw_folded = _tr_fold(raw_stripped)
        if store_backend() == "sqlite":
            conn = _get_db()
            try:
                row = conn.execute(
                    "SELECT * FROM watchlivo_users WHERE lower(handle) = ? OR lower(name) = ? OR lower(email) = ? LIMIT 1",
                    (clean_h, raw_stripped.lower(), raw.lower()),
                ).fetchone()
                if row:
                    return public_user_card(row)
                for cand_row in conn.execute("SELECT * FROM watchlivo_users ORDER BY updated_at DESC LIMIT 300").fetchall():
                    d_r = dict(cand_row)
                    if _tr_fold(d_r.get("handle") or "") in (folded_h, norm_h) or _tr_fold(d_r.get("name") or "") == raw_folded:
                        return public_user_card(d_r)
            finally:
                conn.close()
        else:
            uids = _kv("SMEMBERS", f"{_kp()}uids") or []
            if isinstance(uids, list):
                for u_id in uids[:200]:
                    row = _user_get(str(u_id))
                    if not row:
                        continue
                    if _tr_fold(row.get("handle") or "") in (folded_h, norm_h) or _tr_fold(row.get("name") or "") == raw_folded:
                        return public_user_card(row)
    except Exception:
        return None
    return None


def search_public_users(query: str, exclude_uid: str = "", limit: int = 20) -> list[Dict[str, Any]]:
    """Search registered Watchlivo accounts by @handle or display name (never enumerates private emails)."""
    q = _strip_discrim_tag(str(query or "").strip())
    if not q:
        return []
    q_low = re.sub(r"[%_\\]", "", q.lower().lstrip("@")).strip()
    q_fold = _tr_fold(q_low)
    q_norm = re.sub(r"[^a-z0-9_.\-]", "", q_fold)
    if not q_low and not q_fold:
        return []
    results: Dict[str, Dict[str, Any]] = {}
    if "@" not in q or q.startswith("@"):
        exact = resolve_public_user(q)
        if exact and exact.get("uid") and exact["uid"] != exclude_uid:
            results[exact["uid"]] = exact
    try:
        if store_backend() == "sqlite":
            conn = _get_db()
            try:
                esc_q = q_low.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                like_q = f"%{esc_q}%"
                rows = conn.execute(
                    "SELECT * FROM watchlivo_users WHERE lower(handle) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
                    (like_q, like_q, max(1, min(limit, 30))),
                ).fetchall()
                for r in rows:
                    card = public_user_card(r)
                    if card.get("uid") and card["uid"] != exclude_uid:
                        results[card["uid"]] = card
                if len(results) < limit:
                    for r in conn.execute("SELECT * FROM watchlivo_users ORDER BY updated_at DESC LIMIT 300").fetchall():
                        card = public_user_card(r)
                        c_uid = card.get("uid") or ""
                        if not c_uid or c_uid == exclude_uid or c_uid in results:
                            continue
                        h_f = _tr_fold(card["handle"].lstrip("@"))
                        n_f = _tr_fold(card["name"])
                        if (q_fold and (q_fold in h_f or q_fold in n_f)) or (q_norm and len(q_norm) >= 2 and (q_norm in h_f or q_norm in re.sub(r"[^a-z0-9_.\-]", "", n_f))):
                            results[c_uid] = card
                            if len(results) >= limit:
                                break
            finally:
                conn.close()
        else:
            uids = _kv("SMEMBERS", f"{_kp()}uids") or []
            if isinstance(uids, list):
                for u_id in uids[:200]:
                    if len(results) >= limit or str(u_id) == exclude_uid:
                        continue
                    row = _user_get(str(u_id))
                    if not row:
                        continue
                    card = public_user_card(row)
                    h_f = _tr_fold(card["handle"].lstrip("@"))
                    n_f = _tr_fold(card["name"])
                    if (q_fold and (q_fold in h_f or q_fold in n_f)) or (q_norm and len(q_norm) >= 2 and (q_norm in h_f or q_norm in re.sub(r"[^a-z0-9_.\-]", "", n_f))):
                        results[card["uid"]] = card
    except Exception:
        pass
    return list(results.values())[:limit]


def has_active_max_connection(target: Any) -> Dict[str, Any]:
    """Check whether a user, guest session token, or request has an active Max (HBO) account connection."""
    try:
        import server
        return server.has_active_max_connection(target)
    except Exception:
        return {
            "has_active_connection": False,
            "provider": "max",
            "user_id": "",
            "reason": "unavailable",
        }


def check_user_provider_status(user_id: str, provider: str = "max") -> Dict[str, Any]:
    """Check connection status for a provider (default: 'max') for a given user or guest session."""
    try:
        import server
        return server.check_user_provider_status(user_id, provider)
    except Exception:
        return {
            "has_active_connection": False,
            "provider": str(provider or "max"),
            "user_id": str(user_id or ""),
            "reason": "unavailable",
        }


