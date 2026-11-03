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
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse

IS_VERCEL = bool(os.environ.get("VERCEL"))
BASE_DIR = pathlib.Path(__file__).parent.resolve()
AUTH_DB_PATH = pathlib.Path("/tmp/watchlivo_auth.db") if IS_VERCEL else BASE_DIR / "rave_platform.db"

from security import RateLimiter, client_ip, constant_time_eq, server_secret, too_many_response

# Fail-closed: no public fallback secret. Without AUTH_SECRET the process uses an
# unguessable per-instance value (or refuses to boot with WATCHLIVO_STRICT_SECRETS=1).
AUTH_SECRET = server_secret("AUTH_SECRET") if len((os.environ.get("AUTH_SECRET") or "").strip()) >= 16 else server_secret("VORTEX_SECRET")
TOKEN_TTL = int(os.environ.get("AUTH_TOKEN_TTL") or 60 * 60 * 24 * 7)
_LOGIN_LIMIT = RateLimiter(10, 300.0, name="login")
_REGISTER_LIMIT = RateLimiter(5, 3600.0, name="register")
_OTP_LIMIT = RateLimiter(5, 600.0, name="otp_send")
_OTP_VERIFY_LIMIT = RateLimiter(10, 600.0, name="otp_verify")
_RESET_LIMIT = RateLimiter(5, 3600.0, name="reset")

