<<<<<<< HEAD
// On-demand singleton loader for hls.js so initial Home route avoids downloading 135 KB GZip upfront.
const HLS_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js',
];

let _hlsLoadPromise = null;

function _loadScriptUrl(url, perTryTimeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const s = document.createElement('script');
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) {
        try { s.remove(); } catch (_) {}
      }
      resolve(Boolean(ok && window.Hls));
    };
    const timer = setTimeout(() => finish(Boolean(window.Hls)), perTryTimeoutMs);
    s.src = url;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.wlHls = '1';
    s.onload = () => finish(true);
    s.onerror = () => finish(false);
    (document.head || document.documentElement).appendChild(s);
  });
}

export function ensureHlsJs(timeoutMs = 7000) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }
  if (window.Hls) {
    return Promise.resolve(true);
  }
  if (_hlsLoadPromise) {
    return _hlsLoadPromise;
  }
  _hlsLoadPromise = (async () => {
    const existing = document.querySelector('script[data-wl-hls="1"], script[src*="hls.min.js"]');
    if (existing) {
      if (window.Hls) return true;
      const okExisting = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(Boolean(window.Hls)), 3500);
        existing.addEventListener('load', () => { clearTimeout(t); resolve(Boolean(window.Hls)); }, { once: true });
        existing.addEventListener('error', () => { clearTimeout(t); resolve(false); }, { once: true });
      });
      if (okExisting) return true;
      try { existing.remove(); } catch (_) {}
    }
    const perTry = Math.max(2500, Math.round((Number(timeoutMs) || 7000) / HLS_CDN_URLS.length));
    for (const url of HLS_CDN_URLS) {
      if (await _loadScriptUrl(url, perTry)) return true;
    }
    _hlsLoadPromise = null;
    return Boolean(window.Hls);
  })();
  return _hlsLoadPromise;
}
=======
// On-demand singleton loader for hls.js so initial Home route avoids downloading 135 KB GZip upfront.
const HLS_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js',
];

let _hlsLoadPromise = null;

function _loadScriptUrl(url, perTryTimeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const s = document.createElement('script');
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) {
        try { s.remove(); } catch (_) {}
      }
      resolve(Boolean(ok && window.Hls));
    };
    const timer = setTimeout(() => finish(Boolean(window.Hls)), perTryTimeoutMs);
    s.src = url;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.wlHls = '1';
    s.onload = () => finish(true);
    s.onerror = () => finish(false);
    (document.head || document.documentElement).appendChild(s);
  });
}

export function ensureHlsJs(timeoutMs = 8000) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }
  if (window.Hls) {
    return Promise.resolve(true);
  }
  if (_hlsLoadPromise) {
    return _hlsLoadPromise;
  }
  _hlsLoadPromise = (async () => {
    const existing = document.querySelector('script[data-wl-hls="1"], script[src*="hls.min.js"]');
    if (existing) {
      if (window.Hls) return true;
      const okExisting = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(Boolean(window.Hls)), 5000);
        existing.addEventListener('load', () => { clearTimeout(t); resolve(Boolean(window.Hls)); }, { once: true });
        existing.addEventListener('error', () => { clearTimeout(t); resolve(false); }, { once: true });
      });
      if (okExisting) return true;
      try { existing.remove(); } catch (_) {}
    }
    const perTry = Math.max(3800, Math.round((Number(timeoutMs) || 8000) / HLS_CDN_URLS.length));
    for (const url of HLS_CDN_URLS) {
      if (await _loadScriptUrl(url, perTry)) return true;
    }
    _hlsLoadPromise = null;
    return Boolean(window.Hls);
  })();
  return _hlsLoadPromise;
}
>>>>>>> fd1b292b142958c2a521d474978d23e1dd493358
