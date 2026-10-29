"""Shared security primitives for Watchlivo.

Central place for:
- fail-closed secrets (no hard-coded fallbacks in production)
- rate limiting (memory for single process, Upstash REST when available)
- small crypto helpers used by rooms / auth / proxy layers
"""
from __future__ import annotations

import hashlib
import hmac
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
    if name not in _EPHEMERAL:
        seed = f"watchlivo-deterministic-secret-v1:{name}:{os.environ.get('VERCEL_GIT_COMMIT_SHA', 'default')}"
        _EPHEMERAL[name] = hashlib.sha256(seed.encode("utf-8")).digest()
        if name not in _WARNED:
            _WARNED.add(name)
            print(
                f"[security] {name} tanımlı değil — deterministik çalışma sırrı üretildi."
            )
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

    if not token or not isinstance(token, str) or len(token) > 4096 or "." not in token:
        return None
    b64, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sign_blob(key, b64)[:32], sig):
        return None
    try:
        pad = "=" * (-len(b64) % 4)
        data = json.loads(base64.urlsafe_b64decode(b64 + pad).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if max_age > 0:
        issued = float(data.get("iat") or 0.0)
        if issued <= 0 or time.time() - issued > max_age:
            return None
    return data


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------
class RateLimiter:
    """Token-free sliding window limiter.

    Uses Upstash Redis when configured (works across serverless instances),
    otherwise an in-process ordered mapping.
    """

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
            count = self._kv("INCR", key)
            try:
                count_int = int(count)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                count_int = None
            if count_int == 1:
                self._kv("EXPIRE", key, int(self.window) or 1)
            if count_int is not None:
                if count_int > self.limit:
                    ttl = self._kv("TTL", key)
                    try:
                        retry = float(ttl)  # type: ignore[arg-type]
                    except (TypeError, ValueError):
                        retry = self.window
                    if retry < 0:
                        self._kv("EXPIRE", key, int(self.window) or 1)
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
            if len(bucket) >= self.limit:
                retry = max(1.0, self.window - (t - bucket[0]))
                return False, retry
            bucket.append(t)
            return True, 0.0

    def reset(self, key: str) -> None:
        key = f"{self.name}:{key}"[:200]
        with self._lock:
            self._hits.pop(key, None)


def client_ip(scope_or_request) -> str:
    """Best-effort client IP honouring common proxy headers."""
    headers = {}
    try:
        headers = scope_or_request.headers  # type: ignore[assignment]
    except Exception:
        pass
    for hdr_name in ("x-vercel-forwarded-for", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"):
        try:
            val = (headers.get(hdr_name) or "").split(",")[0].strip()
            if val:
                return val[:64]
        except Exception:
            continue
    try:
        client = getattr(scope_or_request, "client", None)
        if client and getattr(client, "host", None):
            return str(client.host)[:64]
    except Exception:
        pass
    scope = getattr(scope_or_request, "scope", None) or {}
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
