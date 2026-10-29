// Realtime transport: WebSocket first (Rave mesh socket parity), HTTP polling fallback + P2P DataChannel/BroadcastChannel bridge.
import { clock } from './sync.js?v=20261029_v8';
import { api } from './api.js?v=20261029_v8';

const COUNTRY = ((navigator.language || '').split('-')[1] || '').toUpperCase().slice(0, 2);

export class MeshConnection {
  constructor({ roomId, profile, password = '', device = 'Web', onMessage, onStatus }) {
    Object.assign(this, { roomId, profile, password, device, onMessage, onStatus });
    this.ws = null; this.mode = null; this.closed = false; this.retry = 0;
    this.pollTimer = null; this.pingTimer = null; this.clientId = null; this.lastRoomStamp = '';
    this.status = '';
    this.syncToken = '';
    this.clientToken = '';
    try {
      localStorage.removeItem(`vortex_st_${roomId}`);
      this.syncToken = sessionStorage.getItem(`vortex_st_${roomId}`) || '';
      this.clientToken = sessionStorage.getItem(`vortex_ct_${roomId}`) || '';
      this.clientId = sessionStorage.getItem('vortex_cid') || null;
    } catch (e) { /* ignore */ }
    this.seenEventIds = new Set();
    this.seenSignalIds = new Set();
    this.seenP2pIds = new Set();
    this.outQueue = [];
    this.flushing = false;
    this.lastRev = 0;
    this.p2pBroadcast = null;
    this.bc = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(`vortex_mesh_${roomId}`);
        this.bc.onmessage = (ev) => this.onP2pPacket(ev.data);
      }
    } catch (e) { /* ignore */ }
  }

  emitStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  _emitP2p(pkt) {
    if (!pkt || this.closed) return;
    const msg = { ...pkt, _id: pkt._id || ('p_' + Math.random().toString(36).slice(2, 10)), fromCid: this.clientId, syncToken: this.syncToken, rev: this.lastRev };
    this.seenP2pIds.add(msg._id);
    try { this.bc?.postMessage(msg); } catch (e) { /* ignore */ }
    try { this.p2pBroadcast?.(msg); } catch (e) { /* ignore */ }
  }

  onP2pPacket(pkt) {
    if (!pkt || this.closed || pkt.fromCid === this.clientId) return;
    if (pkt._id && this.seenP2pIds.has(pkt._id)) return;
    if (pkt._id) this.seenP2pIds.add(pkt._id);
    if (pkt.syncToken && Number(pkt.rev || 0) >= this.lastRev) {
      this.syncToken = pkt.syncToken;
      this.lastRev = Number(pkt.rev || this.lastRev);
    }
    if (pkt.event) {
      const ev = pkt.event;
      if (ev.targetId && ev.targetId !== this.clientId) return;
      this.onMessage?.(ev);
    }
  }

  _rememberToken(token, cid) {
    if (token) {
      this.clientToken = token;
      try { sessionStorage.setItem(`vortex_ct_${this.roomId}`, token); } catch (e) { /* ignore */ }
    }
    if (cid) {
      this.clientId = cid;
      try { sessionStorage.setItem('vortex_cid', cid); } catch (e) { /* ignore */ }
    }
  }

  start() {
    const preferHttp = /(\.vercel\.app|watchlivo\.online)$/i.test(location.hostname) || localStorage.getItem('vortex_transport') === 'http';
    if (preferHttp) this.startHttp(); else this.startWs();
  }

  startWs() {
    this.mode = 'ws';
    this.emitStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ username: this.profile.name, color: this.profile.color, device: this.device, pwd: this.password, country: COUNTRY });
    if (this.profile.authToken) q.set('authToken', this.profile.authToken);
    if (this.clientId) q.set('clientId', this.clientId);
    if (this.clientToken) q.set('clientToken', this.clientToken);
    let opened = false;
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(this.roomId)}?${q}`);
    } catch (e) {
      this.startHttp();
      return;
    }
    this.ws = ws;
    ws.onopen = () => { opened = true; this.retry = 0; this.emitStatus('online'); this.ping(); this.pingTimer = setInterval(() => this.ping(), 2500); };
    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.type === 'pong' && data.t0Epoch) clock.sample(Number(data.t0Epoch), Number(data.serverTime));
      if (data.type === 'init') {
        this._rememberToken(data.clientToken, data.clientId);
        this._markRoomEventsSeen(data.room);
      }
      if (data.type === 'password_required') this.close();
      this.onMessage?.(data);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      if (!opened && this.retry >= 1) { this.startHttp(); return; }
      this.emitStatus('connecting');
      this.retry += 1;
      setTimeout(() => !this.closed && this.startWs(), Math.min(8000, 600 * this.retry));
    };
    ws.onerror = () => { /* onclose handles retry/fallback */ };
  }

  ping() { this.sendRaw({ type: 'ping', t0: performance.now(), t0Epoch: Date.now() / 1000 }); }

  startHttp() {
    this.mode = 'http';
    this.emitStatus('connecting');
    if (!this.clientId) {
      let savedCid = '';
      try { savedCid = sessionStorage.getItem('vortex_cid') || ''; } catch (e) { /* ignore */ }
      this.clientId = savedCid || ('h_' + Math.random().toString(36).slice(2, 10));
      try { sessionStorage.setItem('vortex_cid', this.clientId); } catch (e) { /* ignore */ }
    }
    this.inFlight = false;
    this.actionSeq = 0;
    this.participantCount = 1;
    this.httpSend({ type: 'init' }, true);
    clearTimeout(this.pollTimer);
    clearInterval(this.pollTimer);
    const scheduleNextPoll = () => {
      if (this.closed || this.mode !== 'http') return;
      const pCnt = this.participantCount || 1;
      const baseMs = pCnt > 400 ? 2700 : pCnt > 100 ? 2100 : pCnt > 25 ? 1550 : 1100;
      const jitterMs = pCnt > 25 ? Math.floor(Math.random() * 550) : Math.floor(Math.random() * 180);
      this.pollTimer = setTimeout(async () => {
        if (!this.inFlight && !this.outQueue.length) {
          await this.httpSend({ type: 'poll' });
        }
        scheduleNextPoll();
      }, baseMs + jitterMs);
    };
    scheduleNextPoll();
  }

  _markRoomEventsSeen(room) {
    if (!room) return;
    for (const ev of room.events || []) if (ev.id) this.seenEventIds.add(ev.id);
    for (const sg of room.signals || []) if (sg.id) this.seenSignalIds.add(sg.id);
  }

  _dispatchHttpEvents(room, isInit) {
    if (!room) return;
    for (const ev of room.events || []) {
      if (!ev.id || this.seenEventIds.has(ev.id)) continue;
      this.seenEventIds.add(ev.id);
      if (!isInit && (ev.cid !== this.clientId || (ev.type === 'chat' && ev.message?.system))) {
        this.onMessage?.(ev);
      }
    }
    for (const sg of room.signals || []) {
      if (!sg.id || this.seenSignalIds.has(sg.id)) continue;
      this.seenSignalIds.add(sg.id);
      if (sg.targetId === this.clientId && sg.fromId !== this.clientId) {
        this.onMessage?.(sg);
      }
    }
  }

  async _flushOutQueue() {
    if (this.flushing || this.closed || !this.outQueue.length) return;
    this.flushing = true;
    try {
      while (this.outQueue.length && !this.closed) {
        await new Promise((r) => setTimeout(r, 25));
        const items = this.outQueue.splice(0, 20);
        const payload = items.length === 1 ? items[0] : { type: 'batch', items };
        await this.httpSend(payload, false);
      }
    } finally {
      this.flushing = false;
    }
  }

  async httpSend(payload, isInit = false) {
    const isPoll = payload.type === 'poll';
    if (isPoll && (this.inFlight || this.flushing)) return;
    if (!isPoll) this.actionSeq = (this.actionSeq || 0) + 1;
    const reqSeq = this.actionSeq || 0;
    this.inFlight = true;
    const t0 = Date.now() / 1000;
    try {
      const reqBody = {
        ...payload,
        clientId: this.clientId,
        clientToken: this.clientToken,
        username: this.profile.name,
        color: this.profile.color,
        device: this.device,
        pwd: this.password,
        country: COUNTRY,
      };
      if (isPoll && this.lastRev > 0) {
        reqBody.sinceRev = this.lastRev;
      }
      if (this.syncToken) {
        reqBody.syncToken = this.syncToken;
      }
      const res = await api(`/api/rooms/${encodeURIComponent(this.roomId)}/sync`, {
        method: 'POST', timeout: 8000,
        body: reqBody,
      });
      if (res.clientToken || (res.clientId && res.clientId !== this.clientId)) {
        this._rememberToken(res.clientToken, res.clientId);
        if (!isPoll) {
          try { sessionStorage.setItem('vortex_cid', this.clientId); } catch (e) { /* ignore */ }
        }
      }
      if (res.serverTime) clock.sample(t0, Number(res.serverTime));
      this.emitStatus('online');
      if (isPoll && (reqSeq !== this.actionSeq || this.outQueue.length > 0)) {
        this._dispatchHttpEvents(res.unchanged ? res : res.room, false);
        return;
      }
      if (res.unchanged && this.lastRoom) {
        if (res.syncToken) {
          this.syncToken = res.syncToken;
          try { sessionStorage.setItem(`vortex_st_${this.roomId}`, this.syncToken); } catch (e) { /* ignore */ }
        }
        this._dispatchHttpEvents(res, false);
        const newCnt = Number(res.participantCount || this.participantCount || 1);
        this.participantCount = newCnt;
        if (res.media) {
          const prevMedia = this.lastRoom.media || {};
          const statusChanged = Boolean(res.media.meshStateStatus && res.media.meshStateStatus !== prevMedia.meshStateStatus);
          const posDiff = Math.abs(Number(res.media.meshStatePosition || 0) - Number(prevMedia.meshStatePosition || 0));
          const isPaused = res.media.meshStateStatus === 'PAUSED' || res.media.playing === false;
          const significantJump = isPaused ? (posDiff > 0.5) : (posDiff > 2.5);
          this.lastRoom.media = { ...this.lastRoom.media, ...res.media };
          if (statusChanged || significantJump) {
            this.onMessage?.({ type: 'sync', action: 'poll_sync', media: this.lastRoom.media });
          }
        }
        if (this.lastRoom.participantCount !== newCnt) {
          this.lastRoom.participantCount = newCnt;
          this.lastRoom.count = newCnt;
          this.onMessage?.({ type: 'room_state', room: this.lastRoom, viaHttp: true });
        }
        return;
      }
      if (res.room) {
        this.lastRoom = res.room;
        this.participantCount = Number(res.room.participantCount || res.room.count || (res.room.participants || []).length || 1);
        this._dispatchHttpEvents(res.room, isInit);
        if (isPoll && reqSeq !== this.actionSeq) return;
        this.lastRev = Math.max(this.lastRev, Number(res.room.rev || 0));
        if (res.room.syncToken && res.room.syncToken !== this.syncToken) {
          this.syncToken = res.room.syncToken;
          try { sessionStorage.setItem(`vortex_st_${this.roomId}`, this.syncToken); } catch (e) { /* ignore */ }
          if (!isPoll) this._emitP2p({ event: { type: 'room_state', room: res.room } });
        }
        const stamp = `${res.room.rev}|${res.room.participantCount || (res.room.participants || []).length}|${res.room.media?.meshStateTime}|${res.room.media?.meshStateStatus}|${res.room.media?.url}|${res.room.chat?.length}|${res.room.host_id}`;
        if (isInit) this.onMessage?.({ type: 'init', clientId: this.clientId, room: res.room });
        else if (stamp !== this.lastRoomStamp) this.onMessage?.({ type: 'room_state', room: res.room, viaHttp: isPoll });
        this.lastRoomStamp = stamp;
      }
    } catch (e) {
      this.emitStatus(e.status === 403 ? 'denied' : 'connecting');
      if (e.status === 403) { this.close(); this.onMessage?.({ type: 'password_required', roomId: this.roomId }); }
    } finally {
      this.inFlight = false;
    }
  }

  sendRaw(obj) {
    if (!obj || obj.type === 'ping') {
      if (this.mode === 'ws' && this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
      return;
    }
    if (['reaction', 'soundfx', 'typing'].includes(obj.type)) {
      this._emitP2p({ event: { ...obj, user: this.profile.name, cid: this.clientId } });
    } else if (['webrtc_offer', 'webrtc_answer', 'webrtc_ice'].includes(obj.type)) {
      this._emitP2p({ event: { ...obj, fromId: this.clientId } });
    } else if (['play', 'pause', 'seek', 'rate', 'heartbeat'].includes(obj.type)) {
      const isPaused = obj.type === 'pause' || (obj.type === 'heartbeat' && obj.playing === false);
      this._emitP2p({ event: { type: 'sync', action: obj.type, by: this.profile.name, media: { meshStateStatus: isPaused ? 'PAUSED' : 'PLAYING', meshStatePosition: Number(obj.currentTime || 0), meshStateTime: Number(obj.atTime || clock.now()), meshStatePlaybackSpeed: Number(obj.rate || 1), playing: !isPaused, currentTime: Number(obj.currentTime || 0) } } });
    }
    if (this.mode === 'ws') {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
    } else if (this.mode === 'http') {
      this.actionSeq = (this.actionSeq || 0) + 1;
      this.outQueue.push(obj);
      this._flushOutQueue();
    }
  }

  send(type, payload = {}) { this.sendRaw({ type, ...payload }); }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer); clearInterval(this.pollTimer); clearTimeout(this.pollTimer);
    try {
      localStorage.removeItem(`vortex_st_${this.roomId}`);
      localStorage.removeItem(`vortex_room_${this.roomId}`);
    } catch (e) { /* ignore */ }
    try { this.bc?.close(); } catch (e) { /* ignore */ }
    try { this.ws?.close(); } catch (e) { /* ignore */ }
    if (this.mode === 'http') api(`/api/rooms/${encodeURIComponent(this.roomId)}/sync`, { method: 'POST', body: { type: 'leave', clientId: this.clientId, syncToken: this.syncToken || undefined } }).catch(() => {});
  }
}
