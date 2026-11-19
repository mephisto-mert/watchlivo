// Lobby (Rave Lobby + MeshThumbFC): sectioned grid of live rooms + 7/24 cinema + Friends & Nearby.
import { h, icons, popup, toast } from '../ui.js?v=20261119_v221';
import { avatar, openDmModal } from '../profile.js?v=20261119_v221';
import { getProvider } from '../providers.js?v=20261119_v221';
import { api, qs } from '../api.js?v=20261119_v221';
import {
  state, getFriends, isFriend, getRecentRoomsKey, getRoomSnapshotsKey,
  syncSocialState, searchUsersServer, sendFriendRequest, updateFriendAction, sendRoomInvite, pushPresenceHeartbeat,
} from '../store.js?v=20261119_v221';
import { expectedPosition } from '../sync.js?v=20261119_v221';

const LIVE_BRANDS = {
  'tv-trt1':        { label: 'TRT 1',        sub: 'ULUSAL · DİZİ & MAÇ',    c1: '#e11d48', c2: '#4c0519' },
  'tv-atv':         { label: 'atv',          sub: 'ULUSAL · PRIME TIME',    c1: '#ef4444', c2: '#450a0a' },
  'tv-now-tv':      { label: 'NOW',          sub: 'ULUSAL · DİZİ & HABER',  c1: '#f97316', c2: '#431407' },
  'tv-star-tv':     { label: 'STAR TV',      sub: 'ULUSAL · EĞLENCE & DİZİ',c1: '#eab308', c2: '#422006' },
  'tv-trt-spor':    { label: 'TRT SPOR',     sub: 'CANLI MAÇ & STÜDYO',     c1: '#6366f1', c2: '#064e3b' },
  'tv-a-spor':      { label: 'A SPOR',       sub: 'FUTBOL & KUPA ÖZEL',     c1: '#dc2626', c2: '#3f0d12' },
  'tv-ntv':         { label: 'NTV',          sub: 'HABER & BELGESEL',       c1: '#3b82f6', c2: '#172554' },
  'tv-haberturk':   { label: 'HABERTÜRK',    sub: 'GÜNDEM & TARTIŞMA',      c1: '#e11d48', c2: '#3b071e' },
  'tv-halk-tv':     { label: 'HALK TV',      sub: 'CANLI GÜNDEM · 7/24',    c1: '#06b6d4', c2: '#083344' },
  'tv-trt-haber':   { label: 'TRT HABER',    sub: 'SON DAKİKA · 7/24',      c1: '#f43f5e', c2: '#4c0519' },
  'tv-cnbc-e':      { label: 'CNBC-e',       sub: 'EKONOMİ, FİNANS & DİZİ', c1: '#0ea5e9', c2: '#0c4a6e' },
  'tv-trt-belgesel':{ label: 'BELGESEL',     sub: 'TRT · DOĞA & BİLİM',     c1: '#22c55e', c2: '#052e16' },
  'radyo-power-turk':{ label: 'POWER TÜRK',  sub: 'TÜRKÇE POP · #1 HİT',    c1: '#ec4899', c2: '#500724' },
  'radyo-kral-fm':  { label: 'KRAL FM',      sub: 'ARABESK & FANTEZİ',      c1: '#f59e0b', c2: '#451a03' },
  'radyo-super-fm': { label: 'SÜPER FM',     sub: 'TÜRKÇE POP · 7/24',      c1: '#8b5cf6', c2: '#2e1065' },
  'radyo-metro-fm': { label: 'METRO FM',     sub: 'GLOBAL TOP 40 · DANCE',  c1: '#06b6d4', c2: '#083344' },
  'radyo-power-fm': { label: 'POWER FM',     sub: 'GLOBAL HITS · 256K',     c1: '#ef4444', c2: '#450a0a' },
  'radyo-joy-turk': { label: 'JOY TÜRK',     sub: 'TÜRKÇE AKUSTİK & SLOW',  c1: '#a855f7', c2: '#3b0764' },
  'radyo-slow-turk':{ label: 'SLOW TÜRK',    sub: 'AŞK ŞARKILARI · 7/24',   c1: '#f43f5e', c2: '#4c0519' },
  'radyo-best-fm':  { label: 'BEST FM',      sub: 'CANLI ŞOV & POP',        c1: '#14b8a6', c2: '#042f2e' },
  'radyo-alem-fm':  { label: 'ALEM FM',      sub: 'HİT MÜZİK & EĞLENCE',    c1: '#eab308', c2: '#422006' },
};

const LIVE_BRAND_CARDS = LIVE_BRANDS;

function makeLiveBrandSvg({ label, sub, c1, c2 }) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient><radialGradient id="r" cx="25%" cy="15%" r="75%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="100%" stop-color="#000000" stop-opacity="0.35"/></radialGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect width="320" height="180" fill="url(#r)"/><circle cx="285" cy="35" r="55" fill="#ffffff" fill-opacity="0.06"/><text x="160" y="102" text-anchor="middle" fill="#ffffff" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="900" font-size="29" letter-spacing="1">${esc(label)}</text><text x="160" y="132" text-anchor="middle" fill="rgba(255,255,255,0.88)" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="700" font-size="11.5" letter-spacing="1.5">${esc(sub)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function thumbFor(roomOrMedia, roomId = '') {
  if (!roomOrMedia) return '';
  const isRoomObj = Boolean(roomOrMedia.media || roomOrMedia.curated || LIVE_BRAND_CARDS[roomOrMedia.id]);
  const m = isRoomObj ? (roomOrMedia.media || {}) : roomOrMedia;
  const effRoomId = roomId || (isRoomObj ? roomOrMedia.id : '') || '';
  const brandSpec = LIVE_BRAND_CARDS[m.videoId || effRoomId];
  const primaryImg = m.thumbnail || m.poster || m.backdrop || m.still || '';
  if (brandSpec && (!primaryImg || primaryImg.includes('watchlivo-poster.svg'))) {
    return makeLiveBrandSvg(brandSpec);
  }
  if (primaryImg) return primaryImg;
  if (brandSpec) return makeLiveBrandSvg(brandSpec);
  if (m.provider === 'youtube' && m.videoId) return `https://i.ytimg.com/vi/${m.videoId}/hqdefault.jpg`;
  return m.thumbnail || '/static/watchlivo-poster.svg';
}

function fmtRoomClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0
    ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`;
}

export function tvGlassCard(room, onOpen) {
  const brand = LIVE_BRANDS[room.id] || { label: room.name || 'TV', sub: '7/24 CANLI', c1: '#e11d48', c2: '#4c0519' };
  const isRadio = Boolean(room.media?.isMusic || String(room.id).startsWith('radyo-'));
  const eq = h('div', { class: 'equalizer-bars' }, h('span'), h('span'), h('span'));
  const card = h('div', {
    class: 'tv-glass-card meshthumb curated-room',
    role: 'button',
    tabindex: '0',
    'data-room': room.id,
    style: { '--room-accent': brand.c1 },
    onclick: () => onOpen(card._room || room),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(card._room || room);
      }
    },
  },
    h('div', { class: 'tv-logo-box', style: { background: `linear-gradient(135deg, ${brand.c1}, ${brand.c2})` } }, brand.label),
    h('div', { class: 'tv-info' },
      h('div', { class: 'tv-badge' }, isRadio ? '7/24 RADYO' : '7/24 CANLI', eq),
      h('div', { class: 'tv-name meshthumb-title' }, room.media?.title || room.name || brand.label),
      h('div', { class: 'tv-desc' }, `${brand.sub} · Herkese Açık`)));
  card._room = room;
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const rotateX = (((y - rect.height / 2) / (rect.height / 2)) * -6);
    const rotateY = (((x - rect.width / 2) / (rect.width / 2)) * 6);
    card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
  }, { passive: true });
  card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  return card;
}

export function meshThumb(room, onOpen) {
  const media = room.media || {};
  const prov = getProvider(media.catalogProvider || media.sourceProvider || media.provider);
  const thumb = thumbFor(media, room.id);
  const brand = LIVE_BRANDS[room.id];
  const dur = Number(media.duration || 0);
  const rawViewerCount = Number(room.count ?? (room.participants || []).filter((p) => p.transport !== 'bot').length) || 0;
  const viewerCount = Math.max(0, rawViewerCount);
  const hasHumanViewer = viewerCount > 0 || Boolean(room.curated);
  const rawPos = hasHumanViewer ? expectedPosition(media) : 0;
  const pos = dur > 0 ? (rawPos % dur) : rawPos;
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;
  const users = (room.participants || []).filter((p) => p.transport !== 'bot');
  const privacyLabel = { public: '🌐 Herkese Açık', friends: '👥 Arkadaşlar', private: '🔒 Gizli Oda', hidden: '🔒 Gizli Oda' }[room.privacy || 'public'] || '🌐 Herkese Açık';
  const hasTr = Boolean(
    media.catalogProvider ||
    (media.audioTracks || []).some((a) => /tr|türk/i.test(`${a.lang} ${a.label}`)) ||
    (media.subtitleTracks || []).some((s) => /tr|türk/i.test(`${s.lang} ${s.label}`)) ||
    /dublaj|altyaz/i.test(media.title || '')
  );
  const liveLabel = room.curated ? '🟢 7/24 CANLI' : (room.privacy === 'friends' ? `👥 ${viewerCount} izleyici` : `🔴 ${viewerCount} izleyici`);
  const cleanMediaTitle = (media.title && !/içerik seçilmedi|medya seçilmedi|hazır/i.test(String(media.title))) ? String(media.title).trim() : '';
  const displayTitle = cleanMediaTitle || room.name || 'Watchlivo Odası';
  const hostName = room.creator || users[0]?.name || 'Lider';
  const subLine = room.curated
    ? `${room.name || displayTitle} · 7/24 Kesintisiz`
    : `👤 ${hostName} · ${privacyLabel}`;

  const card = h('div', {
    class: `meshthumb ${room.curated ? 'curated-room' : ''} ${room.privacy === 'friends' ? 'friends-only-room' : ''}`,
    role: 'button',
    tabindex: '0',
    'data-room': room.id,
    'data-privacy': room.privacy || 'public',
    style: brand ? { '--room-accent': brand.c1 } : undefined,
    onclick: () => onOpen(card._room || room),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(card._room || room);
      }
    },
  },
    h('div', { class: 'meshthumb-img' },
      thumb ? h('img', { src: thumb, alt: displayTitle, decoding: 'async', onerror: (e) => { e.target.style.display = 'none'; } }) : null,
      h('span', { class: `meshthumb-live-badge ${room.curated ? 'is-247' : ''} ${room.privacy === 'friends' ? 'is-friends' : ''}` }, liveLabel),
      (!room.curated && prov?.logo) ? h('img', { class: 'meshthumb-prov', src: prov.logo, alt: prov.name }) : null,
      dur > 0 ? h('span', { class: 'meshthumb-time' }, `${fmtRoomClock(pos)} / ${fmtRoomClock(dur)}`) : null,
      h('div', { class: 'play-hover', html: icons.play })),
    h('div', { class: 'meshthumb-body' },
      h('div', { class: 'meshthumb-title', title: displayTitle }, displayTitle),
      h('div', { class: 'meshthumb-sub', title: subLine }, subLine),
      h('div', { class: 'meshthumb-meta-row' },
        h('div', { class: 'meshthumb-users' },
          users.slice(0, 5).map((u) => avatar(u, 20)),
          viewerCount > 5 ? h('span', { class: 'more' }, `+${viewerCount - 5}`) : null,
          h('span', { class: 'more meshthumb-join-hint' }, 'Katıl →')),
        hasTr ? h('span', { class: 'meshthumb-lang-badge' }, '🇹🇷 TR') : null),
      dur > 0 ? h('div', { class: 'meshthumb-progress' }, h('div', { style: { width: `${pct}%` } })) : null),
    room.hasPassword ? h('span', { class: 'meshthumb-lock', html: icons.lock }) : null);
  card._room = room;
  return card;
}

export function rememberRoom(room) {
  try {
    if (!room?.id) return;
    const recentKey = getRecentRoomsKey();
    const snapsKey = getRoomSnapshotsKey();
    localStorage.removeItem(`vortex_st_${room.id}`);
    localStorage.removeItem(`vortex_room_${room.id}`);
    if (room.syncToken) {
      sessionStorage.setItem(`vortex_st_${room.id}`, room.syncToken);
    }
    const hasPlayableMedia = Boolean(room.media && (room.media.url || room.media.videoId || room.media.tmdbId));
    if (hasPlayableMedia || (room.name && !room.media)) {
      let cachedMedia = room.media;
      if (room.media && hasPlayableMedia) {
        const nowEpoch = Date.now() / 1000;
        const rawLive = Number(room.media.liveTime);
        const rawAnchorPos = Number(room.media.meshStatePosition ?? room.media.currentTime ?? 0);
        const rawAnchorTime = Number(room.media.meshStateTime ?? room.media.updatedAt ?? 0);
        const anchorTimeSec = rawAnchorTime > 1e11 ? rawAnchorTime / 1000 : rawAnchorTime;
        const srvNow = Number(room.serverNow ?? room.media.serverNow ?? 0);
        const hasValidAnchor = Number.isFinite(anchorTimeSec) && anchorTimeSec > 1000000000;
        const computedLive = Number.isFinite(rawLive) && rawLive >= 0
          ? rawLive
          : (Number.isFinite(rawAnchorPos) && rawAnchorPos > 0 ? rawAnchorPos : 0);
        cachedMedia = {
          ...room.media,
          currentTime: hasValidAnchor ? Math.max(0, rawAnchorPos) : Math.max(0, computedLive),
          updatedAt: hasValidAnchor ? anchorTimeSec : (srvNow > 1000000000 ? srvNow : nowEpoch),
          meshStatePosition: hasValidAnchor ? Math.max(0, rawAnchorPos) : Math.max(0, computedLive),
          meshStateTime: hasValidAnchor ? anchorTimeSec : (srvNow > 1000000000 ? srvNow : nowEpoch),
          meshStateStatus: room.media.meshStateStatus || (room.media.playing === false ? 'PAUSED' : 'PLAYING'),
          meshStatePlaybackSpeed: Number(room.media.meshStatePlaybackSpeed ?? room.media.rate ?? 1) || 1,
        };
      }
      const cleanSnap = {
        ...room,
        chat: [],
        polls: [],
        syncToken: undefined,
        serverNow: undefined,
        media: cachedMedia ? { ...cachedMedia, serverNow: undefined } : cachedMedia,
      };
      sessionStorage.setItem(`vortex_room_${room.id}`, JSON.stringify(cleanSnap));
      if (!room.curated) {
        const snaps = JSON.parse(localStorage.getItem(snapsKey) || '{}');
        snaps[room.id] = { id: room.id, name: room.name || '', media: cleanSnap.media ? { title: cleanSnap.media.title || '' } : null };
        localStorage.setItem(snapsKey, JSON.stringify(snaps));
      }
    }
    const list = JSON.parse(localStorage.getItem(recentKey) || '[]').filter((r) => r !== room.id);
    list.unshift(room.id);
    localStorage.setItem(recentKey, JSON.stringify(list.slice(0, 12)));
  } catch (e) { /* ignore */ }
}
export function forgetRoom(roomId) {
  if (!roomId) return;
  try {
    sessionStorage.removeItem(`vortex_room_${roomId}`);
    sessionStorage.removeItem(`vortex_st_${roomId}`);
    sessionStorage.removeItem(`vortex_ct_${roomId}`);
    sessionStorage.removeItem(`vortex_creator_${roomId}`);
    localStorage.removeItem(`vortex_st_${roomId}`);
    localStorage.removeItem(`vortex_room_${roomId}`);
    localStorage.removeItem(`vortex_creator_flag_${roomId}`);
    const recentKey = getRecentRoomsKey();
    const snapsKey = getRoomSnapshotsKey();
    const list = JSON.parse(localStorage.getItem(recentKey) || '[]').filter((r) => r !== roomId);
    localStorage.setItem(recentKey, JSON.stringify(list));
    const snaps = JSON.parse(localStorage.getItem(snapsKey) || '{}');
    if (snaps && snaps[roomId]) {
      delete snaps[roomId];
      localStorage.setItem(snapsKey, JSON.stringify(snaps));
    }
  } catch (e) { /* ignore */ }
}
export function getRememberedRoom(roomId) {
  if (!roomId) return null;
  try {
    localStorage.removeItem(`vortex_st_${roomId}`);
    localStorage.removeItem(`vortex_room_${roomId}`);
    const raw = sessionStorage.getItem(`vortex_room_${roomId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.media && !Number.isFinite(Number(parsed.media.currentTime))) parsed.media.currentTime = 0;
    if (parsed) parsed.chat = [];
    return parsed;
  } catch (e) {
    return null;
  }
}
const recentIds = () => { try { return JSON.parse(localStorage.getItem(getRecentRoomsKey()) || '[]'); } catch (e) { return []; } };

