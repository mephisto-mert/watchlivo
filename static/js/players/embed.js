// Embed adapter for iframe-based sources (Cinema full movie/episode embeds, Twitch live/VOD, Google Drive preview).
const _TRUSTED_EMBED_DOMAINS = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'dai.ly',
  'twitch.tv', 'kick.com', 'tiktok.com', 'drive.google.com', 'docs.google.com', 'archive.org', 'ok.ru', 'vk.com', 'vkvideo.ru',
  'rutube.ru', 'sibnet.ru', 'streamtape.com', 'voe.sx', 'vidlink.pro', 'flixer.su', 'cinejoy.pk', 'vidy.st', 'molystream.org',
];
const _TRUSTED_EMBED_PREFIX_RE = /(?:^|\.)(?:vidsrc|2embed|multiembed|autoembed|smashystream|vidmoly|fastplay|tau-video|dood|filemoon|pilavyer|hdfilmcehennemi|fullhdfilmizlesene|rapidvid)\.[a-z0-9-]+$/i;

export function isTrustedEmbedUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (_TRUSTED_EMBED_DOMAINS.some((d) => h === d || h.endsWith('.' + d))) return true;
    return _TRUSTED_EMBED_PREFIX_RE.test(h);
  } catch (_) {
    return false;
  }
}

