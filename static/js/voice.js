// Voice, Camera & P2P DataChannel mesh with perfect negotiation; signaling relayed by mesh socket / HTTP sync.
import { toast } from './ui.js?v=20261030_v24';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];

export class Voice {
  constructor({ send, getSelfId, getSelfProfile, onDuckChange, onMicLevel, onP2pData }) {
    this.send = send;
    this.getSelfId = getSelfId;
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
    this.deafened = false;
    this.stageGridMode = false;
    this.stripMode = false;
    this.selfSpeaking = false;
    this.speakTimer = null;
    this.audioCtx = null;
    this.participants = [];
    this.peerVolumes = new Map();
    this.onStateChange = null;
    this._unlockBound = () => {
      for (const st of this.peers.values()) {
        if (st.audio && st.audio.srcObject && st.audio.paused) {
          st.audio.play().catch(() => {});
        }
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', this._unlockBound, { passive: true });
    window.addEventListener('keydown', this._unlockBound, { passive: true });
  }

  _playCallChime(join = true) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
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
      setTimeout(() => ac.close().catch(() => {}), 500);
    } catch (e) { /* ignore */ }
  }

  toggleDeafen() {
    this.deafened = !this.deafened;
    for (const [id, st] of this.peers.entries()) {
      if (st?.audio) {
        const volPct = this.getPeerVolume(id);
        st.audio.muted = this.deafened || volPct === 0;
      }
    }
    this.send('voice_state', { deafened: this.deafened });
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
    const anySpeaking = Boolean(this.selfSpeaking || peerSpeaking);
    if (typeof window !== 'undefined') {
      window.__kinoxVoiceDuckFactor = anySpeaking ? 0.32 : 1.0;
      window.__kinoxSyncDuckVolume?.();
    }
    this.onDuckChange?.(anySpeaking);
    const selfCam = document.querySelector('#vortex-cam-dock [data-cam-id="self"]');
    if (selfCam) selfCam.classList.toggle('is-speaking', Boolean(this.selfSpeaking));
    for (const p of this.participants || []) {
      const bubble = document.querySelector(`#vortex-cam-dock [data-cam-id="${p.id}"]`);
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
      st.audio.volume = Math.min(1, Math.max(0, val / 100));
      st.audio.muted = this.deafened || val === 0;
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
        window.addEventListener('resize', () => this._layoutCameraBubbles(), { passive: true });
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
        wrap.classList.toggle('controls-visible');
        clearTimeout(wrap._ctlTimer);
        if (wrap.classList.contains('controls-visible')) {
          wrap._ctlTimer = setTimeout(() => wrap.classList.remove('controls-visible'), 4000);
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
    let wrap = dock.querySelector(`[data-cam-id="${id}"]`);
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
      const swapBtn = document.createElement('button');
      swapBtn.type = 'button';
      swapBtn.className = 'cam-bubble-btn swap-btn';
      swapBtn.title = 'Kamera Yerini Değiştir (Sürükle veya Tıkla)';
      swapBtn.textContent = '⇄';
      swapBtn.onclick = (e) => {
        e.stopPropagation();
        this.swapCameraPositions(wrap);
      };
      const spotBtn = document.createElement('button');
      spotBtn.type = 'button';
      spotBtn.className = 'cam-bubble-btn spot-btn';
      spotBtn.title = 'Sahneye Büyüt (Spotlight)';
      spotBtn.textContent = '🖥️';
      spotBtn.onclick = (e) => {
        e.stopPropagation();
        const nextSpot = !wrap.classList.contains('spotlight');
        dock.querySelectorAll('.cam-bubble.spotlight').forEach((n) => n.classList.remove('spotlight'));
        wrap.classList.toggle('spotlight', nextSpot);
        dock.classList.toggle('has-spotlight', nextSpot);
        this._layoutCameraBubbles();
      };
      const sizeBtn = document.createElement('button');
      sizeBtn.type = 'button';
      sizeBtn.className = 'cam-bubble-btn size-btn';
      sizeBtn.title = 'Büyüt / Küçült';
      sizeBtn.textContent = '⤢';
      sizeBtn.onclick = (e) => {
        e.stopPropagation();
        if (wrap.classList.contains('spotlight')) {
          wrap.classList.remove('spotlight');
          dock.classList.remove('has-spotlight');
        } else {
          wrap.classList.toggle('expanded');
        }
        this._layoutCameraBubbles();
      };
      wrap.append(vid, tag, swapBtn, spotBtn, sizeBtn);
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
    const el = document.querySelector(`#vortex-cam-dock [data-cam-id="${id}"]`);
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
    if (st.makingOffer || pc.signalingState !== 'stable') return;
    try {
      st.makingOffer = true;
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

  peer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    this._ensureAudioHost().appendChild(audio);
    let dc = null;
    try {
      dc = pc.createDataChannel('vortex-p2p', { negotiated: true, id: 0 });
      dc.onmessage = (ev) => {
        try { this.onP2pData?.(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
      };
    } catch (e) { /* ignore */ }
    const st = { pc, dc, makingOffer: false, ignoreOffer: false, iceQueue: [], audio, audioSender: null, videoSender: null };
    this.peers.set(id, st);
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) {
        st.audioSender = pc.addTrack(t, this.stream);
      }
    }
    const activeVid = this.screenStream || this.camStream;
    if (activeVid) {
      for (const t of activeVid.getVideoTracks()) {
        st.videoSender = pc.addTrack(t, activeVid);
      }
    }
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        const vStream = new MediaStream([e.track]);
        const p = (this.participants || []).find((x) => x.id === id);
        this._attachVideoBubble(id, vStream, p?.name || 'Katılımcı', Boolean(p?.screen));
        e.track.onended = () => this._removeVideoBubble(id);
        e.track.onunmute = () => {
          const curP = (this.participants || []).find((x) => x.id === id);
          this._attachVideoBubble(id, vStream, curP?.name || 'Katılımcı', Boolean(curP?.screen));
        };
      } else if (e.track.kind === 'audio') {
        const aStream = new MediaStream([e.track]);
        audio.srcObject = aStream;
        const volPct = this.getPeerVolume(id);
        audio.muted = Boolean(this.deafened) || volPct === 0;
        audio.volume = Math.min(1.0, Math.max(0, volPct / 100));
        audio.play().catch(() => {});
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send('webrtc_ice', { targetId: id, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      }
    };
    pc.onnegotiationneeded = () => this._negotiate(id, st);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        try { pc.restartIce?.(); } catch (e) { /* ignore */ }
        this._negotiate(id, st);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        try { pc.restartIce?.(); } catch (e) { /* ignore */ }
        this._negotiate(id, st);
      }
    };
    return st;
  }

  async onSignal(data) {
    const from = data.fromId;
    if (!from || from === this.getSelfId()) return;
    if (!this.peers.has(from) && this.peers.size >= 12) return;
    if (data.type === 'webrtc_offer' && this.peers.has(from)) {
      // Karşı taraf sayfayı yenilediyse yeni ICE kimliği (ice-ufrag) gelir: eski bağlantıyı at, sıfırdan kur.
      const old = this.peers.get(from);
      const newU = /a=ice-ufrag:(\S+)/.exec(data.sdp?.sdp || '')?.[1];
      const oldU = /a=ice-ufrag:(\S+)/.exec(old.pc.remoteDescription?.sdp || '')?.[1];
      if (newU && oldU && newU !== oldU) {
        try { old.pc.close(); } catch (e) { /* ignore */ }
        try { old.audio.srcObject = null; old.audio.remove(); } catch (e) { /* ignore */ }
        this._removeVideoBubble(from);
        this.peers.delete(from);
      }
    }
    const st = this.peer(from);
    const { pc } = st;
    const polite = String(this.getSelfId()) < String(from);
    try {
      if (data.type === 'webrtc_offer' || data.type === 'webrtc_answer') {
        const desc = data.sdp;
        if (!desc || !desc.type) return;
        const collision = desc.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
        st.ignoreOffer = !polite && collision;
        if (st.ignoreOffer) return;
        if (collision) {
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e) { /* ignore */ }
        }
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
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
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          st.iceQueue = st.iceQueue || [];
          st.iceQueue.push(data.candidate);
        } else {
          try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { if (!st.ignoreOffer) console.warn('[voice] ice', e); }
        }
      }
    } catch (e) { console.warn('[voice] signal', e); }
  }

  onPeerJoined(id) {
    if (!id || id === this.getSelfId()) return;
    if (!this.micOn && !this.camOn && !this.screenOn) return;
    if (!this.peers.has(id) && this.peers.size >= 12) return;
    const st = this.peer(id);
    if (String(this.getSelfId()) < String(id)) this._negotiate(id, st);
  }

  syncPeers(participants) {
    const selfId = this.getSelfId();
    const list = participants || [];
    const ids = new Set(list.map((p) => p.id));
    for (const [id, st] of this.peers) {
      if (!ids.has(id)) {
        st.pc.close();
        st.audio.srcObject = null;
        st.audio.remove();
        this._removeVideoBubble(id);
        this.peers.delete(id);
      }
    }
    if (selfId) {
      const iAmActive = Boolean(this.micOn || this.camOn || this.screenOn);
      for (const p of list) {
        if (p.id && p.id !== selfId) {
          if (p.cam === false && p.screen === false) {
            this._removeVideoBubble(p.id);
          }
          const peerActive = Boolean(!p.muted || p.cam || p.screen || p.speaking);
          if (!iAmActive && !peerActive && !this.peers.has(p.id)) continue;
          if (!this.peers.has(p.id) && this.peers.size >= 12) continue;
          const had = this.peers.has(p.id);
          const st = this.peer(p.id);
          if (!had && (iAmActive || (peerActive && String(selfId) < String(p.id)))) {
            this._negotiate(p.id, st);
          }
        }
      }
    }
    this.participants = list;
    this._updateDuckState();
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
    for (const p of this.participants || []) if (p.id !== this.getSelfId()) this.peer(p.id);
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
      this.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }, audio: false });
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
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true });
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
      this.stream?.getTracks().forEach((t) => { t.enabled = false; });
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
      if (!this.stream) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          this.watchSpeaking();
        } catch (err) {
          this.stream = this._createSyntheticAudioStream();
        }
      }
      this.stream?.getTracks().forEach((t) => { t.enabled = true; });
      this.micOn = true;
      this.inCall = true;
      for (const p of this.participants || []) if (p.id !== this.getSelfId()) this.peer(p.id);
      const aTrack = this.stream?.getAudioTracks?.()[0];
      if (aTrack) {
        for (const [id, st] of this.peers.entries()) {
          try {
            if (st.audioSender) await st.audioSender.replaceTrack(aTrack);
            else st.audioSender = st.pc.addTrack(aTrack, this.stream);
            await this._negotiate(id, st);
          } catch (err) { /* ignore */ }
        }
      }
      this.send('voice_state', { muted: false, inCall: true });
      this.onStateChange?.();
      toast('🎙️ Mikrofon açıldı — sesin odaya iletiliyor');
      return true;
    } catch (e) {
      toast('⚠️ Mikrofon açılamadı.');
      return false;
    }
  }

  async joinCall({ withMic = true, withCam = false } = {}) {
    this.inCall = true;
    this._playCallChime(true);
    for (const p of this.participants || []) if (p.id !== this.getSelfId()) this.peer(p.id);
    if (withMic && !this.micOn) {
      await this.toggleMic();
    }
    if (withCam && !this.camOn) {
      await this.toggleCamera();
    }
    this.send('voice_state', { inCall: true, muted: !this.micOn, cam: this.camOn, screen: this.screenOn, deafened: this.deafened });
    this.onStateChange?.();
    toast('📞 Ses & Yayın Kanalına katıldın!');
    return true;
  }

  async leaveCall() {
    if (this.micOn) await this.toggleMic();
    if (this.camOn) await this.toggleCamera();
    if (this.screenOn) await this.toggleScreenShare();
    this.inCall = false;
    this.deafened = false;
    for (const st of this.peers.values()) {
      if (st?.audio) st.audio.muted = false;
    }
    this._playCallChime(false);
    this.send('voice_state', { inCall: false, muted: true, speaking: false, cam: false, screen: false, deafened: false });
    this.onStateChange?.();
    toast('📴 Ses & Yayın Kanalından ayrıldın');
    return false;
  }

  watchSpeaking() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      let speaking = false;
      clearInterval(this.speakTimer);
      this.speakTimer = setInterval(() => {
        if (!this.micOn) {
          this.onMicLevel?.(0);
          if (speaking) { speaking = false; this.selfSpeaking = false; this._updateDuckState(); }
          return;
        }
        if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {});
        an.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / (buf.length || 1);
        const norm = Math.min(1, avg / 55);
        this.onMicLevel?.(norm);
        const now = avg > 14;
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
    clearInterval(this.speakTimer);
    clearInterval(this.synthTimer);
    clearInterval(this.screenSynthTimer);
    window.removeEventListener('pointerdown', this._unlockBound);
    window.removeEventListener('keydown', this._unlockBound);
    for (const st of this.peers.values()) {
      try { st.pc.close(); } catch (e) { /* ignore */ }
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
    this.audioCtx?.close?.().catch(() => {});
  }
}
