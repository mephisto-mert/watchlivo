// Home (Rave Home: NavBar · Selection (provider grid + SuperSearch) · Lobby sections).
import { h, icons, popup, toast, setBackground, openThemeModal, openDownloadModal } from '../ui.js?v=20261029_v7';
import { state, set } from '../store.js?v=20261029_v7';
import { avatar, profileSetup } from '../profile.js?v=20261029_v7';
import { api } from '../api.js?v=20261029_v7';
import { createSelection } from './selection.js?v=20261029_v7';
import { fetchRooms, renderLobbySections, thumbFor, rememberRoom } from './lobby.js?v=20261029_v7';

let refreshTimer = null;
let rooms = [];

export function navIcon(name, tip, onClick, { selected = false, disabled = false, badge = 0, red = false, id } = {}) {
  return h('button', { class: `nav-icon ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`, 'data-tip': tip, 'aria-label': tip, id, onclick: onClick },
    h('span', { html: icons[name], style: { display: 'flex' } }),
    badge > 0 ? h('span', { class: `badge ${red ? 'red' : ''}` }, badge > 9999 ? '9.9B+' : badge) : null);
}

export function logo() {
  return h('div', { class: 'logo', onclick: () => window.vortexNavigate('/') },
    h('img', { src: '/static/watchlivo-logo.svg?v=20261024m', alt: 'Watchlivo' }),
    h('span', { class: 'logo-wordmark' }, 'WATCHLIVO'));
}

export function openRoom(room) {
  if (!room?.id) return;
  rememberRoom(room);
  window.vortexNavigate(`/mesh/${encodeURIComponent(room.id)}`);
}

export async function createRoomWithMedia(media) {
  const self = state.self || { id: 'guest_user', name: 'İzleyici', isGuest: true };
  const cleanMedia = media ? { ...media, currentTime: 0 } : media;
  let cid = '';
  try {
    cid = sessionStorage.getItem('vortex_cid') || ('h_' + Math.random().toString(36).slice(2, 10));
    sessionStorage.setItem('vortex_cid', cid);
  } catch (e) { /* ignore */ }
  const res = await api('/api/rooms/create', { method: 'POST', body: { name: `${self.name || 'İzleyici'} odası`, privacy: 'public', playMode: 'leader', creator: self.name || 'İzleyici', clientId: cid, media: cleanMedia } });
  if (!res.room?.id) throw new Error('Oda oluşturulamadı');
  try {
    if (res.clientId) {
      sessionStorage.setItem('vortex_cid', res.clientId);
      sessionStorage.setItem(`vortex_creator_${res.room.id}`, res.clientId);
    }
    if (res.clientToken) sessionStorage.setItem(`vortex_ct_${res.room.id}`, res.clientToken);
    if (res.room.syncToken) sessionStorage.setItem(`vortex_st_${res.room.id}`, res.room.syncToken);
  } catch (e) { /* ignore */ }
  rememberRoom(res.room);
  window.vortexNavigate(`/mesh/${encodeURIComponent(res.room.id)}?new=1`);
}

