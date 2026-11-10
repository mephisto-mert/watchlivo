// Rave Account Login, In-App WebSelection Auth & TV Season/Episode Selector.
import { h, toast, popup } from './ui.js?v=20261110_v175';
import { api, qs } from './api.js?v=20261110_v175';
import { state, set, setView, findSavedProgress } from './store.js?v=20261110_v175';

const LS_KEY = 'vortex_accounts_v7';

// Local storage holds only display metadata (masked e-mail, profile label).
// It is not encrypted: never write a password here.
function _zkEncode(obj) {
  try { return JSON.stringify(obj); } catch (e) { return ''; }
}

function _zkDecode(str) {
  try { return str ? JSON.parse(str) : {}; } catch (e) { return {}; }
}

function _scopedAccountsKey() {
  const s = state.self;
  const uid = (!s?.isGuest && (s?.uid || s?.id)) ? String(s.uid || s.id).trim().toLowerCase() : 'guest';
  return `${LS_KEY}:${uid || 'guest'}`;
}

function readLocalAccounts() {
  try {
    localStorage.removeItem('vortex_accounts_v4');
    localStorage.removeItem('vortex_accounts_v5');
    localStorage.removeItem('vortex_accounts_v6');
    const scopedKey = _scopedAccountsKey();
    const raw = localStorage.getItem(scopedKey) || '';
    return _zkDecode(raw);
  } catch (e) { return {}; }
}

function saveLocalAccounts(accs) {
  try { localStorage.setItem(_scopedAccountsKey(), _zkEncode(accs)); } catch (e) { /* ignore */ }
}

export function setConnectedAccount(providerId, { accountEmail = '', profileName = '', cookies = [], extra = {} } = {}) {
  const local = readLocalAccounts();
  const current = local[providerId] || {};
  const cleanProfile = String(profileName || '').trim() || state.self?.name || 'Netflix Profilim';
  const cleanEmail = String(accountEmail || '').trim() || `${cleanProfile} (Aktif Oturum)`;
  
  local[providerId] = {
    ...current,
    loginSatisfied: true,
    userAuthenticated: true,
    accountEmail: cleanEmail,
    profileName: cleanProfile,
    cookies: Array.isArray(cookies) ? cookies : [],
    updatedAt: Date.now(),
    connectedVia: 'official_web_bridge',
    ...extra,
  };
  saveLocalAccounts(local);
  try { window.dispatchEvent(new CustomEvent('vortex_account_updated', { detail: { provider: providerId } })); } catch (_) {}
  return local[providerId];
}


