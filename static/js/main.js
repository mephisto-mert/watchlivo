// Watchlivo entry: profile bootstrap + hash router (#/ home, #/mesh/:id) — Rave home ⇄ mesh navigation parity.
import { state, set } from './store.js?v=20261029_v1';
import { loadProfile, saveProfile, profileSetup, checkRedirectAuth } from './profile.js?v=20261029_v1';
import { renderHome, destroyHome } from './views/home.js?v=20261029_v1';
import { enterMesh, leaveMeshView } from './views/mesh.js?v=20261029_v1';
import { api } from './api.js?v=20261029_v1';
import { toast } from './ui.js?v=20261029_v1';

function parseRoute() {
  const legacyRoom = new URLSearchParams(location.search).get('room');
  if (legacyRoom && !location.hash) {
    history.replaceState({}, '', `/#/mesh/${encodeURIComponent(legacyRoom)}`);
  }
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (parts[0] === 'mesh' && parts[1]) return { name: 'mesh', params: { id: decodeURIComponent(parts[1]), ...params } };
  return { name: 'home', params };
}

let current = null;
async function route() {
  const r = parseRoute();
  const app = document.getElementById('app');
  if (current === 'mesh' && (r.name !== 'mesh' || r.params.id !== state.route.params.id)) leaveMeshView();
  if (current === 'home' && r.name !== 'home') destroyHome();
  set({ route: r });
  if (r.name === 'mesh') {
    if (current !== 'mesh' || state.mesh?.id !== r.params.id) await enterMesh(app, r.params);
  } else {
    renderHome(app);
  }
  current = r.name;
}

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}
window.vortexNavigate = navigate;

async function boot() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('vortex_st_') || k.startsWith('vortex_room_')) localStorage.removeItem(k);
    }
  } catch (e) { /* ignore */ }
  const sp = new URLSearchParams(location.search);
  const oobCode = sp.get('oobCode') || '';
  const mode = sp.get('mode') || '';
  if (oobCode && mode === 'signIn') {
    const email = sp.get('magic_email') || localStorage.getItem('watchlivo_pending_magic_email') || '';
    if (email) {
      try {
        const res = await api('/api/auth/email-action', {
          method: 'POST',
          body: { action: 'complete_magic_link', email, oobCode },
        });
        if (res?.ok && res.user) {
          saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
          toast(`✓ E-posta bağlantısı ile giriş yapıldı: @${res.user.handle}`);
          history.replaceState({}, '', '/');
        }
      } catch (e) { /* ignore */ }
    }
  }
  const isRedirectPending = Boolean(localStorage.getItem('watchlivo_auth_pending_redirect'));
  if (isRedirectPending) {
    toast('Google hesabınız doğrulanıyor, lütfen bekleyin...', 8000);
  }
  const redirectProf = await checkRedirectAuth();
  const profile = redirectProf || loadProfile();
  let routed = false;
  const start = (p) => {
    set({ self: p });
    if (!routed) {
      routed = true;
      window.addEventListener('hashchange', route);
    }
    route();
  };
  if (profile) {
    start(profile);
  } else {
    set({ self: { id: 'pending_auth', name: 'Hesap Girişi', handle: '', color: '#00f5d4', isGuest: true } });
    // Always render home backdrop so app never stays on an empty black screen
    const appEl = document.getElementById('app');
    if (appEl && !appEl.children.length) {
      renderHome(appEl);
    }
    profileSetup({ dismissable: false, onDone: start });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }
}

boot();
