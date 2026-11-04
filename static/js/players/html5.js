// HTML5 <video> adapter for direct files (.mp4/.webm), uploads and HLS (.m3u8 via hls.js / native iOS AVPlayer).
import { SubtitleDubController } from './subtitles.js?v=20261104_v94';
import { expectedPosition } from '../sync.js?v=20261104_v94';
import { state, isRoomMediaPlaying } from '../store.js?v=20261104_v94';
import { applyElementVolume, ensureIosPlaybackAudioSession, hasWebAudioGraph, isIosWebKit, resumeSharedAudioContext, setElementBassCutDb } from './audio-gain.js?v=20261104_v94';

function setReferrerMeta(policy) {
  let m = document.querySelector('meta[name="referrer"]');
  if (!m) { m = document.createElement('meta'); m.name = 'referrer'; document.head.appendChild(m); }
  m.content = policy;
}

function applyOptimalPipAttributes(v, autoPipOn = true) {
  if (!v) return;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('x-webkit-airplay', 'allow');
  v.disablePictureInPicture = false;
  try { v.removeAttribute('disablepictureinpicture'); } catch (_) {}
  try { v.disableRemotePlayback = false; } catch (_) {}
  const allowAuto = Boolean(autoPipOn);
  try {
    v.autoPictureInPicture = allowAuto;
    if (allowAuto) {
      v.setAttribute('autopictureinpicture', '');
      v.setAttribute('allowsPictureInPicture', 'true');
    } else {
      v.removeAttribute('autopictureinpicture');
      v.removeAttribute('allowsPictureInPicture');
    }
  } catch (_) {}
}

