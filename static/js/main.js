// Watchlivo entry: profile bootstrap + hash router (#/ home, #/mesh/:id) — Rave home ⇄ mesh navigation parity.
import { state, set, syncSocialState, updateFriendAction, pushPresenceHeartbeat } from './store.js?v=20261109_v160';
import { loadProfile, saveProfile, avatar, profileSetup, openDmModal, checkRedirectAuth, verifyAndRefreshSession } from './profile.js?v=20261109_v160';
import { renderHome, destroyHome } from './views/home.js?v=20261109_v160';
import { api } from './api.js?v=20261109_v160';
import { h, toast } from './ui.js?v=20261109_v160';

const MODULE_VER = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || '20261109_v160'; } catch (_) { return '20261109_v160'; }
})();

let _meshMod = null;
let _meshModPromise = null;

function loadMeshModule() {
  if (_meshMod) return Promise.resolve(_meshMod);
  if (!_meshModPromise) {
    _meshModPromise = import('./views/mesh.js?v=20261109_v160')
      .then((mod) => {
        _meshMod = mod;
        return mod;
      })
      .catch((err) => {
        _meshModPromise = null;
        throw err;
      });
  }
  return _meshModPromise;
}

function leaveMeshSafe(full = true) {
  _meshMod?.leaveMeshView?.(full);
}

function parseRoute() {
  const searchParams = new URLSearchParams(location.search);
  const legacyRoom = searchParams.get('room');
  if (legacyRoom && !location.hash) {
    searchParams.delete('room');
    const rem = searchParams.toString();
    history.replaceState({}, '', `/#/mesh/${encodeURIComponent(legacyRoom)}${rem ? '?' + rem : ''}`);
  }
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = {
    ...Object.fromEntries(new URLSearchParams(location.search)),
    ...Object.fromEntries(new URLSearchParams(query)),
  };
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
  window.__vortexCancelChatVoiceRec?.();
  window.__activeSubsController?.stopDubAudio?.();
  try {
    if (localStorage.getItem('vortex_bg_audio') === 'off') {
      window.__kinoxHost?.adapter?.pause?.();
    }
  } catch (_) {}
  document.querySelectorAll('.settings-menu.is-body-portal').forEach((m) => m.remove());
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.body.classList.add('mesh-minimized');
  document.body.classList.remove('vortex-fs', 'theater-mode');
  toast('🗗 Oda sağ alta küçültüldü · Gezinmeye devam edebilirsin');
  navigate('/');
};

window.vortexRestoreRoom = () => {
  if (!activeMeshRoomId) return;
  document.body.classList.remove('mesh-minimized');
  navigate(`/mesh/${encodeURIComponent(activeMeshRoomId)}`);
};

