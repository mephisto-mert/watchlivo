// Mesh controller: connection, server messages, playback actions, play-mode rules (Rave Mesh parity).
import { h, popup, toast, setBackground } from '../ui.js';
import { state, set, isLeader, isHostOnly, saveWatchProgress, saveMusicHistory, getMusicHistory } from '../store.js';
import { resolveMusicItem } from './selection-kinds.js?v=20261025_v10';
import { MeshConnection } from '../realtime.js?v=20261025_v10';
import { PlayerHost, mediaKey } from '../players/host.js?v=20261025_v10';
import { SyncEngine, clock, expectedPosition } from '../sync.js?v=20261025_v10';
import { buildLayout } from './mesh-layout.js?v=20261025_v10';
import { thumbFor, rememberRoom, getRememberedRoom } from './lobby.js';
import { Voice } from '../voice.js?v=20261025_v10';
import { playRoomSfx } from './chat.js?v=20261025_v10';

let ctx = null;

// Sohbet yenilemede korunur (sessionStorage), odadan çıkınca / sekme kapanınca temizlenir.
const chatKey = (id) => `vortex_chat_${id}`;
function loadSavedChat(id) {
  try {
    const arr = JSON.parse(sessionStorage.getItem(chatKey(id)) || '[]');
    return Array.isArray(arr) ? arr.filter((m) => m && m.id && m.ts && (Date.now() / 1000 - Number(m.ts)) < 3600) : [];
  } catch (e) { return []; }
}
function saveChat(room) {
  try {
    if (!room?.id || room.curated) return;
    const chat = (room.chat || []).filter((m) => m && m.id).slice(-80);
    if (chat.length) sessionStorage.setItem(chatKey(room.id), JSON.stringify(chat));
  } catch (e) { /* ignore */ }
}
function clearSavedChat(id) {
  try { if (id) sessionStorage.removeItem(chatKey(id)); } catch (e) { /* ignore */ }
}

const isTimeKeeper = () => isHostOnly()
  || Boolean(ctx?.lastLeaderActionAt && Date.now() - ctx.lastLeaderActionAt < 8500)
  || (isLeader() && String(state.mesh?.host_id || '').startsWith('bot_'));

const deviceLabel = () => (/iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) ? 'Mobil' : (window.vortexDesktop ? 'Masaüstü' : 'Web'));

