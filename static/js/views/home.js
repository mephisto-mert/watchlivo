// Home (Rave Home: NavBar · Selection (provider grid + SuperSearch) · Lobby sections).
import { h, icons, popup, toast, setBackground, openThemeModal, openDownloadModal } from '../ui.js?v=20261102_v62';
import { state, set, getFriends } from '../store.js?v=20261102_v62';
import { avatar, profileSetup } from '../profile.js?v=20261102_v62';
import { api } from '../api.js?v=20261102_v62';
import { createSelection } from './selection.js?v=20261102_v62';
import { fetchRooms, renderLobbySections, thumbFor, rememberRoom, forgetRoom, openFriendsManagerModal } from './lobby.js?v=20261102_v62';

let refreshTimer = null;
let rooms = [];

export function navIcon(name, tip, onClick, { selected = false, disabled = false, badge = 0, red = false, id } = {}) {
  return h('button', { class: `nav-icon ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`, 'data-tip': tip, 'aria-label': tip, id, onclick: onClick },
    h('span', { html: icons[name], style: { display: 'flex' } }),
    badge > 0 ? h('span', { class: `badge ${red ? 'red' : ''}` }, badge > 9999 ? '9.9B+' : badge) : null);
}

export function logo() {
  return h('div', {
    class: 'logo',
    onclick: () => {
      if (state.route?.name === 'mesh' && typeof window.vortexMinimizeRoom === 'function') {
        window.vortexMinimizeRoom();
      } else {
        window.vortexNavigate('/');
      }
    },
  },
    h('img', { src: '/static/watchlivo-logo.svg?v=20261102_v62', alt: 'Watchlivo' }),
    h('span', { class: 'logo-wordmark' }, 'WATCHLIVO'));
}

export function openRoom(room) {
  if (!room?.id) return;
  rememberRoom(room);
  window.vortexNavigate(`/mesh/${encodeURIComponent(room.id)}`);
}

export async function createRoomWithMedia(media) {
  const self = state.self || { id: 'guest_user', name: 'İzleyici', isGuest: true };
  const resumePos = Number.isFinite(Number(media?.currentTime)) && Number(media.currentTime) > 5 ? Math.floor(Number(media.currentTime)) : 0;
  const cleanMedia = media ? { ...media, currentTime: resumePos } : media;
  if (cleanMedia && state.mesh?.id && !state.mesh.curated && window.vortexActions?.pickMedia) {
    document.body.classList.remove('mesh-minimized');
    window.vortexNavigate(`/mesh/${encodeURIComponent(state.mesh.id)}`);
    window.vortexActions.pickMedia(cleanMedia);
    return;
  }
  let cid = '';
  try {
    cid = sessionStorage.getItem('vortex_cid') || ('h_' + Math.random().toString(36).slice(2, 10));
    sessionStorage.setItem('vortex_cid', cid);
  } catch (e) { /* ignore */ }
  const initialRoomName = (cleanMedia?.title && !/içerik seçilmedi|medya seçilmedi|hazır/i.test(cleanMedia.title))
    ? String(cleanMedia.title).trim().slice(0, 80)
    : `${self.name || 'İzleyici'} odası`;
  const res = await api('/api/rooms/create', {
    method: 'POST',
    body: {
      name: initialRoomName,
      privacy: 'public',
      playMode: 'leader',
      creator: self.name || 'İzleyici',
      creatorId: self.id || '',
      clientId: cid,
      color: self.color || '#27DCC8',
      handle: self.handle || '',
      avatarUrl: self.avatarUrl || self.avatar || '',
      bio: self.bio || '',
      statusText: self.statusText || '',
      statusEmoji: self.statusEmoji || '🍿',
      medal: self.medal || '',
      watchMinutes: self.watchMinutes || 0,
      hideLocation: Boolean(self.hideLocation),
      hideWatching: Boolean(self.hideWatching),
      hideFriends: Boolean(self.hideFriends),
      friendsPreview: Boolean(self.hideFriends) ? [] : (getFriends() || []).slice(0, 10),
      device: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '') ? 'Mobil' : 'Web',
      media: cleanMedia,
    },
  });
  if (!res.room?.id) throw new Error('Oda oluşturulamadı');
  try {
    const prevRecents = JSON.parse(localStorage.getItem('vortex_recent_rooms') || '[]');
    for (const oldId of prevRecents) {
      if (oldId && oldId !== res.room.id && !String(oldId).startsWith('tv-') && !String(oldId).startsWith('radyo-')) {
        forgetRoom(oldId);
      }
    }
    if (res.clientId) {
      sessionStorage.setItem('vortex_cid', res.clientId);
      sessionStorage.setItem(`vortex_creator_${res.room.id}`, res.clientId);
      localStorage.removeItem(`vortex_creator_flag_${res.room.id}`);
      localStorage.removeItem(`vortex_creator_${res.room.id}`);
    }
    if (res.clientToken) {
      sessionStorage.setItem(`vortex_ct_${res.room.id}`, res.clientToken);
      localStorage.removeItem(`vortex_ct_${res.room.id}`);
    }
    if (res.room.syncToken) sessionStorage.setItem(`vortex_st_${res.room.id}`, res.room.syncToken);
  } catch (e) { /* ignore */ }
  rememberRoom(res.room);
  window.vortexNavigate(`/mesh/${encodeURIComponent(res.room.id)}?new=1&cid=${encodeURIComponent(res.clientId || cid)}`);
}

