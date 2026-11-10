// Mesh controller: connection, server messages, playback actions, play-mode rules (Rave Mesh parity).
import { h, popup, toast, setBackground } from '../ui.js?v=20261110_v186';
import { state, set, isLeader, isHostOnly, isCreatorSelf, isActiveTimeKeeper, isRoomMediaPlaying, normalizeRoomMediaState, saveWatchProgress, saveMusicHistory, getMusicHistory, pushPresenceHeartbeat } from '../store.js?v=20261110_v186';
import { resolveMusicItem } from './selection-kinds.js?v=20261110_v186';
import { MeshConnection } from '../realtime.js?v=20261110_v186';
import { PlayerHost, mediaKey } from '../players/host.js?v=20261110_v186';
import { SyncEngine, clock, expectedPosition } from '../sync.js?v=20261110_v186';
import { buildLayout } from './mesh-layout.js?v=20261110_v186';
import { thumbFor, rememberRoom, getRememberedRoom, forgetRoom } from './lobby.js?v=20261110_v186';
import { Voice } from '../voice.js?v=20261110_v186';
import { playRoomSfx, playEmojiSfx } from './chat.js?v=20261110_v186';
import { ensureHlsJs } from '../players/hls-loader.js?v=20261110_v186';
import { closeSharedAudioContext } from '../players/audio-gain.js?v=20261110_v186';

let ctx = null;

// Sohbet yenilemede ve uygulama geçişlerinde korunur (sessionStorage + localStorage).
const chatKey = (id) => `vortex_chat_${id}`;
export function loadSavedChat(id) {
  if (!id) return [];
  try {
    const nowSec = Date.now() / 1000;
    const rawS = JSON.parse(sessionStorage.getItem(chatKey(id)) || '[]');
    const rawL = JSON.parse(localStorage.getItem(chatKey(id)) || '[]');
    const byId = new Map();
    for (const m of [...(Array.isArray(rawL) ? rawL : []), ...(Array.isArray(rawS) ? rawS : [])]) {
      if (m && m.id && !m.system) {
        const ts = Number(m.ts || nowSec);
        if (nowSec - ts < 86400) {
          byId.set(m.id, { ...m, ts });
        }
      }
    }
    return Array.from(byId.values()).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)).slice(-80);
  } catch (e) { return []; }
}
const _saveChatTimers = new Map();
const _pendingChatRooms = new Map();

function flushSavedChat(room) {
  try {
    if (!room?.id || room.curated) return;
    const t = _saveChatTimers.get(room.id);
    if (t) { clearTimeout(t); _saveChatTimers.delete(room.id); }
    _pendingChatRooms.delete(room.id);
    if (ctx?.chatClearedAt && Date.now() - ctx.chatClearedAt < 10000) return;
    const nowSec = Date.now() / 1000;
    const existing = loadSavedChat(room.id);
    const incoming = (room.chat || []).filter((m) => m && m.id && !m.system);
    const byId = new Map();
    for (const m of [...existing, ...incoming]) {
      if (m && m.id && !m.system) {
        const ts = Number(m.ts || nowSec);
        if (nowSec - ts < 86400) {
          const { snapshot, ...lite } = m;
          byId.set(m.id, { ...lite, ts });
        }
      }
    }
    const merged = Array.from(byId.values()).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)).slice(-80);
    const serialized = JSON.stringify(merged);
    try { sessionStorage.setItem(chatKey(room.id), serialized); } catch (_) {}
    const localSafe = serialized.length > 160000
      ? JSON.stringify(merged.map(({ audioNote, ...rest }) => rest))
      : serialized;
    try { localStorage.setItem(chatKey(room.id), localSafe); } catch (_) {}
  } catch (e) { /* ignore */ }
}

function saveChat(room) {
  if (!room?.id || room.curated) return;
  _pendingChatRooms.set(room.id, room);
  if (_saveChatTimers.has(room.id)) return;
  _saveChatTimers.set(room.id, setTimeout(() => {
    _saveChatTimers.delete(room.id);
    const latest = _pendingChatRooms.get(room.id) || room;
    flushSavedChat(latest);
  }, 260));
}
function clearSavedChat(id) {
  try {
    if (id) {
      const t = _saveChatTimers.get(id);
      if (t) { clearTimeout(t); _saveChatTimers.delete(id); }
      _pendingChatRooms.delete(id);
      sessionStorage.removeItem(chatKey(id));
      localStorage.removeItem(chatKey(id));
    }
  } catch (e) { /* ignore */ }
}

const isTimeKeeper = () => isActiveTimeKeeper();

function reconcileSelfVoiceState(room) {
  if (!ctx?.voice || !room) return;
  const parts = Array.isArray(room.participants) ? room.participants : [];
  const meP = parts.find((x) => x && x.id === state.clientId);
  const voipMode = room.voipMode || 'all';
  if (ctx.voice.micOn) {
    const blockedByMode = voipMode === 'off'
      || (voipMode === 'leader' && !isLeader())
      || (voipMode === 'stage' && meP && !meP.isHost && !meP.isCoHost && !meP.isStageSpeaker);
    if ((meP && meP.muted === true) || blockedByMode) {
      ctx.voice.toggleMic();
    }
  }
  if (meP && meP.cam === false && ctx.voice.camOn) {
    ctx.voice.toggleCamera();
  }
  if (meP && meP.screen === false && ctx.voice.screenOn) {
    ctx.voice.toggleScreenShare();
  }
}

const deviceLabel = () => {
  const ua = navigator.userAgent || '';
  if (/WatchlivoApp/i.test(ua) || (/Android/i.test(ua) && /;\s*wv\b/i.test(ua))) return 'Mobil Uygulama';
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'Tablet';
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  if (/iPhone|Android|Mobile/i.test(ua)) return 'Mobil';
  return window.vortexDesktop ? 'Masaüstü' : 'Web';
};