function applyRoom(room, { reload = false, viaPoll = false } = {}) {
  if (!room) return;
  const curRoom = state.mesh;
  const prevKey = mediaKey(curRoom?.media);
  let nextKey = mediaKey(room.media);
  // Anti-dropout guard: If currently playing media exists, never drop to empty state from polling glich or race condition
  const curHasMedia = Boolean(curRoom?.media && (curRoom.media.url || curRoom.media.videoId || curRoom.media.tmdbId));
  const nextHasMedia = Boolean(room?.media && (room.media.url || room.media.videoId || room.media.tmdbId));
  if (curHasMedia && !nextHasMedia) {
    // Preserve current media instead of letting stage-empty take over
    room = {
      ...room,
      media: curRoom.media,
      participants: (Array.isArray(room.participants) && room.participants.length >= (curRoom.participants?.length || 0))
        ? room.participants
        : (curRoom.participants || room.participants || []),
      chat: (room.chat && room.chat.length) ? room.chat : (curRoom.chat || []),
    };
    nextKey = mediaKey(room.media);
    if (isLeader()) {
      const curPos = ctx?.host.adapter?.getTime?.() ?? expectedPosition(curRoom.media);
      setTimeout(() => ctx?.conn?.send('change_media', { ...curRoom.media, currentTime: curPos }), 120);
    }
  }
  if (nextKey && nextKey === prevKey && curRoom?.media?.url && !String(curRoom.media.url).startsWith('/api/rave/resolve-catalog') && String(room.media?.url || '').startsWith('/api/rave/resolve-catalog')) {
    room = {
      ...room,
      media: {
        ...room.media,
        provider: curRoom.media.provider || room.media.provider,
        streamType: curRoom.media.streamType || room.media.streamType,
        url: curRoom.media.url,
        altUrls: curRoom.media.altUrls || room.media.altUrls,
        audioTracks: (curRoom.media.audioTracks && curRoom.media.audioTracks.length) ? curRoom.media.audioTracks : room.media.audioTracks,
        subtitleTracks: (curRoom.media.subtitleTracks && curRoom.media.subtitleTracks.length) ? curRoom.media.subtitleTracks : room.media.subtitleTracks,
        intro: curRoom.media.intro || room.media.intro,
      },
    };
  }
  if (nextKey && nextKey === prevKey && curRoom?.media?.similar?.length && !(room.media?.similar?.length)) {
    room = { ...room, media: { ...room.media, similar: curRoom.media.similar } };
  }
  if (curRoom && isLeader() && nextKey && nextKey === prevKey) {
    const curMedia = curRoom.media || {};
    const nextMedia = room.media || {};
    if (ctx?.lastLeaderActionAt && Date.now() - ctx.lastLeaderActionAt < 8500) {
      const inSeekGrace = Boolean(ctx?.lastSeekAt && Date.now() - ctx.lastSeekAt < 8500 && Number.isFinite(ctx.lastSeekTarget));
      const pos = inSeekGrace ? expectedPosition(curMedia) : (ctx?.host.adapter?.getTime?.() ?? curMedia.meshStatePosition);
      room = {
        ...room,
        media: {
          ...nextMedia,
          intro: nextMedia.intro || curMedia.intro,
          playing: curMedia.playing,
          currentTime: pos,
          meshStateStatus: curMedia.meshStateStatus,
          meshStatePosition: pos,
          meshStateTime: clock.now(),
          meshStatePlaybackSpeed: curMedia.meshStatePlaybackSpeed || 1,
        },
      };
    } else if (!ctx?.userPaused && curMedia.meshStateStatus === 'PLAYING') {
      const livePos = ctx?.host.adapter?.getTime?.() ?? expectedPosition(curMedia);
      room = {
        ...room,
        media: {
          ...nextMedia,
          intro: nextMedia.intro || curMedia.intro,
          playing: true,
          currentTime: livePos,
          meshStateStatus: 'PLAYING',
          meshStatePosition: livePos,
          meshStateTime: clock.now(),
        },
      };
    }
    if (ctx?.lastPrivacy && ctx.lastPrivacyAt && Date.now() - ctx.lastPrivacyAt < 10000) {
      room = { ...room, privacy: ctx.lastPrivacy };
    }
  }
  if (!room.curated && !(room.chat || []).length) {
    const saved = loadSavedChat(room.id);
    if (saved.length) room = { ...room, chat: saved };
  }
  if (ctx) {
    if (!ctx.seenChatIds) {
      ctx.seenChatIds = new Set((room.chat || []).map((m) => m.id));
    } else {
      for (const m of (room.chat || [])) {
        if (m && m.id && !ctx.seenChatIds.has(m.id)) {
          ctx.seenChatIds.add(m.id);
          ctx.layout?.chatAppended?.(m);
          if (viaPoll && !m.system) ctx.layout?.danmaku?.(m);
        }
      }
    }
  }
  set({ mesh: room });
  saveChat(room);
  rememberRoom(room);
  const key = mediaKey(room.media);
  const prevUrl = String(curRoom?.media?.url || '');
  const nextUrl = String(room.media?.url || '');
  const urlResolved = Boolean(nextUrl && !nextUrl.startsWith('/api/rave/resolve-catalog') && (!prevUrl || prevUrl.startsWith('/api/rave/resolve-catalog') || !ctx?.host?.adapter));
  if (reload || key !== prevKey || urlResolved) loadMedia(room.media);
  else ctx?.sync.kick();
  setBackground(thumbFor(room.media));
  ctx?.layout.update();
  ctx?.voice?.syncPeers(room.participants || []);
}

