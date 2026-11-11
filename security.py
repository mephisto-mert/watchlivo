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
from typing import Any, Dict, Optional, Tuple

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
                _EPHEMERAL[name] = (
                    hmac.new(
                        shared_entropy.encode("utf-8"),
                        f"watchlivo-shared-secret-v4:{name}".encode("utf-8"),
                        hashlib.sha256,
                    )
                    .hexdigest()[:32]
                    .encode("ascii")
                )
                if name not in _WARNED:
                    _WARNED.add(name)
                    print(f"[security] {name} tanımlı değil — özel küme entropisinden deterministik ASCII HMAC sırrı üretildi.")
            else:
                _EPHEMERAL[name] = secrets.token_hex(16).encode("ascii")
                if name not in _WARNED:
                    _WARNED.add(name)
                    print(f"[security] {name} tanımlı değil — süreç bazlı rastgele CSPRNG sırrı üretildi.")
        return _EPHEMERAL[name]


class BoundedTTLCache:
    """Thread-safe dict-compatible LRU + TTL cache preventing unbounded RAM growth."""

    def __init__(self, maxsize: int = 2048, default_ttl: float = 1800.0, ttl: Optional[float] = None) -> None:
        self.maxsize = max(16, int(maxsize))
        self.default_ttl = float(ttl if ttl is not None else default_ttl)
        self._lock = threading.RLock()
        self._data: "OrderedDict[object, Tuple[object, float]]" = OrderedDict()

    def _purge_expired_locked(self, now_t: float, max_scan: int = 64) -> None:
        scanned = 0
        stale = []
        for k, (_, exp) in self._data.items():
            if exp > 0 and exp <= now_t:
                stale.append(k)
            scanned += 1
            if scanned >= max_scan:
                break
        for k in stale:
            self._data.pop(k, None)

    def get(self, key: object, default: object = None) -> object:
        now_t = time.time()
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return default
            val, exp = item
            if exp > 0 and exp <= now_t:
                self._data.pop(key, None)
                return default
            self._data.move_to_end(key)
            return val

    def set(self, key: object, value: object, ttl: Optional[float] = None) -> None:
        eff_ttl = self.default_ttl if ttl is None else float(ttl)
        now_t = time.time()
        exp = (now_t + eff_ttl) if eff_ttl > 0 else 0.0
        with self._lock:
            if key in self._data:
                self._data.pop(key, None)
            self._data[key] = (value, exp)
            if len(self._data) > self.maxsize:
                self._purge_expired_locked(now_t, max_scan=128)
                while len(self._data) > self.maxsize:
                    self._data.popitem(last=False)

    def __getitem__(self, key: object) -> object:
        sentinel = object()
        val = self.get(key, sentinel)
        if val is sentinel:
            raise KeyError(key)
        return val

    def __setitem__(self, key: object, value: object) -> None:
        self.set(key, value)

    def __contains__(self, key: object) -> bool:
        sentinel = object()
        return self.get(key, sentinel) is not sentinel

    def setdefault(self, key: object, default: object = None) -> object:
        sentinel = object()
        with self._lock:
            cur = self.get(key, sentinel)
            if cur is not sentinel:
                return cur
            self.set(key, default)
            return default

    def pop(self, key: object, *args: object) -> object:
        now_t = time.time()
        with self._lock:
            item = self._data.pop(key, None)
            if item is not None:
                val, exp = item
                if exp <= 0 or exp > now_t:
                    return val
            if args:
                return args[0]
            raise KeyError(key)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def keys(self):
        now_t = time.time()
        with self._lock:
            return [k for k, (_, exp) in list(self._data.items()) if exp <= 0 or exp > now_t]

    def values(self):
        now_t = time.time()
        with self._lock:
            return [v for _, (v, exp) in list(self._data.items()) if exp <= 0 or exp > now_t]

    def items(self):
        now_t = time.time()
        with self._lock:
            return [(k, v) for k, (v, exp) in list(self._data.items()) if exp <= 0 or exp > now_t]

    def delete(self, key: object) -> None:
        with self._lock:
            self._data.pop(key, None)

    def update(self, mapping: Any) -> None:
        items = mapping.items() if hasattr(mapping, "items") else mapping
        for k, v in items:
            self.set(k, v)

    def __iter__(self):
        return iter(self.keys())

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


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
# Upstash Redis circuit-breaker (zero-latency fallback when quota/network fails)
# ---------------------------------------------------------------------------
_UPSTASH_CB_LOCK = threading.Lock()
_UPSTASH_DOWN_UNTIL: dict[str, float] = {}
_CF_WORKER_EGRESS_NETS = (
    ipaddress.ip_network("2a06:98c0::/29"),
)
_CF_EDGE_NETS = (
    ipaddress.ip_network("173.245.48.0/20"),
    ipaddress.ip_network("103.21.244.0/22"),
    ipaddress.ip_network("103.22.200.0/22"),
    ipaddress.ip_network("103.31.4.0/22"),
    ipaddress.ip_network("141.101.64.0/18"),
    ipaddress.ip_network("108.162.192.0/18"),
    ipaddress.ip_network("190.93.240.0/20"),
    ipaddress.ip_network("188.114.96.0/20"),
    ipaddress.ip_network("197.234.240.0/22"),
    ipaddress.ip_network("198.41.128.0/17"),
    ipaddress.ip_network("162.158.0.0/15"),
    ipaddress.ip_network("104.16.0.0/13"),
    ipaddress.ip_network("104.24.0.0/14"),
    ipaddress.ip_network("172.64.0.0/13"),
    ipaddress.ip_network("131.0.72.0/22"),
    ipaddress.ip_network("2400:cb00::/32"),
    ipaddress.ip_network("2606:4700::/32"),
    ipaddress.ip_network("2803:f800::/32"),
    ipaddress.ip_network("2405:b500::/32"),
    ipaddress.ip_network("2405:8100::/32"),
    ipaddress.ip_network("2a06:98c0::/29"),
    ipaddress.ip_network("2c0f:f248::/32"),
)


