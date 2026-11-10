// Vimeo Player SDK adapter. SDK methods are async, so time is cached from timeupdate and extrapolated.
let sdkPromise = null;
function loadSdk() {
  if (window.Vimeo && window.Vimeo.Player) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://player.vimeo.com/api/player.js';
    s.onload = () => resolve();
    s.onerror = () => { sdkPromise = null; reject(new Error('Vimeo SDK yüklenemedi')); };
    document.head.append(s);
    setTimeout(() => { if (!(window.Vimeo && window.Vimeo.Player)) { sdkPromise = null; reject(new Error('Vimeo SDK zaman aşımı')); } }, 12000);
  });
  return sdkPromise;
}

export class VimeoAdapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.player = null;
    this.t = 0; this.tAt = 0; this.paused = true; this.buffering = false; this.rate = 1; this.duration = 0; this.buffered = 0; this.muted = false;
    this.caps = { seek: true, rate: true, overlayClicks: true };
  }

  async load(media, startAt = 0, autoplay = true) {
    this._destroyed = false;
    this.buffering = false;
    this.loadedAtMs = Date.now();
    this.wantPlaying = Boolean(autoplay);
    this.initialSeekPending = Number(startAt) > 0.5 ? Number(startAt) : 0;
    await loadSdk();
    if (this._destroyed) return;
    const mount = document.createElement('div');
    this.container.replaceChildren(mount);
    const id = media.videoId || (String(media.url).match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1];
    this.player = new window.Vimeo.Player(mount, { id: Number(id) || undefined, url: media.url || undefined, autoplay: false, controls: false, playsinline: true, responsive: false, width: 640 });
    const styleFrame = () => {
      const iframe = mount.querySelector('iframe');
      if (iframe) Object.assign(iframe.style, { width: '100%', height: '100%' });
    };
    styleFrame();
    const p = this.player;
    p.on('timeupdate', (d) => { this.t = d.seconds; this.tAt = performance.now(); this.duration = d.duration; });
    p.on('progress', (d) => { this.buffered = d.seconds; });
    p.on('play', () => {
      this.paused = false;
      this.buffering = false;
      this.tAt = performance.now();
      if (this.initialSeekPending > 0.5 && Math.abs((this.t || 0) - this.initialSeekPending) > 2) {
        const target = this.initialSeekPending;
        this.initialSeekPending = 0;
        p.setCurrentTime(target).catch(() => {});
      } else {
        this.initialSeekPending = 0;
      }
      this.events.onPlay?.();
    });
    p.on('pause', () => {
      this.t = this.getTime();
      this.tAt = performance.now();
      this.paused = true;
      this.buffering = false;
      this.events.onPause?.();
    });
    p.on('bufferstart', () => { this.buffering = true; this.events.onBuffering?.(true); });
    p.on('bufferend', () => { this.buffering = false; this.events.onBuffering?.(false); });
    p.on('ended', () => { this.wantPlaying = false; this.buffering = false; this.events.onEnded?.(); });
    p.on('playbackratechange', (d) => {
      this.t = this.getTime();
      this.tAt = performance.now();
      this.rate = d.playbackRate;
    });
    p.on('error', (e) => this.events.onError?.(`Vimeo: ${e?.message || 'oynatma hatası'}`));
    try {
      await p.ready();
      if (this._destroyed || this.player !== p) return;
      styleFrame();
      this.duration = await p.getDuration().catch(() => 0);
      if (startAt > 0.5) await p.setCurrentTime(startAt).catch(() => {});
      this.t = startAt; this.tAt = performance.now();
      this.events.onReady?.();
      if (autoplay && this.wantPlaying) {
        this.play();
      }
    } catch (e) {
      if (!this._destroyed) this.events.onError?.('Vimeo videosu açılamadı (gizli veya gömmeye kapalı olabilir)');
    }
  }

  play() {
    this.wantPlaying = true;
    this.player?.play().catch((err) => {
      const isAutoBlock = !err || err.name === 'NotAllowedError' || /notallowed|interact|autoplay/i.test(String(err.message || err.name || ''));
      if (isAutoBlock) {
        this.muted = true;
        this.events.onAutoplayBlocked?.();
        this.player?.setMuted(true).then(() => this.player?.play()).catch(() => {});
      }
    });
  }
  pause() { this.wantPlaying = false; this.player?.pause().catch(() => {}); }
  seek(t) { this.t = Math.max(0, t); this.tAt = performance.now(); this.player?.setCurrentTime(this.t).catch(() => {}); }
  getTime() { return this.paused ? this.t : this.t + ((performance.now() - this.tAt) / 1000) * this.rate; }
  getDuration() { return this.duration || 0; }
  getBuffered() { return this.buffered || 0; }
  isPaused() { return this.paused; }
  isBuffering() { return Boolean(this.buffering); }
  setRate(r) {
    if (Math.abs(this.rate - r) > 0.001) {
      this.t = this.getTime();
      this.tAt = performance.now();
      this.rate = r;
      this.player?.setPlaybackRate(r).catch(() => {});
    }
  }
  getRate() { return this.rate; }
  setVolume(v) { this.player?.setVolume(Math.min(1, Math.max(0, v / 100))).catch(() => {}); }
  setMuted(m) {
    this.muted = Boolean(m);
    this.player?.setMuted(this.muted).catch(() => {});
    if (!this.muted) this.events.onUnmuted?.();
  }
  isMuted() { return this.muted; }
  destroy() { this._destroyed = true; try { this.player?.destroy(); } catch (e) { /* ignore */ } this.player = null; this.container.replaceChildren(); }
}