const _isTrustedEmbedUrl = isTrustedEmbedUrl;

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
    this._destroyed = false;
    this.caps = { seek: false, rate: false, overlayClicks: false, live: false };
    this._onMsg = (ev) => this._handleMessage(ev);
  }

  buildSrc(media, startAt = 0) {
    const host = location.hostname;
    if (media.provider === 'twitch') {
      const id = String(media.videoId || '').trim();
      if (!/^[A-Za-z0-9_]{1,64}$/.test(id)) return 'about:blank';
      const isVod = /^\d+$/.test(id);
      this.caps.live = !isVod;
      this.caps.seek = isVod;
      return isVod
        ? `https://player.twitch.tv/?video=v${id}&parent=${encodeURIComponent(host)}&autoplay=true`
        : `https://player.twitch.tv/?channel=${encodeURIComponent(id)}&parent=${encodeURIComponent(host)}&autoplay=true&muted=false`;
    }
    if (media.provider === 'kick') {
      const id = String(media.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return 'about:blank';
      this.caps.live = true;
      this.caps.seek = false;
      return `https://player.kick.com/${encodeURIComponent(id)}?autoplay=true&muted=false`;
    }
    if (media.provider === 'dailymotion') {
      const id = String(media.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return 'about:blank';
      this.caps.seek = false;
      return `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(id)}&autoplay=1`;
    }
    if (media.provider === 'tiktok') {
      const id = String(media.videoId || '').trim();
      if (!/^\d{5,32}$/.test(id)) return 'about:blank';
      this.caps.seek = false;
      return `https://www.tiktok.com/player/v1/${encodeURIComponent(id)}?autoplay=1&rel=0`;
    }
    if (media.provider === 'drive') {
      this.caps.seek = false;
      const fid = String(media.videoId || media.fileId || (String(media.url || '').match(/(?:\/d\/|id=)([A-Za-z0-9_-]{15,})/) || [])[1] || '').trim();
      if (/^[A-Za-z0-9_-]{10,120}$/.test(fid)) {
        return `https://drive.google.com/file/d/${encodeURIComponent(fid)}/preview`;
      }
      const fallbackDrive = media.embedUrl || media.url || '';
      return _isTrustedEmbedUrl(fallbackDrive) ? fallbackDrive : 'about:blank';
    }
    let u = media.embedUrl || media.url || '';
    if (startAt > 5 && /vidlink\.pro/i.test(u) && !u.includes('startAt=')) {
      u += `${u.includes('?') ? '&' : '?'}startAt=${Math.floor(startAt)}`;
    }
    return _isTrustedEmbedUrl(u) ? u : 'about:blank';
  }

  _handleMessage(ev) {
    if (this.frame && ev?.source && ev.source !== this.frame.contentWindow) return;
    if (this._expectedOrigin && ev?.origin && ev.origin !== 'null' && ev.origin !== this._expectedOrigin) return;
    const d = ev?.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'PLAYER_EVENT' && d.data) {
      if (typeof d.data.currentTime === 'number') { this.baseTime = d.data.currentTime; this.anchorPerf = performance.now(); }
      if (typeof d.data.duration === 'number' && d.data.duration > 0) this.duration = d.data.duration;
      if (d.data.event === 'play') { this.paused = false; this.anchorPerf = performance.now(); this.events.onPlay?.(); }
      if (d.data.event === 'pause') { this.baseTime = this.getTime(); this.paused = true; this.events.onPause?.(); }
      if (d.data.event === 'ended') { this.paused = true; this.events.onEnded?.(); }
    }
  }

  async load(media, startAt = 0, shouldPlay = true) {
    this._destroyed = false;
    this.loadedAtMs = Date.now();
    this.wantPlaying = Boolean(shouldPlay);
    this.baseTime = Math.max(0, Number(startAt) || 0);
    this.anchorPerf = performance.now();
    this.paused = !shouldPlay;
    this.duration = Number(media.duration) || (media.mediaType === 'tv' ? 2700 : 7200);
    const src = this.buildSrc(media, this.baseTime);
    try { this._expectedOrigin = src.startsWith('http') ? new URL(src).origin : ''; } catch (_) { this._expectedOrigin = ''; }
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
    const alts = (media.altUrls || []).filter((u) => _isTrustedEmbedUrl(u));
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
        this.baseTime = 0;
        this.anchorPerf = performance.now();
        const nextSrc = allSrcs[idx];
        try { this._expectedOrigin = nextSrc.startsWith('http') ? new URL(nextSrc).origin : ''; } catch (_) { this._expectedOrigin = ''; }
        f.src = nextSrc;
        sw.textContent = `🔄 Kaynak ${idx + 1}/${allSrcs.length}`;
      };
      this.container.appendChild(sw);
    }
    await new Promise((resolve) => { f.onload = resolve; setTimeout(resolve, 1800); });
    if (this._destroyed || this.frame !== f) return;
    this.events.onBuffering?.(false);
    this.events.onReady?.();
    if (shouldPlay) this.events.onPlay?.();
  }

  _post(cmd) { try { this.frame?.contentWindow?.postMessage(cmd, '*'); } catch (e) { /* ignore */ } }
  play() { this.wantPlaying = true; if (this.paused) { this.anchorPerf = performance.now(); this.paused = false; } this._post({ command: 'play' }); }
  pause() { this.wantPlaying = false; if (!this.paused) { this.baseTime = this.getTime(); this.paused = true; } this._post({ command: 'pause' }); }
  seek(t) { this.baseTime = Math.max(0, Number(t) || 0); this.anchorPerf = performance.now(); this._post({ command: 'seek', time: this.baseTime }); }
  getTime() { return this.paused ? this.baseTime : this.baseTime + ((performance.now() - this.anchorPerf) / 1000) * this.rate; }
  getDuration() { return this.duration; }
  getBuffered() { return Math.min(this.duration, this.getTime() + 60); }
  isPaused() { return this.paused; }
  isBuffering() { return false; }
  setRate(r) { this.baseTime = this.getTime(); this.anchorPerf = performance.now(); this.rate = Number(r) || 1; }
  getRate() { return this.rate; }
  setVolume(v) {
    this._volume = Math.max(0, Math.min(150, Number(v ?? 80)));
    const c100 = Math.min(100, Math.round(this._volume));
    const c01 = Math.min(1, c100 / 100);
    this._post({ command: 'volume', volume: c01, value: c100 });
    this._post({ event: 'command', func: 'setVolume', args: [c100] });
    this._post({ method: 'setVolume', value: c01 });
  }
  setMuted(m) {
    this._muted = Boolean(m);
    this._post({ command: m ? 'mute' : 'unmute', muted: this._muted });
    this._post({ event: 'command', func: m ? 'mute' : 'unMute', args: [] });
    this._post({ method: 'setMuted', value: this._muted });
  }
  isMuted() { return Boolean(this._muted); }
  destroy() { this._destroyed = true; window.removeEventListener('message', this._onMsg); this.container.replaceChildren(); this.frame = null; }
}
