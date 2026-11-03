// Watchlivo Auth, Account & Profile System (Supabase Auth + Watchlivo Cloud — Zero Guest Mode).
import { h, popup, toast } from './ui.js?v=20261103_v80';
import { api } from './api.js?v=20261103_v80';
import { state, set, getFriends, addFriendByName, toggleFriend, isFriend, getWatchHistory } from './store.js?v=20261103_v80';

const KEY = 'vortex_profile_v2';
const VAULT_KEY = 'watchlivo_accounts_vault';
const LAST_PROVIDER_KEY = 'watchlivo_last_auth_provider';
export const AVATAR_COLORS = ['#6366f1', '#8b5cf6', '#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#ec4899', '#eab308', '#a3e635', '#fb923c'];

function saveToAccountVault(prof) {
  if (!prof || !prof.authToken) return;
  try {
    const vault = JSON.parse(localStorage.getItem(VAULT_KEY) || '{}') || {};
    if (prof.email) vault[String(prof.email).toLowerCase()] = prof.authToken;
    if (prof.handle) vault[String(prof.handle).toLowerCase().replace(/^@+/, '')] = prof.authToken;
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } catch (e) { /* ignore */ }
}

function getVaultToken(identifier) {
  if (!identifier) return '';
  try {
    const vault = JSON.parse(localStorage.getItem(VAULT_KEY) || '{}') || {};
    const k = String(identifier).trim().toLowerCase().replace(/^@+/, '');
    return vault[k] || vault[String(identifier).trim().toLowerCase()] || '';
  } catch (e) {
    return '';
  }
}

export function loadProfile() {
  for (const k of [KEY, 'vortex_profile_v1', 'vortex_self']) {
    try {
      const p = JSON.parse(localStorage.getItem(k) || 'null');
      if (p && !p.id && p.uid) p.id = p.uid;
      if (p && !p.uid && p.id) p.uid = p.id;
      if (p && p.name && p.id) {
        if (!p.isGuest && !/^Misafir/i.test(String(p.name))) {
          if (!p.authToken) p.authToken = getVaultToken(p.email || p.handle) || '';
          return p;
        }
        if (p.isGuest && p.guestConfirmed) {
          return p;
        }
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

export function saveGuestProfile(data = {}) {
  const prev = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
  })();
  const randSuffix = Math.floor(1000 + Math.random() * 9000);
  const defaultGuestName = (prev.isGuest && prev.name && prev.name !== 'Misafir İzleyici') ? prev.name : `Misafir #${randSuffix}`;
  const name = String(data.name || defaultGuestName).trim().slice(0, 24) || defaultGuestName;
  const resolvedId = data.uid || data.id || (prev.isGuest && (prev.id || prev.uid)) || ('guest_' + Math.random().toString(36).slice(2, 10));
  const handle = String(data.handle || prev.handle || name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || `misafir${randSuffix}`);
  const p = {
    id: resolvedId,
    uid: resolvedId,
    name,
    handle,
    email: '',
    color: data.color || prev.color || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    avatar: String(data.avatarUrl ?? data.avatar ?? prev.avatarUrl ?? '').trim(),
    avatarUrl: String(data.avatarUrl ?? data.avatar ?? prev.avatarUrl ?? '').trim(),
    bio: String(data.bio ?? prev.bio ?? '').trim().slice(0, 160),
    statusText: String(data.statusText ?? prev.statusText ?? '').trim().slice(0, 60),
    statusEmoji: String(data.statusEmoji ?? prev.statusEmoji ?? '🍿').trim().slice(0, 12) || '🍿',
    hideLocation: asBool(data.hideLocation ?? prev.hideLocation ?? false),
    hideWatching: asBool(data.hideWatching ?? prev.hideWatching ?? false),
    hideFriends: asBool(data.hideFriends ?? prev.hideFriends ?? false),
    watchMinutes: Math.max(0, Number(prev.watchMinutes || 15)),
    medal: '🍿 Misafir İzleyici',
    authProvider: 'guest',
    authToken: '',
    verified: false,
    isGuest: true,
    guestConfirmed: true,
  };
  localStorage.setItem(KEY, JSON.stringify(p));
  localStorage.setItem(LAST_PROVIDER_KEY, 'guest');
  try { set({ self: p }); } catch (_) {}
  return p;
}

function asBool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

export function saveProfile(data = {}) {
  const prev = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
  })();
  const cleanPrevName = /^Misafir/i.test(String(prev.name || '')) ? '' : prev.name;
  const name = String(data.name || cleanPrevName || 'Üye').trim().slice(0, 24) || 'Üye';
  const rawHandle = String(data.handle ?? prev.handle ?? '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
  const resolvedId = data.uid || data.id || prev.id || prev.uid || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const watchMinutes = Math.max(0, Number(data.watchMinutes ?? prev.watchMinutes ?? 145) || 145);
  const computedMedal = data.medal || prev.medal || (watchMinutes >= 300 ? '🥇 Altın İzleyici' : watchMinutes >= 120 ? '🥈 Gümüş İzleyici' : '🥉 Bronz İzleyici');
  const avatarUrl = String(data.avatarUrl ?? data.avatar ?? prev.avatarUrl ?? prev.avatar ?? '').trim();
  const hideLocation = asBool(data.hideLocation ?? prev.hideLocation ?? false);
  const hideWatching = asBool(data.hideWatching ?? prev.hideWatching ?? false);
  const hideFriends = asBool(data.hideFriends ?? prev.hideFriends ?? false);
  const bio = String(data.bio ?? prev.bio ?? '').trim().slice(0, 160);
  const statusText = String(data.statusText ?? prev.statusText ?? '').trim().slice(0, 60);
  const statusEmoji = String(data.statusEmoji ?? prev.statusEmoji ?? '🍿').trim().slice(0, 12) || '🍿';
  const p = {
    id: resolvedId,
    uid: resolvedId,
    name,
    handle: rawHandle || name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'uye',
    email: String(data.email ?? prev.email ?? '').trim().toLowerCase(),
    color: data.color || prev.color || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    avatar: avatarUrl,
    avatarUrl,
    bio,
    statusText,
    statusEmoji,
    hideLocation,
    hideWatching,
    hideFriends,
    watchMinutes,
    medal: computedMedal,
    authProvider: data.authProvider || prev.authProvider || 'email',
    authToken: data.authToken ?? prev.authToken ?? '',
    verified: true,
    isGuest: false,
  };
  localStorage.setItem(KEY, JSON.stringify(p));
  saveToAccountVault(p);
  if (p.authProvider && p.authProvider !== 'guest') {
    localStorage.setItem(LAST_PROVIDER_KEY, p.authProvider);
  }
  try { set({ self: p }); } catch (_) {}
  return p;
}

export function logoutProfile() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem('vortex_profile_v1');
    localStorage.removeItem('vortex_self');
    localStorage.removeItem('rave_user');
  } catch (e) { /* ignore */ }
  const guest = loadProfile() || {
    id: 'g_' + Math.random().toString(36).slice(2, 10),
    uid: '',
    name: 'Misafir İzleyici',
    handle: 'misafir',
    color: AVATAR_COLORS[0],
    isGuest: true,
    verified: false,
    authToken: '',
  };
  try { set({ self: guest }); } catch (_) {}
  return guest;
}

export function initials(name) {
  const parts = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export const PRESET_GIF_AVATARS = [
  { id: 'none', label: '🔤 Harf Avatar', url: '' },
  { id: 'cyber_cat', label: '🐱 Neon Kedi (GIF)', url: 'https://media.tenor.com/2roX3uxz_68AAAAC/cat-space.gif' },
  { id: 'synth_dj', label: '🎧 Watchlivo DJ (GIF)', url: 'https://media.tenor.com/bCfpwMjfAi0AAAAC/cat-vibing.gif' },
  { id: 'cinema_pop', label: '🍿 Sinema (GIF)', url: 'https://media.tenor.com/5lLcKZ4IMhgAAAAC/popcorn-eating.gif' },
];

export function avatar(user, size = 32, { speaking = false, online = false } = {}) {
  const medalTxt = user?.medal ? ` · ${user.medal}` : '';
  const minsTxt = user?.watchMinutes ? ` · ${user.watchMinutes} dk izleme` : '';
  const label = user?.name ? (user?.handle ? `${user.name} (@${String(user.handle).replace(/^@/, '')})${medalTxt}${minsTxt}` : `${user.name}${medalTxt}${minsTxt}`) : '';
  const imgUrl = String(user?.avatarUrl || user?.avatar || '').trim();
  const hasImg = Boolean(imgUrl && (imgUrl.startsWith('https://') || imgUrl.startsWith('http://') || imgUrl.startsWith('/static/') || imgUrl.startsWith('/uploads/') || imgUrl.startsWith('data:image/') || imgUrl.startsWith('blob:')));
  const el = h('span', {
    class: `avatar ${speaking ? 'speaking' : ''} ${user?.verified ? 'verified-avatar' : ''} ${hasImg ? 'has-img-avatar' : ''}`,
    title: label,
    style: {
      width: `${size}px`,
      height: `${size}px`,
      background: user?.color || '#6366f1',
      fontSize: `${Math.round(size * 0.4)}px`,
      overflow: 'hidden',
      position: 'relative',
    },
  }, hasImg ? h('img', {
    src: imgUrl,
    alt: initials(user?.name),
    style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'block' },
    onerror: (e) => { e.currentTarget.replaceWith(document.createTextNode(initials(user?.name))); },
  }) : initials(user?.name));
  if (online) el.append(h('span', { class: 'presence' }));
  return el;
}

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAeyDRstvjN8c_D08U8CrqopcFT0_fz9fo',
  authDomain: 'watchlivo-38ab6.firebaseapp.com',
  projectId: 'watchlivo-38ab6',
  appId: '1:1034129375158:web:6ce9d8f15e625925090b17',
};