const DEFAULT_SPECS = {
  netflix:     { name: 'Netflix', accent: '#e50914', domain: '.netflix.com', loginUrl: 'https://www.netflix.com/login', browseUrl: 'https://www.netflix.com/browse', authCookies: ['NetflixId', 'SecureNetflixId', 'nfvdid'], freeNoAuth: true },
  disney:      { name: 'Disney+', accent: '#0063e5', domain: '.disneyplus.com', loginUrl: 'https://www.disneyplus.com/login', browseUrl: 'https://www.disneyplus.com/home', authCookies: ['BAMSDK_TOKEN', 'disneyplus_session'] },
  prime:       { name: 'Prime Video', accent: '#00a8e1', domain: '.primevideo.com', loginUrl: 'https://www.primevideo.com/auth-redirect', browseUrl: 'https://www.primevideo.com', authCookies: ['x-main-av', 'at-main-av'] },
  max:         { name: 'Max', accent: '#002be7', domain: '.max.com', loginUrl: 'https://auth.max.com/login', browseUrl: 'https://play.max.com', authCookies: ['st', 'session', 'token'], freeNoAuth: true },
  apple:       { name: 'Apple TV+', accent: '#a1a1aa', domain: '.tv.apple.com', loginUrl: 'https://tv.apple.com', browseUrl: 'https://tv.apple.com', authCookies: ['media-user-token', 'myacinfo'] },
  mubi:        { name: 'MUBI', accent: '#0028ff', domain: '.mubi.com', loginUrl: 'https://mubi.com/tr/session/new', browseUrl: 'https://mubi.com/tr/showing', authCookies: ['_mubi_session', 'mubi_token'] },
  hulu:        { name: 'Hulu', accent: '#1ce783', domain: '.hulu.com', loginUrl: 'https://auth.hulu.com/web/login', browseUrl: 'https://www.hulu.com/hub/home', authCookies: ['_hulu_session', 'hulu_at'] },
  paramount:   { name: 'Paramount+', accent: '#0064ff', domain: '.paramountplus.com', loginUrl: 'https://www.paramountplus.com/account/signin/', browseUrl: 'https://www.paramountplus.com/home/', authCookies: ['CBS_COM', 'pplus_session'] },
  peacock:     { name: 'Peacock', accent: '#f59e0b', domain: '.peacocktv.com', loginUrl: 'https://www.peacocktv.com/signin', browseUrl: 'https://www.peacocktv.com/watch/home', authCookies: ['peacock_token', 'pck_sess'] },
  crunchyroll: { name: 'Crunchyroll', accent: '#f47521', domain: '.crunchyroll.com', loginUrl: 'https://sso.crunchyroll.com/login', browseUrl: 'https://www.crunchyroll.com/videos/popular', authCookies: ['etp_rt', 'session_id'] },
  plex:        { name: 'Plex', accent: '#e5a00d', domain: '.plex.tv', loginUrl: 'https://app.plex.tv/auth', browseUrl: 'https://watch.plex.tv', authCookies: ['X-Plex-Token', 'plex_tv_auth'] },
  pluto:       { name: 'Pluto TV', accent: '#fff200', domain: '.pluto.tv', loginUrl: 'https://pluto.tv/sign-in', browseUrl: 'https://pluto.tv/on-demand', authCookies: ['pluto_jwt', 'pluto_sess'] },
  tubi:        { name: 'Tubi', accent: '#fa382f', domain: '.tubitv.com', loginUrl: 'https://tubitv.com/login', browseUrl: 'https://tubitv.com/home', authCookies: ['at', 'TUBI_TOKEN'] },
  exxen:       { name: 'Exxen', accent: '#ffcb05', domain: '.exxen.com', loginUrl: 'https://www.exxen.com/tr/sign-in', browseUrl: 'https://www.exxen.com/tr', authCookies: ['exxen_token', 'exxen_session'] },
  blutv:       { name: 'BluTV', accent: '#00a8ff', domain: '.blutv.com', loginUrl: 'https://www.blutv.com/giris', browseUrl: 'https://www.blutv.com', authCookies: ['blutv_token', 'blu_sess'] },
  gain:        { name: 'GAİN', accent: '#e11d48', domain: '.gain.tv', loginUrl: 'https://www.gain.tv/giris', browseUrl: 'https://www.gain.tv', authCookies: ['gain_auth', 'gain_session'] },
  tod:         { name: 'TOD (beIN)', accent: '#ff004c', domain: '.todtv.com.tr', loginUrl: 'https://www.todtv.com.tr/giris', browseUrl: 'https://www.todtv.com.tr', authCookies: ['tod_token', 'tod_session'] },
  tabii:       { name: 'tabii', accent: '#00e676', domain: '.tabii.com', loginUrl: 'https://www.tabii.com/tr/login', browseUrl: 'https://www.tabii.com/tr', authCookies: ['tabii_token', 'tabii_session'] },
  tvplus:      { name: 'TV+', accent: '#ffc700', domain: '.tvplus.com.tr', loginUrl: 'https://tvplus.com.tr/giris', browseUrl: 'https://tvplus.com.tr', authCookies: ['tvplus_token', 'tvplus_sess'] },
  puhutv:      { name: 'puhutv', accent: '#ff2a5f', domain: '.puhutv.com', loginUrl: 'https://puhutv.com/giris', browseUrl: 'https://puhutv.com', authCookies: ['puhu_session', 'puhu_token'] },
  youtube:     { name: 'YouTube', accent: '#ff0033', domain: '.youtube.com', loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube', browseUrl: 'https://www.youtube.com', authCookies: ['LOGIN_INFO', 'SAPISID'] },
  drive:       { name: 'Google Drive', accent: '#3b82f6', domain: '.google.com', loginUrl: 'https://accounts.google.com/ServiceLogin?service=wise', browseUrl: 'https://drive.google.com/drive/my-drive', authCookies: ['drive_oauth_token', 'SID'] },
  dropbox:     { name: 'Dropbox', accent: '#0061ff', domain: '.dropbox.com', loginUrl: 'https://www.dropbox.com/login', browseUrl: 'https://www.dropbox.com/home', authCookies: ['t', 'jar'] },
  twitch:      { name: 'Twitch', accent: '#9146ff', domain: '.twitch.tv', loginUrl: 'https://www.twitch.tv/login', browseUrl: 'https://www.twitch.tv', authCookies: ['auth-token', 'twilight-user'] },
  kick:        { name: 'Kick', accent: '#53fc18', domain: '.kick.com', loginUrl: 'https://kick.com', browseUrl: 'https://kick.com', authCookies: ['kick_session', 'XSRF-TOKEN'] },
  tiktok:      { name: 'TikTok', accent: '#fe2c55', domain: '.tiktok.com', loginUrl: 'https://www.tiktok.com/login', browseUrl: 'https://www.tiktok.com', authCookies: ['sessionid', 'tt_chain_token'] },
  dailymotion: { name: 'Dailymotion', accent: '#00c6ff', domain: '.dailymotion.com', loginUrl: 'https://www.dailymotion.com/signin', browseUrl: 'https://www.dailymotion.com', authCookies: ['sid', 'access_token'] },
  vimeo:       { name: 'Vimeo', accent: '#1ab7ea', domain: '.vimeo.com', loginUrl: 'https://vimeo.com/log_in', browseUrl: 'https://vimeo.com/watch', authCookies: ['vimeo', 'vuid'] },
  cinema:          { name: 'Sinema, Dizi & Anime+', accent: '#ff6b00', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['cinema_free'], freeNoAuth: true },
  hdfilmcehennemi: { name: 'Sinema+ HD', accent: '#ff6b00', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['hdfc_free'], freeNoAuth: true },
  dizibox:         { name: 'Dizi+ Arşiv', accent: '#6366f1', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['dbx_free'], freeNoAuth: true },
  dizilife:        { name: 'Sezon+ TV', accent: '#8b5cf6', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['dl_free'], freeNoAuth: true },
  fullhdfilm:      { name: 'Vizyon 4K', accent: '#eab308', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['fhd_free'], freeNoAuth: true },
  yabancidizi:     { name: 'Maraton+', accent: '#06b6d4', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['yd_free'], freeNoAuth: true },
  music:           { name: 'Müzik & Klip', accent: '#1db954', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['m_free'], freeNoAuth: true },
  ytmusic:         { name: 'YouTube Music', accent: '#ff0033', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['ytm_free'], freeNoAuth: true },
  spotify:         { name: 'Spotify Music', accent: '#1db954', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['sp_free'], freeNoAuth: true },
  deezer:          { name: 'Deezer Hi-Fi', accent: '#a238ff', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['dz_free'], freeNoAuth: true },
  applemusic:      { name: 'Apple Music', accent: '#fa243c', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['am_free'], freeNoAuth: true },
  soundcloud:      { name: 'SoundCloud', accent: '#ff5500', domain: '.watchlivo.online', loginUrl: '', browseUrl: '', authCookies: ['sc_free'], freeNoAuth: true },
};

const FREE_NO_AUTH_IDS = new Set([
  'netflix', 'max', 'hbomax',
  'cinema', 'hdfilmcehennemi', 'dizibox', 'dizilife', 'fullhdfilm', 'yabancidizi',
  'music', 'ytmusic', 'spotify', 'deezer', 'applemusic', 'soundcloud', 'plex', 'pluto', 'tubi',
]);

function maskAccountEmail(raw) {
  const s = String(raw || '').trim();
  if (!s.includes('@')) return s;
  const [user, dom] = s.split('@');
  if (user.length <= 2) return `${user[0] || '*'}***@${dom}`;
  return `${user.slice(0, 2)}***@${dom}`;
}

export function getAccount(providerId) {
  const local = readLocalAccounts()[providerId] || {};
  const spec = DEFAULT_SPECS[providerId] || { name: providerId, accent: '#8b5cf6', domain: `.${providerId}.com`, loginUrl: 'https://www.netflix.com/login', browseUrl: 'https://www.netflix.com/browse', authCookies: ['session'] };
  const isFree = Boolean(spec.freeNoAuth || FREE_NO_AUTH_IDS.has(providerId));
  const isAuthed = isFree || Boolean(local.userAuthenticated || local.loginSatisfied);
  return {
    ...spec,
    provider: providerId,
    freeNoAuth: isFree,
    loginSatisfied: isAuthed,
    accountEmail: local.accountEmail ? maskAccountEmail(local.accountEmail) : (isFree ? 'Şifresiz Açık Erişim' : ''),
    profileName: local.profileName || (isFree ? (providerId === 'netflix' ? 'Netflix (Şifresiz)' : (providerId === 'max' ? 'HBO Max (Şifresiz)' : '🍿 Ücretsiz VIP Sinema')) : (state.self?.name || '4K UHD')),
    cookieCount: 0,
    cookies: [],
  };
}

export async function fetchAccounts() {
  const local = readLocalAccounts();
  let cleaned = false;
  for (const [k, v] of Object.entries(local)) {
    if (v && (v.cookies || v.yRaveHeader)) {
      delete v.cookies;
      delete v.yRaveHeader;
      cleaned = true;
    }
  }
  if (cleaned) saveLocalAccounts(local);
  const out = {};
  for (const k of Object.keys(DEFAULT_SPECS)) {
    out[k] = getAccount(k);
  }
  for (const [k, v] of Object.entries(local)) {
    if (v?.loginSatisfied && v?.userAuthenticated && v?.accountEmail) {
      out[k] = getAccount(k);
    }
  }
  set({ accounts: out });
  return out;
}

export function launchProviderWindow(_url, title = 'Watchlivo') {
  setView('left', 'Search');
  toast(`${title} uygulama içi Watchlivo panelinde açıldı`);
}

export async function openSiteDataModal() {
  toast('Güvenlik nedeniyle çerez paylaşımı ve gösterimi devre dışı bırakıldı.');
}

export async function logoutAccount(providerId, onReload) {
  const local = readLocalAccounts();
  delete local[providerId];
  saveLocalAccounts(local);
  try { await api('/api/rave/accounts/logout', { method: 'POST', body: { provider: providerId } }); } catch (e) { /* ignore */ }
  await fetchAccounts();
  try { window.dispatchEvent(new CustomEvent('vortex_account_updated', { detail: { provider: providerId } })); } catch (_) {}
  toast('Hesap bağlantısı kapatıldı');
  onReload?.();
}
export function openNetflixLoginModal(p, onReload, onOpenBrowser, onPickContent) {
  const prov = (typeof p === 'string') ? { id: p, name: 'Netflix' } : (p || { id: 'netflix', name: 'Netflix' });
  const acct = getAccount('netflix');
  let modalHandle = null;

  let closeModal = () => {
    if (modalHandle?.close) modalHandle.close();
    else document.querySelector('.popup-backdrop')?.remove();
  };

  // 5 Canonical Netflix Smileys matching Rave
  const NETFLIX_PROFILES = [
    { id: 'p1', name: (state.self?.name && state.self?.name !== 'Misafir') ? state.self.name : 'Mertcan', color: '#0071eb', label: 'Ana Profil' },
    { id: 'p2', name: 'Tv', color: '#ffb400', label: 'Salon TV' },
    { id: 'p3', name: 'Telefon', color: '#e50914', label: 'Mobil' },
    { id: 'p4', name: 'Bilgisayar', color: '#2bb85c', label: 'Masaüstü' },
    { id: 'p5', name: 'Ayşe', color: '#009688', label: 'Misafir' },
  ];

  const makeSmileySvg = (size = 48) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('viewBox', '0 0 100 100');
    s.setAttribute('fill', 'none');
    s.innerHTML = `
      <circle cx="32" cy="38" r="7" fill="#ffffff" />
      <circle cx="68" cy="38" r="7" fill="#ffffff" />
      <path d="M26 62 C 38 78, 62 78, 74 62" stroke="#ffffff" stroke-width="8" stroke-linecap="round" fill="none" />
    `;
    return s;
  };

  // State Machine: 'login' | 'challenge' | 'profiles' | 'browse'
  // Option B: Default to live in-app Netflix bridge session (Rave parity)
  let currentStep = 'bridge';
  let bridgeUrl = acct.loginSatisfied ? '/api/netflix-bridge/browse' : '/api/netflix-bridge/login';

  let loginIdentifier = acct.accountEmail || ((!state.self?.isGuest && state.self?.email) ? state.self.email : 'mertcan@gmail.com');
  let challengeMode = 'otp'; // 'otp' or 'password'
  let activeProfile = acct.profileName || NETFLIX_PROFILES[0].name;

  const modalContainer = h('div', {
    class: 'rave-inapp-netflix-window',
    style: {
      width: '100%',
      maxWidth: '820px',
      minHeight: '520px',
      maxHeight: '90vh',
      background: '#141414',
      borderRadius: '16px',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      boxShadow: '0 24px 70px rgba(0,0,0,0.95), 0 0 40px rgba(229, 9, 20, 0.25)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '"Netflix Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      color: '#ffffff',
      boxSizing: 'border-box',
      position: 'relative',
    },
  });

  // 1. RAVE TOP APP BAR (Avatar, ☰, rAvE, ⚙, 👥, Close)
  const renderRaveHeader = () => {
    return h('div', {
      class: 'rave-native-header',
      style: {
        height: '46px',
        background: '#050507',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        flexShrink: 0,
      },
    },
      // Left: User Avatar & Hamburger
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        h('div', {
          style: {
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #e50914, #0071eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            fontWeight: '900',
            color: '#fff',
            overflow: 'hidden',
          },
        }, state.self?.avatar ? h('img', { src: state.self.avatar, style: { width: '100%', height: '100%', objectFit: 'cover' } }) : 'MC'),
        h('button', {
          type: 'button',
          style: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '18px', cursor: 'pointer', padding: '2px 4px' },
          onclick: () => toast('Rave Menüsü'),
        }, '☰')
      ),
      // Center: Stylized rAvE Wordmark
      h('div', {
        style: {
          fontSize: '24px',
          fontWeight: '900',
          letterSpacing: '1px',
          color: '#ffffff',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
        },
      },
        h('span', { style: { textTransform: 'lowercase' } }, 'r'),
        h('span', { style: { textTransform: 'uppercase' } }, 'A'),
        h('span', { style: { textTransform: 'lowercase' } }, 'v'),
        h('span', { style: { textTransform: 'uppercase' } }, 'E')
      ),
      // Right: Settings, Friends & Close
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        h('button', {
          type: 'button',
          style: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '17px', cursor: 'pointer' },
          onclick: () => toast('Rave Ayarları'),
        }, '⚙'),
        h('button', {
          type: 'button',
          style: { background: 'none', border: 'none', color: '#94a3b8', fontSize: '17px', cursor: 'pointer' },
          onclick: () => toast('Rave Arkadaşlar'),
        }, '👥'),
        h('button', {
          type: 'button',
          style: { background: 'none', border: 'none', color: '#cbd5e1', fontSize: '18px', cursor: 'pointer', marginLeft: '6px', fontWeight: '700' },
          onclick: () => closeModal(),
        }, '✕')
      )
    );
  };

  const bodyArea = h('div', {
    class: 'rave-inapp-netflix-body',
    style: {
      flex: 1,
      overflowY: 'auto',
      position: 'relative',
      background: 'radial-gradient(ellipse at 50% 0%, #2b0406 0%, #141414 70%)',
      display: 'flex',
      flexDirection: 'column',
    },
  });

  // RENDER VIEWS
  const renderView = () => {
    bodyArea.replaceChildren();

    // OPTION B: LIVE IN-APP NETFLIX BRIDGE (RAVE PARITY)
    if (currentStep === 'bridge') {
      const bridgeToolbar = h('div', {
        class: 'rave-bridge-toolbar',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          background: '#0d0d0f',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          fontSize: '12px',
          color: '#94a3b8',
          flexShrink: 0,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { color: '#e50914', fontWeight: '900', letterSpacing: '0.5px' } }, 'NETFLIX LIVE PORTAL'),
          h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' } }),
          h('span', { style: { color: '#cbd5e1', fontSize: '11px' } }, 'Rave Köprüsü Aktif')
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('button', {
            type: 'button',
            style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px' },
            onclick: () => {
              const fr = bodyArea.querySelector('#watchlivo-netflix-bridge-frame');
              if (fr) fr.src = fr.src;
            },
          }, '🔄 Yenile'),
          h('button', {
            type: 'button',
            style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px' },
            onclick: () => {
              const fr = bodyArea.querySelector('#watchlivo-netflix-bridge-frame');
              if (fr) fr.src = '/api/netflix-bridge/browse';
            },
          }, '🏠 Ana Sayfa'),
          h('button', {
            type: 'button',
            style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px' },
            onclick: () => {
              const fr = bodyArea.querySelector('#watchlivo-netflix-bridge-frame');
              if (fr) fr.src = '/api/netflix-bridge/login';
            },
          }, '🔑 Giriş Yap'),
          h('button', {
            type: 'button',
            style: { background: 'rgba(229,9,20,0.15)', border: '1px solid rgba(229,9,20,0.4)', color: '#f87171', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px', fontWeight: '700' },
            onclick: () => {
              currentStep = 'profiles';
              renderView();
            },
          }, '⚡ Hızlı Profil Modu')
        )
      );

      const bridgeIframe = h('iframe', {
        id: 'watchlivo-netflix-bridge-frame',
        src: bridgeUrl,
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
        style: {
          width: '100%',
          height: '580px',
          minHeight: '520px',
          border: 'none',
          background: '#141414',
          flex: 1,
        },
      });

      bodyArea.appendChild(bridgeToolbar);
      bodyArea.appendChild(bridgeIframe);
      return;
    }


    // VIEW 1: NETFLIX LOGIN (SCREENSHOT 2 PARITY)
    if (currentStep === 'login') {
      const emailInput = h('input', {
        type: 'text',
        placeholder: 'E-posta veya cep telefonu numarası',
        value: loginIdentifier,
        style: {
          width: '100%',
          padding: '16px 18px',
          borderRadius: '4px',
          background: '#333333',
          border: '1px solid #444444',
          color: '#ffffff',
          fontSize: '16px',
          outline: 'none',
          boxSizing: 'border-box',
          transition: 'border-color .2s',
        },
      });
      emailInput.onfocus = () => { emailInput.style.borderColor = '#ffffff'; };
      emailInput.onblur = () => { emailInput.style.borderColor = '#444444'; };

      const helpArea = h('div', {
        style: {
          display: 'none',
          background: 'rgba(255, 255, 255, 0.05)',
          padding: '12px 14px',
          borderRadius: '6px',
          fontSize: '13px',
          color: '#94a3b8',
          lineHeight: '1.45',
          marginTop: '8px',
        },
      }, 'Giriş yapmakta sorun yaşıyorsanız "Devam Et" butonuna tıklayarak SMS veya e-posta ile anlık doğrulama kodu alabilirsiniz.');

      const helpToggle = h('button', {
        type: 'button',
        style: {
          background: 'none',
          border: 'none',
          color: '#8c8c8c',
          fontSize: '13px',
          cursor: 'pointer',
          padding: '4px 0',
          alignSelf: 'flex-start',
        },
        onclick: () => {
          helpArea.style.display = helpArea.style.display === 'none' ? 'block' : 'none';
        },
      }, 'Yardım Al ⌵');

      const instantConnect = (chosenVal) => {
        const emailVal = chosenVal || loginIdentifier || 'Şifresiz Açık Erişim';
        setConnectedAccount('netflix', {
          accountEmail: emailVal,
          profileName: activeProfile || 'Netflix Profilim',
          extra: { avatarColor: '#e50914' },
        });
        toast('🎉 Netflix şifresiz hesabı başarıyla bağlandı!');
        onReload?.();
        currentStep = 'profiles';
        renderView();
      };

      const submitBtn = h('button', {
        type: 'button',
        style: {
          width: '100%',
          padding: '15px',
          borderRadius: '4px',
          background: '#e50914',
          border: 'none',
          color: '#ffffff',
          fontWeight: '800',
          fontSize: '16px',
          cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(229, 9, 20, 0.4)',
          transition: 'background .2s, transform .1s',
          marginTop: '4px',
        },
        onclick: () => {
          const val = emailInput.value.trim() || 'sifresiz@netflix.watchlivo';
          loginIdentifier = val;
          instantConnect(val);
        },
      }, '⚡ Şifresiz 1-Tıkla Giriş Yap (Devam Et)');

      const contentBox = h('div', {
        style: {
          maxWidth: '440px',
          width: '100%',
          margin: '36px auto',
          padding: '0 24px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        },
      },
        // Netflix Logo
        h('div', {
          style: {
            fontSize: '32px',
            fontWeight: '900',
            color: '#e50914',
            letterSpacing: '-0.5px',
            marginBottom: '8px',
          },
        }, 'NETFLIX'),
        // Title & Subtitle
        h('h1', {
          style: {
            margin: '0',
            fontSize: '24px',
            fontWeight: '700',
            color: '#ffffff',
            lineHeight: '1.25',
          },
        }, 'Oturum açmak için bilgilerinizi girin'),
        h('div', {
          style: {
            fontSize: '14px',
            color: '#8c8c8c',
            marginTop: '-6px',
            marginBottom: '4px',
          },
        }, 'Veya yeni bir hesap oluşturun.'),
        // Form
        emailInput,
        submitBtn,
        helpToggle,
        helpArea,
        // Google reCAPTCHA notice
        h('div', {
          style: {
            fontSize: '12px',
            color: '#737373',
            lineHeight: '1.4',
            marginTop: '18px',
          },
        }, 'Bu sayfa robot olmadığınızı kanıtlamak için Google reCAPTCHA tarafından korunuyor.')
      );

      bodyArea.appendChild(contentBox);
      setTimeout(() => emailInput.focus(), 80);
      return;
    }

    // VIEW 2: PASSWORD OR OTP CONFIRMATION CODE (ŞİFRE VEYA ONAY KODU)
    if (currentStep === 'challenge') {
      const modeTabs = h('div', {
        style: {
          display: 'flex',
          gap: '8px',
          background: 'rgba(0,0,0,0.4)',
          padding: '4px',
          borderRadius: '8px',
          marginBottom: '12px',
        },
      },
        h('button', {
          type: 'button',
          style: {
            flex: 1,
            padding: '10px',
            borderRadius: '6px',
            background: challengeMode === 'otp' ? '#e50914' : 'transparent',
            border: 'none',
            color: '#fff',
            fontWeight: '700',
            fontSize: '13px',
            cursor: 'pointer',
          },
          onclick: () => { challengeMode = 'otp'; renderView(); },
        }, '📱 SMS / E-posta Onay Kodu'),
        h('button', {
          type: 'button',
          style: {
            flex: 1,
            padding: '10px',
            borderRadius: '6px',
            background: challengeMode === 'password' ? '#e50914' : 'transparent',
            border: 'none',
            color: '#fff',
            fontWeight: '700',
            fontSize: '13px',
            cursor: 'pointer',
          },
          onclick: () => { challengeMode = 'password'; renderView(); },
        }, '🔑 Şifre ile Giriş')
      );

      let inputEl;
      if (challengeMode === 'otp') {
        inputEl = h('input', {
          type: 'text',
          placeholder: '6 Haneli Onay Kodu (örn: 849201)',
          maxLength: 8,
          style: {
            width: '100%',
            padding: '16px 18px',
            borderRadius: '4px',
            background: '#333333',
            border: '1px solid #444444',
            color: '#ffffff',
            fontSize: '18px',
            fontWeight: '700',
            letterSpacing: '4px',
            textAlign: 'center',
            outline: 'none',
            boxSizing: 'border-box',
          },
        });
      } else {
        inputEl = h('input', {
          type: 'password',
          placeholder: 'Netflix Parolanız',
          style: {
            width: '100%',
            padding: '16px 18px',
            borderRadius: '4px',
            background: '#333333',
            border: '1px solid #444444',
            color: '#ffffff',
            fontSize: '16px',
            outline: 'none',
            boxSizing: 'border-box',
          },
        });
      }

      const verifyBtn = h('button', {
        type: 'button',
        style: {
          width: '100%',
          padding: '15px',
          borderRadius: '4px',
          background: '#e50914',
          border: 'none',
          color: '#ffffff',
          fontWeight: '800',
          fontSize: '16px',
          cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(229, 9, 20, 0.4)',
        },
        onclick: () => {
          const val = inputEl.value.trim();
          if (!val) {
            toast(challengeMode === 'otp' ? 'Lütfen gelen onay kodunu girin.' : 'Lütfen şifrenizi girin.');
            inputEl.focus();
            return;
          }
          toast('✓ Netflix kimlik doğrulaması başarılı!');
          currentStep = 'profiles';
          renderView();
        },
      }, challengeMode === 'otp' ? 'Kodu Doğrula ve Giriş Yap' : 'Oturum Aç');

      const contentBox = h('div', {
        style: {
          maxWidth: '440px',
          width: '100%',
          margin: '36px auto',
          padding: '0 24px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        },
      },
        h('div', { style: { fontSize: '32px', fontWeight: '900', color: '#e50914', letterSpacing: '-0.5px' } }, 'NETFLIX'),
        h('h1', { style: { margin: '0', fontSize: '24px', fontWeight: '700', color: '#ffffff' } }, 'Giriş Doğrulaması'),
        h('div', { style: { fontSize: '14px', color: '#a3a3a3', marginTop: '-4px' } }, `${loginIdentifier} için devam ediliyor`),
        modeTabs,
        inputEl,
        verifyBtn,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' } },
          h('button', {
            type: 'button',
            style: { background: 'none', border: 'none', color: '#8c8c8c', fontSize: '13px', cursor: 'pointer' },
            onclick: () => { currentStep = 'login'; renderView(); },
          }, '← Farklı e-posta / telefon kullan'),
          challengeMode === 'otp' ? h('button', {
            type: 'button',
            style: { background: 'none', border: 'none', color: '#38bdf8', fontSize: '13px', cursor: 'pointer' },
            onclick: () => toast('Onay kodu tekrar gönderildi.'),
          }, 'Tekrar Kod Gönder') : null
        )
      );

      bodyArea.appendChild(contentBox);
      setTimeout(() => inputEl.focus(), 80);
      return;
    }

    // VIEW 3: "KİM İZLİYOR?" PROFILE PICKER (SCREENSHOT 3 PARITY)
    if (currentStep === 'profiles') {
      const profilesRow = h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '24px',
          flexWrap: 'wrap',
          margin: '32px 0 40px',
        },
      });

      NETFLIX_PROFILES.forEach((prof) => {
        const card = h('div', {
          role: 'button',
          tabindex: '0',
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
            cursor: 'pointer',
            transition: 'transform .2s ease',
          },
          onclick: () => {
            activeProfile = prof.name;
            setConnectedAccount('netflix', {
              accountEmail: loginIdentifier,
              profileName: prof.name,
              extra: { avatarColor: prof.color },
            });
            toast(`🎉 Hoş geldin ${prof.name}! Netflix kütüphanesi açılıyor...`);
            onReload?.();
            currentStep = 'browse';
            renderView();
          },
        },
          // Profile Smiley Box
          h('div', {
            style: {
              width: '110px',
              height: '110px',
              borderRadius: '8px',
              background: prof.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              border: '2px solid transparent',
              transition: 'border-color .2s, transform .2s',
            },
          }, makeSmileySvg(54)),
          // Profile Name
          h('div', {
            style: {
              fontSize: '15px',
              fontWeight: '600',
              color: '#808080',
              transition: 'color .2s',
            },
          }, prof.name)
        );

        card.onmouseenter = () => {
          card.style.transform = 'scale(1.06)';
          card.querySelector('div').style.borderColor = '#ffffff';
          card.lastChild.style.color = '#ffffff';
        };
        card.onmouseleave = () => {
          card.style.transform = 'scale(1)';
          card.querySelector('div').style.borderColor = 'transparent';
          card.lastChild.style.color = '#808080';
        };

        profilesRow.appendChild(card);
      });

      const manageBtn = h('button', {
        type: 'button',
        style: {
          padding: '10px 24px',
          background: 'transparent',
          border: '1px solid #808080',
          color: '#808080',
          fontSize: '14px',
          fontWeight: '600',
          letterSpacing: '1px',
          textTransform: 'uppercase',
          borderRadius: '4px',
          cursor: 'pointer',
          transition: 'all .2s',
        },
        onclick: () => toast('Profil yönetimi modu aktif.'),
      }, '✎ Profil Yönetimi');
      manageBtn.onmouseenter = () => { manageBtn.style.borderColor = '#fff'; manageBtn.style.color = '#fff'; };
      manageBtn.onmouseleave = () => { manageBtn.style.borderColor = '#808080'; manageBtn.style.color = '#808080'; };

      const contentBox = h('div', {
        style: {
          maxWidth: '720px',
          width: '100%',
          margin: '24px auto',
          padding: '0 20px',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        },
      },
        h('div', {
          style: {
            fontSize: '28px',
            fontWeight: '900',
            color: '#e50914',
            letterSpacing: '-0.5px',
            alignSelf: 'flex-start',
            marginBottom: '16px',
          },
        }, 'NETFLIX'),
        h('h1', {
          style: {
            margin: '0',
            fontSize: '36px',
            fontWeight: '700',
            color: '#ffffff',
            letterSpacing: '-0.5px',
          },
        }, 'Kim İzliyor?'),
        profilesRow,
        manageBtn
      );

      bodyArea.appendChild(contentBox);
      return;
    }

    // VIEW 4: IN-APP NETFLIX BROWSE (SCREENSHOT 4 & 5 PARITY)
    if (currentStep === 'browse') {
      const topBar = h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          background: 'rgba(20, 20, 20, 0.95)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          position: 'sticky',
          top: '0',
          zIndex: '10',
        },
      },
        // Nav Links
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '20px' } },
          h('span', { style: { fontSize: '26px', fontWeight: '900', color: '#e50914', cursor: 'pointer' } }, 'NETFLIX'),
          h('span', { style: { fontSize: '13px', fontWeight: '700', color: '#fff', cursor: 'pointer' } }, 'Ana Sayfa'),
          h('span', { style: { fontSize: '13px', fontWeight: '500', color: '#e5e5e5', cursor: 'pointer' } }, 'Diziler'),
          h('span', { style: { fontSize: '13px', fontWeight: '500', color: '#e5e5e5', cursor: 'pointer' } }, 'Filmler'),
          h('span', { style: { fontSize: '13px', fontWeight: '500', color: '#e5e5e5', cursor: 'pointer' } }, 'Oyunlar'),
          h('span', { style: { fontSize: '13px', fontWeight: '500', color: '#e5e5e5', cursor: 'pointer' } }, 'Daha Fazla ⌵')
        ),
        // Right Icons & Profile
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
          h('span', { style: { cursor: 'pointer', fontSize: '16px' }, onclick: () => toast('Netflix içi arama') }, '🔍'),
          h('span', { style: { cursor: 'pointer', fontSize: '16px' } }, '🔔'),
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'rgba(255,255,255,0.08)',
              padding: '4px 10px',
              borderRadius: '20px',
              cursor: 'pointer',
            },
            onclick: () => { currentStep = 'profiles'; renderView(); },
          },
            h('div', {
              style: {
                width: '24px',
                height: '24px',
                borderRadius: '4px',
                background: '#0071eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              },
            }, makeSmileySvg(16)),
            h('span', { style: { fontSize: '12px', fontWeight: '700' } }, activeProfile)
          ),
          h('button', {
            type: 'button',
            style: {
              background: 'none',
              border: 'none',
              color: '#ef4444',
              fontSize: '11px',
              fontWeight: '700',
              cursor: 'pointer',
              padding: '4px',
            },
            onclick: async () => {
              await logoutAccount('netflix', onReload);
              currentStep = 'login';
              renderView();
            },
          }, 'Çıkış')
        )
      );

      // Hero Spotlight Billboard (Organize İşler Karun Hazinesi - Screenshot 4 Parity)
      const heroBillboard = h('div', {
        style: {
          position: 'relative',
          width: '100%',
          minHeight: '280px',
          backgroundImage: 'linear-gradient(to right, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.2) 70%), url("https://image.tmdb.org/t/p/w1280/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg"), url("/static/brand/organize_isler.jpg")',
          backgroundSize: 'cover',
          backgroundPosition: 'center 20%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '32px 36px',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '800', color: '#e50914', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' } },
          h('span', { style: { background: '#e50914', color: '#fff', padding: '2px 6px', borderRadius: '3px', fontSize: '10px' } }, 'TOP 10 DİZİ'),
          '4K ULTRA HD · 5.1 DOLBY AUDIO'
        ),
        h('h1', {
          style: {
            margin: '0 0 10px',
            fontSize: '32px',
            fontWeight: '900',
            letterSpacing: '-0.5px',
            maxWidth: '560px',
            lineHeight: '1.15',
            textShadow: '0 2px 10px rgba(0,0,0,0.8)',
          },
        }, 'Organize İşler: Karun Hazinesi'),
        h('div', { style: { display: 'flex', gap: '10px', fontSize: '12px', color: '#cbd5e1', fontWeight: '600', marginBottom: '10px' } },
          h('span', {}, 'Dizi'),
          h('span', {}, '·'),
          h('span', {}, 'Komedi'),
          h('span', {}, '·'),
          h('span', {}, '2026'),
          h('span', {}, '·'),
          h('span', {}, '8 Bölüm'),
          h('span', { style: { border: '1px solid #94a3b8', padding: '0 4px', borderRadius: '2px', fontSize: '10px' } }, '16+')
        ),
        h('p', {
          style: {
            margin: '0 0 20px',
            fontSize: '13px',
            color: '#e2e8f0',
            lineHeight: '1.45',
            maxWidth: '520px',
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          },
        }, 'Efsanevi Asım Noyan, jübilesini yapıp "mesleği" geride bırakmadan önce son performansını sergilemeye hazır. Peki ama usta dolandırıcı bu defa ateşle mi oynuyor?'),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 26px',
              borderRadius: '6px',
              background: '#ffffff',
              border: 'none',
              color: '#000000',
              fontWeight: '800',
              fontSize: '15px',
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
            },
            onclick: () => {
              closeModal();
              const mediaObj = {
                provider: 'netflix',
                catalogProvider: 'netflix',
                streamType: 'official',
                title: 'Organize İşler: Karun Hazinesi',
                originalTitle: 'Organize İşler: Karun Hazinesi',
                url: 'https://www.netflix.com/watch/81682705',
                officialUrl: 'https://www.netflix.com/title/81682705',
                poster: 'https://image.tmdb.org/t/p/w500/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg',
                backdrop: 'https://image.tmdb.org/t/p/w1280/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg',
                mediaType: 'tv',
                season: 1,
                episode: 1,
                authenticated: true,
                duration: 2880,
              };
              if (typeof onPickContent === 'function') {
                onPickContent(mediaObj);
              } else {
                location.hash = `#/mesh/netflix-organize-isler-${Date.now().toString(36)}`;
              }
            },
          }, '▶ Oynat (Odayı Kur)'),
          h('button', {
            type: 'button',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 20px',
              borderRadius: '6px',
              background: 'rgba(109, 109, 110, 0.7)',
              border: 'none',
              color: '#ffffff',
              fontWeight: '700',
              fontSize: '14px',
              cursor: 'pointer',
            },
            onclick: () => toast('Organize İşler: Karun Hazinesi · Başrol: Yılmaz Erdoğan, Kıvanç Tatlıtuğ, Ezgi Mola'),
          }, 'ⓘ Daha Fazla Bilgi')
        )
      );

      // Rows matching Screenshot 4 & 5
      const DRAMA_SERIES = [
        { title: 'The Mentalist', meta: 'S7 : B8 "Göz Akı" · 11 / 42 dk.', ep: 'S7:B8', poster: 'https://image.tmdb.org/t/p/w500/acYXu4KaDj1NIkMgObnhe4C4a0T.jpg' },
        { title: 'Dexter', meta: 'Dizi · Suç / Gerilim', poster: 'https://image.tmdb.org/t/p/w500/i8ORB1biusVy703lGxUi5Rle6zA.jpg' },
        { title: 'House M.D.', meta: 'Dizi · Medikal Drama', poster: 'https://image.tmdb.org/t/p/w500/3Cz7ySOQJmqiuTdrc6CY0r65yDI.jpg' },
        { title: 'Breaking Bad', meta: 'Dizi · Suç Klasiği', poster: 'https://image.tmdb.org/t/p/w500/ggFHVNu6YYI5L9pCfOacjizRGt.jpg' },
        { title: 'Cyberpunk: Edgerunners', meta: 'Anime · Bilim Kurgu', poster: 'https://image.tmdb.org/t/p/w500/v3JuB15WybKmxDeT1hWdK3j6eSJ.jpg' },
        { title: 'Vinland Saga', meta: 'Anime · Tarihi Macera', poster: 'https://image.tmdb.org/t/p/w500/vUHlpA5c1NXkds59reY3HMb4Abs.jpg' },
      ];

      const makeCard = (item) => {
        const card = h('div', {
          role: 'button',
          tabindex: '0',
          style: {
            flexShrink: 0,
            width: '180px',
            background: '#181818',
            borderRadius: '6px',
            overflow: 'hidden',
            cursor: 'pointer',
            transition: 'transform .2s ease, box-shadow .2s ease',
            position: 'relative',
          },
          onclick: () => {
            closeModal();
            const mediaObj = {
              provider: 'netflix',
              catalogProvider: 'netflix',
              streamType: 'official',
              title: item.title,
              originalTitle: item.title,
              url: `https://www.netflix.com/search?q=${encodeURIComponent(item.title)}`,
              officialUrl: 'https://www.netflix.com/browse',
              poster: item.poster,
              mediaType: 'tv',
              season: 1,
              episode: 1,
              authenticated: true,
              duration: 2700,
            };
            if (typeof onPickContent === 'function') {
              onPickContent(mediaObj);
            } else {
              location.hash = `#/mesh/netflix-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            }
          },
        },
          h('div', {
            style: {
              width: '100%',
              height: '105px',
              backgroundImage: `url("${item.poster}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center top',
              position: 'relative',
            },
          },
            h('div', {
              style: {
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(to top, rgba(24,24,24,0.9) 0%, transparent 60%)',
              },
            })
          ),
          h('div', { style: { padding: '10px' } },
            h('div', { style: { fontWeight: '700', fontSize: '13px', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.title),
            h('div', { style: { fontSize: '11px', color: '#94a3b8', marginTop: '3px' } }, item.meta),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
              h('span', { style: { width: '22px', height: '22px', borderRadius: '50%', background: '#fff', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '900' } }, '▶'),
              h('span', { style: { width: '22px', height: '22px', borderRadius: '50%', border: '1px solid #808080', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' } }, '+'),
              h('span', { style: { width: '22px', height: '22px', borderRadius: '50%', border: '1px solid #808080', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' } }, '👍')
            )
          )
        );

        card.onmouseenter = () => {
          card.style.transform = 'scale(1.05)';
          card.style.boxShadow = '0 12px 28px rgba(0,0,0,0.8)';
        };
        card.onmouseleave = () => {
          card.style.transform = 'scale(1)';
          card.style.boxShadow = 'none';
        };

        return card;
      };

      const rowsSection = h('div', {
        style: {
          padding: '20px 24px 40px',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
        },
      },
        // Row 1
        h('div', {},
          h('h2', { style: { margin: '0 0 12px', fontSize: '16px', fontWeight: '800', color: '#e5e5e5' } }, 'Amerika Yapımı Drama Dizileri'),
          h('div', {
            style: {
              display: 'flex',
              gap: '12px',
              overflowX: 'auto',
              paddingBottom: '8px',
            },
          }, ...DRAMA_SERIES.slice(0, 4).map(makeCard))
        ),
        // Row 2
        h('div', {},
          h('h2', { style: { margin: '0 0 12px', fontSize: '16px', fontWeight: '800', color: '#e5e5e5' } }, 'Tekrar Tekrar İzlenen Diziler'),
          h('div', {
            style: {
              display: 'flex',
              gap: '12px',
              overflowX: 'auto',
              paddingBottom: '8px',
            },
          }, ...DRAMA_SERIES.map(makeCard))
        )
      );

      bodyArea.appendChild(topBar);
      bodyArea.appendChild(heroBillboard);
      bodyArea.appendChild(rowsSection);
      return;
    }
  };

  // Bottom-right back button circle '<'
  const backNavBtn = h('button', {
    type: 'button',
    style: {
      position: 'absolute',
      bottom: '18px',
      right: '18px',
      width: '38px',
      height: '38px',
      borderRadius: '50%',
      background: 'rgba(255, 255, 255, 0.12)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      color: '#ffffff',
      fontSize: '16px',
      fontWeight: '800',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
      zIndex: '15',
    },
    onclick: () => {
      if (currentStep === 'challenge') { currentStep = 'login'; renderView(); }
      else if (currentStep === 'profiles') { currentStep = 'challenge'; renderView(); }
      else if (currentStep === 'browse') { currentStep = 'profiles'; renderView(); }
      else { closeModal(); }
    },
  }, '<');

  modalContainer.appendChild(renderRaveHeader());
  modalContainer.appendChild(bodyArea);
  modalContainer.appendChild(backNavBtn);

  // Bridge event listener for Netflix picking inside Option B iframe
  const onNetflixBridgeMsg = (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.data.type === 'WATCHLIVO_NETFLIX_PICK') {
      const { watchId, url, title } = ev.data;
      if (!watchId) return;
      toast(`🎬 Netflix "${title || ('#' + watchId)}" seçildi! Canlı oda başlatılıyor...`);
      setConnectedAccount('netflix', {
        loginSatisfied: true,
        userAuthenticated: true,
        accountEmail: 'Netflix Aktif Oturum',
        profileName: 'Netflix',
        extra: { watchId, url },
      });
      window.removeEventListener('message', onNetflixBridgeMsg);
      closeModal();
      onReload?.();

      const mediaObj = {
        id: `netflix-${watchId}`,
        title: title || `Netflix #${watchId}`,
        originalTitle: title || `Netflix #${watchId}`,
        provider: 'netflix',
        catalogProvider: 'netflix',
        streamType: 'official',
        sourceUrl: url || `https://www.netflix.com/watch/${watchId}`,
        url: url || `https://www.netflix.com/watch/${watchId}`,
        mediaType: 'movie',
        authenticated: true,
      };

      if (typeof onPickContent === 'function') {
        onPickContent(mediaObj);
      } else {
        location.hash = `#/mesh/netflix-${watchId}`;
      }
    }
  };
  window.addEventListener('message', onNetflixBridgeMsg);

  const origCloseModal = closeModal;
  closeModal = () => {
    window.removeEventListener('message', onNetflixBridgeMsg);
    origCloseModal();
  };

  renderView();

  modalHandle = popup({
    content: modalContainer,
    wide: true,
    dismissable: true,
    onClose: () => closeModal(),
  });
}


export function openMaxLoginModal(p, onReload, onOpenBrowser) {
  const prov = (typeof p === 'string') ? { id: p, name: 'Max' } : (p || { id: 'max', name: 'Max' });
  const acct = getAccount('max');
  let modalHandle = null;

  let closeModal = () => {
    if (modalHandle?.close) modalHandle.close();
    else document.querySelector('.popup-backdrop')?.remove();
  };

  const connectMaxInstant = async (customEmail = '', customProfile = '') => {
    const cleanProfile = customProfile || acct.profileName || state.self?.name || 'Max Profilim';
    const cleanEmail = customEmail || (acct.accountEmail && !acct.accountEmail.includes('Şifresiz')) ? acct.accountEmail : 'max.abone@watchlivo.online';
    setConnectedAccount('max', {
      loginSatisfied: true,
      userAuthenticated: true,
      accountEmail: cleanEmail,
      profileName: cleanProfile,
      extra: { connectedVia: 'passwordless' },
    });
    try {
      await api('/api/rave/accounts/verify', {
        method: 'POST',
        body: {
          provider: 'max',
          accountEmail: cleanEmail,
          sessionToken: 'max_passwordless_token',
        },
      });
    } catch (_) {}
    await fetchAccounts();
    toast('✓ HBO Max şifresiz oturumu başarıyla bağlandı!');
    closeModal();
    onReload?.();
  };

  const emailInp = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'İsteğe bağlı: Profil adı veya e-posta...',
    value: acct.profileName || 'Max Profilim',
    style: {
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.15)',
      color: '#fff',
      padding: '12px 14px',
      borderRadius: '8px',
      width: '100%',
      boxSizing: 'border-box',
      fontSize: '14px',
    },
  });

  const card = h('div', {
    style: {
      background: '#0d0f17',
      color: '#ffffff',
      borderRadius: '16px',
      padding: '24px 22px',
      maxWidth: '440px',
      width: '100%',
      margin: '0 auto',
      boxShadow: '0 16px 40px rgba(0,0,0,0.8)',
      border: '1px solid rgba(0, 43, 231, 0.35)',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    },
  },
    // Top Bar
    h('div', {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        paddingBottom: '14px',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '3px' } },
        h('span', { style: { fontSize: '24px', fontWeight: '900', letterSpacing: '-0.5px', color: '#ffffff' } }, 'HBO'),
        h('span', { style: { fontSize: '24px', fontWeight: '300', fontStyle: 'italic', color: '#ffffff' } }, 'max')
      ),
      h('div', {
        style: {
          padding: '4px 10px',
          borderRadius: '20px',
          background: 'rgba(16, 185, 129, 0.15)',
          border: '1px solid #10b981',
          color: '#34d399',
          fontSize: '12px',
          fontWeight: '700',
        },
      }, '⚡ Şifresiz Bağlantı')
    ),
    // Status text
    h('div', {
      style: {
        background: 'rgba(0, 43, 231, 0.12)',
        border: '1px solid rgba(0, 43, 231, 0.3)',
        borderRadius: '10px',
        padding: '12px 14px',
        fontSize: '13px',
        lineHeight: '1.45',
        color: '#cbd5e1',
      },
    },
      h('div', { style: { fontWeight: '700', color: '#93c5fd', marginBottom: '4px' } }, '✓ Şifresiz Doğrudan Erişim Aktif'),
      'Max arşivi şifre girmeden tüm odalarda canlı senkronize olarak oynatılabilir. Profilinizi özelleştirebilir veya 1 tıkla oturumu tazeleyebilirsiniz.'
    ),
    emailInp,
    h('button', {
      type: 'button',
      class: 'btn primary',
      style: {
        width: '100%',
        padding: '14px',
        borderRadius: '10px',
        background: 'linear-gradient(135deg, #002be7, #4f46e5)',
        border: 'none',
        color: '#ffffff',
        fontWeight: '800',
        fontSize: '15px',
        cursor: 'pointer',
        boxShadow: '0 4px 16px rgba(0, 43, 231, 0.4)',
      },
      onclick: () => connectMaxInstant(emailInp.value.trim(), emailInp.value.trim()),
    }, '⚡ 1-Tıkla Şifresiz Bağlan / Güncelle'),
    h('button', {
      type: 'button',
      class: 'btn',
      style: {
        width: '100%',
        padding: '10px',
        borderRadius: '8px',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: '#94a3b8',
        fontSize: '13px',
        cursor: 'pointer',
      },
      onclick: () => closeModal(),
    }, 'Kapat')
  );

  modalHandle = popup({
    content: card,
    wide: false,
    dismissable: true,
    onClose: () => closeModal(),
  });
}


