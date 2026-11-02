// Watchlivo entry: profile bootstrap + hash router (#/ home, #/mesh/:id) — Rave home ⇄ mesh navigation parity.
import { state, set } from './store.js?v=20261102_v72';
import { loadProfile, saveProfile, profileSetup, checkRedirectAuth } from './profile.js?v=20261102_v72';
import { renderHome, destroyHome } from './views/home.js?v=20261102_v72';
import { enterMesh, leaveMeshView } from './views/mesh.js?v=20261102_v72';
import { api } from './api.js?v=20261102_v72';
import { h, toast } from './ui.js?v=20261102_v72';

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
let enteringMeshRoomId = null;

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
  leaveMeshView(true);
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
    document.querySelectorAll('.modal-backdrop, .popup-backdrop').forEach((el) => el.remove());
    if (current === 'home') destroyHome();
    homeRoot.classList.add('hidden');
    meshRoot.classList.remove('hidden');
    const hasMeshDom = Boolean(meshRoot.querySelector('.mesh-layout'));
    if (enteringMeshRoomId === r.params.id && hasMeshDom) {
      window.dispatchEvent(new Event('resize'));
    } else if (activeMeshRoomId !== r.params.id || !state.mesh || !hasMeshDom) {
      if (activeMeshRoomId && activeMeshRoomId !== r.params.id) {
        leaveMeshView(true);
      }
      activeMeshRoomId = r.params.id;
      enteringMeshRoomId = r.params.id;
      try {
        await enterMesh(meshRoot, r.params);
      } finally {
        if (enteringMeshRoomId === r.params.id) enteringMeshRoomId = null;
      }
    } else {
      window.dispatchEvent(new Event('resize'));
    }
  } else {
    if (activeMeshRoomId && state.mesh) {
      document.body.classList.add('mesh-minimized');
    }
    const keepMinimized = Boolean(activeMeshRoomId && document.body.classList.contains('mesh-minimized') && state.mesh);
    if (!keepMinimized) {
      document.body.classList.remove('mesh-minimized');
      if (activeMeshRoomId) {
        activeMeshRoomId = null;
        leaveMeshView(true);
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
  const clean = String(path || '/').replace(/^#+/, '');
  if (location.hash === `#${clean}`) route();
  else location.hash = clean;
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
  let routed = false;
  const start = (p) => {
    set({ self: p });
    if (!routed) {
      routed = true;
      window.addEventListener('hashchange', route);
    }
    route();
  };
  const initialProfile = loadProfile();
  if (initialProfile) {
    start(initialProfile);
  } else {
    const guestFallback = { id: 'guest_' + Math.random().toString(36).slice(2, 9), name: 'Misafir İzleyici', handle: 'misafir', color: '#27DCC8', isGuest: true };
    start(guestFallback);
    if (!isRedirectPending && (!location.hash || location.hash === '#/' || location.hash === '#')) {
      profileSetup({ dismissable: true, onDone: start });
    }
  }
  checkRedirectAuth().then((redirectProf) => {
    if (redirectProf) start(redirectProf);
  }).catch(() => {});
  if ('serviceWorker' in navigator) {
    initRaveNotifications();
  }
}

function initRaveNotifications() {
  let swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js?v=20261102_v72').then((reg) => {
      swReg = reg;
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (event) => {
      const d = event.data || {};
      if (d.type === 'WATCHLIVO_NOTIFICATION_CLICK' && d.url) {
        const cleanHash = String(d.url).replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?#/, '');
        if (cleanHash) navigate(cleanHash);
      }
    });
  }

  const ensureStack = () => {
    let st = document.getElementById('rave-notif-stack');
    if (!st) {
      st = h('div', { class: 'rave-notif-stack', id: 'rave-notif-stack' });
      document.body.appendChild(st);
    }
    return st;
  };

  window.vortexShowNotificationCard = (payload = {}) => {
    const title = String(payload.title || 'Watchlivo — Sinema Daveti');
    const body = String(payload.body || 'Arkadaşın seni sinema odasına çağırıyor!');
    const roomId = String(payload.roomId || '');
    const targetUrl = String(payload.url || (roomId ? `/#/mesh/${encodeURIComponent(roomId)}` : ''));
    const stack = ensureStack();
    while (stack.childElementCount >= 3) {
      stack.firstElementChild?.remove();
    }
    const card = h('div', { class: 'rave-notif-card' },
      h('div', { class: 'rave-notif-icon' }, payload.type === 'dm' ? '💬' : '🎬'),
      h('div', { class: 'rave-notif-body' },
        h('div', { class: 'rave-notif-title' }, title),
        h('div', { class: 'rave-notif-text' }, body)),
      h('div', { class: 'rave-notif-actions' },
        (roomId || targetUrl) ? h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: () => {
            card.remove();
            if (roomId) navigate(`/mesh/${encodeURIComponent(roomId)}`);
            else if (targetUrl) {
              const cleanHash = targetUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?#/, '');
              if (cleanHash) navigate(cleanHash);
            }
          },
        }, 'Katıl') : null,
        h('button', {
          type: 'button',
          class: 'btn sm ghost',
          onclick: () => card.remove(),
        }, '✕')));
    stack.appendChild(card);
    setTimeout(() => { try { card.remove(); } catch (e) { /* ignore */ } }, 9000);

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && (document.visibilityState === 'hidden' || payload.forceOsNotification)) {
      if (swReg?.active) {
        swReg.active.postMessage({ type: 'WATCHLIVO_SHOW_NOTIFICATION', payload });
      } else {
        try {
          const n = new Notification(title, { body, icon: '/static/watchlivo-icon-192.png' });
          n.onclick = () => {
            window.focus();
            if (roomId) navigate(`/mesh/${encodeURIComponent(roomId)}`);
            n.close();
          };
        } catch (e) { /* ignore */ }
      }
    }
  };

  window.vortexRequestPushPermission = async () => {
    if (typeof Notification === 'undefined') {
      toast('Bu tarayıcı bildirimleri desteklemiyor.');
      return false;
    }
    let perm = Notification.permission;
    if (perm !== 'granted') {
      try { perm = await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    if (perm === 'granted') {
      try { localStorage.setItem('vortex_push_enabled', 'on'); } catch (e) { /* ignore */ }
      await api('/api/rave/notifications/subscribe', {
        method: 'POST',
        body: {
          uid: state.self?.uid || state.self?.id || state.clientId,
          name: state.self?.name || 'İzleyici',
          subscription: { granted: true, ts: Date.now() },
        },
      }).catch(() => {});
      toast('🔔 Arka plan ve masaüstü bildirimleri açıldı!');
      window.vortexShowNotificationCard?.({
        title: '🔔 Bildirimler Aktif',
        body: 'Arkadaşların oda açtığında veya davet gönderdiğinde anında bildirim alacaksın.',
        forceOsNotification: true,
      });
      return true;
    }
    toast('⚠️ Bildirim izni verilmedi. Tarayıcı adres çubuğundan izin verebilirsin.');
    return false;
  };

  window.vortexSendRoomNotification = async (extra = {}) => {
    const rid = extra.roomId || state.mesh?.id || '';
    const rTitle = extra.roomTitle || state.mesh?.media?.title || state.mesh?.name || 'Sinema Odası';
    const sender = state.self?.name || 'Arkadaşın';
    const res = await api('/api/rave/notifications/send', {
      method: 'POST',
      body: {
        fromUid: state.self?.uid || state.self?.id || state.clientId,
        fromName: sender,
        roomId: rid,
        roomTitle: rTitle,
        targetUid: extra.targetUid || '*',
        url: `${location.origin}/#/mesh/${encodeURIComponent(rid)}`,
      },
    }).catch(() => null);
    if (res?.ok) {
      toast('🔔 Arkadaşlarına anlık oda daveti bildirimi gönderildi!');
    }
    return res;
  };

  let lastNotifTs = Date.now() / 1000;
  const seenNotifIds = new Set();
  setInterval(async () => {
    const uid = state.self?.uid || state.self?.id || state.clientId || 'guest_default';
    const name = state.self?.name || '';
    const res = await api(`/api/rave/notifications/poll?uid=${encodeURIComponent(uid)}&name=${encodeURIComponent(name)}&since=${encodeURIComponent(lastNotifTs)}`).catch(() => null);
    if (res?.ok && Array.isArray(res.notifications)) {
      for (const item of res.notifications) {
        if (!item?.id || seenNotifIds.has(item.id)) continue;
        seenNotifIds.add(item.id);
        lastNotifTs = Math.max(lastNotifTs, Number(item.ts || 0));
        if (item.roomId && item.roomId === state.mesh?.id) continue;
        window.vortexShowNotificationCard?.({ ...item, forceOsNotification: true });
      }
      if (res.serverTs) lastNotifTs = Math.max(lastNotifTs, Number(res.serverTs) - 1);
    }
  }, 12000);
}

boot();