def is_upstash_down(url: Optional[str]) -> bool:
    u = (url or "").strip().rstrip("/")
    if not u:
        return False
    exp = _UPSTASH_DOWN_UNTIL.get(u, 0.0)
    if exp <= 0.0:
        return False
    if time.time() < exp:
        return True
    with _UPSTASH_CB_LOCK:
        if time.time() >= _UPSTASH_DOWN_UNTIL.get(u, 0.0):
            _UPSTASH_DOWN_UNTIL.pop(u, None)
            return False
    return True


def mark_upstash_down(url: Optional[str], cooldown_sec: float = 60.0) -> None:
    u = (url or "").strip().rstrip("/")
    if not u:
        return
    until = time.time() + max(5.0, float(cooldown_sec))
    with _UPSTASH_CB_LOCK:
        _UPSTASH_DOWN_UNTIL[u] = max(until, _UPSTASH_DOWN_UNTIL.get(u, 0.0))


def mark_upstash_ok(url: Optional[str]) -> None:
    u = (url or "").strip().rstrip("/")
    if not u or u not in _UPSTASH_DOWN_UNTIL:
        return
    with _UPSTASH_CB_LOCK:
        _UPSTASH_DOWN_UNTIL.pop(u, None)


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
        if not url or is_upstash_down(url):
            return None
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps([str(c) for c in cmd]).encode("utf-8"),
                headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=1.2) as r:
                out = json.loads(r.read().decode("utf-8"))
            if isinstance(out, dict) and out.get("error"):
                mark_upstash_down(url, 60.0)
                return None
            mark_upstash_ok(url)
            return out.get("result") if isinstance(out, dict) else None
        except Exception:
            mark_upstash_down(url, 60.0)
            return None

    def hit(self, key: str) -> Tuple[bool, float]:
        """Register one attempt. Returns (allowed, retry_after_seconds)."""
        key = f"{self.name}:{key}"[:200]
        url, _ = self._kv_cfg()
        if url and not is_upstash_down(url):
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
            if not is_upstash_down(url):
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
            else:
                self._hits.move_to_end(key)
            cutoff = t - self.window
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)
            if len(self._hits) > 20000:
                stale = [k for k, v in self._hits.items() if k != key and (not v or v[-1] < cutoff)]
                for sk in stale:
                    self._hits.pop(sk, None)
                while len(self._hits) > 20000:
                    old_k, _ = next(iter(self._hits.items()))
                    if old_k == key:
                        break
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
        if url and not is_upstash_down(url):
            raw_cnt = self._kv("GET", full_key)
            if not is_upstash_down(url):
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
        if url and not is_upstash_down(url):
            self._kv("DEL", key)
        with self._lock:
            self._hits.pop(key, None)


