// Lobby (Rave Lobby + MeshThumbFC): sectioned grid of live rooms + 7/24 cinema + Friends & Nearby.
import { h, icons, popup, toast } from '../ui.js?v=20261029_v3';
import { avatar } from '../profile.js?v=20261029_v3';
import { getProvider } from '../providers.js?v=20261029_v3';
import { api, qs } from '../api.js?v=20261029_v3';
import { state, getFriends, isFriend, toggleFriend, addFriendByName } from '../store.js?v=20261029_v3';
import { expectedPosition } from '../sync.js?v=20261029_v3';

const LIVE_BRANDS = {
  'tv-trt1':        { label: 'TRT 1',        sub: 'ULUSAL · DİZİ & MAÇ',    c1: '#e11d48', c2: '#4c0519' },
  'tv-atv':         { label: 'atv',          sub: 'ULUSAL · PRIME TIME',    c1: '#ef4444', c2: '#450a0a' },
  'tv-now-tv':      { label: 'NOW',          sub: 'ULUSAL · DİZİ & HABER',  c1: '#f97316', c2: '#431407' },
  'tv-star-tv':     { label: 'STAR TV',      sub: 'ULUSAL · EĞLENCE & DİZİ',c1: '#eab308', c2: '#422006' },
  'tv-trt-spor':    { label: 'TRT SPOR',     sub: 'CANLI MAÇ & STÜDYO',     c1: '#10b981', c2: '#064e3b' },
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

function makeLiveBrandSvg({ label, sub, c1, c2 }) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient><radialGradient id="r" cx="25%" cy="15%" r="75%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="100%" stop-color="#000000" stop-opacity="0.35"/></radialGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect width="320" height="180" fill="url(#r)"/><circle cx="285" cy="35" r="55" fill="#ffffff" fill-opacity="0.06"/><text x="160" y="102" text-anchor="middle" fill="#ffffff" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="900" font-size="29" letter-spacing="1">${esc(label)}</text><text x="160" y="132" text-anchor="middle" fill="rgba(255,255,255,0.88)" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="700" font-size="11.5" letter-spacing="1.5">${esc(sub)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function thumbFor(media, roomId = '') {
  if (!media) return '';
  const brand = LIVE_BRANDS[roomId];
  if (brand && (!media.thumbnail || media.thumbnail.includes('watchlivo-poster.svg'))) {
    return makeLiveBrandSvg(brand);
  }
  if (media.thumbnail) return media.thumbnail;
  if (media.provider === 'youtube' && media.videoId) return `https://i.ytimg.com/vi/${media.videoId}/hqdefault.jpg`;
  return '';
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
    onclick: () => onOpen(room),
    onkeydown: (e) => { if (e.key === 'Enter') onOpen(room); },
  },
    h('div', { class: 'tv-badge' }, isRadio ? '7/24 RADYO' : '7/24 CANLI', eq),
    h('div', { class: 'tv-logo-box', style: { background: `linear-gradient(135deg, ${brand.c1}, ${brand.c2})` } }, brand.label),
    h('div', { class: 'tv-info' },
      h('div', { class: 'tv-name meshthumb-title' }, room.media?.title || room.name || brand.label),
      h('div', { class: 'tv-desc' }, `${brand.sub} · Herkese Açık`)));
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const rotateX = (((y - rect.height / 2) / (rect.height / 2)) * -6);
    const rotateY = (((x - rect.width / 2) / (rect.width / 2)) * 6);
    card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
  });
  card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  return card;
}