export function renderHome(app) {
  destroyHome();
  setBackground(null);
  const self = state.self;
  const isMember = Boolean(self && !self.isGuest && (self.email || self.authToken));
  const isConfirmedGuest = Boolean(self && self.isGuest && self.guestConfirmed);
  const nav = h('header', { class: 'top-nav-capsule navbar' },
    h('div', { class: 'nav-left navbar-left' },
      h('button', {
        class: 'user-profile-badge wl-nav-account-btn',
        id: 'nav-account-btn',
        title: isMember ? `${self.name} (@${self.handle}) — Hesap Ayarları` : (isConfirmedGuest ? `${self.name} (Misafir) — Giriş Yap / Hesap Aç` : 'Watchlivo Giriş Yap / Misafir İzle'),
        onclick: () => profileSetup({ current: self, dismissable: true, onDone: (p) => { if (p) set({ self: p }); renderHome(app); } }),
      },
      avatar(self, 30),
      h('div', { class: 'user-meta wl-nav-account-text' },
        h('span', { class: 'uname' }, isMember ? self.name : (isConfirmedGuest ? self.name : 'Giriş Yap / Misafir Gir')),
        h('span', { class: 'utag wl-nav-account-sub' }, isMember ? `✓ @${self.handle || 'uye'}` : (isConfirmedGuest ? '👤 Misafir · Hesap Aç' : '🔓 Kayıtsız İzle / Giriş')))),
      navIcon('rooms', 'Odalar', () => {
        const anchor = document.getElementById('lobby-anchor');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('🎬 Aktif izleme odaları listesi');
      }),
      navIcon('friends', 'Arkadaşlarım & Arkadaş Ekle', () => openFriendsManagerModal(() => draw(true)), { id: 'nav-friends-btn', badge: getFriends().length }),
      navIcon('settings', 'Ayarlar & Tema', () => openAppSettings(), { id: 'nav-theme-btn' })),
    h('div', { class: 'nav-center navbar-center' }, logo()),
    h('div', { class: 'nav-right navbar-right' },
      h('a', {
        class: 'apk-badge wl-btn-apk',
        id: 'nav-btn-apk',
        href: '/download/Watchlivo-v1.1.0.apk',
        download: 'Watchlivo-v1.1.0.apk',
        title: 'Watchlivo Android APK İndir',
        onclick: () => toast('📱 Watchlivo Android APK indiriliyor...', 4000),
      },
      h('span', { html: icons.android, style: { display: 'flex' } }),
      h('span', { class: 'wl-btn-apk-text' }, 'APK İndir')),
      h('button', { class: 'btn-create-room btn primary', id: 'btn-create-room', onclick: async () => {
        try {
          await createRoomWithMedia(null);
        } catch (e) {
          toast(e?.message || 'Oda oluşturulamadı, lütfen tekrar deneyin.');
          document.getElementById('home-selection')?.scrollIntoView({ behavior: 'smooth' });
          setTimeout(() => document.querySelector('#home-selection .home-search input')?.focus(), 80);
        }
      } }, h('span', { html: icons.plus, style: { display: 'flex' } }), h('span', { class: 'create-room-lbl' }, 'Oda Oluştur')),
      navIcon('download', 'Tüm Uygulamaları İndir (APK & Windows)', () => openDownloadModal(), { id: 'nav-download-btn' }),
      navIcon('link', 'Kodla katıl', () => joinByCode())));

  const selection = createSelection({ onPick: async (media) => {
    if (document.body.classList.contains('mesh-minimized') && state.mesh && !state.mesh.curated && typeof window.vortexActions?.pickMedia === 'function') {
      try {
        const cleanMedia = { ...media, currentTime: Number(media.currentTime) > 0 ? Number(media.currentTime) : 0 };
        await window.vortexActions.pickMedia(cleanMedia);
        window.vortexRestoreRoom?.();
        return;
      } catch (e) { /* fallback to createRoomWithMedia */ }
    }
    try { await createRoomWithMedia(media); } catch (e) { toast(e.message || 'Oda oluşturulamadı'); }
  } });
  selection.id = 'home-selection';
  selection.render();

  let filter = 'all';
  let query = '';
  const lobbyBox = h('div', { id: 'lobby-box' });
  const lobbySearch = h('input', { class: 'input', placeholder: 'Katılacak yeni odalar keşfet...', style: { maxWidth: '360px' } });
  const tabs = h('div', { class: 'lobby-tabs' }, [['all', 'Tümü'], ['friends', 'Arkadaşlar'], ['nearby', 'Çevremdekiler'], ['public', 'Herkese Açık']].map(([k, label]) =>
    h('button', { class: `lobby-tab ${k === filter ? 'on' : ''}`, onclick: (e) => { filter = k; tabs.querySelectorAll('.lobby-tab').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); draw(true); } }, label)));
  let lastRoomsSig = '';
  let lastScrollAt = 0;
  let pendingDrawTimer = null;
  const draw = (force = false) => {
    const sorted = [...rooms].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const sig = `${filter}|${query}|${JSON.stringify(sorted.map((r) => [r.id, r.name, r.privacy, r.count, r.media?.title, r.media?.url]))}`;
    if (!force && sig === lastRoomsSig) return;
    if (!force && Date.now() - lastScrollAt < 1000) {
      clearTimeout(pendingDrawTimer);
      pendingDrawTimer = setTimeout(() => draw(false), 1050);
      return;
    }
    lastRoomsSig = sig;
    renderLobbySections(lobbyBox, rooms, openRoom, { filter, query });
  };
  lobbySearch.addEventListener('input', () => { query = lobbySearch.value; draw(true); });

  const appBanner = h('div', { class: 'wl-app-banner', id: 'home-app-banner' },
    h('div', { class: 'wl-app-banner-icon' }, h('span', { html: icons.android, style: { display: 'flex' } })),
    h('div', { class: 'wl-app-banner-text' },
      h('div', { class: 'wl-app-banner-title' },
        h('span', { class: 'wl-app-banner-badge' }, 'RESMİ APK'),
        h('b', {}, 'Watchlivo Android Yayında!')),
      h('span', { class: 'wl-app-banner-sub' }, 'Kesintisiz, reklamsız ve arkadaşlarınla tam senkron odalar için Android uygulamasını kur.')),
    h('div', { class: 'wl-app-banner-actions' },
      h('a', {
        class: 'btn primary sm wl-banner-apk-btn',
        href: '/download/Watchlivo-v1.1.0.apk',
        download: 'Watchlivo-v1.1.0.apk',
        onclick: () => toast('📱 Watchlivo Android APK indiriliyor...', 4000)
      }, h('span', { html: icons.download, style: { display: 'flex' } }), 'APK İndir'),
      h('button', {
        class: 'btn sm wl-banner-info-btn',
        onclick: () => openDownloadModal()
      }, 'Uygulamalar')));

  const makeDockLabel = (id) => ({
    home: 'Keşfet',
    cinema: 'Sinema+',
    rooms: 'Odalar',
    tv: 'Canlı TV',
    profile: 'Profil',
  }[id] || id);

  const makeDockBtn = (id, title, svgHtml, isAct, onClick) => {
    const b = h('button', {
      type: 'button',
      class: `dock-btn ${isAct ? 'active' : ''}`,
      'data-view': id,
      title,
      onclick: () => {
        dockEl.querySelectorAll('.dock-btn').forEach((x) => x.classList.toggle('active', x === b));
        onClick();
      },
    },
      h('span', { class: 'dock-ico', html: svgHtml }),
      h('span', { class: 'dock-lbl' }, makeDockLabel(id))
    );
    return b;
  };

  const dockEl = h('nav', { class: 'floating-dock', 'aria-label': 'Hızlı Gezinti' },
    makeDockBtn('home', 'Rave Hub & Odalar', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>', true, () => {
      selection.setProvider(null);
      homeScroll.scrollTo({ top: 0, behavior: 'smooth' });
    }),
    makeDockBtn('cinema', '40.000+ Sinema, Dizi & Anime', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>', false, () => {
      selection.setProvider('cinema');
      homeScroll.scrollTo({ top: 0, behavior: 'smooth' });
    }),
    makeDockBtn('rooms', 'Herkese Açık & Arkadaş Odaları', icons.rooms, false, () => {
      selection.setProvider(null);
      filter = 'all';
      tabs.querySelectorAll('.lobby-tab').forEach((b, idx) => b.classList.toggle('on', idx === 0));
      draw(true);
      setTimeout(() => {
        const el = document.getElementById('lobby-anchor');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    }),
    makeDockBtn('tv', '7/24 Canlı TV & Radyolar', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>', false, () => {
      selection.setProvider(null);
      filter = 'all';
      tabs.querySelectorAll('.lobby-tab').forEach((b, idx) => b.classList.toggle('on', idx === 0));
      draw(true);
      setTimeout(() => {
        const el = document.getElementById('lobby-sec-tv') || document.getElementById('lobby-anchor');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    }),
    makeDockBtn('profile', 'Profilim & Ayarlar', icons.friends, false, () => {
      profileSetup({ current: state.self, dismissable: true, onDone: (p) => { if (p) set({ self: p }); renderHome(app); } });
    })
  );

  const glassWindow = h('div', { class: 'glass-main-window' },
    selection,
    h('div', { id: 'lobby-anchor', class: 'lobby-toolbar' },
      h('div', { class: 'lobby-toolbar-left' },
        h('h2', { class: 'lobby-heading' }, 'Canlı Odalar'),
        tabs),
      h('div', { class: 'lobby-toolbar-right', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'nowrap' } },
        h('button', {
          type: 'button',
          class: 'btn sm primary',
          id: 'btn-toolbar-friends',
          style: { flexShrink: '0' },
          onclick: () => openFriendsManagerModal(() => draw(true)),
        }, '👥 + Arkadaş Ekle'),
        lobbySearch)),
    lobbyBox);

  const homeScroll = h('div', { class: 'home-scroll glass-home-shell' },
    h('div', { class: 'app-layout' }, dockEl, glassWindow));
  homeScroll.addEventListener('scroll', () => { lastScrollAt = Date.now(); }, { passive: true });
  const home = h('main', { class: 'home' }, homeScroll);

  app.replaceChildren(nav, home);
  updateMiniPip();
  let emptyStreak = 0;
  const load = async () => {
    try {
      const next = await fetchRooms();
      if (next.length === 0 && rooms.length > 0 && emptyStreak < 2) {
        emptyStreak += 1;
        return;
      }
      emptyStreak = 0;
      rooms = next;
      draw();
      updateMiniPip();
    } catch (e) { if (!rooms.length) lobbyBox.replaceChildren(h('div', { class: 'lobby-empty' }, 'Odalar yüklenemedi.')); }
  };
  lobbyBox.append(h('div', { style: { display: 'flex', justifyContent: 'center', padding: '1.5em' } }, h('div', { class: 'spinner' })));
  load();
  refreshTimer = setInterval(load, 8000);
}