let lastLobbyRooms = [];

export async function fetchRooms() {
  const res = await api(`/api/rooms?${qs({ user: state.self?.name })}`, { timeout: 8000 });
  lastLobbyRooms = res.rooms || [];
  return lastLobbyRooms;
}

export function openFriendsManagerModal(onRefresh, initialTab = 'friends') {
  const box = h('div', { class: 'friends-manager-modal wl-rave-friends-hub', style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '100%' } });
  let activeTab = initialTab;
  let searchQuery = '';
  let searchResults = [];
  let searching = false;
  let searchTimer = null;
  const sentRoomInvites = new Map();
  let modalRef = null;
  let liveTimer = null;

  const findFriendActiveRoom = (f) => {
    if (!f || f.hideWatching) return null;
    const wId = f.watchingRoom?.roomId || f.roomId || '';
    if (wId) {
      const liveMatch = (lastLobbyRooms || []).find((r) => r && r.id === wId);
      if (liveMatch) return liveMatch;
    }
    if (f.watchingRoom?.roomId) {
      return { id: f.watchingRoom.roomId, name: f.watchingRoom.roomName, media: { title: f.watchingRoom.mediaTitle, poster: f.watchingRoom.mediaPoster } };
    }
    if (f.roomId) {
      return { id: f.roomId, name: f.roomName || 'Canlı Oda', media: { title: f.mediaTitle || '', poster: f.mediaPoster || '' } };
    }
    const fUid = String(f.uid || '').trim();
    if (state.social?.loaded && fUid) return null;
    const fh = String(f.handle || '').replace(/^@+/, '').toLowerCase();
    const fn = String(f.name || '').toLowerCase();
    return (lastLobbyRooms || []).find((r) => !r.curated && !r.hasPassword && (!r.privacy || r.privacy === 'public') && (
      (r.participants || []).some((p) =>
        (!p.hideWatching) && (
          (fUid && p.uid && p.uid === fUid) ||
          (fh && p.handle && String(p.handle).replace(/^@+/, '').toLowerCase() === fh) ||
          (!fUid && fn && String(p.name || '').toLowerCase() === fn)
        )
      ) ||
      (!fUid && fn && String(r.creator || '').toLowerCase() === fn)
    ));
  };

  const renderFriendRow = (f) => {
    const fUid = f.uid || f.id || '';
    const activeRoom = findFriendActiveRoom(f);
    const inSameRoom = Boolean(
      state.mesh?.id && (
        f.roomId === state.mesh.id ||
        activeRoom?.id === state.mesh.id ||
        (state.mesh.participants || []).some((p) =>
          (p.uid && f.uid && p.uid === f.uid) ||
          (p.handle && f.handle && String(p.handle).replace(/^@+/, '').toLowerCase() === String(f.handle).replace(/^@+/, '').toLowerCase())
        )
      )
    );
    const inMyRoom = Boolean(state.mesh?.id && !inSameRoom);
    const invId = sentRoomInvites.get(fUid);
    const pState = f.presenceState || (f.online ? 'online' : 'offline');
    const dotClass = `wl-pres-dot is-${pState}`;
    return h('div', { class: `wl-friend-row is-${pState}` },
      h('div', { class: 'wl-friend-main' },
        h('div', { class: 'wl-friend-avatar-wrap' },
          avatar(f, 36, { online: Boolean(f.online) }),
          h('span', { class: dotClass, title: f.status || '' })),
        h('div', { class: 'wl-friend-info' },
          h('div', { class: 'wl-friend-title-line' },
            h('b', {}, f.name || 'İzleyici'),
            f.handle ? h('span', { class: 'wl-friend-handle' }, f.handle) : null,
            h('button', {
              type: 'button',
              class: `wl-best-star ${f.bestFriend ? 'on' : ''}`,
              title: f.bestFriend ? 'Yakın arkadaşlardan çıkar' : 'Yakın arkadaş olarak işaretle',
              onclick: async () => {
                const r = await updateFriendAction('toggle_best', { targetUid: fUid });
                if (!r?.ok) { toast(r?.error || 'İşlem tamamlanamadı.'); return; }
                renderModalContent();
              },
            }, f.bestFriend ? '⭐' : '☆')),
          h('div', { class: `wl-friend-status is-${pState}` },
            inSameRoom ? '✅ Şu an bu odada' : (activeRoom ? `🎬 ${activeRoom.media?.title || activeRoom.name} izliyor` : (f.status || (f.online ? '🟢 Çevrimiçi' : '⚫ Çevrimdışı')))))),
      h('div', { class: 'wl-friend-actions' },
        inSameRoom
          ? h('span', { class: 'wl-friend-pill ok' }, '✅ Odada')
          : (activeRoom ? h('button', {
              type: 'button',
              class: 'btn sm primary',
              onclick: () => {
                modalRef?.close?.();
                rememberRoom(activeRoom);
                window.vortexNavigate?.(`/mesh/${encodeURIComponent(activeRoom.id)}`);
              },
            }, '▶ Katıl') : null),
        inMyRoom ? h('button', {
          type: 'button',
          class: `btn sm ${invId ? '' : 'primary'}`,
          onclick: async () => {
            if (invId) {
              const r = await sendRoomInvite({ action: 'cancel', inviteId: invId, targetUid: fUid, roomId: state.mesh?.id });
              if (!r?.ok) { toast(r?.error || 'Davet iptal edilemedi.'); return; }
              sentRoomInvites.delete(fUid);
              toast('Davet geri çekildi');
            } else {
              const res = await sendRoomInvite({ action: 'send', targetUid: fUid });
              if (res?.ok && (res.invites?.[0]?.id || Number(res.sentCount ?? 0) > 0)) {
                sentRoomInvites.set(fUid, res.invites?.[0]?.id || 'sent');
                toast(`📩 ${f.name} odaya davet edildi!`);
              } else {
                toast(res?.error || 'Davet gönderilemedi');
              }
            }
            renderModalContent();
          },
        }, invId ? '✓ Davetli · İptal' : '📩 Davet Et') : null,
        h('button', {
          type: 'button',
          class: 'btn sm',
          title: 'Özel Mesaj (DM)',
          onclick: () => {
            modalRef?.close?.();
            openDmModal(f.uid);
          },
        }, '💬'),
        h('button', {
          type: 'button',
          class: 'btn sm ghost',
          title: 'El Salla',
          onclick: async () => {
            const r = await sendRoomInvite({ action: 'poke', targetUid: f.uid });
            if (r?.ok) toast(`👋 ${f.name} kişisine el salladın!`);
            else toast(r?.error || 'İşlem tamamlanamadı.');
          },
        }, '👋'),
        h('button', {
          type: 'button',
          class: 'btn sm ghost',
          title: 'Kullanıcıyı Engelle',
          'aria-label': 'Engelle',
          onclick: async () => {
            const r = await updateFriendAction('block', { targetUid: f.uid || fUid, targetName: f.name });
            if (!r?.ok) { toast(r?.error || 'Kullanıcı engellenemedi.'); return; }
            toast(`🚫 ${f.name} engellendi`);
            renderModalContent();
            onRefresh?.();
          },
        }, '🚫'),
        h('button', {
          type: 'button',
          class: 'btn sm ghost',
          title: 'Arkadaşlıktan çıkar',
          onclick: async () => {
            const r = await updateFriendAction('remove', { targetUid: f.uid });
            if (!r?.ok) { toast(r?.error || 'Arkadaş çıkarılamadı.'); return; }
            toast(`${f.name} arkadaş listesinden çıkarıldı`);
            renderModalContent();
            onRefresh?.();
          },
        }, '×')));
  };

  const renderModalContent = () => {
    const soc = state.social || {};
    const friends = getFriends();
    const isFriendLive = (f) => Boolean(f.online || f.roomId || findFriendActiveRoom(f));
    const onlineFriends = friends.filter(isFriendLive);
    const offlineFriends = friends.filter((f) => !isFriendLive(f));
    const inReqs = soc.requests || [];
    const outReqs = soc.outgoingRequests || [];
    const blocked = soc.blocked || [];
    const priv = soc.privacy || { presenceVisibility: 'friends', hideWatching: false, allowInvites: 'friends' };

    const tabBar = h('div', { class: 'wl-social-tabs' },
      [
        ['friends', `👥 Arkadaşlar (${friends.length})`, onlineFriends.length ? `🟢 ${onlineFriends.length}` : ''],
        ['requests', '🔔 İstekler', inReqs.length ? String(inReqs.length) : ''],
        ['search', '🔎 Kullanıcı Ara & Ekle', ''],
        ['privacy', '🛡️ Gizlilik', ''],
      ].map(([id, lbl, badgeTxt]) => h('button', {
        type: 'button',
        class: `wl-social-tab ${activeTab === id ? 'on' : ''}`,
        onclick: () => { activeTab = id; renderModalContent(); },
      }, h('span', {}, lbl), badgeTxt ? h('span', { class: 'wl-social-tab-badge' }, badgeTxt) : null)));

    let bodyNode = null;
    if (activeTab === 'friends') {
      bodyNode = h('div', { class: 'wl-social-pane' },
        state.mesh?.id && onlineFriends.length ? h('button', {
          type: 'button',
          class: 'btn primary sm',
          style: { width: '100%', justifyContent: 'center' },
          onclick: async () => {
            const r = await sendRoomInvite({ action: 'invite_all_online' });
            if (!r?.ok) { toast(r?.error || 'Davet gönderilemedi.'); return; }
            toast(r?.sentCount ? `📩 ${r.sentCount} çevrimiçi arkadaşın odaya çağrıldı!` : 'Çevrimiçi arkadaş bulunamadı');
          },
        }, `🔔 Tüm Çevrimiçi Arkadaşları Odaya Çağır (${onlineFriends.length})`) : null,
        friends.length ? h('div', { class: 'wl-friends-sections' },
          onlineFriends.length ? h('div', { class: 'wl-friends-sec' },
            h('div', { class: 'wl-friends-sec-head' }, `🟢 ÇEVRİMİÇİ & ODADA (${onlineFriends.length})`),
            ...onlineFriends.map(renderFriendRow)) : null,
          offlineFriends.length ? h('div', { class: 'wl-friends-sec' },
            h('div', { class: 'wl-friends-sec-head' }, `⚫ ÇEVRİMDIŞI (${offlineFriends.length})`),
            ...offlineFriends.map(renderFriendRow)) : null,
        ) : h('div', { class: 'lobby-empty', style: { padding: '20px 14px', fontSize: '.83rem' } },
          'Henüz onaylı arkadaşın yok. ',
          h('button', { type: 'button', class: 'btn sm primary', style: { marginTop: '10px' }, onclick: () => { activeTab = 'search'; renderModalContent(); } }, '🔎 Kullanıcı Adıyla İlk Arkadaşını Ekle')));
    } else if (activeTab === 'requests') {
      bodyNode = h('div', { class: 'wl-social-pane' },
        h('div', { class: 'wl-friends-sec-head' }, `📥 GELEN ARKADAŞLIK İSTEKLERİ (${inReqs.length})`),
        inReqs.length ? h('div', { class: 'wl-friends-sec' }, ...inReqs.map((req) => h('div', { class: 'wl-friend-row' },
          h('div', { class: 'wl-friend-main' },
            avatar({ name: req.fromName, color: req.color, avatarUrl: req.avatarUrl }, 36),
            h('div', { class: 'wl-friend-info' },
              h('b', {}, req.fromName || 'İzleyici'),
              h('div', { class: 'wl-friend-handle' }, `${req.fromHandle || ''} · Onay bekliyor`))),
          h('div', { class: 'wl-friend-actions' },
            h('button', {
              type: 'button', class: 'btn sm primary',
              onclick: async () => {
                const r = await updateFriendAction('accept', { requestId: req.id, targetUid: req.fromUid });
                if (!r?.ok) { toast(r?.error || 'İstek kabul edilemedi.'); return; }
                toast(`🎉 ${req.fromName} ile artık arkadaşsınız!`);
                if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vortex_friends_updated'));
                renderModalContent();
                onRefresh?.();
              },
            }, '✓ Kabul Et'),
            h('button', {
              type: 'button', class: 'btn sm ghost',
              onclick: async () => {
                const r = await updateFriendAction('decline', { requestId: req.id, targetUid: req.fromUid });
                if (!r?.ok) { toast(r?.error || 'İstek reddedilemedi.'); return; }
                toast('İstek reddedildi');
                renderModalContent();
              },
            }, '✕ Reddet'))))) : h('div', { class: 'dim', style: { fontSize: '.8rem', padding: '6px 2px' } }, 'Bekleyen gelen arkadaşlık isteği yok.'),
        h('div', { class: 'wl-friends-sec-head', style: { marginTop: '10px' } }, `📤 GÖNDERİLEN İSTEKLER (${outReqs.length})`),
        outReqs.length ? h('div', { class: 'wl-friends-sec' }, ...outReqs.map((req) => h('div', { class: 'wl-friend-row' },
          h('div', { class: 'wl-friend-main' },
            avatar({ name: req.toName, color: req.color, avatarUrl: req.avatarUrl }, 34),
            h('div', { class: 'wl-friend-info' },
              h('b', {}, req.toName || 'İzleyici'),
              h('div', { class: 'wl-friend-handle' }, `${req.toHandle || ''} · ⏳ Karşı tarafın onayı bekleniyor`))),
          h('button', {
            type: 'button', class: 'btn sm ghost',
            onclick: async () => {
              const r = await updateFriendAction('cancel', { requestId: req.id, targetUid: req.toUid });
              if (!r?.ok) { toast(r?.error || 'İstek iptal edilemedi.'); return; }
              toast('Gönderilen istek iptal edildi');
              renderModalContent();
            },
          }, 'İptal Et')))) : h('div', { class: 'dim', style: { fontSize: '.8rem', padding: '6px 2px' } }, 'Onay bekleyen gönderilmiş isteğin yok.'));
    } else if (activeTab === 'search') {
      const sInp = h('input', {
        class: 'input', id: 'friend-name-input', value: searchQuery,
        placeholder: '@kullaniciadi, isim veya e-posta yaz...',
        style: { flex: '1' },
      });
      const triggerSendReq = async (ident, extra = {}) => {
        const cleanIdent = String(ident || sInp.value || '').trim();
        if (!cleanIdent) { toast('Lütfen kullanıcı adı (@handle) veya e-posta girin'); sInp.focus(); return; }
        const r = await sendFriendRequest(cleanIdent, extra);
        if (!r?.ok) { toast(`⚠️ ${r?.error || 'Kullanıcı bulunamadı'}`); return; }
        if (r.alreadyFriend) toast('Bu kullanıcı zaten arkadaş listende ✓');
        else if (r.mutualAccepted) toast('🎉 Karşılıklı istek onaylandı, artık arkadaşsınız!');
        else toast(`📨 ${cleanIdent} hesabına arkadaşlık isteği gönderildi (onay bekleniyor)`);
        if (searchQuery) searchResults = await searchUsersServer(searchQuery);
        renderModalContent();
        onRefresh?.();
      };
      sInp.addEventListener('input', () => {
        searchQuery = sInp.value.trim();
        clearTimeout(searchTimer);
        if (searchQuery.length < 2) { searchResults = []; return; }
        searching = true;
        searchTimer = setTimeout(async () => {
          searchResults = await searchUsersServer(searchQuery);
          searching = false;
          renderModalContent();
          const newInp = box.querySelector('#friend-name-input');
          if (newInp) { newInp.focus(); newInp.setSelectionRange(searchQuery.length, searchQuery.length); }
        }, 260);
      });
      sInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerSendReq(sInp.value); } });
      bodyNode = h('div', { class: 'wl-social-pane' },
        h('div', { class: 'dim', style: { fontSize: '.8rem' } }, 'Arkadaş eklediğin kişiye onay isteği gider. Onaylandığında gerçek zamanlı mesajlaşabilir, çevrimiçi durumunu görebilir ve odaya davet edebilirsin.'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          sInp,
          h('button', { type: 'button', class: 'btn primary', id: 'btn-confirm-add-friend', onclick: () => triggerSendReq(sInp.value) }, '+ İstek Gönder')),
        searching ? h('div', { class: 'dim', style: { fontSize: '.8rem' } }, '🔎 Aranıyor...') : null,
        searchResults.length ? h('div', { class: 'wl-friends-sec' },
          ...searchResults.map((uCard) => {
            const st = uCard.friendshipState || 'NONE';
            return h('div', { class: 'wl-friend-row' },
              h('div', { class: 'wl-friend-main' },
                avatar(uCard, 36, { online: uCard.online }),
                h('div', { class: 'wl-friend-info' },
                  h('div', { class: 'wl-friend-title-line' }, h('b', {}, uCard.name), h('span', { class: 'wl-friend-handle' }, uCard.handle)),
                  h('div', { class: `wl-friend-status is-${uCard.presenceState || 'offline'}` }, uCard.status || ''))),
              st === 'FRIENDS' ? h('span', { class: 'wl-friend-pill ok' }, '✓ Arkadaş')
                : st === 'OUTGOING_PENDING' ? h('button', { type: 'button', class: 'btn sm ghost', onclick: async () => { const r = await updateFriendAction('cancel', { targetUid: uCard.uid }); if (!r?.ok) { toast(r?.error || 'İşlem tamamlanamadı.'); return; } searchResults = await searchUsersServer(searchQuery); renderModalContent(); } }, '⏳ İstek Gönderildi · İptal')
                : st === 'INCOMING_PENDING' ? h('button', { type: 'button', class: 'btn sm primary', onclick: async () => { const r = await updateFriendAction('accept', { targetUid: uCard.uid }); if (!r?.ok) { toast(r?.error || 'İstek kabul edilemedi.'); return; } toast(`🎉 ${uCard.name} ile artık arkadaşsınız!`); if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vortex_friends_updated')); searchResults = await searchUsersServer(searchQuery); renderModalContent(); } }, '✓ Seni Ekledi · Onayla')
                : h('button', { type: 'button', class: 'btn sm primary', onclick: () => triggerSendReq(uCard.handle || uCard.name, { targetUid: uCard.uid }) }, '+ Arkadaş Ekle'));
          })) : (searchQuery.length >= 2 && !searching ? h('div', { class: 'dim', style: { fontSize: '.8rem', padding: '8px 2px' } }, searchResults?._error || `"${searchQuery}" ile eşleşen kayıtlı kullanıcı bulunamadı.`) : null));
    } else {
      bodyNode = h('div', { class: 'wl-social-pane' },
        h('div', { class: 'wl-friends-sec-head' }, '🟢 ÇEVRİMİÇİ DURUM GÖRÜNÜRLÜĞÜ'),
        h('div', { class: 'seg' }, [
          ['everyone', 'Herkese Açık', 'Tüm kullanıcılar görür'],
          ['friends', 'Yalnızca Arkadaşlar', 'Onaylı arkadaşların görür'],
          ['nobody', 'Gizli (Çevrimdışı)', 'Kimse çevrimiçi görmez'],
        ].map(([k, lbl, dsc]) => h('button', {
          type: 'button', class: priv.presenceVisibility === k ? 'on' : '',
          onclick: async () => {
            const r = await updateFriendAction('privacy', { presenceVisibility: k });
            if (!r?.ok) { toast(r?.error || 'Gizlilik ayarı güncellenemedi.'); return; }
            await pushPresenceHeartbeat({ visibility: k });
            renderModalContent();
          },
        }, lbl, h('small', {}, dsc)))),
        h('div', { class: 'wl-privacy-toggle-row' },
          h('span', {}, '🎬 Ne İzlediğimi ve Hangi Odada Olduğumu Gizle'),
          h('button', {
            type: 'button', class: `btn sm ${priv.hideWatching ? 'primary' : ''}`,
            onclick: async () => {
              const next = !priv.hideWatching;
              const r = await updateFriendAction('privacy', { hideWatching: next });
              if (!r?.ok) { toast(r?.error || 'Gizlilik ayarı güncellenemedi.'); return; }
              await pushPresenceHeartbeat({ hideWatching: next });
              renderModalContent();
            },
          }, priv.hideWatching ? 'Gizli ✓' : 'Açık (Arkadaşlar Görür)')),
        blocked.length ? h('div', { class: 'wl-friends-sec' },
          h('div', { class: 'wl-friends-sec-head' }, `🚫 ENGELLENENLER (${blocked.length})`),
          ...blocked.map((b) => h('div', { class: 'wl-friend-row' },
            h('span', {}, b.name || b.uid),
            h('button', { type: 'button', class: 'btn sm', onclick: async () => { const r = await updateFriendAction('unblock', { targetUid: b.uid }); if (!r?.ok) { toast(r?.error || 'Engel kaldırılamadı.'); return; } renderModalContent(); } }, 'Engeli Kaldır')))) : null);
    }

    const wasInpFocused = typeof document !== 'undefined' && document.activeElement?.id === 'friend-name-input';
    const inpStart = wasInpFocused ? document.activeElement.selectionStart : null;
    const inpEnd = wasInpFocused ? document.activeElement.selectionEnd : null;
    box.replaceChildren(tabBar, bodyNode);
    if (wasInpFocused) {
      const nextInp = box.querySelector('#friend-name-input');
      if (nextInp) {
        nextInp.focus({ preventScroll: true });
        try { nextInp.setSelectionRange(inpStart, inpEnd); } catch (_) {}
      }
    }
  };

  renderModalContent();
  syncSocialState(true).then(() => { if (box.isConnected) renderModalContent(); });
  liveTimer = setInterval(() => {
    if (!box.isConnected) { clearInterval(liveTimer); return; }
    syncSocialState(true).then(() => { if (box.isConnected && activeTab !== 'search') renderModalContent(); });
  }, 6000);

  modalRef = popup({
    title: '👥 Arkadaşlarım, İstekler & Çevrimiçi Durum',
    content: box,
    wide: true,
    onClose: () => clearInterval(liveTimer),
    options: [{ label: 'Kapat', onClick: () => clearInterval(liveTimer) }],
  });
  return modalRef;
}