HANDLE_RE = re.compile(r"^[a-z0-9_.\-]{2,24}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


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


def _get_db() -> sqlite3.Connection:
    global _AUTH_DB_SCHEMA_READY
    conn = sqlite3.connect(str(AUTH_DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
    except Exception:
        pass
    if not _AUTH_DB_SCHEMA_READY:
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
                hide_location INTEGER DEFAULT 0
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
        ]:
            try:
                conn.execute(f"ALTER TABLE watchlivo_users ADD COLUMN {col_def}")
            except Exception:
                pass
        conn.commit()
        _AUTH_DB_SCHEMA_READY = True
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
    req = urllib.request.Request(url, data=json.dumps([str(c) for c in cmd]).encode("utf-8"),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        out = json.loads(r.read().decode("utf-8"))
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(f"KV error: {out['error']}")
    return out.get("result") if isinstance(out, dict) else None


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
        cols = list(row.keys())
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
        sets = [k for k in cur.keys() if k != "uid"]
        try:
            conn.execute(f"UPDATE watchlivo_users SET {', '.join(f'{k} = ?' for k in sets)} WHERE uid = ?", [cur[k] for k in sets] + [uid])
        except sqlite3.IntegrityError:
            cur["handle"] = f"{str(cur.get('handle') or 'uye')[:18]}_{secrets.token_hex(2)}"
            conn.execute(f"UPDATE watchlivo_users SET {', '.join(f'{k} = ?' for k in sets)} WHERE uid = ?", [cur[k] for k in sets] + [uid])
        conn.commit()
        return cur
    finally:
        conn.close()


def _norm_handle(raw: str, fallback_name: str = "") -> str:
    h = re.sub(r"[^a-z0-9_.\-]", "", (raw or "").strip().lower().lstrip("@")
               .replace("ı", "i").replace("ş", "s").replace("ğ", "g")
               .replace("ü", "u").replace("ö", "o").replace("ç", "c"))[:24]
    if len(h) < 2 and fallback_name:
        h = re.sub(r"[^a-z0-9_.\-]", "", fallback_name.lower()
                   .replace(" ", "_").replace("ı", "i").replace("ş", "s")
                   .replace("ğ", "g").replace("ü", "u").replace("ö", "o").replace("ç", "c"))[:20]
    if len(h) < 2:
        h = "uye_" + secrets.token_hex(3)
    return h


def _hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()


def _new_salt() -> str:
    """Cryptographically random per-account salt (never derived from the uid)."""
    return secrets.token_hex(16)


def sign_auth_token(user: Dict[str, Any]) -> str:
    """Mint a short-lived HMAC session token.

    The password hash never enters the token: a leaked token must not help an
    attacker guess or reuse credentials.
    """
    issued = int(time.time())
    raw_av = str(user.get("avatar") or "🎬")
    safe_av = "📷" if (raw_av.startswith("data:image/") or len(raw_av) > 120) else raw_av
    payload = {
        "uid": user["uid"],
        "email": user.get("email", ""),
        "handle": user.get("handle", ""),
        "name": user.get("name", ""),
        "color": user.get("color", "#00f5d4"),
        "avatar": safe_av,
        "provider": user.get("authProvider", "email"),
        "verified": bool(user.get("verified", True)),
        "iat": issued,
        "exp": issued + TOKEN_TTL,
        "jti": secrets.token_hex(8),
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(AUTH_SECRET, b64.encode("ascii"), hashlib.sha256).hexdigest()[:32]
    return f"{b64}.{sig}"


def _candidate_auth_secrets() -> list[bytes]:
    out = [AUTH_SECRET]
    if not (os.environ.get("AUTH_SECRET") or "").strip() and not (os.environ.get("VORTEX_SECRET") or "").strip():
        ent = (
            os.environ.get("UPSTASH_REDIS_REST_TOKEN")
            or os.environ.get("KV_REST_API_TOKEN")
            or ""
        ).strip()
        if len(ent) >= 24:
            for nm in ("VORTEX_SECRET", "AUTH_SECRET"):
                cand_v4 = hmac.new(ent.encode("utf-8"), f"watchlivo-hmac-secret-v4:{nm}".encode("utf-8"), hashlib.sha256).digest()
                if cand_v4 not in out:
                    out.append(cand_v4)
                cand_v2 = hashlib.sha256(f"watchlivo-deterministic-secret-v2:{nm}:{ent}:default".encode("utf-8")).digest()
                if cand_v2 not in out:
                    out.append(cand_v2)
    return out


def verify_auth_token(token: str) -> Optional[Dict[str, Any]]:
    if not token or "." not in token or len(token) > 4096:
        return None
    b64, sig = token.rsplit(".", 1)
    b64_bytes = b64.encode("ascii")
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
        if float(data.get("exp") or 0.0) <= time.time():
            return None
    except (TypeError, ValueError):
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
        "isGuest": False,
    }


async def auth_register(request: Request) -> JSONResponse:
    allowed, retry_after = _REGISTER_LIMIT.hit(client_ip(request))
    if not allowed:
        return too_many_response(retry_after)
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
    if len(password) < 4:
        return JSONResponse({"ok": False, "error": "Şifre en az 4 karakter olmalıdır."}, status_code=400)
    handle = _norm_handle(raw_handle, name)
    uid = "u_wl_" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:12]
    salt = _new_salt()
    pw_hash = _hash_pw(password, salt)
    now_ts = time.time()
    fb_pw = password if len(password) >= 6 else (password + "_wl26")
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
        "color": color, "avatar": avatar, "auth_provider": "email", "verified": 1, "created_at": now_ts, "updated_at": now_ts,
    }
    try:
        created = _user_create(row)
    except Exception:
        return JSONResponse({"ok": False, "error": "Hesap kaydı şu an yapılamıyor. Lütfen tekrar deneyin."}, status_code=503)
    if not created:
        ex_row = _user_get(uid)
        if ex_row and hmac.compare_digest(_hash_pw(password, ex_row["salt"]), ex_row["password_hash"]):
            user = _row_to_user(ex_row)
            return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user), "emailSent": True})
        return JSONResponse({"ok": False, "error": "Bu e-posta adresi zaten kayıtlı. Lütfen giriş yapın."}, status_code=409)
    user = _row_to_user(row)
    token = sign_auth_token(user)
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
    identifier = str(body.get("identifier") or body.get("email") or body.get("handle") or "").strip().lower()[:120]
    password = str(body.get("password") or "")[:256]
    if not identifier or not password:
        return JSONResponse({"ok": False, "error": "E-posta / kullanıcı adı ve şifre zorunludur."}, status_code=400)
    clean_h = identifier.lstrip("@")
    try:
        uid = _uid_for("email", identifier) if EMAIL_RE.match(identifier) else _uid_for("handle", clean_h)
        row = _user_get(uid) if uid else None
    except Exception:
        row = None
    target_email = identifier if EMAIL_RE.match(identifier) else (row.get("email", "") if row else "")
    fb_verified = False
    local_verified = bool(
        row
        and row.get("password_hash")
        and row.get("salt")
        and constant_time_eq(row["password_hash"], _hash_pw(password, row["salt"]))
    )
    if local_verified:
        fb_verified = True
    elif not row and target_email and EMAIL_RE.match(target_email):
        for cand_pw in ([password, password + "_wl26"] if len(password) < 6 else [password]):
            fb_res = _firebase_auth_req("accounts:signInWithPassword", {
                "email": target_email,
                "password": cand_pw,
                "returnSecureToken": True,
            })
            if fb_res and fb_res.get("idToken"):
                lk_res = _firebase_auth_req("accounts:lookup", {"idToken": fb_res["idToken"]})
                lk_users = (lk_res or {}).get("users") or []
                lk_u0 = lk_users[0] if lk_users else {}
                if lk_u0.get("emailVerified") is True and str(lk_u0.get("email") or "").strip().lower() == target_email:
                    fb_verified = True
                    uid = "u_wl_" + hashlib.sha256(target_email.encode("utf-8")).hexdigest()[:12]
                    salt = _new_salt()
                    pw_hash = _hash_pw(password, salt)
                    disp = str(fb_res.get("displayName") or target_email.split("@")[0])[:24]
                    row = {
                        "uid": uid, "email": target_email,
                        "handle": _norm_handle("", disp),
                        "name": disp, "password_hash": pw_hash, "salt": salt,
                        "color": "#00f5d4", "avatar": "🎬",
                        "auth_provider": "email", "verified": 1, "created_at": time.time(), "updated_at": time.time(),
                    }
                    try:
                        _user_create(row)
                    except Exception:
                        pass
                break
    if not row and EMAIL_RE.match(identifier):
        sb_res = _supabase_auth_req("/auth/v1/token?grant_type=password", {
            "email": identifier,
            "password": password if len(password) >= 6 else (password + "_wl26"),
        })
        if sb_res and isinstance(sb_res.get("user"), dict) and sb_res["user"].get("email_confirmed_at"):
            sb_u = sb_res["user"]
            meta = sb_u.get("user_metadata") or {}
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
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})


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
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    provider = str(body.get("provider") or "google").strip().lower()
    if provider not in PROVIDER_ICONS:
        provider = "google"
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
    pw_hash = _hash_pw(secrets.token_hex(12), salt)
    now_ts = time.time()
    row = {
        "uid": uid, "email": raw_email, "handle": handle, "name": raw_name, "password_hash": pw_hash, "salt": salt,
        "color": color, "avatar": avatar, "auth_provider": provider, "verified": 1, "created_at": now_ts, "updated_at": now_ts,
    }
    try:
        _user_create(row)
    except Exception:
        pass
    user = _row_to_user(row)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})


