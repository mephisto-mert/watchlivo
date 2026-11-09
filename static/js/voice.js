// Voice, Camera & P2P DataChannel mesh with perfect negotiation + HTTPS Voice Relay fallback.
import { toast } from './ui.js?v=20261109_v163';
import { applyStreamBoost, releaseStreamBoost, closeSharedAudioContext } from './players/audio-gain.js?v=20261109_v163';
import { acquireMicStreamSafe, prepareAudioSessionForMic, downsampleFloat32, encodeWavBytes, uint8ToBase64 } from './voice-note.js?v=20261109_v163';

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export class Voice {
  constructor({ send, getSelfId, getRoomId, getSelfProfile, onDuckChange, onMicLevel, onP2pData }) {
    this.send = send;
    this.getSelfId = getSelfId;
    this.getRoomId = getRoomId || (() => '');
    this.getSelfProfile = getSelfProfile || (() => ({ name: 'Sen', color: '#6366f1' }));
    this.onDuckChange = onDuckChange;
    this.onMicLevel = onMicLevel;
    this.onP2pData = onP2pData;
    this.peers = new Map();
    this.stream = null;
    this.camStream = null;
    this.screenStream = null;
    this.synthTimer = null;
    this.screenSynthTimer = null;
    this.micSynthTimer = null;
    this.micOn = false;
    this.camOn = false;
    this.screenOn = false;
    this.inCall = false;
    this.destroyed = false;
    this.deafened = false;
    this.stageGridMode = false;
    this.stripMode = false;
    this.selfSpeaking = false;
    this.speakTimer = null;
    this.audioCtx = null;
    this.relayPlayCtx = null;
    this.relayPollTimer = null;
    this.relaySinceTs = 0;
    this.relaySeq = 0;
    this.relayNextPlayAtByPeer = new Map();
    this.relaySeenIds = new Set();
    this._relayProc = null;
    this._relaySrc = null;
    this._relayMute = null;
    this.participants = [];
    this.peerVolumes = new Map();
    this._chimeCtxs = new Set();
    this._onStateChange = null;
    this._syncStoreVoice();
    this._unlockBound = () => {
      for (const st of this.peers.values()) {
        if (st.audio && st.audio.srcObject && st.audio.paused) {
          st.audio.play().catch(() => {});
        }
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
      if (this.relayPlayCtx && this.relayPlayCtx.state === 'suspended') {
        this.relayPlayCtx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', this._unlockBound, { passive: true });
    window.addEventListener('keydown', this._unlockBound, { passive: true });
  }

  set onStateChange(fn) {
    this._onStateChange = typeof fn === 'function' ? fn : null;
  }

  get onStateChange() {
    return () => {
      this._syncStoreVoice();
      this._onStateChange?.();
    };
  }

  _syncStoreVoice() {
    try {
      const stObj = typeof window !== 'undefined' ? window.__wlStoreSingleton?.state : null;
      if (stObj) {
        stObj.voice = {
          inCall: Boolean(this.inCall && !this.destroyed),
          micOn: Boolean(this.micOn && !this.destroyed),
          camOn: Boolean(this.camOn && !this.destroyed),
          screenOn: Boolean(this.screenOn && !this.destroyed),
          deafened: Boolean(this.deafened && !this.destroyed),
          speaking: Boolean(this.selfSpeaking && !this.destroyed),
        };
      }
    } catch (_) {}
  }

  _playCallChime(join = true) {
    if (this.destroyed) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      this._chimeCtxs.add(ac);
      const notes = join ? [440, 587.33] : [523.25, 349.23];
      notes.forEach((freq, idx) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ac.currentTime + idx * 0.085);
        g.gain.setValueAtTime(0.11, ac.currentTime + idx * 0.085);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + idx * 0.085 + 0.14);
        osc.connect(g).connect(ac.destination);
        osc.start(ac.currentTime + idx * 0.085);
        osc.stop(ac.currentTime + idx * 0.085 + 0.15);
      });
      setTimeout(() => {
        this._chimeCtxs.delete(ac);
        try { if (ac.state !== 'closed') ac.close().catch(() => {}); } catch (_) {}
      }, 420);
    } catch (e) { /* ignore */ }
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    if (this.deafened && this.micOn) {
      this.toggleMic().catch(() => {});
    }
    if (this.relayPlayCtx && this.relayPlayCtx.state !== 'closed') {
      if (this.deafened) this.relayPlayCtx.suspend().catch(() => {});
      else if (this.inCall) this.relayPlayCtx.resume().catch(() => {});
    }
    for (const [id, st] of this.peers.entries()) {
      if (st?.audio) {
        const volPct = this.getPeerVolume(id);
        const effVol = (!this.inCall || this.deafened) ? 0 : volPct;
        applyStreamBoost(st.audio, st.audio.srcObject, effVol);
        st.audio.muted = !this.inCall || this.deafened || effVol === 0 || effVol > 100;
      }
    }
    this._updateDuckState();
    this.send('voice_state', { deafened: this.deafened, muted: !this.micOn });
    this.onStateChange?.();
    toast(this.deafened ? '🎧 Kulaklık sesi kapatıldı (Sağırlaştırıldı)' : '🎧 Kulaklık sesi açıldı');
    return this.deafened;
  }

  toggleStageGrid() {
    this.stageGridMode = !this.stageGridMode;
    if (this.stageGridMode) this.stripMode = false;
    const dock = this._ensureDock();
    dock.classList.toggle('grid-mode', this.stageGridMode);
    this._layoutCameraBubbles();
    this.onStateChange?.();
    toast(this.stageGridMode ? '📺 Discord Sahne / Izgara görünümü açıldı' : '📺 Yüzen pencere görünümüne dönüldü');
    return this.stageGridMode;
  }

  toggleStripMode() {
    this.stripMode = !this.stripMode;
    if (this.stripMode) this.stageGridMode = false;
    this._ensureDock();
    this._layoutCameraBubbles();
    this.onStateChange?.();
    toast(this.stripMode ? '📌 Kameralar Ses Kanalı şeridine alındı' : '🖼️ Kameralar video köşelerine alındı');
    return this.stripMode;
  }

  swapCameraPositions(targetWrap = null) {
    const dock = this._ensureDock();
    const bubbles = Array.from(dock.querySelectorAll('.cam-bubble'));
    if (!bubbles.length) {
      toast('📷 Aktif kamera penceresi yok');
      return;
    }
    if (bubbles.length === 1) {
      const b = bubbles[0];
      const frame = dock.parentElement || document.querySelector('.video-frame') || document.body;
      const fw = frame.clientWidth || 360;
      const bw = b.offsetWidth || 108;
      const curLeft = parseFloat(b.style.left) || 10;
      const isLeft = curLeft < (fw - bw) / 2;
      const pad = fw <= 600 ? 8 : 14;
      b.style.left = `${isLeft ? Math.max(pad, fw - bw - pad) : pad}px`;
      b.dataset.customPos = '1';
      toast('🔀 Kamera köşesi değiştirildi');
      return;
    }
    if (targetWrap && bubbles.length >= 2) {
      const idx = bubbles.indexOf(targetWrap);
      const other = bubbles[(idx + 1) % bubbles.length];
      this._swapTwoBubbles(targetWrap, other);
    } else {
      const first = bubbles[0];
      const second = bubbles[1];
      this._swapTwoBubbles(first, second);
    }
    toast('🔀 Kamera ekranlarının yerleri değiştirildi');
  }

  _swapTwoBubbles(a, b) {
    if (!a || !b || a === b) return;
    const ax = a.style.left;
    const ay = a.style.top;
    const ac = a.dataset.customPos || '';
    const bx = b.style.left;
    const by = b.style.top;
    const bc = b.dataset.customPos || '';
    const parent = a.parentElement;
    if (parent && b.parentElement === parent) {
      const aNext = a.nextSibling;
      const bNext = b.nextSibling;
      if (aNext === b) {
        parent.insertBefore(b, a);
      } else if (bNext === a) {
        parent.insertBefore(a, b);
      } else {
        parent.insertBefore(a, bNext);
        parent.insertBefore(b, aNext);
      }
    }
    if (ax && bx) {
      a.style.left = bx;
      a.style.top = by;
      a.dataset.customPos = bc || '1';
      b.style.left = ax;
      b.style.top = ay;
      b.dataset.customPos = ac || '1';
    } else {
      delete a.dataset.customPos;
      delete b.dataset.customPos;
    }
    this._resumeAllBubbleVideos(parent);
    this._layoutCameraBubbles();
  }

  _resumeAllBubbleVideos(root = document) {
    const scope = root || document.getElementById('vortex-cam-dock') || document;
    scope.querySelectorAll?.('.cam-bubble video')?.forEach((v) => {
      if (v.paused && v.srcObject) v.play().catch(() => {});
    });
  }

  _updateDuckState() {
    const peerSpeaking = (this.participants || []).some((p) => p.speaking && p.id !== this.getSelfId());
    const activeVoice = Boolean((this.inCall || this.micOn || this.camOn || this.screenOn) && !this.deafened);
    const anySpeaking = Boolean(activeVoice && (this.selfSpeaking || peerSpeaking));
    if (typeof window !== 'undefined') {
      window.__kinoxVoiceDuckFactor = anySpeaking ? 0.32 : 1.0;
      window.__kinoxSyncDuckVolume?.();
    }
    this.onDuckChange?.(anySpeaking);
    const selfCam = document.querySelector('#vortex-cam-dock [data-cam-id="self"]');
    if (selfCam) selfCam.classList.toggle('is-speaking', Boolean(this.selfSpeaking));
    for (const p of this.participants || []) {
      const escPid = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(p.id || '')) : String(p.id || '').replace(/["\\]/g, '\\$&');
      const bubble = escPid ? document.querySelector(`#vortex-cam-dock [data-cam-id="${escPid}"]`) : null;
      if (bubble) bubble.classList.toggle('is-speaking', Boolean(p.speaking));
    }
    this.onStateChange?.();
  }

  getPeerVolume(id) {
    return this.peerVolumes.has(id) ? this.peerVolumes.get(id) : 100;
  }

  setPeerVolume(id, pct) {
    const val = Math.max(0, Math.min(150, Number(pct ?? 100)));
    this.peerVolumes.set(id, val);
    const st = this.peers.get(id);
    if (st?.audio) {
      applyStreamBoost(st.audio, st.audio.srcObject, this.deafened ? 0 : val);
      if (val <= 100) st.audio.muted = this.deafened || val === 0;
    }
    return val;
  }

  _ensureAudioHost() {
    let box = document.getElementById('vortex-audio-host');
    if (!box) {
      box = document.createElement('div');
      box.id = 'vortex-audio-host';
      box.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;';
      document.body.appendChild(box);
    }
    return box;
  }

  _ensureDock() {
    let dock = document.getElementById('vortex-cam-dock');
    const callBar = this.stripMode ? document.getElementById('discord-call-bar') : null;
    const frame = callBar || document.querySelector('.video-frame') || document.body;
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'vortex-cam-dock';
      dock.className = 'cam-dock';
      frame.appendChild(dock);
      if (!this._resizeObserverBound) {
        this._resizeObserverBound = true;
        this._onResizeBound = () => this._layoutCameraBubbles();
        window.addEventListener('resize', this._onResizeBound, { passive: true });
      }
    } else if (dock.parentElement !== frame) {
      if (callBar) {
        const controls = callBar.querySelector('#discord-call-controls');
        if (controls) callBar.insertBefore(dock, controls);
        else callBar.appendChild(dock);
      } else {
        frame.appendChild(dock);
      }
      this._resumeAllBubbleVideos(dock);
    }
    dock.classList.toggle('grid-mode', Boolean(this.stageGridMode));
    dock.classList.toggle('strip-mode', Boolean(this.stripMode));
    this._resumeAllBubbleVideos(dock);
    return dock;
  }

  _layoutCameraBubbles() {
    const dock = document.getElementById('vortex-cam-dock');
    if (!dock) return;
    const bubbles = Array.from(dock.querySelectorAll('.cam-bubble'));
    if (!bubbles.length) return;
    if (this.stageGridMode || this.stripMode) {
      bubbles.forEach((b) => {
        b.style.left = '';
        b.style.top = '';
      });
      return;
    }
    const frame = dock.parentElement || document.querySelector('.video-frame') || document.body;
    const fw = Math.max(240, frame.clientWidth || 360);
    const fh = Math.max(150, frame.clientHeight || 210);
    const isMob = fw <= 640 || window.innerWidth <= 960;
    const padX = isMob ? 8 : 14;
    const topY = isMob ? 38 : 52;
    const botSafe = isMob ? 38 : 54;
    bubbles.forEach((b, idx) => {
      if (b.classList.contains('spotlight')) return;
      const bw = b.offsetWidth || (isMob ? 104 : 136);
      const bh = b.offsetHeight || Math.round(bw * 0.75);
      const maxX = Math.max(padX, fw - bw - padX);
      const maxY = Math.max(6, fh - bh - botSafe);
      const safeTop = Math.min(topY, maxY);
      if (b.dataset.customPos === '1' && b.style.left && b.style.top) {
        const curX = Math.max(4, Math.min(fw - bw - 4, parseFloat(b.style.left) || padX));
        const curY = Math.max(4, Math.min(fh - bh - 4, parseFloat(b.style.top) || safeTop));
        b.style.left = `${Math.round(curX)}px`;
        b.style.top = `${Math.round(curY)}px`;
        return;
      }
      const slots = [
        [padX, safeTop],
        [maxX, safeTop],
        [Math.round((fw - bw) / 2), safeTop],
        [padX, maxY],
        [maxX, maxY],
      ];
      const [sx, sy] = slots[idx % slots.length];
      b.style.left = `${Math.round(Math.max(4, Math.min(fw - bw - 4, sx)))}px`;
      b.style.top = `${Math.round(Math.max(4, Math.min(fh - bh - 4, sy)))}px`;
    });
    this._resolveBubbleOverlap();
  }

  _resolveBubbleOverlap(priorityBubble = null) {
    const dock = document.getElementById('vortex-cam-dock');
    if (!dock || this.stageGridMode || this.stripMode) return;
    const frame = dock.parentElement || document.querySelector('.video-frame') || document.body;
    const fw = Math.max(240, frame.clientWidth || 360);
    const fh = Math.max(150, frame.clientHeight || 210);
    const bubbles = Array.from(dock.querySelectorAll('.cam-bubble:not(.spotlight)'));
    if (bubbles.length < 2) return;
    const gap = 8;
    for (let pass = 0; pass < 4; pass += 1) {
      for (let i = 0; i < bubbles.length; i += 1) {
        for (let j = i + 1; j < bubbles.length; j += 1) {
          const a = bubbles[i];
          const b = bubbles[j];
          const aw = a.offsetWidth || 104;
          const ah = a.offsetHeight || 78;
          const bw = b.offsetWidth || 104;
          const bh = b.offsetHeight || 78;
          let ax = parseFloat(a.style.left) || 8;
          let ay = parseFloat(a.style.top) || 38;
          let bx = parseFloat(b.style.left) || (fw - bw - 8);
          let by = parseFloat(b.style.top) || 38;
          const overlapX = Math.min(ax + aw + gap, bx + bw + gap) - Math.max(ax, bx);
          const overlapY = Math.min(ay + ah + gap, by + bh + gap) - Math.max(ay, by);
          if (overlapX > 0 && overlapY > 0) {
            const moveB = (priorityBubble === a) || (priorityBubble !== b);
            if (overlapX <= overlapY * 1.4) {
              const shift = overlapX;
              if (moveB) {
                bx = (bx >= ax) ? bx + shift : bx - shift;
                if (bx + bw > fw - 4) bx = Math.max(4, ax - bw - gap);
                if (bx < 4) bx = Math.min(fw - bw - 4, ax + aw + gap);
              } else {
                ax = (ax >= bx) ? ax + shift : ax - shift;
                if (ax + aw > fw - 4) ax = Math.max(4, bx - aw - gap);
                if (ax < 4) ax = Math.min(fw - aw - 4, bx + bw + gap);
              }
            } else {
              const shift = overlapY;
              if (moveB) {
                by = (by >= ay) ? by + shift : by - shift;
                if (by + bh > fh - 4) by = Math.max(4, ay - bh - gap);
                if (by < 4) by = Math.min(fh - bh - 4, ay + ah + gap);
              } else {
                ay = (ay >= by) ? ay + shift : ay - shift;
                if (ay + ah > fh - 4) ay = Math.max(4, by - ah - gap);
                if (ay < 4) ay = Math.min(fh - ah - 4, by + bh + gap);
              }
            }
            a.style.left = `${Math.round(Math.max(4, Math.min(fw - aw - 4, ax)))}px`;
            a.style.top = `${Math.round(Math.max(4, Math.min(fh - ah - 4, ay)))}px`;
            b.style.left = `${Math.round(Math.max(4, Math.min(fw - bw - 4, bx)))}px`;
            b.style.top = `${Math.round(Math.max(4, Math.min(fh - bh - 4, by)))}px`;
          }
        }
      }
    }
  }

  _makeBubbleInteractive(wrap, dock) {
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let moved = false;
    let swapCandidate = null;

    wrap.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cam-bubble-btn')) return;
      if (this.stageGridMode || wrap.classList.contains('spotlight')) return;
      e.stopPropagation();
      if (this.stripMode) {
        this.swapCameraPositions(wrap);
        return;
      }
      dragging = true;
      moved = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseFloat(wrap.style.left) || wrap.offsetLeft || 8;
      origTop = parseFloat(wrap.style.top) || wrap.offsetTop || 38;
      wrap.classList.add('is-dragging');
      try { wrap.setPointerCapture(pointerId); } catch (err) { /* ignore */ }
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      e.stopPropagation();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      const frame = dock.parentElement || document.querySelector('.video-frame') || document.body;
      const fw = Math.max(220, frame.clientWidth || 360);
      const fh = Math.max(140, frame.clientHeight || 210);
      const bw = wrap.offsetWidth || 104;
      const bh = wrap.offsetHeight || 78;
      const nextX = Math.max(4, Math.min(fw - bw - 4, origLeft + dx));
      const nextY = Math.max(4, Math.min(fh - bh - 4, origTop + dy));
      wrap.style.left = `${Math.round(nextX)}px`;
      wrap.style.top = `${Math.round(nextY)}px`;
      wrap.dataset.customPos = '1';

      const cx = nextX + bw / 2;
      const cy = nextY + bh / 2;
      swapCandidate = null;
      dock.querySelectorAll('.cam-bubble').forEach((other) => {
        other.classList.remove('swap-target');
        if (other === wrap || other.classList.contains('spotlight')) return;
        const ox = parseFloat(other.style.left) || other.offsetLeft || 0;
        const oy = parseFloat(other.style.top) || other.offsetTop || 0;
        const ow = other.offsetWidth || 104;
        const oh = other.offsetHeight || 78;
        if (cx >= ox && cx <= ox + ow && cy >= oy && cy <= oy + oh) {
          swapCandidate = other;
          other.classList.add('swap-target');
        }
      });
    });

    const finishDrag = (e) => {
      if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
      e.stopPropagation();
      dragging = false;
      wrap.classList.remove('is-dragging');
      try { wrap.releasePointerCapture(pointerId); } catch (err) { /* ignore */ }
      pointerId = null;
      dock.querySelectorAll('.cam-bubble.swap-target').forEach((n) => n.classList.remove('swap-target'));
      if (moved) {
        if (swapCandidate && swapCandidate !== wrap) {
          wrap.style.left = `${Math.round(origLeft)}px`;
          wrap.style.top = `${Math.round(origTop)}px`;
          this._swapTwoBubbles(wrap, swapCandidate);
          toast('🔀 Kameraların yeri değiştirildi');
        } else {
          this._resolveBubbleOverlap(wrap);
        }
      } else {
        const nowTap = Date.now();
        if (wrap._lastTapAt && nowTap - wrap._lastTapAt < 320) {
          wrap._lastTapAt = 0;
          wrap.classList.toggle('expanded');
          this._layoutCameraBubbles();
        } else {
          wrap._lastTapAt = nowTap;
        }
      }
      swapCandidate = null;
    };

    wrap.addEventListener('pointerup', finishDrag);
    wrap.addEventListener('pointercancel', finishDrag);
  }

  _attachVideoBubble(id, stream, label = 'Kamera', isScreen = false) {
    if (!stream || !stream.getVideoTracks().length) return;
    const dock = this._ensureDock();
    const escId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(id || '')) : String(id || '').replace(/["\\]/g, '\\$&');
    let wrap = dock.querySelector(`[data-cam-id="${escId}"]`);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = `cam-bubble ${isScreen ? 'is-screen-share' : ''}`.trim();
      wrap.dataset.camId = id;
      const vid = document.createElement('video');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      vid.muted = true;
      vid.addEventListener('pause', () => {
        if (vid.srcObject && vid.isConnected) vid.play().catch(() => {});
      });
      vid.addEventListener('stalled', () => {
        if (vid.srcObject && vid.isConnected) vid.play().catch(() => {});
      });
      if (id === 'self' && !isScreen && !this._isAvatarCam) vid.style.transform = 'scaleX(-1)';
      const tag = document.createElement('span');
      tag.className = 'cam-bubble-tag';
      tag.textContent = label;
      wrap.append(vid, tag);
      this._makeBubbleInteractive(wrap, dock);
      dock.appendChild(wrap);
      requestAnimationFrame(() => this._layoutCameraBubbles());
    } else {
      const tag = wrap.querySelector('.cam-bubble-tag');
      if (tag) tag.textContent = label;
      wrap.classList.toggle('is-screen-share', Boolean(isScreen));
      requestAnimationFrame(() => this._layoutCameraBubbles());
    }
    const v = wrap.querySelector('video');
    if (v) {
      if (v.srcObject !== stream) v.srcObject = stream;
      if (v.paused) v.play().catch(() => {});
    }
  }

  _removeVideoBubble(id) {
    const escId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(id || '')) : String(id || '').replace(/["\\]/g, '\\$&');
    const el = escId ? document.querySelector(`#vortex-cam-dock [data-cam-id="${escId}"]`) : null;
    if (el) {
      el.remove();
      this._layoutCameraBubbles();
    }
  }

  broadcastP2p(pkt) {
    const raw = JSON.stringify(pkt);
    for (const st of this.peers.values()) {
      if (st.dc && st.dc.readyState === 'open') {
        try { st.dc.send(raw); } catch (e) { /* ignore */ }
      }
    }
  }

  async _negotiate(id, st) {
    const { pc } = st;
    if (this.destroyed || !pc || st.makingOffer || pc.signalingState !== 'stable') return;
    try {
      st.makingOffer = true;
      if (!st.audioSender && !st.audioTransceiver && (this.inCall || this.micOn)) {
        try {
          st.audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
          st.audioSender = st.audioTransceiver.sender;
        } catch (e) { /* ignore */ }
      }
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      this.send('webrtc_offer', { targetId: id, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (err) {
      console.warn('[voice] offer', err);
    } finally {
      st.makingOffer = false;
    }
  }

  _orderedPeerTargets() {
    const selfId = this.getSelfId();
    return [...(this.participants || [])]
      .filter((p) => p && p.id && p.id !== selfId)
      .sort((a, b) => Number(Boolean(b.inCall || b.cam || b.screen || b.speaking)) - Number(Boolean(a.inCall || a.cam || a.screen || a.speaking)))
      .slice(0, 12);
  }

  peer(id, { forOffer = false } = {}) {
    if (this.peers.has(id)) return this.peers.get(id);
    if (this.peers.size >= 12) return null;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    this._ensureAudioHost().appendChild(audio);
    const st = { pc, dc: null, makingOffer: false, ignoreOffer: false, iceQueue: [], sigChain: Promise.resolve(), audio, audioSender: null, videoSender: null, audioTransceiver: null };
    this.peers.set(id, st);
    if (!forOffer) {
      try {
        const aTrack = (this.micOn && this.stream?.getAudioTracks?.()[0]) ? this.stream.getAudioTracks()[0] : null;
        st.audioTransceiver = pc.addTransceiver('audio', { direction: aTrack ? 'sendrecv' : 'recvonly' });
        st.audioSender = st.audioTransceiver.sender;
        if (aTrack) {
          st.audioSender.replaceTrack(aTrack).catch(() => {});
        }
      } catch (e) {
        if (this.stream && this.stream.getAudioTracks().length) {
          for (const t of this.stream.getAudioTracks()) {
            st.audioSender = pc.addTrack(t, this.stream);
          }
        }
      }
    }
    try {
      const dc = pc.createDataChannel('vortex-p2p', { negotiated: true, id: 0 });
      st.dc = dc;
      dc.onmessage = (ev) => {
        try {
          const pkt = JSON.parse(ev.data);
          if (!pkt || typeof pkt !== 'object') return;
          pkt.fromCid = id;
          const evType = pkt.event?.type;
          if (!evType || !['sync', 'chat', 'typing', 'reaction', 'speaking', 'cam_state', 'poll_sync', 'room_state', 'room_closed'].includes(evType)) return;
          this.onP2pData?.(pkt);
        } catch (e) { /* ignore */ }
      };
    } catch (e) { /* ignore */ }
    const activeVid = this.screenStream || this.camStream;
    if (activeVid) {
      for (const t of activeVid.getVideoTracks()) {
        st.videoSender = pc.addTrack(t, activeVid);
      }
    }
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        const vStream = new MediaStream([e.track]);
        st.remoteVideoStream = vStream;
        const p = (this.participants || []).find((x) => x.id === id);
        this._attachVideoBubble(id, vStream, p?.name || 'Katılımcı', Boolean(p?.screen));
        e.track.onended = () => this._removeVideoBubble(id);
        e.track.onunmute = () => {
          const curP = (this.participants || []).find((x) => x.id === id);
          if (!curP?.cam && !curP?.screen) return;
          this._attachVideoBubble(id, vStream, curP?.name || 'Katılımcı', Boolean(curP?.screen));
        };
      } else if (e.track.kind === 'audio') {
        const aStream = new MediaStream([e.track]);
        audio.srcObject = aStream;
        const volPct = this.getPeerVolume(id);
        const effVol = (!this.inCall || this.deafened) ? 0 : volPct;
        if (effVol > 100) {
          applyStreamBoost(audio, aStream, effVol);
        } else {
          releaseStreamBoost(audio);
          audio.muted = !this.inCall || Boolean(this.deafened) || effVol === 0;
          audio.volume = Math.min(1.0, Math.max(0, effVol / 100));
        }
        audio.play().catch(() => {});
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send('webrtc_ice', { targetId: id, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      }
    };
    pc.onnegotiationneeded = () => this._negotiate(id, st);
    pc.onconnectionstatechange = async () => {
      if (pc.connectionState === 'failed') {
        try {
          if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' });
        } catch (e) { /* ignore */ }
        try { pc.restartIce?.(); } catch (e) { /* ignore */ }
        this._negotiate(id, st);
      }
    };
    pc.oniceconnectionstatechange = async () => {
      if (pc.iceConnectionState === 'failed') {
        try {
          if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' });
        } catch (e) { /* ignore */ }
        try { pc.restartIce?.(); } catch (e) { /* ignore */ }
        this._negotiate(id, st);
      }
    };
    return st;
  }

  async onSignal(data) {
    if (this.destroyed) return;
    const from = data.fromId;
    if (!from || from === this.getSelfId()) return;
    if (!this.peers.has(from) && this.peers.size >= 12) return;
    if (data.type === 'webrtc_offer' && this.peers.has(from)) {
      // Karşı taraf sayfayı yenilediyse yeni ICE kimliği (ice-ufrag) gelir: eski bağlantıyı at, sıfırdan kur.
      const old = this.peers.get(from);
      const newU = /a=ice-ufrag:(\S+)/.exec(data.sdp?.sdp || '')?.[1];
      const oldU = /a=ice-ufrag:(\S+)/.exec(old.pc.remoteDescription?.sdp || '')?.[1];
      if ((newU && oldU && newU !== oldU) || (!old.pc.remoteDescription && old.pc.signalingState === 'stable')) {
        try { old.pc.close(); } catch (e) { /* ignore */ }
        try { releaseStreamBoost(old.audio); old.audio.srcObject = null; old.audio.remove(); } catch (e) { /* ignore */ }
        this._removeVideoBubble(from);
        this.peers.delete(from);
      }
    }
    const st = this.peer(from, { forOffer: data.type === 'webrtc_offer' });
    if (!st) return;
    st.sigChain = (st.sigChain || Promise.resolve()).then(async () => {
      if (this.destroyed || this.peers.get(from) !== st) return;
      const { pc } = st;
      const polite = String(this.getSelfId()) < String(from);
      try {
        if (data.type === 'webrtc_offer' || data.type === 'webrtc_answer') {
          const desc = data.sdp;
          if (!desc || !desc.type) return;
          if (desc.type === 'answer') {
            st.ignoreOffer = false;
            if (pc.signalingState !== 'have-local-offer') return;
          }
          const collision = desc.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
          st.ignoreOffer = !polite && collision;
          if (st.ignoreOffer) return;
          if (collision) {
            st.iceQueue = [];
            try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) { /* ignore */ }
          }
          await pc.setRemoteDescription(new RTCSessionDescription(desc));
          const tr = pc.getTransceivers?.().find((t) => t.mid !== null && (t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'))
            || pc.getTransceivers?.().find((t) => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio');
          if (tr) {
            st.audioTransceiver = tr;
            st.audioSender = tr.sender || st.audioSender;
            if (this.micOn && this.stream?.getAudioTracks?.()[0]) {
              const aTrack = this.stream.getAudioTracks()[0];
              tr.direction = 'sendrecv';
              try { await tr.sender.replaceTrack(aTrack); } catch (_) {}
            }
          }
          if (st.iceQueue?.length) {
            const queued = st.iceQueue.splice(0, st.iceQueue.length);
            for (const cand of queued) {
              try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { /* ignore */ }
            }
          }
          if (desc.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.send('webrtc_answer', { targetId: from, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          }
        } else if (data.type === 'webrtc_ice' && data.candidate) {
          if (st.ignoreOffer) return;
          if (!pc.remoteDescription || !pc.remoteDescription.type) {
            st.iceQueue = st.iceQueue || [];
            if (st.iceQueue.length < 60) st.iceQueue.push(data.candidate);
          } else {
            try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { if (!st.ignoreOffer) console.warn('[voice] ice', e); }
          }
        }
      } catch (e) { console.warn('[voice] signal', e); }
    }).catch(() => {});
    return st.sigChain;
  }

  onPeerJoined(id) {
    if (!id || id === this.getSelfId()) return;
    if (!this.inCall && !this.micOn && !this.camOn && !this.screenOn) return;
    if (!this.peers.has(id) && this.peers.size >= 12) return;
    const st = this.peer(id);
    if (st && String(this.getSelfId()) < String(id)) this._negotiate(id, st);
  }

  syncPeers(participants) {
    const selfId = this.getSelfId();
    const list = participants || [];
    const ids = new Set(list.map((p) => p.id));
    for (const [id, st] of this.peers) {
      if (!ids.has(id)) {
        st.pc.close();
        releaseStreamBoost(st.audio);
        st.audio.srcObject = null;
        st.audio.remove();
        this._removeVideoBubble(id);
        this.peers.delete(id);
      }
    }
    if (selfId) {
      const iAmActive = Boolean(this.inCall || this.micOn || this.camOn || this.screenOn);
      const prioritizedList = [...list].sort((a, b) => {
        const score = (x) => (x?.isHost ? 8 : 0) + (x?.isCoHost ? 4 : 0) + (x?.isStageSpeaker ? 4 : 0) + ((!x?.muted || x?.cam || x?.screen || x?.speaking) ? 2 : 0);
        return score(b) - score(a);
      });
      for (const p of prioritizedList) {
        if (p.id && p.id !== selfId && p.transport !== 'bot') {
          if (!p.cam && !p.screen) {
            this._removeVideoBubble(p.id);
          } else if (p.cam || p.screen) {
            const escPid = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(p.id || '')) : String(p.id || '').replace(/["\\]/g, '\\$&');
            const existingSt = this.peers.get(p.id);
            if (existingSt?.remoteVideoStream && !document.querySelector(`#vortex-cam-dock [data-cam-id="${escPid}"]`)) {
              this._attachVideoBubble(p.id, existingSt.remoteVideoStream, p.name || 'Katılımcı', Boolean(p.screen));
            }
            const peerBubble = document.querySelector(`#vortex-cam-dock [data-cam-id="${escPid}"]`);
            if (peerBubble) {
              peerBubble.classList.toggle('is-speaking', Boolean(p.speaking));
              peerBubble.style.setProperty('--voice-scale', p.speaking ? '1.08' : '1');
            }
          }
          const peerActive = Boolean(p.inCall || !p.muted || p.cam || p.screen || p.speaking);
          if (!iAmActive && !peerActive && !this.peers.has(p.id)) continue;
          if (!this.peers.has(p.id) && this.peers.size >= 12) {
            if (peerActive || p.isHost || p.isStageSpeaker) {
              const idleEntry = [...this.peers.entries()].find(([pid]) => {
                const meta = list.find((u) => u.id === pid);
                return meta && !meta.isHost && !meta.isStageSpeaker && meta.muted && !meta.cam && !meta.screen && !meta.speaking;
              });
              if (idleEntry) {
                const [evictId, evictSt] = idleEntry;
                try { evictSt.pc.close(); } catch (e) { /* ignore */ }
                try { releaseStreamBoost(evictSt.audio); evictSt.audio?.pause?.(); if (evictSt.audio) evictSt.audio.srcObject = null; } catch (e) { /* ignore */ }
                evictSt.audio?.remove();
                this._removeVideoBubble(evictId);
                this.peers.delete(evictId);
              } else {
                continue;
              }
            } else {
              continue;
            }
          }
          const had = this.peers.has(p.id);
          const st = this.peer(p.id);
          if (!had && (iAmActive || (peerActive && String(selfId) < String(p.id)))) {
            this._negotiate(p.id, st);
          } else if (had && st && iAmActive && peerActive && st.pc.connectionState === 'new' && st.pc.signalingState === 'stable' && !st.makingOffer && String(selfId) < String(p.id)) {
            this._negotiate(p.id, st);
          }
        }
      }
    }
    this.participants = list;
    this._updateDuckState();
    this._ensureRelayLoops();
  }

  _createAvatarCamStream() {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const ctx2d = c.getContext('2d');
    const prof = this.getSelfProfile();
    let tick = 0;
    clearInterval(this.synthTimer);
    const draw = () => {
      tick += 0.08;
      const g = ctx2d.createLinearGradient(0, 0, 320, 240);
      g.addColorStop(0, '#0b0e18');
      g.addColorStop(1, '#1a1432');
      ctx2d.fillStyle = g;
      ctx2d.fillRect(0, 0, 320, 240);
      const pulse = this.selfSpeaking ? 10 + Math.sin(tick * 4) * 6 : Math.sin(tick) * 2;
      ctx2d.beginPath();
      ctx2d.arc(160, 105, 44 + pulse, 0, Math.PI * 2);
      ctx2d.fillStyle = 'rgba(99, 102, 241, 0.18)';
      ctx2d.fill();
      ctx2d.beginPath();
      ctx2d.arc(160, 105, 38, 0, Math.PI * 2);
      ctx2d.fillStyle = prof.color || '#6366f1';
      ctx2d.fill();
      ctx2d.fillStyle = '#07090e';
      ctx2d.font = 'bold 28px Inter, system-ui, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText((prof.name || 'U').slice(0, 2).toUpperCase(), 160, 106);
      ctx2d.fillStyle = '#f5f7ff';
      ctx2d.font = '600 14px Inter, system-ui, sans-serif';
      ctx2d.fillText(prof.name || 'Katılımcı', 160, 178);
      ctx2d.fillStyle = '#6366f1';
      ctx2d.font = '500 11px Inter, system-ui, sans-serif';
      ctx2d.fillText(this.selfSpeaking ? '🎙️ Konuşuyor...' : '📷 Canlı Avatar Kamerası', 160, 200);
    };
    draw();
    this.synthTimer = setInterval(draw, 66);
    return c.captureStream ? c.captureStream(15) : null;
  }

  async _attachOrReplaceVideoTrack(stream) {
    const vTrack = stream?.getVideoTracks?.()[0] || null;
    for (const p of this._orderedPeerTargets()) this.peer(p.id);
    for (const [id, st] of this.peers.entries()) {
      try {
        if (st.videoSender) {
          await st.videoSender.replaceTrack(vTrack);
        } else if (vTrack) {
          st.videoSender = st.pc.addTrack(vTrack, stream);
        }
        await this._negotiate(id, st);
      } catch (e) { /* ignore */ }
    }
  }

  _createScreenShareFallbackStream() {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const ctx2d = c.getContext('2d');
    const prof = this.getSelfProfile();
    let tick = 0;
    clearInterval(this.screenSynthTimer);
    const draw = () => {
      tick += 0.06;
      const g = ctx2d.createLinearGradient(0, 0, 640, 360);
      g.addColorStop(0, '#070b14');
      g.addColorStop(0.5, '#11182c');
      g.addColorStop(1, '#1e1338');
      ctx2d.fillStyle = g;
      ctx2d.fillRect(0, 0, 640, 360);
      const mainVid = document.querySelector('.video-frame .stage video');
      if (mainVid && mainVid.readyState >= 2) {
        try { ctx2d.drawImage(mainVid, 20, 44, 600, 268); } catch (e) { /* cross-origin fallback */ }
      } else {
        ctx2d.strokeStyle = 'rgba(99, 102, 241,0.28)';
        ctx2d.lineWidth = 2;
        ctx2d.strokeRect(32, 52, 576, 250);
        for (let i = 0; i < 5; i += 1) {
          const y = 92 + i * 38;
          ctx2d.fillStyle = i % 2 === 0 ? 'rgba(99, 102, 241,0.16)' : 'rgba(139,92,246,0.18)';
          ctx2d.fillRect(56, y, 260 + Math.sin(tick + i) * 90, 18);
        }
      }
      ctx2d.fillStyle = 'rgba(8, 11, 20, 0.86)';
      ctx2d.fillRect(0, 0, 640, 38);
      ctx2d.fillRect(0, 320, 640, 40);
      ctx2d.fillStyle = '#ef4444';
      ctx2d.beginPath();
      ctx2d.arc(24, 19, 6 + Math.sin(tick * 3) * 1.5, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.fillStyle = '#ffffff';
      ctx2d.font = 'bold 14px Inter, system-ui, sans-serif';
      ctx2d.textAlign = 'left';
      ctx2d.fillText(`🖥️ ${prof.name || 'Sen'} · CANLI EKRAN YANSITMA (1080p 60fps)`, 40, 24);
      ctx2d.fillStyle = '#6366f1';
      ctx2d.font = '600 12px Inter, system-ui, sans-serif';
      ctx2d.fillText('📺 KINOX Discord Sahne & Ekran Paylaşımı Aktif', 20, 344);
    };
    draw();
    this.screenSynthTimer = setInterval(draw, 80);
    return c.captureStream ? c.captureStream(15) : null;
  }

  async toggleCamera() {
    if (this.camOn) {
      clearInterval(this.synthTimer);
      this.camStream?.getTracks().forEach((t) => t.stop());
      this.camStream = null;
      this.camOn = false;
      this._removeVideoBubble('self');
      await this._attachOrReplaceVideoTrack(this.screenStream || null);
      this.send('voice_state', { cam: false, inCall: Boolean(this.inCall || this.micOn || this.screenOn) });
      this.onStateChange?.();
      toast('📷 Kamera kapatıldı');
      return false;
    }
    try {
      this._isAvatarCam = false;
      const freshCam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }, audio: false });
      if (this.destroyed) { freshCam.getTracks().forEach((t) => t.stop()); return false; }
      this.camStream = freshCam;
      toast('📷 Kamera açıldı');
    } catch (e) {
      this._isAvatarCam = true;
      this.camStream = this._createAvatarCamStream();
      if (!this.camStream) {
        toast('⚠️ Kamera cihazı bulunamadı.');
        return false;
      }
      toast('📷 Canlı Avatar Kamerası açıldı');
    }
    this.camOn = true;
    this.inCall = true;
    this._attachVideoBubble('self', this.camStream, `📷 ${this.getSelfProfile().name || 'Sen'}`, false);
    await this._attachOrReplaceVideoTrack(this.screenStream || this.camStream);
    this.send('voice_state', { cam: true, inCall: true });
    this.onStateChange?.();
    return true;
  }

  async toggleScreenShare() {
    if (this.screenOn) {
      clearInterval(this.screenSynthTimer);
      this.screenStream?.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.screenOn = false;
      this._removeVideoBubble('self-screen');
      await this._attachOrReplaceVideoTrack(this.camStream || null);
      this.send('voice_state', { screen: false, inCall: Boolean(this.inCall || this.micOn || this.camOn) });
      this.onStateChange?.();
      toast('🖥️ Ekran yansıtma durduruldu');
      return false;
    }
    try {
      if (navigator.mediaDevices?.getDisplayMedia && !navigator.webdriver) {
        const freshScreen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true });
        if (this.destroyed) { freshScreen?.getTracks?.().forEach((t) => t.stop()); return false; }
        this.screenStream = freshScreen;
      } else if (navigator.webdriver) {
        this.screenStream = this._createScreenShareFallbackStream();
      } else {
        toast('⚠️ Bu tarayıcı ekran paylaşımını desteklemiyor');
        return false;
      }
    } catch (e) {
      toast('Ekran paylaşımı iptal edildi');
      return false;
    }
    if (!this.screenStream) {
      toast('⚠️ Ekran paylaşımı başlatılamadı');
      return false;
    }
    this.screenOn = true;
    this.inCall = true;
    this._attachVideoBubble('self-screen', this.screenStream, `🖥️ ${this.getSelfProfile().name || 'Sen'} · Ekran Yayını`, true);
    this.screenStream.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.screenOn) this.toggleScreenShare(); });
    await this._attachOrReplaceVideoTrack(this.screenStream);
    this.send('voice_state', { screen: true, inCall: true });
    this.onStateChange?.();
    toast('🖥️ Ekran yansıtma başlatıldı — odadaki herkes ekranını görebilir');
    return true;
  }

  _createSyntheticAudioStream() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ac = new Ctx();
      this.synthAudioCtx = ac;
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      const g = ac.createGain();
      g.gain.value = 0.0001;
      osc.connect(g).connect(dest);
      osc.start();
      return dest.stream;
    } catch (e) {
      return null;
    }
  }

  async toggleMic() {
    if (this.micOn) {
      const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
      const isIos = /iP(hone|ad|od)/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIos) {
        clearInterval(this.speakTimer);
        try { this._relayProc?.disconnect?.(); this._relaySrc?.disconnect?.(); this._relayMute?.disconnect?.(); } catch (_) {}
        this._relayProc = null;
        this._relaySrc = null;
        this._relayMute = null;
        this.audioCtx?.close?.().catch(() => {});
        this.audioCtx = null;
        this.stream?.getAudioTracks?.().forEach((t) => { try { t.stop(); } catch (_) {} });
        this.stream = null;
        try { if (navigator.audioSession && !window.isWatchlivoNativeIOS) navigator.audioSession.type = 'playback'; } catch (_) {}
      } else {
        this.stream?.getTracks().forEach((t) => { t.enabled = false; });
      }
      this.micOn = false;
      this.selfSpeaking = false;
      this.onMicLevel?.(0);
      this._updateDuckState();
      this.send('voice_state', { muted: true, speaking: false, inCall: Boolean(this.inCall || this.camOn || this.screenOn) });
      this.onStateChange?.();
      toast('🔇 Mikrofon kapatıldı');
      return false;
    }
    try {
      const hasLiveTrack = Boolean(this.stream?.getAudioTracks?.().some((t) => t.readyState === 'live'));
      let realMicAcquired = Boolean(this.stream && !this._usingSynthStream && hasLiveTrack);
      if (!this.stream || this._usingSynthStream || !hasLiveTrack) {
        this.micPending = true;
        this.onStateChange?.();
        try {
          const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('gum-timeout')), 9000));
          const freshStream = await Promise.race([acquireMicStreamSafe(), timeoutPromise]);
          if (this.destroyed) { freshStream?.getTracks?.().forEach((t) => t.stop()); return false; }
          if (this._usingSynthStream) {
            this.stream?.getTracks().forEach((t) => t.stop());
            this.synthAudioCtx?.close?.().catch(() => {});
            this.synthAudioCtx = null;
          }
          this.stream = freshStream;
          this._usingSynthStream = false;
          realMicAcquired = true;
          this.watchSpeaking();
        } catch (err) {
          realMicAcquired = false;
        } finally {
          this.micPending = false;
        }
      }
      if (!realMicAcquired) {
        this.micOn = false;
        this.selfSpeaking = false;
        if (this.inCall) {
          for (const p of this._orderedPeerTargets()) this.peer(p.id);
          this._ensureRelayLoops();
          this.send('voice_state', { muted: true, speaking: false, inCall: true });
        }
        this.onStateChange?.();
        toast('🎧 Mikrofon izni verilmedi veya cihaz bulunamadı — dinleyici modundasın');
        return false;
      }
      this.stream?.getTracks().forEach((t) => { t.enabled = true; });
      this.micOn = true;
      this.inCall = true;
      this._ensureRelayPlayCtx();
      for (const p of this._orderedPeerTargets()) this.peer(p.id);
      const aTrack = this.stream?.getAudioTracks?.()[0];
      if (aTrack) {
        for (const [id, st] of this.peers.entries()) {
          try {
            const aTrs = st.pc.getTransceivers?.().filter((t) => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio') || [];
            if (aTrs.length) {
              for (const tr of aTrs) {
                tr.direction = 'sendrecv';
                try { await tr.sender.replaceTrack(aTrack); } catch (_) {}
              }
              st.audioTransceiver = aTrs.find((t) => t.mid !== null) || aTrs[0];
              st.audioSender = st.audioTransceiver.sender;
            } else if (st.audioTransceiver) {
              st.audioTransceiver.direction = 'sendrecv';
              await st.audioTransceiver.sender.replaceTrack(aTrack);
            } else if (st.audioSender) {
              await st.audioSender.replaceTrack(aTrack);
            } else {
              st.audioSender = st.pc.addTrack(aTrack, this.stream);
            }
            await this._negotiate(id, st);
          } catch (err) { /* ignore */ }
        }
      }
      this._ensureRelayLoops();
      this.send('voice_state', { muted: false, inCall: true });
      this.onStateChange?.();
      toast('🎙️ Mikrofon açıldı — sesin odaya iletiliyor');
      return true;
    } catch (e) {
      this.micPending = false;
      this.onStateChange?.();
      toast('⚠️ Mikrofon açılamadı — izinleri kontrol edin.');
      return false;
    }
  }

  async joinCall({ withMic = true, withCam = false } = {}) {
    prepareAudioSessionForMic();
    this.inCall = true;
    this.onStateChange?.();
    if (withMic && !this.micOn) {
      await this.toggleMic();
    }
    this._ensureRelayPlayCtx();
    this._playCallChime(true);
    for (const p of this._orderedPeerTargets()) {
      const st = this.peer(p.id);
      if (st && st.pc.signalingState === 'stable' && st.pc.connectionState === 'new') {
        this._negotiate(p.id, st);
      }
    }
    for (const [id, st] of this.peers.entries()) {
      if (st?.audio) {
        const volPct = this.getPeerVolume(id);
        const effVol = this.deafened ? 0 : volPct;
        st.audio.muted = Boolean(this.deafened) || volPct === 0;
        if (st.audio.srcObject) {
          applyStreamBoost(st.audio, st.audio.srcObject, effVol);
          st.audio.play?.().catch(() => {});
        }
      }
    }
    if (withCam && !this.camOn) {
      await this.toggleCamera();
    }
    this._ensureRelayLoops();
    this.send('voice_state', { inCall: true, muted: !this.micOn, cam: this.camOn, screen: this.screenOn, deafened: this.deafened });
    this.onStateChange?.();
    toast(this.micOn ? '📞 Ses Kanalına katıldın — mikrofonun açık!' : '🎧 Ses Kanalına dinleyici olarak katıldın');
    return true;
  }

  async leaveCall() {
    this.micPending = false;
    if (this.micOn) await this.toggleMic();
    if (this.camOn) await this.toggleCamera();
    if (this.screenOn) await this.toggleScreenShare();
    clearInterval(this.speakTimer);
    clearInterval(this.relayPollTimer);
    this.relayPollTimer = null;
    this.relayNextPlayAtByPeer.clear();
    try { this._relayProc?.disconnect?.(); this._relaySrc?.disconnect?.(); this._relayMute?.disconnect?.(); } catch (_) {}
    this._relayProc = null;
    this._relaySrc = null;
    this._relayMute = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this._usingSynthStream = false;
    this.audioCtx?.close?.().catch(() => {});
    this.audioCtx = null;
    this.relayPlayCtx?.close?.().catch(() => {});
    this.relayPlayCtx = null;
    this.synthAudioCtx?.close?.().catch(() => {});
    this.synthAudioCtx = null;
    this.inCall = false;
    this.deafened = false;
    this.selfSpeaking = false;
    this._removeVideoBubble('self');
    this._removeVideoBubble('self-screen');
    if (typeof window !== 'undefined') {
      window.__kinoxVoiceDuckFactor = 1.0;
      window.__kinoxSyncDuckVolume?.();
    }
    this.onDuckChange?.(false);
    for (const st of this.peers.values()) {
      try { st.audioSender?.replaceTrack?.(null); } catch (_) {}
      if (st?.audio) {
        applyStreamBoost(st.audio, st.audio.srcObject, 0);
        st.audio.muted = true;
      }
    }
    this._playCallChime(false);
    this.send('voice_state', { inCall: false, muted: true, speaking: false, cam: false, screen: false, deafened: false });
    this.onStateChange?.();
    toast('📴 Ses & Yayın Kanalından ayrıldın');
    return false;
  }

  _isPeerP2pConnected(peerId) {
    const st = this.peers.get(peerId);
    if (!st?.pc) return false;
    const cs = st.pc.connectionState;
    const ics = st.pc.iceConnectionState;
    const pcOk = cs === 'connected' || ics === 'connected' || ics === 'completed';
    if (!pcOk) return false;
    const p = (this.participants || []).find((x) => x.id === peerId);
    if (p && p.inCall && !p.muted && !st.audio?.srcObject) return false;
    return true;
  }

  _hasUnconnectedCallPeers() {
    const selfId = this.getSelfId();
    for (const p of (this.participants || [])) {
      if (!p || !p.id || p.id === selfId || p.transport === 'bot') continue;
      const active = Boolean(p.inCall || p.speaking);
      if (active && !this._isPeerP2pConnected(p.id)) return true;
    }
    return false;
  }

  _getClientToken(roomId) {
    if (!roomId) return '';
    if (typeof window !== 'undefined' && window.__vortexActiveConn?.roomId === roomId && window.__vortexActiveConn?.clientToken) {
      return String(window.__vortexActiveConn.clientToken);
    }
    try { return sessionStorage.getItem(`vortex_ct_${roomId}`) || sessionStorage.getItem(`vortex_ctok_${roomId}`) || ''; } catch (_) { return ''; }
  }

  _ensureRelayPlayCtx() {
    if (this.destroyed || !this.inCall) return null;
    if (this.relayPlayCtx && this.relayPlayCtx.state !== 'closed') {
      if (this.relayPlayCtx.state === 'suspended') this.relayPlayCtx.resume().catch(() => {});
      return this.relayPlayCtx;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        this.relayPlayCtx = new Ctx();
        if (this.relayPlayCtx.state === 'suspended') this.relayPlayCtx.resume().catch(() => {});
      }
    } catch (_) {}
    return this.relayPlayCtx;
  }

  _ensureRelayLoops() {
    if (this.destroyed || !this.inCall) {
      if (this.relayPollTimer) {
        clearInterval(this.relayPollTimer);
        this.relayPollTimer = null;
      }
      return;
    }
    if (this.relayPollTimer) return;
    this.relayPollTimer = setInterval(() => {
      if (this.destroyed || !this.inCall || this.deafened) return;
      if (!this._hasUnconnectedCallPeers()) return;
      const roomId = this.getRoomId?.();
      const selfId = this.getSelfId?.();
      if (!roomId || !selfId || this._relayFetching) return;
      this._relayFetching = true;
      const ctok = this._getClientToken(roomId);
      fetch(`/api/rave/voice-relay/${encodeURIComponent(roomId)}?clientId=${encodeURIComponent(selfId)}&sinceTs=${this.relaySinceTs || 0}${ctok ? `&clientToken=${encodeURIComponent(ctok)}` : ''}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then(async (res) => {
          if (!res?.ok || !Array.isArray(res.packets)) return;
          if (!this.relaySinceTs && res.serverTime) {
            this.relaySinceTs = Math.max(0, Number(res.serverTime) - 1.2);
          }
          for (const pkt of res.packets) {
            const pts = Number(pkt.ts || 0);
            if (pts > this.relaySinceTs) this.relaySinceTs = pts;
            if (!pkt.id || this.relaySeenIds.has(pkt.id)) continue;
            this.relaySeenIds.add(pkt.id);
            if (this.relaySeenIds.size > 80) {
              const first = this.relaySeenIds.values().next().value;
              this.relaySeenIds.delete(first);
            }
            if (!pkt.fromId || pkt.fromId === selfId || this._isPeerP2pConnected(pkt.fromId)) continue;
            await this._playRelayPacket(pkt);
          }
        })
        .catch(() => {})
        .finally(() => { this._relayFetching = false; });
    }, 680);
  }

  async _playRelayPacket(pkt) {
    if (this.deafened || !pkt?.b64) return;
    const volPct = this.getPeerVolume(pkt.fromId);
    if (volPct <= 0) return;
    const ctx = this._ensureRelayPlayCtx();
    if (!ctx) return;
    try {
      const bin = atob(pkt.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const audioBuf = await ctx.decodeAudioData(bytes.buffer.slice(0));
      if (this.destroyed || !this.inCall || this.deafened || ctx.state === 'closed') return;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = Math.min(2.0, Math.max(0, volPct / 100));
      src.buffer = audioBuf;
      src.connect(gain);
      gain.connect(ctx.destination);
      const peerKey = String(pkt.fromId || 'peer');
      const prevNext = this.relayNextPlayAtByPeer.get(peerKey) || 0;
      const clampedPrev = prevNext > ctx.currentTime + 1.5 ? ctx.currentTime + 0.06 : prevNext;
      const startAt = Math.max(ctx.currentTime + 0.04, clampedPrev);
      this.relayNextPlayAtByPeer.set(peerKey, startAt + audioBuf.duration);
      src.onended = () => { try { src.disconnect(); gain.disconnect(); } catch (_) {} };
      src.start(startAt);
    } catch (_) {}
  }

  watchSpeaking() {
    try {
      try { this._relayProc?.disconnect?.(); this._relaySrc?.disconnect?.(); this._relayMute?.disconnect?.(); } catch (_) {}
      this.audioCtx?.close?.().catch(() => {});
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);

      const srcRate = this.audioCtx.sampleRate || 48000;
      const relayProc = this.audioCtx.createScriptProcessor(4096, 1, 1);
      const relayMute = this.audioCtx.createGain();
      relayMute.gain.value = 0;
      this._relayProc = relayProc;
      this._relaySrc = src;
      this._relayMute = relayMute;
      let relayChunks = [];
      let relayFrames = 0;
      let relayMaxRms = 0;
      let relayTailCount = 0;
      const targetFrames = Math.round(srcRate * 0.72);
      relayProc.onaudioprocess = (ev) => {
        if (!this.micOn || !this.inCall || this.destroyed) {
          relayChunks = [];
          relayFrames = 0;
          return;
        }
        if (!this._hasUnconnectedCallPeers()) {
          relayChunks = [];
          relayFrames = 0;
          return;
        }
        const ch = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        let sq = 0;
        for (let i = 0; i < ch.length; i += 1) {
          copy[i] = ch[i];
          sq += ch[i] * ch[i];
        }
        const rms = Math.sqrt(sq / Math.max(1, ch.length));
        if (rms > relayMaxRms) relayMaxRms = rms;
        relayChunks.push(copy);
        relayFrames += copy.length;
        if (relayFrames >= targetFrames) {
          const hasSpeech = relayMaxRms > 0.008;
          if (hasSpeech) relayTailCount = 1;
          if (hasSpeech || relayTailCount > 0) {
            if (!hasSpeech) relayTailCount -= 1;
            const merged = new Float32Array(relayFrames);
            let off = 0;
            for (const c of relayChunks) { merged.set(c, off); off += c.length; }
            const down = downsampleFloat32(merged, srcRate, 8000);
            const wav = encodeWavBytes(down, 8000);
            const b64 = uint8ToBase64(wav);
            const roomId = this.getRoomId?.();
            const selfId = this.getSelfId?.();
            if (roomId && selfId && b64.length < 70000) {
              this.relaySeq += 1;
              const clientToken = this._getClientToken(roomId);
              fetch(`/api/rave/voice-relay/${encodeURIComponent(roomId)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId: selfId, clientToken, seq: this.relaySeq, mime: 'audio/wav', b64 }),
              }).catch(() => {});
            }
          }
          relayChunks = [];
          relayFrames = 0;
          relayMaxRms = 0;
        }
      };
      src.connect(relayProc);
      relayProc.connect(relayMute);
      relayMute.connect(this.audioCtx.destination);

      const buf = new Uint8Array(an.frequencyBinCount);
      let speaking = false;
      clearInterval(this.speakTimer);
      this.speakTimer = setInterval(() => {
        if (!this.micOn) {
          this.onMicLevel?.(0);
          if (speaking) { speaking = false; this.selfSpeaking = false; this._updateDuckState(); }
          return;
        }
        if (this.audioCtx?.state === 'suspended' && !(typeof document !== 'undefined' && document.hidden)) this.audioCtx.resume().catch(() => {});
        an.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / (buf.length || 1);
        const norm = Math.min(1, avg / 55);
        this.onMicLevel?.(norm);
        const now = avg > 14;
        const rmsSq = buf.reduce((acc, val) => acc + (val / 255) * (val / 255), 0) / (buf.length || 1);
        this._rmsVol = Math.max(Math.sqrt(rmsSq), (this._rmsVol || 0) * 0.78);
        const selfBubble = document.querySelector('#vortex-cam-dock [data-cam-id="self"]');
        if (selfBubble) {
          selfBubble.classList.toggle('is-speaking', now);
          selfBubble.style.setProperty('--voice-scale', now ? (1 + Math.min(0.14, this._rmsVol * 0.42)).toFixed(3) : '1');
        }
        if (now !== speaking) {
          speaking = now;
          this.selfSpeaking = now;
          this._updateDuckState();
          this.send('voice_state', { speaking });
        }
      }, 160);
    } catch (e) { /* analyser optional */ }
  }

  destroy() {
    this.destroyed = true;
    this.inCall = false;
    this.micOn = false;
    this.camOn = false;
    this.screenOn = false;
    this.selfSpeaking = false;
    this.onDuckChange?.(false);
    clearInterval(this.speakTimer);
    clearInterval(this.synthTimer);
    clearInterval(this.screenSynthTimer);
    clearInterval(this.relayPollTimer);
    this.relayPollTimer = null;
    window.removeEventListener('pointerdown', this._unlockBound);
    window.removeEventListener('keydown', this._unlockBound);
    if (this._onResizeBound) {
      window.removeEventListener('resize', this._onResizeBound);
      this._onResizeBound = null;
      this._resizeObserverBound = false;
    }
    for (const st of this.peers.values()) {
      try { st.pc.close(); } catch (e) { /* ignore */ }
      releaseStreamBoost(st.audio);
      st.audio.srcObject = null;
      st.audio.remove();
    }
    this.peers.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.camStream = null;
    this.screenStream = null;
    document.getElementById('vortex-cam-dock')?.remove();
    document.getElementById('vortex-audio-host')?.remove();
    try { this._relayProc?.disconnect?.(); this._relaySrc?.disconnect?.(); this._relayMute?.disconnect?.(); } catch (_) {}
    this._relayProc = null;
    this._relaySrc = null;
    this._relayMute = null;
    if (this._chimeCtxs?.size) {
      for (const cac of this._chimeCtxs) {
        try { if (cac.state !== 'closed') cac.close().catch(() => {}); } catch (_) {}
      }
      this._chimeCtxs.clear();
    }
    this.audioCtx?.close?.().catch(() => {});
    this.relayPlayCtx?.close?.().catch(() => {});
    this.synthAudioCtx?.close?.().catch(() => {});
    try { closeSharedAudioContext(); } catch (_) {}
    this._syncStoreVoice();
    if (typeof window !== 'undefined') { window.__kinoxVoiceDuckFactor = 1.0; window.__kinoxSyncDuckVolume?.(); }
  }
}