window.vortexCloseMinimizedRoom = () => {
  document.body.classList.remove('mesh-minimized', 'vortex-fs', 'theater-mode');
  document.querySelectorAll('.settings-menu.is-body-portal').forEach((m) => m.remove());
  activeMeshRoomId = null;
  leaveMeshSafe(true);
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
  document.body.classList.toggle('in-room', r.name === 'mesh');
  const closeNavPopups = () => {
    document.querySelectorAll('.modal-backdrop, .popup-backdrop').forEach((el) => {
      if (el.dataset?.persistOnNavigate === '1') return;
      if (typeof el._closePopup === 'function') el._closePopup();
      else el.remove();
    });
  };
  if (r.name === 'mesh') {
    document.body.classList.remove('mesh-minimized');
    closeNavPopups();
    if (current === 'home') destroyHome();
    homeRoot.classList.add('hidden');
    meshRoot.classList.remove('hidden');
    const hasMeshDom = Boolean(meshRoot.querySelector('.mesh-layout'));
    if (enteringMeshRoomId === r.params.id) {
      if (hasMeshDom) window.dispatchEvent(new Event('resize'));
    } else if (activeMeshRoomId !== r.params.id || !state.mesh || !hasMeshDom) {
      if (activeMeshRoomId && activeMeshRoomId !== r.params.id) {
        leaveMeshSafe(true);
      }
      activeMeshRoomId = r.params.id;
      enteringMeshRoomId = r.params.id;
      try {
        const { enterMesh } = await loadMeshModule();
        await enterMesh(meshRoot, r.params);
      } catch (err) {
        console.error('[Route] enterMesh error:', err);
        toast('Odaya bağlanırken hata oluştu, tekrar deneniyor...');
      } finally {
        if (enteringMeshRoomId === r.params.id) enteringMeshRoomId = null;
      }
    } else {
      window.dispatchEvent(new Event('resize'));
      if (String(r.params.autocall || '') === '1') {
        try { history.replaceState({}, '', `#/mesh/${encodeURIComponent(r.params.id)}`); } catch (_) {}
        if (!window.__kinoxVoice?.inCall) {
          setTimeout(() => window.__kinoxVoice?.joinCall?.({ withMic: true }), 180);
        }
      }
    }
  } else {
    closeNavPopups();
    if (activeMeshRoomId && state.mesh) {
      window.__vortexCancelChatVoiceRec?.();
      window.__activeSubsController?.stopDubAudio?.();
      try {
        if (localStorage.getItem('vortex_bg_audio') === 'off') {
          window.__kinoxHost?.adapter?.pause?.();
        }
      } catch (_) {}
      document.body.classList.add('mesh-minimized');
    }
    const keepMinimized = Boolean(activeMeshRoomId && document.body.classList.contains('mesh-minimized') && state.mesh);
    if (!keepMinimized) {
      document.body.classList.remove('mesh-minimized');
      if (activeMeshRoomId) {
        activeMeshRoomId = null;
        leaveMeshSafe(true);
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
  document.querySelector('.skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.querySelector('#mesh-root:not(.hidden)') || document.getElementById('home-main') || document.getElementById('app');
    if (target instanceof HTMLElement) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: true }); } catch (_) {}
      try { target.scrollIntoView({ block: 'start' }); } catch (_) {}
    }
  });
  if (navigator.userAgent.includes('WatchlivoApp') || window.isWatchlivoNativeIOS || window.webkit?.messageHandlers?.watchlivoPiP || window.Android || navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches) {
    document.documentElement.classList.add('is-apk', 'is-native-apk');
  }
  let safeAreaProbe = null;
  const readSafeAreaInsets = () => {
    if (!document.body) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (!safeAreaProbe || !safeAreaProbe.isConnected) {
      safeAreaProbe = document.getElementById('wl-safe-area-probe');
      if (!safeAreaProbe) {
        safeAreaProbe = document.createElement('div');
        safeAreaProbe.id = 'wl-safe-area-probe';
        safeAreaProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;display:block !important;pointer-events:none;visibility:hidden;z-index:-1;padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
        document.body.appendChild(safeAreaProbe);
      }
    }
    const cs = window.getComputedStyle(safeAreaProbe);
    return {
      top: Math.max(0, Math.round(parseFloat(cs.paddingTop) || 0)),
      right: Math.max(0, Math.round(parseFloat(cs.paddingRight) || 0)),
      bottom: Math.max(0, Math.round(parseFloat(cs.paddingBottom) || 0)),
      left: Math.max(0, Math.round(parseFloat(cs.paddingLeft) || 0)),
    };
  };
  const syncAppViewportMetrics = () => {
    const root = document.documentElement;
    const kbOpen = document.body?.classList?.contains('kb-open');
    const vv = window.visualViewport;
    const rawW = Math.round(window.innerWidth || root.clientWidth || 390);
    const rawH = Math.round(window.innerHeight || root.clientHeight || 844);
    const vvH = vv ? Math.round(vv.height) : rawH;
    const w = Math.max(280, rawW);
    const insets = readSafeAreaInsets();
    const isIos = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    const isStandalone = typeof window !== 'undefined' && (
      window.navigator?.standalone === true ||
      window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
      Boolean(window.isWatchlivoNativeIOS || window.webkit?.messageHandlers?.watchlivoPiP)
    );
    const screenH = Math.round(window.screen?.height || 0);
    const screenW = Math.round(window.screen?.width || 0);
    const portraitScreenH = Math.max(screenH, screenW);
    const statusDiff = portraitScreenH - rawH;
    const isMobilePortrait = w <= 900 && rawH >= rawW;
    const isIosFullBleed = isIos && (isStandalone || insets.top >= 20);
    const isIosWebClipShort = isIosFullBleed && !kbOpen && isMobilePortrait && statusDiff >= 20 && statusDiff <= 80;
    const fullH = isIosWebClipShort ? portraitScreenH : rawH;
    const h = Math.max(kbOpen ? 120 : 240, kbOpen ? Math.min(rawH, vvH || rawH) : fullH);
    let topSafeOffset = insets.top;
    let bottomSafeOffset = insets.bottom;
    if (isMobilePortrait) {
      if (isIosFullBleed) {
        const minTop = portraitScreenH >= 812 ? 52 : 28;
        topSafeOffset = Math.max(insets.top, minTop) + 10;
        bottomSafeOffset = Math.max(insets.bottom, 10);
      } else if (isIos) {
        topSafeOffset = insets.top > 0 ? insets.top + 6 : 8;
        bottomSafeOffset = Math.max(insets.bottom, 6);
      } else {
        topSafeOffset = insets.top > 0 ? insets.top + 4 : 6;
        bottomSafeOffset = Math.min(Math.max(insets.bottom, 6), 12);
      }
    }
    root.style.setProperty('--app-width', `${w}px`);
    root.style.setProperty('--app-height', `${h}px`);
    if (!kbOpen) {
      root.style.setProperty('--vvh', `${h}px`);
      root.style.setProperty('--vv-top', '0px');
    }
    root.style.setProperty('--safe-top-px', `${insets.top}px`);
    root.style.setProperty('--safe-bottom-px', `${insets.bottom}px`);
    root.style.setProperty('--top-safe-offset', `${topSafeOffset}px`);
    root.style.setProperty('--bottom-safe-offset', `${bottomSafeOffset}px`);
    if (!kbOpen && (window.scrollX !== 0 || window.scrollY !== 0)) {
      window.scrollTo(0, 0);
    }
  };
  let _vpSyncRaf = 0;
  const scheduleSyncAppViewportMetrics = () => {
    if (_vpSyncRaf) return;
    _vpSyncRaf = requestAnimationFrame(() => {
      _vpSyncRaf = 0;
      syncAppViewportMetrics();
    });
  };
  window.__wlSyncViewport = syncAppViewportMetrics;
  syncAppViewportMetrics();
  window.addEventListener('resize', scheduleSyncAppViewportMetrics, { passive: true });
  window.addEventListener('orientationchange', () => {
    syncAppViewportMetrics();
    setTimeout(syncAppViewportMetrics, 120);
    setTimeout(syncAppViewportMetrics, 350);
  }, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleSyncAppViewportMetrics, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleSyncAppViewportMetrics, { passive: true });
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
    if (initialProfile.isGuest && !initialProfile.uid && initialProfile.id) {
      initialProfile.uid = initialProfile.id;
    }
    start(initialProfile);
    if (!initialProfile.isGuest) {
      verifyAndRefreshSession().catch(() => {});
    } else if (typeof fetch === 'function' && (initialProfile.uid || initialProfile.id)) {
      fetch('/api/rave/social/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: initialProfile.uid || initialProfile.id,
          name: initialProfile.name || '',
          handle: initialProfile.handle || '',
          color: initialProfile.color || '#27DCC8',
          avatarUrl: initialProfile.avatarUrl || '',
        }),
      }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (d?.guestToken) {
          initialProfile.guestToken = d.guestToken;
          if (state.self && (state.self.uid === initialProfile.uid || state.self.id === initialProfile.id)) {
            state.self.guestToken = d.guestToken;
          }
          try { localStorage.setItem('vortex_profile_v2', JSON.stringify(initialProfile)); } catch (_) {}
        }
      }).catch(() => {});
    }
  } else {
    let guestFallback = null;
    try {
      guestFallback = JSON.parse(sessionStorage.getItem('vortex_temp_guest_v1') || 'null');
    } catch (e) { guestFallback = null; }
    if (!guestFallback || !guestFallback.id || !guestFallback.name || guestFallback.name === 'Misafir İzleyici') {
      const gTag = Math.floor(1000 + Math.random() * 9000);
      const gColors = ['#27DCC8', '#6366f1', '#8b5cf6', '#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#ec4899'];
      const gid = 'guest_' + Math.random().toString(36).slice(2, 10);
      guestFallback = {
        id: gid,
        uid: gid,
        name: `Misafir #${gTag}`,
        handle: `misafir_${gid.slice(-6)}`,
        color: gColors[gTag % gColors.length],
        isGuest: true,
      };
      try { sessionStorage.setItem('vortex_temp_guest_v1', JSON.stringify(guestFallback)); } catch (e) { /* ignore */ }
    } else if (!guestFallback.uid && guestFallback.id) {
      guestFallback.uid = guestFallback.id;
      try { sessionStorage.setItem('vortex_temp_guest_v1', JSON.stringify(guestFallback)); } catch (e) { /* ignore */ }
    }
    start(guestFallback);
    if (typeof fetch === 'function' && guestFallback.uid) {
      fetch('/api/rave/social/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: guestFallback.uid,
          name: guestFallback.name,
          handle: guestFallback.handle,
          color: guestFallback.color,
        }),
      }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (d?.guestToken) {
          guestFallback.guestToken = d.guestToken;
          if (state.self && state.self.uid === guestFallback.uid) {
            state.self.guestToken = d.guestToken;
          }
          try { sessionStorage.setItem('vortex_temp_guest_v1', JSON.stringify(guestFallback)); } catch (_) {}
        }
      }).catch(() => {});
    }
    if (!isRedirectPending && (sp.get('login') === '1' || sp.get('auth') === '1')) {
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
      const tok = s?.authToken || s?.guestToken || '';
      if (tok) hdrs.Authorization = `Bearer ${tok}`;
      fetch('/api/rave/social/presence', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ uid, state: 'offline' }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  };
  window.addEventListener('pagehide', markOffline);
}

