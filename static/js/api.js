// HTTP API helpers with explicit timeouts, GET deduplication, 429/5xx/network auto-retry, and Bearer injection.
const _inflightGets = new Map();

const _IDEMPOTENT_POST_PATHS = [
  '/api/rave/social/guest',
  '/api/rave/social/presence',
  '/api/rave/server-health',
  '/api/rave/analytics',
];

function _getAuthToken() {
  try {
    const v2Raw = localStorage.getItem('vortex_profile_v2');
    if (v2Raw !== null) {
      const p2 = JSON.parse(v2Raw);
      if (p2) {
        if (!p2.isGuest && p2.authToken) return String(p2.authToken);
        if (p2.isGuest && p2.guestToken) return String(p2.guestToken);
      }
    }
    const tmpGuestRaw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('vortex_temp_guest_v1') : null;
    if (tmpGuestRaw) {
      const gp = JSON.parse(tmpGuestRaw);
      if (gp && gp.isGuest && gp.guestToken) return String(gp.guestToken);
    }
    for (const k of ['vortex_profile_v1', 'vortex_self']) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const p = JSON.parse(raw);
      if (p && p.authToken && !p.isGuest) return String(p.authToken);
    }
  } catch (_) {}
  return '';
}

function _isSameOriginPath(path) {
  const s = String(path || '');
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  if (typeof window !== 'undefined' && window.location?.origin && s.startsWith(`${window.location.origin}/`)) return true;
  return false;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _execApi(path, { method = 'GET', body, headers: extraHeaders, timeout = 14000, signal: extSignal } = {}) {
  const normMethod = String(method || 'GET').toUpperCase();
  const pathStr = String(path || '');
  const isPollSync = pathStr.includes('/sync');
  const isSafeIdempotentPost = normMethod === 'POST' && _IDEMPOTENT_POST_PATHS.some((p) => pathStr.startsWith(p));
  const canRetry = !isPollSync && (normMethod === 'GET' || normMethod === 'HEAD' || isSafeIdempotentPost);
  const maxRetries = canRetry ? 2 : 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onExtAbort = () => ctl.abort();
    if (extSignal) {
      if (extSignal.aborted) ctl.abort();
      else extSignal.addEventListener('abort', onExtAbort, { once: true });
    }
    try {
      const hdrs = { ...(extraHeaders || {}) };
      if (body) hdrs['Content-Type'] = 'application/json';
      const tok = _isSameOriginPath(path) ? _getAuthToken() : '';
      if (tok && !hdrs.Authorization && !hdrs.authorization) {
        hdrs.Authorization = `Bearer ${tok}`;
      }
      const res = await fetch(path, {
        method: normMethod,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: Object.keys(hdrs).length ? hdrs : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const retryHdr = Number(res.headers?.get?.('retry-after') || data?.retryAfter || 0);
        const isGateway5xx = res.status === 502 || res.status === 503 || res.status === 504 || res.status === 530;
        const isTransientGateway = isGateway5xx || (res.status === 429 && (!data?.error || Boolean(data?.retryable) || /^HTTP\s*429\b/i.test(String(data.error))));
        if (canRetry && isTransientGateway && attempt < maxRetries && !extSignal?.aborted) {
          const baseWait = retryHdr > 0 ? Math.min(5000, retryHdr * 1000) : (attempt === 0 ? 550 : 1350);
          await _sleep(baseWait + Math.floor(Math.random() * 250));
          continue;
        }
        const rawErr = String(data?.error || '').trim();
        const isRaw429 = res.status === 429 && (!rawErr || /^HTTP\s*429\b/i.test(rawErr) || /^too many requests$/i.test(rawErr));
        const msg = isRaw429
          ? 'Sunucu şu an yoğun, birkaç saniye içinde otomatik yenilenecek.'
          : (rawErr || (res.status === 429
            ? 'Sunucu şu an yoğun, birkaç saniye içinde otomatik yenilenecek.'
            : `HTTP ${res.status}`));
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        if (res.status === 429) {
          err.isRateLimit = true;
          err.retryAfter = retryHdr > 0 ? retryHdr : 3;
        }
        throw err;
      }
      return data;
    } catch (fetchErr) {
      if (ctl.signal.aborted && !extSignal?.aborted) {
        if (canRetry && attempt < maxRetries && timeout <= 15000) {
          await _sleep(450);
          continue;
        }
        const tErr = new Error('Sunucu yanıt süresi aşıldı, lütfen tekrar deneyin.');
        tErr.status = 408;
        tErr.isTimeout = true;
        throw tErr;
      }
      const isRawNetErr = !fetchErr?.status && !extSignal?.aborted;
      if (isRawNetErr && canRetry && attempt < maxRetries) {
        await _sleep(attempt === 0 ? 400 : 950);
        continue;
      }
      if (isRawNetErr && /load failed|failed to fetch|networkerror|ağ bağlantısı/i.test(String(fetchErr?.message || ''))) {
        const nErr = new Error('Bağlantı yenileniyor, lütfen birkaç saniye içinde tekrar deneyin.');
        nErr.isNetworkError = true;
        throw nErr;
      }
      throw fetchErr;
    } finally {
      clearTimeout(timer);
      if (extSignal) {
        try { extSignal.removeEventListener('abort', onExtAbort); } catch (_) {}
      }
    }
  }
  throw new Error('İstek tamamlanamadı');
}

export async function api(path, opts = {}) {
  const method = String(opts?.method || 'GET').toUpperCase();
  if (method === 'GET' && !opts?.body && !opts?.signal) {
    const tok = _isSameOriginPath(path) ? _getAuthToken() : '';
    const tBucket = Math.round(Number(opts?.timeout || 14000) / 1000);
    const dedupKey = `${path}|${tok.slice(-16)}|${tBucket}`;
    const existing = _inflightGets.get(dedupKey);
    if (existing) return existing;
    const p = _execApi(path, { ...opts, method }).finally(() => {
      _inflightGets.delete(dedupKey);
    });
    _inflightGets.set(dedupKey, p);
    return p;
  }
  return _execApi(path, { ...opts, method });
}

export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