async function loadMedia(media) {
  if (!ctx || !media) return;
  const sig = `${mediaKey(media)}|${media.url || ''}`;
  if (ctx.loadingSig === sig) return;
  ctx.loadingSig = sig;
  ctx.userPaused = false;
  const exp = expectedPosition(media);
  const start = (!isLeader() || (!ctx.isNew && exp > 0.5)) ? Math.max(0, exp) : 0;
  const playing = (media?.meshStateStatus || (media?.playing ? 'PLAYING' : 'PAUSED')) === 'PLAYING';
  if (String(media.url || '').startsWith('/api/rave/resolve-catalog')) {
    ctx.host.loading = true;
    ctx.layout?.playerEvent?.('loading');
    if (!isLeader()) {
      await new Promise((r) => setTimeout(r, 450 + Math.floor(Math.random() * 450)));
      if (!ctx) return;
      const latest = state.mesh?.media;
      if (latest?.url && !String(latest.url).startsWith('/api/rave/resolve-catalog') && mediaKey(latest) === mediaKey(media)) {
        media = latest;
      }
    }
    if (String(media.url || '').startsWith('/api/rave/resolve-catalog')) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const r = await fetch(media.url);
          if (r.ok) {
            const res = await r.json();
            if (res && res.url) {
              media = {
                ...media,
                provider: res.provider || 'hls',
                streamType: res.streamType || 'hls',
                url: res.url,
                altUrls: res.altUrls || [],
                audioTracks: (res.audioTracks && res.audioTracks.length) ? res.audioTracks : media.audioTracks,
                subtitleTracks: (res.subtitleTracks && res.subtitleTracks.length) ? res.subtitleTracks : (res.subtitles || media.subtitleTracks),
                intro: res.intro || media.intro,
                duration: res.duration || media.duration,
              };
              if (state.mesh) set({ mesh: { ...state.mesh, media } });
              ctx.conn?.send('resolve_media', { ...media, currentTime: start });
              break;
            }
          }
        } catch (e) { /* retry */ }
      }
    }
  }
  ctx.loadingSig = `${mediaKey(media)}|${media.url || ''}`;
  if (media?.isMusic || media?.mediaType === 'music') saveMusicHistory(media);
  else saveWatchProgress(media, 0, media?.duration || 0);
  await ctx.host.setMedia(media, start, playing);
  if (!isLeader()) {
    const liveExp = expectedPosition(state.mesh?.media || media);
    const curTime = ctx.host?.adapter?.getTime?.() || 0;
    if (liveExp > 0.5 && Math.abs(curTime - liveExp) > 0.5 && ctx.host?.adapter) {
      ctx.host.adapter.seek?.(liveExp);
    }
  }
  if (ctx.sync) {
    ctx.sync.seekUntil = 0;
    ctx.sync.deferStartedAt = 0;
    ctx.sync.kick();
  }
  ctx.layout.update();
}

