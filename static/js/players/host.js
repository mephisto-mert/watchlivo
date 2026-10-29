// PlayerHost: chooses an adapter per media (Rave VideoPlayerFC techOrder parity) and exposes it to SyncEngine.
import { YouTubeAdapter } from './youtube.js?v=20261029_v8';
import { Html5Adapter } from './html5.js?v=20261029_v8';
import { VimeoAdapter } from './vimeo.js?v=20261029_v8';
import { EmbedAdapter } from './embed.js?v=20261029_v8';
import { WebviewAdapter } from './webview.js?v=20261029_v8';

const DRM_PROVS = new Set([
  'netflix', 'disney', 'prime', 'max', 'apple', 'mubi', 'hulu', 'paramount', 'peacock',
  'plex', 'pluto', 'exxen', 'blutv', 'gain', 'tod', 'tabii', 'tvplus', 'puhutv', 'crunchyroll', 'tubi',
]);

export function adapterFor(media) {
  if (!media) return EmbedAdapter;
  const url = String(media.url || '');
  const vid = String(media.videoId || '');
  if (window.vortexDesktop && DRM_PROVS.has(media.provider) && url && !/youtube\.com|youtu\.be/i.test(url)) {
    return WebviewAdapter;
  }
  if (
    !(/youtube\.com|youtu\.be/i.test(url)) && (
      ['direct', 'hls', 'upload', 'web-direct'].includes(media.provider) ||
      media.streamType === 'hls' ||
      media.streamType === 'mp4' ||
      /\.(mp4|m4v|m4a|mp3|aac|webm|m3u8|mov|ogg)(\?|$)/i.test(url) ||
      /\/proxy\?data=|\/api\/rave\/stream|\/api\/rave\/yt-music-stream|itunes\.apple\.com|scdn\.co\/mp3-preview/i.test(url)
    )
  ) {
    return Html5Adapter;
  }
  if (media.provider === 'youtube' || /^[A-Za-z0-9_-]{11}$/.test(vid) || /youtube\.com|youtu\.be/i.test(url)) {
    return YouTubeAdapter;
  }
  if (media.provider === 'vimeo') return VimeoAdapter;
  return EmbedAdapter;
}

export const mediaKey = (m) => {
  if (!m) return '';
  const s = Math.max(1, Number(m.season) || 1);
  const e = Math.max(1, Number(m.episode) || 1);
  if (m.tmdbId) return `tmdb|${m.tmdbId}|${m.mediaType || 'movie'}|${s}|${e}`;
  return `${m.provider}|${m.videoId || ''}|${m.url || ''}|${s}|${e}`;
};

export class PlayerHost {
  constructor(container, { onEvent } = {}) {
    this.container = container;
    this.onEvent = onEvent || (() => {});
    if (typeof window !== 'undefined') window.__kinoxHost = this;
    this.adapter = null;
    this.key = '';
    const savedVol = Number(localStorage.getItem('vortex_volume'));
    this.volume = Number.isFinite(savedVol) && savedVol > 0 ? Math.min(100, savedVol) : 80;
    this.muted = false;
    this.userMuted = false;
    this.loading = false;
    this.error = null;
    this.autoplayBlocked = false;
    this.userUnlocked = false;
    this._gestureHandler = () => {
      if (!this.userMuted && (this.autoplayBlocked || this.muted || this.adapter?.isMuted?.())) {
        this.unlockAudio();
      }
    };
    if (typeof window !== 'undefined') {
      ['pointerdown', 'touchstart', 'keydown', 'click'].forEach((ev) => {
        window.addEventListener(ev, this._gestureHandler, { capture: true, passive: true });
      });
    }
  }

  isMuted() {
    return Boolean(this.muted || this.autoplayBlocked || this.adapter?.isMuted?.() || this.volume === 0);
  }