export function meshThumb(room, onOpen) {
  const media = room.media || {};
  const prov = getProvider(media.catalogProvider || media.sourceProvider || media.provider);
  const thumb = thumbFor(media, room.id);
  const brand = LIVE_BRANDS[room.id];
  const dur = Number(media.duration || 0);
  const viewerCount = room.count ?? (room.participants || []).length;
  const hasHumanViewer = room.curated ? viewerCount > 1 : viewerCount > 0;
  const rawPos = hasHumanViewer ? expectedPosition(media) : 0;
  const pos = dur > 0 ? (rawPos % dur) : rawPos;
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;
  const users = room.participants || [];
  const privacyLabel = { public: 'Herkese Açık', friends: 'Arkadaşlar', nearby: 'Çevremdekiler', private: 'Gizli', hidden: 'Gizli' }[room.privacy] || '';
  const hasTr = Boolean(
    media.catalogProvider ||
    (media.audioTracks || []).some((a) => /tr|türk/i.test(`${a.lang} ${a.label}`)) ||
    (media.subtitleTracks || []).some((s) => /tr|türk/i.test(`${s.lang} ${s.label}`)) ||
    /dublaj|altyaz/i.test(media.title || '')
  );
  const liveLabel = room.curated ? '🟢 7/24 CANLI' : `🔴 ${viewerCount} izleyici`;

  return h('div', {
    class: `meshthumb ${room.curated ? 'curated-room' : ''}`,
    role: 'button',
    tabindex: '0',
    'data-room': room.id,
    style: brand ? { '--room-accent': brand.c1 } : undefined,
    onclick: () => onOpen(room),
    onkeydown: (e) => { if (e.key === 'Enter') onOpen(room); },
  },
    h('div', { class: 'meshthumb-img' },
      thumb ? h('img', { src: thumb, alt: '', decoding: 'async', onerror: (e) => { e.target.style.display = 'none'; } }) : null,
      h('span', { class: `meshthumb-live-badge ${room.curated ? 'is-247' : ''}` }, liveLabel),
      (!room.curated && prov?.logo) ? h('img', { class: 'meshthumb-prov', src: prov.logo, alt: prov.name }) : null,
      dur > 0 ? h('span', { class: 'meshthumb-time' }, `${fmtRoomClock(pos)} / ${fmtRoomClock(dur)}`) : null,
      h('div', { class: 'play-hover', html: icons.play })),
    h('div', { class: 'meshthumb-body' },
      h('div', { class: 'meshthumb-title' }, media.title || room.name || 'Oda'),
      h('div', { class: 'meshthumb-sub' }, `${room.name || ''}${privacyLabel ? ' · ' + privacyLabel : ''}`),
      h('div', { class: 'meshthumb-meta-row' },
        h('div', { class: 'meshthumb-users' },
          users.slice(0, 5).map((u) => avatar(u, 20)),
          room.count > 5 ? h('span', { class: 'more' }, `+${room.count - 5}`) : null,
          room.count === 0 ? h('span', { class: 'more' }, 'Boş oda') : null),
        hasTr ? h('span', { class: 'meshthumb-lang-badge' }, '🇹🇷 Dublaj & Altyazı') : null),
      dur > 0 ? h('div', { class: 'meshthumb-progress' }, h('div', { style: { width: `${pct}%` } })) : null),
    room.hasPassword ? h('span', { class: 'meshthumb-lock', html: icons.lock }) : null);
}

const RECENT_KEY = 'vortex_recent_rooms';
export function rememberRoom(room) {
  try {
    if (!room?.id) return;
    localStorage.removeItem(`vortex_st_${room.id}`);
    localStorage.removeItem(`vortex_room_${room.id}`);
    if (room.media || room.name) {
      const cleanSnap = {
        ...room,
        chat: [],
        polls: [],
        syncToken: undefined,
        media: room.media ? { ...room.media, currentTime: 0, updatedAt: Date.now() / 1000 } : room.media,
      };
      sessionStorage.setItem(`vortex_room_${room.id}`, JSON.stringify(cleanSnap));
    }
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((r) => r !== room.id);
    list.unshift(room.id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
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
    if (parsed && parsed.media) parsed.media.currentTime = 0;
    if (parsed) parsed.chat = [];
    return parsed;
  } catch (e) {
    return null;
  }
}
const recentIds = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; } };

export async function fetchRooms() {
  const res = await api(`/api/rooms?${qs({ user: state.self?.name })}`, { timeout: 8000 });
  return res.rooms || [];
}

function openAddFriendDialog(onRefresh) {
  const input = h('input', { class: 'input', placeholder: 'Arkadaşının kullanıcı adını yaz (örn. Berk, Elif)...' });
  popup({
    title: '👥 Arkadaş Ekle',
    content: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('div', { class: 'dim', style: { fontSize: '.85rem' } }, 'Eklediğin arkadaşların açtığı veya katıldığı odalar "Arkadaşlar" sekmesinde otomatik listelenir.'),
      input),
    options: [
      {
        label: 'Arkadaş Ekle',
        primary: true,
        onClick: () => {
          const val = input.value.trim();
          if (!val) return true;
          addFriendByName(val);
          toast(`${val} arkadaş listene eklendi`);
          if (onRefresh) onRefresh();
        },
      },
      { label: 'Kapat' },
    ],
  });
  setTimeout(() => input.focus(), 40);
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