function onMessage(data) {
  const room = state.mesh;
  switch (data.type) {
    case 'init': {
      set({ clientId: data.clientId });
      const needReload = !ctx?.host?.adapter || mediaKey(data.room?.media) !== mediaKey(room?.media);
      applyRoom(data.room, { reload: needReload });
      break;
    }
    case 'room_state': case 'media_changed': case 'user_joined': case 'user_left':
      if (data.room) applyRoom(data.room, { viaPoll: !!data.viaHttp });
      if (data.type === 'user_joined' && data.user?.id !== state.clientId) {
        ctx?.voice?.onPeerJoined(data.user.id);
        if (isHostOnly()) actions.heartbeat();
      }
      break;
    case 'sync':
      if (room && data.media) {
        set({ mesh: { ...room, media: data.media } });
        if (ctx?.sync) {
          ctx.sync.lastExpected = expectedPosition(data.media);
          ctx.sync.seekUntil = 0;
          ctx.sync.kick();
        }
        if (data.media.meshStateStatus === 'PAUSED' || data.media.playing === false) {
          ctx?.host?.adapter?.pause?.();
          const target = Number(data.media.meshStatePosition || 0);
          if (Math.abs((ctx?.host?.adapter?.getTime?.() || 0) - target) > 0.4) {
            ctx?.host?.adapter?.seek?.(target);
          }
        } else if (data.action === 'play') {
          ctx?.host?.adapter?.play?.();
        } else if (data.action === 'seek') {
          const target = Number(data.media.meshStatePosition || 0);
          ctx?.host?.adapter?.seek?.(target);
        }
        ctx.layout.update();
      }
      break;
    case 'chat':
      if (room && data.message) {
        if (data.message.id) ctx.seenChatIds?.add(data.message.id);
        set({ mesh: { ...room, chat: [...(room.chat || []), data.message].slice(-200) } });
        saveChat(state.mesh);
        ctx.layout.chatAppended(data.message);
        ctx.layout.danmaku?.(data.message);
      }
      break;
    case 'chat_cleared':
      if (room) {
        ctx.seenChatIds?.clear();
        set({ mesh: { ...room, chat: [], polls: [] } });
        ctx.layout.update();
      }
      break;
    case 'poll_updated':
      if (room) {
        const polls = Array.isArray(data.polls) ? data.polls : (room.polls || []);
        set({ mesh: { ...room, polls } });
        ctx.layout.pollsUpdated?.();
      }
      break;
    case 'msg_reacted':
      if (room && data.msgId) {
        const chatList = (room.chat || []).map((m) => (m.id === data.msgId ? { ...m, reactions: data.reactions || {} } : m));
        set({ mesh: { ...room, chat: chatList } });
        ctx.layout.reactionsUpdated?.();
      }
      break;
    case 'typing': ctx?.layout.showTyping(data.user); break;
    case 'reaction': ctx?.layout.floatEmoji(data.emoji); break;
    case 'soundfx': playRoomSfx(data.sfx); ctx?.layout.floatEmoji(data.sfx === 'clap' ? '👏' : data.sfx === 'laugh' ? '😂' : data.sfx === 'suspense' ? '🥁' : '🎉'); break;
    case 'queue_updated': case 'vote_updated': if (room) { set({ mesh: { ...room, queue: data.queue, voteEndsAt: data.voteEndsAt ?? room.voteEndsAt } }); ctx.layout.update(); } break;
    case 'skip_votes': if (room) { set({ mesh: { ...room, skip_votes: data.votes, skipNeeded: data.needed } }); ctx.layout.update(); } break;
    case 'participants_updated': if (room) { set({ mesh: { ...room, participants: data.participants } }); ctx.layout.update(); ctx.voice?.syncPeers(data.participants); } break;
    case 'password_required': askPassword(); break;
    case 'kicked': popup({ title: 'Odadan Atıldın', options: [{ label: 'Ana Sayfa', onClick: () => window.vortexNavigate('/') }], dismissable: false }); ctx?.conn.close(); break;
    case 'webrtc_offer': case 'webrtc_answer': case 'webrtc_ice': ctx?.voice?.onSignal(data); break;
    case 'error': toast(data.message || 'İşlem reddedildi'); break;
    default: break;
  }
}

function askPassword() {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Oda şifresi' });
  popup({ title: 'Bu oda şifreli', content: input, dismissable: false, options: [
    { label: 'Katıl', primary: true, onClick: () => { const id = state.route.params.id; leaveMeshView(); enterMesh(document.getElementById('app'), { id, pwd: input.value }); } },
    { label: 'Ana Sayfa', onClick: () => window.vortexNavigate('/') },
  ] });
}

// Optimistic local mesh-state update, then broadcast (Rave sends meshState* to the mesh server).
function localState(patch) {
  const m = state.mesh?.media;
  if (!m) return;
  const status = patch.meshStateStatus || m.meshStateStatus || (m.playing !== false ? 'PLAYING' : 'PAUSED');
  const pos = patch.meshStatePosition ?? m.meshStatePosition ?? m.currentTime ?? 0;
  const media = { ...m, ...patch, meshStateStatus: status, meshStatePosition: pos, meshStateTime: clock.now() };
  media.playing = media.meshStateStatus === 'PLAYING';
  media.currentTime = media.meshStatePosition;
  set({ mesh: { ...state.mesh, media } });
  ctx.sync.kick();
  ctx.layout.update();
}