export function openRoomInviteModal() {
  return openFriendsManagerModal(null, 'friends');
}
if (typeof window !== 'undefined') {
  window.vortexOpenFriendsModal = openFriendsManagerModal;
}

export function renderHomeFriendsStrip(onOpenRoom) {
  const wrap = h('section', { class: 'wl-home-friends-strip HomeHeader__home-header-friend-list-container', id: 'wl-home-friends-strip' });
  const drawStrip = () => {
    const soc = state.social || {};
    const friends = getFriends();
    const reqCnt = Number(soc.requestCount || soc.requests?.length || 0);
    const unrCnt = Number(soc.totalUnread || 0);
    wrap.replaceChildren(
      h('div', { class: 'wl-hfs-head' },
        h('div', { class: 'wl-hfs-title' },
          h('span', { class: 'wl-pres-dot is-online' }),
          h('b', {}, 'Arkadaşlar & Çevrimiçi'),
          friends.length ? h('span', { class: 'wl-hfs-count' }, `${friends.filter((f) => f.online).length}/${friends.length} aktif`) : null),
        h('div', { class: 'wl-hfs-actions' },
          reqCnt > 0 ? h('button', {
            type: 'button', class: 'wl-hfs-pill req-alert',
            onclick: () => openFriendsManagerModal(null, 'requests'),
          }, `🔔 ${reqCnt} Onay Bekleyen İstek`) : null,
          unrCnt > 0 ? h('button', {
            type: 'button', class: 'wl-hfs-pill dm-alert',
            onclick: () => openDmModal(),
          }, `💬 ${unrCnt} Okunmamış Mesaj`) : null,
          h('button', {
            type: 'button', class: 'wl-hfs-pill add-btn',
            onclick: () => openFriendsManagerModal(null, 'search'),
          }, '➕ Arkadaş Ekle'),
          h('button', {
            type: 'button', class: 'wl-hfs-pill',
            onclick: () => openDmModal(),
          }, '💬 Mesajlar'))),
      friends.length ? h('div', { class: 'wl-hfs-rail' },
        ...friends.map((f) => {
          const pState = f.presenceState || (f.online ? 'online' : 'offline');
          const wRoom = f.hideWatching ? null : f.watchingRoom;
          const fRoomId = wRoom?.roomId || f.roomId || '';
          const inCurrentRoom = Boolean(state.mesh?.id && (f.roomId === state.mesh.id || fRoomId === state.mesh.id));
          return h('div', {
            class: `wl-hfs-chip is-${pState}`,
            onclick: () => {
              if (inCurrentRoom) return;
              if (fRoomId && onOpenRoom) {
                const liveMatch = (lastLobbyRooms || []).find((r) => r && r.id === fRoomId);
                onOpenRoom(liveMatch || { id: fRoomId, name: wRoom?.roomName || f.roomName });
              } else {
                openDmModal(f.uid);
              }
            },
          },
            h('div', { class: 'wl-friend-avatar-wrap' },
              avatar(f, 34, { online: Boolean(f.online) }),
              h('span', { class: `wl-pres-dot is-${pState}` })),
            h('div', { class: 'wl-hfs-chip-meta' },
              h('b', {}, f.name),
              h('span', {}, inCurrentRoom ? '✅ Odada' : (wRoom ? `🎬 ${wRoom.mediaTitle || wRoom.roomName}` : (f.online ? (pState === 'idle' ? '🌙 Uzakta' : '🟢 Çevrimiçi') : (f.status || '⚫ Çevrimdışı'))))),
            inCurrentRoom
              ? h('span', { class: 'wl-hfs-join-tag' }, '✅ Odada')
              : (fRoomId ? h('span', { class: 'wl-hfs-join-tag' }, '▶ Katıl') : null));
        })) : h('div', { class: 'wl-hfs-empty' },
        'Arkadaşlarını @kullaniciadi ile ekle; çevrimiçi olduklarında gör, mesajlaş ve tek tıkla odalarına davet et.'));
  };
  drawStrip();
  wrap._refresh = drawStrip;
  return wrap;
}