// Rave lobby sections: Pinned/Recent · Friends · Nearby · Public
export function renderLobbySections(container, rooms, onOpen, { filter = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const match = (r) => !q || `${r.name} ${r.media?.title || ''} ${r.creator || ''}`.toLowerCase().includes(q);
  const visible = rooms.filter((r) => r.id !== state.mesh?.id && match(r));
  const recents = recentIds();
  const friends = getFriends();

  const friendRooms = visible.filter((r) =>
    isFriend(r.creator) ||
    (r.participants || []).some((p) => isFriend(p))
  );
  const nearbyRooms = visible.filter((r) =>
    r.privacy === 'nearby' ||
    (filter === 'nearby' && (r.id === 'kinox-dizi-maraton' || r.id === 'kinox-sinema-tr')) ||
    (!r.curated && (r.participants || []).some((p) => p.country === 'TR'))
  );

  const isTvRoom = (r) => Boolean(r.curated && r.media?.live && !r.media?.isMusic && LIVE_BRANDS[r.id]);
  const isRadioRoom = (r) => Boolean(r.curated && r.media?.live && r.media?.isMusic && LIVE_BRANDS[r.id]);
  const sections = [
    { key: 'recent', title: 'Son Ziyaret Ettiklerin', list: visible.filter((r) => !r.curated && recents.includes(r.id) && r.count > 0) },
    { key: 'friends', title: 'Arkadaşlar', list: friendRooms, empty: 'Henüz çevrimiçi bir arkadaş odası yok. Üstteki "+ Arkadaş Ekle" butonuyla arkadaşlarını ekleyebilirsin.' },
    { key: 'nearby', title: 'Çevremdekiler (Türkiye · Yakındaki Odalar)', list: nearbyRooms.filter((r) => !r.curated), empty: 'Şu anda yakındaki oda yok' },
    { key: 'public', title: 'Herkese Açık Odalar', list: visible.filter((r) => r.privacy === 'public' && !r.curated).sort((a, b) => (b.count - a.count) || String(a.id).localeCompare(String(b.id))), empty: q ? 'Bu arama ölçütleriyle bir oda bulamadık' : 'Şu anda herkese açık oda yok' },
    { key: 'tv', title: '📺 Canlı TV Kanalları · 7/24', list: sortByBrandOrder(visible.filter(isTvRoom)) },
    { key: 'radio', title: '📻 Canlı Radyolar · 7/24', list: sortByBrandOrder(visible.filter(isRadioRoom)) },
  ].filter((s) => filter === 'all' || s.key === filter || (filter === 'public' && (s.key === 'tv' || s.key === 'radio')));

  const layoutSig = `${filter}|${q}|${friends.length}|${sections.map((s) => `${s.key}:${s.list.map((r) => r.id).join(',')}`).join(';')}`;
  if (container.dataset.layoutSig === layoutSig && container.querySelector('.meshthumb')) {
    const byId = new Map(visible.map((r) => [r.id, r]));
    container.querySelectorAll('.meshthumb[data-room]').forEach((card) => {
      const r = byId.get(card.dataset.room);
      if (!r) return;
      card.onclick = () => onOpen(r);
      const badge = card.querySelector('.meshthumb-live-badge');
      if (badge && !r.curated) badge.textContent = `🔴 ${r.count ?? (r.participants || []).length} izleyici`;
      const titleEl = card.querySelector('.meshthumb-title');
      if (titleEl && (r.media?.title || r.name)) titleEl.textContent = r.media?.title || r.name;
    });
    return;
  }

  container.dataset.layoutSig = layoutSig;
  container.replaceChildren();

  if (filter === 'friends') {
    const friendsBar = h('div', { class: 'friends-strip' },
      h('span', { class: 'friends-strip-title' }, `👥 Arkadaşlarım (${friends.length})`),
      ...friends.map((f) => h('span', { class: 'friend-pill' },
        h('span', { class: 'friend-dot', style: { background: f.color || '#00f5d4' } }),
        h('span', {}, f.name),
        h('button', {
          type: 'button',
          class: 'friend-remove',
          title: 'Arkadaşlardan çıkar',
          onclick: () => { container.dataset.layoutSig = ''; toggleFriend(f); renderLobbySections(container, rooms, onOpen, { filter, query }); },
        }, '×'))),
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        onclick: () => openAddFriendDialog(() => { container.dataset.layoutSig = ''; renderLobbySections(container, rooms, onOpen, { filter, query }); }),
      }, '+ Arkadaş Ekle'));
    container.append(friendsBar);
  }

  const renderedRoomIds = new Set();
  for (const s of sections) {
    const list = filter === 'all' ? s.list.filter((r) => !renderedRoomIds.has(r.id)) : s.list;
    list.forEach((r) => renderedRoomIds.add(r.id));
    if (!list.length && (s.key === 'recent' || (filter === 'all' && s.key !== 'public'))) continue;
    container.append(h('div', { class: 'section-head', id: `lobby-sec-${s.key}` }, h('h2', {}, s.title), h('span', { class: 'dim' }, list.length ? `${list.length} aktif oda` : '')));
    if (!list.length) container.append(h('div', { class: 'lobby-empty' }, s.empty));
    else if (s.key === 'tv' || s.key === 'radio') container.append(h('div', { class: 'tv-channels-grid' }, list.map((r) => tvGlassCard(r, onOpen))));
    else container.append(h('div', { class: 'lobby-grid' }, list.map((r) => meshThumb(r, onOpen))));
  }
  requestAnimationFrame(() => container.classList.add('is-hydrated'));
}