const BRAND_SVGS = {
  google: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.2-.9 2.3-2 3l3.2 2.5c1.9-1.7 3-4.3 3-7.4 0-.7-.1-1.4-.2-2H12z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.2-2.5c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.9v2.6C4.6 19.8 8 22 12 22z"/><path fill="#FBBC05" d="M6.2 13.8c-.2-.6-.3-1.2-.3-1.8s.1-1.2.3-1.8V7.6H2.9C2.3 8.9 2 10.4 2 12s.3 3.1.9 4.4l3.3-2.6z"/><path fill="#4285F4" d="M12 5.9c1.5 0 2.8.5 3.9 1.5l2.9-2.9C17 2.9 14.7 2 12 2 8 2 4.6 4.2 2.9 7.6l3.3 2.6c.8-2.5 3.1-4.3 5.8-4.3z"/></svg>',
  apple: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.08zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>',
  github: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z"/></svg>',
  microsoft: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>',
  discord: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51.07.07 0 0 0-.07.04c-.21.38-.45.87-.61 1.25a18.27 18.27 0 0 0-5.42 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.07-.04 19.74 19.74 0 0 0-4.93 1.51.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1-.01-.13c.13-.09.25-.19.37-.29a.08.08 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.07 0a.08.08 0 0 1 .08.01c.12.1.25.2.37.29a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.87.9a.08.08 0 0 0-.04.11c.36.7.77 1.37 1.22 2a.08.08 0 0 0 .08.03 19.83 19.83 0 0 0 6-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42z"/></svg>',
  x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
};

let _fbAuthPromise = null;
async function getFirebaseAuth() {
  if (_fbAuthPromise) return _fbAuthPromise;
  _fbAuthPromise = (async () => {
    const [{ initializeApp, getApps }, { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, RecaptchaVerifier, signInWithPhoneNumber }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
    ]);
    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    return { auth: getAuth(app), GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, RecaptchaVerifier, signInWithPhoneNumber };
  })().catch(() => {
    _fbAuthPromise = null;
    return null;
  });
  return _fbAuthPromise;
}

export async function checkRedirectAuth() {
  const isPending = Boolean(localStorage.getItem('watchlivo_auth_pending_redirect'));
  if (!isPending) return null;

  return Promise.race([
    (async () => {
      try {
        const fb = await getFirebaseAuth();
        if (!fb?.auth || !fb?.getRedirectResult) return null;
        const cred = await fb.getRedirectResult(fb.auth).catch(() => null);
        if (cred?.user) {
          const idToken = await cred.user.getIdToken();
          const fbEmail = cred.user.email || '';
          const fbName = cred.user.displayName || '';
          const res = await api('/api/auth/oauth', {
            method: 'POST',
            body: { provider: 'google', idToken, email: fbEmail, name: fbName },
          });
          if (res?.ok && res.user) {
            localStorage.removeItem('watchlivo_auth_pending_redirect');
            const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
            toast('✓ ' + prof.name + ' (@' + prof.handle + ') olarak giriş yapıldı');
            return prof;
          }
        }
      } catch (e) {
        console.warn('Redirect auth check failed:', e);
      } finally {
        localStorage.removeItem('watchlivo_auth_pending_redirect');
      }
      return null;
    })(),
    new Promise((resolve) => setTimeout(() => {
      localStorage.removeItem('watchlivo_auth_pending_redirect');
      resolve(null);
    }, 12000))
  ]);
}