function applyRoom(room, { reload = false, viaPoll = false, fromInit = false } = {}) {
  if (!room) return;
  if (!room.curated && room.media?.title && !/içerik seçilmedi|medya seçilmedi|hazır/i.test(String(room.media.title))) {
    room = { ...room, name: String(room.media.title).trim().slice(0, 80) };
  }
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
    if (ctx?.conn) ctx.conn.lastRoom = room;
    if (isTimeKeeper() && (!ctx?.lastMediaRestoreAt || Date.now() - ctx.lastMediaRestoreAt > 2500)) {
      if (ctx) ctx.lastMediaRestoreAt = Date.now();
      const localCtx = ctx;
      const curPos = ctx?.host.adapter?.getTime?.() ?? expectedPosition(curRoom.media);
      setTimeout(() => {
        if (!localCtx || ctx !== localCtx) return;
        localCtx.conn?.send('change_media', { ...curRoom.media, currentTime: curPos });
      }, 120);
    }
  }
  if (ctx && curRoom) {
    const prevHost = curRoom.hostId || curRoom.host_id || '';
    const nextHost = room.hostId || room.host_id || '';
    if (prevHost && nextHost && prevHost !== nextHost) {
      ctx.lastLeaderActionAt = 0;
    }
  }
  if (nextKey && nextKey === prevKey && curRoom?.media?.url && !String(curRoom.media.url).startsWith('/api/rave/resolve-catalog') && String(room.media?.url || '').startsWith('/api/rave/resolve-catalog')) {
    const useLocalClock = Boolean(!fromInit && isTimeKeeper() && ctx?.host?.adapter && !ctx.host.loading);
    const livePos = useLocalClock
      ? (ctx.host.adapter.getTime?.() ?? expectedPosition(curRoom.media))
      : Number(room.media.meshStatePosition ?? room.media.currentTime ?? 0);
    const keepPaused = useLocalClock
      ? Boolean(ctx?.userPaused || curRoom.media.meshStateStatus === 'PAUSED' || curRoom.media.playing === false)
      : !isRoomMediaPlaying(room.media);
    room = {
      ...room,
      media: {
        ...room.media,
        provider: curRoom.media.provider || room.media.provider,
        streamType: curRoom.media.streamType || room.media.streamType,
        url: curRoom.media.url,
        altUrls: curRoom.media.altUrls || room.media.altUrls,
        servers: (curRoom.media.servers && curRoom.media.servers.length) ? curRoom.media.servers : room.media.servers,
        audioTracks: (curRoom.media.audioTracks && curRoom.media.audioTracks.length) ? curRoom.media.audioTracks : room.media.audioTracks,
        subtitleTracks: (curRoom.media.subtitleTracks && curRoom.media.subtitleTracks.length) ? curRoom.media.subtitleTracks : room.media.subtitleTracks,
        intro: curRoom.media.intro || room.media.intro,
        duration: curRoom.media.duration || room.media.duration,
        ...(useLocalClock ? {
          playing: !keepPaused,
          currentTime: livePos,
          meshStateStatus: keepPaused ? 'PAUSED' : 'PLAYING',
          meshStatePosition: livePos,
          meshStateTime: clock.now(),
        } : {}),
      },
    };
    if (ctx && isTimeKeeper() && (!ctx.lastResolvePushAt || Date.now() - ctx.lastResolvePushAt > 4000)) {
      ctx.lastResolvePushAt = Date.now();
      const localCtx = ctx;
      const pushMedia = room.media;
      const pushPos = useLocalClock ? livePos : expectedPosition(room.media);
      setTimeout(() => {
        if (!localCtx || ctx !== localCtx) return;
        localCtx.conn?.send('resolve_media', { ...pushMedia, currentTime: pushPos });
      }, 60);
    }
  }
  if (nextKey && nextKey === prevKey && curRoom?.media?.similar?.length && !(room.media?.similar?.length)) {
    room = { ...room, media: { ...room.media, similar: curRoom.media.similar } };
  }
  if (curRoom && isTimeKeeper() && nextKey && nextKey === prevKey) {
    const curMedia = curRoom.media || {};
    const nextMedia = room.media || {};
    if ((ctx?.lastLeaderActionAt && Date.now() - ctx.lastLeaderActionAt < 6500) || ctx?.userPaused) {
      const inSeekGrace = Boolean(ctx?.lastSeekAt && Date.now() - ctx.lastSeekAt < 4500 && Number.isFinite(ctx.lastSeekTarget));
      const pos = inSeekGrace ? expectedPosition(curMedia) : (ctx?.host.adapter?.getTime?.() ?? curMedia.meshStatePosition);
      const isPausedNow = Boolean(ctx?.userPaused || curMedia.meshStateStatus === 'PAUSED' || curMedia.playing === false);
      room = {
        ...room,
        media: {
          ...nextMedia,
          intro: nextMedia.intro || curMedia.intro,
          playing: !isPausedNow,
          currentTime: pos,
          meshStateStatus: isPausedNow ? 'PAUSED' : 'PLAYING',
          meshStatePosition: pos,
          meshStateTime: clock.now(),
          meshStatePlaybackSpeed: curMedia.meshStatePlaybackSpeed || 1,
        },
      };
    }
    if (ctx?.lastPrivacy && ctx.lastPrivacyAt && Date.now() - ctx.lastPrivacyAt < 10000) {
      room = { ...room, privacy: ctx.lastPrivacy };
    }
  }
  if (ctx && isLeader()) {
    let savedPriv = ctx.lastPrivacy || '';
    if (!savedPriv && room.id) {
      try { savedPriv = sessionStorage.getItem(`vortex_priv_${room.id}`) || ''; } catch (e) { /* ignore */ }
    }
    if (savedPriv && room.privacy !== savedPriv) {
      room = { ...room, privacy: savedPriv };
      if (!ctx.lastPrivacySyncAt || Date.now() - ctx.lastPrivacySyncAt > 3500) {
        ctx.lastPrivacySyncAt = Date.now();
        const localCtx = ctx;
        setTimeout(() => {
          if (!localCtx || ctx !== localCtx) return;
          localCtx.conn?.send('host_action', { action: 'set_privacy', privacy: savedPriv });
        }, 80);
      }
    }
  }
  if (!room.curated && !(ctx?.chatClearedAt && Date.now() - ctx.chatClearedAt < 10000)) {
    const nowSec = Date.now() / 1000;
    const saved = loadSavedChat(room.id);
    const localCur = (Array.isArray(curRoom?.chat) ? curRoom.chat : []).filter((m) => m && (!m.system || (nowSec - Number(m.ts || 0) <= 1800)));
    const srvChat = (Array.isArray(room.chat) ? room.chat : []).filter((m) => m && (!m.system || (nowSec - Number(m.ts || 0) <= 1800)));
    const mergedMap = new Map();
    for (const m of [...saved, ...localCur, ...srvChat]) {
      if (m && m.id) {
        const prev = mergedMap.get(m.id);
        mergedMap.set(m.id, prev ? { ...prev, ...m, reactions: m.reactions || prev.reactions } : m);
      }
    }
    const sorted = Array.from(mergedMap.values()).sort((a, b) => (Number(a.ts || 0) - Number(b.ts || 0)));
    let presCnt = 0;
    let seenMed = false;
    const dedupRev = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const m = sorted[i];
      if (m.system) {
        const txt = String(m.text || '');
        if (/katıldı|ayrıldı/i.test(txt)) {
          if (presCnt >= 6) continue;
          presCnt += 1;
        } else if (/oynatılıyor|başlatıldı/i.test(txt)) {
          if (seenMed) continue;
          seenMed = true;
        }
      }
      dedupRev.push(m);
    }
    dedupRev.reverse();
    room = { ...room, chat: dedupRev.slice(-200) };
  }
  if (ctx) {
    if (!ctx.seenParticipantIds) {
      ctx.seenParticipantIds = new Set((room.participants || []).map((p) => p.id));
    } else {
      for (const p of (room.participants || [])) {
        if (p && p.id && !ctx.seenParticipantIds.has(p.id)) {
          ctx.seenParticipantIds.add(p.id);
          if (p.id !== state.clientId && p.transport !== 'bot') {
            toast(`🟢 ${p.name || 'Bir izleyici'} odaya katıldı`);
          }
        }
      }
    }
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
  if (curRoom?.media && room?.media && mediaKey(curRoom.media) === mediaKey(room.media)) {
    const prevMUrl = String(curRoom.media.url || '');
    const nextMUrl = String(room.media.url || '');
    if ((!nextMUrl || nextMUrl.startsWith('/api/rave/resolve-catalog')) && prevMUrl && !prevMUrl.startsWith('/api/rave/resolve-catalog')) {
      room = {
        ...room,
        media: {
          ...room.media,
          url: prevMUrl,
          altUrls: room.media.altUrls?.length ? room.media.altUrls : (curRoom.media.altUrls || []),
          subtitleTracks: room.media.subtitleTracks?.length ? room.media.subtitleTracks : (curRoom.media.subtitleTracks || []),
          audioTracks: room.media.audioTracks?.length ? room.media.audioTracks : (curRoom.media.audioTracks || []),
          servers: room.media.servers?.length ? room.media.servers : (curRoom.media.servers || []),
          intro: room.media.intro || curRoom.media.intro || null,
        },
      };
    }
  }
  if (!room?.media?.url && !room?.media?.videoId && (state.route?.params?.tmdbId || state.route?.params?.t)) {
    const rp = state.route.params;
    const isTvParam = rp.mt === 'tv' || Number(rp.s || 0) > 0 || Number(rp.e || 0) > 0;
    const sNum = Math.max(1, Number(rp.s || 1));
    const eNum = Math.max(1, Number(rp.e || 1));
    const qStr = new URLSearchParams({
      provider: 'cinema',
      title: rp.t || '',
      origTitle: rp.t || '',
      tmdbId: rp.tmdbId || '',
      mediaType: isTvParam ? 'tv' : 'movie',
      season: isTvParam ? String(sNum) : '',
      episode: isTvParam ? String(eNum) : '',
    }).toString();
    room = {
      ...room,
      media: {
        provider: 'hls',
        streamType: 'hls',
        url: `/api/rave/resolve-catalog?${qStr}`,
        title: rp.t || room.name || 'Sinema Odası',
        tmdbId: rp.tmdbId || '',
        mediaType: isTvParam ? 'tv' : 'movie',
        season: isTvParam ? sNum : 0,
        episode: isTvParam ? eNum : 0,
        playing: true,
        currentTime: 0,
        meshStateStatus: 'PLAYING',
        meshStatePosition: 0,
        meshStateTime: clock.now(),
      },
    };
  }
  set({ mesh: room });
  try {
    const dynTitle = String(room?.media?.title || room?.name || '').trim();
    if (dynTitle && !/içerik seçilmedi|medya seçilmedi|hazır/i.test(dynTitle)) {
      document.title = `🎬 ${dynTitle} — Watchlivo İzleme Odası`;
    } else if (room?.name) {
      document.title = `🍿 ${room.name} — Watchlivo Sinema Odası`;
    }
  } catch (_) {}
  if (ctx?.conn) ctx.conn.lastRoom = room;
  if (room?.media) room.media = normalizeRoomMediaState(curRoom?.media, room.media);
  saveChat(room);
  rememberRoom(room);
  reconcileSelfVoiceState(room);
  const key = mediaKey(room.media);
  const prevUrl = String(curRoom?.media?.url || '');
  const nextUrl = String(room.media?.url || '');
  const urlResolved = Boolean(nextUrl && !nextUrl.startsWith('/api/rave/resolve-catalog') && (!prevUrl || prevUrl.startsWith('/api/rave/resolve-catalog') || !ctx?.host?.adapter));
  if (reload || key !== prevKey || urlResolved) {
    loadMedia(room.media);
  } else {
    if (!isTimeKeeper() && ctx?.host?.adapter && room.media) {
      const target = expectedPosition(room.media);
      if (ctx.host.loading) {
        if (!room.curated && !room.media.live && target >= 0.8) {
          ctx.host.adapter.updateInitialSeek?.(target);
        }
      } else {
        const isPaused = !isRoomMediaPlaying(room.media);
        if (isPaused) {
          ctx.userPaused = true;
          ctx.host.adapter.pause?.();
          if (!room.curated && !room.media.live && Math.abs((ctx.host.adapter.getTime?.() || 0) - target) > 0.35) {
            ctx.host.adapter.seek?.(target);
          }
        } else {
          ctx.userPaused = false;
          if (ctx.host.adapter.isPaused?.() && !ctx.host.adapter.autoplayHardBlocked) ctx.host.adapter.play?.();
          if (!room.curated && !room.media.live && (fromInit || !ctx.sync?.didInitialSync) && target >= 0.8 && Math.abs((ctx.host.adapter.getTime?.() || 0) - target) > 1.5) {
            ctx.host.adapter.seek?.(target);
          }
        }
      }
    }
    ctx?.sync.kick();
  }
  setBackground(thumbFor(room.media));
  ctx?.layout.update();
  ctx?.voice?.syncPeers(room.participants || []);
}