function initRaveNotifications() {
  let swReg = null;
  if ('serviceWorker' in navigator && !window.isWatchlivoNativeIOS && !window.Android) {
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(MODULE_VER)}`, { updateViaCache: 'none' }).then((reg) => {
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
      if (nType === 'friend_accepted') {
        actionBtns.push(
          h('button', {
            type: 'button',
            class: 'btn sm',
            onclick: () => {
              closeCard();
              window.vortexOpenFriendsModal?.(null, 'friends');
            },
          }, '👥 Arkadaşlar')
        );
      }
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
            if (targetUrl) {
              const cleanHash = targetUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?#/, '');
              if (cleanHash && cleanHash !== '/') {
                navigate(cleanHash);
                return;
              }
            }
            if (roomId) navigate(`/mesh/${encodeURIComponent(roomId)}`);
          },
        }, '▶ Odaya Katıl')
      );
    }
    actionBtns.push(h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': 'Bildirimi kapat', onclick: closeCard }, '✕'));

    const leadVisual = payload.fromName
      ? avatar({ name: payload.fromName, color: payload.color || '#27dcc8', avatarUrl: payload.avatarUrl || '' }, 38, { online: true })
      : h('div', { class: 'rave-notif-icon' }, nType === 'dm' ? '💬' : (nType === 'friend_request' ? '👥' : '🎬'));

    const card = h('div', { class: `rave-notif-card is-${nType}` },
      leadVisual,
      h('div', {
        class: 'rave-notif-body',
        style: (nType === 'friend_request' || nType === 'friend_accepted' || nType === 'dm') ? { cursor: 'pointer' } : null,
        onclick: () => {
          if (nType === 'friend_request' || nType === 'friend_accepted') {
            closeCard();
            window.vortexOpenFriendsModal?.(null, nType === 'friend_request' ? 'requests' : 'friends');
          } else if (nType === 'dm' && payload.fromUid) {
            closeCard();
            openDmModal(payload.fromUid);
          }
        },
      },
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

  window.vortexSendRoomNotification = async (extraOrRoomId = {}, maybeRoomTitle = '') => {
    const extra = typeof extraOrRoomId === 'string'
      ? { roomId: extraOrRoomId, roomTitle: maybeRoomTitle }
      : (extraOrRoomId || {});
    const rid = extra.roomId || state.mesh?.id || '';
    if (!rid) return null;
    const rTitle = extra.roomTitle || state.mesh?.media?.title || state.mesh?.name || 'Sinema Odası';
    const sender = state.self?.name || 'Arkadaşın';
    const qp = new URLSearchParams();
    let pwd = state.route?.params?.pwd || '';
    let rtok = state.mesh?.syncToken || '';
    try {
      if (!pwd) pwd = sessionStorage.getItem('vortex_pwd_' + rid) || '';
      if (!rtok) rtok = sessionStorage.getItem('vortex_st_' + rid) || '';
    } catch (_) {}
    if (pwd) qp.set('pwd', pwd);
    if (rTitle) qp.set('t', rTitle);
    if (rtok && rtok.length < 6000) qp.set('r_tok', rtok);
    const qs = qp.toString();
    const res = await api('/api/rave/notifications/send', {
      method: 'POST',
      body: {
        fromUid: state.self?.uid || state.self?.id || state.clientId,
        fromName: sender,
        roomId: rid,
        roomTitle: rTitle,
        targetUid: extra.targetUid || '*',
        url: `/#/mesh/${encodeURIComponent(rid)}${qs ? '?' + qs : ''}`,
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
        window.vortexShowNotificationCard?.({ ...item });
      }
      if (needSocialRefresh) syncSocialState(true).catch(() => {});
    }
    if (res.serverTs) lastNotifTs = Math.max(lastNotifTs, Number(res.serverTs) - 1);
  }, 4500);

  initSpatialTvNavigation();
}

