// Watchlivo Desktop & Native iOS OAuth Handoff (externalized for strict script-src CSP).
const params = new URLSearchParams(location.search);
const authMode = (params.get('mode') || '').trim().toLowerCase();
const isIosMode = authMode === 'ios';
const rawPort = Number(params.get('port') || '49223');
const port = (Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535) ? String(rawPort) : '';
const state = (params.get('state') || '').trim();
const loginHint = (params.get('login_hint') || '').trim().toLowerCase();
const statusEl = document.getElementById('status');
const btn = document.getElementById('google-btn');

if (isIosMode) {
  document.title = 'Watchlivo — iOS Uygulama Girişi';
  const h1 = document.querySelector('h1');
  if (h1) h1.textContent = 'Watchlivo iOS Uygulamasına Giriş';
  const desc = document.querySelector('p.desc');
  if (desc) desc.textContent = 'Google veya e-posta hesabınla giriş yap; Watchlivo uygulamasına güvenli şekilde otomatik dönülecek.';
}

function setStatus(text, type = '', spinning = false) {
  statusEl.className = 'status-box ' + (type ? 'status-' + type : '');
  statusEl.replaceChildren();
  if (spinning) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    statusEl.appendChild(sp);
  }
  statusEl.appendChild(document.createTextNode(String(text || '')));
}

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAeyDRstvjN8c_D08U8CrqopcFT0_fz9fo',
  authDomain: 'watchlivo-38ab6.firebaseapp.com',
  projectId: 'watchlivo-38ab6',
  appId: '1:1034129375158:web:6ce9d8f15e625925090b17',
};

async function sendToDesktop(user, authToken) {
  if (isIosMode) {
    if (!state || !authToken) {
      setStatus('Geçersiz iOS oturum parametresi. Lütfen uygulamadan tekrar başlatın.', 'err');
      return;
    }
    setStatus('✓ Giriş Başarılı! Watchlivo iOS uygulamasına dönülüyor...', 'ok');
    if (btn) btn.style.display = 'none';
    const cbUrl = `watchlivo://auth?state=${encodeURIComponent(state)}&token=${encodeURIComponent(String(authToken))}`;
    window.location.href = cbUrl;
    return;
  }
  if (!port || !state) {
    setStatus('Geçersiz masaüstü oturum parametresi. Lütfen uygulamadan tekrar başlatın.', 'err');
    return;
  }
  setStatus('Masaüstü uygulamasına aktarılıyor...', '', true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, user, authToken }),
    });
    const json = await res.json();
    if (json.ok) {
      setStatus('✓ Giriş Başarılı! Masaüstü uygulaması açıldı. Bu sekmeyi kapatabilirsiniz.', 'ok');
      btn.style.display = 'none';
      setTimeout(() => window.close(), 2500);
    } else {
      setStatus('Aktarım hatası: ' + (json.error || 'Bilinmeyen hata'), 'err');
    }
  } catch (e) {
    setStatus('Masaüstü uygulamasına ulaşılamadı. Uygulamanın açık olduğundan emin olun.', 'err');
  }
}

const formEl = document.getElementById('desktop-auth-form');
const identEl = document.getElementById('desktop-ident');
const pwEl = document.getElementById('desktop-pw');
const emailBtn = document.getElementById('email-login-btn');

async function verifySessionToken(token) {
  try {
    const r = await fetch('/api/auth/me', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (d && d.authenticated === true && d.user) {
      return { user: d.user, authToken: token || d.authToken };
    }
  } catch (_) {}
  return null;
}

try {
  const saved = JSON.parse(localStorage.getItem('vortex_profile_v2') || 'null');
  const hasSessionTarget = isIosMode ? Boolean(state) : Boolean(port && state);
  if (hasSessionTarget && saved && saved.authToken && saved.name && !saved.isGuest) {
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-google';
    confirmBtn.style.cssText = 'margin-bottom:12px;background:#00f5d4;color:#041014;font-weight:800;';
    confirmBtn.textContent = isIosMode
      ? `${saved.name} (@${saved.handle || 'uye'}) olarak Watchlivo iOS'a Bağlan`
      : `${saved.name} (@${saved.handle || 'uye'}) olarak Masaüstüne Bağlan`;
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      const verified = await verifySessionToken(saved.authToken);
      if (!verified) {
        try { localStorage.removeItem('vortex_profile_v2'); } catch (_) {}
        confirmBtn.remove();
        setStatus('Oturumunuz sona ermiş. Lütfen tekrar giriş yapın.', 'err');
        return;
      }
      await sendToDesktop(verified.user, verified.authToken);
    });
    const anchor = formEl || btn;
    anchor?.parentNode?.insertBefore(confirmBtn, anchor);
    setStatus('Mevcut hesabınızla devam etmek için yukarıdaki onay butonuna tıklayın veya aşağıdan giriş yapın.');
  }
} catch (_) {}

