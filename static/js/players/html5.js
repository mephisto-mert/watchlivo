// HTML5 <video> adapter for direct files (.mp4/.webm), uploads and HLS (.m3u8 via hls.js / native iOS AVPlayer).
import { SubtitleDubController } from './subtitles.js?v=20261031_v45';
import { expectedPosition } from '../sync.js?v=20261031_v45';
import { state } from '../store.js?v=20261031_v45';

function setReferrerMeta(policy) {
  let m = document.querySelector('meta[name="referrer"]');
  if (!m) { m = document.createElement('meta'); m.name = 'referrer'; document.head.appendChild(m); }
  m.content = policy;
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
    this.wantPlaying = true;
    this.bufferingReported = false;
    this.playingReported = false;
    this.baseVolume = 80;
    this.currentUrl = '';
    this.subs = new SubtitleDubController(this);
    this.caps = { seek: true, rate: true, overlayClicks: true, subtitles: true, audioTracks: true };
  }

  async load(media, startAt = 0, autoplay = true) {
    if (media?.live) {
      startAt = 0;
      this.caps = { ...this.caps, seek: false, live: true };
    }
    setReferrerMeta('no-referrer');
    this.wantPlaying = Boolean(autoplay);
    this.bufferingReported = false;
    this.playingReported = false;
    clearTimeout(this.watchdogTimer);
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.disableRemotePlayback = true;
    v.preload = 'auto';
    v.preservesPitch = true;
    if (media?.thumbnail || media?.poster) v.poster = media.thumbnail || media.poster;
    this.video = v;
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
      const wasPausedWant = !this.wantPlaying;
      this.wantPlaying = true;
      if (this.bgMvEl && !this.vinylMode) {
        this.bgMvEl.play().catch(() => {});
      }
      if (!v.muted && v.volume > 0) this.events.onUnmuted?.();
      reportPlay(wasPausedWant);
    });
    v.addEventListener('volumechange', () => { if (!v.paused && !v.muted && v.volume > 0) { this.audioUnlocked = true; this.events.onUnmuted?.(); } });
    v.addEventListener('loadeddata', () => { if (v.readyState >= 2) { clearBuf(); this.events.onReady?.(); } });
    v.addEventListener('canplay', () => { clearBuf(); this.events.onReady?.(); });
    v.addEventListener('canplaythrough', () => { clearBuf(); this.events.onReady?.(); });
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
    const onFsChangeMark = () => { this._lastFsChangeAt = Date.now(); };
    v.addEventListener('webkitbeginfullscreen', onFsChangeMark);
    v.addEventListener('webkitendfullscreen', onFsChangeMark);
    v.addEventListener('pause', () => {
      if (this._destroyed || this.video !== v) return;
      this.playingReported = false;
      this.subs.stopDubAudio();
      try { this.bgMvEl?.pause(); } catch (e) { /* ignore */ }
      const dur = Number(v.duration || 0);
      if (v.ended || (Number.isFinite(dur) && dur > 20 && v.currentTime >= dur - 0.45)) {
        fireEndedOnce();
        return;
      }
      const fsTransition = Boolean(this._lastFsChangeAt && Date.now() - this._lastFsChangeAt < 650);
      const recentSeek = Boolean(this.lastSeekAt && Date.now() - this.lastSeekAt < 2200);
      const isTransientPause = Boolean(fsTransition || v.seeking || recentSeek || v.readyState < 2);
      if (this.wantPlaying && !this.hasEnded && !v.ended && isTransientPause) {
        clearTimeout(this.resumeTimer);
        const delayMs = (v.seeking || recentSeek || v.readyState < 3) ? 400 : 250;
        this.resumeTimer = setTimeout(() => {
          if (this.video === v && this.wantPlaying && !this.hasEnded && v.paused && !v.ended && !v.seeking) {
            this.tryPlay();
          }
        }, delayMs);
        return;
      }
      if (this.wantPlaying && !v.seeking) {
        this.wantPlaying = false;
        this.events.onPause?.({ native: true });
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
        return `sid:${mSid[1]}`;
      }
      return raw.replace(/&ext=\.m3u8\b/i, '');
    };
    const pushAlt = (u) => {
      const s = String(u || '').trim();
      const k = normDedupeKey(s);
      if (!s || !k || isDrmUrl(s) || isDemoTestUrl(s) || seenUrls.has(k)) return;
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
    if (Array.isArray(media.audioTracks)) {
      for (const t of media.audioTracks) if (t?.url) pushAlt(t.url);
    }
    alts.sort((a, b) => (isHevcUrl(a) ? 1 : 0) - (isHevcUrl(b) ? 1 : 0));

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
      const wantClip = media.musicMode === 'video' && Boolean(this.bgMvEl || this.bgYtEl || !isAudioOnlyUrl(url));
      this._setMusicVisualMode?.(wantClip ? 'clip' : (isAudioOnlyUrl(url) ? 'vinyl' : 'clip'));
    }
    this.subs.initForMedia(media);

    let triedHlsFallback = false;
    const isUrlHls = (u) => /\.m3u8(\?|$)/i.test(String(u || '')) || /\/proxy\?data=|\/api\/rave\/stream\?|playback\.media-streaming\.soundcloud\.cloud|cf-hls-media\.sndcdn\.com/i.test(String(u || ''));
    const isHls = isUrlHls(url) || media.provider === 'hls' || media.streamType === 'hls';
    const canHlsJs = Boolean(window.Hls && window.Hls.isSupported());
    const canNativeHls = Boolean(v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL'));
    const isApple = /Apple/i.test(navigator.vendor || '') && (/iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    const useNativeHls = isHls && canNativeHls && (isApple || !canHlsJs);
    this.useNativeHls = useNativeHls;
    const withProxySegs = (u) => {
      const s = String(u || '');
      if (!s.includes('/api/rave/stream?') || s.includes('proxy_segs=1')) return u;
      return s.includes('&ext=.m3u8')
        ? s.replace('&ext=.m3u8', '&proxy_segs=1&ext=.m3u8')
        : `${s}&proxy_segs=1`;
    };

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
              let addedAny = false;
              for (const fu of freshList) {
                const s = String(fu || '').trim();
                if (s && !isDrmUrl(s) && !isDemoTestUrl(s) && !seenUrls.has(s)) {
                  seenUrls.add(s);
                  alts.push(s);
                  addedAny = true;
                }
              }
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
      if (this.isMusic) {
        this._setMusicVisualMode?.(isAudioOnlyUrl(nextUrl) ? 'vinyl' : 'clip');
      }
      const restorePosOnLoad = () => {
        if (this.video !== v) return;
        if (resumePos >= 0.5 && Math.abs((v.currentTime || 0) - resumePos) > 1.5) {
          try { v.currentTime = resumePos; } catch (e) { /* ignore */ }
        }
        doneCb?.();
      };
      if (isUrlHls(nextUrl)) {
        if (canHlsJs && !useNativeHls) {
          attachHlsJs(nextUrl, doneCb, resumePos);
          return;
        }
        try { this.hls?.destroy(); } catch (err) { /* ignore */ }
        this.hls = null;
        v.src = withProxySegs(nextUrl);
        v.load();
        v.addEventListener('loadedmetadata', restorePosOnLoad, { once: true });
        if (this.wantPlaying) this.tryPlay();
        return;
      }
      try { this.hls?.destroy(); } catch (err) { /* ignore */ }
      this.hls = null;
      v.src = nextUrl;
      v.load();
      v.addEventListener('loadedmetadata', restorePosOnLoad, { once: true });
      if (this.wantPlaying) this.tryPlay();
    };
    this._loadCandidateUrl = loadCandidateUrl;

    const attachHlsJs = (srcUrl, doneCb, customStart = null) => {
      try { this.hls?.destroy(); } catch (e) { /* ignore */ }
      let doneFired = false;
      const fireDoneOnce = () => {
        if (doneFired) return;
        doneFired = true;
        doneCb?.();
      };
      const effStart = Number(customStart ?? startAt) || 0;
      this.hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        subtitleDisplay: false,
        enableWebVTT: false,
        startFragPrefetch: true,
        startPosition: effStart >= 0.5 ? effStart : -1,
        abrEwmaDefaultEstimate: 1600000,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.65,
        autoLevelCapping: -1,
        maxBufferLength: 35,
        maxMaxBufferLength: 75,
        backBufferLength: 45,
        maxBufferSize: 45 * 1000 * 1000,
        maxBufferHole: 0.8,
        maxAudioFramesDrift: 2,
        stretchShortVideoTrack: true,
        forceKeyFrameOnDiscontinuity: true,
        progressive: false,
        highBufferWatchdogPeriod: 2,
        maxFragLookUpTolerance: 0.35,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 10,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 4,
      });
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (data?.levels?.length > 1) {
          let maxAllowedIdx = -1;
          data.levels.forEach((l, idx) => {
            const w = l.width || 0;
            const h = l.height || 0;
            const bw = l.bitrate || 0;
            const isOver1080p = w > 2650 || h > 1200 || bw > 10500000;
            if (!isOver1080p) {
              maxAllowedIdx = idx;
            }
          });
          if (maxAllowedIdx >= 0 && maxAllowedIdx < data.levels.length - 1) {
            this.hls.autoLevelCapping = maxAllowedIdx;
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
      this.hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
        netRetries = 0;
        if (v.readyState >= 2) {
          clearBuf();
          this.events.onReady?.();
          fireDoneOnce();
        }
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
              if (!this.isBuffered(cur + 0.25)) {
                for (let i = 0; i < v.buffered.length; i += 1) {
                  const bStart = v.buffered.start(i);
                  const bEnd = v.buffered.end(i);
                  if (bStart > cur + 0.04 && bStart - cur <= 2.5 && bEnd > bStart + 0.2) {
                    v.currentTime = bStart + 0.05;
                    return;
                  }
                }
              }
            } catch (err) { /* ignore */ }
            try {
              const curLvl = this.hls.currentLevel >= 0 ? this.hls.currentLevel : (this.hls.nextAutoLevel ?? this.hls.loadLevel ?? 0);
              if (this.hls.levels?.length > 1 && curLvl > 0) {
                this.hls.nextAutoLevel = Math.max(0, curLvl - 1);
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
            netRetries += 1;
            if (netRetries <= 2) {
              setTimeout(() => {
                try { this.hls?.startLoad(curResume >= 5 ? curResume : -1); } catch (err) { /* ignore */ }
              }, 350 * netRetries);
            } else if (nativeAltIdx < alts.length) {
              netRetries = 0;
              loadCandidateUrl(alts[nativeAltIdx++], doneCb);
            } else if (canNativeHls && !triedHlsFallback) {
              triedHlsFallback = true;
              try { this.hls.destroy(); } catch (err) { /* ignore */ }
              this.hls = null;
              v.src = withProxySegs(srcUrl);
              v.load();
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

    v.addEventListener('error', () => {
      if (this._destroyed || this.video !== v || this.hls) return;
      if (nativeAltIdx < alts.length) {
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
        if (v.readyState >= 2 && !v.seeking) {
          clearBuf();
          this.events.onReady?.();
        } else {
          this.bufferingReported = true;
          this.events.onBuffering?.(true);
        }
        resolve();
      };
      const onFrameReady = () => {
        if (this._destroyed || this.video !== v || v.readyState < 2) return;
        clearBuf();
        this.events.onReady?.();
        done();
      };
      v.addEventListener('loadeddata', onFrameReady);
      v.addEventListener('canplay', onFrameReady);
      v.addEventListener('playing', onFrameReady);
      this.loadReadyTimer = setTimeout(done, 2200);
      if (isHls && canHlsJs && !useNativeHls) {
        attachHlsJs(url, onFrameReady);
      } else {
        v.src = useNativeHls ? withProxySegs(url) : url;
        if (autoplay) this.tryPlay();
      }
    });
    if (this._destroyed || this.video !== v) return;
    if (!this.hls && startAt >= 8) {
      const applyInitialNativeSeek = () => {
        if (this.video !== v || this.hls) return;
        if (startAt >= 0.5 && Math.abs((v.currentTime || 0) - startAt) > 1.2) {
          try { v.currentTime = startAt; } catch (e) { /* ignore */ }
        }
      };
      if (v.readyState >= 1) applyInitialNativeSeek();
      else v.addEventListener('loadedmetadata', applyInitialNativeSeek, { once: true });
    }
    if (autoplay) {
      this.tryPlay();
      v.addEventListener('canplay', () => { if (this.wantPlaying && v.paused) this.tryPlay(); });
    }
    let stallChecks = 0;
    const stallWindowMs = this.isMusic ? 4500 : 10500;
    let lastZeroDimSwitchAt = 0;
    const checkZeroDimAudioOnly = () => {
      if (this.video !== v || this.isMusic || isAudioOnlyUrl(this.currentUrl)) return;
      if (v.readyState >= 2 && !v.paused && v.currentTime > (startAt || 0) + 0.45 && v.videoWidth === 0) {
        const nowMs = Date.now();
        if (nowMs - lastZeroDimSwitchAt > 1200 && nativeAltIdx < alts.length) {
          lastZeroDimSwitchAt = nowMs;
          loadCandidateUrl(alts[nativeAltIdx++]);
        }
      }
    };
    v.addEventListener('timeupdate', checkZeroDimAudioOnly);
    const checkUniversalStall = () => {
      if (this.video !== v) return;
      if (!this.wantPlaying || v.seeking || document.hidden) {
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
        if (this.hls && this.hls.levels?.length > 0 && stallChecks === 1) {
          try {
            if (this.hls.levels.length > 1) this.hls.nextAutoLevel = 0;
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
      if (!this.wantPlaying || v.seeking || document.hidden) {
        consecutiveMidStalls = 0;
        lastWatchdogPos = curT;
        return;
      }
      if (Math.abs(curT - lastWatchdogPos) < 0.08 && curT > 0.5) {
        consecutiveMidStalls += 1;
        if (v.paused && v.readyState >= 2) {
          this.tryPlay();
        }
        if (consecutiveMidStalls >= 2 && !this.isBuffered(curT + 0.25)) {
          try {
            for (let i = 0; i < v.buffered.length; i += 1) {
              const bStart = v.buffered.start(i);
              const bEnd = v.buffered.end(i);
              if (bStart > curT + 0.04 && bStart - curT <= 2.8 && bEnd > bStart + 0.2) {
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
        v.muted = true;
        this.audioUnlocked = false;
        this.events.onAutoplayBlocked?.();
        try { await v.play(); } catch (e2) { this.events.onPause?.(); }
      }
    }
  }

  play() { if (this.hasEnded || this.video?.ended) return; this.wantPlaying = true; this.tryPlay(); }
  pause() { this.wantPlaying = false; clearTimeout(this.resumeTimer); this.video?.pause(); }
  isEnded() { return Boolean(this.hasEnded || this.video?.ended); }
  seek(t) {
    const target = Math.max(0, Number(t) || 0);
    const dur = this.getDuration();
    if (!dur || target < dur - 2) {
      this.hasEnded = false;
    }
    const v = this.video;
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
    if (this.initialSeekPending && Date.now() - (this.loadedAtMs || 0) < 6000) {
      const cur = Number(this.video?.currentTime || 0);
      if (!this.video || this.video.readyState < 1 || cur < Math.max(0.5, this.initialSeekPending - 2.5)) {
        return this.initialSeekPending;
      }
      this.initialSeekPending = 0;
    }
    if (!this.video || this.video.readyState < 1) {
      return Number(this.video?.currentTime || 0);
    }
    if (this.video?.seeking && this.lastSeekAt && Date.now() - this.lastSeekAt < 3500) {
      return this.lastSeekTarget;
    }
    return Number(this.video?.currentTime || 0);
  }
  getDuration() { const d = Number(this.video?.duration || 0); return Number.isFinite(d) ? d : 0; }
  getBuffered() {
    const v = this.video;
    if (!v || !v.buffered.length) return 0;
    const ct = Number(v.currentTime || 0);
    for (let i = 0; i < v.buffered.length; i += 1) {
      if (ct >= v.buffered.start(i) - 1.5 && ct <= v.buffered.end(i) + 0.5) {
        return v.buffered.end(i);
      }
    }
    return v.buffered.end(v.buffered.length - 1);
  }
  isPaused() { return !this.video || this.video.paused; }
  isBuffered(t) {
    const b = this.video?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i += 1) if (t >= b.start(i) - 0.5 && t <= b.end(i) - 0.2) return true;
    return false;
  }
  isBuffering() {
    if (!this.video) return true;
    if (this.initialSeekPending && Date.now() - (this.loadedAtMs || 0) < 7500 && this.video.readyState < 2) return true;
    return Boolean(this.video.seeking || this.bufferingReported || (this.video.readyState < 2 && (!this.video.paused || this.wantPlaying)));
  }
  setRate(r) { if (this.video && Math.abs(this.video.playbackRate - r) > 0.001) this.video.playbackRate = r; }
  getRate() { return Number(this.video?.playbackRate || 1); }
  setVolume(v) {
    this.baseVolume = Math.max(0, Math.min(100, Number(v)));
    this.subs.syncVideoVolume();
  }
  setMuted(m) {
    this.userExplicitMuted = Boolean(m);
    if (!m) {
      this.audioUnlocked = true;
      this.subs.unlockDubAudio();
    } else {
      this.subs.stopDubAudio();
    }
    if (this.video) this.video.muted = Boolean(m);
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
    const isNextHls = /\.m3u8(\?|$)/i.test(String(newUrl || '')) || /\/proxy\?data=|\/api\/rave\/stream\?|playback\.media-streaming\.soundcloud\.cloud|cf-hls-media\.sndcdn\.com/i.test(String(newUrl || ''));
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
      const effUrl = (this.useNativeHls && !/stream-proxy/i.test(newUrl) && String(newUrl).includes('/api/rave/stream?') && !String(newUrl).includes('proxy_segs=1'))
        ? String(newUrl).replace('&ext=.m3u8', '&proxy_segs=1&ext=.m3u8')
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
      const lbl = (vw >= 3200 || vh >= 2000) ? '4K UHD (2160p)' : (vw >= 1800 || vh >= 1000) ? '1080p Full HD' : (vw >= 1200 || vh >= 680) ? '720p HD' : '1080p Full HD';
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
  destroy() {
    this._destroyed = true;
    this.wantPlaying = false;
    clearTimeout(this.loadReadyTimer);
    this._loadDoneResolve?.();
    clearInterval(this.subTickTimer);
    clearTimeout(this.waitTimer);
    clearTimeout(this.resumeTimer);
    clearTimeout(this.watchdogTimer);
    clearInterval(this.playbackWatchdog);
    setReferrerMeta('strict-origin-when-cross-origin');
    this.subs.stopDubAudio();
    this.subs.destroy();
    if (this.vinylBtn) { try { this.vinylBtn.remove(); } catch (e) { /* ignore */ } this.vinylBtn = null; }
    if (this.bgMvEl) { try { this.bgMvEl.pause(); this.bgMvEl.removeAttribute('src'); this.bgMvEl.remove(); } catch (e) { /* ignore */ } this.bgMvEl = null; }
    if (this.bgYtEl) { try { this.bgYtEl.removeAttribute('src'); this.bgYtEl.remove(); } catch (e) { /* ignore */ } this.bgYtEl = null; }
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
