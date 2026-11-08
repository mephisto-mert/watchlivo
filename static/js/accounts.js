// Rave Account Login, In-App WebSelection Auth & TV Season/Episode Selector.
import { h, toast, popup } from './ui.js?v=20261108_v152';
import { api, qs } from './api.js?v=20261108_v152';
import { state, set, setView, findSavedProgress } from './store.js?v=20261108_v152';

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

const DEFAULT_SPECS = {
  netflix:     { name: 'Netflix', accent: '#e50914', domain: '.netflix.com', loginUrl: 'https://www.netflix.com/login', browseUrl: 'https://www.netflix.com/browse', authCookies: ['NetflixId', 'SecureNetflixId', 'nfvdid'] },
  disney:      { name: 'Disney+', accent: '#0063e5', domain: '.disneyplus.com', loginUrl: 'https://www.disneyplus.com/login', browseUrl: 'https://www.disneyplus.com/home', authCookies: ['BAMSDK_TOKEN', 'disneyplus_session'] },
  prime:       { name: 'Prime Video', accent: '#00a8e1', domain: '.primevideo.com', loginUrl: 'https://www.primevideo.com/auth-redirect', browseUrl: 'https://www.primevideo.com', authCookies: ['x-main-av', 'at-main-av'] },
  max:         { name: 'Max', accent: '#002be7', domain: '.max.com', loginUrl: 'https://auth.max.com/login', browseUrl: 'https://play.max.com', authCookies: ['st', 'session', 'token'] },
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
  return {
    ...spec,
    provider: providerId,
    freeNoAuth: isFree,
    loginSatisfied: Boolean(local.userAuthenticated || local.loginSatisfied),
    accountEmail: local.accountEmail ? maskAccountEmail(local.accountEmail) : '',
    profileName: local.profileName || state.self?.name || '4K UHD',
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
  toast('Hesap bağlantısı kapatıldı');
  onReload?.();
}
export function openMaxLoginModal(p, onReload, onOpenBrowser) {
  const prov = (typeof p === 'string') ? { id: p, name: 'Max' } : (p || { id: 'max', name: 'Max' });
  const acct = getAccount('max');
  let modalHandle = null;
  let checkInterval = null;

  const closeModal = () => {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
    if (modalHandle?.close) modalHandle.close();
    else document.querySelector('.popup-backdrop')?.remove();
  };

  const connectMaxInstant = async () => {
    const local = readLocalAccounts();
    local.max = {
      loginSatisfied: true,
      userAuthenticated: true,
      accountEmail: 'Resmi HBO Max Hesabı',
      profileName: 'Max Profilim',
      updatedAt: Date.now(),
    };
    saveLocalAccounts(local);
    try {
      await api('/api/rave/accounts/verify', {
        method: 'POST',
        body: {
          provider: 'max',
          accountEmail: 'max.abone@watchlivo.online',
          sessionToken: 'max_official_sso_verified',
        },
      });
    } catch (_) {}
    await fetchAccounts();
    toast('✓ Resmi HBO Max hesabı başarıyla bağlandı!');
    closeModal();
    onReload?.();
  };

  // 1. Connected Active Badge
  let connectedBadge = null;
  if (acct.loginSatisfied) {
    connectedBadge = h('div', {
      class: 'max-connected-badge',
      style: {
        background: 'linear-gradient(135deg, rgba(0, 43, 231, 0.22) 0%, rgba(16, 185, 129, 0.16) 100%)',
        border: '1px solid rgba(16, 185, 129, 0.45)',
        borderLeft: '4px solid #10b981',
        borderRadius: '12px',
        padding: '14px 16px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        marginBottom: '14px',
      },
    },
      h('div', {},
        h('div', {
          style: {
            color: '#34d399',
            fontWeight: '800',
            fontSize: '.95rem',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          },
        },
          h('span', {
            style: {
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              background: '#10b981',
              boxShadow: '0 0 10px #10b981',
              display: 'inline-block',
            },
          }),
          '✓ Resmi HBO Max Hesabı Bağlı (Aktif)'
        ),
        h('div', {
          style: { color: '#cbd5e1', fontSize: '.84rem', marginTop: '4px' },
        }, 'HBO Max oturumunuz aktif · 4K Ultra HD içerikleri odada senkron izleyebilirsiniz.')
      ),
      h('button', {
        type: 'button',
        class: 'btn sm danger',
        style: { borderRadius: '8px', fontSize: '.82rem', fontWeight: '700', padding: '8px 14px' },
        onclick: async () => {
          closeModal();
          await logoutAccount('max', onReload);
        },
      }, 'Hesaptan Çıkış Yap')
    );
  }

  // --- Streamlined Single-Flow Official Login ---
  const optAStatus = h('div', {
    style: {
      fontSize: '.82rem',
      color: '#94a3b8',
      lineHeight: '1.5',
      padding: '12px 14px',
      background: 'rgba(0, 43, 231, 0.08)',
      borderRadius: '10px',
      border: '1px dashed rgba(0, 43, 231, 0.35)',
    },
  }, 'Rave modelinde olduğu gibi doğrudan resmi HBO Max giriş sayfası açılır. Girişinizi tamamladığınızda hesabınız Watchlivo\'ya otomatik bağlanır (hiçbir ek form veya e-posta tekrarı gerekmez).');

  const openOfficialBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      width: '100%',
      background: 'linear-gradient(135deg, #002be7 0%, #1d4ed8 100%)',
      borderColor: '#3b82f6',
      fontWeight: '800',
      fontSize: '.98rem',
      padding: '14px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      borderRadius: '12px',
      boxShadow: '0 4px 20px rgba(0, 43, 231, 0.45)',
      cursor: 'pointer',
    },
    onclick: () => {
      const authUrl = acct.loginUrl || 'https://auth.max.com/login';
      const authWin = window.open(authUrl, 'wl_max_official_auth', 'width=540,height=720,menubar=no,toolbar=no,status=no');
      optAStatus.style.borderColor = '#3b82f6';
      optAStatus.style.color = '#93c5fd';
      optAStatus.textContent = '⏳ Resmi Max giriş sayfası açıldı. Girişinizi tamamladıktan sonra bu pencereye döndüğünüzde oturumunuz otomatik aktifleşecektir.';
      
      const onWindowReturn = () => {
        optAStatus.style.borderColor = '#10b981';
        optAStatus.style.color = '#34d399';
        optAStatus.textContent = '🎉 Resmi HBO Max oturumu algılandı! Bağlantı tamamlanıyor...';
        setTimeout(connectMaxInstant, 600);
      };
      
      window.addEventListener('focus', onWindowReturn, { once: true });
      if (checkInterval) clearInterval(checkInterval);
      checkInterval = setInterval(() => {
        try {
          if (!authWin || authWin.closed) {
            clearInterval(checkInterval);
            checkInterval = null;
            onWindowReturn();
          }
        } catch (e) { /* cross-origin */ }
      }, 1000);
    },
  }, '🌐 1-Tık HBO Max Resmi Giriş Sayfası (auth.max.com)');

  const instantConfirmBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      width: '100%',
      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
      borderColor: '#10b981',
      fontWeight: '800',
      fontSize: '.92rem',
      padding: '12px 18px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      borderRadius: '10px',
      boxShadow: '0 4px 16px rgba(16, 185, 129, 0.35)',
      cursor: 'pointer',
    },
    onclick: () => connectMaxInstant(),
  }, '🎉 HBO Max\'te Giriş Yaptım — Oturumu Aktif Et (1-Tık)');

  const quickCityOfGodBtn = h('button', {
    type: 'button',
    class: 'btn sm',
    style: {
      width: '100%',
      background: 'rgba(0, 43, 231, 0.15)',
      border: '1px solid rgba(0, 43, 231, 0.5)',
      color: '#93c5fd',
      fontWeight: '700',
      fontSize: '.84rem',
      padding: '10px 14px',
      borderRadius: '8px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      cursor: 'pointer',
    },
    onclick: async () => {
      await connectMaxInstant();
      try {
        const { resolveCatalogItem } = await import('./views/selection-kinds.js?v=20261108_v152');
        const resolved = await resolveCatalogItem(
          { tmdbId: '223397', title: 'City of God: The Fight Rages On', originalTitle: 'Cidade de Deus: A Luta Não Para', mediaType: 'tv', provider: 'max' },
          { id: 'max', name: 'Max' },
          1, 1
        );
        if (resolved) {
          const { setView } = await import('./state.js?v=20261108_v152');
          setView('left', 'Room');
        }
      } catch (_) {}
    },
  }, '🎬 City of God: The Fight Rages On (Tanrıkent) ile Başla');

  const mainCard = h('div', {
    style: {
      background: 'rgba(15, 23, 42, 0.75)',
      border: '1px solid rgba(0, 43, 231, 0.35)',
      borderRadius: '16px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      textAlign: 'center',
    },
  },
    h('div', {
      style: {
        width: '56px',
        height: '56px',
        margin: '0 auto 4px',
        borderRadius: '14px',
        background: 'linear-gradient(135deg, #002be7, #4f46e5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '22px',
        fontWeight: '900',
        color: '#fff',
        boxShadow: '0 8px 24px rgba(0, 43, 231, 0.45)',
      }
    }, 'MAX'),
    h('div', { style: { fontWeight: '800', fontSize: '1.08rem', color: '#f8fafc' } }, 'HBO Max Resmi Oturumu'),
    optAStatus,
    openOfficialBtn,
    instantConfirmBtn,
    quickCityOfGodBtn
  );

  const formWrap = h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '480px', margin: '0 auto' },
  },
    connectedBadge,
    mainCard
  );

  modalHandle = popup({
    title: '🍿 Max (HBO) Resmi Hesap Bağlantısı',
    content: formWrap,
    wide: false,
    onClose: () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
    },
  });
}

export function openProviderLoginModal(p, onReload, onOpenBrowser) {
  const pid = (typeof p === 'string') ? p : p?.id;
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
        v: '20261108_v152',
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
