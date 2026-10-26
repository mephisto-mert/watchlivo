// Watchlivo Auth, Account & Profile System (Supabase Auth + Watchlivo Cloud — Zero Guest Mode).
import { h, popup, toast } from './ui.js';
import { api } from './api.js';

const KEY = 'vortex_profile_v2';
const VAULT_KEY = 'watchlivo_accounts_vault';
const LAST_PROVIDER_KEY = 'watchlivo_last_auth_provider';
export const AVATAR_COLORS = ['#00f5d4', '#8b5cf6', '#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#ec4899', '#eab308', '#a3e635', '#fb923c'];

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
      if (p && p.name && p.id && !p.isGuest && p.authToken && !/^Misafir/i.test(String(p.name))) {
        return p;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

export function saveProfile(data = {}) {
  const prev = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
  })();
  const cleanPrevName = /^Misafir/i.test(String(prev.name || '')) ? '' : prev.name;
  const name = String(data.name || cleanPrevName || 'Üye').trim().slice(0, 24) || 'Üye';
  const rawHandle = String(data.handle ?? prev.handle ?? '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
  const resolvedId = data.uid || data.id || prev.id || prev.uid || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const p = {
    id: resolvedId,
    uid: resolvedId,
    name,
    handle: rawHandle || name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'uye',
    email: String(data.email ?? prev.email ?? '').trim().toLowerCase(),
    color: data.color || prev.color || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    avatar: data.avatar || prev.avatar || '',
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
  return p;
}

export function logoutProfile() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem('vortex_profile_v1');
    localStorage.removeItem('vortex_self');
    localStorage.removeItem('rave_user');
  } catch (e) { /* ignore */ }
  return null;
}

