// Shared WebAudio GainNode + Soft-Limiter Engine (0% - 150% real volume & boost, CORS/iOS PiP safe).

let _audioCtx = null;
const _mediaNodes = new WeakMap();
const _streamNodes = new WeakMap();

export function isIosWebKit() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isIosStandalonePwa() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!isIosWebKit() || window.isWatchlivoNativeIOS || window.webkit?.messageHandlers?.watchlivoPiP) return false;
  return Boolean(window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches);
}

export function ensureIosPlaybackAudioSession() {
  if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS) return;
  if (typeof navigator === 'undefined' || !navigator.audioSession) return;
  try {
    if (navigator.audioSession.type !== 'playback') {
      navigator.audioSession.type = 'playback';
    }
  } catch (e) { /* ignore */ }
}

export function hasWebAudioGraph(el) {
  return Boolean(el && _mediaNodes.has(el));
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
  if (typeof document !== 'undefined' && document.hidden) return _audioCtx;
  const ctx = getSharedAudioContext(true);
  if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
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
  // Preserve native iOS AVPlayer on <video> and HLS streams so Home-Screen Auto-PiP & background audio never detach.
  if (isIosWebKit()) {
    if (el.tagName === 'VIDEO') return false;
    if (opts.useNativeHls) return false;
    if (!src.startsWith('blob:') && /(\.m3u8(\?|$)|\/api\/rave\/stream(?:[-_]manifest|-proxy)?)/i.test(src)) return false;
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
  if (typeof window !== 'undefined' && window.webkit?.messageHandlers?.watchlivoVolume) return true;
  if (!el) return false;
  if (el.tagName === 'VIDEO') return true;
  if (_mediaNodes.has(el)) return true;
  return isCorsSafeMediaElement(el, opts);
}

function _attachElementGraph(el, opts = {}, initialGain = 1.0) {
  if (!el || opts.forbidWebAudio || opts.inPip) return null;
  if (isIosWebKit() && el.tagName === 'VIDEO') return null;
  const existing = _mediaNodes.get(el);
  if (existing) return existing;
  if (!isCorsSafeMediaElement(el, opts)) return null;
  const ctx = getSharedAudioContext(true);
  if (!ctx) return null;
  if ((ctx.state === 'suspended' || ctx.state === 'interrupted') && !(typeof document !== 'undefined' && document.hidden)) {
    try { ctx.resume().catch(() => {}); } catch (e) { /* ignore */ }
  }
  if (ctx.state !== 'running') return null;
  try {
    const source = ctx.createMediaElementSource(el);
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 180;
    eqLow.gain.value = 0;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, Number.isFinite(initialGain) ? initialGain : 1.0));
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.knee.value = 10;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;
    source.connect(eqLow);
    eqLow.connect(gain);
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    const entry = { ctx, source, eqLow, gain, limiter };
    _mediaNodes.set(el, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

export function setElementBassCutDb(el, db = 0) {
  const graph = el ? _mediaNodes.get(el) : null;
  if (!graph?.eqLow) return false;
  const clamped = Math.max(-18, Math.min(6, Number(db) || 0));
  try {
    if (graph.ctx.state === 'running') {
      graph.eqLow.gain.setTargetAtTime(clamped, graph.ctx.currentTime, 0.03);
    } else {
      graph.eqLow.gain.value = clamped;
    }
    return true;
  } catch (e) {
    return false;
  }
}

export function applyElementVolume(el, effectivePct, muted = false, opts = {}) {
  if (!el) return false;
  ensureIosPlaybackAudioSession();
  const rawNum = Number(effectivePct);
  const pct = Math.max(0, Math.min(100, Number.isFinite(rawNum) ? rawNum : (isIosWebKit() ? 100 : 80)));
  const isMuted = Boolean(muted || pct <= 0);
  const targetGain = isMuted ? 0 : Math.max(0, Math.min(1, pct / 100));

  if (typeof window !== 'undefined' && window.webkit?.messageHandlers?.watchlivoVolume?.postMessage) {
    el.muted = isMuted;
    try { window.webkit.messageHandlers.watchlivoVolume.postMessage({ volume: targetGain, muted: isMuted }); } catch (e) { /* ignore */ }
    return true;
  }

  // Keep <video> on iOS WebKit strictly on native AVPlayer (never attach createMediaElementSource).
  const wantIosAudioGraph = isIosWebKit() && el.tagName !== 'VIDEO' && !isMuted && pct > 0 && pct < 99.5 && !opts.forbidWebAudio && !opts.inPip;
  const needWebAudio = _mediaNodes.has(el) || wantIosAudioGraph || Boolean(opts.enableDjEq && !isIosWebKit());
  const graph = needWebAudio ? _attachElementGraph(el, opts, targetGain) : _mediaNodes.get(el);

  if (graph) {
    if ((graph.ctx.state === 'suspended' || graph.ctx.state === 'interrupted') && !isMuted && !(typeof document !== 'undefined' && document.hidden)) {
      graph.ctx.resume().catch(() => {});
    }
    el.muted = isMuted;
    try { el.volume = 1.0; } catch (e) { /* iOS read-only 1.0 */ }
    if (graph.ctx.state === 'running') {
      try {
        graph.gain.gain.setTargetAtTime(targetGain, graph.ctx.currentTime, 0.015);
      } catch (e) {
        graph.gain.gain.value = targetGain;
      }
    } else {
      graph.gain.gain.value = targetGain;
    }
    return true;
  }

  el.muted = isMuted;
  try {
    el.volume = targetGain;
    return !isIosWebKit() || isMuted || pct >= 99.5;
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
  if (node && node.stream !== activeStream) {
    try { node.source?.disconnect(); } catch (_) {}
    try { node.gain?.disconnect(); } catch (_) {}
    try { node.limiter?.disconnect(); } catch (_) {}
    _streamNodes.delete(audioEl);
    node = null;
  }
  if (!node) {
    const ctx = resumeSharedAudioContext();
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(activeStream);
      const gain = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2.0;
      limiter.knee.value = 8;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      source.connect(gain);
      gain.connect(limiter);
      limiter.connect(ctx.destination);
      audioEl.muted = true;
      node = { ctx, source, gain, limiter, stream: activeStream };
      _streamNodes.set(audioEl, node);
    } catch (e) {
      return;
    }
  }
  if (node) {
    if (node.ctx.state === 'suspended' || node.ctx.state === 'interrupted') {
      node.ctx.resume().catch(() => {});
    }
    node.gain.gain.value = Math.max(0, Math.min(1.5, clamped / 100));
  }
}