export function profileSetup({ current = null, initialTab = null, dismissable = true, onDone } = {}) {
  try { getFirebaseAuth().catch(() => {}); } catch (_) {}
  let isLoggedMember = Boolean(current && !current.isGuest && current.authToken && !/^Misafir/i.test(String(current.name || '')));
  let activeTab = initialTab || (isLoggedMember ? 'account' : 'register');
  let color = current?.color || AVATAR_COLORS[0];
  let phoneConfirmation = null;
  let phonePendingNumber = '';
  let phoneSending = false;
  const lastProvider = localStorage.getItem(LAST_PROVIDER_KEY) || '';
  const root = h('div', { class: 'wl-auth-modal' });
  let modalRef = null;

  const finish = (prof, msg) => {
    modalRef?.close?.();
    if (msg) toast(msg);
    onDone?.(prof);
  };

  const doSocialLogin = async (provider, fallbackName) => {
    try {
      let idToken = '';
      let fbEmail = '';
      let fbName = '';
      if (provider !== 'google') {
        toast('Bu giriş yöntemi henüz etkin değil. Google veya e-posta ile giriş yapın.');
        return;
      }
      if (window.isWatchlivoDesktop && window.pywebview?.api?.start_google_login) {
        toast('Google ile giriş için varsayılan tarayıcınız açılıyor...');
        try {
          const res = await window.pywebview.api.start_google_login();
          if (res?.ok && res.user) {
            const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
            finish(prof, '✓ ' + prof.name + ' (@' + prof.handle + ') olarak giriş yapıldı');
            return;
          } else if (res?.error && !/iptal|timeout|Zaman aşımı/i.test(res.error)) {
            toast('Giriş tamamlanamadı: ' + res.error);
          }
        } catch (e) {
          console.warn('Desktop login api error:', e);
        }
        return;
      }
      const fb = await getFirebaseAuth();
      if (!fb?.auth || !fb?.signInWithPopup) {
        toast('Giriş servisi yüklenemedi. Sayfayı yenileyip tekrar deneyin.');
        return;
      }
      const gProv = new fb.GoogleAuthProvider();
      gProv.addScope('email');
      gProv.addScope('profile');
      gProv.setCustomParameters({ prompt: 'select_account' });
      // Only standalone Android APK (WatchlivoApp custom WebView) uses redirect because WebView lacks multi-window popup support.
      // Standard mobile browsers (Chrome on Android, Safari on iOS, Samsung Internet, Firefox) and PC browsers support popup!
      const isStandaloneApk = /WatchlivoApp/i.test(navigator.userAgent);
      if (isStandaloneApk) {
        localStorage.setItem('watchlivo_auth_pending_redirect', Date.now().toString());
        toast('Google giriş sayfasına aktarılıyorsunuz...');
        await fb.signInWithRedirect(fb.auth, gProv);
        return;
      }
      try {
        toast('Google penceresi açılıyor...');
        const cred = await fb.signInWithPopup(fb.auth, gProv);
        if (cred?.user) {
          idToken = await cred.user.getIdToken();
          fbEmail = cred.user.email || '';
          fbName = cred.user.displayName || '';
        }
      } catch (popErr) {
        console.warn('Popup login failed, attempting fallback redirect:', popErr);
        if (fb.signInWithRedirect) {
          localStorage.setItem('watchlivo_auth_pending_redirect', Date.now().toString());
          toast('Google giriş sayfasına aktarılıyorsunuz...');
          await fb.signInWithRedirect(fb.auth, gProv);
          return;
        }
        toast('Google girişi tamamlanmadı. Lütfen tekrar deneyin.');
        return;
      }
      if (!idToken) {
        toast('Google girişi doğrulanamadı.');
        return;
      }
      const baseName = fbName || ((current && current.name && !/^Misafir/i.test(current.name)) ? current.name : fallbackName);
      const res = await api('/api/auth/oauth', {
        method: 'POST',
        body: { provider, idToken, email: fbEmail, name: baseName, color },
      });
      if (res?.ok && res.user) {
        const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
        finish(prof, `✓ ${prof.name} (@${prof.handle}) olarak giriş yapıldı`);
      }
    } catch (e) {
      toast(e.message || 'Sosyal giriş başarısız oldu');
    }
  };

  const renderColorPicker = () => {
    const row = h('div', { class: 'avatar-choices' }, AVATAR_COLORS.map((c) => {
      const b = h('button', {
        type: 'button',
        class: `avatar-choice ${c === color ? 'on' : ''}`,
        style: { background: c },
        'aria-label': c,
        onclick: () => {
          color = c;
          row.querySelectorAll('.avatar-choice').forEach((x) => x.classList.toggle('on', x === b));
        },
      });
      return b;
    }));
    return row;
  };

  const doGuestLogin = (customName = '') => {
    const prof = saveGuestProfile({ name: customName, color });
    finish(prof, `🎬 ${prof.name} olarak misafir girişi yapıldı — İyi seyirler!`);
  };

  const renderSocialButtons = ({ hideGuestBtn = false } = {}) => h('div', { class: 'wl-social-stack' },
    h('div', { class: 'wl-auth-divider' }, h('span', {}, hideGuestBtn ? 'veya Google ile Tek Tıkla Giriş' : 'veya Hızlı Giriş Seçenekleri')),
    h('div', { class: 'wl-social-row' },
      !hideGuestBtn ? h('button', {
        type: 'button',
        id: 'wl-instant-guest-btn',
        class: 'wl-social-btn wl-social-guest',
        style: {
          background: 'linear-gradient(135deg, rgba(39, 220, 200, 0.18), rgba(99, 102, 241, 0.18))',
          border: '1px solid rgba(39, 220, 200, 0.48)',
          color: '#5eead4',
          fontWeight: '700',
        },
        onclick: () => doGuestLogin(),
      },
      h('span', {}, '👤 Kayıt Olmadan Misafir Olarak Gir'),
      lastProvider === 'guest' ? h('span', { class: 'wl-last-used-badge' }, 'Son') : null) : null,
      h('button', {
        type: 'button',
        class: 'wl-social-btn wl-social-google',
        onclick: () => doSocialLogin('google', 'GmailÜyesi'),
      },
      h('span', { html: BRAND_SVGS.google || '', style: { display: 'inline-flex', alignItems: 'center' } }),
      h('span', {}, 'Google ile Devam Et'),
      lastProvider === 'google' ? h('span', { class: 'wl-last-used-badge' }, 'Son') : null)),
    h('div', { class: 'wl-security-footer' }, '🔒 256-bit SSL · Kayıtsız Misafir veya Resmi Hesap ile Kesintisiz İzle'));

  const draw = () => {
    root.replaceChildren();
    const topNavTabs = isLoggedMember
      ? [
          ['account', '👤 Profilim & Gizlilik'],
          ['login', '🔄 Başka Hesap'],
        ]
      : [
          ['login', '🔑 Giriş Yap'],
          ['register', '✨ Kayıt Ol'],
          ['guest', '👤 Misafir Girişi'],
          ['account', '🪪 Profil Kartım'],
        ];
    if (!topNavTabs.some(([id]) => id === activeTab)) {
      activeTab = isLoggedMember ? 'account' : 'register';
    }
    const tabsBar = h('div', { class: 'wl-auth-tabs' },
      topNavTabs.map(([id, lbl]) =>
        h('button', {
          type: 'button',
          class: `wl-auth-tab ${activeTab === id ? 'on' : ''}`,
          onclick: () => { activeTab = id; draw(); },
        }, lbl)));
    root.append(tabsBar);

    if (activeTab === 'account') {
      const profObj = current || state.self || loadProfile() || { name: 'Misafir İzleyici', handle: 'misafir', color: AVATAR_COLORS[0], isGuest: true };
      const nameInp = h('input', { class: 'input', id: 'wl-profile-name-input', maxlength: '24', placeholder: 'İsim / Görünen Adın', value: profObj.name || '' });
      const handleInp = h('input', { class: 'input', id: 'wl-profile-handle-input', maxlength: '24', placeholder: '@kullaniciadi', value: profObj.handle ? `@${String(profObj.handle).replace(/^@+/, '')}` : '' });
      const bioInp = h('textarea', {
        class: 'input',
        id: 'wl-profile-bio-input',
        maxlength: '160',
        rows: '2',
        placeholder: 'Biyografin (Örn: Bilim kurgu, gece sineması ve anime tutkunu 🍿🎬)',
        style: { resize: 'vertical', minHeight: '54px', fontFamily: 'inherit', lineHeight: '1.4' },
      }, profObj.bio || '');
      let selectedStatusEmoji = profObj.statusEmoji || '🍿';
      const statusInp = h('input', {
        class: 'input',
        id: 'wl-profile-status-input',
        maxlength: '60',
        placeholder: 'Anlık durum paylaş (Örn: Bu gece korku maratonu var!)',
        value: profObj.statusText || '',
      });
      const avatarInp = h('input', { class: 'input', id: 'wl-profile-avatar-input', placeholder: 'Fotoğraf URL veya GIF bağlantısı (isteğe bağlı)', value: (profObj.avatarUrl || profObj.avatar || '').startsWith('data:image/') ? '' : (profObj.avatarUrl || profObj.avatar || '') });
      let selectedAvatarUrl = profObj.avatarUrl || profObj.avatar || '';
      let hideWatchingState = asBool(profObj.hideWatching);
      let hideFriendsState = asBool(profObj.hideFriends);
      let hideLocState = asBool(profObj.hideLocation);
      const userMins = Number(profObj.watchMinutes || 145);
      const userMedal = profObj.medal || (userMins >= 300 ? '🥇 Altın İzleyici' : userMins >= 120 ? '🥈 Gümüş İzleyici' : '🥉 Bronz İzleyici');
      const errBox = h('div', { class: 'wl-auth-err' });

      // Live active media ("Şu An İzliyor")
      const activeRoomMedia = state.mesh?.media?.title ? state.mesh.media : null;
      const lastHistMedia = (getWatchHistory() || [])[0] || null;
      const watchingMedia = activeRoomMedia || lastHistMedia;
      const watchingTitle = watchingMedia?.title || 'Lobide içerik keşfediyor';
      const watchingSub = activeRoomMedia
        ? `🟢 Şu an odada canlı izliyor · ${state.mesh?.name || activeRoomMedia.title}`
        : (lastHistMedia ? '🕘 Son izlenen yapım' : '🍿 Watchlivo Sinema & Dizi');

      // Live Avatar DOM container for instant preview update
      const liveAvatarWrap = h('div', { style: { position: 'relative', cursor: 'pointer', flexShrink: '0' }, title: 'Profil fotoğrafını değiştirmek için tıkla' });
      const liveNameEl = h('strong', { id: 'wl-card-name' }, profObj.name || 'İzleyici');
      const liveHandleEl = h('div', { class: 'wl-user-handle', id: 'wl-card-handle' }, `@${String(profObj.handle || 'uye').replace(/^@+/, '')} · ⏱️ ${userMins} dk birlikte izleme`);
      const liveStatusPill = h('div', {
        id: 'wl-card-status-pill',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '4px',
          padding: '3px 9px', borderRadius: '99px', fontSize: '.75rem', fontWeight: '600',
          background: 'rgba(39, 220, 200, 0.14)', border: '1px solid rgba(39, 220, 200, 0.35)', color: '#5eead4',
        },
      });
      const liveBioBox = h('div', {
        id: 'wl-card-bio-box',
        style: {
          fontSize: '.8rem', color: 'rgba(255,255,255,0.86)', lineHeight: '1.45',
          background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '10px', padding: '8px 10px', marginTop: '6px',
        },
      });
      const liveWatchingBox = h('div', { id: 'wl-profile-watching-box', style: { marginTop: '6px' } });
      const liveFriendsBox = h('div', { id: 'wl-profile-friends-box', style: { marginTop: '6px' } });

      const refreshLiveCard = () => {
        liveAvatarWrap.replaceChildren(
          avatar({ ...profObj, name: nameInp.value.trim() || profObj.name, color, avatarUrl: selectedAvatarUrl }, 64, { online: true }),
          h('span', {
            style: {
              position: 'absolute', right: '-2px', bottom: '-2px', width: '22px', height: '22px',
              borderRadius: '50%', background: '#6366f1', color: '#fff', fontSize: '11px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #0b0e17',
            },
          }, '📷')
        );
        liveNameEl.textContent = nameInp.value.trim() || profObj.name || 'İzleyici';
        const cleanH = handleInp.value.trim().replace(/^@+/, '') || profObj.handle || 'uye';
        liveHandleEl.textContent = `@${cleanH} · ⏱️ ${userMins} dk birlikte izleme`;
        const stTxt = statusInp.value.trim() || 'Birlikte film & dizi izlemeye hazır';
        liveStatusPill.textContent = `${selectedStatusEmoji} ${stTxt}`;
        const bioTxt = bioInp.value.trim();
        liveBioBox.textContent = bioTxt || 'Henüz biyografi eklenmedi. Aşağıdan biyografini yazabilirsin ✨';
        liveBioBox.style.opacity = bioTxt ? '1' : '0.6';

        // Refresh "Şu An İzliyor" box
        liveWatchingBox.replaceChildren();
        if (hideWatchingState) {
          liveWatchingBox.append(
            h('div', {
              style: {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                padding: '8px 11px', borderRadius: '11px', background: 'rgba(255,255,255,0.03)',
                border: '1px dashed rgba(255,255,255,0.14)', fontSize: '.78rem', color: 'rgba(255,255,255,0.6)',
              },
            },
            h('span', {}, '👁️‍🗨️ Şu An İzliyor: Gizlendi (Diğer kullanıcılara görünmez)'),
            h('span', { style: { fontSize: '.7rem', color: '#fbbf24' } }, '🔒 Gizli'))
          );
        } else {
          liveWatchingBox.append(
            h('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px',
                borderRadius: '12px', background: 'linear-gradient(135deg, rgba(39,220,200,0.1), rgba(99,102,241,0.1))',
                border: '1px solid rgba(39,220,200,0.3)',
              },
            },
            h('div', {
              style: {
                width: '36px', height: '36px', borderRadius: '9px', background: 'rgba(39,220,200,0.18)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', flexShrink: '0',
              },
            }, '🎬'),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { style: { fontSize: '.68rem', fontWeight: '800', color: '#27dcc8', textTransform: 'uppercase', letterSpacing: '.04em' } }, watchingSub),
              h('div', { id: 'wl-watching-media-title', style: { fontSize: '.84rem', fontWeight: '700', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, watchingTitle)))
          );
        }

        // Refresh "Arkadaşlarım" box
        liveFriendsBox.replaceChildren();
        const myFriends = getFriends() || [];
        if (hideFriendsState) {
          liveFriendsBox.append(
            h('div', {
              style: {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                padding: '8px 11px', borderRadius: '11px', background: 'rgba(255,255,255,0.03)',
                border: '1px dashed rgba(255,255,255,0.14)', fontSize: '.78rem', color: 'rgba(255,255,255,0.6)',
              },
            },
            h('span', {}, `👥 Arkadaşlar (${myFriends.length}): Gizlendi (Diğer kullanıcılara görünmez)`),
            h('span', { style: { fontSize: '.7rem', color: '#fbbf24' } }, '🔒 Gizli'))
          );
        } else {
          const addFrInp = h('input', {
            class: 'input',
            placeholder: '@kullaniciadi veya isim ile arkadaş ekle...',
            style: { flex: '1', padding: '5px 9px', fontSize: '.76rem' },
          });
          const addFrBtn = h('button', {
            type: 'button',
            class: 'btn sm primary',
            style: { padding: '5px 10px', fontSize: '.74rem' },
            onclick: () => {
              const v = addFrInp.value.trim().replace(/^@+/, '');
              if (!v) return;
              addFriendByName(v);
              addFrInp.value = '';
              toast(`👥 @${v} arkadaş listene eklendi!`);
              refreshLiveCard();
            },
          }, '+ Ekle');
          liveFriendsBox.append(
            h('div', {
              style: {
                padding: '9px 11px', borderRadius: '12px', background: 'rgba(255,255,255,0.035)',
                border: '1px solid rgba(255,255,255,0.09)', display: 'flex', flexDirection: 'column', gap: '7px',
              },
            },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '.76rem', fontWeight: '700', color: 'rgba(255,255,255,0.85)' } },
              h('span', {}, `👥 Arkadaşlarım (${myFriends.length})`),
              h('span', { style: { fontSize: '.68rem', color: '#6ee7b7' } }, '🌐 Profilde Açık')),
            myFriends.length
              ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  myFriends.slice(0, 10).map((fr) => h('span', {
                    style: {
                      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 8px',
                      borderRadius: '99px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      fontSize: '.74rem', color: '#f8fafc',
                    },
                  }, avatar(fr, 18), fr.name)))
              : h('div', { style: { fontSize: '.75rem', color: 'rgba(255,255,255,0.5)' } }, 'Henüz arkadaş eklenmedi. Hemen aşağıdan ekleyebilirsin:'),
            h('div', { style: { display: 'flex', gap: '6px' } }, addFrInp, addFrBtn))
          );
        }
      };

      const syncAvatarEverywhere = (newAvatarDataUrl) => {
        selectedAvatarUrl = newAvatarDataUrl;
        avatarInp.value = newAvatarDataUrl.startsWith('data:image/') ? '' : newAvatarDataUrl;
        refreshLiveCard();
        const curName = nameInp.value.trim() || profObj.name || 'İzleyici';
        const curHandle = handleInp.value.trim().replace(/^@+/, '') || profObj.handle || 'uye';
        const curBio = bioInp.value.trim();
        const curStatus = statusInp.value.trim();
        const autoPayload = {
          name: curName,
          handle: curHandle,
          color,
          avatar: newAvatarDataUrl,
          avatarUrl: newAvatarDataUrl,
          bio: curBio,
          statusText: curStatus,
          statusEmoji: selectedStatusEmoji || '🍿',
          hideWatching: hideWatchingState,
          hideFriends: hideFriendsState,
          hideLocation: hideLocState,
        };
        const saved = isLoggedMember
          ? saveProfile({ ...profObj, ...autoPayload, isGuest: false })
          : saveGuestProfile({ ...profObj, ...autoPayload });
        Object.assign(profObj, saved);
        current = saved;
        // Immediately refresh top navbar avatar & any room participant avatar in DOM
        const navBtn = document.getElementById('nav-account-btn');
        if (navBtn) {
          const oldAv = navBtn.querySelector('.avatar');
          if (oldAv) oldAv.replaceWith(avatar(saved, 30));
        }
        if (state.mesh && Array.isArray(state.mesh.participants)) {
          state.mesh.participants.forEach((pt) => {
            if (pt.id === state.clientId || pt.name === saved.name) {
              pt.avatar = newAvatarDataUrl;
              pt.avatarUrl = newAvatarDataUrl;
            }
          });
        }
        if (isLoggedMember && saved.authToken) {
          api('/api/auth/profile', {
            method: 'POST',
            body: { ...autoPayload, authToken: saved.authToken },
          }).then((res) => {
            if (res?.authToken) {
              saveProfile({ ...saved, authToken: res.authToken, isGuest: false });
            }
          }).catch(() => {});
        }
        onDone?.(saved);
      };

      // Native file input for device gallery photo upload
      const fileInp = h('input', {
        type: 'file',
        id: 'wl-avatar-file-input',
        accept: 'image/*,image/heic,image/heif,image/webp,image/gif',
        style: { position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' },
        onchange: (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const rawDataUrl = String(ev.target?.result || '');
            if (!rawDataUrl) return;
            const img = new Image();
            img.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                const sz = 180;
                canvas.width = sz;
                canvas.height = sz;
                const cctx = canvas.getContext('2d');
                const minSide = Math.max(1, Math.min(img.width || sz, img.height || sz));
                const sx = Math.max(0, ((img.width || sz) - minSide) / 2);
                const sy = Math.max(0, ((img.height || sz) - minSide) / 2);
                cctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, sz, sz);
                const outUrl = canvas.toDataURL('image/jpeg', 0.85);
                syncAvatarEverywhere(outUrl && outUrl.length > 64 ? outUrl : rawDataUrl);
                toast('📷 Profil fotoğrafın galeriden yüklendi ve kaydedildi!');
              } catch (_) {
                syncAvatarEverywhere(rawDataUrl);
                toast('📷 Profil fotoğrafın güncellendi!');
              }
            };
            img.onerror = () => {
              syncAvatarEverywhere(rawDataUrl);
              toast('📷 Profil fotoğrafın güncellendi!');
            };
            img.src = rawDataUrl;
          };
          reader.readAsDataURL(file);
          e.target.value = '';
        },
      });
      liveAvatarWrap.onclick = () => fileInp.click();

      nameInp.addEventListener('input', refreshLiveCard);
      handleInp.addEventListener('input', refreshLiveCard);
      bioInp.addEventListener('input', refreshLiveCard);
      statusInp.addEventListener('input', refreshLiveCard);
      avatarInp.addEventListener('input', () => {
        if (avatarInp.value.trim()) {
          selectedAvatarUrl = avatarInp.value.trim();
          refreshLiveCard();
        }
      });

      const STATUS_PRESETS = [
        ['🍿', 'Film arıyor'],
        ['🎬', 'Odada yayında'],
        ['🎧', 'Müzik dinliyor'],
        ['🔥', 'Sohbete açık'],
        ['☕', 'Mola verdi'],
        ['🌙', 'Rahatsız etmeyin'],
      ];

      refreshLiveCard();

      root.append(
        fileInp,
        // Live Profile Card Preview
        h('div', { id: 'wl-profile-card-preview', style: { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(99,102,241,0.28)', borderRadius: '16px', padding: '12px', marginBottom: '10px' } },
          h('div', { class: 'wl-user-header', style: { marginBottom: '4px', border: 'none', padding: '0', background: 'transparent' } },
            liveAvatarWrap,
            h('div', { class: 'wl-user-meta', style: { flex: '1' } },
              h('div', { class: 'wl-user-title-row' },
                liveNameEl,
                h('span', { class: 'wl-verified-pill' }, isLoggedMember ? '✓ Resmi Hesap' : '👤 Misafir Profil'),
                h('span', { class: 'wl-verified-pill', style: { background: 'rgba(245,158,11,0.18)', color: '#fbbf24', borderColor: 'rgba(245,158,11,0.4)' } }, userMedal)),
              liveHandleEl,
              liveStatusPill)),
          liveBioBox,
          liveWatchingBox,
          liveFriendsBox),

        // Photo Upload & GIF Picker
        h('label', { class: 'wl-field-label' }, '📷 Profil Fotoğrafı Seç / Yükle'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' } },
          h('label', {
            for: 'wl-avatar-file-input',
            id: 'wl-upload-photo-btn',
            class: 'btn sm primary',
            role: 'button',
            tabindex: '0',
            style: { fontSize: '.75rem', padding: '5px 11px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px' },
            onclick: (e) => {
              if (e.target !== fileInp) {
                e.preventDefault();
                fileInp.click();
              }
            },
          }, '📷 Galeriden Fotoğraf Seç / Yükle'),
          ...PRESET_GIF_AVATARS.map((pr) => h('button', {
            type: 'button',
            class: 'btn sm',
            style: { fontSize: '.73rem', padding: '4px 8px', background: selectedAvatarUrl === pr.url ? 'rgba(39,220,200,0.22)' : 'rgba(255,255,255,0.06)', border: selectedAvatarUrl === pr.url ? '1px solid #27dcc8' : '1px solid rgba(255,255,255,0.12)' },
            onclick: () => {
              syncAvatarEverywhere(pr.url);
              toast(pr.url ? `${pr.label} seçildi!` : '🔤 Harf avatarına geçildi');
            },
          }, pr.label))),
        avatarInp,

        // Name & Handle side-by-side
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px' } },
          h('div', {},
            h('label', { class: 'wl-field-label' }, 'İsim (Görünen Ad)'),
            nameInp),
          h('div', {},
            h('label', { class: 'wl-field-label' }, 'Kullanıcı Adı (@handle)'),
            handleInp)),

        // Bio
        h('label', { class: 'wl-field-label' }, '📝 Biyografi'),
        bioInp,

        // Instant Status Share
        h('label', { class: 'wl-field-label' }, '💬 Anlık Durum Paylaşımı'),
        h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '5px' } },
          STATUS_PRESETS.map(([emo, txt]) => h('button', {
            type: 'button',
            class: 'btn sm',
            style: { fontSize: '.72rem', padding: '3px 8px', background: (selectedStatusEmoji === emo && statusInp.value === txt) ? 'rgba(39,220,200,0.2)' : 'rgba(255,255,255,0.05)' },
            onclick: () => {
              selectedStatusEmoji = emo;
              statusInp.value = txt;
              refreshLiveCard();
            },
          }, `${emo} ${txt}`))),
        statusInp,

        // Privacy Toggles ("İstenirse Gizlenebilsin")
        h('label', { class: 'wl-field-label', style: { marginTop: '8px' } }, '🛡️ Gizlilik Ayarları (İstediğin Kısmı Gizle)'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '9px 11px' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '.8rem', color: '#f8fafc' } },
            h('input', {
              type: 'checkbox',
              id: 'wl-hide-watching-chk',
              checked: hideWatchingState ? 'checked' : null,
              onchange: (e) => { hideWatchingState = e.target.checked; refreshLiveCard(); },
            }),
            h('span', {}, '👁️ "Şu An İzliyor" Kısmını Gizle (Ne izlediğimi kimse görmesin)')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '.8rem', color: '#f8fafc' } },
            h('input', {
              type: 'checkbox',
              id: 'wl-hide-friends-chk',
              checked: hideFriendsState ? 'checked' : null,
              onchange: (e) => { hideFriendsState = e.target.checked; refreshLiveCard(); },
            }),
            h('span', {}, '👥 Arkadaşlarımı Gizle (Arkadaş listemi profilimde gizle)')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '.8rem', color: '#f8fafc' } },
            h('input', {
              type: 'checkbox',
              id: 'wl-hide-location-chk',
              checked: hideLocState ? 'checked' : null,
              onchange: (e) => { hideLocState = e.target.checked; },
            }),
            h('span', {}, '🕵️ Dünya Haritasında Konumumu Gizle'))),

        h('label', { class: 'wl-field-label' }, '🎨 Profil Neon Rengi'),
        renderColorPicker(),
        errBox,
        h('div', { class: 'wl-auth-actions' },
          h('button', {
            type: 'button',
            id: 'wl-profile-save-btn',
            class: 'btn primary wl-btn-full wl-btn-primary-gradient',
            onclick: async () => {
              const name = nameInp.value.trim() || profObj.name || 'İzleyici';
              const handle = handleInp.value.trim().replace(/^@+/, '') || profObj.handle || 'uye';
              const avatarUrl = selectedAvatarUrl || avatarInp.value.trim();
              const bio = bioInp.value.trim();
              const statusText = statusInp.value.trim();
              const statusEmoji = selectedStatusEmoji || '🍿';
              const payload = {
                name, handle, color, avatarUrl, bio, statusText, statusEmoji,
                hideWatching: hideWatchingState,
                hideFriends: hideFriendsState,
                hideLocation: hideLocState,
              };
              if (isLoggedMember && profObj.authToken) {
                try {
                  const res = await api('/api/auth/profile', {
                    method: 'POST',
                    body: { ...payload, authToken: profObj.authToken },
                  });
                  const updated = saveProfile({ ...(res?.user || profObj), ...payload, authToken: res?.authToken || profObj.authToken, isGuest: false });
                  finish(updated, '✓ Profilin ve gizlilik ayarların kaydedildi!');
                  return;
                } catch (e) { /* fallback to local save */ }
                const updated = saveProfile({ ...profObj, ...payload, isGuest: false });
                finish(updated, '✓ Profil bilgilerin güncellendi!');
              } else {
                const updated = saveGuestProfile({ ...profObj, ...payload });
                finish(updated, '✓ Profil kartın ve gizlilik ayarların kaydedildi!');
              }
            },
          }, '💾 Profili & Gizlilik Ayarlarını Kaydet'),
          isLoggedMember ? h('button', {
            type: 'button',
            class: 'btn wl-btn-logout',
            onclick: () => {
              const guestProf = logoutProfile();
              isLoggedMember = false;
              current = guestProf;
              activeTab = 'login';
              onDone?.(guestProf);
              toast('Oturum kapatıldı. Misafir olarak devam edebilir veya giriş yapabilirsiniz.');
              draw();
            },
          }, '🚪 Çıkış Yap (Başka Hesaba Geç)') : null,
          h('button', {
            type: 'button',
            class: 'btn wl-btn-full',
            onclick: () => (modalRef?.close ? modalRef.close() : document.querySelector('.popup-backdrop')?.remove()),
          }, 'Kapat')));
      return;
    }

    if (activeTab === 'guest') {
      const existingGuestName = (current && current.isGuest && current.name && current.name !== 'Misafir İzleyici') ? current.name : '';
      const guestNameInp = h('input', {
        class: 'input',
        id: 'wl-guest-name-input',
        maxlength: '24',
        placeholder: 'Görünen Adın (İsteğe bağlı — boş bırakırsan otomatik atanır)',
        value: existingGuestName,
      });

      const guestBtn = h('button', {
        type: 'button',
        id: 'wl-guest-submit-btn',
        class: 'btn primary wl-btn-full wl-btn-primary-gradient',
        onclick: () => doGuestLogin(guestNameInp.value.trim()),
      }, '🎬 Kayıt Olmadan Hemen İzlemeye Başla');

      guestNameInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doGuestLogin(guestNameInp.value.trim());
      });

      root.append(
        h('div', { class: 'wl-auth-form' },
          h('div', { style: { fontSize: '.84rem', color: 'rgba(255,255,255,0.78)', lineHeight: '1.45', marginBottom: '2px' } },
            'Kayıt olmadan veya e-posta girmeden doğrudan misafir olarak odalara katılabilir, kendi odanı açabilir ve tüm dizi, film ve müzikleri izleyebilirsin.'),
          guestNameInp,
          h('label', { class: 'wl-field-label' }, 'Profil Neon Rengin'),
          renderColorPicker(),
          guestBtn),
        renderSocialButtons({ hideGuestBtn: true }));
      return;
    }

    if (activeTab === 'login') {
      const idInp = h('input', { class: 'input', placeholder: 'E-posta adresi veya @kullaniciadi', autocomplete: 'username' });
      const pwInp = h('input', { class: 'input', type: 'password', placeholder: 'Şifreniz', autocomplete: 'current-password' });
      const errBox = h('div', { class: 'wl-auth-err' });

      const submitLogin = async () => {
        errBox.style.color = '#fb7185';
        errBox.textContent = '';
        const identifier = idInp.value.trim();
        const password = pwInp.value;
        if (!identifier || !password) {
          errBox.textContent = 'Lütfen e-posta/kullanıcı adı ve şifrenizi girin.';
          return;
        }
        try {
          const vaultToken = getVaultToken(identifier);
          const res = await api('/api/auth/login', { method: 'POST', body: { identifier, password, vaultToken } });
          if (res?.ok && res.user) {
            const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
            finish(prof, `Hoş geldin, ${prof.name} (@${prof.handle})!`);
          }
        } catch (e) {
          errBox.textContent = e.message || 'Giriş yapılamadı. Bilgilerinizi kontrol edin.';
        }
      };

      const sendResetEmail = async () => {
        const email = idInp.value.trim();
        if (!email.includes('@')) {
          errBox.style.color = '#fb7185';
          errBox.textContent = 'Şifre sıfırlama için üstteki kutuya geçerli e-posta adresinizi yazın.';
          return;
        }
        try {
          const res = await api('/api/auth/email-action', { method: 'POST', body: { action: 'reset_password', email } });
          errBox.style.color = '#6ee7b7';
          errBox.textContent = res?.message || `Şifre sıfırlama e-postası ${email} adresine gönderildi!`;
        } catch (e) {
          errBox.style.color = '#fb7185';
          errBox.textContent = e.message || 'Şifre sıfırlama e-postası gönderilemedi.';
        }
      };

      const sendMagicLink = async () => {
        const email = idInp.value.trim();
        if (!email.includes('@')) {
          errBox.style.color = '#fb7185';
          errBox.textContent = 'Şifresiz giriş bağlantısı için üstteki kutuya geçerli e-posta adresinizi yazın.';
          return;
        }
        try {
          const res = await api('/api/auth/email-action', { method: 'POST', body: { action: 'magic_link', email } });
          errBox.style.color = '#6ee7b7';
          errBox.textContent = res?.message || `Şifresiz giriş bağlantısı ${email} adresine gönderildi!`;
        } catch (e) {
          errBox.style.color = '#fb7185';
          errBox.textContent = e.message || 'Şifresiz giriş bağlantısı gönderilemedi.';
        }
      };

      pwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

      root.append(
        h('div', { class: 'wl-auth-form' },
          idInp,
          pwInp,
          errBox,
          h('button', { type: 'button', class: 'btn primary wl-btn-full wl-btn-primary-gradient', onclick: submitLogin }, '🔑 Hesabımla Giriş Yap'),
          h('button', {
            type: 'button',
            class: 'btn wl-btn-full',
            style: { background: 'rgba(139, 92, 246, 0.14)', border: '1px solid rgba(139, 92, 246, 0.35)', color: '#c4b5fd' },
            onclick: sendMagicLink,
          }, '🔗 Şifresiz Giriş Bağlantısı Gönder'),
          h('button', {
            type: 'button',
            class: 'wl-auth-link-btn',
            onclick: sendResetEmail,
          }, 'Şifrenizi mi unuttunuz? E-posta ile sıfırlayın')),
        renderSocialButtons());
      return;
    }

    // activeTab === 'register'
    const nameInp = h('input', { class: 'input', maxlength: '24', placeholder: 'Görünen Adın (Örn: Mert Can)', value: (current && current.name && !/^Misafir/i.test(current.name)) ? current.name : '' });
    const handleInp = h('input', { class: 'input', maxlength: '24', placeholder: '@kullaniciadi (Örn: @mertcan)' });
    const emailInp = h('input', { class: 'input', type: 'email', placeholder: 'E-posta adresin (Örn: ad@gmail.com)', autocomplete: 'email' });
    const pwInp = h('input', { class: 'input', type: 'password', placeholder: 'Şifre belirle (en az 4 karakter)', autocomplete: 'new-password' });
    const errBox = h('div', { class: 'wl-auth-err' });

    const submitReg = async () => {
      errBox.style.color = '#fb7185';
      errBox.textContent = '';
      const name = nameInp.value.trim();
      const handle = handleInp.value.trim();
      const email = emailInp.value.trim();
      const password = pwInp.value;
      if (name.length < 2) { errBox.textContent = 'Görünen ad en az 2 karakter olmalıdır.'; return; }
      if (!email.includes('@')) { errBox.textContent = 'Geçerli bir e-posta adresi girin.'; return; }
      if (password.length < 4) { errBox.textContent = 'Şifre en az 4 karakter olmalıdır.'; return; }
      try {
        const res = await api('/api/auth/register', { method: 'POST', body: { name, handle, email, password, color } });
        if (res?.ok && res.user) {
          const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
          finish(prof, `🎉 Watchlivo hesabın oluşturuldu: @${prof.handle}`);
        }
      } catch (e) {
        errBox.textContent = e.message || 'Kayıt işlemi başarısız oldu.';
      }
    };

    pwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitReg(); });

    root.append(
      h('div', { class: 'wl-auth-form' },
        nameInp,
        handleInp,
        emailInp,
        pwInp,
        h('label', { class: 'wl-field-label' }, 'Profil Neon Rengin'),
        renderColorPicker(),
        errBox,
        h('button', { type: 'button', class: 'btn primary wl-btn-full wl-btn-primary-gradient', onclick: submitReg }, '✨ Hesap Oluştur & Başla')),
      renderSocialButtons());
  };

  draw();
  modalRef = popup({
    title: isLoggedMember && activeTab === 'account' ? 'Watchlivo Hesabım' : "Watchlivo'ya Giriş Yap",
    message: isLoggedMember && activeTab === 'account' ? null : 'Birlikte kesintisiz sinema, dizi ve müzik odalarına katıl.',
    dismissable: Boolean(dismissable),
    content: root,
    options: [],
  });
}