export function openProviderLoginModal(p, onReload, onOpenBrowser) {
  const pid = (typeof p === 'string') ? p : p?.id;
  if (pid === 'netflix') {
    return openNetflixLoginModal(p, onReload, onOpenBrowser);
  }
  if (pid === 'max') {
    return openMaxLoginModal(p, onReload, onOpenBrowser);
  }
  const acct = getAccount(p.id);
  let officialOpenedAt = 0;
  const emailInp = h('input', {
    class: 'input',
    type: 'email',
    placeholder: `${p.name} hesap e-posta adresiniz (örn. ad@gmail.com — zorunlu)...`,
    autocomplete: 'email',
    value: (!state.self?.isGuest && state.self?.email) ? state.self.email : '',
  });
  const pwInp = h('input', {
    class: 'input',
    type: 'password',
    placeholder: `${p.name} hesap şifreniz (en az 6 karakter — zorunlu)...`,
    autocomplete: 'current-password',
  });
  const profInp = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Profil Adı (örn. Mert 4K UHD)',
    value: acct.profileName || ((!state.self?.isGuest && state.self?.name) ? state.self.name : '4K UHD'),
  });
  const cookieName = (acct.authCookies || ['session'])[0] || 'session';
  const cookieInp = h('input', {
    class: 'input',
    type: 'text',
    placeholder: `İsteğe bağlı: ${cookieName}=... oturum çerezi veya token`,
  });
  const statusBox = h('div', {
    style: {
      fontSize: '.8rem',
      padding: '8px 10px',
      borderRadius: '10px',
      background: 'rgba(99, 102, 241, 0.08)',
      border: '1px solid rgba(99, 102, 241, 0.25)',
      color: '#cbd5e1',
      lineHeight: '1.4',
    },
  }, `🔐 Güvenlik gereği şifre yazmadan ${p.name} oturumu bağlanamaz. Lütfen e-posta adresinizi ve en az 6 karakterli şifrenizi girin, ardından 1. Adım ve 2. Adım ile oturumu doğrulayın.`);

  let modalHandle = null;
  modalHandle = popup({
    title: `🔑 ${p.name} Şifreli Oturum & Portal Doğrulaması`,
    content: h('form', { onsubmit: (e) => e.preventDefault(), style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      statusBox,
      emailInp,
      pwInp,
      profInp,
      cookieInp,
      acct.loginUrl ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } },
        h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: () => {
            officialOpenedAt = Date.now();
            window.open(acct.loginUrl, 'wl_provider_login', 'width=520,height=680,noopener,noreferrer');
            statusBox.style.borderColor = '#6366f1';
            statusBox.style.color = '#a5b4fc';
            statusBox.textContent = `⏳ ${p.name} resmi giriş penceresi açıldı. E-posta ve şifrenizi girdikten sonra "2. Adım: Şifreyi Doğrula & Bağla" butonuna tıklayın.`;
          },
        }, `🔑 1. Adım: ${p.name} Resmi Giriş Penceresini Aç`),
        onOpenBrowser ? h('button', {
          type: 'button',
          class: 'btn sm',
          onclick: () => {
            if (modalHandle?.close) modalHandle.close();
            else document.querySelector('.popup-backdrop')?.remove();
            onOpenBrowser(acct.loginUrl || acct.browseUrl);
          },
        }, `🌐 Dahili Portal Gezgininde Aç`) : null
      ) : null
    ),
    options: [
      {
        label: '✓ 2. Adım: Şifreyi Doğrula & Bağla',
        primary: true,
        onClick: async () => {
          const em = emailInp.value.trim();
          const pw = pwInp.value;
          const pr = profInp.value.trim() || ((!state.self?.isGuest && state.self?.name) ? state.self.name : '4K UHD');
          const ck = cookieInp.value.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) {
            statusBox.style.borderColor = '#ef4444';
            statusBox.style.color = '#f87171';
            statusBox.textContent = `⚠️ Lütfen geçerli bir ${p.name} e-posta adresi girin (örn. ad@gmail.com).`;
            emailInp.focus();
            return true;
          }
          if (!pw || pw.length < 6 || /^(123456|12345678|password|qwerty|111111)$/i.test(pw)) {
            statusBox.style.borderColor = '#ef4444';
            statusBox.style.color = '#f87171';
            statusBox.textContent = `⚠️ Şifre yazmadan ${p.name} girişi yapılamaz! Lütfen en az 6 karakterli geçerli hesap şifrenizi girin.`;
            pwInp.focus();
            return true;
          }
          const hasValidCookie = ck.length >= 16 && (ck.includes('=') || ck.length >= 24);
          if (!hasValidCookie && !officialOpenedAt) {
            statusBox.style.borderColor = '#f59e0b';
            statusBox.style.color = '#fbbf24';
            statusBox.textContent = `⚠️ Önce "🔑 1. Adım: ${p.name} Resmi Giriş Penceresini Aç" ile tarayıcınızda oturum açın veya oturum çerezinizi (${cookieName}) girin.`;
            return true;
          }
          const local = readLocalAccounts();
          local[p.id] = {
            loginSatisfied: true,
            userAuthenticated: true,
            accountEmail: maskAccountEmail(em),
            profileName: pr,
            updatedAt: Date.now(),
          };
          saveLocalAccounts(local);
          await fetchAccounts();
          toast(`✓ ${p.name} oturumu (${maskAccountEmail(em)}) şifreyle doğrulandı ve bağlandı!`);
          onReload?.();
        },
      },
      ...(acct.loginSatisfied ? [{
        label: 'Bağlantıyı Kes',
        onClick: () => logoutAccount(p.id, onReload),
      }] : []),
      { label: 'Kapat' },
    ],
  });
}