async function loadMedia(media) {
  if (!ctx || !media) return;
  const mKey = mediaKey(media);
  const sig = `${mKey}|${media.url || ''}`;
  if (ctx.loadingSig === sig) return;
  const stripAudParam = (u) => String(u || '').replace(/&proxy_segs=1/g, '');
  const alreadyLoadedResolved = Boolean(
    mKey && ctx.host?.key === mKey && ctx.host?.adapter
    && ctx.host?.loadedUrl && !String(ctx.host.loadedUrl).startsWith('/api/rave/resolve-catalog')
    && (
      (String(media.url || '').startsWith('/api/rave/resolve-catalog') && !/[?&]aud=/i.test(String(media.url || '')))
      || stripAudParam(ctx.host.loadedUrl) === stripAudParam(media.url)
    )
  );
  if (alreadyLoadedResolved) {
    ctx.loadingSig = sig;
    if (ctx.host.loading) {
      ctx.host.loading = false;
      ctx.layout?.playerEvent?.('loaded');
    }
    if ((!isTimeKeeper() || !ctx.sync?.didInitialSync) && !state.mesh?.curated && !media?.live) {
      const liveExp = expectedPosition(state.mesh?.media || media);
      if (liveExp >= 0.8 && Math.abs((ctx.host.adapter.getTime?.() || 0) - liveExp) > 1.5) {
        ctx.host.adapter.seek?.(liveExp);
      }
    }
    ctx.sync?.kick();
    return;
  }
  ctx.loadingSig = sig;
  ctx.loadSeq = (ctx.loadSeq || 0) + 1;
  const mySeq = ctx.loadSeq;
  ctx.userPaused = !isRoomMediaPlaying(media);
  if (ctx.sync) ctx.sync.didInitialSync = false;
  const wasNewCreatorRoom = Boolean(ctx.isNew && isTimeKeeper());
  const initialPos = Math.max(0, Number(media?.meshStatePosition ?? media?.currentTime ?? 0));
  const exp = expectedPosition(media);
  const start = !isTimeKeeper()
    ? (media?.live ? 0 : (exp >= 0.8 ? exp : initialPos))
    : ((wasNewCreatorRoom && initialPos < 3.0 && exp < 3.0) ? 0 : Math.max(initialPos, exp >= 0.8 ? exp : 0));
  ctx.isNew = false;
  const playing = isRoomMediaPlaying(media);
  if (String(media.url || '').startsWith('/api/rave/resolve-catalog')) {
    ctx.layout?.playerEvent?.('loading');
    if (!isTimeKeeper()) {
      for (let w = 0; w < 2; w += 1) {
        await new Promise((r) => setTimeout(r, 150));
        if (!ctx || ctx.loadSeq !== mySeq) return;
        const latest = state.mesh?.media;
        if (latest?.url && !String(latest.url).startsWith('/api/rave/resolve-catalog') && mediaKey(latest) === mKey) {
          media = latest;
          break;
        }
      }
    }
    if (String(media.url || '').startsWith('/api/rave/resolve-catalog')) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const r = await fetch(media.url);
          if (!ctx || ctx.loadSeq !== mySeq) return;
          if (r.ok) {
            const res = await r.json();
            if (!ctx || ctx.loadSeq !== mySeq) return;
            if (res && res.url) {
              const refMedia = state.mesh?.media || media;
              const roomStillUnresolved = String(refMedia?.url || '').startsWith('/api/rave/resolve-catalog');
              const freshExp = expectedPosition(refMedia);
              const resolvedStart = (wasNewCreatorRoom && initialPos < 3.0 && freshExp < 3.0)
                ? 0
                : Math.max(initialPos, freshExp >= 0.8 ? freshExp : 0);
              const keepServerClockAnchor = !isTimeKeeper() && Number(refMedia?.meshStateTime || refMedia?.updatedAt || 0) > 1000000000;
              media = {
                ...media,
                provider: res.provider || 'hls',
                streamType: res.streamType || 'hls',
                url: res.url,
                videoId: res.videoId || media.videoId || '',
                embedUrl: res.embedUrl || media.embedUrl || '',
                title: res.title || media.title || '',
                channel: res.channel || media.channel || '',
                thumbnail: res.thumbnail || media.thumbnail || '',
                altUrls: res.altUrls || [],
                servers: (res.servers && res.servers.length) ? res.servers : (media.servers || []),
                audioTracks: (res.audioTracks && res.audioTracks.length) ? res.audioTracks : media.audioTracks,
                subtitleTracks: (res.subtitleTracks && res.subtitleTracks.length) ? res.subtitleTracks : (res.subtitles || media.subtitleTracks),
                intro: res.intro || media.intro,
                duration: res.duration || media.duration,
                meshStatePosition: keepServerClockAnchor ? Number(refMedia.meshStatePosition ?? refMedia.currentTime ?? resolvedStart) : resolvedStart,
                meshStateTime: keepServerClockAnchor ? Number(refMedia.meshStateTime ?? refMedia.updatedAt ?? clock.now()) : clock.now(),
              };
              if (state.mesh) {
                const updatedMesh = { ...state.mesh, media };
                set({ mesh: updatedMesh });
                if (ctx?.conn) ctx.conn.lastRoom = updatedMesh;
                rememberRoom(updatedMesh);
              }
              if (isTimeKeeper() || roomStillUnresolved) {
                if (ctx) ctx.lastResolvePushAt = Date.now();
                ctx.conn?.send('resolve_media', { ...media, currentTime: resolvedStart });
              }
              break;
            }
          }
        } catch (e) { /* retry */ }
      }
    }
  }
  if (!ctx || ctx.loadSeq !== mySeq) return;
  if (String(media.url || '').startsWith('/api/rave/resolve-catalog')) {
    ctx.host.loading = false;
    ctx.loadingSig = '';
    ctx.layout?.playerEvent?.('error', 'Yayın kaynağı şu an çözümlenemedi, lütfen yenileyin.');
    return;
  }
  ctx.loadingSig = `${mediaKey(media)}|${media.url || ''}`;
  const finalExp = expectedPosition(state.mesh?.media || media);
  const finalStart = media?.live
    ? 0
    : (!isTimeKeeper()
      ? (finalExp >= 0.8 ? finalExp : (start >= 0.5 ? start : 0))
      : ((wasNewCreatorRoom && initialPos < 3.0 && finalExp < 5.0)
        ? 0
        : (finalExp >= 1.5 ? finalExp : (start >= 0.5 ? start : 0))));
  if (!state.mesh?.curated && !media?.live) {
    if (media?.isMusic || media?.mediaType === 'music') {
      saveMusicHistory(media);
    } else {
      saveWatchProgress(media, finalStart > 3 ? finalStart : 0, media?.duration || 0, { forceCloud: true });
    }
  }
  pushPresenceHeartbeat().catch(() => {});
  try {
    await ctx.host.setMedia(media, finalStart, playing);
  } catch (err) {
    if (ctx && ctx.loadSeq === mySeq) ctx.loadingSig = '';
    return;
  }
  if (!ctx || ctx.loadSeq !== mySeq) return;
  if (!isTimeKeeper()) {
    const ad = ctx.host?.adapter;
    const vEl = ad?.video;
    const snapGuestToLive = () => {
      if (!ctx || ctx.loadSeq !== mySeq || isTimeKeeper() || media?.live) return;
      const liveExp = expectedPosition(state.mesh?.media || media);
      const curPos = ad?.getTime?.() || 0;
      if (liveExp >= 0.6 && Math.abs(liveExp - curPos) > 1.0 && (!vEl || (!vEl.seeking && vEl.readyState >= 1))) {
        ad?.seek?.(liveExp);
      }
    };
    snapGuestToLive();
    if (vEl) {
      vEl.addEventListener('loadedmetadata', snapGuestToLive, { once: true });
      vEl.addEventListener('canplay', snapGuestToLive, { once: true });
      vEl.addEventListener('playing', snapGuestToLive, { once: true });
    }
  } else {
    const k = mediaKey(media);
    const ad = ctx.host?.adapter;
    const vEl = ad?.video;
    const fireLeaderAnchor = () => {
      if (!ctx || ctx.loadSeq !== mySeq || !isTimeKeeper() || ctx.anchoredKey === k) return;
      if (ad && !ad.isPaused?.() && (!vEl || (vEl.readyState >= 2 && !vEl.seeking))) {
        ctx.anchoredKey = k;
        actions.heartbeat(ad.getTime?.() ?? 0, true);
      }
    };
    if (vEl) {
      vEl.addEventListener('playing', fireLeaderAnchor, { once: true });
      if (vEl.readyState >= 3 && !vEl.paused) fireLeaderAnchor();
    } else {
      fireLeaderAnchor();
    }
  }
  if (ctx.sync) {
    ctx.sync.seekUntil = performance.now() + (isTimeKeeper() ? 1800 : 2800);
    ctx.sync.deferStartedAt = 0;
    ctx.sync.kick(false);
  }
  ctx.layout.update();
}