const actions = {
  heartbeat(explicitTime) {
    if (!ctx || !isTimeKeeper()) return;
    const ad = ctx.host?.adapter;
    if (!ad || ctx.host.loading || ad.isBuffering?.() || ad.video?.seeking) return;
    if (ctx.lastSeekAt && Date.now() - ctx.lastSeekAt < 4500 && Math.abs((ad.video?.currentTime || 0) - (ctx.lastSeekTarget || 0)) > 3.0) return;
    const t = Number.isFinite(explicitTime) ? explicitTime : (ad.getTime?.() ?? 0);
    const expNow = expectedPosition(state.mesh?.media);
    if (t <= 1.5 || (expNow > 25 && t < 10 && (!ctx.lastSeekAt || Date.now() - ctx.lastSeekAt > 6000))) return;
    const playing = !ctx.userPaused && !ad.isPaused?.();
    if (ctx.sync) ctx.sync.lastLeaderBroadcast = performance.now();
    localState({ meshStateStatus: playing ? 'PLAYING' : 'PAUSED', meshStatePosition: t });
    ctx.conn.send('heartbeat', { currentTime: t, playing, atTime: clock.now() });
  },
  play() {
    if (!ctx) return;
    if (!isLeader()) {
      ctx.host.adapter?.play?.();
      ctx.sync?.kick();
      return;
    }
    ctx.userPaused = false;
    ctx.lastLeaderActionAt = Date.now();
    const t = ctx.host.adapter?.getTime() ?? expectedPosition(state.mesh?.media);
    ctx.host.adapter?.play?.();
    if (ctx.sync) ctx.sync.lastLeaderBroadcast = performance.now();
    localState({ meshStateStatus: 'PLAYING', meshStatePosition: t });
    ctx.conn.send('play', { currentTime: t, atTime: clock.now() });
  },
  pause() {
    if (!ctx) return;
    if (!isLeader()) {
      toast('Videoyu yalnızca oda lideri duraklatabilir');
      return;
    }
    ctx.userPaused = true;
    ctx.lastLeaderActionAt = Date.now();
    const t = ctx.host.adapter?.getTime() ?? expectedPosition(state.mesh?.media);
    ctx.host.adapter?.pause?.();
    if (ctx.sync) ctx.sync.lastLeaderBroadcast = performance.now();
    localState({ meshStateStatus: 'PAUSED', meshStatePosition: t });
    ctx.conn.send('pause', { currentTime: t, atTime: clock.now() });
  },
  toggle() {
    if (!isLeader()) {
      toast('Videoyu yalnızca oda başkanı duraklatabilir veya başlatabilir');
      return;
    }
    ((state.mesh?.media?.meshStateStatus || (state.mesh?.media?.playing !== false ? 'PLAYING' : 'PAUSED')) === 'PLAYING') ? actions.pause() : actions.play();
  },
  seek(t) {
    if (!ctx) return;
    if (!isLeader()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
    const d = Number(ctx.host.adapter?.getDuration?.() || state.mesh?.media?.duration || 0);
    const target = d > 0 ? Math.max(0, Math.min(d - 0.5, Number(t) || 0)) : Math.max(0, Number(t) || 0);
    ctx.lastLeaderActionAt = Date.now();
    ctx.lastSeekTarget = target;
    ctx.lastSeekAt = Date.now();
    if (ctx.sync) {
      ctx.sync.lastSeekTarget = target;
      ctx.sync.lastExpected = target;
      ctx.sync.seekUntil = performance.now() + 7500;
      ctx.sync.lastLeaderBroadcast = performance.now();
    }
    ctx.host.adapter?.seek?.(target);
    localState({ meshStatePosition: target });
    ctx.conn.send('seek', { currentTime: target, atTime: clock.now() });
  },
  setRate(r) {
    if (!ctx) return;
    if (!isLeader()) { toast('Oynatma hızını yalnızca oda lideri değiştirebilir'); return; }
    const t = ctx.host.adapter?.getTime() ?? 0;
    ctx.lastLeaderActionAt = Date.now();
    ctx.host.adapter?.setRate?.(r);
    localState({ meshStatePlaybackSpeed: r, meshStatePosition: t });
    ctx.conn.send('rate', { rate: r, currentTime: t, atTime: clock.now() });
  },
  skip() { ctx.conn.send('vote_skip'); },
  // Rave play-mode rules for a selection made inside the mesh.
  pickMedia(media) {
    const mode = state.mesh?.playMode || 'leader';
    if (mode === 'leader' && !isLeader()) { toast("Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider video seçebilir."); return; }
    if (mode === 'leader' || mode === 'cohost' || mode === 'quickplay' || !state.mesh?.media?.url) {
      if (ctx) {
        ctx.userPaused = false;
        ctx.lastLeaderActionAt = Date.now();
      }
      const nextMedia = { ...media, playing: true, currentTime: 0, meshStateStatus: 'PLAYING', meshStatePosition: 0, meshStateTime: clock.now() };
      if (state.mesh) {
        const updatedRoom = { ...state.mesh, media: nextMedia };
        set({ mesh: updatedRoom });
        rememberRoom(updatedRoom);
      }
      loadMedia(nextMedia);
      ctx.conn.send('change_media', { ...media, currentTime: 0 });
      set({ view: { ...state.view, left: 'Collapsed' } });
      ctx.layout.update();
      return;
    }
    ctx.conn.send('queue_add', { item: media });
    toast(`${media.title} ${mode === 'vote' ? 'oylamaya' : 'sıraya'} eklendi`);
  },
  queueMusic(media) {
    if (!ctx || !media) return;
    ctx.conn.send('queue_add', { item: media });
    toast(`🎵 Sıraya eklendi: ${media.songTitle || media.title}`);
  },
  voteVideo(index) { ctx.conn.send('vote_video', { index }); },
  playQueueIndex(index) { ctx.conn.send('queue_play_index', { index }); },
  removeQueueItem(index) { ctx.conn.send('queue_remove', { index }); },
  sendChat(text, extra = {}) { if (text.trim() || extra.gif) ctx.conn.send('chat', { text: text.trim().slice(0, 1000), ...extra }); },
  clearChat() {
    if (!ctx) return;
    clearSavedChat(state.mesh?.id);
    ctx.seenChatIds?.clear();
    if (state.mesh) set({ mesh: { ...state.mesh, chat: [], polls: [] } });
    ctx.conn.send('clear_chat');
  },
  createPoll(question, options) {
    if (!question || !Array.isArray(options) || options.length < 2) return;
    ctx.conn.send('poll_create', { question: String(question).trim().slice(0, 140), options: options.map((o) => String(o).trim().slice(0, 80)).filter(Boolean) });
  },
  votePoll(pollId, optionIndex) {
    if (!pollId || typeof optionIndex !== 'number') return;
    ctx.conn.send('poll_vote', { pollId, optionIndex });
  },
  reactMessage(msgId, emoji) {
    if (!msgId || !emoji) return;
    const room = state.mesh;
    const myName = state.self?.name || 'Misafir';
    if (room && Array.isArray(room.chat)) {
      const chatList = room.chat.map((m) => {
        if (m.id !== msgId) return m;
        const reacts = { ...(m.reactions || {}) };
        const users = Array.isArray(reacts[emoji]) ? [...reacts[emoji]] : [];
        const idx = users.indexOf(myName);
        if (idx >= 0) users.splice(idx, 1);
        else users.push(myName);
        if (users.length) reacts[emoji] = users;
        else delete reacts[emoji];
        return { ...m, reactions: reacts };
      });
      set({ mesh: { ...room, chat: chatList } });
      ctx?.layout.reactionsUpdated?.();
    }
    ctx.conn.send('msg_react', { msgId, emoji });
  },
  typing() { ctx.conn.send('typing', { user: state.self.name }); },
  reaction(emoji) { ctx.layout.floatEmoji(emoji); ctx.conn.send('reaction', { emoji }); },
  soundfx(sfx) { playRoomSfx(sfx); ctx.layout.floatEmoji(sfx === 'clap' ? '👏' : sfx === 'laugh' ? '😂' : sfx === 'suspense' ? '🥁' : '🎉'); ctx.conn.send('soundfx', { sfx }); },
  hostAction(action, extra = {}) {
    if (action === 'set_privacy' && state.mesh) {
      const patch = {};
      if (extra.privacy) {
        patch.privacy = extra.privacy;
        if (ctx) { ctx.lastPrivacy = extra.privacy; ctx.lastPrivacyAt = Date.now(); }
      }
      if (extra.playMode) patch.playMode = extra.playMode;
      if (extra.voipMode) patch.voipMode = extra.voipMode;
      if (typeof extra.name === 'string' && extra.name.trim()) patch.name = extra.name.trim();
      if (typeof extra.password === 'string') patch.hasPassword = Boolean(extra.password.trim());
      if (Object.keys(patch).length) {
        set({ mesh: { ...state.mesh, ...patch } });
        ctx?.layout.update();
      }
    }
    ctx.conn.send('host_action', { action, ...extra });
  },
  async ended() {
    const m = state.mesh?.media;
    if (!m) return;
    if (ctx) {
      ctx.userPaused = true;
      ctx.lastLeaderActionAt = Date.now();
    }
    localState({ meshStateStatus: 'PAUSED', meshStatePosition: Number(m.duration || ctx?.host?.adapter?.getDuration?.() || 0) });
    const q = state.mesh?.queue || [];
    if (q.length > 0) {
      if (isLeader() && state.mesh?.playMode !== 'vote') {
        actions.playQueueIndex(0);
        return;
      }
      ctx.conn.send('video_ended', { key: mediaKey(m) });
      return;
    }
    if (m.isMusic || m.mediaType === 'music') {
      let simPool = (Array.isArray(m.similar) && m.similar.length)
        ? m.similar
        : (Array.isArray(window.__kinoxCachedSimilar) && window.__kinoxCachedSimilar.length ? window.__kinoxCachedSimilar : []);
      if (!simPool.length) {
        try {
          const qs = new URLSearchParams({ artist: m.artist || 'Semicenk', title: m.songTitle || m.title || '' });
          const r = await fetch(`/api/rave/music-similar?${qs}`);
          if (r.ok) {
            const d = await r.json();
            if (Array.isArray(d.items) && d.items.length) simPool = d.items;
          }
        } catch (e) { /* ignore */ }
      }
      if (simPool.length) {
        const curNorm = `${(m.artist || '').toLowerCase()}|${(m.songTitle || m.title || '').toLowerCase()}`;
        const histKeys = new Set([
          curNorm,
          ...getMusicHistory().slice(0, 6).map((x) => `${(x.artist || '').toLowerCase()}|${(x.songTitle || x.title || '').toLowerCase()}`),
        ]);
        const nextCand = simPool.find((s) => !histKeys.has(`${(s.artist || '').toLowerCase()}|${(s.songTitle || s.title || '').toLowerCase()}`))
          || simPool.find((s) => `${(s.artist || '').toLowerCase()}|${(s.songTitle || s.title || '').toLowerCase()}` !== curNorm)
          || simPool[0];
        if (nextCand) {
          toast(`⏭️ Sıradaki Şarkı Başlıyor: ${nextCand.artist || ''} — ${nextCand.songTitle || nextCand.title}`);
          const resolved = await resolveMusicItem(nextCand);
          if (resolved) {
            actions.pickMedia(resolved);
            return;
          }
        }
      }
    }
    ctx.conn.send('video_ended', { key: mediaKey(m) });
  },
  async leave() { clearSavedChat(state.mesh?.id); window.vortexNavigate('/'); },
};

export async function enterMesh(app, params) {
  leaveMeshView();
  let initialCid = null;
  try { initialCid = sessionStorage.getItem('vortex_cid') || null; } catch (e) { /* ignore */ }
  set({ mesh: null, clientId: initialCid, view: { left: 'Collapsed', right: 'Collapsed' }, connection: 'connecting' });
  const host = new PlayerHost(h('div'), { onEvent: (ev, arg) => onPlayerEvent(ev, arg) });
  const sync = new SyncEngine({
    getMedia: () => state.mesh?.media,
    getAdapter: () => (host.loading ? null : host.adapter),
    isLeader: () => isTimeKeeper(),
    onLeaderSync: (t) => actions.heartbeat(t),
    onStatus: (s) => ctx?.layout.syncStatus(s),
  });
  ctx = { host, sync, actions, conn: null, layout: null, voice: null, isNew: params.new === '1' };
  ctx.layout = buildLayout(app, ctx);
  const cachedRoom = getRememberedRoom(params.id);
  if (cachedRoom && cachedRoom.id === params.id) {
    applyRoom(cachedRoom, { reload: true });
  } else {
    ctx.layout.playerEvent?.('loading');
  }
  sync.start();
  ctx.conn = new MeshConnection({
    roomId: params.id, profile: state.self, password: params.pwd || '', device: deviceLabel(),
    onMessage, onStatus: (s) => { set({ connection: s }); ctx?.layout.update(); },
  });
  ctx.voice = new Voice({
    send: (type, payload) => ctx.conn.send(type, payload),
    getSelfId: () => state.clientId,
    getSelfProfile: () => state.self,
    onDuckChange: (ducked) => host.setDucked(ducked),
    onMicLevel: (lvl) => ctx?.layout?.setMicLevel?.(lvl),
    onP2pData: (pkt) => ctx?.conn?.onP2pPacket?.(pkt),
  });
  ctx.conn.p2pBroadcast = (pkt) => ctx?.voice?.broadcastP2p?.(pkt);
  ctx.conn.start();
  window.vortexActions = actions;
  window.__kinoxVoice = ctx.voice;
  // Diagnostics hook used by automated two-browser sync tests (God's Eye).
  window.vortexDebug = () => {
    const m = state.mesh?.media;
    const ad = ctx?.host.adapter;
    return {
      roomId: state.mesh?.id, clientId: state.clientId, isLeader: isLeader(), connection: state.connection, transport: ctx?.conn.mode,
      key: mediaKey(m), status: m?.meshStateStatus, expected: expectedPosition(m), time: ad && !ctx.host.loading ? ad.getTime() : null,
      paused: ad ? ad.isPaused() : null, rate: ad ? ad.getRate() : null, syncMode: ctx?.sync.mode, participants: (state.mesh?.participants || []).length,
      chat: (state.mesh?.chat || []).map((c) => c.text), privacy: state.mesh?.privacy, playMode: state.mesh?.playMode, queue: (state.mesh?.queue || []).length,
      intro: ad?.subs?.intro || m?.intro || null,
      voicePeers: ctx?.voice ? Array.from(ctx.voice.peers.keys()) : [],
      camBubbles: document.querySelectorAll('.cam-bubble').length,
      audioEls: document.querySelectorAll('#vortex-audio-host audio').length,
    };
  };
}

function onPlayerEvent(ev, arg) {
  if (!ctx) return;
  if (ev === 'loaded' || (ev === 'buffering' && arg === false) || ev === 'ready') {
    if (!isLeader()) {
      const m = state.mesh?.media;
      if (m && (m.meshStateStatus === 'PLAYING' || m.playing)) {
        const liveExp = expectedPosition(m);
        const curTime = ctx.host?.adapter?.getTime?.() || 0;
        if (liveExp > 0.5 && Math.abs(curTime - liveExp) > 0.6 && ctx.host?.adapter) {
          ctx.host.adapter.seek?.(liveExp);
        }
        if (ctx.sync) {
          ctx.sync.seekUntil = 0;
          ctx.sync.deferStartedAt = 0;
          ctx.sync.kick();
        }
      }
    }
  }
  if ((ev === 'play' || ev === 'loaded') && isLeader() && !ctx.host.loading) {
    const m = state.mesh?.media;
    const k = mediaKey(m);
    const ad = ctx.host.adapter;
    if (m && k && ad && !ad.isPaused() && ctx.anchoredKey !== k) {
      ctx.anchoredKey = k;
      const basePos = Number(m.meshStatePosition ?? m.currentTime ?? 0);
      const t = ad.getTime?.() ?? 0;
      if (basePos < 5 && t < 5 && Math.abs(expectedPosition(m) - t) > 0.3) {
        actions.play();
      }
    }
  }
  if (ev === 'ended') {
    const curKey = mediaKey(state.mesh?.media);
    if (ctx.lastEndedKey !== curKey && (isLeader() || isHostOnly() || state.mesh?.playMode === 'cohost' || state.mesh?.playMode === 'quickplay')) {
      ctx.lastEndedKey = curKey;
      actions.ended();
    }
  }
  if (ev === 'autoplay-blocked') ctx.layout.showUnmute(true);
  if (ev === 'unmuted') ctx.layout.showUnmute(false);
  ctx.layout.playerEvent(ev, arg);
}

export function leaveMeshView() {
  if (!ctx) return;
  clearInterval(ctx.progressTimer);
  try { ctx.conn?.close(); } catch (e) { /* ignore */ }
  ctx.sync.stop();
  ctx.host.destroy();
  ctx.voice?.destroy();
  ctx.layout?.destroy?.();
  ctx = null;
  set({ mesh: null, clientId: null });
}
