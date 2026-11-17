// Embed adapter for iframe-based sources (Cinema full movie/episode embeds, Twitch live/VOD, Google Drive preview).
export class EmbedAdapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.frame = null;
    this.baseTime = 0;
    this.anchorPerf = performance.now();
    this.paused = false;
    this.rate = 1;
    this.duration = 0;
    this.caps = { seek: false, rate: false, overlayClicks: false, live: false };
    this._onMsg = (ev) => this._handleMessage(ev);
  }

  buildSrc(media, startAt = 0) {
    const host = location.hostname;
    if (media.provider === 'twitch') {
      const id = media.videoId || '';
      const isVod = /^\d+$/.test(id);
      this.caps.live = !isVod;
      this.caps.seek = isVod;
      return isVod
        ? `https://player.twitch.tv/?video=v${id}&parent=${host}&autoplay=true`
        : `https://player.twitch.tv/?channel=${encodeURIComponent(id)}&parent=${host}&autoplay=true&muted=false`;
    }
    if (media.provider === 'kick') {
      this.caps.live = true;
      this.caps.seek = false;
      return `https://player.kick.com/${encodeURIComponent(media.videoId || '')}?autoplay=true&muted=false`;
    }
    if (media.provider === 'dailymotion') {
      this.caps.seek = false;
      return `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(media.videoId || '')}&autoplay=1`;
    }
    if (media.provider === 'tiktok') {
      this.caps.seek = false;
      return `https://www.tiktok.com/player/v1/${encodeURIComponent(media.videoId || '')}?autoplay=1&rel=0`;
    }
    if (media.provider === 'drive') {
      this.caps.seek = false;
      return `https://drive.google.com/file/d/${encodeURIComponent(media.videoId)}/preview`;
    }
    let u = media.embedUrl || media.url || '';
    if (startAt > 5 && /vidlink\.pro/i.test(u) && !u.includes('startAt=')) {
      u += `${u.includes('?') ? '&' : '?'}startAt=${Math.floor(startAt)}`;
    }
    return u;
  }

  _handleMessage(ev) {
    const d = ev?.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'PLAYER_EVENT' && d.data) {
      if (typeof d.data.currentTime === 'number') { this.baseTime = d.data.currentTime; this.anchorPerf = performance.now(); }
      if (typeof d.data.duration === 'number' && d.data.duration > 0) this.duration = d.data.duration;
      if (d.data.event === 'play') { this.paused = false; this.anchorPerf = performance.now(); this.events.onPlay?.(); }
      if (d.data.event === 'pause') { this.baseTime = this.getTime(); this.paused = true; this.events.onPause?.(); }
      if (d.data.event === 'ended') this.events.onEnded?.();
    }
  }

  async load(media, startAt = 0, shouldPlay = true) {
    this.baseTime = Math.max(0, Number(startAt) || 0);
    this.anchorPerf = performance.now();
    this.paused = !shouldPlay;
    this.duration = Number(media.duration) || (media.mediaType === 'tv' ? 2700 : 7200);
    const src = this.buildSrc(media, this.baseTime);
    const f = document.createElement('iframe');
    f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    f.allowFullscreen = true;
    f.referrerPolicy = 'origin';
    // Not: Gömülü oynatıcılar (vidlink, vidsrc…) "sandbox" özniteliğini algılayıp "Disable sandbox" hatası verir; bu yüzden sandbox kullanılmıyor.
    f.removeAttribute('sandbox');
    f.src = src;
    this.frame = f;
    window.addEventListener('message', this._onMsg);
    this.container.replaceChildren(f);
    const alts = (media.altUrls || []).filter((u) => /^https?:/i.test(String(u || '')));
    if (alts.length) {
      let idx = 0;
      const allSrcs = [src, ...alts];
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.textContent = '🔄 Kaynak Değiştir';
      sw.style.cssText = 'position:absolute;left:12px;bottom:52px;z-index:8;padding:5px 11px;border-radius:99px;font-size:12px;font-weight:700;background:rgba(8,9,14,.82);color:#fff;border:1px solid rgba(255,255,255,.22);cursor:pointer;backdrop-filter:blur(8px);';
      sw.onclick = (e) => {
        e.stopPropagation();
        idx = (idx + 1) % allSrcs.length;
        f.src = allSrcs[idx];
        sw.textContent = `🔄 Kaynak ${idx + 1}/${allSrcs.length}`;
      };
      this.container.appendChild(sw);
    }
    await new Promise((resolve) => { f.onload = resolve; setTimeout(resolve, 1800); });
    this.events.onBuffering?.(false);
    this.events.onReady?.();
    if (shouldPlay) this.events.onPlay?.();
  }

  _post(cmd) { try { this.frame?.contentWindow?.postMessage(cmd, '*'); } catch (e) { /* ignore */ } }
  play() { if (this.paused) { this.anchorPerf = performance.now(); this.paused = false; } this._post({ command: 'play' }); }
  pause() { if (!this.paused) { this.baseTime = this.getTime(); this.paused = true; } this._post({ command: 'pause' }); }
  seek(t) { this.baseTime = Math.max(0, Number(t) || 0); this.anchorPerf = performance.now(); this._post({ command: 'seek', time: this.baseTime }); }
  getTime() { return this.paused ? this.baseTime : this.baseTime + ((performance.now() - this.anchorPerf) / 1000) * this.rate; }
  getDuration() { return this.duration; }
  getBuffered() { return Math.min(this.duration, this.getTime() + 60); }
  isPaused() { return this.paused; }
  isBuffering() { return false; }
  setRate(r) { this.baseTime = this.getTime(); this.anchorPerf = performance.now(); this.rate = Number(r) || 1; }
  getRate() { return this.rate; }
  setVolume() {}
  setMuted() {}
  isMuted() { return false; }
  destroy() { window.removeEventListener('message', this._onMsg); this.container.replaceChildren(); this.frame = null; }
}
