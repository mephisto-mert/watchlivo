// Rave-parity Desktop <webview> adapter: mounts provider page in persist:vortex-drm partition
// and synchronizes its internal HTML5 <video> element via executeJavaScript.
export class WebviewAdapter {
  constructor(container, events) {
    this.container = container;
    this.events = events;
    this.wv = null;
    this.timer = null;
    this.state = { t: 0, d: 0, paused: true, buffering: false, rate: 1 };
    this.caps = { seek: true, rate: true, overlayClicks: false, live: false };
  }

  async load(media, startAt = 0, shouldPlay = true) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', window.vortexDesktop?.partition || 'persist:vortex-drm');
    wv.setAttribute('allowpopups', '');
    wv.style.cssText = 'width:100%;height:100%;border:0;';
    wv.src = media.url;
    this.wv = wv;
    this.container.replaceChildren(wv);
    await new Promise((res) => { wv.addEventListener('dom-ready', res, { once: true }); setTimeout(res, 8000); });
    if (startAt > 1) this.seek(startAt);
    if (shouldPlay) this.play();
    this.timer = setInterval(() => this.poll(), 250);
    this.events.onReady?.();
  }

  async poll() {
    if (!this.wv?.executeJavaScript) return;
    try {
      const s = await this.wv.executeJavaScript(`(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const b = v.buffered?.length ? v.buffered.end(v.buffered.length - 1) : 0;
        return { t: v.currentTime || 0, d: v.duration || 0, paused: v.paused, buffering: v.readyState < 3, rate: v.playbackRate || 1, buf: b };
      })()`);
      if (s) this.state = s;
    } catch (e) { /* cross-navigation */ }
  }

  exec(code) { try { this.wv?.executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) { ${code} } })()`); } catch (e) { /* ignore */ } }
  play() { this.exec('v.play().catch(()=>{})'); }
  pause() { this.exec('v.pause()'); }
  seek(sec) { this.state.t = sec; this.exec(`v.currentTime = ${Number(sec) || 0}`); }
  getTime() { return this.state.t || 0; }
  getDuration() { return this.state.d || 0; }
  getBuffered() { return this.state.buf ?? (this.state.t + 10); }
  isPaused() { return !!this.state.paused; }
  isBuffering() { return !!this.state.buffering; }
  setRate(r) { this.state.rate = r; this.exec(`v.playbackRate = ${Number(r) || 1}`); }
  getRate() { return this.state.rate || 1; }
  setVolume(v) { this.exec(`v.volume = ${Math.max(0, Math.min(1, Number(v) / 100))}`); }
  setMuted(m) { this.exec(`v.muted = ${!!m}`); }
  isMuted() { return false; }
  destroy() { clearInterval(this.timer); this.container.replaceChildren(); this.wv = null; }
}