_PHONE_CODES: Dict[str, Dict[str, Any]] = {}


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
    except Exception:
        pass
    user = _row_to_user(row)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})


async def auth_email_action(request: Request) -> JSONResponse:
    """Firebase Email Actions: Password Reset ('reset_password'), Magic Link ('magic_link'), Complete Link ('complete_magic_link')."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Geçersiz istek."}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "Geçersiz istek."}, status_code=400)
    action = str(body.get("action") or "").strip().lower()
    email = str(body.get("email") or "").strip().lower()[:120]
    if not EMAIL_RE.match(email):
        return JSONResponse({"ok": False, "error": "Lütfen geçerli bir e-posta adresi girin."}, status_code=400)
    if action == "reset_password":
        allowed, retry_after = _RESET_LIMIT.hit(f"{client_ip(request)}:{email}")
        if not allowed:
            return too_many_response(retry_after)
        # Ensure account exists in Firebase Auth so Firebase can dispatch the reset email.
        # The bootstrap password must be random: a derived one would be guessable.
        _firebase_auth_req("accounts:signUp", {
            "email": email,
            "password": "Wl!" + secrets.token_urlsafe(24),
            "returnSecureToken": True,
        })
        res = _firebase_auth_req("accounts:sendOobCode", {"requestType": "PASSWORD_RESET", "email": email})
        if res and res.get("email"):
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
    if len(name) >= 2:
        fields["name"] = name
    if body.get("handle"):
        fields["handle"] = _norm_handle(str(body.get("handle")), name or claims.get("name", ""))
    color = str(body.get("color") or "").strip()[:16]
    if re.match(r"^#[0-9a-fA-F]{3,8}$", color):
        fields["color"] = color
    avatar_url = str(body.get("avatarUrl") or body.get("avatar") or "").strip()
    if avatar_url and (avatar_url.startswith(("https://", "/static/", "/uploads/")) or (avatar_url.startswith("data:image/") and len(avatar_url) <= 45000)):
        fields["avatar_url"] = avatar_url
    elif "avatarUrl" in body and not avatar_url:
        fields["avatar_url"] = ""
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
    try:
        row = _user_update(uid, fields)
    except Exception:
        row = None
    if not row:
        user = {
            "uid": uid,
            "email": claims.get("email", ""),
            "handle": fields.get("handle") or claims.get("handle", "uye"),
            "name": fields.get("name") or claims.get("name", "Üye"),
            "color": fields.get("color") or claims.get("color", "#00f5d4"),
            "avatar": fields.get("avatar_url") or claims.get("avatar", "🎬"),
            "avatarUrl": fields.get("avatar_url", ""),
            "bio": fields.get("bio", ""),
            "statusText": fields.get("status_text", ""),
            "statusEmoji": fields.get("status_emoji", "🍿"),
            "hideWatching": bool(fields.get("hide_watching", 0)),
            "hideFriends": bool(fields.get("hide_friends", 0)),
            "hideLocation": bool(fields.get("hide_location", 0)),
            "authProvider": claims.get("provider", "email"),
            "verified": True,
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
                "created_at": time.time(),
                "updated_at": time.time(),
            })
        except Exception:
            pass
        return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})
    user = _row_to_user(row)
    return JSONResponse({"ok": True, "user": user, "authToken": sign_auth_token(user)})


async def auth_me(request: Request) -> JSONResponse:
    priv_hdrs = {"Cache-Control": "private, no-store, max-age=0", "Vary": "Authorization"}
    auth_hdr = request.headers.get("Authorization", "")
    token = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else ""
    claims = verify_auth_token(token)
    if not claims:
        return JSONResponse({"ok": False, "authenticated": False}, status_code=200, headers=priv_hdrs)
    try:
        row = _user_get(claims["uid"])
    except Exception:
        row = None
    if row:
        u_obj = _row_to_user(row)
        return JSONResponse({"ok": True, "authenticated": True, "user": u_obj, "authToken": sign_auth_token(u_obj)}, headers=priv_hdrs)
    user = {
        "uid": claims["uid"],
        "email": claims.get("email", ""),
        "handle": claims.get("handle", ""),
        "name": claims.get("name", ""),
        "color": claims.get("color", "#00f5d4"),
        "avatar": claims.get("avatar", "🎬"),
        "authProvider": claims.get("provider", "email"),
        "verified": bool(claims.get("verified", True)),
        "isGuest": False,
    }
    return JSONResponse({"ok": True, "authenticated": True, "user": user, "authToken": sign_auth_token(user)}, headers=priv_hdrs)


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
        clean_h = raw.lstrip("@").strip().lower()
        for h_cand in dict.fromkeys([clean_h, _norm_handle(clean_h)]):
            if not h_cand:
                continue
            uid_h = _uid_for("handle", h_cand)
            if uid_h:
                row = _user_get(uid_h)
                if row:
                    return public_user_card(row)
        if store_backend() == "sqlite":
            conn = _get_db()
            try:
                row = conn.execute(
                    "SELECT * FROM watchlivo_users WHERE lower(handle) = ? OR lower(name) = ? OR lower(email) = ? LIMIT 1",
                    (clean_h, raw.lower(), raw.lower()),
                ).fetchone()
                if row:
                    return public_user_card(row)
            finally:
                conn.close()
    except Exception:
        return None
    return None


def search_public_users(query: str, exclude_uid: str = "", limit: int = 20) -> list[Dict[str, Any]]:
    """Search registered Watchlivo accounts by @handle or display name (never enumerates private emails)."""
    q = str(query or "").strip()
    if not q:
        return []
    q_low = re.sub(r"[%_\\]", "", q.lower().lstrip("@")).strip()
    if not q_low:
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
            finally:
                conn.close()
        else:
            uids = _kv("SMEMBERS", f"{_kp()}uids") or []
            if isinstance(uids, list):
                for u_id in uids[:150]:
                    if len(results) >= limit or str(u_id) == exclude_uid:
                        continue
                    row = _user_get(str(u_id))
                    if not row:
                        continue
                    card = public_user_card(row)
                    if q_low in card["handle"].lower() or q_low in card["name"].lower():
                        results[card["uid"]] = card
    except Exception:
        pass
    return list(results.values())[:limit]

