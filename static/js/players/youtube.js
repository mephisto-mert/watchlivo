// YouTube IFrame + Music Clip & Vinyl Visualizer adapter (with automatic VEVO error-150 fallback & Karaoke Lyrics).
import { SubtitleDubController } from './subtitles.js?v=20261029_v13';

let apiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('YouTube API yüklenemedi'));
    document.head.append(s);
    setTimeout(() => reject(new Error('YouTube API zaman aşımı')), 12000);
  });
  return apiPromise;
}

export class YouTubeAdapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.player = null;
    this.audioEl = null;
    this.vinylOverlay = null;
    this.vinylBtn = null;
    this.vinylMode = false;
    this.ready = false;
    this.baseVolume = 80;
    this.autoplayTimer = null;
    this.subTimer = null;
    this.media = null;
    this.altQueue = [];
    this.subs = new SubtitleDubController(this);
    this.caps = { seek: true, rate: true, rateSteps: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], overlayClicks: true, live: false, subtitles: true };
  }

  async load(media, startAt = 0, autoplay = true) {
    this.media = media || {};
    this.altQueue = Array.isArray(media?.altVideoIds) ? [...media.altVideoIds] : [];
    if (media?.live) { this.caps.live = true; this.caps.seek = false; }
    const rawId = String(media?.videoId || '');
    const urlId = (String(media?.url || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/) || [])[1];
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(rawId) ? rawId : (urlId || rawId);
    this.media.videoId = videoId;
    const mount = document.createElement('div');
    mount.className = 'yt-mount';
    this.container.replaceChildren(mount);
    if (media?.isMusic) this._mountVinylOverlay(media);
    this.subs.initForMedia({ ...this.media, videoId, provider: this.media.provider || 'youtube' }).then(() => {
      if (media?.isMusic && this.subs.subtitleTracks?.length) {
        this.subs.setSubtitleTrack(this.subs.subtitleTracks[0].id);
      }
      this._syncYtNativeCaptions();
      this.events.onTracksChanged?.();
    }).catch(() => {});
    this.subTimer = setInterval(() => {
      if (this.ready && !this.isPaused()) this.subs.onTimeUpdate(this.getTime());
    }, 180);

    try {
      await loadYouTubeApi();
    } catch (err) {
      if (media?.audioPreviewUrl || media?.isMusic) {
        this._activateAudioFallback(startAt, autoplay);
        return;
      }
      throw err;
    }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      this.player = new window.YT.Player(mount, {
        width: '100%', height: '100%', videoId,
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
            } catch (e) { /* ignore */ }
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
              this.stallTimer = setTimeout(() => {
                if (this.audioEl) return;
                const st = this.player?.getPlayerState?.();
                const ct = Number(this.player?.getCurrentTime?.() || 0);
                if ((st === -1 || st === 3 || st === 5) && ct <= (startAt || 0) + 0.2) {
                  if (this.altQueue.length > 0 && this.player?.loadVideoById) {
                    const nextVid = this.altQueue.shift();
                    try { this.player.loadVideoById(nextVid, Math.floor(startAt || 0)); return; } catch (err) { /* ignore */ }
                  }
                  if (this.media?.audioPreviewUrl) {
                    this._activateAudioFallback(startAt, autoplay);
                    return;
                  }
                  this.events.onBuffering?.(false);
                }
              }, 4500);
            }
          },
          onStateChange: (e) => {
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING) {
              clearTimeout(this.autoplayTimer);
              clearTimeout(this.stallTimer);
              try {
                this.player?.setPlaybackQualityRange?.('hd1080', 'highres');
                this.player?.setPlaybackQuality?.('hd1080');
              } catch (err) { /* ignore */ }
              this._syncYtNativeCaptions();
              this.events.onBuffering?.(false);
              this.events.onPlay?.();
            }
            else if (e.data === S.PAUSED) { this.events.onBuffering?.(false); this.events.onPause?.(); }
            else if (e.data === S.BUFFERING) this.events.onBuffering?.(true);
            else if (e.data === S.ENDED) { this.events.onBuffering?.(false); this.events.onEnded?.(); }
          },
          onError: (e) => {
            if (this.altQueue.length > 0 && this.player?.loadVideoById) {
              const nextVid = this.altQueue.shift();
              try { this.player.loadVideoById(nextVid, Math.floor(this.getTime() || startAt)); return; } catch (err) { /* fallback */ }
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
    } catch (e) { /* ignore */ }

    const selId = this.subs?.selectedSubId || 'off';
    const curTrack = (this.subs?.subtitleTracks || []).find((t) => t.id === selId);
    const hasCustomCues = Array.isArray(this.subs?.subCues) && this.subs.subCues.length > 0;
    if (selId === 'off' || hasCustomCues || !curTrack?.ytNativeLang) {
      try { this.player?.setOption?.('captions', 'track', {}); } catch (e) { /* ignore */ }
      try { this.player?.setOption?.('cc', 'track', {}); } catch (e) { /* ignore */ }
      try { this.player?.unloadModule?.('captions'); } catch (e) { /* ignore */ }
      try { this.player?.unloadModule?.('cc'); } catch (e) { /* ignore */ }
    } else if (curTrack?.ytNativeLang) {
      try { this.player?.loadModule?.('captions'); } catch (e) { /* ignore */ }
      try { this.player?.setOption?.('captions', 'track', { languageCode: curTrack.ytNativeLang }); } catch (e) { /* ignore */ }
    }
  }

  _mountVinylOverlay(media) {
    const cover = media.poster || media.thumbnail || '/static/watchlivo-poster.svg';
    const title = (media.songTitle || media.title || 'Müzik & Klip').replace(/^🎵\s*/, '');
    const artist = media.artist || media.channel || 'Sanatçı';
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
      const showBgMv = !this.vinylMode && Boolean(this.audioEl);
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
    this.toggleVinylMode(true);
    if (this.audioEl) return;
    const a = document.createElement('audio');
    a.crossOrigin = 'anonymous';
    a.preload = 'auto';
    if (this.media?.audioPreviewUrl) a.src = this.media.audioPreviewUrl;
    a.currentTime = Math.max(0, startAt);
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
  play() { if (this.audioEl) this.audioEl.play().catch(() => {}); else this.player?.playVideo?.(); }
  pause() { if (this.audioEl) this.audioEl.pause(); else this.player?.pauseVideo?.(); }
  seek(t) {
    const target = Math.max(0, t);
    if (this.audioEl) { try { this.audioEl.currentTime = target; } catch (e) { /* ignore */ } }
    else this.player?.seekTo?.(target, true);
    this.subs?.onTimeUpdate(target, true);
  }
  getTime() { return this.audioEl ? Number(this.audioEl.currentTime || 0) : Number(this.player?.getCurrentTime?.() || 0); }
  getDuration() { return this.audioEl ? Number(this.audioEl.duration || this.media?.duration || 200) : Number(this.player?.getDuration?.() || this.media?.duration || 0); }
  getBuffered() { return this.audioEl ? this.getDuration() : Number(this.player?.getVideoLoadedFraction?.() || 0) * this.getDuration(); }
  isPaused() {
    if (this.audioEl) return this.audioEl.paused;
    const st = this.player?.getPlayerState?.();
    return !(st === 1 || st === 3);
  }
  isBuffering() { return this.audioEl ? false : this.player?.getPlayerState?.() === 3; }
  isBuffered(t) { const cur = this.getTime(); return t >= cur - 1 && t <= this.getBuffered() - 0.5; }
  setRate(r) {
    if (this.audioEl) { this.audioEl.playbackRate = r; return; }
    const steps = this.caps.rateSteps;
    const best = steps.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 1);
    if (this.player?.getPlaybackRate?.() !== best) this.player?.setPlaybackRate?.(best);
  }
  getRate() { return this.audioEl ? Number(this.audioEl.playbackRate || 1) : Number(this.player?.getPlaybackRate?.() || 1); }
  setVolume(v) {
    this.baseVolume = Math.max(0, Math.min(100, Number(v ?? 80)));
    if (this.audioEl) this.audioEl.volume = Math.max(0, Math.min(1, this.baseVolume / 100));
    else this.subs?.syncVideoVolume ? this.subs.syncVideoVolume() : this.player?.setVolume?.(Math.round(this.baseVolume));
  }
  setMuted(m) {
    if (this.audioEl) this.audioEl.muted = !!m;
    else if (m) this.player?.mute?.();
    else this.player?.unMute?.();
  }
  isMuted() { return this.audioEl ? !!this.audioEl.muted : !!this.player?.isMuted?.(); }
  destroy() {
    this._destroyed = true;
    clearTimeout(this.autoplayTimer);
    clearTimeout(this.stallTimer);
    clearInterval(this.subTimer);
    this.subs?.stopDubAudio?.();
    this.subs?.destroy?.();
    if (this.bgMvEl) { try { this.bgMvEl.pause(); this.bgMvEl.removeAttr?.('src'); this.bgMvEl.remove(); } catch (e) { /* ignore */ } this.bgMvEl = null; }
    if (this.vinylBtn) { try { this.vinylBtn.remove(); } catch (e) { /* ignore */ } this.vinylBtn = null; }
    if (this.audioEl) { try { this.audioEl.pause(); this.audioEl.remove(); } catch (e) { /* ignore */ } this.audioEl = null; }
    try { this.player?.destroy?.(); } catch (e) { /* ignore */ }
    this.player = null;
    this.container.replaceChildren();
  }
}
