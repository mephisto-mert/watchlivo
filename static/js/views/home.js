// Home (Rave Home: NavBar · Selection (provider grid + SuperSearch) · Lobby sections).
import { h, icons, popup, toast, setBackground, openThemeModal, openDownloadModal } from '../ui.js?v=20261027_v1';
import { state, set } from '../store.js';
import { avatar, profileSetup } from '../profile.js?v=20261025_v10';
import { api } from '../api.js';
import { createSelection } from './selection.js?v=20261025_v10';
import { fetchRooms, renderLobbySections, thumbFor, rememberRoom } from './lobby.js?v=20261025_v10';

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
  const self = state.self;
  const cleanMedia = media ? { ...media, currentTime: 0 } : media;
  const res = await api('/api/rooms/create', { method: 'POST', body: { name: `${self.name} odası`, privacy: 'public', playMode: 'leader', creator: self.name, media: cleanMedia } });
  if (!res.room?.id) throw new Error('Oda oluşturulamadı');
  rememberRoom(res.room);
  window.vortexNavigate(`/mesh/${encodeURIComponent(res.room.id)}?new=1`);
}

export function renderHome(app) {
  destroyHome();
  setBackground(null);
  const self = state.self;
  const isMember = Boolean(self && !self.isGuest && (self.email || self.authToken));
  const nav = h('nav', { class: 'navbar' },
    h('div', { class: 'navbar-left' },
      h('button', {
        class: 'wl-nav-account-btn',
        id: 'nav-account-btn',
        title: isMember ? `${self.name} (@${self.handle}) — Hesap Ayarları` : 'Watchlivo Giriş Yap / Kayıt Ol',
        onclick: () => profileSetup({ current: self, dismissable: isMember, onDone: (p) => { set({ self: p }); renderHome(app); } }),
      },
      avatar(self, 28),
      h('span', { class: 'wl-nav-account-text' },
        h('span', {}, isMember ? self.name : 'Giriş Yap / Kayıt Ol'),
        h('span', { class: 'wl-nav-account-sub' }, isMember ? `✓ @${self.handle || 'uye'}` : '🔒 Resmi Hesap Girişi'))),
      navIcon('rooms', 'Odalar', () => {
        const anchor = document.getElementById('lobby-anchor');
        if (anchor) {
          anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
          anchor.style.transition = 'box-shadow .3s ease';
          anchor.style.boxShadow = '0 0 0 2px var(--accent)';
          setTimeout(() => { anchor.style.boxShadow = ''; }, 1200);
        }
        toast('🎬 Aktif izleme odaları listesi');
      }),
      navIcon('settings', 'Ayarlar & Tema', () => openAppSettings(), { id: 'nav-theme-btn' })),
    h('div', { class: 'navbar-center' }, logo()),
    h('div', { class: 'navbar-right' },
      h('a', {
        class: 'btn wl-btn-apk',
        id: 'nav-btn-apk',
        href: '/download/apk',
        download: 'Watchlivo-v1.1.0.apk',
        title: 'Watchlivo Android APK İndir',
        onclick: () => toast('📱 Watchlivo Android APK indiriliyor...', 4000),
      },
      h('span', { html: icons.android, style: { display: 'flex' } }),
      h('span', { class: 'wl-btn-apk-text' }, 'APK İndir')),
      h('button', { class: 'btn primary', id: 'btn-create-room', onclick: async () => {
        try {
          await createRoomWithMedia(null);
        } catch (e) {
          document.getElementById('home-selection')?.scrollIntoView({ behavior: 'smooth' });
          setTimeout(() => document.querySelector('#home-selection .home-search input')?.focus(), 80);
        }
      } }, h('span', { html: icons.plus, style: { display: 'flex' } }), 'Oda Oluştur'),
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

  const homeScroll = h('div', { class: 'home-scroll' },
    appBanner,
    selection,
    h('div', { id: 'lobby-anchor', class: 'lobby-toolbar' },
      h('div', { class: 'lobby-toolbar-left' },
        h('h2', { class: 'lobby-heading' }, 'Odalar'),
        tabs),
      h('div', { class: 'lobby-toolbar-right' },
        lobbySearch)),
    lobbyBox);
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
