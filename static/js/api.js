// HTTP API helpers with explicit timeouts and automatic Bearer token injection.
function _getAuthToken() {
  try {
    for (const k of ['vortex_profile_v2', 'vortex_profile_v1', 'vortex_self']) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const p = JSON.parse(raw);
      if (p && p.authToken && !p.isGuest) return String(p.authToken);
    }
  } catch (_) {}
  return '';
}

export async function api(path, { method = 'GET', body, headers: extraHeaders, timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const hdrs = { ...(extraHeaders || {}) };
    if (body) hdrs['Content-Type'] = 'application/json';
    const tok = _getAuthToken();
    if (tok && !hdrs.Authorization && !hdrs.authorization) {
      hdrs.Authorization = `Bearer ${tok}`;
    }
    const res = await fetch(path, {
      method,
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
  }
}

export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