// ============================================================================
// RAVE.IO PARITY: Direct Messages (DMThreads / DirectMessageView) & Friendships
// ============================================================================
export async function openDmModal(initialPeerId = null) {
  const me = state.self || loadProfile() || { id: 'guest_default', uid: 'guest_default', name: 'İzleyici', handle: 'izleyici', color: '#27dcc8' };
  const myUid = me.uid || me.id || 'guest_default';
  let socialData = { friends: [], requests: [], threads: [], totalUnread: 0 };
  let activePeerId = initialPeerId || 'u_ayla_cinema';
  let activeMessages = [];

  let dmModal = null;
  const root = h('div', { class: 'DMThreads DirectMessageView wl-dm-root', style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxHeight: '76vh' } });

  const loadState = async () => {
    try {
      const r = await api(`/api/rave/social/state?uid=${encodeURIComponent(myUid)}&name=${encodeURIComponent(me.name || '')}&handle=${encodeURIComponent(me.handle || '')}`);
      if (r?.ok) {
        socialData = r;
        if (!initialPeerId && socialData.friends?.length && !socialData.friends.some((f) => f.uid === activePeerId)) {
          activePeerId = socialData.friends[0].uid;
        }
      }
    } catch (e) { /* ignore */ }
  };

  const loadMessages = async (peerId) => {
    activePeerId = peerId;
    try {
      const r = await api(`/api/rave/social/dm?uid=${encodeURIComponent(myUid)}&peerId=${encodeURIComponent(peerId)}`);
      if (r?.ok) activeMessages = r.messages || [];
    } catch (e) { activeMessages = []; }
    renderUI();
  };

  const renderUI = () => {
    root.replaceChildren();

    // Top row: Add friend + incoming friend requests
    const addInp = h('input', {
      class: 'input',
      placeholder: '@kullaniciadi ile arkadaş ekle (Örn: @can_sinema)',
      style: { flex: '1', height: '36px', fontSize: '.84rem' },
    });
    const addBtn = h('button', {
      type: 'button',
      class: 'btn primary sm',
      onclick: async () => {
        const val = addInp.value.trim();
        if (!val) return;
        try {
          const r = await api('/api/rave/social/friends', {
            method: 'POST',
            body: { uid: myUid, fromName: me.name, action: 'request', targetName: val, targetHandle: val },
          });
          if (r?.ok) {
            toast(`✓ ${val} arkadaş listene ve DM kutuna eklendi!`);
            addInp.value = '';
            await loadState();
            if (r.friend?.uid) await loadMessages(r.friend.uid);
            else renderUI();
          }
        } catch (e) { toast('Arkadaş isteği gönderilemedi'); }
      },
    }, '➕ Arkadaş Ekle');

    root.append(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, addInp, addBtn));

    if (socialData.requests?.length) {
      root.append(h('div', { class: 'rave-friend-requests-bar', style: { background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.32)', borderRadius: '10px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { fontSize: '.76rem', fontWeight: '700', color: '#a5b4fc' } }, `🔔 Bekleyen Arkadaşlık İstekleri (${socialData.requests.length})`),
        ...socialData.requests.map((req) => h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '.82rem' } },
            avatar({ name: req.fromName, color: req.color }, 28),
            h('span', {}, `${req.fromName} (${req.fromHandle || '@izleyici'}) · ${req.medal || '🥉 Bronz İzleyici'}`)),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', {
              type: 'button',
              class: 'btn primary sm',
              onclick: async () => {
                await api('/api/rave/social/friends', { method: 'POST', body: { uid: myUid, action: 'accept', requestId: req.id } });
                toast(`✓ ${req.fromName} ile artık arkadaşsınız!`);
                await loadState();
                renderUI();
              },
            }, '✓ Kabul Et'),
            h('button', {
              type: 'button',
              class: 'btn sm',
              onclick: async () => {
                await api('/api/rave/social/friends', { method: 'POST', body: { uid: myUid, action: 'decline', requestId: req.id } });
                await loadState();
                renderUI();
              },
            }, '✕ Reddet'))))));
    }

    // 2-Column split: Left = DMThreads, Right = DirectMessageView
    const activePeer = (socialData.friends || []).find((f) => f.uid === activePeerId) || socialData.friends?.[0] || {
      uid: activePeerId, name: 'Ayla Sinema', handle: '@ayla_cinema', color: '#FF2A85', medal: '🥇 Altın İzleyici', watchMinutes: 420,
    };

    const threadsCol = h('div', {
      class: 'DMThreads__list',
      style: { width: '220px', flexShrink: '0', display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', maxHeight: '48vh', borderRight: '1px solid rgba(255,255,255,0.08)', paddingRight: '8px' },
    }, ...(socialData.friends || []).map((fr) => {
      const isAct = fr.uid === activePeer.uid;
      const th = (socialData.threads || []).find((t) => t.peer?.uid === fr.uid);
      const unread = th?.unreadCount || 0;
      return h('button', {
        type: 'button',
        class: `dm-thread-item ${isAct ? 'on' : ''}`,
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '10px', textAlign: 'left', cursor: 'pointer',
          background: isAct ? 'rgba(39,220,200,0.15)' : 'rgba(255,255,255,0.03)',
          border: isAct ? '1px solid rgba(39,220,200,0.45)' : '1px solid transparent', color: '#fff',
        },
        onclick: () => loadMessages(fr.uid),
      },
      avatar(fr, 34, { online: fr.online !== false }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' } },
          h('strong', { style: { fontSize: '.82rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, fr.name),
          unread > 0 ? h('span', { style: { background: '#f43f5e', color: '#fff', fontSize: '.68rem', padding: '1px 6px', borderRadius: '99px', fontWeight: '700' } }, String(unread)) : null),
        h('div', { class: 'Tooltip__friend-tooltip-medal', style: { fontSize: '.7rem', color: '#fbbf24', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `${fr.medal || '🥉 Raver'} · ${fr.watchMinutes || 60}dk`),
        h('div', { style: { fontSize: '.71rem', color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, th?.lastMessage?.text || fr.status || 'Sohbet başlat')));
    }));

    const msgListEl = h('div', {
      class: 'DirectMessageView__messages',
      style: { flex: '1', overflowY: 'auto', maxHeight: '36vh', minHeight: '190px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px', background: 'rgba(0,0,0,0.28)', borderRadius: '10px' },
    }, ...(activeMessages.length ? activeMessages.map((m) => {
      const isMe = m.fromUid === myUid;
      return h('div', {
        style: {
          alignSelf: isMe ? 'flex-end' : 'flex-start',
          maxWidth: '82%',
          background: isMe ? 'linear-gradient(135deg, rgba(39,220,200,0.22), rgba(99,102,241,0.24))' : 'rgba(255,255,255,0.07)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '12px',
          padding: '7px 11px',
        },
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '.7rem', color: m.color || '#27dcc8', marginBottom: '2px' } },
        h('strong', {}, m.fromName || 'İzleyici'),
        h('span', { style: { color: 'rgba(255,255,255,0.45)' } }, m.time || '')),
      h('div', { style: { fontSize: '.84rem', color: '#f8fafc', wordBreak: 'break-word' } }, m.text || ''),
      m.roomInvite ? h('button', {
        type: 'button',
        class: 'btn primary sm',
        style: { marginTop: '6px', width: '100%' },
        onclick: () => {
          dmModal?.close?.();
          if (typeof window.vortexNavigate === 'function') window.vortexNavigate(`/mesh/${encodeURIComponent(m.roomInvite)}`);
          else window.location.href = `/r/${encodeURIComponent(m.roomInvite)}`;
        },
      }, `🎬 Odaya Katıl (#${m.roomInvite})`) : null);
    }) : [h('div', { style: { color: 'rgba(255,255,255,0.5)', fontSize: '.82rem', textAlign: 'center', margin: 'auto' } }, `${activePeer.name} ile özel mesajlaşmaya başla 💬`)]));

    const dmInp = h('input', {
      class: 'input',
      placeholder: `${activePeer.name} kişisine özel mesaj yaz...`,
      style: { flex: '1', height: '38px' },
    });

    const sendDmNow = async (extra = {}) => {
      const txt = dmInp.value.trim() || extra.text || '';
      if (!txt && !extra.roomInvite) return;
      dmInp.value = '';
      try {
        const r = await api('/api/rave/social/dm', {
          method: 'POST',
          body: {
            uid: myUid,
            fromName: me.name || 'İzleyici',
            color: me.color || '#27dcc8',
            peerId: activePeer.uid,
            text: txt,
            ...extra,
          },
        });
        if (r?.ok) {
          activeMessages = r.messages || [];
          await loadState();
          renderUI();
        }
      } catch (e) { toast('DM gönderilemedi'); }
    };

    dmInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDmNow(); });

    const rightCol = h('div', {
      style: { flex: '1', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0' },
    },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.08)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        avatar(activePeer, 32, { online: true }),
        h('div', {},
          h('strong', { style: { fontSize: '.86rem' } }, `${activePeer.name} (${activePeer.handle || '@izleyici'})`),
          h('div', { class: 'Tooltip__friend-tooltip-minutes', style: { fontSize: '.72rem', color: '#27dcc8' } }, `${activePeer.medal || '🥇 Altın İzleyici'} · ⏱️ ${activePeer.watchMinutes || 180} dk birlikte izlendi`))),
      state.mesh?.id ? h('button', {
        type: 'button',
        class: 'btn sm',
        style: { fontSize: '.74rem', background: 'rgba(39,220,200,0.16)', color: '#27dcc8', border: '1px solid rgba(39,220,200,0.35)' },
        onclick: () => sendDmNow({ text: `🎬 Seni "${state.mesh.name || state.mesh.id}" odasına davet ediyorum!`, roomInvite: state.mesh.id }),
      }, '🎬 Odaya Davet Gönder') : null),
    msgListEl,
    h('div', { style: { display: 'flex', gap: '6px' } },
      dmInp,
      h('button', { type: 'button', class: 'btn primary', onclick: () => sendDmNow() }, 'Gönder ➤')));

    root.append(h('div', { class: 'wl-dm-split', style: { display: 'flex', gap: '12px', flex: '1', minHeight: '0' } }, threadsCol, rightCol));
    setTimeout(() => { msgListEl.scrollTop = msgListEl.scrollHeight; }, 20);
  };

  await loadState();
  await loadMessages(activePeerId);

  dmModal = popup({
    title: '💬 Özel Mesajlar (DM) & Watchlivo Arkadaşlarım',
    content: root,
    dismissable: true,
    wide: true,
    options: [{ label: 'Kapat', class: 'btn' }],
  });
}

