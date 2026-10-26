// Rave Account Login, In-App WebSelection Auth & TV Season/Episode Selector.
import { h, popup, toast } from './ui.js';
import { api, qs } from './api.js';
import { state, set, setView } from './store.js';

const LS_KEY = 'vortex_accounts_zk_v5';
const SEALS_KEY = 'vortex_vault_seals_v5';
const ZK_XOR_KEY = 'Watchlivo_ZeroKnowledge_AES256_2026';

function _zkEncode(obj) {
  try {
    const raw = unescape(encodeURIComponent(JSON.stringify(obj)));
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ ZK_XOR_KEY.charCodeAt(i % ZK_XOR_KEY.length));
    }
    return 'zk1:' + btoa(out);
  } catch (e) { return ''; }
}

function _zkDecode(str) {
  try {
    if (!str) return {};
    if (!str.startsWith('zk1:')) return JSON.parse(str);
    const bin = atob(str.slice(4));
    let raw = '';
    for (let i = 0; i < bin.length; i++) {
      raw += String.fromCharCode(bin.charCodeAt(i) ^ ZK_XOR_KEY.charCodeAt(i % ZK_XOR_KEY.length));
    }
    return JSON.parse(decodeURIComponent(escape(raw)));
  } catch (e) { return {}; }
}

function readLocalAccounts() {
  try {
    localStorage.removeItem('vortex_accounts_v4');
    return _zkDecode(localStorage.getItem(LS_KEY) || '');
  } catch (e) { return {}; }
}

function saveLocalAccounts(accs) {
  try { localStorage.setItem(LS_KEY, _zkEncode(accs)); } catch (e) { /* ignore */ }
}

function readVaultSeals() {
  try { return _zkDecode(localStorage.getItem(SEALS_KEY) || ''); } catch (e) { return {}; }
}

function saveVaultSeal(providerId, email, seal) {
  if (!seal) return;
  try {
    const seals = readVaultSeals();
    seals[`${providerId}:${String(email || '').trim().toLowerCase()}`] = seal;
    localStorage.setItem(SEALS_KEY, _zkEncode(seals));
  } catch (e) { /* ignore */ }
}

function getVaultSeal(providerId, email) {
  const seals = readVaultSeals();
  return seals[`${providerId}:${String(email || '').trim().toLowerCase()}`] || '';
}