emailBtn?.addEventListener('click', async () => {
  const ident = String(identEl?.value || '').trim();
  const pw = String(pwEl?.value || '');
  if (!ident) {
    setStatus('Lütfen e-posta adresinizi veya @kullanıcıadınızı girin.', 'err');
    identEl?.focus?.();
    return;
  }
  if (pw.length < 6) {
    setStatus('Lütfen en az 6 karakterli Watchlivo hesap şifrenizi girin.', 'err');
    pwEl?.focus?.();
    return;
  }
  emailBtn.disabled = true;
  setStatus('Hesap doğrulanıyor...', '', true);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: ident, password: pw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.user) throw new Error(data.error || 'Giriş başarısız.');
    localStorage.setItem('vortex_profile_v2', JSON.stringify({ ...data.user, authToken: data.authToken, isGuest: false, verified: true }));
    await sendToDesktop(data.user, data.authToken);
  } catch (err) {
    emailBtn.disabled = false;
    setStatus(err.message || 'Giriş yapılamadı.', 'err');
  }
});

let _desktopFbReady = null;
let _desktopFbPromise = null;
const preloadDesktopFb = () => {
  if (_desktopFbReady?.auth) return Promise.resolve(_desktopFbReady);
  if (_desktopFbPromise) return _desktopFbPromise;
  _desktopFbPromise = Promise.all([
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
  ]).then(([{ initializeApp, getApps }, { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult }]) => {
    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    _desktopFbReady = { auth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult };
    if (typeof auth.authStateReady === 'function') auth.authStateReady().catch(() => {});
    return _desktopFbReady;
  }).catch(() => {
    _desktopFbPromise = null;
    return null;
  });
  return _desktopFbPromise;
};
preloadDesktopFb();

async function exchangeFirebaseUser(fbUser, pw) {
  setStatus('Hesap doğrulanıyor...', '', true);
  const idToken = await fbUser.getIdToken(true);
  const apiRes = await fetch('/api/auth/oauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      idToken,
      email: fbUser.email || '',
      name: fbUser.displayName || 'Google Üyesi',
      password: pw,
    }),
  });
  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok || !data.ok || !data.user) throw new Error(data.error || `Sunucu doğrulaması başarısız (HTTP ${apiRes.status}).`);
  localStorage.setItem('vortex_profile_v2', JSON.stringify({ ...data.user, authToken: data.authToken, isGuest: false, verified: true }));
  await sendToDesktop(data.user, data.authToken);
}

(async () => {
  if (!isIosMode) return;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('wl_ios_auth_pending') || 'null'); } catch (_) {}
  if (!pending || !pending.ts || (Date.now() - Number(pending.ts) > 5 * 60 * 1000)) {
    try { sessionStorage.removeItem('wl_ios_auth_pending'); } catch (_) {}
    return;
  }
  try {
    setStatus('Google girişi tamamlanıyor...', '', true);
    const fb = await preloadDesktopFb();
    if (!fb?.auth || !fb.getRedirectResult) return;
    const cred = await fb.getRedirectResult(fb.auth).catch(() => null);
    const fbUser = cred?.user || fb.auth.currentUser;
    try { sessionStorage.removeItem('wl_ios_auth_pending'); } catch (_) {}
    if (fbUser) {
      await exchangeFirebaseUser(fbUser, String(pending.pw || ''));
    } else {
      setStatus('Google oturumu alınamadı. Tekrar deneyin.', 'err');
    }
  } catch (err) {
    try { sessionStorage.removeItem('wl_ios_auth_pending'); } catch (_) {}
    setStatus(err?.message || 'Google girişi doğrulanamadı.', 'err');
  }
})();

formEl?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pw = String(pwEl?.value || '');
  if (pw && pw.length < 6) {
    setStatus('Şifre belirlemek istiyorsanız en az 6 karakter girin (mevcut Google hesabınız için boş bırakabilirsiniz).', 'err');
    pwEl?.focus?.();
    return;
  }
  btn.disabled = true;
  setStatus('Google penceresi açılıyor...', '', true);
  try {
    const fb = _desktopFbReady?.auth ? _desktopFbReady : await preloadDesktopFb();
    if (!fb?.auth) throw new Error('Google giriş servisi yüklenemedi.');
    const provider = new fb.GoogleAuthProvider();
    const customParams = { prompt: 'select_account' };
    if (loginHint) customParams.login_hint = loginHint;
    provider.setCustomParameters(customParams);
    let cred = null;
    try {
      cred = await fb.signInWithPopup(fb.auth, provider);
    } catch (popErr) {
      const code = String(popErr?.code || popErr?.message || '');
      if (isIosMode && fb.signInWithRedirect && /popup-blocked|operation-not-supported|cancelled-popup-request/i.test(code)) {
        try { sessionStorage.setItem('wl_ios_auth_pending', JSON.stringify({ state, pw, ts: Date.now() })); } catch (_) {}
        setStatus('Google giriş sayfasına yönlendiriliyor...', '', true);
        await fb.signInWithRedirect(fb.auth, provider);
        return;
      }
      throw popErr;
    }
    if (!cred?.user) throw new Error('Google girişi tamamlanmadı.');
    await exchangeFirebaseUser(cred.user, pw);
  } catch (err) {
    btn.disabled = false;
    setStatus(err.message || 'Giriş yapılamadı.', 'err');
  }
});
