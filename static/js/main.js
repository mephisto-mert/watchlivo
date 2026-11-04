// Watchlivo entry: profile bootstrap + hash router (#/ home, #/mesh/:id) — Rave home ⇄ mesh navigation parity.
import { state, set, syncSocialState, updateFriendAction, pushPresenceHeartbeat } from './store.js?v=20261104_v94';
import { loadProfile, saveProfile, avatar, profileSetup, openDmModal, checkRedirectAuth, verifyAndRefreshSession } from './profile.js?v=20261104_v94';
import { renderHome, destroyHome } from './views/home.js?v=20261104_v94';
import { enterMesh, leaveMeshView } from './views/mesh.js?v=20261104_v94';
import { api } from './api.js?v=20261104_v94';
import { h, toast } from './ui.js?v=20261104_v94';

function parseRoute() {
  const legacyRoom = new URLSearchParams(location.search).get('room');
  if (legacyRoom && !location.hash) {
    history.replaceState({}, '', `/#/mesh/${encodeURIComponent(legacyRoom)}`);
  }
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (parts[0] === 'mesh' && parts[1]) {
    let roomId = parts[1];
    try { roomId = decodeURIComponent(parts[1]); } catch (_) {}
    return { name: 'mesh', params: { ...params, id: roomId } };
  }
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
    if (enteringMeshRoomId === r.params.id) {
      if (hasMeshDom) window.dispatchEvent(new Event('resize'));
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
  if (navigator.userAgent.includes('WatchlivoApp') || window.isWatchlivoNativeIOS || window.webkit?.messageHandlers?.watchlivoPiP || window.Android || window.matchMedia('(display-mode: standalone)').matches) {
    document.documentElement.classList.add('is-apk', 'is-native-apk');
  }
  window.__onWatchlivoAndroidPiP = (active) => {
    document.documentElement.classList.toggle('is-android-pip', Boolean(active));
    window.__kinoxHost?._onAndroidPipModeChange?.(Boolean(active));
    window.dispatchEvent(new Event('resize'));
  };
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted && !state.mesh?.id) {
      pushPresenceHeartbeat().catch(() => {});
      syncSocialState(true).catch(() => {});
    }
  });
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
    if (!initialProfile.isGuest) verifyAndRefreshSession().catch(() => {});
  } else {
    let guestFallback = null;
    try {
      guestFallback = JSON.parse(sessionStorage.getItem('vortex_temp_guest_v1') || 'null');
    } catch (e) { guestFallback = null; }
    if (!guestFallback || !guestFallback.id || !guestFallback.name || guestFallback.name === 'Misafir İzleyici') {
      const gTag = Math.floor(1000 + Math.random() * 9000);
      const gColors = ['#27DCC8', '#6366f1', '#8b5cf6', '#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#ec4899'];
      guestFallback = {
        id: 'guest_' + Math.random().toString(36).slice(2, 10),
        uid: '',
        name: `Misafir #${gTag}`,
        handle: `misafir${gTag}`,
        color: gColors[gTag % gColors.length],
        isGuest: true,
      };
      try { sessionStorage.setItem('vortex_temp_guest_v1', JSON.stringify(guestFallback)); } catch (e) { /* ignore */ }
    }
    start(guestFallback);
    if (!isRedirectPending && (!location.hash || location.hash === '#/' || location.hash === '#')) {
      profileSetup({ dismissable: true, onDone: start });
    }
  }
  checkRedirectAuth().then((redirectProf) => {
    if (redirectProf) start(redirectProf);
  }).catch(() => {});
  initPresenceLifecycle();
  initRaveNotifications();
}

function playNotifChime() {
  if (typeof document !== 'undefined' && document.hidden) return;
  const isIos = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  if (isIos && state.mesh?.id) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') { ctx.close?.(); return; }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.14);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
    setTimeout(() => ctx.close?.().catch?.(() => {}), 500);
  } catch (_) {}
}