function onMessage(data) {
  const room = state.mesh;
  switch (data.type) {
    case 'init': {
      if (ctx?.initFallbackTimer) {
        clearTimeout(ctx.initFallbackTimer);
        ctx.initFallbackTimer = null;
      }
      if (ctx) ctx.initReceived = true;
      set({ clientId: data.clientId });
      const needReload = !ctx?.host?.adapter || mediaKey(data.room?.media) !== mediaKey(room?.media);
      applyRoom(data.room, { reload: needReload, fromInit: true });
      break;
    }
    case 'room_state': case 'media_changed': case 'user_joined': case 'user_left':
      if (data.room) applyRoom(data.room, { viaPoll: !!data.viaHttp });
      if (data.type === 'user_joined' && data.user?.id !== state.clientId) {
        ctx?.voice?.onPeerJoined(data.user.id);
        if (isTimeKeeper()) actions.heartbeat(undefined, true);
      }
      break;
    case 'sync':
      if (data.cid && data.cid === state.clientId) break;
      if (data.viaP2p && room && ['leader', 'vote', 'autoplay'].includes(room.playMode || 'leader') && data.cid && data.cid !== (room.hostId || room.host_id) && !(room.coHosts || room.co_hosts || []).includes(data.cid)) break;
      if (isTimeKeeper() && (data.action === 'poll_sync' || data.action === 'heartbeat') && (ctx?.userPaused || (ctx?.lastLeaderActionAt && Date.now() - ctx.lastLeaderActionAt < 6500))) break;
      if (room && data.media) {
        const incTime = Number(data.media.meshStateTime || data.media.updatedAt || 0);
        const curTime = Number(room.media?.meshStateTime || room.media?.updatedAt || 0);
        if ((data.action === 'heartbeat' || data.action === 'poll_sync') && incTime > 0 && curTime > 0 && incTime < curTime - 0.05) {
          break;
        }
        const prevKey = mediaKey(room.media);
        const incomingKey = mediaKey(data.media);
        if (data.viaP2p && prevKey && incomingKey && incomingKey !== prevKey) {
          break;
        }
        const safeIncomingMedia = data.viaP2p
          ? {
              ...data.media,
              url: room.media?.url || '',
              embedUrl: room.media?.embedUrl || '',
              videoId: room.media?.videoId || '',
              provider: room.media?.provider || '',
            }
          : data.media;
        const mergedMedia = normalizeRoomMediaState(room.media, safeIncomingMedia);
        const prevUrl = String(room.media?.url || '');
        const nextUrl = String(safeIncomingMedia?.url || '');
        const sameMediaTarget = !incomingKey || prevKey === incomingKey;
        if ((!nextUrl || nextUrl.startsWith('/api/rave/resolve-catalog')) && prevUrl && !prevUrl.startsWith('/api/rave/resolve-catalog') && sameMediaTarget) {
          mergedMedia.url = prevUrl;
          if (!mergedMedia.altUrls?.length && room.media?.altUrls?.length) mergedMedia.altUrls = room.media.altUrls;
          if (!mergedMedia.subtitleTracks?.length && room.media?.subtitleTracks?.length) mergedMedia.subtitleTracks = room.media.subtitleTracks;
          if (!mergedMedia.audioTracks?.length && room.media?.audioTracks?.length) mergedMedia.audioTracks = room.media.audioTracks;
          if (!mergedMedia.servers?.length && room.media?.servers?.length) mergedMedia.servers = room.media.servers;
        }
        if (!mergedMedia.servers?.length && room.media?.servers?.length && prevKey === mediaKey(mergedMedia)) {
          mergedMedia.servers = room.media.servers;
        }
        if (sameMediaTarget) {
          if (!mergedMedia.url && room.media?.url) mergedMedia.url = room.media.url;
          if (!mergedMedia.videoId && room.media?.videoId) mergedMedia.videoId = room.media.videoId;
          if (!mergedMedia.title && room.media?.title) mergedMedia.title = room.media.title;
          if (!mergedMedia.provider && room.media?.provider) mergedMedia.provider = room.media.provider;
        }
        const nextKey = mediaKey(mergedMedia);
        const urlResolved = Boolean(nextUrl && !nextUrl.startsWith('/api/rave/resolve-catalog') && (!prevUrl || prevUrl.startsWith('/api/rave/resolve-catalog') || !ctx?.host?.adapter));
        const updatedRoom = { ...room, media: mergedMedia };
        set({ mesh: updatedRoom });
        if (ctx?.conn) ctx.conn.lastRoom = updatedRoom;
        if (nextKey && (nextKey !== prevKey || urlResolved || !ctx?.host?.adapter)) {
          loadMedia(mergedMedia);
          break;
        }
        const isExplicitAction = ['play', 'pause', 'seek', 'rate'].includes(data.action);
        if (!isRoomMediaPlaying(mergedMedia)) {
          if (ctx) ctx.userPaused = true;
          ctx?.host?.adapter?.pause?.();
          const target = Number(mergedMedia.meshStatePosition || 0);
          if (Math.abs((ctx?.host?.adapter?.getTime?.() || 0) - target) > 0.25) {
            if (ctx?.sync) {
              ctx.sync.lastSeekTarget = target;
              ctx.sync.lastSeekWallAt = performance.now();
              ctx.sync.seekUntil = performance.now() + 1800;
            }
            ctx?.host?.adapter?.seek?.(target);
          }
        } else if (data.action === 'play' || (!isTimeKeeper() && (data.action === 'heartbeat' || data.action === 'poll_sync'))) {
          if (ctx) ctx.userPaused = false;
          if (ctx?.host?.adapter?.isPaused?.() && !ctx.host.adapter.autoplayHardBlocked) {
            ctx?.host?.adapter?.play?.();
          }
          if (!isTimeKeeper() && ctx?.sync && data.action === 'play') {
            ctx.sync.seekUntil = 0;
          }
        } else if (data.action === 'seek') {
          const target = Number(mergedMedia.meshStatePosition || 0);
          if (ctx?.sync) {
            ctx.sync.lastSeekTarget = target;
            ctx.sync.lastSeekWallAt = performance.now();
            ctx.sync.seekUntil = performance.now() + 2600;
          }
          ctx?.host?.adapter?.seek?.(target);
        } else if (data.action === 'rate') {
          const nextRate = Number(mergedMedia.meshStatePlaybackSpeed || 1);
          if (Number.isFinite(nextRate) && nextRate > 0) ctx?.host?.adapter?.setRate?.(nextRate);
        }
        if (ctx?.sync) {
          ctx.sync.kick(isExplicitAction && data.action !== 'seek' && data.action !== 'pause');
        }
        ctx.layout.update();
      }
      break;
    case 'chat':
      if (room && data.message) {
        if (data.message.id && ctx?.seenChatIds?.has(data.message.id)) break;
        if (data.message.id) ctx?.seenChatIds?.add(data.message.id);
        const updatedChat = [...(room.chat || []).filter((c) => c && c.id !== data.message.id), data.message].slice(-200);
        const updatedRoom = { ...room, chat: updatedChat };
        set({ mesh: updatedRoom });
        if (ctx?.conn) ctx.conn.lastRoom = updatedRoom;
        saveChat(updatedRoom);
        ctx.layout.chatAppended(data.message);
        if (!data.message.system) ctx.layout.danmaku?.(data.message);
      }
      break;
    case 'chat_cleared':
      if (room) {
        if (ctx) ctx.chatClearedAt = Date.now();
        clearSavedChat(room.id);
        ctx.seenChatIds?.clear();
        ctx.layout?.clearChatDom?.();
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
    case 'reaction':
      if (!ctx?.voice?.deafened) playEmojiSfx(data.emoji);
      ctx?.layout.floatEmoji(data.emoji, data.user);
      break;
    case 'soundfx':
      if (!ctx?.voice?.deafened) playRoomSfx(data.sfx);
      ctx?.layout.floatEmoji(data.sfx === 'clap' ? '👏' : data.sfx === 'laugh' ? '😂' : data.sfx === 'suspense' ? '🥁' : '🎉', data.user);
      break;
    case 'break_request': {
      if (ctx) {
        if (!ctx.seenBreakIds) ctx.seenBreakIds = new Set();
        if (data.id && ctx.seenBreakIds.has(data.id)) break;
        if (data.id) ctx.seenBreakIds.add(data.id);
      }
      const senderName = data.user || 'Bir izleyici';
      if (data.cid !== state.clientId) {
        if (!ctx?.voice?.deafened) playEmojiSfx('☕');
        ctx?.layout?.floatEmoji?.('☕', senderName);
      }
      if (isLeader()) {
        ctx?.layout?.showBreakRequestBanner?.(senderName);
        if (data.cid !== state.clientId) {
          toast(`☕ ${senderName} mola zamanı (duraklatma isteği) gönderdi!`);
        }
      } else if (data.cid !== state.clientId) {
        toast(`☕ ${senderName} oda kurucusuna duraklatma isteği gönderdi`);
      }
      break;
    }
    case 'queue_updated': case 'vote_updated': if (room) { set({ mesh: { ...room, queue: data.queue, voteEndsAt: data.voteEndsAt ?? room.voteEndsAt } }); ctx.layout.update(); } break;
    case 'skip_votes': if (room) { set({ mesh: { ...room, skip_votes: data.votes, skipNeeded: data.needed } }); ctx.layout.update(); } break;
    case 'hand_raised': {
      if (data.cid && data.cid !== state.clientId && isLeader()) {
        const uName = data.user || 'Bir izleyici';
        toast(`✋ ${uName} konuşmak için söz istiyor!`, 6000, {
          actionLabel: '🎤 Söz Ver',
          onAction: () => actions.toggleStageSpeaker(data.cid),
        });
      }
      break;
    }
    case 'participants_updated':
      if (room) {
        const pList = Array.isArray(data.participants) ? data.participants : [];
        const nextRoom = { ...room, participants: pList, participantCount: pList.length, count: pList.length };
        set({ mesh: nextRoom });
        reconcileSelfVoiceState(nextRoom);
        ctx.layout.update();
        ctx.voice?.syncPeers(data.participants);
      }
      break;
    case 'room_closed': {
      document.body.classList.remove('mesh-minimized');
      const closedId = data.roomId || room?.id || state.route?.params?.id;
      if (closedId) {
        forgetRoom(closedId);
        clearSavedChat(closedId);
      }
      ctx?.conn?.close(false);
      leaveMeshView(true);
      toast('🚪 Oda kurucusu odayı kapattı');
      window.vortexNavigate('/');
      break;
    }
    case 'password_required': askPassword(); break;
    case 'kicked': {
      document.body.classList.remove('mesh-minimized');
      const kickedId = data.roomId || room?.id || state.route?.params?.id;
      if (typeof document !== 'undefined' && document.pictureInPictureElement) {
        try { document.exitPictureInPicture().catch(() => {}); } catch (_) {}
      }
      if (kickedId) {
        forgetRoom(kickedId);
        clearSavedChat(kickedId);
      }
      ctx?.conn?.close(false);
      leaveMeshView(true);
      window.vortexNavigate('/');
      popup({ title: 'Odadan Çıkarıldın', message: 'Bu oda kapatıldı veya oda lideri tarafından çıkarıldın.', persistOnNavigate: true, options: [{ label: 'Ana Sayfa', primary: true, onClick: () => window.vortexNavigate('/') }], dismissable: false });
      break;
    }
    case 'webrtc_offer': case 'webrtc_answer': case 'webrtc_ice': ctx?.voice?.onSignal(data); break;
    case 'error': toast(data.message || 'İşlem reddedildi'); break;
    default: break;
  }
}

function askPassword() {
  if (typeof document !== 'undefined') {
    const existingPwd = document.getElementById('wl-room-pwd-input');
    if (existingPwd && !existingPwd.closest('.popup-backdrop.is-closing')) return;
  }
  if (typeof document !== 'undefined' && document.pictureInPictureElement) {
    try { document.exitPictureInPicture().catch(() => {}); } catch (_) {}
  }
  const submitPwd = () => {
    const id = state.route.params.id;
    const val = input.value;
    try { if (id && val) sessionStorage.setItem(`vortex_pwd_${id}`, val); } catch (_) {}
    leaveMeshView();
    enterMesh(document.getElementById('mesh-root') || document.getElementById('app'), { id, pwd: val });
  };
  const input = h('input', {
    class: 'input',
    id: 'wl-room-pwd-input',
    type: 'password',
    placeholder: 'Oda şifresi',
    'aria-label': 'Oda şifresi',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const bd = document.querySelector('.popup-backdrop');
        if (bd?._closePopup) bd._closePopup(); else bd?.remove();
        submitPwd();
      }
    },
  });
  popup({ title: 'Bu oda şifreli', content: input, dismissable: false, options: [
    { label: 'Katıl', primary: true, onClick: submitPwd },
    { label: 'Ana Sayfa', onClick: () => { leaveMeshView(false); window.vortexNavigate('/'); } },
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
  const updatedRoom = { ...state.mesh, media };
  set({ mesh: updatedRoom });
  if (ctx?.conn) ctx.conn.lastRoom = updatedRoom;
  ctx.sync.kick();
  ctx.layout.update();
}

const actions = {
  heartbeat(explicitTime, forceAnchor = false) {
    if (!ctx || !isTimeKeeper()) return;
    const ad = ctx.host?.adapter;
    if (!ad || ctx.host.loading || ad.isBuffering?.() || ad.video?.seeking) return;
    if (ad.video && ad.video.readyState < 2) return;
    if (ctx.lastSeekAt && Date.now() - ctx.lastSeekAt < 3500 && Math.abs((ad.video?.currentTime || 0) - (ctx.lastSeekTarget || 0)) > 2.5) return;
    const t = Math.max(0, Number.isFinite(explicitTime) ? explicitTime : (ad.getTime?.() ?? 0));
    const expNow = expectedPosition(state.mesh?.media);
    if ((!forceAnchor && t < 0.15) || (expNow > 30 && t < 2 && ad.initialSeekPending > 5)) return;
    const playing = !ctx.userPaused;
    if (isActiveTimeKeeper()) ctx.lastLeaderActionAt = Date.now();
    if (ctx.sync) ctx.sync.lastLeaderBroadcast = performance.now();
    localState({ meshStateStatus: playing ? 'PLAYING' : 'PAUSED', meshStatePosition: t });
    const curM = state.mesh?.media;
    const resolvedActive = (curM?.url && !String(curM.url).startsWith('/api/rave/resolve-catalog'))
      ? {
          url: curM.url,
          provider: curM.provider || 'hls',
          streamType: curM.streamType || 'hls',
          duration: curM.duration || ad.getDuration?.() || 0,
          title: curM.title || '',
          tmdbId: curM.tmdbId || '',
          imdbId: curM.imdbId || '',
          mediaType: curM.mediaType || '',
          season: curM.season || 0,
          episode: curM.episode || 0,
          videoId: curM.videoId || '',
        }
      : undefined;
    ctx.conn.send('heartbeat', {
      currentTime: t,
      playing,
      atTime: clock.now(),
      anchor: Boolean(forceAnchor),
      privacy: state.mesh?.privacy || undefined,
      activeMedia: resolvedActive,
    });
  },
  play() {
    if (!ctx) return;
    if (!isLeader()) {
      ctx.host.adapter?.play?.();
      ctx.sync?.kick();
      return;
    }
    ctx.userPaused = false;
    if (isActiveTimeKeeper()) ctx.lastLeaderActionAt = Date.now();
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
    if (isActiveTimeKeeper()) ctx.lastLeaderActionAt = Date.now();
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
    const roomStatusPlaying = (state.mesh?.media?.meshStateStatus || (state.mesh?.media?.playing !== false ? 'PLAYING' : 'PAUSED')) === 'PLAYING';
    const adapterPlaying = ctx?.host?.adapter ? !ctx.host.adapter.isPaused() : roomStatusPlaying;
    const isCurrentlyPlaying = !ctx?.userPaused && (roomStatusPlaying || adapterPlaying);
    isCurrentlyPlaying ? actions.pause() : actions.play();
  },
  seek(t) {
    if (!ctx) return;
    if (state.mesh?.curated) { toast('7/24 canlı yayın akışı ileri/geri sarılamaz'); return; }
    if (!isLeader()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
    const d = Number(ctx.host.adapter?.getDuration?.() || state.mesh?.media?.duration || 0);
    const target = d > 0 ? Math.max(0, Math.min(d - 0.5, Number(t) || 0)) : Math.max(0, Number(t) || 0);
    if (isActiveTimeKeeper()) ctx.lastLeaderActionAt = Date.now();
    ctx.lastSeekTarget = target;
    ctx.lastSeekAt = Date.now();
    if (ctx.sync) {
      ctx.sync.lastSeekTarget = target;
      ctx.sync.lastExpected = target;
      ctx.sync.seekUntil = performance.now() + 2400;
      ctx.sync.lastLeaderBroadcast = performance.now();
    }
    localState({ meshStatePosition: target });
    ctx.conn.send('seek', { currentTime: target, atTime: clock.now() });
    ctx.host.adapter?.seek?.(target);
  },
  setRate(r) {
    if (!ctx) return;
    if (!isLeader()) { toast('Oynatma hızını yalnızca oda lideri değiştirebilir'); return; }
    const t = ctx.host.adapter?.getTime() ?? 0;
    if (isActiveTimeKeeper()) ctx.lastLeaderActionAt = Date.now();
    ctx.host.adapter?.setRate?.(r);
    localState({ meshStatePlaybackSpeed: r, meshStatePosition: t });
    ctx.conn.send('rate', { rate: r, currentTime: t, atTime: clock.now() });
  },
  skip() { ctx.conn.send('vote_skip'); },
  // Rave play-mode rules for a selection made inside the mesh.
  pickMedia(media) {
    if (!ctx || !media) return;
    const mode = state.mesh?.playMode || 'leader';
    if (mode === 'leader' && !isLeader()) {
      ctx.conn.send('queue_add', { item: media });
      toast(`${media.title || 'Video'} sıraya önerildi — oda lideri başlatabilir`);
      set({ view: { ...state.view, left: 'Collapsed' } });
      ctx.layout.update();
      return;
    }
    if (isLeader() || mode === 'leader' || mode === 'cohost' || mode === 'quickplay' || !state.mesh?.media?.url) {
      ctx.userPaused = false;
      if (isActiveTimeKeeper()) ctx.lastLeaderActionAt = Date.now();
      const startPos = Number.isFinite(Number(media.currentTime)) && Number(media.currentTime) > 0 ? Number(media.currentTime) : 0;
      const nextMedia = { ...media, playing: true, currentTime: startPos, meshStateStatus: 'PLAYING', meshStatePosition: startPos, meshStateTime: clock.now() };
      if (state.mesh) {
        const nextName = (!state.mesh.curated && nextMedia.title) ? String(nextMedia.title).trim().slice(0, 80) : state.mesh.name;
        const updatedRoom = { ...state.mesh, name: nextName || state.mesh.name, media: nextMedia };
        if (typeof document !== 'undefined' && nextMedia.title) document.title = `${nextMedia.title} — Watchlivo`;
        set({ mesh: updatedRoom });
        if (ctx?.conn) ctx.conn.lastRoom = updatedRoom;
        rememberRoom(updatedRoom);
      }
      loadMedia(nextMedia);
      ctx.conn.send('change_media', { ...media, currentTime: startPos });
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
  queueBatch(items) {
    if (!ctx || !Array.isArray(items) || !items.length) return;
    ctx.conn.send('queue_add_batch', { items });
  },
  voteQueue(index, id = state.mesh?.queue?.[index]?.id) { ctx.conn.send('queue_vote', { index, id }); },
  removeQueue(index, id = state.mesh?.queue?.[index]?.id) { ctx.conn.send('queue_remove', { index, id }); },
  playQueue(index, id = state.mesh?.queue?.[index]?.id) { ctx.conn.send('queue_play', { index, id }); },
  voteVideo(index, id = state.mesh?.queue?.[index]?.id) { ctx.conn.send('vote_video', { index, id }); },
  playQueueIndex(index, id = state.mesh?.queue?.[index]?.id) { ctx.conn.send('queue_play_index', { index, id }); },
  removeQueueItem(index, id = state.mesh?.queue?.[index]?.id) { ctx.conn.send('queue_remove', { index, id }); },
  sendChat(text, extra = {}) {
    const cleanText = String(text || '').trim().slice(0, 1000);
    if (!cleanText && !extra.gif && !extra.snapshot && !extra.audioNote) return;
    const msgId = extra.id || ('m_' + Math.random().toString(36).slice(2, 10));
    const nowDate = new Date();
    const hh = String(nowDate.getHours()).padStart(2, '0');
    const mm = String(nowDate.getMinutes()).padStart(2, '0');
    const self = state.self || { name: 'İzleyici', color: '#27DCC8' };
    const optimisticMsg = {
      id: msgId,
      user: self.name || 'İzleyici',
      uid: self.id || '',
      color: self.color || '#27DCC8',
      text: cleanText,
      gif: extra.gif || '',
      snapshot: extra.snapshot || null,
      audioNote: extra.audioNote || null,
      videoTime: extra.videoTime ?? null,
      replyTo: extra.replyTo || null,
      reactions: {},
      time: `${hh}:${mm}`,
      ts: Date.now() / 1000,
    };
    if (state.mesh) {
      ctx?.seenChatIds?.add(msgId);
      const updatedChat = [...(state.mesh.chat || []).filter((c) => c && c.id !== msgId), optimisticMsg].slice(-200);
      const updatedRoom = { ...state.mesh, chat: updatedChat };
      set({ mesh: updatedRoom });
      if (ctx?.conn) ctx.conn.lastRoom = updatedRoom;
      saveChat(updatedRoom);
      ctx?.layout?.chatAppended?.(optimisticMsg);
      ctx?.layout?.danmaku?.(optimisticMsg);
    }
    const recentChat = (state.mesh?.chat || []).slice(-20).map((c) => {
      if (!c || typeof c !== 'object') return c;
      const { audioNote, snapshot, ...lite } = c;
      return lite;
    });
    ctx.conn.send('chat', { id: msgId, clientMsgId: msgId, text: cleanText, ...extra, recentChat });
  },
  clearChat() {
    if (!ctx) return;
    const coHosts = state.mesh?.co_hosts || state.mesh?.coHosts || [];
    if (!isHostOnly() && !coHosts.includes(state.clientId)) {
      toast('Sohbeti yalnızca oda lideri temizleyebilir');
      return;
    }
    ctx.chatClearedAt = Date.now();
    clearSavedChat(state.mesh?.id);
    ctx.seenChatIds?.clear();
    ctx.layout?.clearChatDom?.();
    if (state.mesh) set({ mesh: { ...state.mesh, chat: [], polls: [] } });
    ctx.conn.send('clear_chat');
  },
  createPoll(question, options) {
    if (!question || !Array.isArray(options) || options.length < 2) return;
    ctx.conn.send('poll_create', { question: String(question).trim().slice(0, 140), options: options.map((o) => String(o).trim().slice(0, 80)).filter(Boolean) });
  },
  votePoll(pollId, optionIndex) {
    if (!pollId || typeof optionIndex !== 'number') return;
    const room = state.mesh;
    const myName = state.self?.name || 'Misafir';
    const myVoteKey = `${myName}#${String(state.clientId || '').slice(-4)}`;
    const isMyVote = (u) => u === myVoteKey || u === myName || (!state.clientId && String(u).startsWith(`${myName}#`));
    if (room && Array.isArray(room.polls)) {
      const nextPolls = room.polls.map((p) => {
        if (!p || p.id !== pollId) return p;
        const nextOpts = (p.options || []).map((opt, idx) => {
          const curVotes = Array.isArray(opt.votes) ? [...opt.votes] : [];
          const hasMe = curVotes.some(isMyVote);
          if (idx === optionIndex) {
            return { ...opt, votes: hasMe ? curVotes.filter((u) => !isMyVote(u)) : [...curVotes, myVoteKey] };
          }
          return { ...opt, votes: curVotes.filter((u) => !isMyVote(u)) };
        });
        return { ...p, options: nextOpts };
      });
      set({ mesh: { ...room, polls: nextPolls } });
      ctx?.layout?.pollsUpdated?.();
    }
    ctx?.conn?.send('poll_vote', { pollId, optionIndex });
  },
  reactMessage(msgId, emoji) {
    if (!msgId || !emoji) return;
    const room = state.mesh;
    const myName = state.self?.name || 'Misafir';
    const myCidTail = String(state.clientId || '').slice(-4);
    const myTag = myCidTail ? `${myName}#${myCidTail}` : myName;
    if (room && Array.isArray(room.chat)) {
      const chatList = room.chat.map((m) => {
        if (m.id !== msgId) return m;
        const reacts = { ...(m.reactions || {}) };
        const users = Array.isArray(reacts[emoji]) ? [...reacts[emoji]] : [];
        let idx = users.findIndex((u) => u === myTag || u === myName || (myCidTail && String(u || '').endsWith(`#${myCidTail}`)));
        if (idx >= 0) users.splice(idx, 1);
        else users.push(myTag);
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
  reaction(emoji) { playEmojiSfx(emoji); ctx.layout.floatEmoji(emoji, state.self?.name); ctx.conn.send('reaction', { emoji }); },
  soundfx(sfx) { playRoomSfx(sfx); ctx.layout.floatEmoji(sfx === 'clap' ? '👏' : sfx === 'laugh' ? '😂' : sfx === 'suspense' ? '🥁' : '🎉', state.self?.name); ctx.conn.send('soundfx', { sfx }); },
  requestBreak() {
    if (!ctx) return;
    const nowMs = Date.now();
    if (ctx.lastBreakReqAt && nowMs - ctx.lastBreakReqAt < 350) return;
    if (ctx.lastBreakReqAt && nowMs - ctx.lastBreakReqAt < 2000) {
      toast('☕ Duraklatma isteği zaten gönderildi');
      return;
    }
    ctx.lastBreakReqAt = nowMs;
    const actId = 'brk_' + nowMs.toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    if (!ctx.seenBreakIds) ctx.seenBreakIds = new Set();
    ctx.seenBreakIds.add(actId);
    const myName = state.self?.name || 'İzleyici';
    playEmojiSfx('☕');
    ctx.layout?.floatEmoji?.('☕', myName);
    ctx.layout?.showBreakSentOverlay?.();
    toast('☕ Mola Zamanı: Duraklatma isteği oda kurucusuna gönderildi!');
    if (isLeader() || isHostOnly()) {
      ctx.layout?.showBreakRequestBanner?.(myName);
    }
    const curPos = Number(ctx.host?.adapter?.getTime?.() || state.mesh?.media?.currentTime || 0);
    ctx.conn.send('break_request', { actionId: actId, videoTime: curPos });
  },
  hostAction(action, extra = {}) {
    if (action === 'set_privacy' && state.mesh) {
      const patch = {};
      if (extra.privacy) {
        patch.privacy = extra.privacy;
        if (ctx) { ctx.lastPrivacy = extra.privacy; ctx.lastPrivacyAt = Date.now(); }
        try { sessionStorage.setItem(`vortex_priv_${state.mesh.id}`, extra.privacy); } catch (e) { /* ignore */ }
        const privNotice = {
          public: '🌐 Oda gizliliği "Herkese Açık" olarak ayarlandı',
          friends: '👥 Oda gizliliği "Sadece Arkadaşlar" olarak ayarlandı',
          private: '🔒 Oda gizliliği "Gizli Oda (Sadece Davet)" olarak ayarlandı',
        }[extra.privacy];
        if (privNotice) toast(privNotice);
      }
      if (extra.playMode) patch.playMode = extra.playMode;
      if (extra.voipMode) patch.voipMode = extra.voipMode;
      if (typeof extra.name === 'string' && extra.name.trim()) patch.name = extra.name.trim();
      if (typeof extra.password === 'string') patch.hasPassword = Boolean(extra.password.trim());
      if (Object.keys(patch).length) {
        const updatedRoom = { ...state.mesh, ...patch };
        set({ mesh: updatedRoom });
        rememberRoom(updatedRoom);
        ctx?.layout.update();
      }
    }
    ctx.conn.send('host_action', { action, ...extra });
  },
  toggleStageMode() {
    if (!isLeader() && !isHostOnly()) {
      toast('Sahne Modunu yalnızca oda lideri açıp kapatabilir');
      return;
    }
    const nextMode = state.mesh?.voipMode === 'stage' ? 'all' : 'stage';
    if (state.mesh) {
      set({ mesh: { ...state.mesh, voipMode: nextMode } });
      ctx?.layout?.update();
    }
    ctx?.conn?.send('host_action', { action: 'toggle_stage_mode' });
    toast(nextMode === 'stage' ? "🎤 Sahne Modu açıldı — dinleyiciler '✋ Söz İste' ile mikrofon alabilir" : '🎙️ Serbest Ses Modu açıldı');
  },
  raiseHand() {
    if (!ctx?.conn) return;
    const myId = state.clientId;
    const meP = (state.mesh?.participants || []).find((p) => p.id === myId);
    const nextRaised = !Boolean(meP?.handRaised);
    if (state.mesh) {
      const nextParts = (state.mesh.participants || []).map((p) => (p.id === myId ? { ...p, handRaised: nextRaised } : p));
      set({ mesh: { ...state.mesh, participants: nextParts } });
      ctx?.layout?.update();
    }
    ctx.conn.send('hand_raise', { raised: nextRaised });
    toast(nextRaised ? '✋ Söz isteğin oda liderine gönderildi!' : '✋ Söz isteğin geri çekildi');
  },
  toggleStageSpeaker(targetId) {
    if (!targetId || (!isLeader() && !isHostOnly())) return;
    ctx?.conn?.send('host_action', { action: 'toggle_stage_speaker', targetId });
  },
  async ended() {
    const m = state.mesh?.media;
    if (!m) return;
    if (ctx) {
      ctx.userPaused = true;
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
          const qs = new URLSearchParams({ artist: m.artist || '', title: m.songTitle || m.title || '' });
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
  async leave(closeForAll = false) {
    document.body.classList.remove('mesh-minimized');
    try {
      const mNow = state.mesh?.media;
      if (mNow && ctx?.host?.adapter) {
        const curT = ctx.host.adapter.getTime?.() || 0;
        const durT = ctx.host.adapter.getDuration?.() || mNow.duration || 0;
        if (curT > 3) saveWatchProgress(mNow, curT, durT);
      }
    } catch (_) {}
    if (typeof document !== 'undefined' && document.pictureInPictureElement) {
      try { document.exitPictureInPicture().catch(() => {}); } catch (_) {}
    }
    const leavingId = state.mesh?.id || state.route?.params?.id;
    const isCurated = Boolean(state.mesh?.curated);
    const shouldCloseRoom = Boolean(!isCurated && closeForAll && (isHostOnly() || isCreatorSelf() || ctx?.conn?.isCreator));
    if (shouldCloseRoom && leavingId && !isCurated) {
      forgetRoom(leavingId);
    }
    if (shouldCloseRoom && leavingId && ctx?.conn) {
      const cid = ctx.conn.clientId || state.clientId;
      const ctok = ctx.conn.clientToken || '';
      const uname = state.self?.name || '';
      const authTok = state.self?.authToken || state.self?.guestToken || '';
      const closeHeaders = { 'Content-Type': 'application/json', 'X-Watchlivo-Transport': 'http-poll' };
      if (authTok) closeHeaders.Authorization = `Bearer ${authTok}`;
      clearSavedChat(leavingId);
      try { ctx.conn._emitP2p?.({ event: { type: 'room_closed', roomId: leavingId } }); } catch (e) { /* ignore */ }
      try { ctx.conn.close(false, false); } catch (e) { /* ignore */ }
      try {
        await Promise.race([
          fetch(`/api/rooms/${encodeURIComponent(leavingId)}/sync`, {
            method: 'POST',
            keepalive: true,
            headers: closeHeaders,
            body: JSON.stringify({ type: 'close_room', clientId: cid, username: uname, clientToken: ctok || undefined, gracefulClose: true }),
          }),
          new Promise((r) => setTimeout(r, 350)),
        ]);
      } catch (e) { /* ignore */ }
      toast('🚪 Oda kapatıldı');
    } else {
      try { ctx?.conn?.close(true, false); } catch (e) { /* ignore */ }
    }
    leaveMeshView(true);
    window.vortexNavigate('/');
  },
};

export async function enterMesh(app, params) {
  if (typeof window !== 'undefined' && !window.Hls && !(typeof navigator !== 'undefined' && (/iP(hone|ad|od)/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)))) {
    ensureHlsJs().catch(() => {});
  }
  leaveMeshView();
  const targetRoot = (!app || app.id === 'app') ? (document.getElementById('mesh-root') || app) : app;
  if (targetRoot) targetRoot.classList.remove('hidden');
  app = targetRoot;
  let initialCid = null;
  try {
    if (params.r_tok && params.id) {
      sessionStorage.setItem(`vortex_st_${params.id}`, String(params.r_tok));
    }
    if (params.pwd && params.id) {
      sessionStorage.setItem(`vortex_pwd_${params.id}`, String(params.pwd));
    }
    if (params.new === '1' && params.id) {
      const existingCreatorCid = params.cid || sessionStorage.getItem(`vortex_creator_${params.id}`) || sessionStorage.getItem('vortex_cid') || ('h_' + Math.random().toString(36).slice(2, 10));
      sessionStorage.setItem('vortex_cid', existingCreatorCid);
      sessionStorage.setItem(`vortex_creator_${params.id}`, existingCreatorCid);
    }
    if (params.id && location.hash.includes('?')) {
      window.history.replaceState(null, '', `#/mesh/${encodeURIComponent(params.id)}`);
    }
    localStorage.removeItem(`vortex_creator_${params.id}`);
    localStorage.removeItem(`vortex_creator_flag_${params.id}`);
    localStorage.removeItem(`vortex_ct_${params.id}`);
    initialCid = sessionStorage.getItem(`vortex_creator_${params.id}`)
      || sessionStorage.getItem('vortex_cid')
      || null;
    if (initialCid) sessionStorage.setItem('vortex_cid', initialCid);
  } catch (e) { /* ignore */ }
  set({ mesh: null, clientId: initialCid, view: { left: 'Collapsed', right: 'Collapsed' }, connection: 'connecting' });
  const host = new PlayerHost(h('div'), { onEvent: (ev, arg) => onPlayerEvent(ev, arg) });
  const sync = new SyncEngine({
    getMedia: () => state.mesh?.media,
    getAdapter: () => (host.loading ? null : host.adapter),
    isLeader: () => isTimeKeeper(),
    isSolo: () => !state.mesh?.curated && (state.mesh?.participants || []).length <= 1,
    onLeaderSync: (t) => actions.heartbeat(t, true),
    onStatus: (s) => ctx?.layout.syncStatus(s),
  });
  ctx = { host, sync, actions, conn: null, layout: null, voice: null, isNew: params.new === '1' };
  ctx.voice = new Voice({
    send: (type, payload) => ctx.conn?.send(type, payload),
    getSelfId: () => state.clientId,
    getRoomId: () => state.mesh?.id || params.id,
    getSelfProfile: () => state.self,
    onDuckChange: (ducked) => host.setDucked(ducked),
    onMicLevel: (lvl) => ctx?.layout?.setMicLevel?.(lvl),
    onP2pData: (pkt) => ctx?.conn?.onP2pPacket?.(pkt),
  });
  ctx.layout = buildLayout(app, ctx);
  const cachedRoom = getRememberedRoom(params.id);
  const initialSavedChat = loadSavedChat(params.id);
  let savedRoomPwd = params.pwd || '';
  if (!savedRoomPwd && params.id) {
    try { savedRoomPwd = sessionStorage.getItem(`vortex_pwd_${params.id}`) || ''; } catch (_) {}
  }
  ctx.conn = new MeshConnection({
    roomId: params.id, profile: state.self, password: savedRoomPwd, device: deviceLabel(),
    onMessage, onStatus: (s) => { set({ connection: s }); ctx?.layout.update(); },
  });
  if (cachedRoom && cachedRoom.id === params.id) {
    ctx.conn.lastRoom = cachedRoom;
    if (initialSavedChat.length && !(cachedRoom.chat && cachedRoom.chat.length)) {
      cachedRoom.chat = initialSavedChat;
    }
    if (params.new === '1') {
      applyRoom(cachedRoom, { reload: true });
    } else {
      set({ mesh: cachedRoom });
      ctx.seenChatIds = new Set((cachedRoom.chat || []).map((m) => m?.id).filter(Boolean));
      for (const m of (cachedRoom.chat || [])) ctx.layout?.chatAppended?.(m);
      setBackground(thumbFor(cachedRoom.media));
      ctx.layout?.playerEvent?.('loading');
      ctx.layout?.update?.();
      ctx.initFallbackTimer = setTimeout(() => {
        if (ctx && !ctx.initReceived && !ctx.host?.adapter && cachedRoom.media) {
          applyRoom(cachedRoom, { reload: true });
        }
      }, 2800);
    }
  } else {
    if (initialSavedChat.length) {
      ctx.conn.lastRoom = { id: params.id, chat: initialSavedChat };
      ctx.seenChatIds = new Set(initialSavedChat.map((m) => m.id));
      for (const m of initialSavedChat) ctx.layout?.chatAppended?.(m);
    }
    ctx.layout.playerEvent?.('loading');
  }
  sync.start();
  ctx.conn.p2pBroadcast = (pkt) => ctx?.voice?.broadcastP2p?.(pkt);
  if (params.autocall === '1') {
    const localCtx = ctx;
    setTimeout(() => {
      if (!localCtx || ctx !== localCtx) return;
      if (!localCtx.voice?.destroyed && !localCtx.voice?.inCall) localCtx.voice.joinCall({ withMic: true });
    }, 450);
  }
  const localMeshCtx = ctx;
  const meshBgTickListener = () => {
    if (!localMeshCtx || ctx !== localMeshCtx) return;
    localMeshCtx.sync?.tickFromMedia?.();
    localMeshCtx.conn?.nudgeIfDisconnected?.();
  };
  ctx._bgTickListener = meshBgTickListener;
  if (typeof window !== 'undefined') {
    if (!(window.__watchlivoBgTickListeners instanceof Set)) {
      window.__watchlivoBgTickListeners = new Set();
    }
    window.__watchlivoBgTickListeners.add(meshBgTickListener);
    window.__watchlivoBgSyncTick = () => {
      for (const fn of Array.from(window.__watchlivoBgTickListeners || [])) {
        try { fn(); } catch (_) {}
      }
    };
  }
  ctx.progressTimer = setInterval(() => {
    const m = state.mesh?.media;
    const ad = ctx?.host?.adapter;
    if (m && ad && !state.mesh?.curated && !m.live && !ctx.host.loading && !(ad.initialSeekPending > 3) && !(m.isMusic || m.mediaType === 'music')) {
      const rawPos = ad.getTime?.() || 0;
      const expPos = expectedPosition(m) || 0;
      const pos = rawPos > 3 ? rawPos : (expPos > 10 ? expPos : 0);
      const dur = ad.getDuration?.() || m.duration || 0;
      if (pos > 8 && (!ad.isPaused?.() || isTimeKeeper())) {
        saveWatchProgress(m, pos, dur);
      }
    }
  }, 15000);
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
  if (ev === 'ready' || ev === 'loaded' || ev === 'play') {
    if (!isTimeKeeper()) {
      const m = state.mesh?.media;
      if (m && !state.mesh?.curated && !m.live) {
        const liveExp = expectedPosition(m);
        const curTime = ctx.host?.adapter?.getTime?.() || 0;
        const vEl = ctx.host?.adapter?.video;
        if (liveExp >= 0.8 && Math.abs(curTime - liveExp) > 1.5 && ctx.host?.adapter && (!vEl || (!vEl.seeking && vEl.readyState >= 1))) {
          ctx.host.adapter.seek?.(liveExp);
          if (ctx.sync) {
            ctx.sync.lastSeekTarget = liveExp;
            ctx.sync.lastSeekWallAt = performance.now();
            ctx.sync.seekUntil = performance.now() + 1800;
            ctx.sync.deferStartedAt = 0;
          }
        }
        if (ctx.sync) {
          ctx.sync.deferStartedAt = 0;
          ctx.sync.kick(false);
        }
      }
    } else if (!ctx.host.loading) {
      const m = state.mesh?.media;
      const k = mediaKey(m);
      const ad = ctx.host.adapter;
      const vEl = ad?.video;
      if (m && k && ad && !ad.isPaused() && (!vEl || (vEl.readyState >= 2 && !vEl.seeking)) && ctx.anchoredKey !== k) {
        ctx.anchoredKey = k;
        const t = ad.getTime?.() ?? 0;
        actions.heartbeat(t, true);
      }
    }
  }
  if (ev === 'pause' && arg?.userFullscreenPause && isLeader() && !ctx.host.loading && !ctx.userPaused) {
    actions.pause();
  }
  if (ev === 'play' && arg?.native && isLeader() && !ctx.host.loading && ctx.userPaused) {
    actions.play();
  }
  if (ev === 'ended') {
    const endMedia = state.mesh?.media;
    if (endMedia && !state.mesh?.curated && !endMedia.live && !(endMedia.isMusic || endMedia.mediaType === 'music')) {
      const endDur = ctx.host?.adapter?.getDuration?.() || endMedia.duration || 0;
      saveWatchProgress(endMedia, endDur, endDur, { completed: true, forceCloud: true });
    }
    const curKey = mediaKey(state.mesh?.media);
    const playMode = state.mesh?.playMode || 'leader';
    if (ctx.lastEndedKey !== curKey && (isLeader() || isHostOnly() || ['cohost', 'quickplay', 'vote', 'autoplay'].includes(playMode))) {
      ctx.lastEndedKey = curKey;
      actions.ended();
    }
  }
  if (ev === 'select-similar-music' && arg) {
    actions.pickMedia(arg);
    return;
  }
  if (ev === 'autoplay-blocked') ctx.layout.showUnmute(true);
  if (ev === 'unmuted') ctx.layout.showUnmute(false);
  ctx.layout.playerEvent(ev, arg);
}

export function leaveMeshView(explicitLeave = false) {
  const prevMesh = state.mesh;
  if (!ctx) {
    if (explicitLeave && prevMesh?.id && !prevMesh?.curated) {
      forgetRoom(prevMesh.id);
    } else if (prevMesh?.id && _pendingChatRooms.has(prevMesh.id)) {
      flushSavedChat(_pendingChatRooms.get(prevMesh.id));
    }
    if (prevMesh) set({ mesh: null, clientId: null });
    return;
  }
  try {
    const m = prevMesh?.media;
    const ad = ctx?.host?.adapter;
    if (m && ad && !prevMesh?.curated && !m.live && !ctx.host.loading && !(ad.initialSeekPending > 3) && !(m.isMusic || m.mediaType === 'music')) {
      const rawPos = ad.getTime?.() || 0;
      const expPos = expectedPosition(m) || 0;
      const pos = rawPos > 3 ? rawPos : (expPos > 10 ? expPos : 0);
      const dur = ad.getDuration?.() || m.duration || 0;
      if (pos > 8) saveWatchProgress(m, pos, dur, { forceCloud: true });
    }
  } catch (e) { /* ignore */ }
  if (typeof document !== 'undefined' && document.pictureInPictureElement) {
    try { document.exitPictureInPicture().catch(() => {}); } catch (_) {}
  }
  const shouldClose = false;
  if (explicitLeave && prevMesh?.id && !prevMesh?.curated) {
    forgetRoom(prevMesh.id);
  } else if (prevMesh?.id && _pendingChatRooms.has(prevMesh.id)) {
    flushSavedChat(_pendingChatRooms.get(prevMesh.id));
  }
  if (typeof window !== 'undefined' && ctx._bgTickListener && window.__watchlivoBgTickListeners instanceof Set) {
    window.__watchlivoBgTickListeners.delete(ctx._bgTickListener);
  }
  if (ctx.initFallbackTimer) {
    clearTimeout(ctx.initFallbackTimer);
    ctx.initFallbackTimer = null;
  }
  clearInterval(ctx.progressTimer);
  try { ctx.conn?.close(Boolean(explicitLeave), shouldClose); } catch (e) { /* ignore */ }
  try { ctx.sync?.stop?.(); } catch (_) {}
  try { ctx.host?.destroy?.(); } catch (_) {}
  try { ctx.voice?.destroy?.(); } catch (_) {}
  try { closeSharedAudioContext(); } catch (_) {}
  try { ctx.layout?.destroy?.(); } catch (_) {}
  if (typeof window !== 'undefined') {
    if (window.__kinoxVoice) window.__kinoxVoice = null;
    if (window.vortexActions === actions) window.vortexActions = null;
    window.vortexDebug = null;
  }
  ctx = null;
  set({ mesh: null, clientId: null });
  setTimeout(() => pushPresenceHeartbeat({ state: 'online', roomId: '', roomName: '', mediaTitle: '' }).catch(() => {}), 40);
}