  async setMedia(media, startAt = 0, shouldPlay = true) {
    const key = mediaKey(media);
    if (key === this.key && this.adapter) return false;
    this.destroyAdapterOnly();
    this.key = key;
    this.error = null;
    this.autoplayBlocked = false;
    if (!this.userMuted) this.muted = false;
    if (!media || (!media.url && !media.videoId)) { this.onEvent('empty'); return true; }
    const Cls = adapterFor(media);
    const events = {
      onReady: () => this.onEvent('ready'),
      onPlay: () => this.onEvent('play'),
      onPause: () => this.onEvent('pause'),
      onEnded: () => this.onEvent('ended'),
      onBuffering: (b) => this.onEvent('buffering', b),
      onSubtitleCue: (txt, secTxt = '') => this.onEvent('subtitle-cue', { primary: txt || '', secondary: secTxt || '' }),
      onTracksChanged: () => this.onEvent('tracks-changed'),
      onError: (msg) => { this.error = msg; this.onEvent('error', msg); },
      onUnmuted: () => {
        this.autoplayBlocked = false;
        this.muted = false;
        this.onEvent('unmuted');
      },
      onAutoplayBlocked: () => {
        const hasActiveGesture = Boolean(navigator.userActivation?.isActive);
        if (this.userUnlocked && hasActiveGesture && !this.userMuted) {
          this.autoplayBlocked = false;
          this.muted = false;
          this.adapter?.setMuted?.(false);
          this.onEvent('unmuted');
          return;
        }
        this.autoplayBlocked = true;
        this.muted = true;
        this.onEvent('autoplay-blocked');
      },
    };
    const ad = new Cls(this.container, events);
    this.adapter = ad;
    this.loading = true;
    this.onEvent('loading');
    try {
      await ad.load(media, startAt, shouldPlay);
      if (this.adapter !== ad) return true;
      ad.setVolume(this.volume);
      if (this.userMuted) {
        ad.setMuted(true);
      } else if (ad.isMuted?.()) {
        this.autoplayBlocked = true;
        this.muted = true;
        this.onEvent('autoplay-blocked');
      }
    } catch (e) {
      if (this.adapter === ad) {
        this.error = e.message || 'Oynatıcı yüklenemedi';
        this.onEvent('error', this.error);
      }
    } finally {
      if (this.adapter === ad) {
        this.loading = false;
        this.onEvent('loaded');
      }
    }
    return true;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Number(v)));
    localStorage.setItem('vortex_volume', String(this.volume));
    const effVol = this.ducked && localStorage.getItem('vortex_voice_duck') !== 'off'
      ? Math.max(12, Math.round(this.volume * 0.35))
      : this.volume;
    this.adapter?.setVolume(effVol);
    if (this.volume > 0 && (this.muted || this.autoplayBlocked || this.adapter?.isMuted?.())) {
      this.userMuted = false;
      this.setMuted(false);
    }
  }

  setDucked(ducked) {
    const next = Boolean(ducked) && localStorage.getItem('vortex_voice_duck') !== 'off';
    if (this.ducked === next) return;
    this.ducked = next;
    const effVol = this.ducked ? Math.max(12, Math.round(this.volume * 0.35)) : this.volume;
    this.adapter?.setVolume(effVol);
  }

  setMuted(m, explicitUser = false) {
    this.muted = Boolean(m);
    if (explicitUser) this.userMuted = this.muted;
    if (!this.muted) {
      this.userMuted = false;
      this.userUnlocked = true;
      this.autoplayBlocked = false;
      if (this.volume <= 0) this.volume = 80;
      this.adapter?.setVolume(this.volume);
      this.onEvent('unmuted');
    }
    this.adapter?.setMuted(this.muted);
  }

  unlockAudio() {
    this.userMuted = false;
    this.userUnlocked = true;
    this.autoplayBlocked = false;
    this.muted = false;
    if (this.volume <= 0) this.volume = 80;
    this.adapter?.setMuted(false);
    this.adapter?.setVolume(this.volume);
    if (this.adapter?.isPaused?.() && this.adapter?.wantPlaying !== false) this.adapter?.play?.();
    this.onEvent('unmuted');
  }

  destroyAdapterOnly() {
    try { this.adapter?.destroy(); } catch (e) { /* ignore */ }
    this.adapter = null;
    this.key = '';
  }

  destroy() {
    if (typeof window !== 'undefined' && this._gestureHandler) {
      ['pointerdown', 'touchstart', 'keydown', 'click'].forEach((ev) => {
        window.removeEventListener(ev, this._gestureHandler, { capture: true });
      });
    }
    this.destroyAdapterOnly();
  }
}
