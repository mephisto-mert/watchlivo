"""Shared security primitives for Watchlivo.

Central place for:
- fail-closed secrets (no hard-coded fallbacks in production)
- rate limiting (memory for single process, Upstash REST when available)
- small crypto helpers used by rooms / auth / proxy layers
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import threading
import time
import urllib.request
from collections import OrderedDict
from typing import Dict, Optional, Tuple

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
_EPHEMERAL: Dict[str, bytes] = {}
_WARNED: set[str] = set()
_SECRET_LOCK = threading.Lock()


def server_secret(name: str, *, min_len: int = 16) -> bytes:
    """Return a process-wide secret for ``name``.

    Order of preference:
    1. environment variable (must be at least ``min_len`` chars)
    2. fail hard when WATCHLIVO_STRICT_SECRETS=1 (recommended for production)
    3. per-process random secret + loud warning (forgery impossible, but tokens
       minted by one instance will not validate on another)
    """
    raw = (os.environ.get(name) or "").strip()
    if len(raw) >= min_len:
        return raw.encode("utf-8")
    if os.environ.get("WATCHLIVO_STRICT_SECRETS") == "1":
        raise RuntimeError(
            f"{name} ortam değişkeni tanımlı değil veya çok kısa (>= {min_len} karakter). "
            "WATCHLIVO_STRICT_SECRETS=1 iken uygulama başlamaz."
        )
    with _SECRET_LOCK:
        if name not in _EPHEMERAL:
            shared_entropy = ""
            for env_key in ("VORTEX_SECRET", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_URL"):
                cand = (os.environ.get(env_key) or "").strip()
                if len(cand) >= 24:
                    shared_entropy = cand
                    break
            if shared_entropy:
                _EPHEMERAL[name] = hmac.new(
                    shared_entropy.encode("utf-8"),
                    f"watchlivo-shared-secret-v4:{name}".encode("utf-8"),
                    hashlib.sha256,
                ).digest()
                if name not in _WARNED:
                    _WARNED.add(name)
                    print(f"[security] {name} tanımlı değil — özel küme entropisinden deterministik HMAC sırrı üretildi.")
            else:
                _EPHEMERAL[name] = secrets.token_bytes(32)
                if name not in _WARNED:
                    _WARNED.add(name)
                    print(f"[security] {name} tanımlı değil — süreç bazlı rastgele CSPRNG sırrı üretildi.")
        return _EPHEMERAL[name]


def constant_time_eq(left: str, right: str) -> bool:
    """Compare two strings without leaking length/timing information."""
    return hmac.compare_digest(
        (left or "").encode("utf-8", "ignore"), (right or "").encode("utf-8", "ignore")
    )


def sign_blob(key: bytes, *parts: str) -> str:
    msg = "|".join(str(p) for p in parts).encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def sign_b64(key: bytes, payload: dict) -> str:
    """URL-safe base64 payload + trailing signature (``payload.sig``)."""
    import base64

    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"{b64}.{sign_blob(key, b64)[:32]}"


def unsign_b64(key: bytes, token: str, *, max_age: float = 0.0) -> Optional[dict]:
    import base64
    import math

    if not token or not isinstance(token, str) or len(token) > 4096 or "." not in token:
        return None
    b64, sig = token.rsplit(".", 1)
    if not sig.isascii() or not hmac.compare_digest(sign_blob(key, b64)[:32], sig):
        return None
    try:
        pad = "=" * (-len(b64) % 4)
        data = json.loads(base64.urlsafe_b64decode(b64 + pad).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if max_age > 0:
        try:
            issued = float(data.get("iat") or 0.0)
        except (TypeError, ValueError):
            return None
        now_t = time.time()
        if not math.isfinite(issued) or issued <= 0 or issued > now_t + 60.0 or (now_t - issued > max_age):
            return None
    return data


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------
class RateLimiter:
    """Token-free sliding window limiter.

    Uses Upstash Redis single-RTT Lua EVAL when configured (atomic across serverless
    instances), otherwise an in-process ordered mapping.
    """

    _LUA_HIT = (
        "local c = redis.call('INCR', KEYS[1]); "
        "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; "
        "local ttl = redis.call('PTTL', KEYS[1]); "
        "if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end; "
        "return {c, ttl}"
    )

    def __init__(self, limit: int, window: float, *, name: str = "rl") -> None:
        self.limit = max(1, int(limit))
        self.window = float(window)
        self.name = name
        self._lock = threading.Lock()
        self._hits: "OrderedDict[str, list[float]]" = OrderedDict()

    # -- redis backend -----------------------------------------------------
    def _kv_cfg(self) -> Tuple[Optional[str], Optional[str]]:
        url = (os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL") or "").rstrip("/")
        tok = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN") or ""
        return (url, tok) if (url and tok) else (None, None)

    def _kv(self, *cmd) -> Optional[object]:
        url, tok = self._kv_cfg()
        if not url:
            return None
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps([str(c) for c in cmd]).encode("utf-8"),
                headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=2.5) as r:
                out = json.loads(r.read().decode("utf-8"))
            return out.get("result") if isinstance(out, dict) else None
        except Exception:
            return None

    def hit(self, key: str) -> Tuple[bool, float]:
        """Register one attempt. Returns (allowed, retry_after_seconds)."""
        key = f"{self.name}:{key}"[:200]
        url, _ = self._kv_cfg()
        if url:
            win_ms = max(1000, int(round(self.window * 1000)))
            eval_res = self._kv("EVAL", self._LUA_HIT, "1", key, str(win_ms))
            if isinstance(eval_res, list) and len(eval_res) >= 2:
                try:
                    count_int = int(eval_res[0])
                    pttl_ms = float(eval_res[1])
                except (TypeError, ValueError):
                    count_int = None
                    pttl_ms = -1.0
                if count_int is not None:
                    if count_int > self.limit:
                        retry = (pttl_ms / 1000.0) if pttl_ms > 0 else self.window
                        return False, max(1.0, retry)
                    return True, 0.0
            win_sec = int(self.window) or 1
            count = self._kv("INCR", key)
            try:
                count_int = int(count)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                count_int = None
            if count_int == 1:
                self._kv("EXPIRE", key, win_sec)
            if count_int is not None:
                if count_int > self.limit:
                    ttl = self._kv("TTL", key)
                    try:
                        retry = float(ttl)  # type: ignore[arg-type]
                    except (TypeError, ValueError):
                        retry = self.window
                    if retry < 0:
                        self._kv("EXPIRE", key, win_sec)
                        retry = self.window
                    return False, max(1.0, retry)
                return True, 0.0
        t = time.time()
        with self._lock:
            bucket = self._hits.get(key)
            if bucket is None:
                bucket = []
                self._hits[key] = bucket
            cutoff = t - self.window
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)
            if len(self._hits) > 20000:
                for stale in [k for k, v in list(self._hits.items())[:5000] if not v or v[-1] < cutoff]:
                    self._hits.pop(stale, None)
                if len(self._hits) > 20000:
                    for old_k in list(self._hits.keys())[:4000]:
                        self._hits.pop(old_k, None)
            if len(bucket) >= self.limit:
                retry = max(1.0, self.window - (t - bucket[0]))
                return False, retry
            bucket.append(t)
            return True, 0.0

    def peek(self, key: str) -> Tuple[bool, float]:
        """Check whether key is currently rate-limited without consuming a token."""
        full_key = f"{self.name}:{key}"[:200]
        url, _ = self._kv_cfg()
        if url:
            raw_cnt = self._kv("GET", full_key)
            try:
                cnt_int = int(raw_cnt) if raw_cnt is not None else 0  # type: ignore[arg-type]
            except (TypeError, ValueError):
                cnt_int = 0
            if cnt_int >= self.limit:
                ttl = self._kv("TTL", full_key)
                try:
                    retry = max(1.0, float(ttl))  # type: ignore[arg-type]
                except (TypeError, ValueError):
                    retry = self.window
                return False, retry
            return True, 0.0
        t = time.time()
        with self._lock:
            bucket = self._hits.get(full_key) or []
            cutoff = t - self.window
            live = [ts for ts in bucket if ts >= cutoff]
            if len(live) >= self.limit:
                return False, max(1.0, self.window - (t - live[0]))
            return True, 0.0

    def reset(self, key: str) -> None:
        key = f"{self.name}:{key}"[:200]
        url, _ = self._kv_cfg()
        if url:
            self._kv("DEL", key)
        with self._lock:
            self._hits.pop(key, None)


def client_ip(scope_or_request) -> str:
    """Best-effort client IP honouring common proxy headers."""
    headers: Dict[str, str] = {}
    if isinstance(scope_or_request, dict):
        for k, v in (scope_or_request.get("headers") or []):
            try:
                headers[k.decode("latin-1").lower()] = v.decode("latin-1")
            except Exception:
                continue
    else:
        try:
            headers = scope_or_request.headers  # type: ignore[assignment]
        except Exception:
            pass
    edge_secret = (os.environ.get("EDGE_ORIGIN_SECRET") or os.environ.get("ADMIN_SECRET") or "").strip()
    req_edge_secret = (headers.get("x-watchlivo-edge-secret") or "").strip()
    if edge_secret and req_edge_secret and constant_time_eq(req_edge_secret, edge_secret):
        edge_ip = (headers.get("x-watchlivo-client-ip") or "").split(",")[0].strip()
        if edge_ip:
            try:
                ipaddress.ip_address(edge_ip)
                return edge_ip[:64]
            except Exception:
                pass
    trust_vercel = os.environ.get("VERCEL") == "1"
    trust_proxy = os.environ.get("WATCHLIVO_TRUST_PROXY") == "1" or bool(os.environ.get("RENDER"))
    trusted_hdrs = (
        ("cf-connecting-ip", "x-vercel-forwarded-for")
        if (trust_vercel and not trust_proxy)
        else (("cf-connecting-ip", "x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for") if trust_proxy else ())
    )
    for hdr_name in trusted_hdrs:
        try:
            val = (headers.get(hdr_name) or "").split(",")[0].strip()
            if val:
                ipaddress.ip_address(val)
                return val[:64]
        except Exception:
            continue
    try:
        client = getattr(scope_or_request, "client", None)
        if client and getattr(client, "host", None):
            return str(client.host)[:64]
    except Exception:
        pass
    scope = scope_or_request if isinstance(scope_or_request, dict) else (getattr(scope_or_request, "scope", None) or {})
    try:
        client = scope.get("client")
        if client:
            return str(client[0])[:64]
    except Exception:
        pass
    return "unknown"


def too_many_response(retry_after: float):
    from starlette.responses import JSONResponse

    return JSONResponse(
        {"ok": False, "error": "Çok fazla deneme yaptınız. Lütfen biraz sonra tekrar deneyin."},
        status_code=429,
        headers={"Retry-After": str(int(max(1, retry_after)))},
    )


_SAFE_HOST_CACHE: "OrderedDict[Tuple[str, int], float]" = OrderedDict()
_SAFE_HOST_LOCK = threading.Lock()


_CGNAT_NETWORK = ipaddress.ip_network("100.64.0.0/10")


def is_safe_public_url(url: str) -> bool:
    """Reject non-http(s) schemes and hosts resolving to private/loopback/link-local/CGNAT ranges (SSRF guard)."""
    import socket
    import urllib.parse

    try:
        p = urllib.parse.urlparse(str(url or "").strip())
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        host = p.hostname.lower()
        port = int(p.port or (443 if p.scheme == "https" else 80))
        now_t = time.time()
        with _SAFE_HOST_LOCK:
            exp = _SAFE_HOST_CACHE.get((host, port))
            if exp and exp > now_t:
                return True
        infos = socket.getaddrinfo(host, port)
        if not infos:
            return False
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
                or (isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT_NETWORK)
            ):
                return False
        with _SAFE_HOST_LOCK:
            _SAFE_HOST_CACHE[(host, port)] = now_t + 5.0
            while len(_SAFE_HOST_CACHE) > 1024:
                _SAFE_HOST_CACHE.popitem(last=False)
        return True
    except Exception:
        return False