export class Html5Adapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.video = null;
    this.hls = null;
    this.waitTimer = null;
    this.resumeTimer = null;
    this.watchdogTimer = null;
    this.audioUnlocked = false;
    this.autoplayHardBlocked = false;
    this._autoResumeCount = 0;
    this._lastAutoResumeWindowAt = 0;
    this._lastPipExitAt = 0;
    this._lastVisChangeAt = 0;
    this._pipPauseTimer = null;
    this._wasInPip = false;
    this.iosPipVideo = null;
    this._iosPipActive = false;
    this._iosPipIsCanvasOnly = false;
    this._musicPipTimer = null;
    this.wantPlaying = true;
    this.bufferingReported = false;
    this.playingReported = false;
    this.readyReported = false;
    this.baseVolume = isIosWebKit() ? 100 : 80;
    this.currentUrl = '';
    this.subs = new SubtitleDubController(this);
    this.caps = { seek: true, rate: true, overlayClicks: true, subtitles: true, audioTracks: true };
  }

  async load(media, startAt = 0, autoplay = true) {
    if (this.hls) { try { this.hls.destroy(); } catch (_) {} this.hls = null; }
    if (this.mashupHlsB) { try { this.mashupHlsB.destroy(); } catch (_) {} this.mashupHlsB = null; }
    if (this.mashupDeckB) { try { this.mashupDeckB.pause(); this.mashupDeckB.removeAttribute('src'); } catch (_) {} this.mashupDeckB = null; }
    if (this.iosPipVideo) { try { this.iosPipVideo.pause(); this.iosPipVideo.remove(); } catch (_) {} this.iosPipVideo = null; this._iosPipActive = false; }
    if (media?.live) {
      startAt = 0;
      this.caps = { ...this.caps, seek: false, live: true };
    }
    setReferrerMeta('no-referrer');
    ensureIosPlaybackAudioSession();
    this.media = media || {};
    this.wantPlaying = Boolean(autoplay);
    this.autoplayHardBlocked = false;
    this._autoResumeCount = 0;
    this.bufferingReported = false;
    this.playingReported = false;
    this.readyReported = false;
    clearTimeout(this.watchdogTimer);
    const v = document.createElement('video');
    let initialAutoPip = true;
    try { initialAutoPip = localStorage.getItem('vortex_auto_pip') !== 'off'; } catch (_) {}
    applyOptimalPipAttributes(v, initialAutoPip);
    this._healthSentSet = new Set();
    v.preload = 'auto';
    v.preservesPitch = true;
    if (media?.thumbnail || media?.poster) v.poster = media.thumbnail || media.poster;
    this.video = v;
    const syncVideoCors = (targetUrl, forNativeHls = false) => {
      if ((forNativeHls || this.useNativeHls) && isIosWebKit()) {
        v.removeAttribute('crossorigin');
        v.setAttribute('x-webkit-airplay', 'allow');
        try { v.disableRemotePlayback = false; } catch (_) {}
        return;
      }
      const s = String(targetUrl || '');
      const isFirstPartyRave = s.startsWith('/api/rave/') || (typeof window !== 'undefined' && s.startsWith(`${window.location.origin}/api/rave/`));
      if (isFirstPartyRave && !v._retriedNoCors) v.crossOrigin = 'anonymous';
      else v.removeAttribute('crossorigin');
    };
    const validStart = (Number.isFinite(startAt) && startAt > 0.5) ? Number(startAt) : 0;
    this.lastSeekTarget = validStart;
    this.lastSeekAt = validStart > 0 ? Date.now() : 0;
    this.initialSeekPending = validStart;
    this.highestPlayedPos = validStart;
    this.loadedAtMs = Date.now();
    this.isMusic = Boolean(media?.isMusic);
    const isAudioOnlyUrl = (u) => /\.(m4a|mp3|aac|ogg|wav)(\?|$)/i.test(String(u || '')) || /kind=audio|audio-ssl\.itunes\.apple\.com|p\.scdn\.co\/mp3-preview|soundcloud\.cloud|sndcdn\.com/i.test(String(u || ''));
    if (this.isMusic) {
      const cover = media.poster || media.thumbnail || '/static/watchlivo-poster.svg';
      const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const platName = esc(media.musicPlatformLabel || media.channel || 'Müzik & Klip');
      const vBadge = esc(media.versionBadge || '✅ Orijinal');
      const title = esc((media.songTitle || media.title || 'Müzik').replace(/^🎵\s*/, ''));
      const artist = esc(media.artist || media.channel || 'Sanatçı');
      const vinylStage = document.createElement('div');
      vinylStage.className = 'music-vinyl-stage';
      vinylStage.style.display = 'none';
      vinylStage.innerHTML = `
        <div class="music-vinyl-bg" style="background-image:url('${esc(cover)}')"></div>
        <div class="music-vinyl-card">
          <div class="music-vinyl-disc" id="music-vinyl-disc">
            <img src="${esc(cover)}" alt="" />
            <span class="music-vinyl-hole"></span>
          </div>
          <div class="music-vinyl-meta">
            <span class="music-vinyl-badge">🎵 ${platName} · ${vBadge}</span>
            <h2 class="music-vinyl-title">${title}</h2>
            <p class="music-vinyl-artist">${artist}</p>
            <div class="music-eq-bars"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
          </div>
        </div>
      `;
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.id = 'btn-toggle-vinyl-mode';
      toggleBtn.className = 'music-mode-float-btn';
      toggleBtn.textContent = '💿 Plak Modu';
      this.vinylOverlay = vinylStage;
      this.vinylBtn = toggleBtn;
      this.vinylMode = false;
      const clipSrc = (media.mvUrl && /\.m4v(\?|$)/i.test(String(media.mvUrl))) ? media.mvUrl : '';
      const clipVid = media.clipVideoId || media.videoId || '';
      let bgMvEl = null;
      let bgYtEl = null;
      if (clipSrc) {
        bgMvEl = document.createElement('video');
        bgMvEl.className = 'music-bg-mv';
        bgMvEl.src = clipSrc;
        bgMvEl.muted = true;
        bgMvEl.loop = true;
        bgMvEl.playsInline = true;
        bgMvEl.preload = 'auto';
        bgMvEl.setAttribute('playsinline', '');
        bgMvEl.setAttribute('webkit-playsinline', '');
        bgMvEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:2;pointer-events:none;display:none;';
      } else if (clipVid && /^[A-Za-z0-9_-]{11}$/.test(clipVid)) {
        bgYtEl = document.createElement('iframe');
        bgYtEl.className = 'music-bg-mv';
        bgYtEl.allow = 'autoplay; encrypted-media';
        bgYtEl.dataset.clipSrc = `https://www.youtube.com/embed/${clipVid}?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&loop=1&playlist=${clipVid}&modestbranding=1&playsinline=1&rel=0`;
        bgYtEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:2;pointer-events:none;display:none;';
      }
      this.bgMvEl = bgMvEl;
      this.bgYtEl = bgYtEl;
      this.toggleVinylMode = (force) => {
        this.vinylMode = typeof force === 'boolean' ? force : !this.vinylMode;
        vinylStage.style.display = this.vinylMode ? 'flex' : 'none';
        if (bgMvEl) {
          bgMvEl.style.display = this.vinylMode ? 'none' : 'block';
          if (!this.vinylMode) {
            if (Math.abs((bgMvEl.currentTime || 0) - (v.currentTime || 0)) > 1.5) {
              try { bgMvEl.currentTime = v.currentTime || 0; } catch (e) { /* ignore */ }
            }
            if (!v.paused) bgMvEl.play().catch(() => {});
          } else {
            bgMvEl.pause();
          }
        } else if (bgYtEl) {
          bgYtEl.style.display = this.vinylMode ? 'none' : 'block';
          if (!this.vinylMode && !bgYtEl.src) {
            bgYtEl.src = bgYtEl.dataset.clipSrc;
          }
        }
        toggleBtn.textContent = this.vinylMode ? '🎬 Klip Modu' : '💿 Plak Modu';
        toggleBtn.classList.toggle('active', this.vinylMode);
        return this.vinylMode;
      };
      this._setMusicVisualMode = (mode) => this.toggleVinylMode(mode === 'vinyl');
      toggleBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleVinylMode();
      };
      const children = [v, bgMvEl, bgYtEl, vinylStage].filter(Boolean);
      this.container.replaceChildren(...children);
      const frameParent = this.container.parentElement || this.container;
      frameParent.querySelectorAll('#btn-toggle-vinyl-mode').forEach((b) => b.remove());
      frameParent.append(toggleBtn);
      if (media?.isRaveDJ && Array.isArray(media.mashupTracks) && media.mashupTracks.length >= 2) {
        const trB = media.mashupTracks[1];
        const bAlts = Array.isArray(trB?.altUrls) ? trB.altUrls : [];
        const bProg = bAlts.find((u) => /\.(m4a|mp3|ogg|wav)(\?|$)/i.test(String(u || '')));
        const bSrc = bProg || trB?.url || trB?.audioPreviewUrl || bAlts[0] || '';
        if (bSrc && bSrc !== media.url) {
          const deckB = document.createElement('audio');
          deckB.preload = 'auto';
          deckB.loop = true;
          deckB.volume = 0.28;
          this.mashupDeckB = deckB;
          this.container.append(deckB);
          if (/\.m3u8(\?|$)|soundcloud\.cloud|sndcdn\.com/i.test(String(bSrc)) && window.Hls && window.Hls.isSupported()) {
            try {
              const hlsB = new window.Hls({ enableWorker: true });
              this.mashupHlsB = hlsB;
              hlsB.loadSource(bSrc);
              hlsB.attachMedia(deckB);
            } catch (e) {
              deckB.src = bSrc;
            }
          } else {
            deckB.src = bSrc;
          }
          const bpmA = Math.max(70, Math.min(190, Number(media.bpmA || media.mashupTracks?.[0]?.bpm || 124)));
          const bpmB = Math.max(70, Math.min(190, Number(media.bpmB || trB?.bpm || 126)));
          const tempoRatio = Math.max(0.86, Math.min(1.16, bpmA / bpmB));
          try { deckB.preservesPitch = true; deckB.playbackRate = tempoRatio; } catch (_) {}
          const barSec = (60 / bpmA) * 4;
          const cycleSec = Math.max(16, barSec * 8);
          const syncDeckB = () => {
            if (!this.mashupDeckB || this.video !== v) return;
            const ct = Number(v.currentTime || 0);
            const xfade = 0.5 - 0.5 * Math.cos((ct / cycleSec) * Math.PI * 2);
            const gainA = Math.cos(xfade * Math.PI * 0.5);
            const gainB = Math.sin(xfade * Math.PI * 0.5);
            const rawBase = Number.isFinite(Number(this.baseVolume)) ? Number(this.baseVolume) : 80;
            const isDeckMuted = Boolean(v.muted || this.userExplicitMuted || rawBase <= 0);
            const pctA = isDeckMuted ? 0 : Math.min(100, rawBase * Math.max(0.32, gainA));
            const pctB = isDeckMuted ? 0 : Math.min(100, rawBase * Math.max(0.18, gainB * 0.92));
            if (!isIosWebKit()) {
              applyElementVolume(v, pctA, isDeckMuted, { enableDjEq: true });
              setElementBassCutDb(v, xfade > 0.55 ? -11 * ((xfade - 0.55) / 0.45) : 0);
            }
            applyElementVolume(this.mashupDeckB, pctB, isDeckMuted, { enableDjEq: true });
            setElementBassCutDb(this.mashupDeckB, xfade < 0.45 ? -12 * ((0.45 - xfade) / 0.45) : 0);
          };
          this._syncDeckBVolume = syncDeckB;
          v.addEventListener('timeupdate', syncDeckB);
          v.addEventListener('playing', () => {
            if (this.mashupDeckB && !v.paused) {
              this.mashupDeckB.muted = Boolean(v.muted);
              this.mashupDeckB.play().catch(() => {});
            }
          });
          v.addEventListener('pause', () => { this.mashupDeckB?.pause?.(); });
          v.addEventListener('seeked', () => {
            if (this.mashupDeckB && Number.isFinite(this.mashupDeckB.duration) && this.mashupDeckB.duration > 1) {
              try { this.mashupDeckB.currentTime = (v.currentTime || 0) % this.mashupDeckB.duration; } catch (e) { /* ignore */ }
            }
          });
        }
      }
    } else {
      const frameParent = this.container.parentElement || this.container;
      frameParent.querySelectorAll('#btn-toggle-vinyl-mode').forEach((b) => b.remove());
      this.container.replaceChildren(v);
    }
    const clearBuf = () => {
      clearTimeout(this.waitTimer);
      if (this.bufferingReported) {
        this.bufferingReported = false;
        this.events.onBuffering?.(false);
      }
    };
    const reportPlay = (native = false) => {
      if (!this.playingReported) {
        this.playingReported = true;
        this.events.onPlay?.(native ? { native: true } : undefined);
      }
    };
    v.addEventListener('playing', () => {
      clearBuf();
      clearTimeout(this._pipPauseTimer);
      this.autoplayHardBlocked = false;
      this._autoResumeCount = 0;
      const wasPausedWant = !this.wantPlaying;
      const roomExplicitlyPaused = Boolean(state.mesh?.media && !isRoomMediaPlaying(state.mesh.media));
      const inNativeUi = Boolean(v.webkitDisplayingFullscreen || this.isPiP() || (typeof document !== 'undefined' && document.fullscreenElement === v));
      if (!roomExplicitlyPaused || inNativeUi) {
        this.wantPlaying = true;
      }
      try {
        const autoPipOn = localStorage.getItem('vortex_auto_pip') !== 'off';
        applyOptimalPipAttributes(v, autoPipOn);
      } catch (_) {}
      this._syncAndroidPipState?.(true);
      this._syncNativeIosPip?.(true);
      if (this.bgMvEl && !this.vinylMode) {
        this.bgMvEl.play().catch(() => {});
      }
      if (!v.muted && v.volume > 0) this.events.onUnmuted?.();
      this._requestWakeLock?.();
      this._reportStreamHealth?.(this.currentUrl, true, { latencyMs: Math.max(0, Date.now() - (this.loadedAtMs || Date.now())) });
      reportPlay(wasPausedWant && inNativeUi);
    });
    const onPipChange = () => {
      const nowPip = this.isPiP();
      if (!this._wasInPip && nowPip) {
        this._lastPipEnterAt = Date.now();
      } else if (this._wasInPip && !nowPip) {
        this._lastPipExitAt = Date.now();
      }
      this._wasInPip = nowPip;
      if (nowPip) {
        this.subs?.syncNativeTrackToElement?.(v, true);
        if (this.wantPlaying && v.paused && !v.ended) {
          v.play?.().catch?.(() => {});
        }
      } else {
        this.subs?._disableAllNativeTextTracks?.();
      }
      this.events.onPipChange?.(nowPip);
    };
    v.addEventListener('enterpictureinpicture', onPipChange);
    v.addEventListener('leavepictureinpicture', onPipChange);
    v.addEventListener('webkitpresentationmodechanged', onPipChange);
    if (this._visHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visHandler);
    }
    if (this._pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._pageHideHandler);
    }
    this._visHandler = () => {
      if (this._destroyed || this.video !== v) return;
      this._lastVisChangeAt = Date.now();
      if (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive) return;
      const av = this._activeMediaEl();
      if (document.visibilityState === 'visible') {
        if (this.wantPlaying && !this.hasEnded && !this.autoplayHardBlocked && !this.isPiP()) {
          this._autoResumeCount = 0;
          this._requestWakeLock?.();
          if (av && av.paused && !av.ended) this.tryPlay();
        }
      } else if (document.visibilityState === 'hidden' && this.wantPlaying && !this.hasEnded) {
        if (av && av.paused && !av.ended) {
          av.play?.().catch(() => {});
        }
        this.enterAutoPiP?.('visibilitychange')?.catch?.(() => {});
      }
    };
    this._pageHideHandler = () => {
      if (this._destroyed || this.video !== v) return;
      if (this.wantPlaying && !this.hasEnded) {
        this.enterAutoPiP?.('pagehide')?.catch?.(() => {});
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._visHandler);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this._pageHideHandler);
    }
    v.addEventListener('noop', () => {
    });
    const reportReadyOnce = () => {
      clearBuf();
      if (!this.readyReported) {
        this.readyReported = true;
        this.events.onReady?.();
      }
    };
    v.addEventListener('volumechange', () => { if (!v.paused && !v.muted && v.volume > 0) { this.audioUnlocked = true; this.events.onUnmuted?.(); } });
    v.addEventListener('loadeddata', () => { if (v.readyState >= 2) reportReadyOnce(); });
    v.addEventListener('canplay', reportReadyOnce);
    v.addEventListener('canplaythrough', reportReadyOnce);
    v.addEventListener('seeking', () => {
      this.subs?.clearActiveCue?.();
    });
    v.addEventListener('seeked', () => {
      if (this.initialSeekPending && v.currentTime >= Math.max(0.5, this.initialSeekPending - 2.5)) {
        this.initialSeekPending = 0;
      }
      this.lastSeekAt = 0;
      clearBuf();
      if (this.bgMvEl) {
        try { this.bgMvEl.currentTime = v.currentTime || 0; } catch (e) { /* ignore */ }
      }
      this.subs.stopDubAudio();
      this.subs?.clearActiveCue?.();
      this.subs.onTimeUpdate(v.currentTime, true);
      // Sarma sonrasında yalnızca ses kanalı atanmamışsa kontrol et (çalışan ses tamponunu ve senkronu koru).
      if (this.hls && (typeof this.hls.audioTrack !== 'number' || this.hls.audioTrack < 0)) {
        try {
          this.subs._applyHlsAudioSelection();
        } catch (err) { /* ignore */ }
      }
      [250, 900].forEach((ms) => setTimeout(() => {
        if (this.video === v && !v.seeking) this.subs.onTimeUpdate(v.currentTime, true);
      }, ms));
      if (this.wantPlaying && v.paused && !v.ended) {
        this.tryPlay();
      } else if (!v.paused) {
        this._syncNativeIosPip?.(true);
      }
    });
    v.addEventListener('ratechange', () => {
      if (this.video === v && !v.paused) {
        this._syncNativeIosPip?.(true);
      }
    });
    v.addEventListener('timeupdate', () => {
      if (this.initialSeekPending && v.currentTime >= Math.max(0.5, this.initialSeekPending - 2.5) && v.readyState >= 2) {
        this.initialSeekPending = 0;
      }
      if (!v.paused && !v.seeking && v.readyState >= 2) {
        clearBuf();
        if (v.currentTime > 2) {
          this.highestPlayedPos = Math.max(this.highestPlayedPos || 0, v.currentTime);
        }
      }
      if (v.currentTime > 0 && !v.paused && v.readyState >= 2 && (v.videoWidth > 0 || this.isMusic)) reportPlay();
      if (!v.paused && Date.now() - (this._lastNativeIosSyncAt || 0) > 25000) {
        this._syncNativeIosPip?.(true);
      }
      if (typeof document !== 'undefined' && document.hidden && typeof window !== 'undefined') {
        window.__watchlivoBgSyncTick?.();
      }
      if (v.seeking) return;
      if (v.readyState >= 2 && (v.videoWidth > 0 || this.isMusic)) {
        this.subs.onTimeUpdate(v.currentTime);
      } else {
        this.subs?.clearActiveCue?.();
      }
    });
    clearInterval(this.subTickTimer);
    this.subTickTimer = setInterval(() => {
      if (this._destroyed || !this.video || this.video.paused || this.video.seeking) return;
      if (this.video.readyState < 2 || (!this.isMusic && this.video.videoWidth === 0)) {
        this.subs?.clearActiveCue?.();
        return;
      }
      if (this.subs && this.subs.selectedSubId !== 'off' && this.subs.subCues?.length) {
        this.subs.onTimeUpdate(this.video.currentTime);
      }
    }, 100);
    this.hasEnded = false;
    const fireEndedOnce = () => {
      if (this.hasEnded) return;
      this.hasEnded = true;
      this.wantPlaying = false;
      clearTimeout(this.resumeTimer);
      clearTimeout(this.watchdogTimer);
      try { this.bgMvEl?.pause(); } catch (e) { /* ignore */ }
      this.subs.stopDubAudio();
      this.events.onEnded?.();
    };
    v.addEventListener('webkitbeginfullscreen', () => {
      this._lastFsChangeAt = Date.now();
      this._lastFsEnterAt = Date.now();
    });
    v.addEventListener('webkitendfullscreen', () => {
      this._lastFsChangeAt = Date.now();
      this._lastFsExitAt = Date.now();
    });
    v.addEventListener('pause', () => {
      if (this._destroyed || this.video !== v) return;
      if (this._suppressInlinePauseOnce || (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive) || this._iosPipActive) {
        this._suppressInlinePauseOnce = false;
        return;
      }
      this.playingReported = false;
      this.subs.stopDubAudio();
      try { this.bgMvEl?.pause(); } catch (e) { /* ignore */ }
      const dur = Number(v.duration || 0);
      if (v.ended || (Number.isFinite(dur) && dur > 20 && v.currentTime >= dur - 0.45)) {
        fireEndedOnce();
        return;
      }
      if (!this.isPiP() && !this.wantPlaying) {
        try { window.Android?.setVideoPlaying?.(false, v.videoWidth || 16, v.videoHeight || 9); } catch (_) {}
        this._syncNativeIosPip?.(false);
      }
      const recentSeek = Boolean(this.lastSeekAt && Date.now() - this.lastSeekAt < 2500);
      const exitingWebkitFs = Boolean(this._lastFsExitAt && Date.now() - this._lastFsExitAt < 1200);
      const exitingPipNow = Boolean(this._lastPipExitAt && Date.now() - this._lastPipExitAt < 1200);
      const enteringPipNow = Boolean(this._lastPipEnterAt && Date.now() - this._lastPipEnterAt < 1500);
      const visJustChanged = Boolean(this._lastVisChangeAt && Date.now() - this._lastVisChangeAt < 1500);
      const inNativePlayerUi = Boolean(
        v.webkitDisplayingFullscreen
        || this.isPiP()
        || (typeof document !== 'undefined' && (document.fullscreenElement === v || document.webkitFullscreenElement === v))
      );
      if ((enteringPipNow || visJustChanged) && this.wantPlaying && (this.isPiP() || isIosWebKit())) {
        setTimeout(() => {
          const av = this._activeMediaEl();
          if (this.video === v && this.wantPlaying && av && av.paused && !av.ended && (this.isPiP() || document.visibilityState === 'visible')) {
            av.play?.().catch?.(() => {});
          }
        }, 180);
        return;
      }
      if (inNativePlayerUi && !exitingWebkitFs && !exitingPipNow && !visJustChanged && !v.seeking && !recentSeek && v.readyState >= 2) {
        clearTimeout(this._pipPauseTimer);
        this._pipPauseTimer = setTimeout(() => {
          if (this._destroyed || this.video !== v || !v.paused || v.ended || v.seeking) return;
          const leftPip = Boolean(this._lastPipExitAt && Date.now() - this._lastPipExitAt < 1400);
          const leftFs = Boolean(this._lastFsExitAt && Date.now() - this._lastFsExitAt < 1400);
          const enteredPip = Boolean(this._lastPipEnterAt && Date.now() - this._lastPipEnterAt < 1600);
          const visFlip = Boolean(this._lastVisChangeAt && Date.now() - this._lastVisChangeAt < 1600);
          const stillNativeUi = Boolean(
            v.webkitDisplayingFullscreen
            || this.isPiP()
            || (typeof document !== 'undefined' && (document.fullscreenElement === v || document.webkitFullscreenElement === v))
          );
          if (leftPip || leftFs || enteredPip || visFlip || !stillNativeUi) {
            if (this.wantPlaying && !this.autoplayHardBlocked) {
              const av = this._activeMediaEl();
              if (this.isPiP() && av) av.play?.().catch?.(() => {});
              else if (typeof document === 'undefined' || document.visibilityState === 'visible') this.tryPlay();
            }
            return;
          }
          this.wantPlaying = false;
          clearTimeout(this.resumeTimer);
          this._syncNativeIosPip?.(false);
          this.events.onPause?.({ userFullscreenPause: true });
        }, 650);
        return;
      }
      if (this.wantPlaying && !this.hasEnded && !v.ended) {
        clearTimeout(this.resumeTimer);
        const isHiddenNonPip = typeof document !== 'undefined' && document.visibilityState === 'hidden' && !this.isPiP() && !this.isMusic;
        if (isHiddenNonPip || this.autoplayHardBlocked) return;
        const nowMs = Date.now();
        if (nowMs - (this._lastAutoResumeWindowAt || 0) > 4500) {
          this._autoResumeCount = 0;
          this._lastAutoResumeWindowAt = nowMs;
        }
        if (this._autoResumeCount >= 2 && !v.seeking && !recentSeek) {
          this.events.onPause?.();
          return;
        }
        this._autoResumeCount += 1;
        const delayMs = (v.seeking || recentSeek || v.readyState < 3) ? 380 : (this._autoResumeCount > 1 ? 720 : 240);
        this.resumeTimer = setTimeout(() => {
          if (this.video === v && this.wantPlaying && !this.hasEnded && !this.autoplayHardBlocked && v.paused && !v.ended && !v.seeking) {
            this.tryPlay();
          }
        }, delayMs);
        return;
      }
      this.events.onPause?.();
    });
    v.addEventListener('waiting', () => {
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        if (this.video && !this.video.paused && this.video.readyState < 2 && !this.bufferingReported) {
          this.bufferingReported = true;
          this.events.onBuffering?.(true);
        }
      }, 1300);
    });
    v.addEventListener('ended', fireEndedOnce);
    const is30sPreviewUrl = (u) => /AudioPreview|Video211|mzaf_|mzvf_|p\.scdn\.co\/mp3-preview/i.test(String(u || ''));
    const isDrmUrl = (u) => /\/(?:cbcs|cenc)\//i.test(String(u || ''));
    const isHevcUrl = (u) => /\/resource\/h265\/|[._-]h265[._-]|[._-]hevc[._-]/i.test(String(u || ''));
    const isDemoTestUrl = (u) => /unified-streaming\.com|tears-of-steel|test-streams\.mux\.dev|shaka-demo-assets|angel-one|aHR0cHM6Ly9kZW1vLnVuaWZpZWQtc3RyZWFtaW5n|aHR0cHM6Ly90ZXN0LXN0cmVhbXMubXV4|aHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL3NoYWth/i.test(String(u || ''));
    this.subs._loadMediaSyncPrefs?.(media);
    const prefAudio = (!this.isMusic && Array.isArray(media.audioTracks))
      ? media.audioTracks.find((t) => t.mode === 'stream' && (t.audioLang || t.targetLang || t.lang) && (t.id === this.subs.selectedAudioId || t.targetLang === this.subs.selectedAudioId || t.lang === this.subs.selectedAudioId || t.audioLang === this.subs.selectedAudioId) && t.url && !isDemoTestUrl(t.url))
      : null;
    const seenUrls = new Set();
    const alts = [];
    const primaryIsPlayableFull = Boolean(media.url && !is30sPreviewUrl(media.url) && !isDrmUrl(media.url));
    const normDedupeKey = (u) => {
      const raw = String(u || '').trim();
      if (!raw) return '';
      const mSid = raw.match(/[?&]sid=([^&#]+)/);
      if (mSid && (raw.includes('/api/rave/stream') || raw.includes('/api/rave/stream_manifest') || raw.includes('/api/rave/stream_chunk'))) {
        const mAud = raw.match(/[?&]aud=([^&#]+)/);
        return `sid:${mSid[1]}${mAud ? `:aud:${mAud[1]}` : ''}`;
      }
      return raw.replace(/&ext=\.m3u8\b/i, '');
    };
    const pushAlt = (u) => {
      const s = String(u || '').trim();
      const k = normDedupeKey(s);
      if (!s || !k || isDrmUrl(s) || isDemoTestUrl(s) || /youtube\.com\/watch|youtu\.be\//i.test(s) || seenUrls.has(k)) return;
      if (this.isMusic && is30sPreviewUrl(s) && primaryIsPlayableFull) return;
      seenUrls.add(k);
      alts.push(s);
    };
    const rawInitialUrl = (!isDemoTestUrl(prefAudio?.url) && prefAudio?.url) || (!isDemoTestUrl(media.url) && media.url) || '';
    if (rawInitialUrl && !isDrmUrl(rawInitialUrl)) {
      seenUrls.add(normDedupeKey(rawInitialUrl));
    }
    if (media.url && media.url !== rawInitialUrl) pushAlt(media.url);
    for (const u of (media.altUrls || [])) pushAlt(u);
    if (Array.isArray(media.servers)) {
      for (const srv of media.servers) if (srv?.url) pushAlt(srv.url);
    }
    if (Array.isArray(media.audioTracks)) {
      for (const t of media.audioTracks) if (t?.url) pushAlt(t.url);
    }
    alts.sort((a, b) => (isHevcUrl(a) ? 1 : 0) - (isHevcUrl(b) ? 1 : 0));
    this._pushFallbackAlt = pushAlt;

    let nativeAltIdx = 0;
    let triedProxySegs = false;
    let initialCandidate = (rawInitialUrl && !isDrmUrl(rawInitialUrl)) ? rawInitialUrl : '';
    if (initialCandidate && isHevcUrl(initialCandidate) && alts.length > 0 && !isHevcUrl(alts[0])) {
      const promoted = alts.shift();
      alts.push(initialCandidate);
      initialCandidate = promoted;
    }
    const url = initialCandidate || (alts[nativeAltIdx++] || '');
    this.currentUrl = url;
    if (this.isMusic) {
      const wantClip = !media.live && media.musicMode === 'video' && Boolean(this.bgMvEl || this.bgYtEl || !isAudioOnlyUrl(url));
      this._setMusicVisualMode?.(wantClip ? 'clip' : ((media.live || isAudioOnlyUrl(url)) ? 'vinyl' : 'clip'));
    }
    this.subs.initForMedia(media);

    let triedHlsFallback = false;
    const isUrlHls = (u) => {
      const s = String(u || '');
      if (/[?&]ext=\.(?:mp4|webm|mkv)\b/i.test(s)) return false;
      return /\.m3u8(\?|$)/i.test(s) || /\/proxy\?data=|\/api\/rave\/stream(?:\?|_manifest\?|-proxy\/)|playback\.media-streaming\.soundcloud\.cloud|cf-hls-media\.sndcdn\.com/i.test(s);
    };
    const isHls = isUrlHls(url) || media.provider === 'hls' || media.streamType === 'hls';
    const canHlsJs = Boolean(window.Hls && window.Hls.isSupported());
    const canNativeHls = Boolean(v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL'));
    const isApple = isIosWebKit() || (/Apple/i.test(navigator.vendor || '') && (/iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)));
    let useNativeHls = isHls && canNativeHls && (isApple || !canHlsJs);
    this._isApple = isApple;
    this._canAppleMseHls = false;
    this.useNativeHls = useNativeHls;
    const withProxySegs = (u) => {
      const s = String(u || '');
      if (!/\/api\/rave\/stream(?:\?|_manifest\?|-proxy\/)/i.test(s) || s.includes('proxy_segs=1')) return u;
      return s.includes('&ext=.m3u8')
        ? s.replace('&ext=.m3u8', '&proxy_segs=1&ext=.m3u8')
        : `${s}${s.includes('?') ? '&' : '?'}proxy_segs=1`;
    };
    this._withProxySegs = withProxySegs;

    let triedLiveRefresh = false;
    const handleExhaustedCandidates = async (srcUrl, doneCb) => {
      const proxied = withProxySegs(srcUrl || this.currentUrl);
      if (!triedProxySegs && proxied && proxied !== (srcUrl || this.currentUrl)) {
        triedProxySegs = true;
        loadCandidateUrl(proxied, doneCb);
        return;
      }
      if (!triedLiveRefresh && !this.isMusic && !media?.live && (media?.tmdbId || media?.imdbId || media?.title)) {
        triedLiveRefresh = true;
        try {
          const qs = new URLSearchParams({
            provider: String(media.catalogProvider || media.provider || 'cinema'),
            title: String(media.originalTitle || media.seriesTitle || media.title || ''),
            displayTitle: String(media.seriesTitle || media.title || ''),
            year: String(media.year || ''),
            tmdbId: String(media.tmdbId || ''),
            imdbId: String(media.imdbId || ''),
            mediaType: String(media.mediaType || 'movie'),
            season: String(media.season || 1),
            episode: String(media.episode || 1),
            refresh: '1',
          });
          const resp = await fetch(`/api/rave/resolve-catalog?${qs.toString()}`);
          if (resp.ok && this.video === v) {
            const fresh = await resp.json();
            if (fresh && fresh.url) {
              if (Array.isArray(fresh.servers) && fresh.servers.length) media.servers = fresh.servers;
              if (Array.isArray(fresh.altUrls) && fresh.altUrls.length) media.altUrls = fresh.altUrls;
              const freshList = [fresh.url, ...(fresh.altUrls || []), ...((fresh.servers || []).map((s) => s?.url))].filter(Boolean);
              const prevLen = alts.length;
              for (const fu of freshList) pushAlt(fu);
              const addedAny = alts.length > prevLen;
              if (addedAny && nativeAltIdx < alts.length) {
                triedProxySegs = false;
                loadCandidateUrl(alts[nativeAltIdx++], doneCb);
                return;
              }
            }
          }
        } catch (err) { /* ignore and fall through */ }
      }
      clearBuf();
      this.events.onError?.('Akış yüklenemedi');
      doneCb?.();
    };

    const loadCandidateUrl = (nextUrl, doneCb) => {
      if (!nextUrl || this._destroyed || this.video !== v) return;
      if (!String(nextUrl).includes('proxy_segs=1')) this._switchedToProxySegs = false;
      const expT = expectedPosition(state.mesh?.media);
      const curNow = Math.max(Number(this.getTime() || 0), Number(this.highestPlayedPos || 0));
      const resumePos = curNow > 0.5 ? curNow : ((Number.isFinite(expT) && expT > 0.5) ? expT : (startAt || 0));
      this.highestPlayedPos = resumePos;
      if (resumePos >= 0.5) {
        this.lastSeekTarget = resumePos;
        this.lastSeekAt = Date.now();
        this.initialSeekPending = resumePos;
        this.loadedAtMs = Date.now();
      }
      this.currentUrl = nextUrl;
      syncVideoCors(nextUrl, useNativeHls && isUrlHls(nextUrl));
      if (this.isMusic) {
        this._setMusicVisualMode?.(isAudioOnlyUrl(nextUrl) ? 'vinyl' : 'clip');
        if (isIosWebKit() && isAudioOnlyUrl(nextUrl)) {
          this._ensureIosPipStandby?.(nextUrl);
        }
      }
      const enforceInitialSeek = () => {
        if (this.video !== v || !(this.initialSeekPending >= 0.5) || v.seeking) return;
        if (v.readyState < 1) return;
        if (this.useNativeHls && v.seekable && v.seekable.length === 0) return;
        const targetPos = this.initialSeekPending;
        if (Math.abs((v.currentTime || 0) - targetPos) > 1.5) {
          try { v.currentTime = targetPos; } catch (e) { /* ignore */ }
        } else if (v.readyState >= 2) {
          this.initialSeekPending = 0;
        }
      };
      if (resumePos >= 0.5 && !v._wlInitSeekBound) {
        v._wlInitSeekBound = true;
        ['loadeddata', 'canplay', 'playing', 'durationchange'].forEach((evName) => {
          v.addEventListener(evName, enforceInitialSeek);
        });
      }
      const restorePosOnLoad = () => {
        if (this.video !== v) return;
        enforceInitialSeek();
        doneCb?.();
      };
      if (isUrlHls(nextUrl)) {
        const allowHlsJsHere = canHlsJs && !useNativeHls && (!isApple || Boolean(this._canAppleMseHls) || Boolean(this._forceIosMseInline));
        if (allowHlsJsHere) {
          if (isApple) this._ensureIosPipStandby?.(nextUrl);
          attachHlsJs(isApple ? withProxySegs(nextUrl) : nextUrl, doneCb, resumePos);
          return;
        }
        if (!canNativeHls) {
          if (nativeAltIdx < alts.length) {
            loadCandidateUrl(alts[nativeAltIdx++], doneCb);
          } else {
            handleExhaustedCandidates(nextUrl, doneCb);
          }
          return;
        }
        useNativeHls = true;
        this.useNativeHls = true;
        syncVideoCors(nextUrl, true);
        try { this.hls?.destroy(); } catch (err) { /* ignore */ }
        this.hls = null;
        v.src = withProxySegs(nextUrl);
        v.load();
        v.addEventListener('loadedmetadata', () => {
          this.subs.mergeNativeAudioTracks?.(v.audioTracks);
          restorePosOnLoad();
        }, { once: true });
        if (this.wantPlaying) this.tryPlay();
        return;
      }
      try { this.hls?.destroy(); } catch (err) { /* ignore */ }
      this.hls = null;
      if (isApple && this.baseVolume > 0 && this.baseVolume < 99.5) {
        this._ensureIosPipStandby?.(nextUrl);
      }
      v.src = nextUrl;
      v.load();
      v.addEventListener('loadedmetadata', restorePosOnLoad, { once: true });
      if (this.wantPlaying) this.tryPlay();
    };
    this._loadCandidateUrl = loadCandidateUrl;

    const attachHlsJs = (srcUrl, doneCb, customStart = null) => {
      try { this.hls?.destroy(); } catch (e) { /* ignore */ }
      if (isApple) {
        v.removeAttribute('x-webkit-airplay');
        try { v.disableRemotePlayback = true; } catch (_) {}
      }
      let doneFired = false;
      const fireDoneOnce = () => {
        if (doneFired) return;
        doneFired = true;
        doneCb?.();
      };
      const effStart = Number(customStart ?? startAt) || 0;
      const uaStr = navigator.userAgent || '';
      const isAndroid = /Android/i.test(uaStr);
      const isTouchDev = Boolean(navigator.maxTouchPoints > 0 || (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches));
      const isIpadDesktop = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      const isMobileScreen = isAndroid || isIpadDesktop || /iPhone|iPad|iPod|Mobile/i.test(uaStr) || (isTouchDev && typeof window !== 'undefined' && window.innerWidth <= 900);
      this.hls = new window.Hls({
        enableWorker: !isAndroid,
        lowLatencyMode: false,
        subtitleDisplay: false,
        enableWebVTT: false,
        startFragPrefetch: true,
        startPosition: effStart >= 0.5 ? effStart : -1,
        abrEwmaDefaultEstimate: isMobileScreen ? 680000 : 1600000,
        abrBandWidthFactor: isMobileScreen ? 0.78 : 0.85,
        abrBandWidthUpFactor: isMobileScreen ? 0.55 : 0.65,
        autoLevelCapping: -1,
        maxBufferLength: isMobileScreen ? 28 : 35,
        maxMaxBufferLength: isMobileScreen ? 55 : 75,
        backBufferLength: isMobileScreen ? 25 : 45,
        maxBufferSize: (isMobileScreen ? 28 : 45) * 1000 * 1000,
        maxBufferHole: 0.8,
        maxAudioFramesDrift: 2,
        stretchShortVideoTrack: true,
        forceKeyFrameOnDiscontinuity: true,
        progressive: false,
        highBufferWatchdogPeriod: 2,
        maxFragLookUpTolerance: 0.35,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 10,
        fragLoadingTimeOut: 28000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 600,
        manifestLoadingTimeOut: 16000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 16000,
        levelLoadingMaxRetry: 4,
      });
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (data?.levels?.length > 1) {
          let maxAllowedIdx = -1;
          let maxMobileHdIdx = -1;
          data.levels.forEach((l, idx) => {
            const w = l.width || 0;
            const h = l.height || 0;
            const bw = l.bitrate || 0;
            const isOver1080p = w > 2650 || h > 1200 || bw > 10500000;
            if (!isOver1080p) {
              maxAllowedIdx = idx;
            }
            const isMobileSafeHd = (w <= 1440 && h <= 820 && bw <= 4200000) || (w === 0 && h === 0 && bw <= 3400000);
            if (isMobileSafeHd) {
              maxMobileHdIdx = idx;
            }
          });
          const chosenCap = (isMobileScreen && maxMobileHdIdx >= 0) ? maxMobileHdIdx : maxAllowedIdx;
          if (chosenCap >= 0 && chosenCap < data.levels.length - 1) {
            this.hls.autoLevelCapping = chosenCap;
          }
        }
        this.events.onTracksChanged?.();
        if (effStart >= 0.5 && v.readyState >= 1 && Math.abs((v.currentTime || 0) - effStart) > 1.2) {
          try { v.currentTime = effStart; } catch (err) { /* ignore */ }
        }
        this.subs.mergeHlsAudioTracks(this.hls.audioTracks || data?.audioTracks || []);
        this.subs._applyHlsAudioSelection();
        if (this.wantPlaying) this.tryPlay();
        if (v.readyState >= 2) {
          clearBuf();
          this.events.onReady?.();
          fireDoneOnce();
        }
      });
      this.hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
        this.subs.mergeHlsAudioTracks(data?.audioTracks || this.hls?.audioTracks || []);
        this.subs._applyHlsAudioSelection();
      });
      let netRetries = 0;
      let mediaRetries = 0;
      let singleLevelStalls = 0;
      let firstSingleStallAt = 0;
      this.hls.on(window.Hls.Events.FRAG_BUFFERED, (_e, data) => {
        netRetries = 0;
        if (data?.frag?.type === 'audio' && !this.isMusic && v.readyState < 3) {
          return;
        }
        clearBuf();
        this.events.onReady?.();
        fireDoneOnce();
      });
      this.hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (!data?.fatal) {
          if ((data?.details === 'fragLoadError' || data?.details === 'fragLoadTimeOut') && String(srcUrl).includes('/api/rave/stream') && !String(srcUrl).includes('proxy_segs=1') && !this._switchedToProxySegs) {
            this._switchedToProxySegs = true;
            const proxied = withProxySegs(srcUrl);
            if (proxied && proxied !== srcUrl) {
              loadCandidateUrl(proxied, doneCb);
              return;
            }
          }
          if ((data?.details === 'decryptError' || data?.details === 'keyLoadError') && nativeAltIdx < alts.length) {
            loadCandidateUrl(alts[nativeAltIdx++], doneCb);
            return;
          }
          if (data?.details === 'bufferStalledError' && this.wantPlaying) {
            if (v.paused) {
              this.tryPlay();
              return;
            }
            try {
              const cur = v.currentTime || 0;
              if (!this.isBuffered(cur + 0.25) && Date.now() - (this._lastGapJumpAt || 0) > 8000) {
                for (let i = 0; i < v.buffered.length; i += 1) {
                  const bStart = v.buffered.start(i);
                  const bEnd = v.buffered.end(i);
                  if (bStart > cur + 0.08 && bStart - cur <= 2.2 && bEnd > bStart + 1.5) {
                    this._lastGapJumpAt = Date.now();
                    v.currentTime = bStart + 0.05;
                    return;
                  }
                }
              }
            } catch (err) { /* ignore */ }
            try {
              const lvlCount = this.hls.levels?.length || 0;
              const curLvl = this.hls.currentLevel >= 0 ? this.hls.currentLevel : (this.hls.nextAutoLevel ?? this.hls.loadLevel ?? 0);
              if (lvlCount > 1 && curLvl > 0) {
                this.hls.nextAutoLevel = Math.max(0, curLvl - 1);
              } else if (lvlCount <= 1 && nativeAltIdx < alts.length) {
                const nowMs = Date.now();
                if (!firstSingleStallAt || nowMs - firstSingleStallAt > 24000) {
                  firstSingleStallAt = nowMs;
                  singleLevelStalls = 1;
                } else {
                  singleLevelStalls += 1;
                }
                if (singleLevelStalls >= 2) {
                  singleLevelStalls = 0;
                  this._reportStreamHealth?.(srcUrl, false, { stalled: true });
                  loadCandidateUrl(alts[nativeAltIdx++], doneCb);
                  return;
                }
              }
            } catch (err) { /* ignore */ }
          }
          return;
        }
        if (data?.fatal) {
          const curResume = Math.max(this.getTime() || 0, this.highestPlayedPos || 0, startAt || 0);
          if (curResume >= 5) {
            this.lastSeekTarget = curResume;
            this.lastSeekAt = Date.now();
          }
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            if ((data?.details === 'fragLoadError' || data?.details === 'fragLoadTimeOut') && String(srcUrl).includes('/api/rave/stream') && !String(srcUrl).includes('proxy_segs=1') && !this._switchedToProxySegs) {
              this._switchedToProxySegs = true;
              const proxied = withProxySegs(srcUrl);
              if (proxied && proxied !== srcUrl) {
                loadCandidateUrl(proxied, doneCb);
                return;
              }
            }
            netRetries += 1;
            if (netRetries <= (nativeAltIdx < alts.length ? 1 : 2)) {
              setTimeout(() => {
                try { this.hls?.startLoad(curResume >= 5 ? curResume : -1); } catch (err) { /* ignore */ }
              }, 350 * netRetries);
            } else if (nativeAltIdx < alts.length) {
              netRetries = 0;
              this._reportStreamHealth?.(srcUrl, false, { stalled: false });
              loadCandidateUrl(alts[nativeAltIdx++], doneCb);
            } else if (canNativeHls && !triedHlsFallback) {
              triedHlsFallback = true;
              useNativeHls = true;
              this.useNativeHls = true;
              syncVideoCors(srcUrl, true);
              try { this.hls.destroy(); } catch (err) { /* ignore */ }
              this.hls = null;
              v.src = withProxySegs(srcUrl);
              v.load();
              v.addEventListener('loadedmetadata', () => this.subs.mergeNativeAudioTracks?.(v.audioTracks), { once: true });
              if (curResume >= 5) {
                v.addEventListener('loadedmetadata', () => { try { v.currentTime = curResume; } catch (e) {} }, { once: true });
              }
              if (this.wantPlaying) this.tryPlay();
            } else {
              handleExhaustedCandidates(srcUrl, doneCb);
            }
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            mediaRetries += 1;
            if (mediaRetries <= 1) {
              try { this.hls.recoverMediaError(); } catch (err) { /* ignore */ }
            } else if (canNativeHls && !triedHlsFallback) {
              triedHlsFallback = true;
              useNativeHls = true;
              this.useNativeHls = true;
              syncVideoCors(srcUrl, true);
              try { this.hls.destroy(); } catch (err) { /* ignore */ }
              this.hls = null;
              v.src = withProxySegs(srcUrl);
              v.load();
              v.addEventListener('loadedmetadata', () => this.subs.mergeNativeAudioTracks?.(v.audioTracks), { once: true });
              if (curResume >= 5) {
                v.addEventListener('loadedmetadata', () => { try { v.currentTime = curResume; } catch (e) {} }, { once: true });
              }
              if (this.wantPlaying) this.tryPlay();
            } else if (nativeAltIdx < alts.length) {
              loadCandidateUrl(alts[nativeAltIdx++], doneCb);
            } else {
              handleExhaustedCandidates(srcUrl, doneCb);
            }
          } else if (nativeAltIdx < alts.length) {
            loadCandidateUrl(alts[nativeAltIdx++], doneCb);
          } else {
            handleExhaustedCandidates(srcUrl, doneCb);
          }
        }
      });
      this.hls.loadSource(srcUrl);
      this.hls.attachMedia(v);
    };
    this._attachHlsJsInline = attachHlsJs;

    v.addEventListener('error', () => {
      if (this._destroyed || this.video !== v || this.hls) return;
      if (v.hasAttribute('crossorigin') && !v._retriedNoCors && this.currentUrl) {
        v._retriedNoCors = true;
        v.removeAttribute('crossorigin');
        v.src = this.currentUrl;
        try { v.load(); } catch (_) {}
        if (this.wantPlaying) this.tryPlay();
        return;
      }
      if (nativeAltIdx < alts.length) {
        this._reportStreamHealth?.(this.currentUrl, false, { stalled: false });
        loadCandidateUrl(alts[nativeAltIdx++]);
        return;
      }
      if (isUrlHls(this.currentUrl) && canHlsJs && !triedHlsFallback) {
        triedHlsFallback = true;
        v.removeAttribute('src');
        attachHlsJs(this.currentUrl);
        return;
      }
      handleExhaustedCandidates(this.currentUrl);
    });

    await new Promise((resolve) => {
      let resolved = false;
      this._loadDoneResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(this.loadReadyTimer);
        if (this._destroyed || this.video !== v) {
          resolve();
          return;
        }
        if ((v.readyState >= 1 && !v.seeking) || v.paused) {
          clearBuf();
          this.events.onReady?.();
        } else {
          this.bufferingReported = true;
          this.events.onBuffering?.(true);
        }
        resolve();
      };
      const onFrameReady = () => {
        if (this._destroyed || this.video !== v || v.readyState < 1) return;
        clearBuf();
        this.events.onReady?.();
        done();
      };
      v.addEventListener('loadedmetadata', onFrameReady);
      v.addEventListener('loadeddata', onFrameReady);
      v.addEventListener('canplay', onFrameReady);
      v.addEventListener('playing', onFrameReady);
      this.loadReadyTimer = setTimeout(done, 3400);
      if (validStart >= 0.5 && !v._wlInitSeekBound) {
        v._wlInitSeekBound = true;
        const enforcePrimaryInitialSeek = () => {
          if (this.video !== v || !(this.initialSeekPending >= 0.5) || v.seeking || v.readyState < 1) return;
          if (this.useNativeHls && v.seekable && v.seekable.length === 0) return;
          const targetPos = this.initialSeekPending;
          if (Math.abs((v.currentTime || 0) - targetPos) > 1.5) {
            try { v.currentTime = targetPos; } catch (_) {}
          } else if (v.readyState >= 2) {
            this.initialSeekPending = 0;
          }
        };
        ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'durationchange'].forEach((evName) => {
          v.addEventListener(evName, enforcePrimaryInitialSeek);
        });
      }
      syncVideoCors(url);
      if (isHls && canHlsJs && !useNativeHls) {
        attachHlsJs(isApple ? withProxySegs(url) : url, onFrameReady);
      } else {
        v.src = useNativeHls ? withProxySegs(url) : url;
        if (autoplay) this.tryPlay();
      }
    });
    if (this._destroyed || this.video !== v) return;
    if (startAt >= 0.5 && this.initialSeekPending >= 0.5 && v.readyState >= 1 && !v.seeking) {
      if (Math.abs((v.currentTime || 0) - startAt) > 1.5) {
        try { v.currentTime = startAt; } catch (e) { /* ignore */ }
      }
    }
    if (autoplay) {
      this.tryPlay();
      v.addEventListener('canplay', () => { if (this.wantPlaying && v.paused) this.tryPlay(); });
    }
    let stallChecks = 0;
    const isTouchVp = Boolean(navigator.maxTouchPoints > 0 || (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches));
    const isMobViewport = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || (isTouchVp && typeof window !== 'undefined' && window.innerWidth <= 900);
    const stallWindowMs = this.isMusic ? 4500 : (isMobViewport ? 16500 : 13000);
    let lastZeroDimSwitchAt = 0;
    let zeroDimDowngraded = false;
    const checkZeroDimAudioOnly = () => {
      if (this.video !== v || this.isMusic || isAudioOnlyUrl(this.currentUrl)) return;
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      const decFrames = q && typeof q.totalVideoFrames === 'number'
        ? q.totalVideoFrames
        : (typeof v.webkitDecodedFrameCount === 'number' ? v.webkitDecodedFrameCount : -1);
      const elapsedAfterStart = (v.currentTime || 0) - (startAt || 0);
      const hasZeroVideoDim = v.videoWidth === 0 && elapsedAfterStart > 0.45;
      const hasZeroDecodedFrames = Boolean(this.hls) && decFrames === 0 && elapsedAfterStart > 2.2;
      if (v.readyState >= 2 && !v.paused && (hasZeroVideoDim || hasZeroDecodedFrames)) {
        const nowMs = Date.now();
        if (this.hls && !zeroDimDowngraded) {
          zeroDimDowngraded = true;
          lastZeroDimSwitchAt = nowMs;
          try {
            if (this.hls.levels?.length > 1) this.hls.currentLevel = 0;
            if (hasZeroDecodedFrames) this.hls.recoverMediaError();
          } catch (e) { /* ignore */ }
          return;
        }
        if (nowMs - lastZeroDimSwitchAt > 1500) {
          lastZeroDimSwitchAt = nowMs;
          if (nativeAltIdx < alts.length) {
            zeroDimDowngraded = false;
            loadCandidateUrl(alts[nativeAltIdx++]);
          } else if (isHls && canNativeHls && this.hls && !triedHlsFallback) {
            triedHlsFallback = true;
            useNativeHls = true;
            this.useNativeHls = true;
            const resumeAt = Math.max(v.currentTime || 0, startAt || 0);
            try { this.hls.destroy(); } catch (e) { /* ignore */ }
            this.hls = null;
            v.src = withProxySegs(this.currentUrl || url);
            v.load();
            v.addEventListener('loadedmetadata', () => this.subs.mergeNativeAudioTracks?.(v.audioTracks), { once: true });
            if (resumeAt >= 1) {
              v.addEventListener('loadedmetadata', () => { try { v.currentTime = resumeAt; } catch (e) {} }, { once: true });
            }
            if (this.wantPlaying) this.tryPlay();
          }
        }
      }
    };
    v.addEventListener('timeupdate', checkZeroDimAudioOnly);
    const checkUniversalStall = () => {
      if (this.video !== v) return;
      if (!this.wantPlaying || v.seeking || document.hidden || this.isPiP() || (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive)) {
        this.watchdogTimer = setTimeout(checkUniversalStall, stallWindowMs);
        return;
      }
      if (!v.paused && v.readyState >= 2 && (v.currentTime > 0.25 || v.readyState >= 3)) {
        if (!this.isMusic && !isAudioOnlyUrl(this.currentUrl) && v.videoWidth === 0) {
          if (nativeAltIdx < alts.length) {
            loadCandidateUrl(alts[nativeAltIdx++]);
            this.watchdogTimer = setTimeout(checkUniversalStall, stallWindowMs);
          }
          return;
        }
        clearBuf();
        this.events.onReady?.();
        return;
      }
      if (this.wantPlaying && v.paused && v.readyState >= 2) {
        this.tryPlay();
      }
      const isStuck = v.readyState < 2 || (this.wantPlaying && !v.paused && v.currentTime <= 0.15 && v.readyState < 3);
      if (isStuck && stallChecks < 6) {
        stallChecks += 1;
        const activelyLoadingMedia = Boolean(v.networkState === 2 || (v.buffered && v.buffered.length > 0));
        if (stallChecks === 1 && ((this.hls && this.hls.levels?.length > 0) || (!this.hls && activelyLoadingMedia))) {
          try {
            if (this.hls && this.hls.levels?.length > 1) this.hls.nextAutoLevel = 0;
            if (v.readyState >= 2 && this.wantPlaying && v.paused) this.tryPlay();
          } catch (e) { /* ignore */ }
          this.watchdogTimer = setTimeout(checkUniversalStall, stallWindowMs);
        } else if (nativeAltIdx < alts.length) {
          loadCandidateUrl(alts[nativeAltIdx++]);
          this.watchdogTimer = setTimeout(checkUniversalStall, stallWindowMs);
        } else if (isHls && canHlsJs && !this.hls && !triedHlsFallback) {
          triedHlsFallback = true;
          v.removeAttribute('src');
          attachHlsJs(this.currentUrl || url);
          this.watchdogTimer = setTimeout(checkUniversalStall, stallWindowMs);
        } else if (this.hls) {
          try {
            if (this.hls.levels?.length > 1) this.hls.nextAutoLevel = 0;
          } catch (e) { /* ignore */ }
        }
      }
    };
    this.watchdogTimer = setTimeout(checkUniversalStall, stallWindowMs);
    clearInterval(this.playbackWatchdog);
    let lastWatchdogPos = -1;
    let consecutiveMidStalls = 0;
    this.playbackWatchdog = setInterval(() => {
      if (this._destroyed || this.video !== v || this.hasEnded || v.ended) return;
      const curT = Number(v.currentTime || 0);
      if (!v.paused && !v.seeking && v.readyState >= 3 && Math.abs(curT - lastWatchdogPos) > 0.15) {
        consecutiveMidStalls = 0;
        lastWatchdogPos = curT;
        clearBuf();
        return;
      }
      if (!this.wantPlaying || v.seeking || document.hidden || this.isPiP() || (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive)) {
        consecutiveMidStalls = 0;
        lastWatchdogPos = curT;
        return;
      }
      if (Math.abs(curT - lastWatchdogPos) < 0.08 && curT > 0.5) {
        consecutiveMidStalls += 1;
        if (v.paused && v.readyState >= 2) {
          this.tryPlay();
        }
        if (consecutiveMidStalls >= 3 && !this.isBuffered(curT + 0.25) && Date.now() - (this._lastGapJumpAt || 0) > 8000) {
          try {
            for (let i = 0; i < v.buffered.length; i += 1) {
              const bStart = v.buffered.start(i);
              const bEnd = v.buffered.end(i);
              if (bStart > curT + 0.08 && bStart - curT <= 2.2 && bEnd > bStart + 1.5) {
                this._lastGapJumpAt = Date.now();
                v.currentTime = bStart + 0.06;
                consecutiveMidStalls = 0;
                return;
              }
            }
          } catch (err) { /* ignore */ }
        }
        if (consecutiveMidStalls === 3 && this.hls) {
          try {
            const curLvl = this.hls.currentLevel >= 0 ? this.hls.currentLevel : (this.hls.nextAutoLevel ?? this.hls.loadLevel ?? 0);
            if (this.hls.levels?.length > 1 && curLvl > 0) {
              this.hls.nextAutoLevel = 0;
            }
          } catch (err) { /* ignore */ }
        } else if (consecutiveMidStalls === 10 && this.hls) {
          const nowMs = Date.now();
          if (!this._lastHlsKickAt || nowMs - this._lastHlsKickAt > 25000) {
            this._lastHlsKickAt = nowMs;
            try {
              if (this.hls.levels?.length > 1) {
                this.hls.nextAutoLevel = 0;
              }
              let bufAhead = 0;
              for (let i = 0; i < v.buffered.length; i += 1) {
                if (v.buffered.start(i) <= curT + 0.5 && v.buffered.end(i) > curT) {
                  bufAhead = v.buffered.end(i) - curT;
                  break;
                }
              }
              if (bufAhead < 0.1) {
                this.hls.startLoad(Math.max(0, curT));
              }
            } catch (err) { /* ignore */ }
          }
        } else if (consecutiveMidStalls >= 18) {
          consecutiveMidStalls = 0;
          if (nativeAltIdx < alts.length) {
            loadCandidateUrl(alts[nativeAltIdx++]);
          } else if (this.hls) {
            try { this.hls.recoverMediaError(); } catch (err) { /* ignore */ }
          }
        }
      } else {
        consecutiveMidStalls = 0;
        lastWatchdogPos = curT;
      }
    }, 2500);
  }

  async tryPlay() {
    const v = this.video;
    if (!v || this.hasEnded || v.ended) return;
    if (v.muted && !this.userExplicitMuted && (this.audioUnlocked || navigator.userActivation?.isActive)) {
      v.muted = false;
    }
    try {
      await v.play();
      clearTimeout(this.waitTimer);
      if (this.bufferingReported && v.readyState >= 2) {
        this.bufferingReported = false;
        this.events.onBuffering?.(false);
      }
      if (!v.muted) {
        this.audioUnlocked = true;
        this.events.onUnmuted?.();
      } else {
        this.events.onAutoplayBlocked?.();
      }
    } catch (e) {
      if (!this.video || this.video !== v || this.hasEnded || v.ended) return;
      if (e && e.name === 'AbortError') {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => {
          if (this.video === v && this.wantPlaying && !this.hasEnded && v.paused && !v.ended) this.tryPlay();
        }, 150);
        return;
      }
      if (e && e.name === 'NotAllowedError') {
        if (typeof document !== 'undefined' && document.hidden) return;
        v.muted = true;
        this.audioUnlocked = false;
        this.events.onAutoplayBlocked?.();
        try {
          await v.play();
        } catch (e2) {
          this.autoplayHardBlocked = true;
          this.wantPlaying = false;
          this.events.onPause?.();
        }
      }
    }
  }

  _activeMediaEl() {
    return (this._iosPipActive && this.iosPipVideo && !this._iosPipIsCanvasOnly) ? this.iosPipVideo : this.video;
  }

  canControlVolume() {
    if (!isIosWebKit()) return true;
    if (typeof window !== 'undefined' && window.webkit?.messageHandlers?.watchlivoVolume) return true;
    if (this._canAppleMseHls) return true;
    if (this.video && !this.useNativeHls) return true;
    return true;
  }

  play() {
    const av = this._activeMediaEl();
    if (this.hasEnded || av?.ended) return;
    if (typeof navigator !== 'undefined' && navigator.userActivation?.isActive) this.autoplayHardBlocked = false;
    this.wantPlaying = true;
    if (av && av === this.iosPipVideo) { av.play()?.catch?.(() => {}); return; }
    this.tryPlay();
  }
  _nativeIosPipSourceUrl() {
    if (this.isMusic && !(this.video?.videoWidth > 0)) {
      const clipVid = String(this.media?.clipVideoId || this.media?.videoId || '');
      if (/^[A-Za-z0-9_-]{11}$/.test(clipVid) && !this.media?.live) {
        return `/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(clipVid)}`;
      }
      if (this.bgMvEl?.src) return this.bgMvEl.src;
    }
    if (!this.currentUrl || this.currentUrl.startsWith('blob:')) return '';
    let base = this._withProxySegs ? this._withProxySegs(this.currentUrl) : this.currentUrl;
    if (/\/api\/rave\/stream(?:\?|_manifest\?)/i.test(base) && !base.includes('max_h=')) {
      base = base.includes('&ext=.m3u8')
        ? base.replace('&ext=.m3u8', '&max_h=720&ext=.m3u8')
        : `${base}${base.includes('?') ? '&' : '?'}max_h=720`;
    }
    return base;
  }
  _syncNativeIosPip(playingOverride = null) {
    if (typeof window === 'undefined' || !window.isWatchlivoNativeIOS || typeof window.watchlivoNativePiP !== 'function') return;
    const eff = this._nativeIosPipSourceUrl();
    if (!this.video || !eff) return;
    this._lastNativeIosSyncAt = Date.now();
    try {
      const absU = new URL(eff, window.location.origin).href;
      const r = this.container?.getBoundingClientRect?.() || { left: 0, top: 80, width: 360, height: 202 };
      const isPlaying = typeof playingOverride === 'boolean' ? playingOverride : (!this.video.paused && this.wantPlaying);
      window.watchlivoNativePiP(isPlaying ? 'sync' : 'pause', {
        url: absU,
        time: this.getTime(),
        rate: this.video.playbackRate || 1,
        playing: isPlaying,
        live: Boolean(this.media?.live),
        muted: Boolean(this.video.muted || this.userExplicitMuted || this.baseVolume <= 0),
        rect: { x: Math.round(r.left || 0), y: Math.round(r.top || 80), width: Math.max(240, Math.round(r.width || 360)), height: Math.max(135, Math.round(r.height || 202)) },
      });
    } catch (_) {}
  }

  _syncAndroidPipState(playingOverride = null) {
    if (typeof window === 'undefined' || !window.Android) return;
    const v = this.video;
    const isPlaying = typeof playingOverride === 'boolean' ? playingOverride : Boolean(v && !v.paused && this.wantPlaying);
    const vw = v?.videoWidth || 16;
    const vh = v?.videoHeight || 9;
    try {
      if (typeof window.Android.setVideoPlayingBounds === 'function') {
        const dpr = Math.max(1, Number(window.devicePixelRatio || 1));
        const r = (v || this.container)?.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 };
        window.Android.setVideoPlayingBounds(
          isPlaying,
          vw,
          vh,
          Math.max(0, Math.round((r.left || 0) * dpr)),
          Math.max(0, Math.round((r.top || 0) * dpr)),
          Math.max(0, Math.round((r.right || 0) * dpr)),
          Math.max(0, Math.round((r.bottom || 0) * dpr)),
        );
      } else {
        window.Android.setVideoPlaying?.(isPlaying, vw, vh);
      }
    } catch (_) {}
  }

  async enterAutoPiP(reason = 'visibilitychange') {
    const v = this.video;
    if (!v || this._destroyed || !this.wantPlaying || this.hasEnded) return false;
    try {
      if (localStorage.getItem('vortex_auto_pip') === 'off') return false;
    } catch (_) {}
    if (this.isPiP()) return 'already-pip';
    if (typeof document !== 'undefined' && document.documentElement?.classList?.contains('is-android-pip')) return 'already-pip';
    if (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive) return 'already-pip';

    applyOptimalPipAttributes(v, true);
    const av = this._activeMediaEl();
    if (av && av.paused && !av.ended) {
      try { av.play()?.catch?.(() => {}); } catch (_) {}
    }

    if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && typeof window.watchlivoNativePiP === 'function') {
      this._syncNativeIosPip(true);
      return 'native-ios-synced';
    }

    if (typeof window !== 'undefined' && window.Android) {
      this._syncAndroidPipState(true);
      if ((reason === 'userLeaveHint' || reason === 'mediaSession') && typeof window.Android.enterPiP === 'function') {
        try {
          if (window.Android.enterPiP(v.videoWidth || 16, v.videoHeight || 9) !== false) return 'entered';
        } catch (_) {}
      }
      return 'native-android-synced';
    }

    if (typeof v.requestPictureInPicture === 'function' && (typeof document === 'undefined' || document.pictureInPictureEnabled !== false) && !v.disablePictureInPicture && v.readyState >= 1) {
      try {
        this.subs?.syncNativeTrackToElement?.(v, true);
        await v.requestPictureInPicture();
        this.events.onPipChange?.(true);
        return 'entered';
      } catch (_) {
        /* Browser requires transient MediaSession 'enterpictureinpicture' activation or WebKit presentation API */
      }
    }

    const targetV = (isIosWebKit() && this.iosPipVideo && (Boolean(this.hls) || hasWebAudioGraph(v) || (this.isMusic && !(v.videoWidth > 0))))
      ? this.iosPipVideo
      : v;
    if (targetV && typeof targetV.webkitSetPresentationMode === 'function' && targetV.webkitPresentationMode !== 'picture-in-picture' && targetV.readyState >= 1) {
      try {
        if (!targetV.webkitSupportsPresentationMode || targetV.webkitSupportsPresentationMode('picture-in-picture')) {
          if (targetV === this.iosPipVideo) {
            this._iosPipActive = true;
            this._lastPipEnterAt = Date.now();
            if (!this._iosPipIsCanvasOnly) {
              const curT = this.getTime();
              if (curT > 0.5 && Math.abs((targetV.currentTime || 0) - curT) > 0.8) {
                try { targetV.currentTime = curT; } catch (_) {}
              }
              targetV.muted = Boolean(this.userExplicitMuted || this.baseVolume <= 0);
              targetV.playbackRate = v.playbackRate || 1;
              this._suppressInlinePauseOnce = true;
              try { v.pause(); } catch (_) {}
              try { this.hls?.stopLoad?.(); } catch (_) {}
            }
            try { targetV.play()?.catch?.(() => {}); } catch (_) {}
          }
          this.subs?.syncNativeTrackToElement?.(targetV, true);
          targetV.webkitSetPresentationMode('picture-in-picture');
          this.events.onPipChange?.(true);
          return 'entered';
        }
      } catch (_) {}
    }
    return false;
  }

  pause() {
    this.wantPlaying = false;
    clearTimeout(this.resumeTimer);
    this._activeMediaEl()?.pause();
    if (this._iosPipIsCanvasOnly) this.video?.pause();
    this._syncAndroidPipState(false);
    this._syncNativeIosPip(false);
  }
  isEnded() { return Boolean(this.hasEnded || this._activeMediaEl()?.ended); }
  seek(t) {
    const target = Math.max(0, Number(t) || 0);
    const dur = this.getDuration();
    if (!dur || target < dur - 2) {
      this.hasEnded = false;
    }
    const v = this._activeMediaEl();
    if (v && (v.seeking || Math.abs((Number(v.currentTime) || 0) - this.lastSeekTarget) < 1.5) && this.lastSeekAt && Date.now() - this.lastSeekAt < 1000 && Math.abs(target - this.lastSeekTarget) < 1.2) {
      return;
    }
    if (v && v.readyState >= 1 && Math.abs((Number(v.currentTime) || 0) - target) < 0.6) {
      return;
    }
    this.lastSeekTarget = target;
    this.highestPlayedPos = target;
    this.lastSeekAt = Date.now();
    this.subs?.stopDubAudio?.();
    if (v) {
      if (v.readyState < 1) {
        this.initialSeekPending = target;
        this.loadedAtMs = Date.now();
        if (!this._pendingMetaSeekBound) {
          this._pendingMetaSeekBound = true;
          v.addEventListener('loadedmetadata', () => {
            this._pendingMetaSeekBound = false;
            if (this.video === v && this.initialSeekPending > 0.5 && Math.abs((v.currentTime || 0) - this.initialSeekPending) > 1.2) {
              try { v.currentTime = this.initialSeekPending; } catch (e) { /* ignore */ }
            }
          }, { once: true });
        }
      } else {
        try { v.currentTime = target; } catch (e) { /* ignore */ }
      }
    }
    this.subs?.clearActiveCue?.();
    if (v && v.readyState >= 2 && (v.videoWidth > 0 || this.isMusic)) {
      this.subs?.onTimeUpdate?.(target, true);
    }
  }
  getTime() {
    const v = this._activeMediaEl();
    const nowMs = Date.now();
    if (this.initialSeekPending && nowMs - (this.loadedAtMs || 0) < 16000) {
      const cur = Number(v?.currentTime || 0);
      if (!v || v.readyState < 2 || v.seeking || (v.readyState < 3 && cur < Math.max(0.5, this.initialSeekPending - 2.5))) {
        return this.initialSeekPending;
      }
      if (cur >= Math.max(0.5, this.initialSeekPending - 2.5)) {
        this.initialSeekPending = 0;
      }
    }
    if (!v || v.readyState < 1) {
      return Number(v?.currentTime || 0);
    }
    if (this.lastSeekAt && nowMs - this.lastSeekAt < 14000) {
      const cur = Number(v.currentTime || 0);
      if (v.seeking || (this.wantPlaying && v.readyState < 3 && Math.abs(cur - this.lastSeekTarget) > 2.5)) {
        return this.lastSeekTarget;
      }
    }
    return Number(v.currentTime || 0);
  }
  getDuration() { const d = Number(this._activeMediaEl()?.duration || this.video?.duration || 0); return Number.isFinite(d) ? d : 0; }
  getBuffered() {
    const v = this._activeMediaEl();
    if (!v || !v.buffered.length) return 0;
    const ct = Number(v.currentTime || 0);
    for (let i = 0; i < v.buffered.length; i += 1) {
      if (ct >= v.buffered.start(i) - 1.5 && ct <= v.buffered.end(i) + 0.5) {
        return v.buffered.end(i);
      }
    }
    return v.buffered.end(v.buffered.length - 1);
  }
  isPaused() { const av = this._activeMediaEl(); return !av || av.paused; }
  isBuffered(t) {
    const b = this._activeMediaEl()?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i += 1) if (t >= b.start(i) - 0.5 && t <= b.end(i) - 0.2) return true;
    return false;
  }
  isBuffering() {
    const v = this._activeMediaEl();
    if (!v) return true;
    if (this.initialSeekPending && Date.now() - (this.loadedAtMs || 0) < 16000 && v.readyState < 3) return true;
    const activePlay = !v.paused || this.wantPlaying;
    const starvedAhead = activePlay && v.readyState < 3 && !this.isBuffered(Number(v.currentTime || 0) + 0.3);
    return Boolean(v.seeking || this.bufferingReported || (activePlay && v.readyState < 2) || starvedAhead);
  }
  setRate(r) {
    if (this.video && Math.abs(this.video.playbackRate - r) > 0.001) this.video.playbackRate = r;
    if (this.iosPipVideo && Math.abs(this.iosPipVideo.playbackRate - r) > 0.001) this.iosPipVideo.playbackRate = r;
  }
  getRate() { return Number(this._activeMediaEl()?.playbackRate || 1); }
  setVolume(v) {
    const rawNum = Number(v);
    this.baseVolume = Math.max(0, Math.min(100, Number.isFinite(rawNum) ? rawNum : (isIosWebKit() ? 100 : 80)));
    this.subs.syncVideoVolume();
    if (this.video && (this.hls || hasWebAudioGraph(this.video)) && isIosWebKit()) {
      this._ensureIosPipStandby?.(this.currentUrl);
    }
    this._syncDeckBVolume?.();
  }
  setMuted(m) {
    this.userExplicitMuted = Boolean(m);
    if (!m) {
      this.audioUnlocked = true;
      this.autoplayHardBlocked = false;
      this.subs.unlockDubAudio();
    } else {
      this.subs.stopDubAudio();
    }
    if (this.video) this.video.muted = Boolean(m);
    this.subs.syncVideoVolume();
    this._syncDeckBVolume?.();
    if (!m) this.events.onUnmuted?.();
  }
  isMuted() { return !!this.video?.muted; }
  getSubtitleTracks() { return this.subs.subtitleTracks; }
  getSelectedSubtitleId() { return this.subs.selectedSubId; }
  setSubtitleTrack(id) { return this.subs.setSubtitleTrack(id); }
  getAudioTracks() { return this.subs.audioTracks; }
  getSelectedAudioId() { return this.subs.selectedAudioId; }
  setAudioTrack(id) { return this.subs.setAudioTrack(id); }
  switchStreamSource(newUrl) {
    if (!newUrl || !this.video) return;
    if (this.currentUrl && this.currentUrl !== newUrl) {
      this._pushFallbackAlt?.(this.currentUrl);
    }
    if (typeof this._loadCandidateUrl === 'function') {
      this._loadCandidateUrl(newUrl, () => {
        if (this.subs?.selectedSubId && this.subs.selectedSubId !== 'off') {
          const trk = this.subs.subtitleTracks.find((t) => t.id === this.subs.selectedSubId);
          if (trk) this.subs._attachNativeTrack(trk);
        }
        this.subs?.onTimeUpdate?.(this.getTime(), true);
      });
      return;
    }
    const expT = expectedPosition(state.mesh?.media);
    const curT = (Number.isFinite(expT) && expT > 0.5) ? expT : Math.max(this.getTime() || 0, this.highestPlayedPos || 0);
    if (curT >= 0.5) {
      this.lastSeekTarget = curT;
      this.lastSeekAt = Date.now();
    }
    const wasPlaying = this.wantPlaying || !this.isPaused();
    this.wantPlaying = wasPlaying;
    this.currentUrl = newUrl;
    const getFreshTarget = () => {
      const liveExp = expectedPosition(state.mesh?.media);
      return (Number.isFinite(liveExp) && liveExp > 0.5) ? liveExp : curT;
    };
    const reattachSubs = () => {
      if (this.subs?.selectedSubId && this.subs.selectedSubId !== 'off') {
        const trk = this.subs.subtitleTracks.find((t) => t.id === this.subs.selectedSubId);
        if (trk) this.subs._attachNativeTrack(trk);
      }
      this.subs?.onTimeUpdate?.(this.getTime(), true);
    };
    const isNextHls = /\.m3u8(\?|$)/i.test(String(newUrl || '')) || /\/proxy\?data=|\/api\/rave\/stream(?:\?|_manifest\?|-proxy\/)|playback\.media-streaming\.soundcloud\.cloud|cf-hls-media\.sndcdn\.com/i.test(String(newUrl || ''));
    const isNextAudioOnly = /\.(m4a|mp3|aac|ogg|wav)(\?|$)/i.test(String(newUrl || '')) || /audio-ssl\.itunes\.apple\.com|p\.scdn\.co\/mp3-preview|soundcloud\.cloud|sndcdn\.com/i.test(String(newUrl || ''));
    if (this.isMusic) {
      this._setMusicVisualMode?.(isNextAudioOnly ? 'vinyl' : 'clip');
    }
    if (!this.hls && isNextHls && !/stream-proxy/i.test(newUrl) && window.Hls && window.Hls.isSupported() && !this.useNativeHls) {
      this.hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      this.hls.on(window.Hls.Events.ERROR, (_ev, data) => {
        if (!data?.fatal || !this.hls) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { this.hls.recoverMediaError(); } catch (_) {}
        } else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          try { this.hls.startLoad(); } catch (_) {}
        }
      });
      this.hls.attachMedia(this.video);
    }
    if (this.hls && isNextHls && !/stream-proxy/i.test(newUrl)) {
      this.hls.loadSource(newUrl);
      const targetLoad = getFreshTarget();
      this.hls.startLoad(targetLoad >= 0.5 ? targetLoad : -1);
      this.video.addEventListener('loadedmetadata', () => {
        const fresh = getFreshTarget();
        if (fresh >= 0.5 && Math.abs((this.video?.currentTime || 0) - fresh) > 0.8) {
          try { this.video.currentTime = fresh; } catch (e) { /* ignore */ }
        }
        this.subs._applyHlsAudioSelection();
        reattachSubs();
        if (wasPlaying) this.tryPlay();
      }, { once: true });
      if (wasPlaying) this.tryPlay();
    } else {
      try { this.hls?.destroy(); } catch (e) { /* ignore */ }
      this.hls = null;
      const effUrl = (this.useNativeHls && this._withProxySegs)
        ? this._withProxySegs(newUrl)
        : newUrl;
      this.video.src = effUrl;
      try { this.video.load(); } catch (e) { /* ignore */ }
      this.video.addEventListener('loadedmetadata', () => {
        const fresh = getFreshTarget();
        if (fresh >= 0.5) { try { this.video.currentTime = fresh; } catch (e) { /* ignore */ } }
        reattachSubs();
        if (wasPlaying) this.tryPlay();
      }, { once: true });
      if (wasPlaying) this.tryPlay();
    }
  }
  getQualityLevels() {
    const levels = this.hls?.levels || [];
    if (!levels.length) {
      const vw = this.video?.videoWidth || 0;
      const vh = this.video?.videoHeight || 0;
      const lbl = (vw >= 3200 || vh >= 2000) ? '4K UHD (2160p)' : (vw >= 1800 || vh >= 1000) ? '1080p Full HD' : (vw >= 1200 || vh >= 680) ? '720p HD' : (vh > 0 ? `${vh}p` : 'Otomatik Akış');
      return [{ id: 0, label: `✨ ${lbl} (Doğrudan Akış)`, active: true }];
    }
    const isAuto = Boolean(this.hls.autoLevelEnabled);
    const cur = this.hls.currentLevel;
    const items = levels.map((l, idx) => {
      const w = l.width || 0, h = l.height || 0;
      const effW = Math.max(w, Math.round(h * 16 / 9));
      const tag = effW >= 3200 ? '4K UHD (2160p)' : effW >= 1800 ? '1080p Full HD' : effW >= 1200 ? '720p HD' : `${h || 720}p`;
      return { id: idx, label: `🎬 ${tag}${w && h ? ` (${w}×${h})` : ''}`, active: !isAuto && cur === idx };
    });
    items.push({ id: -1, label: '⚡ Otomatik (En Yüksek HD)', active: isAuto });
    return items;
  }
  setQualityLevel(idx) {
    if (!this.hls) return;
    const n = Number(idx);
    if (n >= 0) this.hls.autoLevelCapping = -1;
    this.hls.currentLevel = n;
    this.events.onTracksChanged?.();
  }
  _reportStreamHealth(rawUrl, ok, extra = {}) {
    try {
      const u = String(rawUrl || '').trim();
      if (!u || this.isMusic || /^(blob:|data:)/i.test(u) || /itunes\.apple\.com|scdn\.co/i.test(u)) return;
      if (!this._healthSentSet) this._healthSentSet = new Set();
      const key = `${ok ? 'ok' : 'err'}:${u.slice(0, 180)}`;
      if (this._healthSentSet.has(key)) return;
      this._healthSentSet.add(key);
      fetch('/api/rave/server-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u, ok: Boolean(ok), ...extra }),
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  canCast() {
    const v = this.video;
    if (!v) return false;
    const isNativeApk = typeof navigator !== 'undefined' && (/WatchlivoApp/i.test(navigator.userAgent || '') || (/Android/i.test(navigator.userAgent || '') && /;\s*wv\b/i.test(navigator.userAgent || '')));
    if (isNativeApk) return false;
    return Boolean(typeof v.webkitShowPlaybackTargetPicker === 'function' || (v.remote && typeof v.remote.prompt === 'function'));
  }
  async promptCast() {
    const v = this.video;
    if (!v) return false;
    try {
      if (typeof v.webkitShowPlaybackTargetPicker === 'function') {
        v.webkitShowPlaybackTargetPicker();
        return 'airplay';
      }
      if (v.remote && typeof v.remote.prompt === 'function') {
        await v.remote.prompt();
        return 'cast';
      }
    } catch (e) {
      if (e && e.name === 'NotFoundError') return 'not-found';
    }
    return false;
  }
  _buildMusicPipCanvasStream(pv) {
    if (typeof document === 'undefined') return false;
    const cv = document.createElement('canvas');
    cv.width = 480;
    cv.height = 270;
    const ctx = cv.getContext('2d');
    if (!ctx || typeof cv.captureStream !== 'function') return false;
    const title = String(this.media?.songTitle || this.media?.title || 'Watchlivo Müzik').replace(/^🎵\s*/, '').slice(0, 42);
    const artist = String(this.media?.artist || this.media?.channel || 'Canlı Ses & Müzik').slice(0, 38);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const drawFrame = () => {
      const grad = ctx.createLinearGradient(0, 0, 480, 270);
      grad.addColorStop(0, '#090b16');
      grad.addColorStop(1, '#191334');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 480, 270);
      if (img.complete && img.naturalWidth > 0) {
        try { ctx.drawImage(img, 28, 45, 180, 180); } catch (_) {}
      }
      ctx.fillStyle = '#a78bfa';
      ctx.font = '700 13px system-ui, -apple-system, sans-serif';
      ctx.fillText('🎵 WATCHLIVO · PENCERE İÇİNDE PENCERE', 226, 98);
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 20px system-ui, -apple-system, sans-serif';
      ctx.fillText(title, 226, 136, 232);
      ctx.fillStyle = 'rgba(226,232,240,0.82)';
      ctx.font = '600 15px system-ui, -apple-system, sans-serif';
      ctx.fillText(artist, 226, 166, 232);
    };
    drawFrame();
    const rawPoster = String(this.media?.poster || this.media?.thumbnail || '');
    if (rawPoster) {
      img.onload = drawFrame;
      img.src = rawPoster.startsWith('http') ? `/api/rave/poster?u=${encodeURIComponent(rawPoster)}` : rawPoster;
    }
    clearInterval(this._musicPipTimer);
    this._musicPipTimer = setInterval(drawFrame, 1000);
    pv.srcObject = cv.captureStream(4);
    pv.muted = true;
    this._iosPipIsCanvasOnly = true;
    return true;
  }

  _ensureIosPipStandby(rawUrl = this.currentUrl) {
    if (!isIosWebKit() || this._destroyed || !this.container) return null;
    let pv = this.iosPipVideo;
    if (!pv) {
      pv = document.createElement('video');
      pv.className = 'wl-ios-pip-standby';
      applyOptimalPipAttributes(pv, true);
      pv.preload = 'metadata';
      pv.muted = true;
      pv.preservesPitch = true;
      pv.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.001;pointer-events:none;z-index:-1;';
      pv.addEventListener('webkitpresentationmodechanged', () => {
        if (this._destroyed || this.iosPipVideo !== pv) return;
        const inPipNow = pv.webkitPresentationMode === 'picture-in-picture';
        if (inPipNow) {
          this._iosPipActive = true;
          this._wasInPip = true;
          if (!this._iosPipIsCanvasOnly) this.subs?.syncNativeTrackToElement?.(pv, true);
          this.events.onPipChange?.(true);
        } else if (this._iosPipActive) {
          const exitT = Number(pv.currentTime || 0);
          const keepPlaying = this._iosPipIsCanvasOnly ? !this.video?.paused : (!pv.paused || this.wantPlaying);
          const wasCanvas = this._iosPipIsCanvasOnly;
          this._iosPipActive = false;
          this._wasInPip = false;
          this._lastPipExitAt = Date.now();
          if (!wasCanvas) {
            try { pv.pause(); } catch (_) {}
            pv.muted = true;
            if (this.video) {
              if (exitT > 0.5) { try { this.video.currentTime = exitT; } catch (_) {} }
              try { this.hls?.startLoad?.(exitT >= 0.5 ? exitT : -1); } catch (_) {}
              this.subs?.syncVideoVolume?.();
              if (keepPlaying) { this.wantPlaying = true; this.tryPlay(); }
            }
          }
          this.events.onPipChange?.(false);
        }
      });
      pv.addEventListener('timeupdate', () => {
        if (!this._iosPipActive || this._iosPipIsCanvasOnly || pv.seeking) return;
        if (pv.currentTime > 2) this.highestPlayedPos = Math.max(this.highestPlayedPos || 0, pv.currentTime);
        this.subs?.onTimeUpdate?.(pv.currentTime);
        if (typeof document !== 'undefined' && document.hidden && typeof window !== 'undefined') {
          window.__watchlivoBgSyncTick?.();
        }
      });
      this.container.appendChild(pv);
      this.iosPipVideo = pv;
    }
    if (this.isMusic) {
      const clipVid = String(this.media?.clipVideoId || this.media?.videoId || '');
      if (/^[A-Za-z0-9_-]{11}$/.test(clipVid) && !this.media?.live) {
        const ytHls = `/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(clipVid)}`;
        this._iosPipIsCanvasOnly = false;
        if (pv.getAttribute('data-standby-src') !== ytHls) {
          pv.srcObject = null;
          pv.setAttribute('data-standby-src', ytHls);
          pv.removeAttribute('crossorigin');
          pv.src = ytHls;
          try { pv.load(); } catch (_) {}
        }
        return pv;
      }
      if (!pv.srcObject) {
        this._buildMusicPipCanvasStream(pv);
        try { pv.play()?.catch?.(() => {}); } catch (_) {}
      }
      return pv;
    }
    this._iosPipIsCanvasOnly = false;
    const targetSrc = (this._withProxySegs && /\.m3u8(\?|$)|\/api\/rave\/stream(?:\?|_manifest\?|-proxy\/)/i.test(String(rawUrl || '')))
      ? this._withProxySegs(rawUrl)
      : String(rawUrl || '');
    if (!targetSrc || targetSrc.startsWith('blob:')) return null;
    if (pv.getAttribute('data-standby-src') !== targetSrc) {
      pv.srcObject = null;
      pv.setAttribute('data-standby-src', targetSrc);
      pv.removeAttribute('crossorigin');
      pv.src = targetSrc;
      try { pv.load(); } catch (_) {}
    }
    return pv;
  }

  _switchIosNativeToInlineMse() {
    if (isIosWebKit() || !this._canAppleMseHls || !this.useNativeHls || !this.video || this.isPiP() || !window.Hls?.isSupported?.()) return;
    const v = this.video;
    const srcUrl = this._withProxySegs ? this._withProxySegs(this.currentUrl) : this.currentUrl;
    if (!srcUrl) return;
    const curT = this.getTime();
    const wasPlaying = this.wantPlaying || !v.paused;
    this._ensureIosPipStandby(this.currentUrl);
    this._forceIosMseInline = true;
    this.useNativeHls = false;
    v.removeAttribute('x-webkit-airplay');
    try { v.disableRemotePlayback = true; } catch (_) {}
    v.crossOrigin = 'anonymous';
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
    if (typeof this._attachHlsJsInline === 'function') {
      this._attachHlsJsInline(srcUrl, () => {
        resumeSharedAudioContext();
        this.subs?.syncVideoVolume?.();
        if (wasPlaying) this.tryPlay();
      }, curT);
    }
  }

  canPiP() {
    const v = this.video;
    if (!v) return false;
    if (typeof window !== 'undefined' && (window.Android?.canPiP?.() || typeof window.Android?.enterPiP === 'function')) return true;
    return Boolean(
      (typeof document !== 'undefined' && document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function') ||
      typeof v.webkitSetPresentationMode === 'function'
    );
  }
  isPiP() {
    const v = this.video;
    const pv = this.iosPipVideo;
    return Boolean(
      this._iosPipActive ||
      (v && ((typeof document !== 'undefined' && document.pictureInPictureElement === v) || v.webkitPresentationMode === 'picture-in-picture')) ||
      (pv && ((typeof document !== 'undefined' && document.pictureInPictureElement === pv) || pv.webkitPresentationMode === 'picture-in-picture'))
    );
  }
  async togglePiP() {
    const v = this.video;
    if (!v) return false;
    ensureIosPlaybackAudioSession();
    v.disablePictureInPicture = false;
    try { v.removeAttribute?.('disablepictureinpicture'); } catch (_) {}

    if (typeof window !== 'undefined' && typeof window.Android?.enterPiP === 'function') {
      try {
        this._syncAndroidPipState(true);
        if (window.Android.enterPiP(v.videoWidth || 16, v.videoHeight || 9) !== false) {
          this.events.onPipChange?.(true);
          return 'entered';
        }
      } catch (_) {}
    }
    const nativeSrc = this._nativeIosPipSourceUrl();
    if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && typeof window.watchlivoNativePiP === 'function' && nativeSrc) {
      const absU = new URL(nativeSrc, window.location.origin).href;
      this._lastPipEnterAt = Date.now();
      if (window.watchlivoNativePiP('toggle', { url: absU, time: this.getTime(), rate: v.playbackRate || 1, playing: true, live: Boolean(this.media?.live), muted: Boolean(this.video.muted || this.userExplicitMuted || this.baseVolume <= 0) })) {
        return 'entered';
      }
    }

    if (this.iosPipVideo && (this._iosPipActive || this.iosPipVideo.webkitPresentationMode === 'picture-in-picture')) {
      this._lastPipExitAt = Date.now();
      try { this.iosPipVideo.webkitSetPresentationMode('inline'); } catch (_) {}
      return 'exited';
    }

    const audioOnlyMusic = Boolean(this.isMusic && !(v.videoWidth > 0));
    const needsIosStandbyPip = isIosWebKit() && typeof v.webkitSetPresentationMode === 'function' && (Boolean(this.hls) || hasWebAudioGraph(v) || audioOnlyMusic);
    if (needsIosStandbyPip && v.webkitPresentationMode !== 'picture-in-picture') {
      const pv = this._ensureIosPipStandby(this.currentUrl);
      if (pv) {
        if (pv.readyState >= 1 && (!pv.webkitSupportsPresentationMode || pv.webkitSupportsPresentationMode('picture-in-picture'))) {
          this._iosPipActive = true;
          this._lastPipEnterAt = Date.now();
          if (!this._iosPipIsCanvasOnly) {
            const curT = this.getTime();
            if (curT > 0.5 && Math.abs((pv.currentTime || 0) - curT) > 0.8) {
              try { pv.currentTime = curT; } catch (_) {}
            }
            pv.muted = Boolean(this.userExplicitMuted || this.baseVolume <= 0);
            pv.playbackRate = v.playbackRate || 1;
            this.subs?.syncNativeTrackToElement?.(pv, true);
            this._suppressInlinePauseOnce = true;
            try { v.pause(); } catch (_) {}
            try { this.hls?.stopLoad?.(); } catch (_) {}
          } else if (v.paused && this.wantPlaying !== false) {
            try { v.play()?.catch?.(() => {}); } catch (_) {}
          }
          try { pv.play()?.catch?.(() => {}); } catch (_) {}
          try {
            pv.webkitSetPresentationMode('picture-in-picture');
            this.events.onPipChange?.(true);
            return 'entered';
          } catch (err) {
            this._iosPipActive = false;
            if (!this._iosPipIsCanvasOnly) {
              try { pv.pause(); } catch (_) {}
              try { this.hls?.startLoad?.(-1); } catch (_) {}
              if (this.wantPlaying) this.tryPlay();
            }
          }
        } else {
          try { pv.load(); } catch (_) {}
          if (typeof window !== 'undefined' && typeof window.watchlivoNativePiP === 'function' && this.currentUrl && !this.currentUrl.startsWith('blob:')) {
            const absU = new URL(this._withProxySegs ? this._withProxySegs(this.currentUrl) : this.currentUrl, window.location.origin).href;
            if (window.watchlivoNativePiP('start', { url: absU, time: this.getTime(), rate: v.playbackRate || 1 })) return 'entered';
          }
          return 'loading';
        }
      }
    }

    if (typeof v.webkitSetPresentationMode === 'function') {
      try {
        if (v.webkitPresentationMode === 'picture-in-picture') {
          this._lastPipExitAt = Date.now();
          v.webkitSetPresentationMode('inline');
          this.subs?._disableAllNativeTextTracks?.();
          this.events.onPipChange?.(false);
          return 'exited';
        }
        if (v.readyState >= 1 && (!v.webkitSupportsPresentationMode || v.webkitSupportsPresentationMode('picture-in-picture'))) {
          if (v.paused && this.wantPlaying !== false) {
            try { v.play()?.catch?.(() => {}); } catch (_) {}
          }
          this.subs?.syncNativeTrackToElement?.(v, true);
          v.webkitSetPresentationMode('picture-in-picture');
          this.events.onPipChange?.(true);
          return 'entered';
        }
        if (v.readyState < 1) {
          try { v.play()?.catch?.(() => {}); } catch (_) {}
          if (typeof window !== 'undefined' && typeof window.watchlivoNativePiP === 'function' && this.currentUrl && !this.currentUrl.startsWith('blob:')) {
            const absU = new URL(this._withProxySegs ? this._withProxySegs(this.currentUrl) : this.currentUrl, window.location.origin).href;
            if (window.watchlivoNativePiP('start', { url: absU, time: this.getTime(), rate: v.playbackRate || 1 })) return 'entered';
          }
          return 'loading';
        }
      } catch (e) { /* try native bridge / standard PiP API below */ }
    }
    if (typeof window !== 'undefined' && typeof window.watchlivoNativePiP === 'function' && this.currentUrl && !this.currentUrl.startsWith('blob:')) {
      const absU = new URL(this._withProxySegs ? this._withProxySegs(this.currentUrl) : this.currentUrl, window.location.origin).href;
      if (window.watchlivoNativePiP('start', { url: absU, time: this.getTime(), rate: v.playbackRate || 1 })) return 'entered';
    }
    try {
      if (typeof document !== 'undefined' && document.pictureInPictureElement === v) {
        this._lastPipExitAt = Date.now();
        await document.exitPictureInPicture();
        this.subs?._disableAllNativeTextTracks?.();
        this.events.onPipChange?.(false);
        return 'exited';
      }
      if (typeof v.requestPictureInPicture === 'function' && (typeof document === 'undefined' || document.pictureInPictureEnabled !== false)) {
        if (v.readyState >= 1) {
          this.subs?.syncNativeTrackToElement?.(v, true);
          await v.requestPictureInPicture();
          this.events.onPipChange?.(true);
          return 'entered';
        }
        return 'loading';
      }
    } catch (e) { /* fallback handled by caller */ }
    return false;
  }
  async _requestWakeLock() {
    if (typeof navigator === 'undefined' || !navigator.wakeLock?.request) return;
    try {
      if (this._wakeLock) return;
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener?.('release', () => { this._wakeLock = null; });
    } catch (e) { /* ignore */ }
  }
  _releaseWakeLock() {
    if (this._wakeLock) {
      try { this._wakeLock.release(); } catch (e) { /* ignore */ }
      this._wakeLock = null;
    }
  }
  destroy() {
    this._releaseWakeLock();
    if (this._visHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
    if (this._pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }
    this._destroyed = true;
    this.wantPlaying = false;
    clearTimeout(this.loadReadyTimer);
    this._loadDoneResolve?.();
    clearInterval(this.subTickTimer);
    clearTimeout(this.waitTimer);
    clearTimeout(this.resumeTimer);
    clearTimeout(this._pipPauseTimer);
    clearTimeout(this.watchdogTimer);
    this._syncAndroidPipState(false);
    if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && !window.__kinoxHost?._nativeIosPipActive) {
      try { window.watchlivoNativePiP?.('stop', {}); } catch (_) {}
    }
    clearInterval(this.playbackWatchdog);
    setReferrerMeta('strict-origin-when-cross-origin');
    this.subs.stopDubAudio();
    this.subs.destroy();
    if (this.vinylBtn) { try { this.vinylBtn.remove(); } catch (e) { /* ignore */ } this.vinylBtn = null; }
    if (this.bgMvEl) { try { this.bgMvEl.pause(); this.bgMvEl.removeAttribute('src'); this.bgMvEl.remove(); } catch (e) { /* ignore */ } this.bgMvEl = null; }
    if (this.bgYtEl) { try { this.bgYtEl.removeAttribute('src'); this.bgYtEl.remove(); } catch (e) { /* ignore */ } this.bgYtEl = null; }
    if (this.mashupHlsB) { try { this.mashupHlsB.detachMedia(); this.mashupHlsB.destroy(); } catch (e) { /* ignore */ } this.mashupHlsB = null; }
    if (this.mashupDeckB) { try { this.mashupDeckB.pause(); this.mashupDeckB.removeAttribute('src'); this.mashupDeckB.remove(); } catch (e) { /* ignore */ } this.mashupDeckB = null; }
    clearInterval(this._musicPipTimer);
    if (this.iosPipVideo) {
      try {
        this.iosPipVideo.pause();
        this.iosPipVideo.srcObject = null;
        this.iosPipVideo.removeAttribute('src');
        this.iosPipVideo.remove();
      } catch (e) { /* ignore */ }
      this.iosPipVideo = null;
    }
    if (this.video) {
      try {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
      } catch (e) { /* ignore */ }
    }
    if (this.hls) {
      try { this.hls.detachMedia(); } catch (e) { /* ignore */ }
      try { this.hls.destroy(); } catch (e) { /* ignore */ }
      this.hls = null;
    }
    this.video = null;
    this.container.replaceChildren();
  }
}