export const openAddFriendDialog = openFriendsManagerModal;
if (typeof window !== 'undefined') {
  window.vortexOpenFriendsModal = openFriendsManagerModal;
  window.vortexOpenInviteModal = openRoomInviteModal;
}

const LIVE_BRAND_ORDER = Object.keys(LIVE_BRANDS);
function sortByBrandOrder(list) {
  return [...list].sort((a, b) => {
    const ia = LIVE_BRAND_ORDER.indexOf(a.id);
    const ib = LIVE_BRAND_ORDER.indexOf(b.id);
    const oa = ia >= 0 ? ia : 999;
    const ob = ib >= 0 ? ib : 999;
    return oa - ob || String(a.id).localeCompare(String(b.id));
  });
}

// Rave lobby sections: Public FIRST (1:1 rave.io) · Friends · Nearby · Live TV & Radio
export function renderLobbySections(container, rooms, onOpen, { filter = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const match = (r) => !q || `${r.name || ''} ${r.media?.title || ''} ${r.creator || ''}`.toLowerCase().includes(q);
  const mergedRooms = Array.isArray(rooms) ? [...rooms] : [];
  if (state.mesh?.id && !state.mesh.curated && state.mesh.privacy !== 'private' && state.mesh.privacy !== 'hidden') {
    if (!mergedRooms.some((r) => r.id === state.mesh.id)) {
      mergedRooms.unshift(state.mesh);
    }
  }
  const visible = mergedRooms.filter((r) => match(r));
  const recents = recentIds();
  if (mergedRooms.length > 0 && recents.length > 0) {
    const liveIds = new Set(mergedRooms.map((r) => r.id));
    const validRecents = recents.filter((id) => liveIds.has(id) || id === state.mesh?.id);
    if (validRecents.length !== recents.length) {
      try { localStorage.setItem(getRecentRoomsKey(), JSON.stringify(validRecents)); } catch (e) { /* ignore */ }
    }
  }
  const friends = getFriends();
  const myName = (state.self?.name || '').trim().toLowerCase();

  const publicRooms = visible
    .filter((r) => !r.curated && (r.privacy === 'public' || !r.privacy))
    .sort((a, b) => ((b.count || 0) - (a.count || 0)) || String(a.id).localeCompare(String(b.id)));

  const friendRooms = visible.filter((r) =>
    !r.curated && (
      r.privacy === 'friends' && (
        isFriend(r.creator) ||
        (r.participants || []).some((p) => isFriend(p)) ||
        (myName && String(r.creator || '').trim().toLowerCase() === myName) ||
        recents.includes(r.id)
      ) ||
      (filter === 'friends' && (isFriend(r.creator) || (r.participants || []).some((p) => isFriend(p))))
    )
  );

  const isTvRoom = (r) => Boolean(r.curated && r.media?.live && !r.media?.isMusic && LIVE_BRANDS[r.id]);
  const isRadioRoom = (r) => Boolean(r.curated && r.media?.live && r.media?.isMusic && LIVE_BRANDS[r.id]);
  const sections = [
    { key: 'public', title: '🌐 Herkese Açık Odalar', list: publicRooms, empty: q ? 'Bu arama ölçütleriyle bir oda bulamadık' : 'Şu anda herkese açık oda yok — "+ Oda Oluştur" ile hemen ilk odayı başlat!' },
    { key: 'friends', title: '👥 Arkadaş Odaları', list: friendRooms, empty: 'Henüz aktif bir arkadaş odası yok. "+ Arkadaş Ekle" butonuyla arkadaşlarını ekleyebilirsin.' },
    { key: 'tv', title: '📺 Canlı TV Kanalları · 7/24', list: sortByBrandOrder(visible.filter(isTvRoom)) },
    { key: 'radio', title: '📻 Canlı Radyolar · 7/24', list: sortByBrandOrder(visible.filter(isRadioRoom)) },
  ].filter((s) => filter === 'all' || s.key === filter || (filter === 'public' && (s.key === 'tv' || s.key === 'radio')));

  const layoutSig = `${filter}|${q}|${friends.map((f) => f.name).join(',')}|${sections.map((s) => `${s.key}:${s.list.map((r) => `${r.id}:${r.privacy}:${r.media?.title || r.name}`).join(',')}`).join(';')}`;
  if (container.dataset.layoutSig === layoutSig && container.querySelector('.meshthumb')) {
    const byId = new Map(visible.map((r) => [r.id, r]));
    container.querySelectorAll('.meshthumb[data-room]').forEach((card) => {
      const r = byId.get(card.dataset.room);
      if (!r) return;
      card._room = r;
      const badge = card.querySelector('.meshthumb-live-badge');
      if (badge && !r.curated) {
        const vc = Math.max(0, Number(r.count ?? (r.participants || []).filter((p) => p.transport !== 'bot').length) || 0);
        badge.textContent = r.privacy === 'friends' ? `👥 ${vc} izleyici` : `🔴 ${vc} izleyici`;
      }
      const titleEl = card.querySelector('.meshthumb-title');
      const cleanT = (r.media?.title && !/içerik seçilmedi|medya seçilmedi|hazır/i.test(String(r.media.title))) ? String(r.media.title).trim() : (r.name || 'Watchlivo Odası');
      if (titleEl && cleanT) titleEl.textContent = cleanT;
    });
    return;
  }

  const wasSearchFocused = typeof document !== 'undefined' && (
    document.activeElement?.id === 'wl-lobby-room-search' ||
    document.activeElement?.id === 'lobby-search'
  );
  const focusedSearchId = wasSearchFocused ? document.activeElement.id : '';
  const selStart = wasSearchFocused ? document.activeElement.selectionStart : null;
  const selEnd = wasSearchFocused ? document.activeElement.selectionEnd : null;
  const hadInlineSearch = Boolean(container.querySelector?.('#wl-lobby-room-search'));

  container.dataset.layoutSig = layoutSig;
  container.replaceChildren();

  let searchInput = null;
  if (hadInlineSearch || (typeof document !== 'undefined' && !document.getElementById('lobby-search') && !document.getElementById('wl-lobby-room-search'))) {
    searchInput = h('input', {
      id: 'wl-lobby-room-search',
      class: 'input lobby-search-compact',
      value: query,
      placeholder: 'Katılacak yeni odalar keşfet...',
      'aria-label': 'Katılacak yeni odalar keşfet',
      oninput: (e) => {
        container.dataset.layoutSig = '';
        renderLobbySections(container, rooms, onOpen, { filter, query: e.target.value });
      },
    });
    container.append(h('div', { class: 'lobby-inline-search-row', style: { display: 'none' } }, searchInput));
  } else if (typeof document !== 'undefined') {
    searchInput = document.getElementById(focusedSearchId) || document.getElementById('wl-lobby-room-search') || document.getElementById('lobby-search');
  }

  if (filter === 'friends' || (filter === 'all' && friends.length > 0)) {
    const friendsBar = h('div', { class: 'friends-strip' },
      h('span', { class: 'friends-strip-title' }, `👥 Arkadaşlarım (${friends.length})`),
      ...(friends.length
        ? friends.map((f) => h('span', { class: 'friend-pill' },
            h('span', { class: 'friend-dot', style: { background: f.color || '#27DCC8' } }),
            h('span', {}, f.name),
            h('button', {
              type: 'button',
              class: 'friend-remove',
              title: 'Arkadaşlardan çıkar',
              onclick: async () => {
                if (f.uid || f.id) {
                  const r = await updateFriendAction('remove', { targetUid: f.uid || f.id });
                  if (!r?.ok) { toast(r?.error || 'Arkadaş çıkarılamadı.'); return; }
                }
                container.dataset.layoutSig = '';
                renderLobbySections(container, rooms, onOpen, { filter, query });
              },
            }, '×')))
        : [h('span', { class: 'dim', style: { fontSize: '.78rem' } }, 'Arkadaşlarını ekleyerek özel odalarını burada görebilirsin.')]),
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        id: 'btn-lobby-add-friend',
        onclick: () => openFriendsManagerModal(() => { container.dataset.layoutSig = ''; renderLobbySections(container, rooms, onOpen, { filter, query }); }),
      }, '👥 + Arkadaş Ekle'));
    container.append(friendsBar);
  }

  const renderedRoomIds = new Set();
  for (const s of sections) {
    const list = filter === 'all' ? s.list.filter((r) => !renderedRoomIds.has(r.id)) : s.list;
    list.forEach((r) => renderedRoomIds.add(r.id));
    if (!list.length && (filter === 'all' && s.key !== 'public')) continue;
    container.append(h('div', { class: 'section-head', id: `lobby-sec-${s.key}` }, h('h2', {}, s.title), h('span', { class: 'dim' }, list.length ? `${list.length} aktif oda` : '')));
    if (!list.length) container.append(h('div', { class: 'lobby-empty' }, s.empty));
    else if (s.key === 'tv' || s.key === 'radio') container.append(h('div', { class: 'tv-channels-grid' }, list.map((r) => tvGlassCard(r, onOpen))));
    else container.append(h('div', { class: 'lobby-grid' }, list.map((r) => meshThumb(r, onOpen))));
  }
  if (wasSearchFocused && searchInput) {
    searchInput.focus({ preventScroll: true });
    try { searchInput.setSelectionRange(selStart, selEnd); } catch (_) {}
  }
  requestAnimationFrame(() => container.classList.add('is-hydrated'));
}