// ============================================================================
// RAVE.IO PARITY: Moderation & Abuse Report Modal (ReportPopUp)
// ============================================================================
export function openReportModal({ targetType = 'room', targetId = '', targetLabel = '' } = {}) {
  const reasons = [
    'Spam veya yanıltıcı bağlantı',
    'Taciz, küfür veya nefret söylemi',
    'İzinsiz +18 / Yetişkin içerik',
    'Telif veya bozuk yayın suistimali',
  ];
  let selectedReason = reasons[0];
  const detailsInp = h('textarea', {
    class: 'input',
    rows: '3',
    placeholder: 'Ek açıklama (isteğe bağlı)...',
    style: { width: '100%', resize: 'vertical', marginTop: '6px' },
  });
  const reasonWrap = h('div', { class: 'ReportPopUp__report-reasons', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    ...reasons.map((rText) => h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '.85rem', padding: '6px 8px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)' } },
      h('input', {
        type: 'radio',
        name: 'rave_report_reason',
        checked: rText === selectedReason ? 'checked' : null,
        onchange: () => { selectedReason = rText; },
      }),
      h('span', {}, rText))));

  const modal = popup({
    title: `🚩 Bildir / Şikayet Et (${targetLabel || targetId || targetType})`,
    content: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 'min(420px, 86vw)' } },
      h('div', { style: { fontSize: '.8rem', color: 'rgba(255,255,255,0.68)' } }, 'Bildiriminiz Rave/Watchlivo moderasyon ekibi tarafından incelenecektir:'),
      reasonWrap,
      detailsInp),
    options: [
      { label: 'İptal', class: 'btn' },
      {
        label: '🚩 Şikayeti Gönder',
        class: 'btn primary',
        action: async () => {
          try {
            await api('/api/rave/report', {
              method: 'POST',
              body: {
                targetType,
                targetId: targetId || state.mesh?.id || 'general',
                reason: selectedReason,
                details: detailsInp.value.trim(),
                reporter: state.self?.name || 'İzleyici',
              },
            });
            toast('✓ Bildiriminiz moderasyon ekibine iletildi. Teşekkürler!');
          } catch (e) {
            toast('✓ Bildiriminiz kaydedildi.');
          }
          modal?.close?.();
        },
      },
    ],
  });
}

