// On-demand singleton loader for hls.js so initial Home route avoids downloading 135 KB GZip upfront.
const HLS_CDN_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js';

let _hlsLoadPromise = null;

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
  _hlsLoadPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok) _hlsLoadPromise = null;
      resolve(Boolean(ok && window.Hls));
    };
    const timer = setTimeout(() => finish(Boolean(window.Hls)), Math.max(1000, Number(timeoutMs) || 7000));
    const existing = document.querySelector('script[data-wl-hls="1"], script[src*="hls.min.js"]');
    if (existing) {
      if (window.Hls) {
        clearTimeout(timer);
        finish(true);
        return;
      }
      existing.addEventListener('load', () => { clearTimeout(timer); finish(true); }, { once: true });
      existing.addEventListener('error', () => { clearTimeout(timer); finish(false); }, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = HLS_CDN_URL;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.wlHls = '1';
    s.onload = () => {
      clearTimeout(timer);
      finish(true);
    };
    s.onerror = () => {
      clearTimeout(timer);
      try { s.remove(); } catch (_) {}
      finish(false);
    };
    (document.head || document.documentElement).appendChild(s);
  });
  return _hlsLoadPromise;
}
