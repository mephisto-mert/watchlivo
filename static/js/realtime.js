// Realtime transport: WebSocket first (Rave mesh socket parity), HTTP polling fallback + P2P DataChannel/BroadcastChannel bridge.
import { clock } from './sync.js?v=20261119_v222';
import { api } from './api.js?v=20261119_v222';
import { state } from './store.js?v=20261119_v222';
import { isRoomMediaPlaying, normalizeRoomMediaState } from './store.js?v=20261119_v222';

const COUNTRY = ((navigator.language || '').split('-')[1] || '').toUpperCase().slice(0, 2);

export class MeshConnection {
  constructor({ roomId, profile, password = '', device = 'Web', onMessage, onStatus }) {
    profile = profile || state.self || { id: 'guest_user', name: 'Misafir İzleyici', color: '#27DCC8', isGuest: true };
    Object.assign(this, { roomId, profile, password, device, onMessage, onStatus });
    this.ws = null; this.mode = null; this.closed = false; this.retry = 0;
    this.pollTimer = null; this.pingTimer = null; this.clientId = null; this.lastRoomStamp = '';
    this.status = '';
    this.syncToken = '';
    this.clientToken = '';
    this.isCreator = false;
    this.needsMediaPush = false;
    try {
      localStorage.removeItem(`vortex_st_${roomId}`);
      localStorage.removeItem(`vortex_ct_${roomId}`);
      localStorage.removeItem(`vortex_creator_${roomId}`);
      localStorage.removeItem(`vortex_creator_flag_${roomId}`);
      this.syncToken = sessionStorage.getItem(`vortex_st_${roomId}`) || '';
      this.clientToken = sessionStorage.getItem(`vortex_ct_${roomId}`) || '';
      const creatorCid = sessionStorage.getItem(`vortex_creator_${roomId}`) || '';
      const guestSeedCid = (profile?.isGuest && /^guest_[a-z0-9_-]{6,28}$/i.test(String(profile.id || ''))) ? String(profile.id) : null;
      this.clientId = creatorCid || sessionStorage.getItem('vortex_cid') || guestSeedCid || null;
      this.isCreator = Boolean(creatorCid && this.clientId === creatorCid);
    } catch (e) { /* ignore */ }
    this.seenEventIds = new Set();
    this.seenSignalIds = new Set();
    this.seenP2pIds = new Set();
    this._inFlightAborts = new Set();
    this.instanceId = 'inst_' + Math.random().toString(36).slice(2, 10);
    this.outQueue = [];
    this.flushing = false;
    this.lastRev = 0;
    this.p2pBroadcast = null;
    this.bc = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(`vortex_mesh_${roomId}`);
        this.bc.onmessage = (ev) => {
          const d = ev.data;
          if (!d) return;
          if (d._cidProbe && d.cid === this.clientId && d.inst !== this.instanceId) {
            try { this.bc.postMessage({ _cidConflict: true, cid: this.clientId, targetInst: d.inst }); } catch (e) { /* ignore */ }
            return;
          }
          if (d._cidConflict && d.targetInst === this.instanceId && d.cid === this.clientId) {
            const newCid = 'h_' + Math.random().toString(36).slice(2, 10);
            this.clientId = newCid;
            this.clientToken = '';
            this.isCreator = false;
            try {
              sessionStorage.setItem('vortex_cid', newCid);
              sessionStorage.removeItem(`vortex_ct_${roomId}`);
              sessionStorage.removeItem(`vortex_creator_${roomId}`);
            } catch (e) { /* ignore */ }
            if (!this.closed) {
              if (this.mode === 'http') {
                this.httpSend({ type: 'init' }, true);
              } else if (this.mode === 'ws') {
                this.startWs();
              }
            }
            return;
          }
          this.onP2pPacket(d);
        };
        if (this.clientId) {
          this.bc.postMessage({ _cidProbe: true, cid: this.clientId, inst: this.instanceId });
        }
      }
    } catch (e) { /* ignore */ }
  }

  _addBounded(set, val, max = 600) {
    if (!val) return;
    if (set.size >= max && !set.has(val)) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    set.add(val);
  }

  emitStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  _emitP2p(pkt) {
    if (!pkt || this.closed) return;
    const msg = { ...pkt, _id: pkt._id || ('p_' + Math.random().toString(36).slice(2, 10)), fromCid: this.clientId, syncToken: this.syncToken, rev: this.lastRev };
    this._addBounded(this.seenP2pIds, msg._id);
    try { this.bc?.postMessage(msg); } catch (e) { /* ignore */ }
    try { this.p2pBroadcast?.(msg); } catch (e) { /* ignore */ }
  }

  onP2pPacket(pkt) {
    if (!pkt || this.closed) return;
    if (pkt._cidProbe || pkt._cidConflict) return;
    if (!this.clientId || !pkt.fromCid || pkt.fromCid === this.clientId) return;
    if (pkt._id && this.seenP2pIds.has(pkt._id)) return;
    if (pkt._id) this._addBounded(this.seenP2pIds, pkt._id);
    if (pkt.event) {
      const ev = pkt.event;
      if (ev.targetId && ev.targetId !== this.clientId) return;
      if (ev.id) {
        if (['webrtc_offer', 'webrtc_answer', 'webrtc_ice'].includes(ev.type)) {
          if (this.seenSignalIds.has(ev.id)) return;
          this._addBounded(this.seenSignalIds, ev.id);
        } else {
          if (this.seenEventIds.has(ev.id)) return;
          this._addBounded(this.seenEventIds, ev.id);
        }
      }
      const safeEv = { ...ev, viaP2p: true };
      if (pkt.fromCid) safeEv.cid = pkt.fromCid;
      this.onMessage?.(safeEv);
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
    if (typeof window !== 'undefined') window.__vortexActiveConn = this;
    if (!this._visHandler) {
      this._visHandler = () => {
        if (this.closed || document.hidden) return;
        this.retry = 0;
        this.httpFailCount = 0;
        if (this.mode === 'http') {
          this.httpSend({ type: 'init' }, true);
        } else if (this.mode === 'ws' && (!this.ws || this.ws.readyState > 1)) {
          this.startWs();
        }
      };
      document.addEventListener('visibilitychange', this._visHandler);
      window.addEventListener('pageshow', this._visHandler);
      window.addEventListener('focus', this._visHandler);
    }
    if (!this._pageHideHandler && typeof window !== 'undefined') {
      this._pageHideHandler = () => {
        if (this.closed || !this.clientId || this.mode !== 'http') return;
        try {
          const leaveAuthTok = this.profile?.authToken || this.profile?.guestToken || state.self?.authToken || state.self?.guestToken || '';
          const leaveHeaders = { 'Content-Type': 'application/json', 'X-Watchlivo-Transport': 'http-poll' };
          if (leaveAuthTok) leaveHeaders.Authorization = `Bearer ${leaveAuthTok}`;
          fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/sync`, {
            method: 'POST',
            keepalive: true,
            headers: leaveHeaders,
            body: JSON.stringify({
              type: 'leave',
              clientId: this.clientId,
              username: this.profile?.name || '',
              clientToken: this.clientToken || undefined,
              gracefulClose: true,
            }),
          }).catch(() => {});
        } catch (e) { /* ignore */ }
      };
      window.addEventListener('pagehide', this._pageHideHandler);
    }
    const preferHttp = /(\.vercel\.app|watchlivo\.online)$/i.test(location.hostname) || localStorage.getItem('vortex_transport') === 'http';
    if (preferHttp) this.startHttp(); else this.startWs();
  }

  nudgeIfDisconnected() {
    if (this.closed) return;
    const now = Date.now();
    if (now - (this._lastBgNudgeAt || 0) < 3500) return;
    this._lastBgNudgeAt = now;
    if (this.mode === 'ws' && (!this.ws || this.ws.readyState > 1)) {
      this.startWs();
    } else if (this.mode === 'http' && !this.inFlight) {
      this.httpSend({ type: 'poll' }, false);
    }
  }

  startWs() {
    clearInterval(this.pingTimer);
    clearTimeout(this.wsRetryTimer);
    clearTimeout(this.pollTimer);
    clearInterval(this.pollTimer);
    if (this.ws && this.ws.readyState <= 1) {
      try { this.ws.onclose = null; this.ws.close(); } catch (_) {}
    }
    this.mode = 'ws';
    this.emitStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({
      username: this.profile.name,
      uid: this.profile.uid || this.profile.id || '',
      handle: this.profile.handle || '',
      avatarUrl: this.profile.avatarUrl || this.profile.avatar || '',
      bio: this.profile.bio || '',
      statusText: this.profile.statusText || '',
      statusEmoji: this.profile.statusEmoji || '🍿',
      medal: this.profile.medal || '',
      watchMinutes: String(this.profile.watchMinutes || 0),
      hideWatching: this.profile.hideWatching ? '1' : '0',
      hideFriends: this.profile.hideFriends ? '1' : '0',
      hideLocation: this.profile.hideLocation ? '1' : '0',
      color: this.profile.color,
      device: this.device,
      pwd: this.password,
      country: COUNTRY,
    });
    const wsAuthTok = this.profile.authToken || this.profile.guestToken || state.self?.authToken || state.self?.guestToken || '';
    if (wsAuthTok) q.set('authToken', wsAuthTok);
    if (this.clientId) q.set('clientId', this.clientId);
    if (this.clientToken) q.set('clientToken', this.clientToken);
    if (this.syncToken) q.set('syncToken', this.syncToken);
    if (this.isCreator) q.set('isCreator', '1');
    let opened = false;
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(this.roomId)}?${q}`);
    } catch (e) {
      this.startHttp();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      this.emitStatus('online');
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 2500);
      while (this.outQueue.length && this.ws?.readyState === 1) {
        try { this.ws.send(JSON.stringify(this.outQueue.shift())); } catch (e) { break; }
      }
    };
    ws.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.type === 'pong' && data.t0Epoch) clock.sample(Number(data.t0Epoch), Number(data.serverTime));
      if (data.type === 'init') {
        const initSrvNow = Number(data.serverTime || data.room?.serverNow || data.room?.media?.serverNow || 0);
        if (initSrvNow > 0) clock.seedServerNow(initSrvNow);
        this._rememberToken(data.clientToken, data.clientId);
        this._markRoomEventsSeen(data.room);
      }
      if (data.type === 'password_required') this.close();
      if (data.id) {
        const seenSet = ['webrtc_offer', 'webrtc_answer', 'webrtc_ice'].includes(data.type) ? this.seenSignalIds : this.seenEventIds;
        if (seenSet.has(data.id)) return;
        this._addBounded(seenSet, data.id);
      }
      this.onMessage?.(data);
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      clearTimeout(this.wsRetryTimer);
      if (this.closed) return;
      if (ev?.code === 4010 || ev?.reason === 'room_closed') {
        this.close(false);
        this.onMessage?.({ type: 'room_closed', roomId: this.roomId, roomClosed: true });
        return;
      }
      if (!opened) { this.startHttp(); return; }
      this.emitStatus('connecting');
      this.retry += 1;
      this.wsRetryTimer = setTimeout(() => !this.closed && this.startWs(), Math.min(8000, 600 * this.retry));
    };
    ws.onerror = () => { /* onclose handles retry/fallback */ };
  }

  ping() { this.sendRaw({ type: 'ping', t0: performance.now(), t0Epoch: Date.now() / 1000 }); }

  startHttp() {
    clearInterval(this.pingTimer);
    clearTimeout(this.wsRetryTimer);
    if (this.ws && this.ws.readyState <= 1) {
      try { this.ws.onclose = null; this.ws.close(); } catch (_) {}
    }
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
      const pCnt = Math.max(this.participantCount || 1, this.lastRoom?.largeRoomMode ? 25 : 1);
      const rawBaseMs = pCnt > 400 ? 2700 : pCnt > 100 ? 2100 : pCnt >= 25 ? 1450 : 950;
      const baseMs = (typeof document !== 'undefined' && document.hidden) ? Math.round(rawBaseMs * 1.6) : rawBaseMs;
      const backoffMs = Math.min(4000, (this.httpFailCount || 0) * 650);
      const jitterMs = pCnt >= 25 ? Math.floor(Math.random() * 550) : Math.floor(Math.random() * 140);
      this.pollTimer = setTimeout(async () => {
        if (this.closed) return;
        if (this.outQueue.length && !this.flushing) {
          await this._flushOutQueue();
        } else if (!this.inFlight && !this.outQueue.length) {
          await this.httpSend({ type: 'poll' });
        }
        scheduleNextPoll();
      }, baseMs + backoffMs + jitterMs);
    };
    scheduleNextPoll();
  }

  _markRoomEventsSeen(room) {
    if (!room) return;
    for (const ev of room.events || []) if (ev.id) this._addBounded(this.seenEventIds, ev.id);
    for (const sg of room.signals || []) if (sg.id) this._addBounded(this.seenSignalIds, sg.id);
  }

  _dispatchHttpEvents(room, isInit) {
    if (!room) return;
    for (const ev of room.events || []) {
      if (!ev.id || this.seenEventIds.has(ev.id)) continue;
      this._addBounded(this.seenEventIds, ev.id);
      if (!isInit && (ev.cid !== this.clientId || ev.type === 'chat' || ev.type === 'break_request' || ev.type === 'media_changed')) {
        this.onMessage?.(ev);
      }
    }
    for (const sg of room.signals || []) {
      if (!sg.id || this.seenSignalIds.has(sg.id)) continue;
      this._addBounded(this.seenSignalIds, sg.id);
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
        const items = this.outQueue.splice(0, 20);
        const payload = items.length === 1 ? items[0] : { type: 'batch', items };
        const ok = await this.httpSend(payload, false);
        if (!ok && !this.closed) {
          const retryTypes = ['chat', 'msg_react', 'poll_create', 'poll_vote', 'change_media', 'play', 'pause', 'seek', 'rate', 'resolve_media', 'host_action'];
          const retryable = items.filter((it) => it && retryTypes.includes(it.type) && (it._retries = (it._retries || 0) + 1) <= 3);
          if (retryable.length) {
            const hasNewerPlayPauseSeek = this.outQueue.some((q) => q && ['play', 'pause', 'seek', 'change_media'].includes(q.type));
            const dedupedRetry = [];
            let seenPlayPause = false;
            let seenSeek = false;
            for (let i = retryable.length - 1; i >= 0; i -= 1) {
              const it = retryable[i];
              if (['play', 'pause'].includes(it.type)) {
                if (hasNewerPlayPauseSeek || seenPlayPause) continue;
                seenPlayPause = true;
              } else if (it.type === 'seek') {
                if (hasNewerPlayPauseSeek || seenSeek) continue;
                seenSeek = true;
              }
              dedupedRetry.unshift(it);
            }
            if (dedupedRetry.length) {
              this.outQueue.unshift(...dedupedRetry);
              await new Promise((r) => setTimeout(r, 800));
            }
          }
        }
        if (this.outQueue.length) await new Promise((r) => setTimeout(r, 15));
      }
    } finally {
      this.flushing = false;
    }
  }

  async httpSend(payload, isInit = false) {
    const isPoll = payload.type === 'poll';
    if (isPoll && (this.inFlight || this.flushing)) return true;
    const reqSeq = this.actionSeq || 0;
    this.inFlight = true;
    const t0 = Date.now() / 1000;
    try {
      const curMedia = this.lastRoom?.media;
      const curMediaUrl = String(curMedia?.url || curMedia?.videoId || '');
      const chatArr = Array.isArray(this.lastRoom?.chat) ? this.lastRoom.chat : [];
      const lastChatId = chatArr.length ? String(chatArr[chatArr.length - 1]?.id || '') : '';
      const partArr = Array.isArray(this.lastRoom?.participants) ? this.lastRoom.participants : [];
      const reqBody = {
        ...payload,
        clientId: this.clientId,
        clientToken: this.clientToken,
        uid: this.profile.uid || this.profile.id || '',
        username: this.profile.name,
        handle: this.profile.handle || '',
        avatarUrl: this.profile.avatarUrl || this.profile.avatar || '',
        bio: this.profile.bio || '',
        statusText: this.profile.statusText || '',
        statusEmoji: this.profile.statusEmoji || '🍿',
        hideWatching: Boolean(this.profile.hideWatching),
        hideFriends: Boolean(this.profile.hideFriends),
        hideLocation: Boolean(this.profile.hideLocation),
        medal: this.profile.medal || '',
        watchMinutes: this.profile.watchMinutes || 0,
        color: this.profile.color,
        device: this.device,
        pwd: this.password,
        country: COUNTRY,
        isCreator: Boolean(this.isCreator),
        mediaUrl: curMediaUrl,
        chatCount: chatArr.length,
        lastChatId,
        participantCount: partArr.length || this.participantCount || 0,
      };
      if ((isInit || payload.type === 'init') && !reqBody.recentChat) {
        try {
          const savedC = JSON.parse(localStorage.getItem(`vortex_chat_${this.roomId}`) || sessionStorage.getItem(`vortex_chat_${this.roomId}`) || '[]');
          const mergedInitChat = [...(Array.isArray(savedC) ? savedC : []), ...chatArr.filter((m) => m && !m.system)].slice(-35);
          if (mergedInitChat.length) reqBody.recentChat = mergedInitChat;
        } catch (e) { /* ignore */ }
      }
      const initialCreatorSeed = Boolean(isInit && this.isCreator && this.lastRev === 0);
      if ((initialCreatorSeed || this.needsMediaPush || (this.lastMediaPushAt && Date.now() - this.lastMediaPushAt < 10000)) && curMedia && (curMedia.url || curMedia.videoId)) {
        reqBody.activeMedia = curMedia;
        this.needsMediaPush = false;
      }
      if (isPoll && this.lastRev > 0) {
        reqBody.sinceRev = this.lastRev;
      }
      if (this.syncToken) {
        reqBody.syncToken = this.syncToken;
      }
      const reqAbort = new AbortController();
      this._inFlightAborts.add(reqAbort);
      let res;
      try {
        res = await api(`/api/rooms/${encodeURIComponent(this.roomId)}/sync`, {
          method: 'POST', timeout: 12000,
          headers: { 'X-Watchlivo-Transport': 'http-poll' },
          body: reqBody,
          signal: reqAbort.signal,
        });
      } finally {
        this._inFlightAborts.delete(reqAbort);
      }
      if (this.closed) return false;
      this.httpFailCount = 0;
      if (res?.roomClosed) {
        this.close(false);
        this.onMessage?.({ type: 'room_closed', roomId: this.roomId, roomClosed: true, error: res.error || '' });
        return false;
      }
      if (res.clientToken || (res.clientId && res.clientId !== this.clientId)) {
        this._rememberToken(res.clientToken, res.clientId);
        if (!isPoll) {
          try { sessionStorage.setItem('vortex_cid', this.clientId); } catch (e) { /* ignore */ }
        }
      }
      const srvClockNow = Number(res.serverTime || res.room?.serverNow || res.media?.serverNow || 0);
      if (srvClockNow > 0) clock.sample(t0, srvClockNow);
      this.emitStatus('online');
      if (Array.isArray(res.errors) && res.errors.length) {
        for (const err of res.errors) {
          if (err) this.onMessage?.({ type: 'error', message: String(err) });
        }
      }
      if (isPoll && (reqSeq !== this.actionSeq || this.outQueue.length > 0)) {
        this._dispatchHttpEvents(res.unchanged ? res : res.room, false);
        return true;
      }
      if (res.unchanged && this.lastRoom) {
        this.lastRoom = { ...this.lastRoom, media: { ...(this.lastRoom.media || {}) } };
        if (res.syncToken) {
          this.syncToken = res.syncToken;
          try { sessionStorage.setItem(`vortex_st_${this.roomId}`, this.syncToken); } catch (e) { /* ignore */ }
        }
        this._dispatchHttpEvents(res, false);
        const newCnt = Number(res.participantCount || (Array.isArray(res.participants) ? res.participants.length : 0) || this.participantCount || 1);
        this.participantCount = newCnt;
        let stateMutated = false;
        if (Array.isArray(res.participants)) {
          const prevPIds = (this.lastRoom.participants || []).map((p) => `${p.id}:${p.uid || ''}:${p.name || ''}:${p.handle || ''}:${p.color || ''}:${p.avatarUrl || ''}:${p.isHost}:${p.isCoHost}:${p.isCreator}:${p.muted}:${p.speaking}:${p.cam}:${p.screen}`).join('|');
          const nextPIds = res.participants.map((p) => `${p.id}:${p.uid || ''}:${p.name || ''}:${p.handle || ''}:${p.color || ''}:${p.avatarUrl || ''}:${p.isHost}:${p.isCoHost}:${p.isCreator}:${p.muted}:${p.speaking}:${p.cam}:${p.screen}`).join('|');
          if (prevPIds !== nextPIds) {
            this.lastRoom.participants = res.participants;
            stateMutated = true;
          }
        }
        if (Array.isArray(res.chat) && res.chat.length) {
          const existingIds = new Set((this.lastRoom.chat || []).map((m) => m.id));
          for (const m of res.chat) {
            if (m && m.id && !existingIds.has(m.id)) {
              existingIds.add(m.id);
              this.lastRoom.chat = [...(this.lastRoom.chat || []), m].slice(-80);
              this.onMessage?.({ type: 'chat', message: m });
              stateMutated = true;
            }
          }
        }
        if (res.media && !(isPoll && (reqSeq !== this.actionSeq || (this.lastMediaPushAt && Date.now() - this.lastMediaPushAt < 5000)))) {
          const prevMedia = this.lastRoom.media || {};
          const prevUrl = String(prevMedia.url || prevMedia.videoId || '');
          const srvUrl = String(res.media.url || res.media.videoId || '');
          const srvUnresolved = srvUrl.startsWith('/api/rave/resolve-catalog');
          const prevResolved = prevUrl && !prevUrl.startsWith('/api/rave/resolve-catalog');
          if (prevUrl && (!srvUrl || (prevResolved && srvUnresolved))) {
            this.needsMediaPush = true;
            this.lastRev = 0;
            return true;
          }
          const sameIdentity = Boolean(
            (res.media.tmdbId && prevMedia.tmdbId && String(res.media.tmdbId) === String(prevMedia.tmdbId) && Number(res.media.season || 1) === Number(prevMedia.season || 1) && Number(res.media.episode || 1) === Number(prevMedia.episode || 1)) ||
            (res.media.title && prevMedia.title && String(res.media.title) === String(prevMedia.title))
          );
          if (srvUrl && srvUrl !== prevUrl && !sameIdentity) {
            this.lastRev = 0;
            this.syncToken = '';
            setTimeout(() => !this.closed && this.httpSend({ type: 'poll' }, false), 60);
            return true;
          }
          const urlChanged = Boolean(srvUrl && srvUrl !== prevUrl);
          const statusChanged = Boolean(res.media.meshStateStatus && res.media.meshStateStatus !== prevMedia.meshStateStatus);
          const nowSec = clock.now();
          const normNext = normalizeRoomMediaState(prevMedia, res.media);
          const prevPlaying = isRoomMediaPlaying(prevMedia);
          const nextPlaying = isRoomMediaPlaying(normNext);
          const rawPrevT0 = Number(prevMedia.meshStateTime ?? prevMedia.updatedAt ?? nowSec);
          const prevT0 = rawPrevT0 > 1e11 ? rawPrevT0 / 1000 : rawPrevT0;
          const rawNextT0 = Number(res.media.meshStateTime ?? res.media.updatedAt ?? nowSec);
          const nextT0 = rawNextT0 > 1e11 ? rawNextT0 / 1000 : rawNextT0;
          const prevExp = Number(prevMedia.meshStatePosition ?? prevMedia.currentTime ?? 0) + (prevPlaying ? Math.max(0, nowSec - prevT0) * Number(prevMedia.meshStatePlaybackSpeed ?? prevMedia.rate ?? 1) : 0);
          const nextExp = Number(res.media.meshStatePosition ?? res.media.currentTime ?? 0) + (nextPlaying ? Math.max(0, nowSec - nextT0) * Number(res.media.meshStatePlaybackSpeed ?? res.media.rate ?? 1) : 0);
          const posDiff = Math.abs(nextExp - prevExp);
          const isPaused = !nextPlaying;
          const significantJump = isPaused ? (posDiff > 0.35) : (posDiff > 0.85);
          const speedChanged = Boolean(res.media.meshStatePlaybackSpeed && Math.abs(Number(res.media.meshStatePlaybackSpeed) - Number(prevMedia.meshStatePlaybackSpeed || prevMedia.rate || 1)) > 0.01);
          this.lastRoom.media = normalizeRoomMediaState(this.lastRoom.media, res.media);
          if (statusChanged || significantJump || speedChanged || urlChanged) {
            this.onMessage?.({ type: 'sync', action: 'poll_sync', media: this.lastRoom.media });
          } else if (state.mesh?.media) {
            const isSelfHost = Boolean((res.host_id || this.lastRoom.host_id) && this.clientId && (res.host_id || this.lastRoom.host_id) === this.clientId);
            if (!isSelfHost || Number(res.media.meshStateTime || 0) >= Number(state.mesh.media.meshStateTime || 0) - 0.2) {
              Object.assign(state.mesh.media, this.lastRoom.media);
            }
          }
        }
        if (Array.isArray(res.polls)) {
          const prevPollsJson = JSON.stringify(this.lastRoom.polls || []);
          const nextPollsJson = JSON.stringify(res.polls);
          if (prevPollsJson !== nextPollsJson) {
            this.lastRoom.polls = res.polls;
            stateMutated = true;
          }
        }
        if (stateMutated || this.lastRoom.participantCount !== newCnt || (res.host_id && res.host_id !== this.lastRoom.host_id) || (res.privacy && res.privacy !== this.lastRoom.privacy) || (res.playMode && res.playMode !== this.lastRoom.playMode)) {
          this.lastRoom.participantCount = newCnt;
          this.lastRoom.count = newCnt;
          if (res.privacy) this.lastRoom.privacy = res.privacy;
          if (res.playMode) this.lastRoom.playMode = res.playMode;
          if (res.voipMode) this.lastRoom.voipMode = res.voipMode;
          if (res.name) this.lastRoom.name = res.name;
          if (res.host_id) this.lastRoom.host_id = res.host_id;
          this.onMessage?.({ type: 'room_state', room: this.lastRoom, viaHttp: true });
        }
        return true;
      }
      if (res.room) {
        if ((isInit || payload.type === 'init') && reqSeq !== this.actionSeq && this.lastRoom?.media && (this.lastRoom.media.url || this.lastRoom.media.videoId)) {
          res.room = { ...res.room, media: this.lastRoom.media };
        }
        this.lastRoom = res.room;
        this.participantCount = Number(res.room.participantCount || res.room.count || (res.room.participants || []).length || 1);
        this._dispatchHttpEvents(res.room, isInit);
        if (isPoll && reqSeq !== this.actionSeq) return true;
        this.lastRev = Math.max(this.lastRev, Number(res.room.rev || 0));
        if (res.room.syncToken && res.room.syncToken !== this.syncToken) {
          this.syncToken = res.room.syncToken;
          try { sessionStorage.setItem(`vortex_st_${this.roomId}`, this.syncToken); } catch (e) { /* ignore */ }
          if (!isPoll) this._emitP2p({ event: { type: 'room_state', room: res.room } });
        }
        const srvLastChatId = Array.isArray(res.room.chat) && res.room.chat.length ? String(res.room.chat[res.room.chat.length - 1]?.id || '') : '';
        const stamp = `${res.room.rev}|${res.room.privacy}|${res.room.playMode}|${res.room.voipMode}|${res.room.name}|${res.room.participantCount || (res.room.participants || []).length}|${res.room.media?.meshStateTime}|${res.room.media?.meshStateStatus}|${res.room.media?.url}|${res.room.chat?.length}|${srvLastChatId}|${res.room.host_id}`;
        if (isInit) this.onMessage?.({ type: 'init', clientId: this.clientId, room: res.room });
        else if (stamp !== this.lastRoomStamp) this.onMessage?.({ type: 'room_state', room: res.room, viaHttp: isPoll });
        this.lastRoomStamp = stamp;
      }
      return true;
    } catch (e) {
      if (this.closed) return false;
      if (e.data?.error === 'kicked' || (e.status === 403 && e.data?.error === 'kicked')) {
        this.close(false);
        this.onMessage?.({ type: 'kicked', roomId: this.roomId });
      } else if (e.status === 410 || e.status === 404) {
        this.close(false);
        this.onMessage?.({
          type: 'room_closed',
          roomId: this.roomId,
          status: e.status,
          roomClosed: Boolean(e.data?.roomClosed || e.status === 410),
          error: e.data?.error || '',
        });
      } else if (e.status === 403) {
        if (!e.data?.error || e.data?.error === 'password_required') {
          this.emitStatus('denied');
          this.close(false);
          this.onMessage?.({ type: 'password_required', roomId: this.roomId });
        }
      } else {
        this.httpFailCount = (this.httpFailCount || 0) + 1;
        if (e.status !== 429 && (!this.lastRoom || this.httpFailCount >= 5)) {
          this.emitStatus('connecting');
        }
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  sendRaw(obj) {
    if (!obj || obj.type === 'ping') {
      if (this.mode === 'ws' && this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
      return;
    }
    if (['reaction', 'soundfx', 'typing', 'break_request'].includes(obj.type)) {
      const actId = obj.actionId || ('ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
      obj.actionId = actId;
      this._addBounded(this.seenEventIds, actId);
      this._emitP2p({ event: { ...obj, id: actId, user: this.profile.name, cid: this.clientId } });
    } else if (['webrtc_offer', 'webrtc_answer', 'webrtc_ice'].includes(obj.type)) {
      const sigId = obj.signalId || ('sg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
      obj.signalId = sigId;
      this._addBounded(this.seenSignalIds, sigId);
      this._emitP2p({ event: { ...obj, id: sigId, fromId: this.clientId } });
    } else if (['change_media', 'resolve_media'].includes(obj.type)) {
      this.needsMediaPush = true;
      this.lastMediaPushAt = Date.now();
      const actId = obj.actionId || ('ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
      obj.actionId = actId;
      this._addBounded(this.seenEventIds, actId);
      const m = { ...(this.lastRoom?.media || {}), ...obj, meshStateStatus: 'PLAYING', playing: true, meshStatePosition: Number(obj.currentTime || 0), meshStateTime: clock.now() };
      delete m.type;
      this._emitP2p({ event: { id: actId, type: 'sync', action: obj.type, cid: this.clientId, by: this.profile.name, media: m } });
    } else if (['play', 'pause', 'seek', 'rate', 'heartbeat'].includes(obj.type)) {
      const actId = obj.actionId || ('ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
      obj.actionId = actId;
      this._addBounded(this.seenEventIds, actId);
      const baseMedia = this.lastRoom?.media || state.mesh?.media || {};
      const isPaused = obj.type === 'pause'
        || (obj.type === 'heartbeat' && obj.playing === false)
        || ((obj.type === 'seek' || obj.type === 'rate') && Boolean(baseMedia && !isRoomMediaPlaying(baseMedia)));
      this._emitP2p({ event: { id: actId, type: 'sync', action: obj.type, cid: this.clientId, by: this.profile.name, media: { ...baseMedia, meshStateStatus: isPaused ? 'PAUSED' : 'PLAYING', meshStatePosition: Number(obj.currentTime || 0), meshStateTime: Number(obj.atTime || clock.now()), meshStatePlaybackSpeed: Number(obj.rate || baseMedia.meshStatePlaybackSpeed || 1), playing: !isPaused, currentTime: Number(obj.currentTime || 0) } } });
    } else if (obj.type === 'chat' && (obj.text || obj.gif || obj.snapshot || obj.audioNote)) {
      let hhmm = '';
      try {
        hhmm = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
      } catch (e) {
        const d = new Date();
        hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      const p2pMsg = {
        id: obj.clientMsgId || `p2p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        user: this.profile.name,
        color: this.profile.color,
        text: String(obj.text || '').slice(0, 600),
        gif: obj.gif || '',
        snapshot: obj.snapshot || '',
        videoTime: obj.videoTime ?? null,
        audioNote: obj.audioNote || null,
        replyTo: obj.replyTo || null,
        time: hhmm,
        ts: Date.now() / 1000,
      };
      this._emitP2p({ event: { type: 'chat', cid: this.clientId, message: p2pMsg } });
    }
    if (!this.mode) {
      this.outQueue.push(obj);
      return;
    }
    if (this.mode === 'ws') {
      if (this.ws?.readyState === 1) {
        this.ws.send(JSON.stringify(obj));
      } else {
        this.outQueue.push(obj);
      }
    } else if (this.mode === 'http') {
      this.actionSeq = (this.actionSeq || 0) + 1;
      this.outQueue.push(obj);
      this._flushOutQueue();
    }
  }

  send(type, payload = {}) { this.sendRaw({ type, ...payload }); }

  close(explicitLeave = false, closeRoomForAll = false) {
    if (this.closed) return;
    if (this._inFlightAborts?.size) {
      for (const ctl of this._inFlightAborts) {
        try { ctl.abort(); } catch (_) {}
      }
      this._inFlightAborts.clear();
    }
    if (explicitLeave) {
      const shouldCloseRoom = Boolean(closeRoomForAll);
      if (shouldCloseRoom) {
        try { this._emitP2p({ event: { type: 'room_closed', roomId: this.roomId } }); } catch (e) { /* ignore */ }
      }
      try {
        if (shouldCloseRoom) {
          localStorage.removeItem(`vortex_st_${this.roomId}`);
          localStorage.removeItem(`vortex_room_${this.roomId}`);
          localStorage.removeItem(`vortex_creator_flag_${this.roomId}`);
          sessionStorage.removeItem(`vortex_st_${this.roomId}`);
          sessionStorage.removeItem(`vortex_room_${this.roomId}`);
          sessionStorage.removeItem(`vortex_creator_${this.roomId}`);
        }
      } catch (e) { /* ignore */ }
      try {
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({ type: shouldCloseRoom ? 'close_room' : 'leave', clientId: this.clientId, gracefulClose: true }));
        }
      } catch (e) { /* ignore */ }
      try {
        const leaveAuthTok = this.profile?.authToken || this.profile?.guestToken || state.self?.authToken || state.self?.guestToken || '';
        const leaveHeaders = { 'Content-Type': 'application/json', 'X-Watchlivo-Transport': 'http-poll' };
        if (leaveAuthTok) leaveHeaders.Authorization = `Bearer ${leaveAuthTok}`;
        fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/sync`, {
          method: 'POST',
          keepalive: true,
          headers: leaveHeaders,
          body: JSON.stringify({
            type: shouldCloseRoom ? 'close_room' : 'leave',
            clientId: this.clientId,
            username: this.profile?.name || '',
            clientToken: this.clientToken || undefined,
            gracefulClose: true,
          }),
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    }
    this.closed = true;
    this.outQueue = [];
    if (typeof window !== 'undefined' && window.__vortexActiveConn === this) {
      window.__vortexActiveConn = null;
    }
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      window.removeEventListener('pageshow', this._visHandler);
      window.removeEventListener('focus', this._visHandler);
      this._visHandler = null;
    }
    if (this._pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._pageHideHandler);
      this._pageHideHandler = null;
    }
    clearInterval(this.pingTimer); clearInterval(this.pollTimer); clearTimeout(this.pollTimer); clearTimeout(this.wsRetryTimer);
    try { this.bc?.close(); } catch (e) { /* ignore */ }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
  }
}