function initSpatialTvNavigation() {
  if (window.__wlSpatialTvNavInit) return;
  window.__wlSpatialTvNavInit = true;
  const FOCUS_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"]):not([type="range"])',
    'select:not([disabled])',
    '[role="button"]:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '.provider-tile',
    '.poster-card',
    '.lobby-card',
    '.dock-item',
    '.cat-tab-pill',
    '.provider-cat-pill',
  ].join(', ');

  const getVisibleFocusables = () => {
    const popupEl = document.querySelector('.popup-backdrop .popup');
    const scope = popupEl || document;
    const nodes = Array.from(scope.querySelectorAll(FOCUS_SELECTOR));
    return nodes.filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.closest('.hidden, [aria-hidden="true"]')) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 6 && r.height > 6;
    });
  };

  const moveFocus = (dir) => {
    const items = getVisibleFocusables();
    if (!items.length) return false;
    items.forEach((el) => {
      if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = 0;
    });
    const cur = document.activeElement instanceof HTMLElement && items.includes(document.activeElement)
      ? document.activeElement
      : null;
    if (!cur) {
      items[0].focus({ preventScroll: false });
      return true;
    }
    const cr = cur.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const cand of items) {
      if (cand === cur) continue;
      const r = cand.getBoundingClientRect();
      const tx = r.left + r.width / 2;
      const ty = r.top + r.height / 2;
      const dx = tx - cx;
      const dy = ty - cy;
      let primary = 0;
      let secondary = 0;
      if (dir === 'right' && dx > 6) { primary = dx; secondary = Math.abs(dy); }
      else if (dir === 'left' && dx < -6) { primary = -dx; secondary = Math.abs(dy); }
      else if (dir === 'down' && dy > 6) { primary = dy; secondary = Math.abs(dx); }
      else if (dir === 'up' && dy < -6) { primary = -dy; secondary = Math.abs(dx); }
      else continue;
      const score = primary + secondary * 2.35;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best) {
      best.focus({ preventScroll: true });
      try { best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (_) {}
      return true;
    }
    return false;
  };

  window.vortexSpatialMove = moveFocus;

  window.addEventListener('pointerdown', () => {
    document.body.classList.remove('tv-nav-active');
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const dir = map[e.key];
    const active = document.activeElement;
    const isTextInput = active && (
      (active.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range'].includes(active.type)) ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable
    );
    if (isTextInput) return;
    if (dir) {
      if (document.body.classList.contains('in-room') && !document.querySelector('.popup-backdrop, .modal-backdrop') && !document.body.classList.contains('tv-nav-active')) return;
      if (document.querySelector('#mesh-root .video-stage:hover') && !document.body.classList.contains('tv-nav-active')) return;
      document.body.classList.add('tv-nav-active');
      if (moveFocus(dir)) {
        e.preventDefault();
      }
    } else if (e.key === 'Enter' && document.body.classList.contains('tv-nav-active') && active instanceof HTMLElement && !isTextInput && active.tagName !== 'BUTTON' && active.tagName !== 'A') {
      e.preventDefault();
      active.click();
    }
  });
}