_DOC_TEST_NETS = (
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
)


def _is_cf_worker_egress_ip(raw_ip: str) -> bool:
    s = (raw_ip or "").strip()
    if not s:
        return False
    try:
        ip = ipaddress.ip_address(s)
        return any(ip in net for net in _CF_WORKER_EGRESS_NETS)
    except Exception:
        return False


def _is_cf_edge_ip(raw_ip: str) -> bool:
    s = (raw_ip or "").strip()
    if not s:
        return False
    try:
        ip = ipaddress.ip_address(s)
        return any(ip in net for net in _CF_EDGE_NETS)
    except Exception:
        return False


def _is_trusted_proxy_peer(peer: str, *, allow_cf_edge: bool = True) -> bool:
    p = (peer or "").strip()
    if not p:
        return False
    if p in ("127.0.0.1", "::1", "localhost"):
        return True
    try:
        ip = ipaddress.ip_address(p)
        if isinstance(ip, ipaddress.IPv4Address) and any(ip in net for net in _DOC_TEST_NETS):
            return False
        if _is_cf_worker_egress_ip(p):
            return False
        if ip.is_private or ip.is_loopback:
            return True
        if allow_cf_edge and any(ip in net for net in _CF_EDGE_NETS):
            return True
        return False
    except Exception:
        return False


def client_ip(scope_or_request) -> str:
    """Best-effort client IP honouring verified proxy headers without client spoofing."""
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
        for hdr_name in ("x-watchlivo-client-ip", "cf-connecting-ip"):
            edge_ip = (headers.get(hdr_name) or "").split(",")[0].strip()
            if edge_ip:
                try:
                    ipaddress.ip_address(edge_ip)
                    return edge_ip[:64]
                except Exception:
                    continue
    cf_worker_zone = (headers.get("cf-worker") or "").strip().lower()
    untrusted_foreign_worker = bool(
        cf_worker_zone and cf_worker_zone not in ("watchlivo.online", "www.watchlivo.online")
    )
    allow_cf_edge = not untrusted_foreign_worker and not edge_secret
    peer = ""
    try:
        client = getattr(scope_or_request, "client", None)
        if client and getattr(client, "host", None):
            peer = str(client.host).strip()[:64]
    except Exception:
        pass
    if not peer:
        scope = scope_or_request if isinstance(scope_or_request, dict) else (getattr(scope_or_request, "scope", None) or {})
        try:
            client = scope.get("client")
            if client and client[0]:
                peer = str(client[0]).strip()[:64]
        except Exception:
            pass
    trust_vercel = os.environ.get("VERCEL") == "1"
    trust_proxy = (
        os.environ.get("WATCHLIVO_TRUST_PROXY") == "1"
        or bool(os.environ.get("RENDER"))
        or _is_trusted_proxy_peer(peer, allow_cf_edge=allow_cf_edge)
    )
    if trust_vercel and not trust_proxy:
        v_ip = (headers.get("x-vercel-forwarded-for") or headers.get("cf-connecting-ip") or headers.get("x-real-ip") or "").split(",")[0].strip()
        if v_ip and not (not edge_secret and _is_cf_worker_egress_ip(v_ip)):
            try:
                ipaddress.ip_address(v_ip)
                return v_ip[:64]
            except Exception:
                pass
    elif trust_proxy:
        cf_ip = (headers.get("cf-connecting-ip") or "").split(",")[0].strip()
        if not untrusted_foreign_worker and cf_ip and (headers.get("cf-ray") or _is_trusted_proxy_peer(peer, allow_cf_edge=allow_cf_edge)):
            if not edge_secret and cf_worker_zone in ("watchlivo.online", "www.watchlivo.online") and (_is_cf_worker_egress_ip(cf_ip) or _is_cf_edge_ip(cf_ip)):
                wl_ip = (headers.get("x-watchlivo-client-ip") or headers.get("x-forwarded-for") or "").split(",")[0].strip()
                if wl_ip and not _is_cf_worker_egress_ip(wl_ip) and not _is_cf_edge_ip(wl_ip):
                    try:
                        ipaddress.ip_address(wl_ip)
                        return wl_ip[:64]
                    except Exception:
                        pass
            if not _is_cf_worker_egress_ip(cf_ip):
                try:
                    ipaddress.ip_address(cf_ip)
                    return cf_ip[:64]
                except Exception:
                    pass
        xff = headers.get("x-forwarded-for") or ""
        if xff:
            fallback_cand = ""
            for raw_part in reversed(xff.split(",")):
                cand = raw_part.strip()
                if not cand:
                    continue
                try:
                    ipaddress.ip_address(cand)
                    if not fallback_cand:
                        fallback_cand = cand[:64]
                    if not _is_trusted_proxy_peer(cand, allow_cf_edge=allow_cf_edge) and not (not edge_secret and not untrusted_foreign_worker and _is_cf_worker_egress_ip(cand)):
                        return cand[:64]
                except Exception:
                    continue
            if fallback_cand:
                return fallback_cand
        real_ip = (headers.get("x-real-ip") or "").split(",")[0].strip()
        if real_ip and not untrusted_foreign_worker:
            try:
                ipaddress.ip_address(real_ip)
                return real_ip[:64]
            except Exception:
                pass
    return peer or "unknown"