export function renderHome(app) {
  destroyHome();
  setBackground(null);
  const self = state.self;
  const isMember = Boolean(self && !self.isGuest && (self.email || self.authToken));
  const nav = h('header', { class: 'top-nav-capsule navbar' },
    h('div', { class: 'nav-left navbar-left' },
      h('button', {
        class: 'user-profile-badge wl-nav-account-btn',
        id: 'nav-account-btn',
        title: isMember ? `${self.name} (@${self.handle}) — Hesap Ayarları` : 'Watchlivo Giriş Yap / Kayıt Ol',
        onclick: () => profileSetup({ current: self, dismissable: isMember, onDone: (p) => { set({ self: p }); renderHome(app); } }),
      },
      avatar(self, 30),
      h('div', { class: 'user-meta wl-nav-account-text' },
        h('span', { class: 'uname' }, isMember ? self.name : 'Giriş Yap / Kayıt Ol'),
        h('span', { class: 'utag wl-nav-account-sub' }, isMember ? `✓ @${self.handle || 'uye'}` : '🔒 Resmi Hesap Girişi'))),
      navIcon('rooms', 'Odalar', () => {
        const anchor = document.getElementById('lobby-anchor');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('🎬 Aktif izleme odaları listesi');
      }),
      navIcon('settings', 'Ayarlar & Tema', () => openAppSettings(), { id: 'nav-theme-btn' })),
    h('div', { class: 'nav-center navbar-center' }, logo()),
    h('div', { class: 'nav-right navbar-right' },
      h('a', {
        class: 'apk-badge wl-btn-apk',
        id: 'nav-btn-apk',
        href: '/download/apk',
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
      } }, h('span', { html: icons.plus, style: { display: 'flex' } }), '+ Oda Oluştur'),
      navIcon('download', 'Tüm Uygulamaları İndir (APK & Windows)', () => openDownloadModal(), { id: 'nav-download-btn' }),
      navIcon('link', 'Kodla katıl', () => joinByCode())));

  const selection = createSelection({ onPick: async (media) => {
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
        href: '/download/apk',
        download: 'Watchlivo-v1.1.0.apk',
        onclick: () => toast('📱 Watchlivo Android APK indiriliyor...', 4000)
      }, h('span', { html: icons.download, style: { display: 'flex' } }), 'APK İndir'),
      h('button', {
        class: 'btn sm wl-banner-info-btn',
        onclick: () => openDownloadModal()
      }, 'Uygulamalar')));

  const makeDockBtn = (id, title, svgHtml, isAct, onClick) => {
    const b = h('button', {
      type: 'button',
      class: `dock-btn ${isAct ? 'active' : ''}`,
      'data-view': id,
      title,
      html: svgHtml,
      onclick: () => {
        dockEl.querySelectorAll('.dock-btn').forEach((x) => x.classList.toggle('active', x === b));
        onClick();
      },
    });
    b.addEventListener('mousemove', (e) => {
      const rect = b.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      b.style.transform = `translate(${x * 0.25}px, ${y * 0.25}px) scale(1.12)`;
    });
    b.addEventListener('mouseleave', () => { b.style.transform = ''; });
    return b;
  };

  const dockEl = h('nav', { class: 'floating-dock', 'aria-label': 'Hızlı Gezinti' },
    makeDockBtn('home', 'Ana Hub & Platformlar', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>', true, () => {
      selection.setProvider(null);
      homeScroll.scrollTo({ top: 0, behavior: 'smooth' });
    }),
    makeDockBtn('cinema', '40.000+ Sinema, Dizi & Anime', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>', false, () => {
      selection.setProvider('cinema');
      homeScroll.scrollTo({ top: 0, behavior: 'smooth' });
    }),
    makeDockBtn('tv', '7/24 Canlı TV Kanalları', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>', false, () => {
      selection.setProvider(null);
      filter = 'all';
      tabs.querySelectorAll('.lobby-tab').forEach((b, idx) => b.classList.toggle('on', idx === 0));
      draw(true);
      setTimeout(() => {
        const el = document.getElementById('lobby-sec-tv') || document.getElementById('lobby-anchor');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    }),
    makeDockBtn('radio', '7/24 Canlı Radyolar', '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-.83-.51-1.57-1.24-1.85L12 2.5 3.24 6.15zM12 11c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/></svg>', false, () => {
      selection.setProvider(null);
      filter = 'all';
      tabs.querySelectorAll('.lobby-tab').forEach((b, idx) => b.classList.toggle('on', idx === 0));
      draw(true);
      setTimeout(() => {
        const el = document.getElementById('lobby-sec-radio') || document.getElementById('lobby-anchor');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    }),
    makeDockBtn('friends', 'Arkadaş Odaları & Çevre', icons.friends, false, () => {
      selection.setProvider(null);
      filter = 'friends';
      tabs.querySelectorAll('.lobby-tab').forEach((b) => b.classList.toggle('on', b.textContent.includes('Arkadaşlar')));
      draw(true);
      setTimeout(() => {
        const el = document.getElementById('lobby-anchor');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    }),
    makeDockBtn('watch', 'Canlı İzleme Odası', icons.rooms, false, async () => {
      try {
        const rec = JSON.parse(localStorage.getItem('vortex_recent_rooms') || '[]')[0];
        if (rec) { openRoom({ id: rec }); return; }
      } catch (e) { /* ignore */ }
      try { await createRoomWithMedia(null); } catch (e) { toast('Oda oluşturulamadı'); }
    }),
    makeDockBtn('settings', 'Ayarlar & Tema', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', false, () => openAppSettings())
  );

  const glassWindow = h('div', { class: 'glass-main-window' },
    appBanner,
    selection,
    h('div', { id: 'lobby-anchor', class: 'lobby-toolbar' },
      h('div', { class: 'lobby-toolbar-left' },
        h('h2', { class: 'lobby-heading' }, 'Odalar & 7/24 Canlı Yayınlar'),
        tabs),
      h('div', { class: 'lobby-toolbar-right' },
        lobbySearch)),
    lobbyBox);

  const homeScroll = h('div', { class: 'home-scroll glass-home-shell' },
    h('div', { class: 'app-layout' }, dockEl, glassWindow));
  homeScroll.addEventListener('scroll', () => { lastScrollAt = Date.now(); }, { passive: true });
  const home = h('main', { class: 'home' }, homeScroll);

  app.replaceChildren(nav, home);
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
