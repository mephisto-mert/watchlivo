// Shared WebAudio GainNode + Soft-Limiter Engine (0% - 150% real volume & boost, CORS/iOS safe).

let _audioCtx = null;
const _mediaNodes = new WeakMap();
const _streamNodes = new WeakMap();

export function isIosWebKit() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function getSharedAudioContext(createIfMissing = false) {
  if (_audioCtx) return _audioCtx;
  if (!createIfMissing || typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    _audioCtx = new Ctor();
  } catch (e) {
    _audioCtx = null;
  }
  return _audioCtx;
}

export function resumeSharedAudioContext() {
  const ctx = getSharedAudioContext(true);
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

export function isCorsSafeMediaElement(el, opts = {}) {
  if (!el) return false;
  if (el.srcObject) return true;
  if (opts.retriedNoCors || el._retriedNoCors) return false;
  const src = String(el.currentSrc || el.src || '').trim();
  if (!src) return Boolean(el.crossOrigin === 'anonymous' && !opts.useNativeHls);
  // WebKit Bug 180696: iOS native AVPlayer HLS outputs silence if attached to MediaElementAudioSourceNode.
  if (isIosWebKit()) {
    if (opts.useNativeHls) return false;
    if (!src.startsWith('blob:') && /\.m3u8(\?|$)/i.test(src)) return false;
  }
  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  if (typeof window !== 'undefined') {
    try {
      const u = new URL(src, window.location.origin);
      if (u.origin === window.location.origin) {
        return true;
      }
    } catch (e) { /* ignore */ }
  }
  return el.crossOrigin === 'anonymous';
}

export function canControlElementVolume(el, opts = {}) {
  if (!isIosWebKit()) return true;
  if (!el) return false;
  if (_mediaNodes.has(el)) return true;
  return isCorsSafeMediaElement(el, opts);
}

function _attachElementGraph(el, opts = {}) {
  if (!el) return null;
  const existing = _mediaNodes.get(el);
  if (existing) return existing;
  if (!isCorsSafeMediaElement(el, opts)) return null;
  const ctx = getSharedAudioContext(true);
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
    if (ctx.state !== 'running') return null;
  }
  try {
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.knee.value = 10;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    const entry = { ctx, source, gain, limiter };
    _mediaNodes.set(el, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

export function applyElementVolume(el, effectivePct, muted = false, opts = {}) {
  if (!el) return false;
  const pct = Math.max(0, Math.min(150, Number.isFinite(Number(effectivePct)) ? Number(effectivePct) : 80));
  const isMuted = Boolean(muted || pct <= 0);
  el.muted = isMuted;

  const needWebAudio = _mediaNodes.has(el) || pct > 100 || (isIosWebKit() && pct < 100 && !isMuted);
  let graph = needWebAudio ? _attachElementGraph(el, opts) : _mediaNodes.get(el);
  if (needWebAudio && !graph && isCorsSafeMediaElement(el, opts)) {
    const ctx = getSharedAudioContext(true);
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (ctx.state === 'running') applyElementVolume(el, pct, isMuted, opts);
      }).catch(() => {});
    }
  }

  if (graph && graph.ctx.state === 'running') {
    try { el.volume = 1.0; } catch (e) { /* iOS read-only 1.0 */ }
    const targetGain = isMuted ? 0 : Math.max(0, Math.min(1.6, pct / 100));
    try {
      graph.gain.gain.setTargetAtTime(targetGain, graph.ctx.currentTime, 0.015);
    } catch (e) {
      graph.gain.gain.value = targetGain;
    }
    return true;
  }

  try {
    el.volume = isMuted ? 0 : Math.max(0, Math.min(1, pct / 100));
    return !isIosWebKit();
  } catch (e) {
    return false;
  }
}

export function applyStreamBoost(audioEl, stream, pct = 100) {
  if (!audioEl) return;
  const clamped = Math.max(0, Math.min(150, Number(pct) || 0));
  if (clamped <= 100 && !_streamNodes.has(audioEl)) {
    try { audioEl.volume = Math.max(0, Math.min(1, clamped / 100)); } catch (e) { /* ignore */ }
    return;
  }
  const activeStream = stream || audioEl.srcObject;
  if (!activeStream) {
    try { audioEl.volume = Math.max(0, Math.min(1, clamped / 100)); } catch (e) { /* ignore */ }
    return;
  }
  let node = _streamNodes.get(audioEl);
  if (!node) {
    const ctx = resumeSharedAudioContext();
    if (!ctx || ctx.state !== 'running') {
      try { audioEl.volume = Math.max(0, Math.min(1, clamped / 100)); } catch (e) { /* ignore */ }
      return;
    }
    try {
      const source = ctx.createMediaStreamSource(activeStream);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      audioEl.muted = true;
      node = { ctx, source, gain };
      _streamNodes.set(audioEl, node);
    } catch (e) {
      try { audioEl.volume = Math.max(0, Math.min(1, clamped / 100)); } catch (_) {}
      return;
    }
  }
  if (node) {
    node.gain.gain.value = Math.max(0, Math.min(1.5, clamped / 100));
  }
}