export function renderAccountBar(p, onReload, _onPickUrl, _onPickItem) {
  const pid = (typeof p === 'string') ? p : p?.id;
  if (pid === 'netflix') {
    const prov = (typeof p === 'string') ? { id: p, name: 'Netflix' } : (p || { id: 'netflix', name: 'Netflix' });
    const acct = getAccount('netflix');

    // Case 1: Netflix Account Logged In
    if (acct.loginSatisfied && acct.accountEmail) {
      return h('div', { class: 'rave-auth-wrap netflix-auth-status-wrap', style: { padding: '.5em .8em', marginBottom: '.6em' } },
        h('div', {
          class: 'rave-auth-bar connected netflix-auth-bar-active',
          style: {
            background: 'linear-gradient(90deg, rgba(229, 9, 20, 0.16) 0%, rgba(16, 185, 129, 0.12) 100%), var(--card-surface)',
            border: '1px solid rgba(229, 9, 20, 0.45)',
            borderLeft: '4px solid #e50914',
            borderRadius: '12px',
            padding: '.75em 1.1em',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', {
              style: {
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #e50914, #b20710)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: '900',
                fontSize: '.85rem',
                letterSpacing: '-0.5px',
                boxShadow: '0 2px 10px rgba(229,9,20,0.5)',
                flexShrink: 0,
              },
            }, 'N'),
            h('div', {},
              h('div', {
                class: 'rave-auth-title ok',
                style: { color: '#34d399', fontWeight: '800', fontSize: '.9rem', display: 'flex', alignItems: 'center', gap: '6px' },
              },
                h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981', display: 'inline-block' } }),
                `✓ Resmi Netflix Hesabı [Aktif]`
              ),
              h('div', {
                class: 'rave-auth-sub',
                style: { color: '#94a3b8', fontSize: '.75rem', marginTop: '2px' },
              }, `${acct.accountEmail} · 4K Ultra HD Senkron İzleme Hazır`)
            )
          ),
          h('div', { class: 'rave-auth-actions', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('button', {
              type: 'button',
              class: 'btn sm primary',
              style: {
                background: '#e50914',
                borderColor: '#e50914',
                color: '#fff',
                fontSize: '.78rem',
                fontWeight: '700',
                borderRadius: '8px',
                padding: '.45em .9em',
              },
              onclick: () => window.open('https://www.netflix.com/browse', '_blank'),
            }, '🌐 netflix.com/browse Aç'),
            h('button', {
              type: 'button',
              class: 'btn sm',
              style: {
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.18)',
                color: '#f1f5f9',
                fontSize: '.78rem',
                fontWeight: '600',
                borderRadius: '8px',
                padding: '.45em .9em',
              },
              onclick: () => openNetflixLoginModal(prov, onReload),
            }, 'Hesap Değiştir / Çıkış Yap')
          )
        )
      );
    }

    // Case 2: Netflix Account Not Logged In
    return h('div', { class: 'rave-auth-wrap netflix-auth-status-wrap', style: { padding: '.5em .8em', marginBottom: '.6em' } },
      h('div', {
        class: 'rave-auth-bar netflix-auth-bar-locked',
        style: {
          background: 'linear-gradient(90deg, rgba(229, 9, 20, 0.24) 0%, rgba(15, 23, 42, 0.95) 100%), var(--card-surface)',
          border: '1px solid rgba(229, 9, 20, 0.55)',
          borderLeft: '4px solid #e50914',
          borderRadius: '12px',
          padding: '.85em 1.15em',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
          boxShadow: '0 6px 22px rgba(229, 9, 20, 0.2)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('div', {
            style: {
              width: '34px',
              height: '34px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #e50914, #b20710)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: '900',
              fontSize: '.85rem',
              letterSpacing: '-0.5px',
              boxShadow: '0 2px 10px rgba(229,9,20,0.6)',
              flexShrink: 0,
            },
          }, 'N'),
          h('div', {},
            h('div', {
              class: 'rave-auth-title',
              style: { color: '#f8fafc', fontWeight: '800', fontSize: '.92rem' },
            }, '🔒 Bu içerikleri izlemek için Netflix hesabınızla giriş yapmalısınız'),
            h('div', {
              class: 'rave-auth-sub',
              style: { color: '#94a3b8', fontSize: '.75rem', marginTop: '2px' },
            }, 'Netflix orijinal yapımlarını odadaki tüm arkadaşlarınızla kesintisiz izlemek için hesabınızı bağlayın.')
          )
        ),
        h('div', { class: 'rave-auth-actions' },
          h('button', {
            type: 'button',
            class: 'btn primary sm',
            style: {
              background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
              borderColor: '#e50914',
              color: '#fff',
              fontWeight: '700',
              fontSize: '.82rem',
              padding: '.55em 1.1em',
              borderRadius: '8px',
              boxShadow: '0 4px 14px rgba(229, 9, 20, 0.4)',
            },
            onclick: () => openNetflixLoginModal(prov, onReload),
          }, '🔑 Netflix ile Giriş Yap')
        )
      )
    );
  }

  if (pid === 'max') {
    const prov = (typeof p === 'string') ? { id: p, name: 'Max' } : (p || { id: 'max', name: 'Max' });
    const acct = getAccount('max');

    // Case 1: Max Account Logged In
    if (acct.loginSatisfied && acct.accountEmail) {
      return h('div', { class: 'rave-auth-wrap max-auth-status-wrap', style: { padding: '.5em .8em', marginBottom: '.6em' } },
        h('div', {
          class: 'rave-auth-bar connected max-auth-bar-active',
          style: {
            background: 'linear-gradient(90deg, rgba(0, 43, 231, 0.16) 0%, rgba(16, 185, 129, 0.12) 100%), var(--card-surface)',
            border: '1px solid rgba(16, 185, 129, 0.45)',
            borderLeft: '4px solid #10b981',
            borderRadius: '12px',
            padding: '.75em 1.1em',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', {
              style: {
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #002be7, #2563eb)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: '900',
                fontSize: '.76rem',
                letterSpacing: '-0.5px',
                boxShadow: '0 2px 10px rgba(0,43,231,0.5)',
                flexShrink: 0,
              },
            }, 'MAX'),
            h('div', {},
              h('div', {
                class: 'rave-auth-title ok',
                style: { color: '#34d399', fontWeight: '800', fontSize: '.9rem', display: 'flex', alignItems: 'center', gap: '6px' },
              },
                h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981', display: 'inline-block' } }),
                `✓ Resmi HBO Max Hesabı [Aktif]`
              ),
              h('div', {
                class: 'rave-auth-sub',
                style: { color: '#94a3b8', fontSize: '.75rem', marginTop: '2px' },
              }, `Resmi HBO Max Oturumu Aktif · 4K Ultra HD Senkron İzleme Hazır`)
            )
          ),
          h('div', { class: 'rave-auth-actions', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('button', {
              type: 'button',
              class: 'btn sm',
              style: {
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.18)',
                color: '#f1f5f9',
                fontSize: '.78rem',
                fontWeight: '600',
                borderRadius: '8px',
                padding: '.45em .9em',
              },
              onclick: () => openProviderLoginModal(prov, onReload),
            }, 'Hesap Değiştir / Çıkış Yap')
          )
        )
      );
    }

    // Case 2: Max Account Not Logged In
    return h('div', { class: 'rave-auth-wrap max-auth-status-wrap', style: { padding: '.5em .8em', marginBottom: '.6em' } },
      h('div', {
        class: 'rave-auth-bar max-auth-bar-locked',
        style: {
          background: 'linear-gradient(90deg, rgba(0, 43, 231, 0.24) 0%, rgba(15, 23, 42, 0.95) 100%), var(--card-surface)',
          border: '1px solid rgba(0, 43, 231, 0.55)',
          borderLeft: '4px solid #002be7',
          borderRadius: '12px',
          padding: '.85em 1.15em',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
          boxShadow: '0 6px 22px rgba(0, 43, 231, 0.2)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('div', {
            style: {
              width: '34px',
              height: '34px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #002be7, #1e40af)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: '900',
              fontSize: '.76rem',
              letterSpacing: '-0.5px',
              boxShadow: '0 2px 10px rgba(0,43,231,0.6)',
              flexShrink: 0,
            },
          }, 'MAX'),
          h('div', {},
            h('div', {
              class: 'rave-auth-title',
              style: { color: '#f8fafc', fontWeight: '800', fontSize: '.92rem' },
            }, '🔒 Bu içerikleri izlemek için Max hesabınızla giriş yapmalısınız'),
            h('div', {
              class: 'rave-auth-sub',
              style: { color: '#94a3b8', fontSize: '.75rem', marginTop: '2px' },
            }, 'Max (HBO) orijinal yapımlarını odadaki tüm arkadaşlarınızla kesintisiz izlemek için hesabınızı bağlayın.')
          )
        ),
        h('div', { class: 'rave-auth-actions' },
          h('button', {
            type: 'button',
            class: 'btn primary sm',
            style: {
              background: 'linear-gradient(135deg, #002be7 0%, #2563eb 100%)',
              borderColor: '#3b82f6',
              color: '#fff',
              fontWeight: '700',
              fontSize: '.82rem',
              padding: '.55em 1.1em',
              borderRadius: '8px',
              boxShadow: '0 4px 14px rgba(0, 43, 231, 0.4)',
            },
            onclick: () => openProviderLoginModal(prov, onReload),
          }, '🔑 Max ile Giriş Yap')
        )
      )
    );
  }

  return h('div', { class: 'rave-auth-wrap', style: { display: 'none' } });
}
export async function renderSeriesPicker(item, prov, container, onBack, onPick, resolveFn) {
  const mtype = item.mediaType || (item.type === 'SHOW' ? 'tv' : 'movie');
  const resetPickerScroll = () => {
    try {
      for (const el of [container.closest('.panel-body'), container.closest('.home'), container.closest('.home-scroll'), document.scrollingElement, document.documentElement, document.body]) {
        if (el) el.scrollTop = 0;
      }
      window.scrollTo(0, 0);
    } catch (e) { /* ignore */ }
  };
  container.replaceChildren(
    h('div', { class: 'series-detail', style: { minHeight: '68vh' } },
      h('button', { class: 'btn', onclick: onBack }, '← Kataloğa Dön'),
      h('div', { style: { display: 'flex', justifyContent: 'center', padding: '2.5em 1.5em' } }, h('div', { class: 'spinner' }))));
  resetPickerScroll();

  const fmtClock = (sec) => {
    const sTot = Math.max(0, Math.floor(Number(sec) || 0));
    const hrs = Math.floor(sTot / 3600);
    const mins = Math.floor((sTot % 3600) / 60);
    const secs = sTot % 60;
    return hrs > 0
      ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${mins}:${String(secs).padStart(2, '0')}`;
  };
  const initSavedProg = findSavedProgress(item);
  const initSeason = Math.max(1, Number(item.season || initSavedProg?.season || 1) || 1);
  let curSeason = initSeason;
  let userPickedSeason = Boolean(item.season);
  let seasonReqSeq = 0;
  const loadSeason = async (sNum, fromUserClick = false) => {
    if (fromUserClick) userPickedSeason = true;
    const mySeq = ++seasonReqSeq;
    curSeason = sNum;
    let info = {};
    try {
      info = await api(`/api/rave/seasons?${qs({
        tmdbId: /^\d+$/.test(String(item.tmdbId || '')) ? String(item.tmdbId) : (/^\d+$/.test(String(item.id || '')) ? String(item.id) : ''),
        title: item.title || '',
        mediaType: mtype,
        season: sNum,
        v: '20261110_v175',
      })}`, { timeout: 10000 });
    } catch (e) { /* fallback */ }
    if (mySeq !== seasonReqSeq) return;
    const tid = info.tmdbId || (/^\d+$/.test(String(item.tmdbId || '')) ? String(item.tmdbId) : (/^\d+$/.test(String(item.id || '')) ? String(item.id) : ''));
    const imdbId = info.imdbId || item.imdbId || '';
    const title = info.title || item.title || 'Yapım';
    const origTitle = info.originalTitle || item.originalTitle || title;
    const year = info.year || item.year || '';
    const overview = info.overview || item.overview || `${prov.name} üzerinde tam uzunlukta senkronize izle.`;
    const backdrop = info.backdrop || item.backdrop || item.poster || '/static/watchlivo-poster.svg';
    const poster = info.poster || item.poster || '/static/watchlivo-poster.svg';
    const rating = info.rating || item.rating || '';
    const effMtype = info.mediaType === 'movie' && (!info.seasons || info.seasons.length <= 1) && (!info.episodes || info.episodes.length <= 1) ? 'movie' : mtype;
    const seasons = info.seasons?.length ? info.seasons : (mtype === 'tv' ? [{ season: 1, name: '1. Sezon' }] : []);
    const episodes = info.episodes?.length ? info.episodes : (mtype === 'tv' ? [{
      episode: 1, season: sNum, name: '1. Bölüm', overview: `${title} ${sNum}. Sezon 1. Bölüm`, runtime: 45, still: backdrop,
    }] : []);

    const rawSavedProg = findSavedProgress({ tmdbId: tid, title, originalTitle: origTitle, mediaType: effMtype });
    let savedProg = rawSavedProg ? { ...rawSavedProg } : null;
    if (savedProg && effMtype === 'tv' && seasons.length > 1) {
      const spS = Math.max(1, Number(savedProg.season || 1));
      const spE = Math.max(1, Number(savedProg.episode || 1));
      const s1Max = Math.max(1, Number(seasons[0]?.count || 0));
      if (spS === 1 && s1Max > 0 && spE > s1Max) {
        let remEp = spE;
        for (const sObj of seasons) {
          const cCnt = Math.max(1, Number(sObj.count || 0));
          if (remEp <= cCnt || sObj === seasons[seasons.length - 1]) {
            savedProg.season = Number(sObj.season || 1);
            savedProg.episode = Math.max(1, remEp);
            break;
          }
          remEp -= cCnt;
        }
        if (!userPickedSeason && savedProg.season !== curSeason) {
          return loadSeason(savedProg.season, true);
        }
      }
    }
    const savedSec = Number(savedProg?.currentTime ?? savedProg?.position ?? 0) > 3 && Number(savedProg?.percent || 0) < 96
      ? Math.floor(Number(savedProg.currentTime ?? savedProg.position ?? 0))
      : 0;
    let busyPlay = false;
    const playEp = async (s, e, epName = '', btnEl = null, resumeAtSec = 0, forceFromStart = false) => {
      if (busyPlay) return;
      busyPlay = true;
      const origTxt = btnEl ? btnEl.textContent : '';
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '⏳ Yayın Hazırlanıyor...';
      }
      const startSec = forceFromStart ? 0 : Math.max(0, Math.floor(Number(resumeAtSec) || 0));
      toast(startSec > 3
        ? `⏩ ${title}${effMtype === 'tv' ? ` (${s}. Sezon ${e}. Bölüm)` : ''} · ${fmtClock(startSec)} anından devam ediliyor...`
        : `🎬 ${title}${effMtype === 'tv' ? ` (${s}. Sezon ${e}. Bölüm)` : ''} hazırlanıyor...`);
      try {
        const media = await resolveFn({ ...item, tmdbId: tid, imdbId, title, originalTitle: origTitle, year, poster: backdrop || poster, mediaType: effMtype }, prov, s, e, epName, { applySavedResume: !forceFromStart });
        if (media) {
          if (forceFromStart) {
            media.currentTime = 0;
            media.meshStatePosition = 0;
          } else if (startSec > 3) {
            media.currentTime = startSec;
            media.meshStatePosition = startSec;
          }
          await onPick(media);
        }
      } finally {
        busyPlay = false;
        if (btnEl && btnEl.isConnected) {
          btnEl.disabled = false;
          btnEl.textContent = origTxt;
        }
      }
    };

    const switchSeason = (targetSeason, btnEl = null) => {
      const nextS = Math.max(1, Number(targetSeason) || 1);
      if (nextS === curSeason) return;
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = `⏳ ${nextS}. Sezon...`;
      }
      const gridEl = container.querySelector('.episode-grid');
      if (gridEl) gridEl.style.opacity = '0.45';
      loadSeason(nextS, true);
    };

    const resumeHeroBtn = savedSec > 3 ? h('button', {
      class: 'btn primary',
      id: 'btn-resume-saved',
      onclick: (ev) => playEp(Number(savedProg?.season || curSeason), Number(savedProg?.episode || 1), '', ev.currentTarget, savedSec),
    }, effMtype === 'tv'
      ? `▶ Devam Et (${savedProg?.season || 1}. Sezon ${savedProg?.episode || 1}. Bölüm · ${fmtClock(savedSec)})`
      : `▶ Kaldığın Yerden Devam Et (${fmtClock(savedSec)})`) : null;

    const primaryPlayBtn = h('button', {
      class: resumeHeroBtn ? 'btn' : 'btn primary',
      id: 'btn-play-primary',
      onclick: (ev) => playEp(curSeason, 1, episodes[0]?.name || '', ev.currentTarget, 0, Boolean(resumeHeroBtn)),
    }, effMtype === 'tv' ? `▶ ${curSeason}. Sezon 1. Bölümü ${resumeHeroBtn ? 'Baştan ' : ''}Başlat` : `▶ Tam Filmi ${resumeHeroBtn ? 'Baştan ' : 'Odada '}Başlat (1080p)`);

    const heroSeasonPicker = (effMtype === 'tv' && seasons.length > 1) ? h('div', {
      class: 'hero-season-picker',
      style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '8px 0 10px' },
    },
    h('span', { style: { fontSize: '.78rem', fontWeight: '700', color: '#a5b4fc', marginRight: '2px' } }, '📚 Sezon Seç:'),
    ...seasons.slice(0, 8).map((s) => h('button', {
      type: 'button',
      class: `btn sm season-pill ${s.season === curSeason ? 'primary' : ''}`,
      style: { padding: '5px 10px', fontSize: '.78rem', borderRadius: '999px' },
      onclick: (ev) => switchSeason(s.season, ev.currentTarget),
    }, `${s.season}. Sezon${s.count ? ` (${s.count})` : ''}`)),
    seasons.length > 8 ? h('select', {
      class: 'season-select-dropdown',
      style: { background: 'rgba(15,23,42,.9)', color: '#f8fafc', border: '1px solid rgba(99,102,241,.45)', borderRadius: '999px', padding: '5px 10px', fontSize: '.78rem', fontWeight: '600' },
      onchange: (ev) => switchSeason(ev.target.value),
    }, ...seasons.map((s) => h('option', { value: String(s.season), selected: s.season === curSeason ? 'selected' : undefined }, `${s.name || `${s.season}. Sezon`}${s.count ? ` (${s.count} Bölüm)` : ''}`))) : null) : null;

    const safeBackdropCss = String(backdrop || '').replace(/["'()\\\r\n]/g, '');
    const detail = h('div', { class: 'series-detail fade-in' },
      h('div', { class: 'series-hero', style: { backgroundImage: `linear-gradient(180deg, rgba(11,10,18,.45), rgba(11,10,18,.96)), url("${safeBackdropCss}")` } },
        h('div', { class: 'series-top-row' },
          h('button', { class: 'btn', onclick: onBack }, '← Kataloğa Dön'),
          h('span', { class: 'series-badge' }, `${effMtype === 'tv' ? `📺 DİZİ • ${seasons.length} Sezon` : '🎬 FİLM'}${year ? ` • ${year}` : ''}${rating ? ` • ⭐ ${rating}` : ''}`)),
        h('div', { class: 'series-hero-body' },
          h('img', {
            class: 'series-poster',
            src: poster || `/api/rave/poster?${qs({ tid: tid || '', t: title || '', ot: origTitle || '', y: year || '', mt: mtype })}`,
            alt: title,
            onerror: (e) => {
              const el = e.currentTarget || e.target;
              if (!el.dataset.healed && (title || tid)) {
                el.dataset.healed = '1';
                el.src = `/api/rave/poster?${qs({ tid: tid || '', t: title || '', ot: origTitle || '', y: year || '', mt: mtype })}`;
              } else {
                el.src = '/static/watchlivo-poster.svg';
              }
            },
          }),
          h('div', { class: 'series-meta' },
            h('h2', {}, title),
            h('p', { class: 'series-overview' }, overview),
            heroSeasonPicker,
            h('div', { class: 'series-cta-row', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, resumeHeroBtn, primaryPlayBtn)))));

    if (effMtype === 'tv') {
      const seasonBar = h('div', { class: 'season-tabs' },
        ...seasons.map((s) => {
          const sLabel = `${s.name || `${s.season}. Sezon`}${s.count ? ` (${s.count} Bölüm)` : ''}`;
          return h('button', {
            class: `btn season-tab ${s.season === curSeason ? 'primary' : ''}`,
            onclick: (ev) => switchSeason(s.season, ev.currentTarget),
          }, sLabel);
        }));

      const epGrid = h('div', { class: 'episode-grid' },
        ...episodes.map((ep) => {
          const rawEpName = String(ep.name || '').replace(/\s*\([^)]*HD[^)]*\)/gi, '').trim();
          const isRedundantEpName = !rawEpName || new RegExp(`^(?:${ep.episode}\\.\\s*bölüm|bölüm\\s*${ep.episode}|episode\\s*${ep.episode})$`, 'i').test(rawEpName);
          const epTitleText = isRedundantEpName
            ? `${ep.episode}. Bölüm`
            : `${ep.episode}. Bölüm — ${rawEpName}`;
          const absEpVal = Number(ep.absEpisode || ep.episode || 1);
          const epProg = findSavedProgress({ tmdbId: tid, title, originalTitle: origTitle, mediaType: effMtype }, curSeason, ep.episode)
            || (curSeason > 1 && absEpVal > ep.episode ? findSavedProgress({ tmdbId: tid, title, originalTitle: origTitle, mediaType: effMtype }, 1, absEpVal) : null);
          const epProgSec = Number(epProg?.currentTime ?? epProg?.position ?? 0) > 3 && Number(epProg?.percent || 0) < 96
            ? Math.floor(Number(epProg.currentTime ?? epProg.position ?? 0))
            : 0;
          const isSavedEp = epProgSec > 3;
          const epStartSec = isSavedEp ? epProgSec : 0;
          const rawDesc = String(ep.overview || '').trim();
          const cleanDesc = (!rawDesc || new RegExp(`^${curSeason}\\.\\s*Sezon\\s*${ep.episode}\\.\\s*Bölüm$`, 'i').test(rawDesc))
            ? `${title} · ${curSeason}. Sezon ${ep.episode}. Bölüm (${ep.runtime || 24} dk HD)`
            : rawDesc;
          return h('div', {
            class: `episode-card ${isSavedEp ? 'is-saved-resume' : ''}`, role: 'button', tabindex: '0',
            onclick: (ev) => playEp(curSeason, ep.episode, isRedundantEpName ? '' : rawEpName, ev.currentTarget.querySelector('.episode-play'), epStartSec),
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                playEp(curSeason, ep.episode, isRedundantEpName ? '' : rawEpName, null, epStartSec);
              }
            },
          },
          h('div', { class: 'episode-thumb' },
            h('img', { src: ep.still || backdrop, alt: '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
            h('span', {
              class: 'episode-season-badge',
              style: { position: 'absolute', top: '8px', left: '8px', background: 'rgba(15,23,42,.88)', color: '#e0e7ff', border: '1px solid rgba(99,102,241,.45)', borderRadius: '8px', padding: '3px 8px', fontSize: '.72rem', fontWeight: '700', backdropFilter: 'blur(6px)' },
            }, `${curSeason}. Sezon · ${ep.episode}. Bölüm`),
            h('span', { class: 'episode-dur' }, isSavedEp ? `⏱ ${fmtClock(epStartSec)} / ${ep.runtime || 45} dk` : `${ep.runtime || 45} dk`),
            h('span', { class: 'episode-play' }, isSavedEp ? `▶ ${fmtClock(epStartSec)}'ten Devam Et` : '▶ Bölümü Başlat')),
          h('div', { class: 'episode-info' },
            h('div', { class: 'episode-title' }, epTitleText),
            h('div', { class: 'episode-desc' }, cleanDesc)));
        }));

      detail.append(
        h('div', { class: 'section-head', style: { padding: '.8em 4px .3em', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
          h('h2', {}, `📺 ${curSeason}. Sezon Bölümleri (${episodes.length} Bölüm)`),
          seasons.length > 1 ? h('select', {
            class: 'season-select-dropdown',
            'aria-label': 'Sezon Seçin',
            style: { background: 'rgba(15,23,42,.92)', color: '#f8fafc', border: '1px solid rgba(99,102,241,.55)', borderRadius: '10px', padding: '6px 12px', fontSize: '.82rem', fontWeight: '700', cursor: 'pointer' },
            onchange: (ev) => switchSeason(ev.target.value),
          }, ...seasons.map((s) => h('option', { value: String(s.season), selected: s.season === curSeason ? 'selected' : undefined }, `${s.name || `${s.season}. Sezon`}${s.count ? ` (${s.count} Bölüm)` : ''}`))) : h('span', { class: 'dim' }, `${seasons.length} sezon · ${episodes.length} bölüm hazır`)),
        seasonBar,
        epGrid);
    }
    container.replaceChildren(detail);
  };

  await loadSeason(initSeason);
}