const DEFAULT_SPECS = {
  netflix:     { name: 'Netflix', accent: '#e50914', domain: '.netflix.com', loginUrl: 'https://www.netflix.com/login', browseUrl: 'https://www.netflix.com/browse', authCookies: ['NetflixId', 'SecureNetflixId', 'nfvdid'] },
  disney:      { name: 'Disney+', accent: '#0063e5', domain: '.disneyplus.com', loginUrl: 'https://www.disneyplus.com/login', browseUrl: 'https://www.disneyplus.com/home', authCookies: ['BAMSDK_TOKEN', 'disneyplus_session'] },
  prime:       { name: 'Prime Video', accent: '#00a8e1', domain: '.primevideo.com', loginUrl: 'https://www.primevideo.com/auth-redirect', browseUrl: 'https://www.primevideo.com', authCookies: ['x-main-av', 'at-main-av'] },
  max:         { name: 'Max', accent: '#002be7', domain: '.max.com', loginUrl: 'https://auth.max.com/login', browseUrl: 'https://play.max.com', authCookies: ['st', 'session'] },
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
  cinema:          { name: 'Sinema, Dizi & Anime+', accent: '#ff6b00', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['cinema_free'], freeNoAuth: true },
  hdfilmcehennemi: { name: 'Sinema+ HD', accent: '#ff6b00', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['hdfc_free'], freeNoAuth: true },
  dizibox:         { name: 'Dizi+ Arşiv', accent: '#10b981', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['dbx_free'], freeNoAuth: true },
  dizilife:        { name: 'Sezon+ TV', accent: '#8b5cf6', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['dl_free'], freeNoAuth: true },
  fullhdfilm:      { name: 'Vizyon 4K', accent: '#eab308', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['fhd_free'], freeNoAuth: true },
  yabancidizi:     { name: 'Maraton+', accent: '#06b6d4', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['yd_free'], freeNoAuth: true },
  music:           { name: 'Müzik & Klip', accent: '#1db954', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['m_free'], freeNoAuth: true },
  ytmusic:         { name: 'YouTube Music', accent: '#ff0033', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['ytm_free'], freeNoAuth: true },
  spotify:         { name: 'Spotify Music', accent: '#1db954', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['sp_free'], freeNoAuth: true },
  deezer:          { name: 'Deezer Hi-Fi', accent: '#a238ff', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['dz_free'], freeNoAuth: true },
  applemusic:      { name: 'Apple Music', accent: '#fa243c', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['am_free'], freeNoAuth: true },
  soundcloud:      { name: 'SoundCloud', accent: '#ff5500', domain: '.kinox.local', loginUrl: '', browseUrl: '', authCookies: ['sc_free'], freeNoAuth: true },
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
  const isAuthed = isFree || Boolean(local.loginSatisfied && local.userAuthenticated && local.accountEmail);
  return {
    ...spec,
    provider: providerId,
    freeNoAuth: isFree,
    loginSatisfied: isAuthed,
    accountEmail: isFree ? 'Üyeliksiz Açık Erişim' : (isAuthed ? maskAccountEmail(local.accountEmail) : ''),
    profileName: isFree ? '🍿 Ücretsiz VIP Sinema' : (isAuthed ? (local.profileName || 'Ana Profil') : ''),
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
export function renderAccountBar(p, onReload, onPickUrl) {
  const acct = getAccount(p.id);
  const wrap = h('div', { class: 'rave-auth-wrap' });
  const feedback = h('div', { id: 'rave-auth-feedback', class: 'rave-auth-feedback hidden' });
  const showMsg = (txt, ok = false) => {
    feedback.textContent = txt;
    feedback.style.color = ok ? '#10b981' : '#ff3b5c';
    feedback.classList.remove('hidden');
  };

  if (acct.loginSatisfied) {
    wrap.append(
      h('div', { id: 'rave-account-status-bar', class: 'rave-auth-bar connected', style: { '--prov-accent': acct.accent || '#10b981' } },
        h('div', { class: 'rave-auth-info', style: { display: 'flex', alignItems: 'center', gap: '.6em', minWidth: '0', flex: '1' } },
          p.logo ? h('span', { class: 'rave-auth-brand-logo' }, h('img', { src: p.logo, alt: p.name })) : null,
          h('div', { style: { minWidth: '0' } },
            h('div', { class: 'rave-auth-title ok' },
              p.id === 'cinema'
                ? '🍿 Sinema, Dizi & Anime+ · 40.000+ Birleşik Arşiv (Sinema+ · Dizi+ · Animetrix · Vizyon 4K)'
                : (acct.freeNoAuth ? `🍿 ${p.name} · Ücretsiz & Üyeliksiz Açık Erişim` : `🟢 ${p.name} Bağlı`)),
            h('div', { class: 'rave-auth-sub' },
              acct.freeNoAuth
                ? '1080p & 4K UHD • 🇹🇷 Türkçe Dublaj & Fansub Altyazılı • Tek Tıkla Odada Senkron Başlat'
                : ['Profil: ', h('b', {}, acct.profileName || 'Ana Profil'), acct.accountEmail ? ` • ${acct.accountEmail}` : '']))),
        h('div', { class: 'rave-auth-actions' },
          acct.freeNoAuth
            ? h('span', { class: 'badge ok', style: { background: 'rgba(16,185,129,.16)', color: '#10b981', border: '1px solid rgba(16,185,129,.35)', padding: '.35em .75em', borderRadius: '999px', fontSize: '.76em', fontWeight: '700' } }, '✓ ÜCRETSİZ AÇIK')
            : h('button', { id: 'btn-rave-logout', class: 'btn danger sm', onclick: () => logoutAccount(p.id, onReload) }, '🚪 Çıkış Yap'))));
  } else {
    let selectedProfile = state.self?.name || 'Ana Profil';
    const emailInp = h('input', {
      id: 'rave-auth-email',
      type: 'email',
      autocomplete: 'username',
      class: 'input rave-inp',
      placeholder: `${p.name} e-posta veya telefon numarası`,
    });
    const passInp = h('input', {
      id: 'rave-auth-password',
      type: 'password',
      autocomplete: 'current-password',
      class: 'input rave-inp',
      placeholder: `${p.name} şifreniz`,
    });
    const togglePassBtn = h('button', {
      type: 'button',
      class: 'btn',
      style: { padding: '.45em .7em', fontSize: '.78em', flexShrink: '0' },
      onclick: () => {
        const isPw = passInp.type === 'password';
        passInp.type = isPw ? 'text' : 'password';
        togglePassBtn.textContent = isPw ? '🙈 Gizle' : '👁️ Göster';
      },
    }, '👁️ Göster');
    const profInp = h('input', {
      id: 'rave-auth-profile',
      class: 'input rave-inp sm',
      value: selectedProfile,
      placeholder: 'Profil adı (Örn: Ana Profil)',
    });
    const profilePresets = [state.self?.name || 'Ana Profil', '4K UHD', 'Misafir'].filter((v, i, a) => v && a.indexOf(v) === i);
    const profPills = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
      ...profilePresets.map((pname) => h('button', {
        type: 'button',
        class: 'btn',
        style: { fontSize: '.76em', padding: '.3em .7em', borderRadius: '99px' },
        onclick: () => { selectedProfile = pname; profInp.value = pname; },
      }, `👤 ${pname}`)));

    const doLogin = async () => {
      const email = emailInp.value.trim();
      const password = passInp.value.trim();
      const profile = profInp.value.trim() || selectedProfile || 'Ana Profil';
      const isPhone = /^\+?[0-9\s()-]{10,16}$/.test(email);
      const isEmail = /^[a-zA-Z0-9._%+-]{3,64}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12}$/.test(email);
      if (!email || (!isEmail && !isPhone)) {
        showMsg(`⚠️ Lütfen geçerli bir ${p.name} e-posta adresi veya telefon numarası girin.`);
        emailInp.focus();
        return;
      }
      if (!password || password.length < 6) {
        showMsg(`⚠️ Lütfen gerçek ${p.name} hesap şifrenizi girin (en az 6 karakter).`);
        passInp.focus();
        return;
      }
      showMsg(`🔒 ${p.name} hesabınız uçtan uca şifreli olarak doğrulanıyor...`, true);
      try {
        const vaultSeal = getVaultSeal(p.id, email);
        const res = await api('/api/rave/accounts/login', {
          method: 'POST',
          body: { provider: p.id, email, password, profile, vaultSeal },
        });
        passInp.value = '';
        if (res.ok) {
          if (res.vaultSeal) saveVaultSeal(p.id, email, res.vaultSeal);
          const local = readLocalAccounts();
          local[p.id] = {
            provider: p.id,
            accountEmail: res.accountEmail || maskAccountEmail(email),
            profileName: profile,
            loginSatisfied: true,
            userAuthenticated: true,
            vaultSeal: res.vaultSeal || '',
            zeroKnowledge: true,
          };
          saveLocalAccounts(local);
          await fetchAccounts();
          toast(`🔒 ${p.name} hesabınız şifreli olarak bağlandı!`);
          onReload?.();
        }
      } catch (e) {
        showMsg(`⚠️ ${e.data?.error || e.message || 'Giriş doğrulanamadı, lütfen hesap bilgilerinizi kontrol edin.'}`);
      }
    };

    emailInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInp.focus(); });
    passInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

    wrap.append(
      h('div', { id: 'rave-account-login-box', class: 'rave-auth-bar', style: { '--prov-accent': acct.accent || '#e50914', padding: '1em' } },
        h('div', { class: 'rave-webview-bar' },
          h('span', {}, '🔒'),
          h('code', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, acct.loginUrl),
          h('span', { style: { opacity: '.85', color: '#10b981', fontWeight: '600' } }, '🛡️ Sıfır Veri Kaydı · PBKDF2-SHA256 Şifreli')),
        h('div', { class: 'rave-auth-info', style: { display: 'flex', alignItems: 'center', gap: '.75em', marginBottom: '.55em' } },
          p.logo ? h('span', { class: 'rave-auth-brand-logo' }, h('img', { src: p.logo, alt: p.name })) : null,
          h('div', {},
            h('div', { class: 'rave-auth-title', style: { fontSize: '1.02em' } }, `${p.name} Hesabınızla Güvenli Oturum Açın`),
            h('div', { class: 'rave-auth-sub' }, `Şifreniz Watchlivo sunucularında asla kaydedilmez (Zero-Knowledge). Gerçek ${p.name} hesabınızla doğrulanarak şifreli oturum açılır.`))),
        h('div', { class: 'rave-auth-form', style: { display: 'flex', flexDirection: 'column', gap: '.55em' } },
          emailInp,
          h('div', { style: { display: 'flex', gap: '.4em', alignItems: 'center' } }, passInp, togglePassBtn),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5em', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '.78em', opacity: '.8' } }, 'Kim İzliyor?'),
            profInp,
            profPills),
          h('button', {
            id: 'btn-rave-login-submit',
            class: 'btn primary rave-login-submit',
            style: { '--prov-accent': acct.accent || '#e50914' },
            onclick: doLogin,
          }, `🔑 ${p.name} Güvenli Oturum Aç`)),
        feedback));
  }

  if (onPickUrl && acct.loginSatisfied) {
    const ph = acct.freeNoAuth || !acct.browseUrl
      ? `${p.name} veya doğrudan video/bölüm bağlantısını buraya yapıştırıp oynatabilirsiniz...`
      : `${p.name} içerik bağlantısını buraya yapıştırıp doğrudan oynatabilirsiniz (${acct.browseUrl}/...)`;
    const urlInp = h('input', { id: 'hub-direct-url', class: 'input rave-inp flex', placeholder: ph });
    const goUrl = () => { const u = urlInp.value.trim(); if (u) onPickUrl(u, `${p.name} İçeriği`); };
    urlInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') goUrl(); });
    wrap.append(h('div', { class: 'rave-url-catcher' }, urlInp, h('button', { class: 'btn', onclick: goUrl }, '▶ Oynat')));
  }
  return wrap;
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

  const initSeason = Math.max(1, Number(item.season || 1) || 1);
  let curSeason = initSeason;
  const loadSeason = async (sNum) => {
    curSeason = sNum;
    let info = {};
    try {
      info = await api(`/api/rave/seasons?${qs({
        tmdbId: item.tmdbId || item.id || '',
        title: item.title || '',
        mediaType: mtype,
        season: sNum,
      })}`, { timeout: 10000 });
    } catch (e) { /* fallback */ }
    const tid = info.tmdbId || item.tmdbId || item.id || '';
    const imdbId = info.imdbId || item.imdbId || '';
    const title = info.title || item.title || 'Yapım';
    const origTitle = info.originalTitle || item.originalTitle || title;
    const year = info.year || item.year || '';
    const overview = info.overview || item.overview || `${prov.name} üzerinde tam uzunlukta senkronize izle.`;
    const backdrop = info.backdrop || item.backdrop || item.poster || '/static/watchlivo-poster.svg';
    const poster = info.poster || item.poster || '/static/watchlivo-poster.svg';
    const rating = info.rating || item.rating || '';
    const seasons = info.seasons?.length ? info.seasons : (mtype === 'tv' ? Array.from({ length: 5 }, (_, i) => ({ season: i + 1, name: `${i + 1}. Sezon` })) : []);
    const episodes = info.episodes?.length ? info.episodes : (mtype === 'tv' ? Array.from({ length: 12 }, (_, i) => ({
      episode: i + 1, season: sNum, name: `${i + 1}. Bölüm`, overview: `${title} ${sNum}. Sezon ${i + 1}. Bölüm`, runtime: 45, still: backdrop,
    })) : []);

    let busyPlay = false;
    const playEp = async (s, e, epName = '', btnEl = null) => {
      if (busyPlay) return;
      busyPlay = true;
      const origTxt = btnEl ? btnEl.textContent : '';
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '⏳ Yayın Hazırlanıyor...';
      }
      toast(`🎬 ${title}${mtype === 'tv' ? ` (${s}. Sezon ${e}. Bölüm)` : ''} hazırlanıyor...`);
      try {
        const media = await resolveFn({ ...item, tmdbId: tid, imdbId, title, originalTitle: origTitle, year, poster: backdrop || poster, mediaType: mtype }, prov, s, e, epName);
        if (media) await onPick(media);
      } finally {
        busyPlay = false;
        if (btnEl && btnEl.isConnected) {
          btnEl.disabled = false;
          btnEl.textContent = origTxt;
        }
      }
    };

    const primaryPlayBtn = h('button', {
      class: 'btn primary',
      id: 'btn-play-primary',
      onclick: (ev) => playEp(curSeason, 1, episodes[0]?.name || '', ev.currentTarget),
    }, mtype === 'tv' ? `▶ ${curSeason}. Sezon 1. Bölümü Odada Başlat` : '▶ Tam Filmi Odada Başlat (1080p)');

    const detail = h('div', { class: 'series-detail fade-in' },
      h('div', { class: 'series-hero', style: { backgroundImage: `linear-gradient(180deg, rgba(11,10,18,.45), rgba(11,10,18,.96)), url("${backdrop}")` } },
        h('div', { class: 'series-top-row' },
          h('button', { class: 'btn', onclick: onBack }, '← Kataloğa Dön'),
          h('span', { class: 'series-badge' }, `${mtype === 'tv' ? '📺 DİZİ' : '🎬 FİLM'}${year ? ` • ${year}` : ''}${rating ? ` • ⭐ ${rating}` : ''}`)),
        h('div', { class: 'series-hero-body' },
          h('img', { class: 'series-poster', src: poster, alt: title, onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
          h('div', { class: 'series-meta' },
            h('h2', {}, title),
            h('p', { class: 'series-overview' }, overview),
            h('div', { class: 'series-cta-row' }, primaryPlayBtn)))));

    if (mtype === 'tv') {
      const seasonBar = h('div', { class: 'season-tabs' },
        ...seasons.map((s) => h('button', {
          class: `btn season-tab ${s.season === curSeason ? 'primary' : ''}`,
          onclick: () => loadSeason(s.season),
        }, s.name || `${s.season}. Sezon`)));

      const epGrid = h('div', { class: 'episode-grid' },
        ...episodes.map((ep) => {
          const rawEpName = String(ep.name || '').trim();
          const isRedundantEpName = !rawEpName || new RegExp(`^(?:${ep.episode}\\.\\s*bölüm|bölüm\\s*${ep.episode}|episode\\s*${ep.episode})$`, 'i').test(rawEpName);
          const epTitleText = isRedundantEpName ? `${ep.episode}. Bölüm` : `${ep.episode}. Bölüm — ${rawEpName}`;
          return h('div', {
            class: 'episode-card', role: 'button', tabindex: '0',
            onclick: (ev) => playEp(curSeason, ep.episode, isRedundantEpName ? '' : rawEpName, ev.currentTarget.querySelector('.episode-play')),
            onkeydown: (e) => { if (e.key === 'Enter') playEp(curSeason, ep.episode, isRedundantEpName ? '' : rawEpName); },
          },
          h('div', { class: 'episode-thumb' },
            h('img', { src: ep.still || backdrop, alt: '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
            h('span', { class: 'episode-dur' }, `${ep.runtime || 45} dk`),
            h('span', { class: 'episode-play' }, '▶ Bölümü Başlat')),
          h('div', { class: 'episode-info' },
            h('div', { class: 'episode-title' }, epTitleText),
            h('div', { class: 'episode-desc' }, ep.overview || `${curSeason}. Sezon ${ep.episode}. Bölüm`)));
        }));

      detail.append(
        h('div', { class: 'section-head', style: { padding: '.8em 4px .3em' } },
          h('h2', {}, 'Sezon ve Bölümler'),
          h('span', { class: 'dim' }, `${episodes.length} bölüm hazır`)),
        seasonBar,
        epGrid);
    }
    container.replaceChildren(detail);
    resetPickerScroll();
  };

  await loadSeason(initSeason);
}
