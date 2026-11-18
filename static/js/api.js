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

function _getEdgeToken() {
  try {
    if (typeof document !== 'undefined') {
      const m = document.querySelector('meta[name="wl-edge-token"]');
      const v = m ? String(m.getAttribute('content') || '').trim() : '';
      if (v) return v;
    }
  } catch (_) {}
  return '';
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
    const hdrs = { ...(extraHeaders || {}) };
    if (body) hdrs['Content-Type'] = 'application/json';
    const sameOrig = _isSameOriginPath(path);
    const tok = sameOrig ? _getAuthToken() : '';
    if (tok && !hdrs.Authorization && !hdrs.authorization) {
      hdrs.Authorization = `Bearer ${tok}`;
    }
    const edgeTok = sameOrig ? _getEdgeToken() : '';
    if (edgeTok && !hdrs['X-Watchlivo-Token'] && !hdrs['x-watchlivo-token']) {
      hdrs['X-Watchlivo-Token'] = edgeTok;
    }
    const res = await fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: Object.keys(hdrs).length ? hdrs : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
    if (extSignal) {
      try { extSignal.removeEventListener('abort', onExtAbort); } catch (_) {}
    }
  }
}

export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