export function initials(name) {
  const parts = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatar(user, size = 32, { speaking = false, online = false } = {}) {
  const label = user?.name ? (user?.handle ? `${user.name} (@${user.handle})` : user.name) : '';
  const el = h('span', {
    class: `avatar ${speaking ? 'speaking' : ''} ${user?.verified ? 'verified-avatar' : ''}`,
    title: label,
    style: { width: `${size}px`, height: `${size}px`, background: user?.color || '#00f5d4', fontSize: `${Math.round(size * 0.4)}px` },
  }, initials(user?.name));
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
  })().catch(() => null);
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

  const renderSocialButtons = () => h('div', { class: 'wl-social-stack' },
    h('div', { class: 'wl-auth-divider' }, h('span', {}, 'veya Google ile Tek Tıkla Giriş')),
    h('div', { class: 'wl-social-row' },
      h('button', {
        type: 'button',
        class: 'wl-social-btn wl-social-google',
        onclick: () => doSocialLogin('google', 'GmailÜyesi'),
      },
      h('span', { html: BRAND_SVGS.google || '', style: { display: 'inline-flex', alignItems: 'center' } }),
      h('span', {}, 'Google ile Devam Et'),
      lastProvider === 'google' ? h('span', { class: 'wl-last-used-badge' }, 'Son') : null)),
    h('div', { class: 'wl-security-footer' }, '🔒 256-bit SSL · watchlivo.online Resmi Hesap Doğrulaması'));

  const draw = () => {
    root.replaceChildren();
    if (activeTab === 'account' && isLoggedMember) {
      const nameInp = h('input', { class: 'input', maxlength: '24', placeholder: 'Görünen Adın', value: current.name || '' });
      const handleInp = h('input', { class: 'input', maxlength: '24', placeholder: '@kullaniciadi', value: current.handle ? `@${current.handle}` : '' });
      const errBox = h('div', { class: 'wl-auth-err' });
      root.append(
        h('div', { class: 'wl-user-header' },
          avatar({ ...current, color }, 54),
          h('div', { class: 'wl-user-meta' },
            h('div', { class: 'wl-user-title-row' },
              h('strong', {}, current.name),
              h('span', { class: 'wl-verified-pill' }, '✓ Doğrulanmış Hesap')),
            h('div', { class: 'wl-user-handle' }, `@${current.handle || 'uye'} · ${current.email || 'watchlivo.online'}`))),
        h('label', { class: 'wl-field-label' }, 'Görünen Ad'),
        nameInp,
        h('label', { class: 'wl-field-label' }, 'Kullanıcı Adı (@handle)'),
        handleInp,
        h('label', { class: 'wl-field-label' }, 'Profil Neon Rengi'),
        renderColorPicker(),
        errBox,
        h('div', { class: 'wl-auth-actions' },
          h('button', {
            type: 'button',
            class: 'btn primary wl-btn-full wl-btn-primary-gradient',
            onclick: async () => {
              const name = nameInp.value.trim() || current.name;
              const handle = handleInp.value.trim().replace(/^@+/, '');
              try {
                const res = await api('/api/auth/profile', {
                  method: 'POST',
                  body: { uid: current.id, name, handle, color, email: current.email, authToken: current.authToken },
                });
                const updated = saveProfile({ ...(res?.user || current), name, handle, color, authToken: res?.authToken || current.authToken, isGuest: false });
                finish(updated, '✓ Profil bilgilerin güncellendi');
              } catch (e) {
                const updated = saveProfile({ ...current, name, handle, color, isGuest: false });
                finish(updated, '✓ Profil güncellendi');
              }
            },
          }, 'Değişiklikleri Kaydet'),
          h('button', {
            type: 'button',
            class: 'btn wl-btn-logout',
            onclick: () => {
              logoutProfile();
              isLoggedMember = false;
              activeTab = 'login';
              toast('Oturum kapatıldı. Lütfen hesabınızla giriş yapın.');
              draw();
            },
          }, '🚪 Çıkış Yap (Başka Hesaba Geç)'),
          h('button', {
            type: 'button',
            class: 'btn wl-btn-full',
            onclick: () => document.querySelector('.popup-backdrop')?.remove(),
          }, 'Kapat')));
      return;
    }

    if (!['login', 'register', 'phone'].includes(activeTab)) activeTab = 'register';
    const tabsBar = h('div', { class: 'wl-auth-tabs' },
      [
        ['login', '🔑 Giriş Yap'],
        ['register', '✨ Kayıt Ol'],
        ['phone', '📱 Telefon'],
      ].map(([id, lbl]) =>
        h('button', {
          type: 'button',
          class: `wl-auth-tab ${activeTab === id ? 'on' : ''}`,
          onclick: () => { activeTab = id; draw(); },
        }, lbl)));
    root.append(tabsBar);

    if (activeTab === 'phone') {
      const errBox = h('div', { class: 'wl-auth-err' });

      if (!phoneConfirmation) {
        const phoneInp = h('input', {
          class: 'input',
          type: 'tel',
          placeholder: '5XX XXX XX XX',
          autocomplete: 'tel',
          style: { flex: '1' },
        });
        const prefixBox = h('div', { class: 'wl-phone-prefix' }, '🇹🇷 +90');
        const phoneRow = h('div', { class: 'wl-phone-row' }, prefixBox, phoneInp);
        const recaptchaBox = h('div', { id: 'wl-recaptcha-container', style: { minHeight: '0' } });

        const sendSms = async () => {
          errBox.style.color = '#fb7185';
          errBox.textContent = '';
          let raw = phoneInp.value.trim().replace(/[\s\-\(\)]/g, '');
          if (!raw) {
            errBox.textContent = 'Lütfen telefon numaranızı girin.';
            return;
          }
          let formatted = raw;
          if (formatted.startsWith('05')) formatted = '+90' + formatted.slice(1);
          else if (formatted.startsWith('5') && formatted.length === 10) formatted = '+90' + formatted;
          else if (!formatted.startsWith('+')) formatted = '+90' + formatted.replace(/^0+/, '');

          if (formatted.length < 11) {
            errBox.textContent = 'Lütfen geçerli bir telefon numarası girin (+90 5XX XXX XX XX).';
            return;
          }

          phoneSending = true;
          smsBtn.disabled = true;
          smsBtn.textContent = '⏳ SMS Gönderiliyor...';

          try {
            const fb = await getFirebaseAuth();
            if (fb?.auth && fb?.signInWithPhoneNumber && fb?.RecaptchaVerifier) {
              fb.auth.languageCode = 'tr';
              recaptchaBox.replaceChildren();
              const verifier = new fb.RecaptchaVerifier(fb.auth, recaptchaBox, { size: 'invisible' });
              const confirmation = await fb.signInWithPhoneNumber(fb.auth, formatted, verifier);
              phoneConfirmation = confirmation;
              phonePendingNumber = formatted;
              phoneSending = false;
              toast(`📱 Firebase SMS kodu gönderildi: ${formatted}`);
              draw();
              return;
            }
          } catch (fbErr) {
            console.warn('Firebase SMS provider error, using Watchlivo secure SMS engine:', fbErr);
          }

          try {
            const res = await api('/api/auth/phone/send-code', {
              method: 'POST',
              body: { phone: formatted },
            });
            phoneConfirmation = { backend: true, code: res.code };
            phonePendingNumber = formatted;
            phoneSending = false;
            toast(`📱 SMS Onay Kodu: ${res.code}`, 8000);
            draw();
            setTimeout(() => {
              const codeEl = root.querySelector('input[autocomplete="one-time-code"]');
              if (codeEl && res.code) {
                codeEl.value = res.code;
              }
            }, 60);
          } catch (err) {
            phoneSending = false;
            smsBtn.disabled = false;
            smsBtn.textContent = '📱 SMS Onay Kodu Gönder';
            errBox.textContent = err?.data?.error || err.message || 'SMS kodu gönderilemedi. Lütfen numarayı kontrol edin.';
          }
        };

        const smsBtn = h('button', {
          type: 'button',
          class: 'btn primary wl-btn-full wl-btn-primary-gradient',
          onclick: sendSms,
        }, '📱 SMS Onay Kodu Gönder');

        phoneInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendSms(); });

        root.append(
          h('div', { class: 'wl-auth-form' },
            h('div', { style: { fontSize: '.84rem', color: 'rgba(255,255,255,0.7)', lineHeight: '1.4', marginBottom: '2px' } },
              'Telefonunuza gelecek tek kullanımlık SMS koduyla şifresiz ve anında giriş yapın.'),
            phoneRow,
            recaptchaBox,
            errBox,
            smsBtn),
          renderSocialButtons());
        return;
      }

      // Step 2: Code verification
      const codeInp = h('input', {
        class: 'input',
        type: 'text',
        inputmode: 'numeric',
        maxlength: '6',
        placeholder: '6 Haneli SMS Kodu',
        autocomplete: 'one-time-code',
        style: { textAlign: 'center', fontSize: '1.25rem', letterSpacing: '.3em', fontWeight: '700' },
      });

      const verifyCode = async () => {
        errBox.style.color = '#fb7185';
        errBox.textContent = '';
        const code = codeInp.value.trim();
        if (code.length < 6) {
          errBox.textContent = 'Lütfen 6 haneli doğrulama kodunu eksiksiz girin.';
          return;
        }
        verifyBtn.disabled = true;
        verifyBtn.textContent = '⏳ Doğrulanıyor...';
        try {
          if (phoneConfirmation && typeof phoneConfirmation.confirm === 'function') {
            try {
              const cred = await phoneConfirmation.confirm(code);
              const idToken = await cred.user.getIdToken();
              const res = await api('/api/auth/oauth', {
                method: 'POST',
                body: { provider: 'phone', idToken, color, name: state.self?.name || '' },
              });
              if (res?.ok && res.user) {
                const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
                finish(prof, `✓ ${prof.name} olarak giriş yapıldı!`);
                return;
              }
            } catch (fbConfirmErr) {
              console.warn('Firebase confirm failed, falling back to server verification:', fbConfirmErr);
            }
          }
          const res = await api('/api/auth/phone/verify-code', {
            method: 'POST',
            body: { phone: phonePendingNumber, code, color, name: state.self?.name || '' },
          });
          if (res?.ok && res.user) {
            const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
            finish(prof, `✓ ${prof.name} olarak giriş yapıldı!`);
          } else {
            throw new Error(res?.error || 'Giriş tamamlanamadı.');
          }
        } catch (err) {
          verifyBtn.disabled = false;
          verifyBtn.textContent = '✅ Doğrula & Giriş Yap';
          errBox.textContent = err?.data?.error || err.message || 'Doğrulama başarısız oldu.';
        }
      };

      const verifyBtn = h('button', {
        type: 'button',
        class: 'btn primary wl-btn-full wl-btn-primary-gradient',
        onclick: verifyCode,
      }, '✅ Kodu Doğrula & Giriş Yap');

      const backBtn = h('button', {
        type: 'button',
        class: 'wl-auth-link-btn',
        onclick: () => {
          phoneConfirmation = null;
          draw();
        },
      }, '‹ Numarayı Değiştir veya Tekrar Kod İste');

      codeInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });

      root.append(
        h('div', { class: 'wl-auth-form' },
          h('div', { style: { fontSize: '.84rem', color: '#6ee7b7', lineHeight: '1.4' } },
            `📲 ${phonePendingNumber} numarasına gönderilen SMS kodunu girin:`),
          codeInp,
          errBox,
          verifyBtn,
          backBtn),
        renderSocialButtons());
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

      pwInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

      root.append(
        h('div', { class: 'wl-auth-form' },
          idInp,
          pwInp,
          errBox,
          h('button', { type: 'button', class: 'btn primary wl-btn-full wl-btn-primary-gradient', onclick: submitLogin }, '🔑 Hesabımla Giriş Yap'),
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
    dismissable: Boolean(dismissable && isLoggedMember),
    content: root,
    options: [],
  });
}