function initPresenceLifecycle() {
  const sendBeat = (overrideState = '') => {
    const extra = overrideState ? { state: overrideState } : {};
    pushPresenceHeartbeat(extra).catch(() => {});
  };
  setTimeout(() => {
    sendBeat();
    syncSocialState(true).catch(() => {});
  }, 450);

  setInterval(() => {
    sendBeat();
    syncSocialState(false).catch(() => {});
  }, 24000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendBeat();
      syncSocialState(true).catch(() => {});
    } else if (!state.mesh?.id) {
      sendBeat('idle');
    }
  });

  const markOffline = () => {
    const s = state.self;
    const uid = String(s?.uid || s?.id || '').trim();
    if (!uid) return;
    try {
      const hdrs = { 'Content-Type': 'application/json' };
      if (s?.authToken) hdrs.Authorization = `Bearer ${s.authToken}`;
      fetch('/api/rave/social/presence', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ uid, state: 'offline' }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  };
  window.addEventListener('beforeunload', markOffline);
}

function initRaveNotifications() {
  let swReg = null;
  if ('serviceWorker' in navigator && !window.isWatchlivoNativeIOS && !window.Android) {
    navigator.serviceWorker.register('/sw.js?v=20261104_v94', { updateViaCache: 'none' }).then((reg) => {
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
      st = h('div', { class: 'rave-notif-stack NotificationWindowApp', id: 'rave-notif-stack' });
      document.body.appendChild(st);
    }
    return st;
  };

  window.vortexShowNotificationCard = (payload = {}) => {
    const nType = String(payload.type || 'room_invite');
    const title = String(payload.title || 'Watchlivo Bildirimi');
    const body = String(payload.body || 'Yeni bir bildirim aldın!');
    const roomId = String(payload.roomId || '');
    const targetUrl = String(payload.url || (roomId ? `/#/mesh/${encodeURIComponent(roomId)}` : ''));
    const stack = ensureStack();
    while (stack.childElementCount >= 3) {
      stack.firstElementChild?.remove();
    }
    playNotifChime();

    const closeCard = () => {
      card.classList.add('is-leaving');
      setTimeout(() => { try { card.remove(); } catch (_) {} }, 180);
    };

    const actionBtns = [];
    if (nType === 'friend_request' && (payload.requestId || payload.fromUid)) {
      actionBtns.push(
        h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: async () => {
            closeCard();
            const r = await updateFriendAction('accept', { requestId: payload.requestId || '', targetUid: payload.fromUid || '' });
            if (r?.ok) toast(`🎉 ${payload.fromName || 'Kullanıcı'} ile artık karşılıklı arkadaşsınız!`);
          },
        }, '✓ Kabul Et'),
        h('button', {
          type: 'button',
          class: 'btn sm',
          onclick: async () => {
            closeCard();
            await updateFriendAction('decline', { requestId: payload.requestId || '', targetUid: payload.fromUid || '' });
          },
        }, 'Reddet')
      );
    } else if ((nType === 'dm' || nType === 'poke' || nType === 'friend_accepted') && payload.fromUid && !roomId) {
      actionBtns.push(
        h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: () => {
            closeCard();
            openDmModal(payload.fromUid);
          },
        }, '💬 Mesaj Aç')
      );
    } else if (roomId || targetUrl) {
      actionBtns.push(
        h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: () => {
            closeCard();
            if (roomId) navigate(`/mesh/${encodeURIComponent(roomId)}`);
            else if (targetUrl) {
              const cleanHash = targetUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?#/, '');
              if (cleanHash) navigate(cleanHash);
            }
          },
        }, '▶ Odaya Katıl')
      );
    }
    actionBtns.push(h('button', { type: 'button', class: 'btn sm ghost', onclick: closeCard }, '✕'));

    const leadVisual = payload.fromName
      ? avatar({ name: payload.fromName, color: payload.color || '#27dcc8', avatarUrl: payload.avatarUrl || '' }, 38, { online: true })
      : h('div', { class: 'rave-notif-icon' }, nType === 'dm' ? '💬' : (nType === 'friend_request' ? '👥' : '🎬'));

    const card = h('div', { class: `rave-notif-card is-${nType}` },
      leadVisual,
      h('div', { class: 'rave-notif-body' },
        h('div', { class: 'rave-notif-title' }, title),
        h('div', { class: 'rave-notif-text' }, body)),
      payload.poster ? h('img', { src: payload.poster, alt: '', class: 'rave-notif-poster', onerror: (e) => e.currentTarget.remove() }) : null,
      h('div', { class: 'rave-notif-actions' }, ...actionBtns),
      h('div', { class: 'rave-notif-timer' }, h('div', { class: 'rave-notif-timer-bar' }))
    );
    stack.appendChild(card);
    setTimeout(() => { if (card.isConnected) closeCard(); }, 12000);

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && (document.visibilityState === 'hidden' || payload.forceOsNotification)) {
      if (swReg?.active) {
        swReg.active.postMessage({ type: 'WATCHLIVO_SHOW_NOTIFICATION', payload });
      } else {
        try {
          const n = new Notification(title, { body, icon: '/static/watchlivo-icon-192.png' });
          n.onclick = () => {
            window.focus();
            if (roomId) navigate(`/mesh/${encodeURIComponent(roomId)}`);
            else if (payload.fromUid) openDmModal(payload.fromUid);
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

  let lastNotifTs = (Date.now() / 1000) - 25;
  const seenNotifIds = new Set();
  try {
    const savedSeen = JSON.parse(sessionStorage.getItem('wl_seen_notifs') || '[]');
    if (Array.isArray(savedSeen)) savedSeen.forEach((id) => seenNotifIds.add(id));
  } catch (_) {}

  const rememberSeen = (id) => {
    seenNotifIds.add(id);
    try {
      sessionStorage.setItem('wl_seen_notifs', JSON.stringify(Array.from(seenNotifIds).slice(-120)));
    } catch (_) {}
  };

  setInterval(async () => {
    const uid = state.self?.uid || state.self?.id || state.clientId || '';
    if (!uid) return;
    const name = state.self?.name || '';
    const res = await api(`/api/rave/notifications/poll?uid=${encodeURIComponent(uid)}&name=${encodeURIComponent(name)}&since=${encodeURIComponent(lastNotifTs)}`).catch(() => null);
    if (!res?.ok) return;

    const prevReq = Number(state.social?.requestCount || 0);
    const prevUnr = Number(state.social?.totalUnread || 0);
    const nextReq = Number.isFinite(Number(res.requestCount)) ? Number(res.requestCount) : prevReq;
    const nextUnr = Number.isFinite(Number(res.totalUnread)) ? Number(res.totalUnread) : prevUnr;
    if (nextReq !== prevReq || nextUnr !== prevUnr) {
      set({ social: { ...(state.social || {}), requestCount: nextReq, totalUnread: nextUnr } });
    }

    if (Array.isArray(res.notifications) && res.notifications.length) {
      let needSocialRefresh = false;
      for (const item of res.notifications) {
        if (!item?.id || seenNotifIds.has(item.id)) continue;
        rememberSeen(item.id);
        lastNotifTs = Math.max(lastNotifTs, Number(item.ts || 0));
        if (['friend_request', 'friend_accepted', 'dm', 'room_invite', 'invite_cancelled'].includes(item.type)) {
          needSocialRefresh = true;
        }
        if (item.type === 'invite_cancelled') continue;
        if (item.type === 'dm' && document.querySelector('.wl-dm-root')) continue;
        if (item.roomId && item.roomId === state.mesh?.id && item.type === 'room_invite') continue;
        window.vortexShowNotificationCard?.({ ...item, forceOsNotification: true });
      }
      if (needSocialRefresh) syncSocialState(true).catch(() => {});
    }
    if (res.serverTs) lastNotifTs = Math.max(lastNotifTs, Number(res.serverTs) - 1);
  }, 4500);
}

boot();