export function destroyHome() { clearInterval(refreshTimer); refreshTimer = null; }

function joinByCode() {
  const input = h('input', { class: 'input', placeholder: 'Oda kodu veya davet bağlantısı' });
  popup({ title: 'Odaya Katıl', content: input, options: [{ label: 'Katıl', primary: true, onClick: () => {
    const v = input.value.trim();
    const m = v.match(/mesh\/([^/?#]+)/) || v.match(/[?&]room=([^&#]+)/);
    const id = m ? decodeURIComponent(m[1]) : v.replace(/[^a-z0-9-]/gi, '').toLowerCase();
    if (!id) {
      toast('Lütfen geçerli bir oda kodu veya davet bağlantısı girin');
      input.focus();
      return true;
    }
    openRoom({ id });
  } }, { label: 'Vazgeç' }] });
  setTimeout(() => input.focus(), 30);
}

function openAppSettings() {
  openThemeModal();
}

function updateMiniPip() {
  const pipEl = document.getElementById('mini-pip');
  if (!pipEl) return;
  let activeId = '';
  let activeTitle = 'Watchlivo Odası';
  try {
    const rec = JSON.parse(localStorage.getItem('vortex_recent_rooms') || '[]')[0];
    if (rec) {
      activeId = rec;
      const saved = JSON.parse(localStorage.getItem('vortex_room_snapshots_v1') || '{}')[rec];
      if (saved?.media?.title) activeTitle = saved.media.title;
      else if (saved?.name) activeTitle = saved.name;
    }
  } catch (e) { /* ignore */ }
  const dismissed = sessionStorage.getItem('vortex_pip_dismissed');
  if (!activeId || dismissed === activeId) {
    pipEl.classList.remove('active');
    return;
  }
  const titleEl = document.getElementById('pip-room-title');
  if (titleEl) titleEl.textContent = activeTitle;
  pipEl.classList.add('active');
  const expandBtn = document.getElementById('pip-expand-btn');
  const closeBtn = document.getElementById('pip-close-btn');
  if (expandBtn) {
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      pipEl.classList.remove('active');
      openRoom({ id: activeId });
    };
  }
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      try {
        sessionStorage.setItem('vortex_pip_dismissed', activeId);
        if (!String(activeId).startsWith('tv-') && !String(activeId).startsWith('radyo-')) {
          forgetRoom(activeId);
        }
      } catch {}
      pipEl.classList.remove('active');
    };
  }
  pipEl.onclick = () => {
    pipEl.classList.remove('active');
    openRoom({ id: activeId });
  };
}
