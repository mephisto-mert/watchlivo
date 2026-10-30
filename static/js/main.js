// Watchlivo entry: profile bootstrap + hash router (#/ home, #/mesh/:id) — Rave home ⇄ mesh navigation parity.
import { state, set } from './store.js?v=20261030_v29';
import { loadProfile, saveProfile, profileSetup, checkRedirectAuth } from './profile.js?v=20261030_v29';
import { renderHome, destroyHome } from './views/home.js?v=20261030_v29';
import { enterMesh, leaveMeshView } from './views/mesh.js?v=20261030_v29';
import { api } from './api.js?v=20261030_v29';
import { toast } from './ui.js?v=20261030_v29';

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
let activeMeshRoomId = null;

function ensureViewRoots(app) {
  let homeRoot = document.getElementById('home-root');
  let meshRoot = document.getElementById('mesh-root');
  if (!homeRoot || !meshRoot) {
    homeRoot = document.createElement('div');
    homeRoot.id = 'home-root';
    homeRoot.className = 'app-view-root hidden';
    meshRoot = document.createElement('div');
    meshRoot.id = 'mesh-root';
    meshRoot.className = 'app-view-root hidden';
    app.replaceChildren(homeRoot, meshRoot);
  }
  return { homeRoot, meshRoot };
}

window.vortexMinimizeRoom = () => {
  if (!activeMeshRoomId) {
    navigate('/');
    return;
  }
  document.body.classList.add('mesh-minimized');
  document.body.classList.remove('vortex-fs');
  toast('🗗 Oda sağ alta küçültüldü · Gezinmeye devam edebilirsin');
  navigate('/');
};

window.vortexRestoreRoom = () => {
  if (!activeMeshRoomId) return;
  document.body.classList.remove('mesh-minimized');
  navigate(`/mesh/${encodeURIComponent(activeMeshRoomId)}`);
};

window.vortexCloseMinimizedRoom = () => {
  document.body.classList.remove('mesh-minimized');
  activeMeshRoomId = null;
  leaveMeshView();
  const meshRoot = document.getElementById('mesh-root');
  if (meshRoot) {
    meshRoot.replaceChildren();
    meshRoot.classList.add('hidden');
  }
  toast('Odadan ayrıldın');
};

async function route() {
  const r = parseRoute();
  const app = document.getElementById('app');
  const { homeRoot, meshRoot } = ensureViewRoots(app);
  set({ route: r });
  if (r.name === 'mesh') {
    document.body.classList.remove('mesh-minimized');
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    if (current === 'home') destroyHome();
    homeRoot.classList.add('hidden');
    meshRoot.classList.remove('hidden');
    if (activeMeshRoomId !== r.params.id || !state.mesh) {
      if (activeMeshRoomId) leaveMeshView();
      activeMeshRoomId = r.params.id;
      await enterMesh(meshRoot, r.params);
    } else {
      window.dispatchEvent(new Event('resize'));
    }
  } else {
    const keepMinimized = Boolean(activeMeshRoomId && document.body.classList.contains('mesh-minimized') && state.mesh);
    if (!keepMinimized) {
      document.body.classList.remove('mesh-minimized');
      if (activeMeshRoomId) {
        activeMeshRoomId = null;
        leaveMeshView();
      }
      meshRoot.replaceChildren();
      meshRoot.classList.add('hidden');
    } else {
      meshRoot.classList.remove('hidden');
    }
    homeRoot.classList.remove('hidden');
    renderHome(homeRoot);
  }
  current = r.name;
}

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}
window.vortexNavigate = navigate;

async function boot() {
  if (navigator.userAgent.includes('WatchlivoApp') || window.Android || window.matchMedia('(display-mode: standalone)').matches) {
    document.documentElement.classList.add('is-apk');
  }
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
    const guestFallback = { id: 'guest_' + Math.random().toString(36).slice(2, 9), name: 'Misafir İzleyici', handle: 'misafir', color: '#27DCC8', isGuest: true };
    start(guestFallback);
    if (!location.hash || location.hash === '#/' || location.hash === '#') {
      profileSetup({ dismissable: true, onDone: start });
    }
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }
}

boot();