def too_many_response(retry_after: float):
    from starlette.responses import JSONResponse

    retry_sec = int(max(1, round(float(retry_after or 1.0))))
    return JSONResponse(
        {
            "ok": False,
            "error": "Çok fazla istek gönderildi, lütfen birkaç saniye bekleyip tekrar deneyin.",
            "retryable": True,
            "retryAfter": retry_sec,
        },
        status_code=429,
        headers={"Retry-After": str(retry_sec), "Cache-Control": "no-store"},
    )


_CGNAT_NETWORK = ipaddress.ip_network("100.64.0.0/10")
_NAT64_NETWORK = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL_NETWORK = ipaddress.ip_network("64:ff9b:1::/48")


def is_ip_public_global(ip_obj: ipaddress._BaseAddress | str) -> bool:
    """Validate that an IPv4/IPv6 address (and any embedded/mapped IPv4) is globally routable."""
    if isinstance(ip_obj, str):
        s = ip_obj.strip()
        if not s:
            return False
        try:
            ip_obj = ipaddress.ip_address(s)
        except ValueError:
            return False
    candidates = [ip_obj]
    if isinstance(ip_obj, ipaddress.IPv6Address):
        if ip_obj.ipv4_mapped is not None:
            candidates.append(ip_obj.ipv4_mapped)
        if ip_obj.sixtofour is not None:
            candidates.append(ip_obj.sixtofour)
        if ip_obj.teredo is not None:
            candidates.extend(ip_obj.teredo)
        if ip_obj in _NAT64_NETWORK or ip_obj in _NAT64_LOCAL_NETWORK:
            candidates.append(ipaddress.IPv4Address(int(ip_obj) & 0xFFFFFFFF))
    for ip in candidates:
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
            or (isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT_NETWORK)
        ):
            return False
    return True


_DNS_PUBLIC_CACHE = BoundedTTLCache(maxsize=2048, default_ttl=60.0)


def is_safe_public_url(url: str) -> bool:
    """Reject non-http(s) schemes and hosts resolving to private/loopback/link-local/CGNAT/NAT64 ranges."""
    import socket
    import urllib.parse

    try:
        p = urllib.parse.urlparse(str(url or "").strip())
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        if p.username or p.password:
            return False
        host = p.hostname.lower().rstrip(".")
        if (
            not host
            or host in ("localhost", "metadata.google.internal", "metadata", "watchlivo.online", "www.watchlivo.online", "watchlivo-origin-eu.onrender.com")
            or host.endswith((".localhost", ".local", ".internal", ".home.arpa", ".watchlivo.online"))
        ):
            return False
        try:
            lit_ip = ipaddress.ip_address(host)
            return is_ip_public_global(lit_ip)
        except ValueError:
            pass
        port = int(p.port or (443 if p.scheme == "https" else 80))
        cache_key = f"{host}:{port}"
        cached = _DNS_PUBLIC_CACHE.get(cache_key)
        if cached is not None:
            return bool(cached)
        infos = socket.getaddrinfo(host, port)
        if not infos:
            _DNS_PUBLIC_CACHE.set(cache_key, False, ttl=15.0)
            return False
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if not is_ip_public_global(ip):
                _DNS_PUBLIC_CACHE.set(cache_key, False, ttl=30.0)
                return False
        _DNS_PUBLIC_CACHE.set(cache_key, True, ttl=60.0)
        return True
    except Exception:
        return False