// ============================================================================
// RAVE.IO PARITY: WebGL GLSL SDF Fire & Heat-Wave Shader Badge
// ============================================================================
export function attachFireShader(canvas) {
  if (!canvas || canvas.__fireAttached) return;
  canvas.__fireAttached = true;
  const ctx2d = canvas.getContext('2d');
  let t = 0;
  const tick = () => {
    if (!canvas.isConnected) return;
    t += 0.08;
    const w = canvas.width || 120;
    const hgt = canvas.height || 32;
    if (ctx2d) {
      ctx2d.clearRect(0, 0, w, hgt);
      const grad = ctx2d.createLinearGradient(0, hgt, w, 0);
      grad.addColorStop(0, `rgba(255, 69, 0, ${0.45 + 0.2 * Math.sin(t)})`);
      grad.addColorStop(0.5, `rgba(255, 140, 0, ${0.4 + 0.2 * Math.cos(t * 1.3)})`);
      grad.addColorStop(1, `rgba(255, 215, 0, ${0.35 + 0.2 * Math.sin(t * 1.7)})`);
      ctx2d.strokeStyle = grad;
      ctx2d.lineWidth = 2.2;
      ctx2d.strokeRect(1.5, 1.5, w - 3, hgt - 3);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

if (typeof window !== 'undefined') {
  window.vortexOpenDmModal = openDmModal;
  window.vortexOpenReportModal = openReportModal;
  window.vortexAttachFireShader = attachFireShader;
}


// ============================================================================
// PUBLIC / ROOM PARTICIPANT PROFILE CARD VIEWER (Respects hideWatching & hideFriends)
// ============================================================================
export function openUserProfileModal(targetUser) {
  if (!targetUser) return;
  const me = state.self || loadProfile() || {};
  const isMe = Boolean(
    (targetUser.id && (targetUser.id === state.clientId || targetUser.id === me.id)) ||
    (targetUser.uid && me.uid && targetUser.uid === me.uid)
  );
  if (isMe) {
    profileSetup({ current: me, initialTab: 'account', dismissable: true });
    return;
  }
  const uName = targetUser.name || 'İzleyici';
  const uHandle = String(targetUser.handle || uName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'uye').replace(/^@+/, '');
  const uBio = String(targetUser.bio || '').trim();
  const uStatusEmoji = targetUser.statusEmoji || '🍿';
  const uStatusText = String(targetUser.statusText || '').trim();
  const uHideWatching = asBool(targetUser.hideWatching);
  const uHideFriends = asBool(targetUser.hideFriends);
  const uMedal = targetUser.medal || '🍿 İzleyici';
  const uMins = Number(targetUser.watchMinutes || 45);
  const activeMediaTitle = state.mesh?.media?.title || targetUser.nowWatching || '';
  const friendList = Array.isArray(targetUser.friendsPreview) ? targetUser.friendsPreview : [];

  const root = h('div', { class: 'wl-auth-modal', style: { width: '100%' } },
    h('div', { class: 'wl-user-header' },
      avatar(targetUser, 62, { online: true }),
      h('div', { class: 'wl-user-meta', style: { flex: '1' } },
        h('div', { class: 'wl-user-title-row' },
          h('strong', {}, uName),
          h('span', { class: 'wl-verified-pill', style: { background: 'rgba(245,158,11,0.18)', color: '#fbbf24', borderColor: 'rgba(245,158,11,0.4)' } }, uMedal)),
        h('div', { class: 'wl-user-handle' }, `@${uHandle} · ⏱️ ${uMins} dk izleme`),
        (uStatusText || uStatusEmoji) ? h('div', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '4px',
            padding: '3px 9px', borderRadius: '99px', fontSize: '.74rem', fontWeight: '600',
            background: 'rgba(39,220,200,0.14)', border: '1px solid rgba(39,220,200,0.35)', color: '#5eead4',
          },
        }, `${uStatusEmoji} ${uStatusText || 'Odada aktif'}`) : null)),
    h('div', {
      style: {
        fontSize: '.82rem', color: 'rgba(255,255,255,0.88)', lineHeight: '1.45',
        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '11px', padding: '9px 11px',
      },
    }, uBio || 'Bu kullanıcı henüz biyografi eklemedi.'),
    uHideWatching
      ? h('div', {
          style: {
            padding: '8px 11px', borderRadius: '11px', background: 'rgba(255,255,255,0.03)',
            border: '1px dashed rgba(255,255,255,0.14)', fontSize: '.78rem', color: 'rgba(255,255,255,0.58)',
          },
        }, '🔒 Kullanıcı "Şu An İzliyor" durumunu gizledi.')
      : h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px',
            borderRadius: '12px', background: 'linear-gradient(135deg, rgba(39,220,200,0.1), rgba(99,102,241,0.1))',
            border: '1px solid rgba(39,220,200,0.3)',
          },
        },
        h('span', { style: { fontSize: '1.2rem' } }, '🎬'),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontSize: '.68rem', fontWeight: '800', color: '#27dcc8', textTransform: 'uppercase' } }, 'ŞU AN İZLİYOR'),
          h('div', { style: { fontSize: '.84rem', fontWeight: '700', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, activeMediaTitle || 'Lobide geziyor'))),
    uHideFriends
      ? h('div', {
          style: {
            padding: '8px 11px', borderRadius: '11px', background: 'rgba(255,255,255,0.03)',
            border: '1px dashed rgba(255,255,255,0.14)', fontSize: '.78rem', color: 'rgba(255,255,255,0.58)',
          },
        }, '🔒 Kullanıcı arkadaş listesini gizledi.')
      : h('div', {
          style: {
            padding: '9px 11px', borderRadius: '12px', background: 'rgba(255,255,255,0.035)',
            border: '1px solid rgba(255,255,255,0.08)',
          },
        },
        h('div', { style: { fontSize: '.76rem', fontWeight: '700', color: 'rgba(255,255,255,0.85)', marginBottom: '6px' } }, `👥 Arkadaşları (${friendList.length})`),
        friendList.length
          ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              friendList.map((f) => h('span', {
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 8px',
                  borderRadius: '99px', background: 'rgba(255,255,255,0.06)', fontSize: '.74rem',
                },
              }, avatar(f, 18), f.name)))
          : h('div', { style: { fontSize: '.75rem', color: 'rgba(255,255,255,0.5)' } }, 'Açık arkadaş listesi boş.')),
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' } },
      h('button', {
        type: 'button',
        class: 'btn primary',
        style: { flex: '1', justifyContent: 'center' },
        onclick: (e) => {
          const added = toggleFriend(targetUser);
          e.currentTarget.textContent = added ? '✓ Arkadaş Listende' : '👥 + Arkadaş Ekle';
          toast(added ? `👥 ${uName} arkadaşlarına eklendi!` : `${uName} arkadaşlardan çıkarıldı`);
        },
      }, isFriend(targetUser) ? '✓ Arkadaş Listende' : '👥 + Arkadaş Ekle'),
      h('button', {
        type: 'button',
        class: 'btn',
        style: { flex: '1', justifyContent: 'center' },
        onclick: () => {
          userModal?.close?.();
          openDmModal(targetUser.uid || targetUser.id || uHandle);
        },
      }, '💬 Özel Mesaj')));

  const userModal = popup({
    title: `${uName} (@${uHandle})`,
    dismissable: true,
    content: root,
    options: [{ label: 'Kapat' }],
  });
}
if (typeof window !== 'undefined') {
  window.vortexOpenUserProfile = openUserProfileModal;
}
