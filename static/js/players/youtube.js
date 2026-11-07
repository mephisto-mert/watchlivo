// YouTube Ad-Free Direct HTML5/HLS/fMP4 Engine + Music Vinyl Visualizer (with youtube-nocookie.com fallback).
import { SubtitleDubController } from './subtitles.js?v=20261107_v137';
import { applyElementVolume, ensureIosPlaybackAudioSession, isIosWebKit, resumeSharedAudioContext } from './audio-gain.js?v=20261107_v137';
import { ensureHlsJs } from './hls-loader.js?v=20261107_v137';

let apiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('YouTube API yüklenemedi')); };
    document.head.append(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { apiPromise = null; reject(new Error('YouTube API zaman aşımı')); } }, 12000);
  });
  return apiPromise;
}

function waitForHlsJs(timeoutMs = 1800) {
  if (typeof window === 'undefined' || window.Hls || isIosWebKit()) return Promise.resolve(Boolean(window?.Hls));
  return ensureHlsJs(Math.max(timeoutMs, 4500));
}

function applyOptimalPipAttrs(v) {
  if (!v) return;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('x-webkit-airplay', 'allow');
  v.disablePictureInPicture = false;
  try { v.removeAttribute('disablepictureinpicture'); } catch (_) {}
  try { v.disableRemotePlayback = false; } catch (_) {}
  try {
    const autoPipOn = localStorage.getItem('vortex_auto_pip') !== 'off';
    v.autoPictureInPicture = autoPipOn;
    if (autoPipOn) {
      v.setAttribute('autopictureinpicture', '');
      v.setAttribute('allowsPictureInPicture', 'true');
    }
  } catch (_) {}
}

