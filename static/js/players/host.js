// PlayerHost: chooses an adapter per media (Rave VideoPlayerFC techOrder parity) and exposes it to SyncEngine.
import { YouTubeAdapter } from './youtube.js?v=20261105_v117';
import { Html5Adapter } from './html5.js?v=20261105_v117';
import { VimeoAdapter } from './vimeo.js?v=20261105_v117';
import { EmbedAdapter } from './embed.js?v=20261105_v117';
import { WebviewAdapter } from './webview.js?v=20261105_v117';
import { resumeSharedAudioContext, canControlElementVolume, isIosWebKit } from './audio-gain.js?v=20261105_v117';

const DRM_PROVS = new Set([
  'netflix', 'disney', 'prime', 'max', 'apple', 'mubi', 'hulu', 'paramount', 'peacock',
  'plex', 'pluto', 'exxen', 'blutv', 'gain', 'tod', 'tabii', 'tvplus', 'puhutv', 'crunchyroll', 'tubi',
]);

export function adapterFor(media) {
  if (!media) return EmbedAdapter;
  const url = String(media.url || '');
  const vid = String(media.videoId || '');
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
  if (window.vortexDesktop?.isElectron && DRM_PROVS.has(media.provider) && url && !/youtube\.com|youtu\.be/i.test(url)) {
    return WebviewAdapter;
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
    const rawOnEvent = onEvent || (() => {});
    this.onEvent = (ev, arg) => {
      if ((ev === 'pause' || ev === 'play') && !this.adapter) return;
      rawOnEvent(ev, arg);
    };
    if (typeof window !== 'undefined') window.__kinoxHost = this;
    this.adapter = null;
    this.key = '';
    const rawVol = localStorage.getItem('vortex_volume');
    const parsedVol = (rawVol !== null && rawVol !== '') ? Number(rawVol) : NaN;
    const defaultVol = isIosWebKit() ? 100 : 80;
    let initVol = Number.isFinite(parsedVol) ? Math.max(0, Math.min(100, Math.round(parsedVol))) : defaultVol;
    if (isIosWebKit() && initVol > 0 && initVol < 100 && !window.webkit?.messageHandlers?.watchlivoVolume) {
      initVol = 100;
      try { localStorage.setItem('vortex_volume', '100'); } catch (_) {}
    }
    this.volume = initVol;
    this._lastNonZeroVol = this.volume > 0 ? this.volume : defaultVol;
    this._docPipWin = null;
    this._nativeIosPipActive = false;
    this.muted = this.volume === 0;
    this.userMuted = this.volume === 0;
    this.loading = false;
    this.error = null;
    this.autoplayBlocked = false;
    this.userUnlocked = false;
    this.voiceSpeaking = false;
    this.voiceNotePlaying = false;
    this.ducked = false;
    this.duckGain = 1.0;
    this._duckTimer = null;
    if (typeof window !== 'undefined') {
      window.vortexSetVoiceNotePlaying = (playing) => this.setVoiceNotePlaying(playing);
      window.vortexSetAutoDuck = (enabled) => this.setAutoDuckEnabled(enabled);
      window.__kinoxSyncDuckVolume = () => this._syncDuckRamp();
      window.__onWatchlivoAppState = (appState) => {
        if ((appState === 'willResignActive' || appState === 'userLeaveHint') && this.adapter && !this._nativeIosPipActive) {
          const shouldPlay = Boolean(this.adapter.wantPlaying !== false && !this.adapter.isPaused?.());
          if (shouldPlay && typeof this.adapter.enterAutoPiP === 'function') {
            this.adapter.enterAutoPiP(appState)?.catch?.(() => {});
          } else {
            this.adapter._syncNativeIosPip?.(shouldPlay);
          }
        }
      };
      window.__onWatchlivoNativePiP = (ev) => {
        if (!ev || typeof ev !== 'object') return;
        if (ev.state === 'started') {
          this._nativeIosPipActive = true;
          if (this.adapter) {
            this.adapter._suppressInlinePauseOnce = true;
            this.adapter._lastPipEnterAt = Date.now();
          }
          try { this.adapter?.video?.pause?.(); } catch (_) {}
          try {
            if (this.adapter?.player) {
              this.adapter._suppressYtPauseOnce = true;
              this.adapter.player.pauseVideo?.();
            }
          } catch (_) {}
          this.onEvent('pip-change', true);
        } else if (ev.state === 'stopped') {
          this._nativeIosPipActive = false;
          if (this.adapter) this.adapter._lastPipExitAt = Date.now();
          if (Number.isFinite(ev.time) && ev.time > 0.5) {
            try { this.adapter?.seek?.(ev.time); } catch (_) {}
          }
          if (ev.playing !== false) {
            try { this.adapter?.play?.(); } catch (_) {}
          }
          this.onEvent('pip-change', false);
        }
      };
    }
    this._gDown = null;
    this._onPointerDown = (e) => {
      this._gDown = { x: e.clientX ?? 0, y: e.clientY ?? 0, t: Date.now() };
    };
    this._gestureHandler = (e) => {
      if (e?.type === 'keydown') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = String(e.key || '').toLowerCase();
        if (k === 'm' || k === 'escape' || k === 'tab' || k === 'shift' || k === ' ' || k === 'k') return;
      } else {
        if (this._gDown && (Math.hypot((e.clientX ?? 0) - this._gDown.x, (e.clientY ?? 0) - this._gDown.y) > 14)) return;
        if (e?.target?.closest?.('#ctl-play, #ctl-center-play, #ctl-break-btn, #ctl-break-accept, #ctl-vol, #ctl-bright-btn, #ctl-pip, #ctl-fs, #ctl-cast, input[type="range"], #ctl-sliders-card, .ctl-slider-row, .vol-wrap')) return;
      }
      resumeSharedAudioContext();
      if (!this.userMuted && (this.autoplayBlocked || this.muted || this.adapter?.isMuted?.())) {
        this.unlockAudio();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this._onPointerDown, { capture: true, passive: true });
      ['click', 'keydown'].forEach((ev) => {
        window.addEventListener(ev, this._gestureHandler, { capture: true, passive: true });
      });
    }
  }

  isMuted() {
    return Boolean(this.muted || this.autoplayBlocked || this.adapter?.isMuted?.() || this.volume === 0);
  }

  isAutoDuckEnabled() {
    const v = localStorage.getItem('vortex_voice_duck');
    return v !== 'off' && v !== '0' && v !== 'false';
  }

  getVolume() {
    return this.volume;
  }

  canControlVolume() {
    if (typeof this.adapter?.canControlVolume === 'function') return Boolean(this.adapter.canControlVolume());
    if (this.adapter?.video) {
      return canControlElementVolume(this.adapter.video, {
        useNativeHls: Boolean(this.adapter.useNativeHls),
        retriedNoCors: Boolean(this.adapter.video._retriedNoCors),
      });
    }
    if (this.adapter?.audioEl) return canControlElementVolume(this.adapter.audioEl);
    return true;
  }

  _effectiveVolume() {
    const rawNum = Number(this.volume);
    const base = Math.max(0, Math.min(100, Number.isFinite(rawNum) ? rawNum : 0));
    if (base === 0) return 0;
    if (!this.isAutoDuckEnabled()) return base;
    const g = Number.isFinite(this.duckGain) ? this.duckGain : 1.0;
    return g < 0.995 ? Math.min(base, Math.max(8, Math.round(base * g))) : base;
  }

  _syncDuckRamp() {
    if (isIosWebKit() && !window.webkit?.messageHandlers?.watchlivoVolume && this.adapter?.video) {
      this.ducked = false;
      this.duckGain = 1.0;
      clearInterval(this._duckTimer);
      this._duckTimer = null;
      return;
    }
    const wantDuck = this.isAutoDuckEnabled() && Boolean(this.voiceSpeaking || this.voiceNotePlaying);
    this.ducked = wantDuck;
    const target = wantDuck ? 0.32 : 1.0;
    clearInterval(this._duckTimer);
    if (Math.abs(this.duckGain - target) < 0.015) {
      this.duckGain = target;
      this.adapter?.setVolume(this._effectiveVolume());
      return;
    }
    this._duckTimer = setInterval(() => {
      const curTarget = (this.isAutoDuckEnabled() && Boolean(this.voiceSpeaking || this.voiceNotePlaying)) ? 0.32 : 1.0;
      const step = curTarget < this.duckGain ? -0.14 : 0.06;
      const next = this.duckGain + step;
      if ((step < 0 && next <= curTarget) || (step > 0 && next >= curTarget)) {
        this.duckGain = curTarget;
        clearInterval(this._duckTimer);
        this._duckTimer = null;
      } else {
        this.duckGain = Number(next.toFixed(3));
      }
      this.adapter?.setVolume(this._effectiveVolume());
    }, 30);
  }

  setVoiceNotePlaying(playing) {
    const next = Boolean(playing);
    if (this.voiceNotePlaying === next) return;
    this.voiceNotePlaying = next;
    this._syncDuckRamp();
  }

  setAutoDuckEnabled(enabled) {
    try { localStorage.setItem('vortex_voice_duck', enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
    this._syncDuckRamp();
  }

  async setMedia(media, startAt = 0, shouldPlay = true) {
    const key = mediaKey(media);
    const nextUrl = String(media?.url || media?.videoId || '');
    const prevResolved = Boolean(this.loadedUrl && !this.loadedUrl.startsWith('/api/rave/resolve-catalog'));
    const nextResolved = Boolean(nextUrl && !nextUrl.startsWith('/api/rave/resolve-catalog'));
    if (!this.error && key && key === this.key && this.adapter && (this.loadedUrl === nextUrl || (prevResolved && nextResolved && this.requestedUrl === nextUrl))) {
      if (this.loading) {
        this.loading = false;
        this.onEvent('loaded');
      }
      return false;
    }
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
    let settledReady = false;
    const guard = (fn) => (...args) => { if (this.adapter === ad) fn(...args); };
    const events = {
      onReady: guard(() => { if (settledReady) return; settledReady = true; this.loading = false; this.onEvent('ready'); }),
      onPlay: guard((arg) => { settledReady = true; this.loading = false; this.onEvent('play', arg); }),
      onPause: (arg) => this.onEvent('pause', arg),
      onEnded: guard(() => this.onEvent('ended')),
      onBuffering: guard((b) => this.onEvent('buffering', b)),
      onSubtitleCue: guard((txt, secTxt = '') => this.onEvent('subtitle-cue', { primary: txt || '', secondary: secTxt || '' })),
      onTracksChanged: guard(() => this.onEvent('tracks-changed')),
      onPipChange: guard((active) => this.onEvent('pip-change', active)),
      onError: guard((msg) => { settledReady = true; this.loading = false; this.error = msg; this.onEvent('error', msg); }),
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
        this.autoplayBlocked = true;
        this.muted = true;
        this.userUnlocked = false;
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
        const videoReady = !ad.video || ad.video.readyState >= 2;
        if (settledReady || videoReady || this.error) {
          this.loading = false;
          this.onEvent('loaded');
        } else {
          clearTimeout(this._loadFallbackTimer);
          this._loadFallbackTimer = setTimeout(() => {
            if (this.adapter === ad && this.loading) {
              this.loading = false;
              this.onEvent('loaded');
            }
          }, 18000);
        }
      }
    }
    return true;
  }

  setVolume(v) {
    resumeSharedAudioContext();
    const rawNum = Number(v);
    this.volume = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawNum) ? rawNum : 0)));
    try { localStorage.setItem('vortex_volume', String(this.volume)); } catch (e) { /* ignore */ }
    if (this.volume === 0) {
      this.muted = true;
      this.userMuted = true;
      this.adapter?.setVolume(0);
      this.adapter?.setMuted(true);
      this.onEvent('volume', 0);
      return;
    }
    this._lastNonZeroVol = this.volume;
    const wasMuted = Boolean(this.muted || this.autoplayBlocked || this.adapter?.isMuted?.());
    if (wasMuted) {
      this.muted = false;
      this.userMuted = false;
      this.userUnlocked = true;
      this.autoplayBlocked = false;
      if (this.adapter) this.adapter.autoplayHardBlocked = false;
    }
    this.adapter?.setVolume(this._effectiveVolume());
    if (wasMuted) {
      this.adapter?.setMuted(false);
      this.onEvent('unmuted');
    }
    this.onEvent('volume', this.volume);
  }

  setDucked(ducked) {
    const next = Boolean(ducked);
    if (this.voiceSpeaking === next && this.ducked === (next && this.isAutoDuckEnabled())) return;
    this.voiceSpeaking = next;
    this._syncDuckRamp();
  }

  setMuted(m, explicitUser = false) {
    this.muted = Boolean(m);
    if (explicitUser) this.userMuted = this.muted;
    if (!this.muted) {
      this.userMuted = false;
      this.userUnlocked = true;
      this.autoplayBlocked = false;
      resumeSharedAudioContext();
      if (this.volume <= 0) this.volume = Math.min(100, this._lastNonZeroVol || 50);
      this.adapter?.setVolume(this._effectiveVolume());
      this.onEvent('unmuted');
    }
    this.adapter?.setMuted(this.muted);
  }

  unlockAudio() {
    resumeSharedAudioContext();
    this.userMuted = false;
    this.userUnlocked = true;
    this.autoplayBlocked = false;
    if (this.adapter) this.adapter.autoplayHardBlocked = false;
    this.muted = false;
    if (this.volume <= 0) this.volume = Math.min(100, this._lastNonZeroVol || 50);
    this.adapter?.setVolume(this._effectiveVolume());
    this.adapter?.setMuted(false);
    if (this.adapter?.isPaused?.() && this.adapter?.wantPlaying === true) this.adapter?.play?.();
    this.onEvent('unmuted');
  }

  isPiP() {
    return Boolean(
      this._nativeIosPipActive
      || this.adapter?.isPiP?.()
      || (this._docPipWin && !this._docPipWin.closed)
      || (typeof document !== 'undefined' && document.documentElement?.classList?.contains('is-android-pip'))
    );
  }

  canPiP() {
    if (typeof window !== 'undefined' && (window.isWatchlivoNativeIOS || window.Android?.canPiP?.() || typeof window.Android?.enterPiP === 'function')) return true;
    if (typeof this.adapter?.canPiP === 'function' && this.adapter.canPiP()) return true;
    const v = this.adapter?.video;
    if (v && (
      (typeof document !== 'undefined' && document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function')
      || typeof v.webkitSetPresentationMode === 'function'
    )) return true;
    if (typeof window !== 'undefined' && window.documentPictureInPicture?.requestWindow && this.adapter) return true;
    return false;
  }

  async togglePiP() {
    if (this._nativeIosPipActive && typeof window !== 'undefined' && typeof window.watchlivoNativePiP === 'function') {
      this._nativeIosPipActive = false;
      window.watchlivoNativePiP('stop', {});
      this.onEvent('pip-change', false);
      return 'exited';
    }
    if (this._docPipWin && !this._docPipWin.closed) {
      try { this._docPipWin.close(); } catch (e) { /* ignore */ }
      this._docPipWin = null;
      this.onEvent('pip-change', false);
      return 'exited';
    }
    if (typeof this.adapter?.togglePiP === 'function') {
      const p = this.adapter.togglePiP();
      const res = await p;
      if (res) return res;
    }
    if (typeof window !== 'undefined' && typeof window.Android?.enterPiP === 'function') {
      const v = this.adapter?.video;
      const ok = window.Android.enterPiP(v?.videoWidth || 16, v?.videoHeight || 9);
      if (ok !== false) {
        this.onEvent('pip-change', true);
        return 'entered';
      }
    }
    if (typeof window !== 'undefined' && window.documentPictureInPicture?.requestWindow && this.container && this.adapter) {
      try {
        const pipWin = await window.documentPictureInPicture.requestWindow({ width: 480, height: 270 });
        this._docPipWin = pipWin;
        const st = pipWin.document.createElement('style');
        st.textContent = 'html,body{margin:0;width:100%;height:100%;background:#05060b;overflow:hidden;display:flex;align-items:center;justify-content:center}#player-host,.player-host{position:relative;width:100%!important;height:100%!important}video,iframe{width:100%!important;height:100%!important;object-fit:contain;border:0}';
        pipWin.document.head.appendChild(st);
        const parent = this.container.parentElement;
        const nextSib = this.container.nextSibling;
        pipWin.document.body.appendChild(this.container);
        this.adapter?.video?.play?.().catch?.(() => {});
        this.onEvent('pip-change', true);
        pipWin.addEventListener('pagehide', () => {
          if (parent && this.container.ownerDocument !== document) {
            if (nextSib && nextSib.parentNode === parent) parent.insertBefore(this.container, nextSib);
            else parent.prepend(this.container);
            if (this.adapter?.wantPlaying) this.adapter?.video?.play?.().catch?.(() => {});
          }
          this._docPipWin = null;
          this.onEvent('pip-change', false);
        }, { once: true });
        return 'entered';
      } catch (e) { /* fallback handled by caller */ }
    }
    return false;
  }

  _onAndroidPipModeChange(active) {
    const isNow = Boolean(active);
    if (isNow && this.adapter?.wantPlaying && this.adapter?.video?.paused && !this.adapter.video.ended) {
      this.adapter.video.play?.().catch?.(() => {});
    }
    this.onEvent('pip-change', isNow);
  }

  async enterPiP(reason = 'mediaSession') {
    if (this.isPiP()) return 'already-pip';
    if (typeof this.adapter?.enterAutoPiP === 'function') {
      const res = await this.adapter.enterAutoPiP(reason);
      if (res) return res;
    }
    if (!this.isPiP()) return await this.togglePiP();
    return 'already-pip';
  }

  canCast() {
    return Boolean(this.adapter?.canCast?.());
  }

  async promptCast() {
    if (typeof this.adapter?.promptCast === 'function') {
      return await this.adapter.promptCast();
    }
    return false;
  }

  destroyAdapterOnly() {
    clearTimeout(this._loadFallbackTimer);
    const oldAdapter = this.adapter;
    this.adapter = null;
    this.key = '';
    try { oldAdapter?.destroy(); } catch (e) { /* ignore */ }
  }

  destroy() {
    clearInterval(this._duckTimer);
    if (this._docPipWin && !this._docPipWin.closed) {
      try { this._docPipWin.close(); } catch (e) { /* ignore */ }
      this._docPipWin = null;
    }
    if (typeof window !== 'undefined') {
      if (this._onPointerDown) window.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
      if (this._gestureHandler) {
        ['click', 'keydown'].forEach((ev) => {
          window.removeEventListener(ev, this._gestureHandler, { capture: true });
        });
      }
    }
    this.destroyAdapterOnly();
  }
}
