// Rave-parity Webview & DRM Provider Bridge adapter:
// - In Desktop App (Electron): mounts provider page in persist:vortex-drm partition with Widevine CDM
//   and synchronizes internal HTML5 <video> element via executeJavaScript.
// - In Web Browser: provides official player window bridge with real-time timestamp synchronization,
//   BroadcastChannel/postMessage protocol for companion extension/popup, and live playback controls.

const _DRM_WEBVIEW_HOSTS = [
  'netflix.com', 'disneyplus.com', 'primevideo.com', 'amazon.com', 'max.com', 'hbomax.com',
  'tv.apple.com', 'mubi.com', 'hulu.com', 'paramountplus.com', 'peacocktv.com', 'plex.tv',
  'pluto.tv', 'exxen.com', 'blutv.com', 'gain.tv', 'todtv.com.tr', 'tabii.com',
  'tvplus.com.tr', 'puhutv.com', 'crunchyroll.com', 'tubitv.com',
];

export function isAllowedWebviewUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return _DRM_WEBVIEW_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

function _formatSeconds(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) {
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export class WebviewAdapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.wv = null;
    this.bridgeEl = null;
    this.timer = null;
    this.syncChannel = null;
    this.state = { t: 0, d: 0, paused: true, buffering: false, rate: 1, buf: 0 };
    this.caps = { seek: true, rate: true, overlayClicks: false, live: false };
    this._isDesktop = Boolean(window.vortexDesktop?.isElectron);
    this._destroyed = false;
    this.baseTime = 0;
    this.anchorPerf = performance.now();
    this.duration = 7200;
    this.rate = 1;
    this.paused = true;
    this.mediaUrl = '';
    this.targetWindow = null;

    this._onWindowMessage = (ev) => {
      const d = ev?.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'VORTEX_DRM_SYNC' || d.type === 'MAX_SYNC') {
        this._applyExternalSync(d);
      }
    };
  }

  _applyExternalSync(d) {
    if (typeof d.currentTime === 'number' && Number.isFinite(d.currentTime)) {
      this.baseTime = d.currentTime;
      this.state.t = d.currentTime;
      this.anchorPerf = performance.now();
    }
    if (typeof d.duration === 'number' && d.duration > 0) {
      this.duration = d.duration;
      this.state.d = d.duration;
    }
    if (typeof d.paused === 'boolean') {
      const prevPaused = this.paused;
      this.paused = d.paused;
      this.state.paused = d.paused;
      if (prevPaused && !d.paused) this.events.onPlay?.();
      else if (!prevPaused && d.paused) this.events.onPause?.();
    }
    this._updateBridgeDisplay();
  }

  async load(media, startAt = 0, shouldPlay = true) {
    this._destroyed = false;
    clearInterval(this.timer);
    this.loadedAtMs = Date.now();
    this.wantPlaying = Boolean(shouldPlay);
    this.mediaUrl = isAllowedWebviewUrl(media?.url) ? String(media.url).trim() : 'https://play.max.com';
    this.baseTime = Math.max(0, Number(startAt) || 0);
    this.state.t = this.baseTime;
    this.duration = Number(media?.duration) || (media?.mediaType === 'tv' ? 2700 : 7200);
    this.state.d = this.duration;
    this.paused = !shouldPlay;
    this.state.paused = this.paused;
    this.anchorPerf = performance.now();

    if (this._isDesktop) {
      await this._initDesktopWebview(media, startAt, shouldPlay);
    } else {
      this._initWebBridge(media, startAt, shouldPlay);
    }
  }

  async _initDesktopWebview(media, startAt, shouldPlay) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', window.vortexDesktop?.partition || 'persist:vortex-drm');
    wv.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    wv.src = this.mediaUrl;
    this.wv = wv;
    this.container.replaceChildren(wv);

    await new Promise((res) => {
      wv.addEventListener('dom-ready', res, { once: true });
      setTimeout(res, 8000);
    });

    if (this._destroyed || this.wv !== wv) return;
    if (startAt > 1) this.seek(startAt);
    if (shouldPlay) this.play();
    this.timer = setInterval(() => this.poll(), 250);
    this.events.onBuffering?.(false);
    this.events.onReady?.();
    if (shouldPlay) this.events.onPlay?.();
  }

  _initWebBridge(media, startAt, shouldPlay) {
    try {
      this.syncChannel = new BroadcastChannel('vortex_drm_sync');
      this.syncChannel.onmessage = (ev) => {
        if (ev?.data) this._applyExternalSync(ev.data);
      };
    } catch (_) {}
    window.addEventListener('message', this._onWindowMessage);

    this.container.replaceChildren();
    const bridge = document.createElement('div');
    bridge.className = 'drm-player-bridge max-bridge-active';
    bridge.style.cssText = `
      width:100%;height:100%;display:flex;flex-direction:column;align-items:center;
      justify-content:center;padding:24px;box-sizing:border-box;
      background:radial-gradient(ellipse at top, #001f54 0%, #080914 70%, #030408 100%);
      color:#f8fafc;font-family:Inter,system-ui,-apple-system,sans-serif;text-align:center;
      position:relative;overflow:hidden;
    `;

    const isMax = /max\.com|hbomax\.com/i.test(this.mediaUrl) || media?.provider === 'max';
    const provName = isMax ? 'Max (HBO)' : (media?.provider ? media.provider.toUpperCase() : 'DRM Oynatıcı');

    bridge.innerHTML = `
      <div style="max-width:540px;width:100%;background:rgba(16,18,26,0.85);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.12);border-radius:18px;padding:28px 24px;box-shadow:0 20px 40px rgba(0,0,0,0.6);">
        <div style="display:inline-flex;align-items:center;gap:8px;padding:4px 12px;background:rgba(0,43,231,0.25);border:1px solid #002be7;border-radius:99px;font-size:12px;font-weight:700;color:#60a5fa;margin-bottom:14px;">
          <span style="width:8px;height:8px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8;animation:pulse 2s infinite;"></span>
          ${provName} Canlı Oda Köprüsü
        </div>
        <h2 style="margin:0 0 8px;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">
          ${media?.title || (isMax ? 'Max Yayını' : 'Resmi Oynatıcı')}
        </h2>
        <p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#94a3b8;">
          Web tarayıcılarında DRM güvenlik ilkeleri nedeniyle Max ayrı pencerede oynatılır. Odanızın zamanlaması bu ekranda milisaniyelik senkronize edilir.
        </p>

        <div style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;">
          <div style="text-align:left;">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Oda Zamanı</div>
            <div id="vortex-bridge-timer" style="font-size:20px;font-weight:800;color:#38bdf8;font-variant-numeric:tabular-nums;">
              ${_formatSeconds(this.baseTime)} / ${_formatSeconds(this.duration)}
            </div>
          </div>
          <div id="vortex-bridge-status" style="font-size:12px;font-weight:700;padding:6px 12px;border-radius:8px;background:${this.paused ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)'};color:${this.paused ? '#f87171' : '#4ade80'};">
            ${this.paused ? '⏸ Duraklatıldı' : '▶️ Oynatılıyor'}
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:18px;">
          <button id="vortex-bridge-open-btn" type="button" style="flex:1;min-width:180px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:10px;background:#002be7;color:#ffffff;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:transform 0.15s, background 0.15s;">
            🎬 Max'te Aç & Başlat
          </button>
          <button id="vortex-bridge-copy-btn" type="button" style="padding:12px 16px;border-radius:10px;background:rgba(255,255,255,0.08);color:#f1f5f9;font-size:13px;font-weight:600;border:1px solid rgba(255,255,255,0.14);cursor:pointer;">
            ⏱ Zamanı Kopyala
          </button>
        </div>

        <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;font-size:12px;color:#94a3b8;display:flex;align-items:center;justify-content:center;gap:6px;">
          <span>Tam gömülü ve otomatik izleme için:</span>
          <a href="/download/windows" download="Watchlivo.exe" style="color:#38bdf8;text-decoration:none;font-weight:700;">Masaüstü Sürümünü İndir ↗</a>
        </div>
      </div>
    `;

    this.bridgeEl = bridge;
    this.container.replaceChildren(bridge);

    const openBtn = bridge.querySelector('#vortex-bridge-open-btn');
    if (openBtn) {
      openBtn.onclick = () => {
        this.targetWindow = window.open(this.mediaUrl, 'vortex_max_player', 'width=1280,height=760,menubar=no,toolbar=no');
        this.play();
      };
    }

    const copyBtn = bridge.querySelector('#vortex-bridge-copy-btn');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const timeStr = _formatSeconds(this.getTime());
        try {
          await navigator.clipboard.writeText(timeStr);
          copyBtn.textContent = '✓ Kopyalandı (' + timeStr + ')';
          setTimeout(() => { copyBtn.textContent = '⏱ Zamanı Kopyala'; }, 2000);
        } catch (_) {}
      };
    }

    this.timer = setInterval(() => {
      this._updateBridgeDisplay();
    }, 500);

    this.events.onBuffering?.(false);
    this.events.onReady?.();
    if (shouldPlay) this.events.onPlay?.();
  }

  _updateBridgeDisplay() {
    if (!this.bridgeEl || this._isDesktop) return;
    const cur = this.getTime();
    this.state.t = cur;
    this.state.d = this.duration;
    this.state.paused = this.paused;

    const timerEl = this.bridgeEl.querySelector('#vortex-bridge-timer');
    if (timerEl) {
      timerEl.textContent = `${_formatSeconds(cur)} / ${_formatSeconds(this.duration)}`;
    }
    const statusEl = this.bridgeEl.querySelector('#vortex-bridge-status');
    if (statusEl) {
      statusEl.style.background = this.paused ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)';
      statusEl.style.color = this.paused ? '#f87171' : '#4ade80';
      statusEl.textContent = this.paused ? '⏸ Duraklatıldı' : '▶️ Oynatılıyor';
    }

    if (cur >= this.duration && this.duration > 0 && !this.paused) {
      this.pause();
      this.events.onEnded?.();
    }
  }

  async poll() {
    if (!this.wv?.executeJavaScript) return;
    try {
      const s = await this.wv.executeJavaScript(`(() => {
        const v = document.querySelector('video') ||
                  document.querySelector('media-player video') ||
                  (document.querySelector('shaka-player')?.shadowRoot?.querySelector('video')) ||
                  Array.from(document.querySelectorAll('video')).pop();
        if (!v) return null;
        const b = v.buffered?.length ? v.buffered.end(v.buffered.length - 1) : 0;
        return {
          t: v.currentTime || 0,
          d: v.duration || 0,
          paused: Boolean(v.paused),
          ended: Boolean(v.ended),
          buffering: v.readyState < 3,
          rate: v.playbackRate || 1,
          buf: b
        };
      })()`);
      if (s) {
        const wasEnded = Boolean(this.state?.ended);
        this.state = s;
        if (s.ended && !wasEnded) this.events.onEnded?.();
      }
    } catch (e) {
      /* cross-navigation or webview rebuilding */
    }
  }

  exec(code) {
    if (this._isDesktop && this.wv?.executeJavaScript) {
      try {
        this.wv.executeJavaScript(`(() => {
          const v = document.querySelector('video') ||
                    document.querySelector('media-player video') ||
                    (document.querySelector('shaka-player')?.shadowRoot?.querySelector('video')) ||
                    Array.from(document.querySelectorAll('video')).pop();
          if (v) { ${code} }
        })()`);
      } catch (e) { /* ignore */ }
    }
  }

  _broadcastSync(action, payload = {}) {
    const packet = {
      type: 'VORTEX_DRM_SYNC',
      action,
      currentTime: this.getTime(),
      duration: this.getDuration(),
      paused: this.isPaused(),
      playbackRate: this.getRate(),
      timestamp: Date.now(),
      ...payload,
    };
    try { this.syncChannel?.postMessage(packet); } catch (_) {}
    try { this.targetWindow?.postMessage(packet, '*'); } catch (_) {}
  }

  play() {
    this.wantPlaying = true;
    if (this._isDesktop) {
      this.exec('v.play().catch(()=>{})');
    } else {
      if (this.paused) {
        this.anchorPerf = performance.now();
        this.paused = false;
        this.state.paused = false;
        this._updateBridgeDisplay();
        this.events.onPlay?.();
        this._broadcastSync('play');
      }
    }
  }

  pause() {
    this.wantPlaying = false;
    if (this._isDesktop) {
      this.exec('v.pause()');
    } else {
      if (!this.paused) {
        this.baseTime = this.getTime();
        this.paused = true;
        this.state.paused = true;
        this._updateBridgeDisplay();
        this.events.onPause?.();
        this._broadcastSync('pause');
      }
    }
  }

  seek(sec) {
    const target = Math.max(0, Number(sec) || 0);
    this.state.t = target;
    if (this._isDesktop) {
      this.exec(`v.currentTime = ${target}`);
    } else {
      this.baseTime = target;
      this.anchorPerf = performance.now();
      this._updateBridgeDisplay();
      this._broadcastSync('seek', { seekTo: target });
    }
  }

  getTime() {
    if (this._isDesktop) return this.state.t || 0;
    if (this.paused) return this.baseTime;
    const elapsed = ((performance.now() - this.anchorPerf) / 1000) * this.rate;
    return Math.min(this.duration, Math.max(0, this.baseTime + elapsed));
  }

  getDuration() {
    return this._isDesktop ? (this.state.d || this.duration) : this.duration;
  }

  getBuffered() {
    if (this._isDesktop) return this.state.buf ?? (this.state.t + 10);
    return Math.min(this.duration, this.getTime() + 60);
  }

  isPaused() {
    return this._isDesktop ? Boolean(this.state.paused) : this.paused;
  }

  isBuffering() {
    return this._isDesktop ? Boolean(this.state.buffering) : false;
  }

  setRate(r) {
    const newRate = Number(r) || 1;
    this.rate = newRate;
    this.state.rate = newRate;
    if (this._isDesktop) {
      this.exec(`v.playbackRate = ${newRate}`);
    } else {
      this.baseTime = this.getTime();
      this.anchorPerf = performance.now();
      this._broadcastSync('rate', { rate: newRate });
    }
  }

  getRate() {
    return this.rate || 1;
  }

  setVolume(v) {
    const vol = Math.max(0, Math.min(1, Number(v) / 100));
    if (this._isDesktop) this.exec(`v.volume = ${vol}`);
  }

  setMuted(m) {
    if (this._isDesktop) this.exec(`v.muted = ${Boolean(m)}`);
  }

  isMuted() {
    return false;
  }

  destroy() {
    this._destroyed = true;
    clearInterval(this.timer);
    window.removeEventListener('message', this._onWindowMessage);
    try { this.syncChannel?.close(); } catch (_) {}
    this.syncChannel = null;
    this.container.replaceChildren();
    this.wv = null;
    this.bridgeEl = null;
    this.targetWindow = null;
  }
}