export class YouTubeAdapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.video = null;
    this.hls = null;
    this.useNativeHls = false;
    this.player = null;
    this.audioEl = null;
    this.vinylOverlay = null;
    this.vinylBtn = null;
    this.vinylMode = false;
    this.pipVideo = null;
    this._pipActive = false;
    this.ready = false;
    this.baseVolume = isIosWebKit() ? 100 : 80;
    this._muted = false;
    this.userExplicitMuted = false;
    this.autoplayTimer = null;
    this.stallTimer = null;
    this.subTimer = null;
    this._visHandler = null;
    this._pageHideHandler = null;
    this.media = null;
    this.altQueue = [];
    this.subs = new SubtitleDubController(this);
    this.caps = { seek: true, rate: true, rateSteps: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], overlayClicks: true, live: false, subtitles: true };
  }

  async load(media, startAt = 0, autoplay = true) {
    this.media = media || {};
    this.loadedAtMs = Date.now();
    this.wantPlaying = Boolean(autoplay);
    this.altQueue = Array.isArray(media?.altVideoIds) ? [...media.altVideoIds] : [];
    if (media?.live) { this.caps.live = true; this.caps.seek = false; }
    const rawId = String(media?.videoId || '');
    const urlId = (String(media?.url || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/) || [])[1];
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(rawId) ? rawId : (urlId || rawId);
    this.media.videoId = videoId;
    ensureIosPlaybackAudioSession();

    const mount = document.createElement('div');
    mount.className = 'yt-mount';
    mount.style.cssText = 'position:relative;width:100%;height:100%;background:transparent;';
    this.container.replaceChildren(mount);

    if (media?.isMusic) this._mountVinylOverlay(media);
    this.subs.initForMedia({ ...this.media, videoId, provider: this.media.provider || 'youtube' }).then(() => {
      if (media?.isMusic && this.subs.subtitleTracks?.length) {
        this.subs.setSubtitleTrack(this.subs.subtitleTracks[0].id);
      }
      this._syncYtNativeCaptions();
      this.events.onTracksChanged?.();
    }).catch(() => {});
    clearInterval(this.subTimer);
    this.subTimer = setInterval(() => {
      if (this.ready && !this.isPaused()) this.subs.onTimeUpdate(this.getTime());
    }, 150);

    const candidateIds = /^[A-Za-z0-9_-]{11}$/.test(videoId)
      ? [videoId, ...this.altQueue.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(String(id || '')))]
      : [];

    for (const candVid of candidateIds) {
      if (this._destroyed) return;
      const ok = await this._tryLoadDirectAdFreeVideo(mount, candVid, startAt, autoplay);
      if (ok) {
        this.media.videoId = candVid;
        return;
      }
    }

    this._teardownDirectVideo();
    mount.style.background = '#000';
    if (isIosWebKit() && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      this._ensureIosPipBridge(videoId);
    }
    await this._loadNoCookieIframeFallback(mount, videoId, startAt, autoplay);
  }

  _teardownDirectVideo() {
    if (this._visHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
    if (this._pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }
    if (this.hls) {
      try { this.hls.destroy(); } catch (_) {}
      this.hls = null;
    }
    if (this.video) {
      try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video.remove(); } catch (_) {}
      this.video = null;
    }
    this.useNativeHls = false;
  }

  _attemptDirectPlay(v) {
    if (!v || this._destroyed || this.video !== v) return;
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        if (this._destroyed || this.video !== v || !this.wantPlaying) return;
        v.muted = true;
        this._muted = true;
        this.events.onAutoplayBlocked?.();
        v.play().catch(() => {});
      });
    }
  }

  async _tryLoadDirectAdFreeVideo(mount, videoId, startAt = 0, autoplay = true) {
    this._teardownDirectVideo();
    await waitForHlsJs(1800);
    if (this._destroyed) return false;

    const streamCandidates = [];
    if (typeof window !== 'undefined' && typeof window.watchlivoResolveYouTube === 'function') {
      try {
        const sd = await Promise.race([
          window.watchlivoResolveYouTube(videoId),
          new Promise((r) => setTimeout(() => r(null), 2200)),
        ]);
        if (sd) {
          if (sd.hlsManifestUrl) streamCandidates.push(sd.hlsManifestUrl);
          const fmts = Array.isArray(sd.formats) ? sd.formats : [];
          const muxed = (fmts.find((f) => f?.itag === 22 && f?.url) || fmts.find((f) => f?.itag === 18 && f?.url))?.url || '';
          if (muxed) streamCandidates.push(muxed);
        }
      } catch (_) {}
    }
    const srvHls = `/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(videoId)}${this.media?.live ? '&live=1' : ''}`;
    if (!this.media?.live) {
      streamCandidates.push(`/api/rave/yt-music-stream?v=${encodeURIComponent(videoId)}&kind=muxed`);
    }
    streamCandidates.push(srvHls);

    const v = document.createElement('video');
    v.className = 'yt-adfree-video';
    applyOptimalPipAttrs(v);
    v.preload = 'auto';
    v.preservesPitch = true;
    const rawPoster = String(this.media?.thumbnail || this.media?.poster || '').trim();
    if (rawPoster) {
      v.poster = /^https?:\/\//i.test(rawPoster) ? `/api/rave/poster?url=${encodeURIComponent(rawPoster)}` : rawPoster;
    }
    v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:transparent;display:block;';
    mount.replaceChildren(v);
    this.video = v;

    const validStart = (!this.media?.live && Number.isFinite(startAt) && startAt > 0.5) ? Number(startAt) : 0;

    v.addEventListener('playing', () => {
      if (this._destroyed || this.video !== v) return;
      this.ready = true;
      if (this.bgMvEl && !this.vinylMode) { try { this.bgMvEl.pause(); this.bgMvEl.style.display = 'none'; } catch (_) {} }
      this._syncPipBridgeState(true);
      this.events.onBuffering?.(false);
      this.events.onPlay?.();
    });
    v.addEventListener('waiting', () => {
      if (!this._destroyed && this.video === v && this.wantPlaying) this.events.onBuffering?.(true);
    });
    v.addEventListener('pause', () => {
      if (this._destroyed || this.video !== v || v.ended) return;
      if (this._suppressYtPauseOnce || this._pipActive || (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive)) {
        this._suppressYtPauseOnce = false;
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && this.wantPlaying && !this._userPausedViaMediaSession) {
        let bgOk = true;
        try { bgOk = localStorage.getItem('vortex_bg_audio') !== 'off'; } catch (_) {}
        if (bgOk) {
          setTimeout(() => {
            if (!this._destroyed && this.video === v && this.wantPlaying && !this._userPausedViaMediaSession && v.paused && !v.ended) {
              ensureIosPlaybackAudioSession();
              v.play().catch(() => {});
            }
          }, 150);
        }
        return;
      }
      this._syncPipBridgeState(false);
      this.events.onBuffering?.(false);
      this.events.onPause?.();
    });
    v.addEventListener('ended', () => {
      if (this._destroyed || this.video !== v) return;
      this.wantPlaying = false;
      this.events.onBuffering?.(false);
      this.events.onEnded?.();
    });
    v.addEventListener('volumechange', () => {
      if (!v.paused && !v.muted && v.volume > 0) this.events.onUnmuted?.();
    });
    v.addEventListener('enterpictureinpicture', () => {
      this._pipActive = true;
      this.events.onPipChange?.(true);
    });
    v.addEventListener('leavepictureinpicture', () => {
      this._pipActive = false;
      this.subs?._disableAllNativeTextTracks?.();
      if (this.wantPlaying && v.paused && !v.ended) v.play().catch(() => {});
      this.events.onPipChange?.(false);
    });
    v.addEventListener('webkitpresentationmodechanged', () => {
      if (this._destroyed || this.video !== v) return;
      const inPipNow = v.webkitPresentationMode === 'picture-in-picture';
      this._pipActive = inPipNow;
      this.subs?.syncNativeTrackToElement?.(v, inPipNow);
      if (!inPipNow && this.wantPlaying && v.paused && !v.ended) v.play().catch(() => {});
      this.events.onPipChange?.(inPipNow);
    });

    this._visHandler = () => {
      if (this._destroyed || this.video !== v) return;
      if (document.visibilityState === 'visible') {
        if (this.wantPlaying && !this._userPausedViaMediaSession && v.paused && !v.ended) {
          v.play().catch(() => {});
        }
      } else if (document.visibilityState === 'hidden' && this.wantPlaying && !v.ended && !this._userPausedViaMediaSession) {
        ensureIosPlaybackAudioSession();
        let bgOk = true;
        try { bgOk = localStorage.getItem('vortex_bg_audio') !== 'off'; } catch (_) {}
        if (bgOk && v.paused) v.play().catch(() => {});
        this.enterAutoPiP?.('visibilitychange')?.catch?.(() => {});
      }
    };
    this._pageHideHandler = () => {
      if (this._destroyed || this.video !== v) return;
      if (this.wantPlaying && !v.ended) {
        this.enterAutoPiP?.('pagehide')?.catch?.(() => {});
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._visHandler);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this._pageHideHandler);

    for (const srcUrl of streamCandidates) {
      if (this._destroyed || this.video !== v) return false;
      const loaded = await this._attachDirectCandidate(v, srcUrl, validStart, autoplay);
      if (loaded) return true;
    }
    return false;
  }

  _attachDirectCandidate(v, srcUrl, validStart = 0, autoplay = true) {
    if (this.hls) {
      try { this.hls.destroy(); } catch (_) {}
      this.hls = null;
    }
    const isHls = /\.m3u8(\?|$)/i.test(String(srcUrl || '')) || String(srcUrl || '').includes('yt-pip-hls.m3u8');
    const canNativeHls = Boolean(v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL'));
    const useNative = isHls && (isIosWebKit() || (!window.Hls?.isSupported?.() && canNativeHls));
    this.useNativeHls = useNative;

    if (!isIosWebKit() && String(srcUrl || '').startsWith('/api/rave/')) {
      v.crossOrigin = 'anonymous';
    } else {
      v.removeAttribute('crossorigin');
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', onOk);
        v.removeEventListener('canplay', onOk);
        v.removeEventListener('error', onFail);
      };
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok && !this._destroyed && this.video === v) {
          const effTarget = (this.initialSeekPending && this.initialSeekPending > 0.5) ? this.initialSeekPending : validStart;
          if (effTarget > 0.5 && !this.media?.live && Math.abs((v.currentTime || 0) - effTarget) > 1.2) {
            try { v.currentTime = effTarget; } catch (_) {}
          }
          this.initialSeekPending = 0;
          this.ready = true;
          this.subs?.syncVideoVolume?.();
          this.events.onBuffering?.(false);
          this.events.onReady?.();
          if (autoplay && this.wantPlaying) this._attemptDirectPlay(v);
        }
        resolve(ok);
      };
      const onOk = () => finish(true);
      const onFail = () => finish(false);

      v.addEventListener('loadedmetadata', onOk, { once: true });
      v.addEventListener('canplay', onOk, { once: true });
      v.addEventListener('error', onFail, { once: true });
      timer = setTimeout(() => finish(false), 6800);

      if (isHls && !useNative && window.Hls?.isSupported?.()) {
        let mediaRecovered = false;
        const effHlsStart = (this.initialSeekPending && this.initialSeekPending > 0.5) ? this.initialSeekPending : validStart;
        const hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: Boolean(this.media?.live),
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          startPosition: effHlsStart > 0.5 ? effHlsStart : -1,
        });
        this.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          if (autoplay && this.wantPlaying && !this._destroyed && this.video === v) {
            this._attemptDirectPlay(v);
          }
        });
        hls.on(window.Hls.Events.FRAG_BUFFERED, () => finish(true));
        hls.on(window.Hls.Events.ERROR, (_ev, data) => {
          if (!data?.fatal) return;
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
            mediaRecovered = true;
            try { hls.recoverMediaError(); return; } catch (_) {}
          }
          finish(false);
        });
        hls.loadSource(srcUrl);
        hls.attachMedia(v);
      } else if (!isHls || useNative) {
        v.src = srcUrl;
        try { v.load(); } catch (_) {}
      } else {
        finish(false);
      }
    });
  }

  async _loadNoCookieIframeFallback(mount, videoId, startAt = 0, autoplay = true) {
    try {
      await loadYouTubeApi();
    } catch (err) {
      if (this.media?.audioPreviewUrl || this.media?.isMusic) {
        this._activateAudioFallback(startAt, autoplay);
        return;
      }
      throw err;
    }
    if (this._destroyed) return;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      this.player = new window.YT.Player(mount, {
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        videoId,
        playerVars: { autoplay: autoplay ? 1 : 0, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, cc_load_policy: 0, fs: 0, start: Math.floor(startAt), origin: location.origin },
        events: {
          onReady: () => {
            if (this._destroyed) return;
            this.ready = true;
            try {
              this.player?.unMute?.();
              this.player?.setVolume?.(this.baseVolume);
              this.player?.setPlaybackQualityRange?.('hd1080', 'highres');
              this.player?.setPlaybackQuality?.('hd1080');
            } catch (_) {}
            this._syncYtNativeCaptions();
            done();
            this.events.onBuffering?.(false);
            this.events.onReady?.();
            if (autoplay) {
              this.autoplayTimer = setTimeout(() => {
                const st = this.player?.getPlayerState?.();
                if (st === -1 || st === 5 || st === 2) {
                  this.player?.mute?.();
                  this.events.onAutoplayBlocked?.();
                  this.player?.playVideo?.();
                }
              }, 1400);
            }
          },
          onStateChange: (e) => {
            if (this._destroyed) return;
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
              clearTimeout(this.autoplayTimer);
              this._syncYtNativeCaptions();
              this._syncPipBridgeState(true);
              this.events.onBuffering?.(false);
              this.events.onPlay?.();
            } else if (e.data === S.PAUSED) {
              if (this._suppressYtPauseOnce || this._pipActive || (typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive)) {
                this._suppressYtPauseOnce = false;
                return;
              }
              this._syncPipBridgeState(false);
              this.events.onBuffering?.(false);
              this.events.onPause?.();
            } else if (e.data === S.BUFFERING) this.events.onBuffering?.(true);
            else if (e.data === S.ENDED) { this.events.onBuffering?.(false); this.events.onEnded?.(); }
          },
          onError: (e) => {
            if (this.altQueue.length > 0 && this.player?.loadVideoById) {
              const nextVid = this.altQueue.shift();
              try { this.player.loadVideoById(nextVid, Math.floor(this.getTime() || startAt)); done(); return; } catch (_) {}
            }
            if (this.media?.audioPreviewUrl || this.media?.isMusic) {
              done();
              this._activateAudioFallback(startAt, autoplay);
              return;
            }
            done();
            this.events.onError?.(`YouTube oynatıcı hatası (${e.data})`);
          },
        },
      });
      setTimeout(done, 9000);
    });
  }

  _syncYtNativeCaptions() {
    if (!this.player) return;
    try {
      const tl = this.player?.getOption?.('captions', 'tracklist') || this.player?.getOption?.('cc', 'tracklist');
      if (Array.isArray(tl) && tl.length && this.subs) {
        let added = false;
        tl.forEach((nt, idx) => {
          const lc = String(nt.languageCode || '').toLowerCase();
          if (!lc) return;
          const exists = this.subs.subtitleTracks.some((st) => String(st.lang || '').toLowerCase() === lc);
          if (!exists) {
            const dn = nt.displayName || nt.languageName || lc.toUpperCase();
            this.subs.subtitleTracks.push({
              id: `yt-native-${lc}-${idx}`,
              lang: lc,
              label: `🎬 ${dn} (YouTube Altyazı)`,
              source: 'youtube-native',
              ytNativeLang: lc,
            });
            added = true;
          }
        });
        if (added) this.events.onTracksChanged?.();
      }
    } catch (_) {}

    const selId = this.subs?.selectedSubId || 'off';
    const curTrack = (this.subs?.subtitleTracks || []).find((t) => t.id === selId);
    const hasCustomCues = Array.isArray(this.subs?.subCues) && this.subs.subCues.length > 0;
    if (selId === 'off' || hasCustomCues || !curTrack?.ytNativeLang) {
      try { this.player?.setOption?.('captions', 'track', {}); } catch (_) {}
      try { this.player?.setOption?.('cc', 'track', {}); } catch (_) {}
      try { this.player?.unloadModule?.('captions'); } catch (_) {}
      try { this.player?.unloadModule?.('cc'); } catch (_) {}
    } else if (curTrack?.ytNativeLang) {
      try { this.player?.loadModule?.('captions'); } catch (_) {}
      try { this.player?.setOption?.('captions', 'track', { languageCode: curTrack.ytNativeLang }); } catch (_) {}
    }
  }

  _mountVinylOverlay(media) {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const cover = esc(media.poster || media.thumbnail || '/static/watchlivo-poster.svg');
    const title = esc((media.songTitle || media.title || 'Müzik & Klip').replace(/^🎵\s*/, ''));
    const artist = esc(media.artist || media.channel || 'Sanatçı');
    const wrap = document.createElement('div');
    wrap.className = 'music-vinyl-stage';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="music-vinyl-bg" style="background-image:url('${cover}')"></div>
      <div class="music-vinyl-card">
        <div class="music-vinyl-disc">
          <img src="${cover}" alt="" />
          <span class="music-vinyl-hole"></span>
        </div>
        <div class="music-vinyl-meta">
          <span class="music-vinyl-badge">🎵 WATCHLIVO HI-FI MÜZİK & KLİP SAHNESİ</span>
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
    toggleBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleVinylMode(); };
    const clipSrc = (media.mvUrl && /\.m4v(\?|$)/i.test(String(media.mvUrl))) ? media.mvUrl : '';
    let bgMvEl = null;
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
      bgMvEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:3;pointer-events:none;display:none;';
      this.container.append(bgMvEl);
    }
    this.bgMvEl = bgMvEl;
    this.container.append(wrap);
    const frameParent = this.container.parentElement || this.container;
    frameParent.querySelectorAll('#btn-toggle-vinyl-mode').forEach((b) => b.remove());
    frameParent.append(toggleBtn);
    this.vinylOverlay = wrap;
    this.vinylBtn = toggleBtn;
  }

  toggleVinylMode(force) {
    if (!this.vinylOverlay) return false;
    this.vinylMode = typeof force === 'boolean' ? force : !this.vinylMode;
    this.vinylOverlay.style.display = this.vinylMode ? 'flex' : 'none';
    if (this.bgMvEl) {
      const showBgMv = !this.vinylMode && Boolean(this.audioEl) && !this.video;
      this.bgMvEl.style.display = showBgMv ? 'block' : 'none';
      if (showBgMv) this.bgMvEl.play().catch(() => {});
      else this.bgMvEl.pause();
    }
    if (this.vinylBtn) {
      this.vinylBtn.textContent = this.vinylMode ? '🎬 Klip Modu' : '💿 Plak Modu';
      this.vinylBtn.classList.toggle('active', this.vinylMode);
    }
    return this.vinylMode;
  }

  _activateAudioFallback(startAt = 0, autoplay = true) {
    this._teardownDirectVideo();
    this.toggleVinylMode(true);
    if (this.audioEl) return;
    const a = document.createElement('audio');
    a.preload = 'auto';
    const fbSrc = this.media?.audioPreviewUrl
      || (Array.isArray(this.media?.altUrls) && this.media.altUrls[0])
      || (this.media?.videoId ? `/api/rave/yt-music-stream?v=${encodeURIComponent(this.media.videoId)}` : '');
    if (String(fbSrc || '').startsWith('/api/rave/')) a.crossOrigin = 'anonymous';
    if (fbSrc) a.src = fbSrc;
    a.currentTime = Math.max(0, startAt);
    applyElementVolume(a, this.baseVolume ?? 80, Boolean(this._muted));
    a.addEventListener('playing', () => { this.ready = true; this.events.onBuffering?.(false); this.events.onPlay?.(); });
    a.addEventListener('pause', () => this.events.onPause?.());
    a.addEventListener('ended', () => this.events.onEnded?.());
    this.container.append(a);
    this.audioEl = a;
    this.ready = true;
    this.events.onReady?.();
    if (autoplay && a.src) {
      a.play().catch(() => { a.muted = true; this.events.onAutoplayBlocked?.(); a.play().catch(() => {}); });
    } else {
      this.events.onPlay?.();
    }
  }

  getSubtitleTracks() { return this.subs?.subtitleTracks || []; }
  getSelectedSubtitleId() { return this.subs?.selectedSubId || 'off'; }
  getActiveSubtitleTrack() { return this.subs?.selectedSubId || 'off'; }
  setSubtitleTrack(id) {
    return this.subs?.setSubtitleTrack(id).then((res) => {
      this._syncYtNativeCaptions();
      this.events.onTracksChanged?.();
      return res;
    });
  }
  getAudioTracks() { return this.subs?.audioTracks || []; }
  getSelectedAudioId() { return this.subs?.selectedAudioId || 'orig'; }
  setAudioTrack(id) { return this.subs?.setAudioTrack(id); }
  getSubtitleOffset() { return this.subs?.offsetSec || 0; }
  setSubtitleOffset(deltaOrVal, absolute = false) { return this.subs?.setSubtitleOffset(deltaOrVal, absolute) || 0; }
  getSubtitleFpsScale() { return this.subs?.fpsScale || 1.0; }
  setSubtitleFpsScale(scale = 1.0) { return this.subs?.setSubtitleFpsScale(scale) || 1.0; }
  isDualSubtitleEnabled() { return false; }
  setDualSubtitle() { return Promise.resolve(false); }

  _syncNativeIosPip(playing) { this._syncPipBridgeState(Boolean(playing)); }

  _syncPipBridgeState(playing) {
    if (this._destroyed) return;
    if (this.video && !this.pipVideo) {
      if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && typeof window.watchlivoNativePiP === 'function') {
        const rawSrc = this.video.currentSrc || this.video.src || (this.media?.videoId ? `/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(this.media.videoId)}` : '');
        if (rawSrc && !String(rawSrc).startsWith('blob:')) {
          try {
            const absU = new URL(rawSrc, window.location.origin).href;
            const r = this.container?.getBoundingClientRect?.() || { left: 0, top: 80, width: 360, height: 202 };
            window.watchlivoNativePiP(playing ? 'sync' : 'pause', {
              url: absU,
              time: this.getTime(),
              rate: this.getRate() || 1,
              playing: Boolean(playing),
              muted: Boolean(this._muted || this.baseVolume <= 0),
              rect: { x: Math.round(r.left || 0), y: Math.round(r.top || 80), width: Math.max(240, Math.round(r.width || 360)), height: Math.max(135, Math.round(r.height || 202)) },
            });
          } catch (_) {}
        }
      }
      return;
    }

    const pv = this.pipVideo;
    if (!pv || this._pipActive) return;
    const curT = this.getTime();
    if (!this.media?.live && curT > 0.5 && pv.readyState >= 1 && Math.abs((pv.currentTime || 0) - curT) > 1.6) {
      try { pv.currentTime = curT; } catch (_) {}
    }
    pv.muted = true;
    pv.playbackRate = this.getRate() || 1;
    if (playing && pv.src) pv.play?.().catch?.(() => {});
    else if (!playing && !pv.paused) { try { pv.pause(); } catch (_) {} }
    if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && typeof window.watchlivoNativePiP === 'function' && pv.src) {
      try {
        const absU = new URL(pv.src, window.location.origin).href;
        const r = this.container?.getBoundingClientRect?.() || { left: 0, top: 80, width: 360, height: 202 };
        window.watchlivoNativePiP(playing ? 'sync' : 'pause', {
          url: absU,
          time: curT,
          rate: this.getRate() || 1,
          playing: Boolean(playing),
          muted: Boolean(this._muted || this.baseVolume <= 0),
          rect: { x: Math.round(r.left || 0), y: Math.round(r.top || 80), width: Math.max(240, Math.round(r.width || 360)), height: Math.max(135, Math.round(r.height || 202)) },
        });
      } catch (_) {}
    }
  }

  _ensureIosPipBridge(videoId) {
    if (!isIosWebKit() || this._destroyed || typeof document === 'undefined') return null;
    if (this.video) return this.video;
    let pv = this.pipVideo;
    if (!pv) {
      pv = document.createElement('video');
      pv.className = 'wl-ios-pip-standby yt-ios-pip-proxy';
      applyOptimalPipAttrs(pv);
      pv.preload = 'auto';
      pv.muted = true;
      pv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0.001;pointer-events:none;z-index:2;object-fit:contain;';
      pv.addEventListener('webkitpresentationmodechanged', () => {
        if (this._destroyed || this.pipVideo !== pv) return;
        const inPipNow = pv.webkitPresentationMode === 'picture-in-picture';
        if (inPipNow) {
          this._pipActive = true;
          const ytCur = Number(this.player?.getCurrentTime?.() || this.audioEl?.currentTime || 0);
          if (!this.media?.live && ytCur > 0.5 && Math.abs((pv.currentTime || 0) - ytCur) > 1.2) {
            try { pv.currentTime = ytCur; } catch (_) {}
          }
          pv.muted = Boolean(this._muted || this.baseVolume <= 0);
          this._suppressYtPauseOnce = true;
          try { this.player?.pauseVideo?.(); } catch (_) {}
          try { this.audioEl?.pause?.(); } catch (_) {}
          pv.play?.().catch?.(() => {});
          this.subs?.syncNativeTrackToElement?.(pv, true);
          this.events.onPipChange?.(true);
        } else if (this._pipActive) {
          const resumeT = Number(pv.currentTime || 0);
          const keepPlaying = !pv.paused || this.wantPlaying;
          this._pipActive = false;
          pv.muted = true;
          if (!keepPlaying) { try { pv.pause(); } catch (_) {} }
          if (this.audioEl) {
            if (resumeT > 0.5) { try { this.audioEl.currentTime = resumeT; } catch (_) {} }
            if (keepPlaying) this.audioEl.play().catch(() => {});
          } else if (this.player) {
            if (resumeT > 0.5) { try { this.player.seekTo?.(resumeT, true); } catch (_) {} }
            if (keepPlaying) { try { this.player.playVideo?.(); } catch (_) {} }
          }
          this.events.onPipChange?.(false);
        }
      });
      (this.container || document.body).appendChild(pv);
      this.pipVideo = pv;
    } else if (this.container && pv.parentElement !== this.container) {
      this.container.appendChild(pv);
    }
    const srvHls = `/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(videoId)}${this.media?.live ? '&live=1' : ''}`;
    if (pv.getAttribute('data-yt-vid') !== videoId) {
      pv.setAttribute('data-yt-vid', videoId);
      const applyCandidate = (bestUrl) => {
        if (!bestUrl || this._destroyed || this._pipActive || this.pipVideo !== pv) return false;
        if (pv.src === bestUrl) return true;
        pv.src = bestUrl;
        try { pv.load(); } catch (_) {}
        if (this.wantPlaying && !this.isPaused()) this._syncPipBridgeState(true);
        return true;
      };
      applyCandidate(srvHls);
      if (typeof window !== 'undefined' && typeof window.watchlivoResolveYouTube === 'function') {
        window.watchlivoResolveYouTube(videoId).then((sd) => {
          if (this._destroyed || this._pipActive || this.pipVideo !== pv || !sd) return;
          const directHls = sd.hlsManifestUrl || '';
          const fmts = Array.isArray(sd.formats) ? sd.formats : [];
          const muxed = (fmts.find((f) => f?.itag === 22 && f?.url) || fmts.find((f) => f?.itag === 18 && f?.url))?.url || '';
          applyCandidate(directHls || muxed);
        }).catch(() => {});
      }
    }
    return pv;
  }

  canPiP() {
    if (this.video) {
      if (typeof document !== 'undefined' && document.pictureInPictureEnabled && typeof this.video.requestPictureInPicture === 'function') return true;
      if (typeof this.video.webkitSetPresentationMode === 'function') return true;
    }
    if (typeof window !== 'undefined' && (window.isWatchlivoNativeIOS || window.Android?.canPiP?.())) return true;
    if (!isIosWebKit()) return false;
    return Boolean(this.media?.videoId && /^[A-Za-z0-9_-]{11}$/.test(String(this.media.videoId)));
  }

  isPiP() {
    if (typeof document !== 'undefined' && this.video && document.pictureInPictureElement === this.video) return true;
    if (this.video && this.video.webkitPresentationMode === 'picture-in-picture') return true;
    return Boolean(this._pipActive || (this.pipVideo && this.pipVideo.webkitPresentationMode === 'picture-in-picture'));
  }

  async enterAutoPiP() {
    try { if (localStorage.getItem('vortex_auto_pip') === 'off') return false; } catch (_) {}
    if (this.isPiP()) return 'already-pip';
    if (this.video) {
      if (typeof document !== 'undefined' && document.pictureInPictureEnabled && typeof this.video.requestPictureInPicture === 'function' && this.video.readyState >= 1) {
        try { await this.video.requestPictureInPicture(); return 'entered'; } catch (_) {}
      }
      if (typeof this.video.webkitSetPresentationMode === 'function' && this.video.readyState >= 1) {
        try { this.video.webkitSetPresentationMode('picture-in-picture'); return 'entered'; } catch (_) {}
      }
    }
    if (typeof window !== 'undefined' && typeof window.Android?.enterPiP === 'function') {
      const ok = window.Android.enterPiP(this.video?.videoWidth || 16, this.video?.videoHeight || 9);
      if (ok !== false) return 'entered';
    }
    if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && typeof window.watchlivoNativePiP === 'function' && this.media?.videoId) {
      const absU = new URL(`/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(this.media.videoId)}`, window.location.origin).href;
      if (window.watchlivoNativePiP('start', { url: absU, time: this.getTime(), rate: this.getRate() || 1 })) return 'entered';
    }
    return false;
  }

  async togglePiP() {
    if (this.video) {
      if (typeof document !== 'undefined' && document.pictureInPictureElement === this.video) {
        try { await document.exitPictureInPicture(); return 'exited'; } catch (_) {}
      }
      if (this.video.webkitPresentationMode === 'picture-in-picture') {
        try { this.video.webkitSetPresentationMode('inline'); return 'exited'; } catch (_) {}
      }
      if (typeof document !== 'undefined' && document.pictureInPictureEnabled && typeof this.video.requestPictureInPicture === 'function' && this.video.readyState >= 1) {
        try {
          await this.video.requestPictureInPicture();
          this._pipActive = true;
          this.events.onPipChange?.(true);
          return 'entered';
        } catch (_) {}
      }
      if (typeof this.video.webkitSetPresentationMode === 'function' && this.video.readyState >= 1 && (!this.video.webkitSupportsPresentationMode || this.video.webkitSupportsPresentationMode('picture-in-picture'))) {
        try {
          ensureIosPlaybackAudioSession();
          this.subs?.syncNativeTrackToElement?.(this.video, true);
          this.video.webkitSetPresentationMode('picture-in-picture');
          this._pipActive = true;
          this.events.onPipChange?.(true);
          return 'entered';
        } catch (_) {}
      }
      if (typeof window !== 'undefined' && typeof window.Android?.enterPiP === 'function') {
        const ok = window.Android.enterPiP(this.video.videoWidth || 16, this.video.videoHeight || 9);
        if (ok !== false) {
          this.events.onPipChange?.(true);
          return 'entered';
        }
      }
    }

    if (!isIosWebKit() || !this.media?.videoId) return false;
    ensureIosPlaybackAudioSession();
    const pv = this._ensureIosPipBridge(this.media.videoId);
    if (!pv || typeof pv.webkitSetPresentationMode !== 'function') return false;
    if (this._pipActive || pv.webkitPresentationMode === 'picture-in-picture') {
      try { pv.webkitSetPresentationMode('inline'); } catch (_) {}
      return 'exited';
    }
    if (pv.readyState >= 1 && pv.videoWidth > 0 && (!pv.webkitSupportsPresentationMode || pv.webkitSupportsPresentationMode('picture-in-picture'))) {
      const curT = this.getTime();
      if (!this.media?.live && curT > 0.5) { try { pv.currentTime = curT; } catch (_) {} }
      pv.playbackRate = this.getRate() || 1;
      pv.muted = Boolean(this._muted || this.baseVolume <= 0);
      this.subs?.syncNativeTrackToElement?.(pv, true);
      this._pipActive = true;
      this._suppressYtPauseOnce = true;
      try { this.player?.pauseVideo?.(); } catch (_) {}
      try { this.audioEl?.pause?.(); } catch (_) {}
      try { pv.play()?.catch?.(() => {}); } catch (_) {}
      try {
        pv.webkitSetPresentationMode('picture-in-picture');
        this.events.onPipChange?.(true);
        return 'entered';
      } catch (_) {
        this._pipActive = false;
        if (this.wantPlaying) {
          if (this.audioEl) this.audioEl.play().catch(() => {});
          else this.player?.playVideo?.();
        }
      }
    }
    if (typeof window !== 'undefined' && typeof window.watchlivoNativePiP === 'function') {
      const srcForNative = pv.src || `/api/rave/yt-pip-hls.m3u8?v=${encodeURIComponent(this.media.videoId)}`;
      const absU = new URL(srcForNative, window.location.origin).href;
      try { this.player?.pauseVideo?.(); } catch (_) {}
      if (window.watchlivoNativePiP('start', { url: absU, time: this.getTime(), rate: this.getRate() || 1 })) return 'entered';
    }
    if (!pv.error) {
      try { pv.load(); } catch (_) {}
      return 'loading';
    }
    return false;
  }

  play() {
    this.wantPlaying = true;
    resumeSharedAudioContext();
    if (this.video) { this._attemptDirectPlay(this.video); return; }
    if (this._pipActive && this.pipVideo) { this.pipVideo.play().catch(() => {}); return; }
    if (this.audioEl) this.audioEl.play().catch(() => {});
    else this.player?.playVideo?.();
  }

  pause() {
    this.wantPlaying = false;
    if (this.video) { try { this.video.pause(); } catch (_) {} return; }
    if (this._pipActive && this.pipVideo) { this.pipVideo.pause(); return; }
    if (this.audioEl) this.audioEl.pause();
    else this.player?.pauseVideo?.();
  }

  seek(t) {
    const target = Math.max(0, Number(t) || 0);
    if (this.video) {
      if (this.video.readyState < 1) {
        this.initialSeekPending = target;
        if (this.hls) { try { this.hls.startLoad?.(target >= 0.5 ? target : -1); } catch (_) {} }
      } else {
        try { this.video.currentTime = target; } catch (_) {}
      }
    } else if (this._pipActive && this.pipVideo) { try { this.pipVideo.currentTime = target; } catch (_) {} }
    else if (this.audioEl) { try { this.audioEl.currentTime = target; } catch (_) {} }
    else if (this.ready && this.player) this.player?.seekTo?.(target, true);
    else this.initialSeekPending = target;
    this.subs?.onTimeUpdate(target, true);
  }

  updateInitialSeek(targetPos) {
    const target = Math.max(0, Number(targetPos) || 0);
    if (target < 0.5 || this.media?.live) return;
    this.initialSeekPending = target;
    if (this.ready) this.seek(target);
    else if (this.hls) { try { this.hls.startLoad?.(target); } catch (_) {} }
  }

  getTime() {
    if (this.video) return Number(this.video.currentTime || 0);
    if (this._pipActive && this.pipVideo) return Number(this.pipVideo.currentTime || 0);
    return this.audioEl ? Number(this.audioEl.currentTime || 0) : Number(this.player?.getCurrentTime?.() || 0);
  }

  getDuration() {
    if (this.video) {
      const d = Number(this.video.duration);
      return (Number.isFinite(d) && d > 0) ? d : Number(this.media?.duration || 0);
    }
    return this.audioEl ? Number(this.audioEl.duration || this.media?.duration || 200) : Number(this.player?.getDuration?.() || this.media?.duration || 0);
  }

  getBuffered() {
    if (this.video) {
      const b = this.video.buffered;
      return (b && b.length) ? b.end(b.length - 1) : 0;
    }
    return this.audioEl ? this.getDuration() : Number(this.player?.getVideoLoadedFraction?.() || 0) * this.getDuration();
  }

  isPaused() {
    if (this.video) return Boolean(this.video.paused);
    if (this._pipActive && this.pipVideo) return this.pipVideo.paused;
    if (this.audioEl) return this.audioEl.paused;
    const st = this.player?.getPlayerState?.();
    return !(st === 1 || st === 3);
  }

  isBuffering() {
    if (this.video) return Boolean(this.wantPlaying && !this.video.paused && this.video.readyState < 3);
    return (this._pipActive || this.audioEl) ? false : this.player?.getPlayerState?.() === 3;
  }

  isBuffered(t) {
    if (this.video) {
      const b = this.video.buffered;
      if (!b) return false;
      for (let i = 0; i < b.length; i += 1) {
        if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.25) return true;
      }
      return false;
    }
    const cur = this.getTime();
    return t >= cur - 1 && t <= this.getBuffered() - 0.5;
  }

  setRate(r) {
    const numR = Math.max(0.25, Math.min(2.0, Number(r) || 1));
    if (this.video) {
      if (Math.abs((this.video.playbackRate || 1) - numR) > 0.004) {
        try { this.video.playbackRate = numR; } catch (_) {}
      }
      return;
    }
    if (this.pipVideo) { try { this.pipVideo.playbackRate = numR; } catch (_) {} }
    if (this.audioEl) { this.audioEl.playbackRate = numR; return; }
    const steps = this.caps.rateSteps;
    const best = steps.reduce((a, b) => (Math.abs(b - numR) < Math.abs(a - numR) ? b : a), 1);
    if (this.player?.getPlaybackRate?.() !== best) this.player?.setPlaybackRate?.(best);
  }

  getRate() {
    if (this.video) return Number(this.video.playbackRate || 1);
    if (this._pipActive && this.pipVideo) return Number(this.pipVideo.playbackRate || 1);
    return this.audioEl ? Number(this.audioEl.playbackRate || 1) : Number(this.player?.getPlaybackRate?.() || 1);
  }

  setVolume(v) {
    this.baseVolume = Math.max(0, Math.min(150, Number(v ?? (isIosWebKit() ? 100 : 80))));
    if (this.pipVideo) this.pipVideo.muted = Boolean(this._muted || this.baseVolume <= 0);
    if (this.video) {
      this.video.muted = Boolean(this._muted || this.baseVolume <= 0);
      if (this.subs?.syncVideoVolume) this.subs.syncVideoVolume();
      else applyElementVolume(this.video, this.baseVolume, Boolean(this._muted));
    } else if (this.audioEl) {
      applyElementVolume(this.audioEl, this.baseVolume, Boolean(this._muted));
    } else if (this.subs?.syncVideoVolume) {
      this.subs.syncVideoVolume();
    } else {
      this.player?.setVolume?.(Math.min(100, Math.round(this.baseVolume)));
    }
  }

  setMuted(m) {
    this._muted = Boolean(m);
    this.userExplicitMuted = Boolean(m);
    if (this.pipVideo) this.pipVideo.muted = Boolean(this._muted || this.baseVolume <= 0);
    if (this.video) {
      this.video.muted = Boolean(this._muted || this.baseVolume <= 0);
      if (this.subs?.syncVideoVolume) this.subs.syncVideoVolume();
      else applyElementVolume(this.video, this.baseVolume, this._muted);
      if (!m) this.events.onUnmuted?.();
    } else if (this.audioEl) {
      applyElementVolume(this.audioEl, this.baseVolume, this._muted);
    } else if (m) {
      this.player?.mute?.();
    } else {
      this.player?.unMute?.();
    }
  }

  isMuted() {
    if (this.video) return Boolean(this.video.muted || this._muted);
    return this._pipActive && this.pipVideo ? !!this.pipVideo.muted : (this.audioEl ? !!this.audioEl.muted : !!this.player?.isMuted?.());
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this.autoplayTimer);
    clearTimeout(this.stallTimer);
    clearInterval(this.subTimer);
    this.subs?.stopDubAudio?.();
    this.subs?.destroy?.();
    this._teardownDirectVideo();
    if (this.pipVideo) {
      try { this.pipVideo.pause(); this.pipVideo.removeAttribute('src'); this.pipVideo.remove(); } catch (_) {}
      this.pipVideo = null;
    }
    if (typeof window !== 'undefined' && window.isWatchlivoNativeIOS && !window.__kinoxHost?._nativeIosPipActive) {
      try { window.watchlivoNativePiP?.('stop', {}); } catch (_) {}
    }
    if (this.bgMvEl) { try { this.bgMvEl.pause(); this.bgMvEl.removeAttribute?.('src'); this.bgMvEl.remove(); } catch (_) {} this.bgMvEl = null; }
    if (this.vinylBtn) { try { this.vinylBtn.remove(); } catch (_) {} this.vinylBtn = null; }
    if (this.audioEl) { try { this.audioEl.pause(); this.audioEl.remove(); } catch (_) {} this.audioEl = null; }
    try { this.player?.destroy?.(); } catch (_) {}
    this.player = null;
    this.container.replaceChildren();
  }
}
