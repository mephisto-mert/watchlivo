// HTTP API helpers with explicit timeouts and automatic Bearer token injection.
function _getAuthToken() {
  try {
    const v2Raw = localStorage.getItem('vortex_profile_v2');
    if (v2Raw !== null) {
      const p2 = JSON.parse(v2Raw);
      return (p2 && p2.authToken && !p2.isGuest) ? String(p2.authToken) : '';
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
    const tok = _isSameOriginPath(path) ? _getAuthToken() : '';
    if (tok && !hdrs.Authorization && !hdrs.authorization) {
      hdrs.Authorization = `Bearer ${tok}`;
    }
    const res = await fetch(path, {
      method,
      cache: 'no-store',
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
