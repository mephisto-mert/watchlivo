// PlayerHost: chooses an adapter per media (Rave VideoPlayerFC techOrder parity) and exposes it to SyncEngine.
import { YouTubeAdapter } from './youtube.js?v=20261031_v45';
import { Html5Adapter } from './html5.js?v=20261031_v45';
import { VimeoAdapter } from './vimeo.js?v=20261031_v45';
import { EmbedAdapter } from './embed.js?v=20261031_v45';
import { WebviewAdapter } from './webview.js?v=20261031_v45';

const DRM_PROVS = new Set([
  'netflix', 'disney', 'prime', 'max', 'apple', 'mubi', 'hulu', 'paramount', 'peacock',
  'plex', 'pluto', 'exxen', 'blutv', 'gain', 'tod', 'tabii', 'tvplus', 'puhutv', 'crunchyroll', 'tubi',
]);

export function adapterFor(media) {
  if (!media) return EmbedAdapter;
  const url = String(media.url || '');
  const vid = String(media.videoId || '');
  if (window.vortexDesktop?.isElectron && DRM_PROVS.has(media.provider) && url && !/youtube\.com|youtu\.be/i.test(url)) {
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
  if (media.provider === 'vimeo') return VimeoAdapter;
  if (media.provider === 'youtube' || ((!media.provider || media.provider === 'web') && /^[A-Za-z0-9_-]{11}$/.test(vid)) || /youtube\.com|youtu\.be/i.test(url)) {
    return YouTubeAdapter;
  }
  return EmbedAdapter;
}

export const mediaKey = (m) => {
  if (!m || (!m.url && !m.videoId && !m.tmdbId && !m.imdbId && !m.id)) return '';
  const epMatch = String(m.title || '').match(/S(\d+)\s*:\s*B(\d+)|(\d+)\.\s*Sezon\s*(\d+)\.\s*Bölüm|(\d+)\.\s*Bölüm/i);
  const s = Math.max(1, Number(m.season || epMatch?.[1] || epMatch?.[3]) || 1);
  const e = Math.max(1, Number(m.episode || epMatch?.[2] || epMatch?.[4] || epMatch?.[5]) || 1);
  if (m.tmdbId) return `tmdb|${m.tmdbId}|${m.mediaType || 'movie'}|${s}|${e}`;
  if (m.imdbId) return `imdb|${m.imdbId}|${m.mediaType || 'movie'}|${s}|${e}`;
  if (m.id && /^(fhd|hfnl|dbx|dl|dp|acx|anx|trd|krm|yt|tv|radyo)-/i.test(String(m.id))) return `cat|${m.id}|${s}|${e}`;
  if (m.videoId) return `vid|${m.provider || 'ext'}|${m.videoId}|${s}|${e}`;
  const isCatalogStream = Boolean(m.seriesTitle || m.originalTitle || m.catalogProvider || String(m.url || '').includes('/api/rave/'));
  const rawTitle = String(m.seriesTitle || m.originalTitle || m.title || '').trim().toLowerCase();
  if (isCatalogStream && rawTitle && !['video', 'medya', 'stream', 'canlı yayın', 'medya yükleniyor…', 'medya seçilmedi'].includes(rawTitle)) {
    const baseTitle = rawTitle.replace(/\s+[—–-]\s*\d+\.\s*sezon.*$/i, '').trim();
    if (baseTitle && !['video', 'medya', 'stream'].includes(baseTitle)) return `title|${baseTitle}|${m.mediaType || 'movie'}|${s}|${e}`;
  }
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

  _effectiveVolume() {
    return this.ducked && localStorage.getItem('vortex_voice_duck') !== 'off'
      ? Math.max(12, Math.round(this.volume * 0.35))
      : this.volume;
  }

  async setMedia(media, startAt = 0, shouldPlay = true) {
    const key = mediaKey(media);
    const nextUrl = String(media?.url || media?.videoId || '');
    const prevResolved = Boolean(this.loadedUrl && !this.loadedUrl.startsWith('/api/rave/resolve-catalog'));
    const nextResolved = Boolean(nextUrl && !nextUrl.startsWith('/api/rave/resolve-catalog'));
    if (key && key === this.key && this.adapter && (this.loadedUrl === nextUrl || (prevResolved && nextResolved && this.requestedUrl === nextUrl))) return false;
    this.destroyAdapterOnly();
    this.key = key;
    this.loadedUrl = nextUrl;
    this.requestedUrl = nextUrl;
    this.error = null;
    this.autoplayBlocked = false;
    if (!this.userMuted) this.muted = false;
    if (!media || (!media.url && !media.videoId)) { this.onEvent('empty'); return true; }
    const Cls = adapterFor(media);
    let ad = null;
    const guard = (fn) => (...args) => { if (this.adapter === ad) fn(...args); };
    const events = {
      onReady: guard(() => this.onEvent('ready')),
      onPlay: (arg) => this.onEvent('play', arg),
      onPause: (arg) => this.onEvent('pause', arg),
      onEnded: guard(() => this.onEvent('ended')),
      onBuffering: guard((b) => this.onEvent('buffering', b)),
      onSubtitleCue: guard((txt, secTxt = '') => this.onEvent('subtitle-cue', { primary: txt || '', secondary: secTxt || '' })),
      onTracksChanged: guard(() => this.onEvent('tracks-changed')),
      onError: guard((msg) => { this.error = msg; this.onEvent('error', msg); }),
      onUnmuted: guard(() => {
        if (this.userMuted) {
          this.adapter?.setMuted?.(true);
          return;
        }
        this.autoplayBlocked = false;
        this.muted = false;
        this.onEvent('unmuted');
      }),
      onAutoplayBlocked: guard(() => {
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
      }),
    };
    ad = new Cls(this.container, events);
    this.adapter = ad;
    this.loading = true;
    this.onEvent('loading');
    try {
      await ad.load(media, startAt, shouldPlay);
      if (this.adapter !== ad) return true;
      ad.setVolume(this._effectiveVolume());
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
    this.adapter?.setVolume(this._effectiveVolume());
    if (this.volume > 0 && (this.muted || this.autoplayBlocked || this.adapter?.isMuted?.())) {
      this.userMuted = false;
      this.setMuted(false);
    }
  }

  setDucked(ducked) {
    const next = Boolean(ducked) && localStorage.getItem('vortex_voice_duck') !== 'off';
    if (this.ducked === next) return;
    this.ducked = next;
    this.adapter?.setVolume(this._effectiveVolume());
  }

  setMuted(m, explicitUser = false) {
    this.muted = Boolean(m);
    if (explicitUser) this.userMuted = this.muted;
    if (!this.muted) {
      this.userMuted = false;
      this.userUnlocked = true;
      this.autoplayBlocked = false;
      if (this.volume <= 0) this.volume = 80;
      this.adapter?.setVolume(this._effectiveVolume());
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
    this.adapter?.setVolume(this._effectiveVolume());
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
