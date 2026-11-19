// HTTP API helpers with explicit timeouts and automatic Bearer token injection.
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

export function getEdgeToken() {
  try {
    if (typeof document !== 'undefined') {
      const m = document.querySelector('meta[name="wl-edge-token"]');
      const v = m ? String(m.getAttribute('content') || '').trim() : '';
      if (v) return v;
    }
  } catch (_) {}
  return '';
}

export function setEdgeToken(token) {
  const clean = String(token || '').trim();
  if (!clean || typeof document === 'undefined') return '';
  try {
    let m = document.querySelector('meta[name="wl-edge-token"]');
    if (!m && document.head) {
      m = document.createElement('meta');
      m.setAttribute('name', 'wl-edge-token');
      document.head.appendChild(m);
    }
    if (m) m.setAttribute('content', clean);
  } catch (_) {}
  return clean;
}

let _edgeTokenRefreshPromise = null;
export async function refreshEdgeToken({ force = false, prevToken = '' } = {}) {
  if (!force) {
    const cur = getEdgeToken();
    if (cur && cur !== prevToken) return cur;
  }
  if (_edgeTokenRefreshPromise) return _edgeTokenRefreshPromise;
  _edgeTokenRefreshPromise = (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await fetch('/api/rave/session-token', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctl.signal,
      });
      if (!res.ok) return '';
      const data = await res.json().catch(() => null);
      if (data?.ok && typeof data.token === 'string' && data.token.trim()) {
        return setEdgeToken(data.token);
      }
    } catch (_) {
      /* ignore (e.g., Python origin without /api/rave/session-token) */
    } finally {
      clearTimeout(t);
    }
    return '';
  })().finally(() => {
    _edgeTokenRefreshPromise = null;
  });
  return _edgeTokenRefreshPromise;
}

export async function api(path, { method = 'GET', body, headers: extraHeaders, timeout = 12000, signal: extSignal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const onExtAbort = () => ctl.abort();
  if (extSignal) {
    if (extSignal.aborted) ctl.abort();
    else extSignal.addEventListener('abort', onExtAbort, { once: true });
  }
  try {
    const sameOrig = _isSameOriginPath(path);
    const tok = sameOrig ? _getAuthToken() : '';
    const bodyStr = body ? JSON.stringify(body) : undefined;
    for (let edgeAttempt = 0; edgeAttempt < 2; edgeAttempt += 1) {
      const hdrs = { ...(extraHeaders || {}) };
      if (body) hdrs['Content-Type'] = 'application/json';
      if (tok && !hdrs.Authorization && !hdrs.authorization) {
        hdrs.Authorization = `Bearer ${tok}`;
      }
      const edgeTok = sameOrig ? getEdgeToken() : '';
      const sentEdgeTok = (edgeAttempt === 1)
        ? edgeTok
        : String(hdrs['X-Watchlivo-Token'] || hdrs['x-watchlivo-token'] || edgeTok || '').trim();
      if (sameOrig && edgeTok) {
        if (edgeAttempt === 1) {
          delete hdrs['x-watchlivo-token'];
          hdrs['X-Watchlivo-Token'] = edgeTok;
        } else if (!hdrs['X-Watchlivo-Token'] && !hdrs['x-watchlivo-token']) {
          hdrs['X-Watchlivo-Token'] = edgeTok;
        }
      }
      const res = await fetch(path, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: Object.keys(hdrs).length ? hdrs : undefined,
        body: bodyStr,
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const shouldRefreshEdgeToken =
          res.status === 403 &&
          edgeAttempt === 0 &&
          sameOrig &&
          !ctl.signal.aborted &&
          !String(path || '').startsWith('/api/rave/session-token') &&
          data?.error !== 'password_required' &&
          data?.error !== 'kicked' &&
          (String(path || '').startsWith('/api/rave/') || Boolean(sentEdgeTok));
        if (shouldRefreshEdgeToken) {
          const nextTok = await refreshEdgeToken({ prevToken: sentEdgeTok });
          if (nextTok && nextTok !== sentEdgeTok) {
            continue;
          }
        }
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }
  } finally {
    clearTimeout(timer);
    if (extSignal) {
      try { extSignal.removeEventListener('abort', onExtAbort); } catch (_) {}
    }
  }
}

export function isEdgeUnavailable(errOrRes) {
  if (!errOrRes) return false;
  const status = Number(errOrRes.status || 0);
  if (status === 404 || status === 501 || status === 503) return true;
  const data = errOrRes.data && typeof errOrRes.data === 'object' ? errOrRes.data : errOrRes;
  const code = String(data?.code || '').trim().toLowerCase();
  if (code === 'origin_required' || code === 'unsupported') return true;
  const msg = String(data?.error || errOrRes.message || '').trim();
  return /^(not_found|not_implemented_on_edge|unsupported|origin_required)$/i.test(msg);
}

export function humanApiError(err, fallbackMsg = 'Bir hata oluştu, lütfen tekrar deneyin.', unavailableMsg = 'Bu özellik şu an kenar sunucuda kullanılamıyor.') {
  if (isEdgeUnavailable(err)) {
    const raw = String(err?.data?.error || '').trim();
    if (raw && !/^(not_found|not_implemented_on_edge|unsupported|origin_required)$/i.test(raw) && !/^HTTP\s+\d+$/i.test(raw)) {
      return raw;
    }
    return unavailableMsg;
  }
  if (!err?.status || err?.name === 'AbortError') {
    return 'Bağlantı hatası oluştu, internetinizi kontrol edip tekrar deneyin.';
  }
  if (Number(err.status) === 429) {
    return String(err?.data?.error || '').trim() || 'Çok fazla istek gönderildi, lütfen biraz bekleyin.';
  }
  const raw = String(err?.data?.error || err?.message || '').trim();
  if (raw && !/^(not_found|not_implemented_on_edge|unsupported|origin_required)$/i.test(raw) && !/^HTTP\s+\d+$/i.test(raw)) {
    return raw;
  }
  return fallbackMsg;
}

export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