boot();

function trackWatchlivoGA4(eventName, params = {}) {
  try {
    if (typeof window.gtag === 'function' && window.__wlGaLoadedId) {
      window.gtag('event', eventName, params);
    }
  } catch (_) {}
}
window.wlTrackGA4 = trackWatchlivoGA4;

function sendWatchlivoAnalytics(ev = 'pageview', extra = {}) {
  try {
    const cleanHash = location.hash ? location.hash.split('?')[0] : '';
    const curPath = location.pathname + cleanHash;
    const curTitle = document.title || 'Watchlivo';
    if (ev === 'pageview') {
      trackWatchlivoGA4('page_view', {
        page_title: curTitle,
        page_path: curPath,
      });
      if (sessionStorage.getItem('wl_session_tracked_v123') === '1') {
        ev = 'route_view';
      } else {
        sessionStorage.setItem('wl_session_tracked_v123', '1');
      }
    } else {
      trackWatchlivoGA4(ev, extra);
    }
    const isPwa = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true;
    const ua = navigator.userAgent || '';
    const dev = isPwa ? 'pwa' : (/iPhone|iPad|iPod/i.test(ua) ? 'ios' : (/Android/i.test(ua) ? 'android' : 'desktop'));
    fetch('/api/rave/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: isPwa && ev === 'pageview' ? 'pwa_launch' : ev,
        device: dev,
        path: curPath,
        title: extra.title || curTitle,
        query: extra.query || '',
      }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

function bootstrapGoogleAnalytics4() {
  try {
    window.addEventListener('hashchange', () => {
      setTimeout(() => sendWatchlivoAnalytics('route_view'), 300);
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        sendWatchlivoAnalytics('heartbeat');
      }
    }, 45000);
  } catch (_) {}
}

window.vortexSendAnalytics = sendWatchlivoAnalytics;
bootstrapGoogleAnalytics4();
setTimeout(() => sendWatchlivoAnalytics('pageview'), 600);
