// Watchlivo Auth, Account & Profile System (Supabase Auth + Watchlivo Cloud — Zero Guest Mode).
import { h, icons, popup, toast } from './ui.js?v=20261114_v212';
import { api } from './api.js?v=20261114_v212';
import { startUniversalVoiceRecorder, buildUniversalAudioNotePlayer, stopActiveVoiceNoteGlobal } from './voice-note.js?v=20261114_v212';
import {
  state, set, getFriends, isFriend, getWatchHistory,
  syncCloudUserMedia, resetCloudSyncState, pushYtPrefsAction, invalidateYtFeedCache,
  syncSocialState, sendFriendRequest, updateFriendAction, sendRoomInvite, pushPresenceHeartbeat,
} from './store.js?v=20261114_v212';

const KEY = 'vortex_profile_v2';
const VAULT_KEY = 'watchlivo_accounts_vault';
const LAST_PROVIDER_KEY = 'watchlivo_last_auth_provider';
export const AVATAR_COLORS = ['#6366f1', '#8b5cf6', '#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#ec4899', '#eab308', '#a3e635', '#fb923c'];

const _TR_FOLD_MAP = {
  'İ': 'i', 'I': 'i', 'ı': 'i',
  'Ş': 's', 'ş': 's',
  'Ğ': 'g', 'ğ': 'g',
  'Ü': 'u', 'ü': 'u',
  'Ö': 'o', 'ö': 'o',
  'Ç': 'c', 'ç': 'c',
};

export function foldTurkish(raw = '') {
  return String(raw || '').replace(/[İIıŞşĞğÜüÖöÇç]/g, (ch) => _TR_FOLD_MAP[ch] || ch).replace(/\u0307/g, '').toLowerCase();
}

export function normalizeHandle(raw = '', fallbackName = '') {
  const cleanRaw = foldTurkish(String(raw || '').trim().replace(/^@+/, '').replace(/#\d{2,6}$/, '')).replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
  if (cleanRaw.length >= 2) return cleanRaw;
  const cleanFb = foldTurkish(String(fallbackName || '').trim().replace(/^@+/, '').replace(/#\d{2,6}$/, '')).replace(/[^a-z0-9_.-]/g, '').slice(0, 20);
  if (cleanFb.length >= 2) return cleanFb;
  return cleanRaw || cleanFb || 'uye';
}

export function sanitizeAvatarUrl(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const compact = s.replace(/[\u0000-\u0020]+/g, '');
  if (/^(?:javascript:|vbscript:|data:text\/|data:application\/|data:image\/svg)/i.test(compact)) return '';
  if (/\.svg(?:$|[?#])/i.test(compact)) return '';
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i.test(compact)) {
    return compact.length <= 45000 ? compact : '';
  }
  if (/^https:\/\//i.test(s) && s.length <= 2048) return s;
  if ((s.startsWith('/static/') || s.startsWith('/uploads/')) && !s.startsWith('//') && s.length <= 512) return s;
  return '';
}

function _syncLiveSelfEverywhere(p) {
  if (!p || typeof document === 'undefined') return;
  try {
    const navLbl = document.querySelector('#nav-account-btn .account-pill-name, #nav-account-btn span:not(.avatar)');
    if (navLbl && p.name) navLbl.textContent = p.name;
  } catch (_) {}
  try {
    if (state.mesh && Array.isArray(state.mesh.participants)) {
      const mePart = state.mesh.participants.find((x) =>
        (state.clientId && x.id === state.clientId) ||
        (p.uid && x.uid && x.uid === p.uid)
      );
      if (mePart) {
        mePart.name = p.name;
        mePart.handle = p.handle;
        mePart.color = p.color;
        mePart.avatarUrl = p.avatarUrl || '';
        mePart.bio = p.bio || '';
        mePart.statusText = p.statusText || '';
        mePart.statusEmoji = p.statusEmoji || '🍿';
      }
    }
    const conn = typeof window !== 'undefined' ? window.__vortexActiveConn : null;
    if (conn && !conn.closed) {
      conn.profile = { ...(conn.profile || {}), ...p };
      conn.send?.('profile_update', {
        username: p.name,
        handle: p.handle,
        color: p.color,
        avatarUrl: p.avatarUrl || '',
        bio: p.bio || '',
        statusText: p.statusText || '',
        statusEmoji: p.statusEmoji || '🍿',
        hideWatching: Boolean(p.hideWatching),
        hideFriends: Boolean(p.hideFriends),
        hideLocation: Boolean(p.hideLocation),
        medal: p.medal || '',
      });
    }
  } catch (_) {}
}

function saveToAccountVault(prof) {
  if (!prof || !prof.authToken) return;
  try {
    const vault = JSON.parse(localStorage.getItem(VAULT_KEY) || '{}') || {};
    if (prof.email) vault[String(prof.email).toLowerCase()] = prof.authToken;
    if (prof.handle) vault[normalizeHandle(prof.handle)] = prof.authToken;
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } catch (e) { /* ignore */ }
}

function getVaultToken(identifier) {
  if (!identifier) return '';
  try {
    const vault = JSON.parse(localStorage.getItem(VAULT_KEY) || '{}') || {};
    const raw = String(identifier).trim();
    const k = raw.includes('@') && !raw.startsWith('@') ? raw.toLowerCase() : normalizeHandle(raw);
    return vault[k] || vault[raw.toLowerCase().replace(/^@+/, '')] || vault[raw.toLowerCase()] || '';
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
        if (!p.isGuest && !/^Misafir\s*(?:#\d+|İzleyici)$/i.test(String(p.name))) {
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
  const guestPrev = prev.isGuest ? prev : {};
  const handle = normalizeHandle(data.handle || guestPrev.handle || '', name || `misafir${randSuffix}`);
  const p = {
    id: resolvedId,
    uid: resolvedId,
    name,
    handle,
    email: '',
    color: data.color || guestPrev.color || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    avatar: sanitizeAvatarUrl(data.avatarUrl ?? data.avatar ?? guestPrev.avatarUrl ?? ''),
    avatarUrl: sanitizeAvatarUrl(data.avatarUrl ?? data.avatar ?? guestPrev.avatarUrl ?? ''),
    bio: String(data.bio ?? guestPrev.bio ?? '').trim().slice(0, 160),
    statusText: String(data.statusText ?? prev.statusText ?? '').trim().slice(0, 60),
    statusEmoji: String(data.statusEmoji ?? prev.statusEmoji ?? '🍿').trim().slice(0, 12) || '🍿',
    hideLocation: asBool(data.hideLocation ?? prev.hideLocation ?? false),
    hideWatching: asBool(data.hideWatching ?? prev.hideWatching ?? false),
    hideFriends: asBool(data.hideFriends ?? prev.hideFriends ?? false),
    watchMinutes: Math.max(0, Number(prev.watchMinutes || 0)),
    medal: '🍿 Misafir İzleyici',
    authProvider: 'guest',
    authToken: '',
    guestToken: String(data.guestToken ?? guestPrev.guestToken ?? '').trim(),
    verified: false,
    isGuest: true,
    guestConfirmed: true,
  };
  localStorage.setItem(KEY, JSON.stringify(p));
  localStorage.setItem(LAST_PROVIDER_KEY, 'guest');
  try { sessionStorage.setItem('vortex_temp_guest_v1', JSON.stringify(p)); } catch (_) {}
  try { set({ self: p }); } catch (_) {}
  _syncLiveSelfEverywhere(p);
  if (!data._skipProvision && typeof fetch === 'function') {
    setTimeout(() => {
      if (state.self && !state.self.isGuest) return;
      const gHdrs = { 'Content-Type': 'application/json' };
      if (p.guestToken) gHdrs.Authorization = `Bearer ${p.guestToken}`;
      fetch('/api/rave/social/guest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: gHdrs,
        body: JSON.stringify({
          uid: p.uid,
          name: p.name,
          handle: p.handle,
          color: p.color,
          avatarUrl: p.avatarUrl,
          bio: p.bio,
          statusText: p.statusText,
          statusEmoji: p.statusEmoji,
        }),
      }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!state.self?.isGuest) return;
        if (d) {
          if (d.uid) { p.uid = String(d.uid); p.id = String(d.uid); }
          if (d.handle) p.handle = String(d.handle);
          if (d.guestToken) p.guestToken = String(d.guestToken);
          try {
            localStorage.setItem(KEY, JSON.stringify(p));
            sessionStorage.setItem('vortex_temp_guest_v1', JSON.stringify(p));
            set({ self: { ...p } });
          } catch (_) {}
        }
        syncSocialState(true).catch(() => {});
        pushPresenceHeartbeat().catch(() => {});
      }).catch(() => {});
    }, 30);
  }
  return p;
}

function asBool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

export function saveProfile(data = {}) {
  const prev = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
  })();
  const cleanPrevName = /^Misafir/i.test(String(prev.name || '')) ? '' : prev.name;
  const name = String(data.name || cleanPrevName || 'Üye').trim().slice(0, 24) || 'Üye';
  const resolvedId = data.uid || data.id || ((!prev.isGuest && (prev.id || prev.uid)) ? (prev.id || prev.uid) : '') || (crypto.randomUUID ? `u_wl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : `u_wl_${String(Date.now()).slice(-6)}${Math.random().toString(16).slice(2, 8)}`);
  const sameAccount = Boolean(!prev.isGuest && (prev.uid || prev.id) && String(prev.uid || prev.id) === String(resolvedId));
  const rawHandle = normalizeHandle(data.handle ?? (sameAccount ? prev.handle : '') ?? '', name);
  const watchMinutes = Math.max(0, Number(data.watchMinutes ?? (sameAccount ? prev.watchMinutes : 0) ?? 0) || 0);
  const computedMedal = data.medal || (sameAccount ? prev.medal : '') || (watchMinutes >= 300 ? '🥇 Altın İzleyici' : watchMinutes >= 120 ? '🥈 Gümüş İzleyici' : watchMinutes >= 30 ? '🥉 Bronz İzleyici' : '⚡ Yeni İzleyici');
  const avatarUrl = sanitizeAvatarUrl(data.avatarUrl ?? data.avatar ?? (sameAccount ? (prev.avatarUrl ?? prev.avatar) : '') ?? '');
  const hideLocation = asBool(data.hideLocation ?? (sameAccount ? prev.hideLocation : false) ?? false);
  const hideWatching = asBool(data.hideWatching ?? (sameAccount ? prev.hideWatching : false) ?? false);
  const hideFriends = asBool(data.hideFriends ?? (sameAccount ? prev.hideFriends : false) ?? false);
  const bio = String(data.bio ?? (sameAccount ? prev.bio : '') ?? '').trim().slice(0, 160);
  const statusText = String(data.statusText ?? (sameAccount ? prev.statusText : '') ?? '').trim().slice(0, 60);
  const statusEmoji = String(data.statusEmoji ?? (sameAccount ? prev.statusEmoji : '🍿') ?? '🍿').trim().slice(0, 12) || '🍿';
  const p = {
    id: resolvedId,
    uid: resolvedId,
    name,
    handle: rawHandle,
    email: String(data.email ?? (sameAccount ? prev.email : '') ?? '').trim().toLowerCase(),
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
    authProvider: data.authProvider || (sameAccount ? prev.authProvider : '') || 'email',
    authToken: data.authToken ?? (sameAccount ? prev.authToken : '') ?? '',
    verified: true,
    isGuest: false,
  };
  localStorage.setItem(KEY, JSON.stringify(p));
  saveToAccountVault(p);
  if (p.authProvider && p.authProvider !== 'guest') {
    localStorage.setItem(LAST_PROVIDER_KEY, p.authProvider);
  }
  try { set({ self: p }); } catch (_) {}
  _syncLiveSelfEverywhere(p);
  if (!p.isGuest && p.authToken) {
    setTimeout(() => {
      syncCloudUserMedia(true).catch(() => {});
      syncSocialState(true).catch(() => {});
      pushPresenceHeartbeat().catch(() => {});
    }, 30);
  }
  return p;
}

export function logoutProfile() {
  const prevSelf = state.self || (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (_) { return {}; }
  })();
  const prevUid = String(prevSelf?.uid || prevSelf?.id || '').trim();
  const prevTok = String(prevSelf?.authToken || '').trim();
  if (typeof fetch === 'function' && (prevUid || prevTok)) {
    const hdrs = { 'Content-Type': 'application/json' };
    if (prevTok) hdrs.Authorization = `Bearer ${prevTok}`;
    try {
      fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: hdrs,
        body: JSON.stringify({ uid: prevUid }),
      }).catch(() => {});
      fetch('/api/rave/social/presence', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: hdrs,
        body: JSON.stringify({ uid: prevUid, state: 'offline' }),
      }).catch(() => {});
    } catch (_) {}
  }
  try {
    const prevEmail = String(prevSelf?.email || '').trim().toLowerCase();
    const prevHandle = String(prevSelf?.handle || '').trim().toLowerCase();
    try {
      const vaultRaw = JSON.parse(localStorage.getItem(VAULT_KEY) || '{}');
      if (vaultRaw && typeof vaultRaw === 'object') {
        const normHnd = prevHandle ? normalizeHandle(prevHandle) : '';
        for (const k of Object.keys(vaultRaw)) {
          const kLow = String(k).trim().toLowerCase();
          const entry = vaultRaw[k];
          if ((prevEmail && kLow === prevEmail) || (prevHandle && (kLow === prevHandle || kLow === normHnd)) || (typeof entry === 'string' && prevTok && entry === prevTok)) {
            delete vaultRaw[k];
            continue;
          }
          if (entry && typeof entry === 'object') {
            const eUid = String(entry.uid || entry.id || '').trim();
            const eMail = String(entry.email || '').trim().toLowerCase();
            const eHnd = String(entry.handle || '').trim().toLowerCase();
            if ((prevUid && eUid === prevUid) || (prevEmail && eMail === prevEmail) || (prevHandle && (eHnd === prevHandle || eHnd === normHnd)) || (prevTok && entry.authToken === prevTok)) {
              delete vaultRaw[k];
            }
          }
        }
        localStorage.setItem(VAULT_KEY, JSON.stringify(vaultRaw));
      }
    } catch (_) {}
    localStorage.removeItem(KEY);
    localStorage.removeItem('vortex_profile_v1');
    localStorage.removeItem('vortex_self');
    localStorage.removeItem('rave_user');
    localStorage.removeItem('watchlivo_auth_pending_redirect');
    localStorage.removeItem('vortex_accounts_v7:guest');
    sessionStorage.removeItem('watchlivo_auth_pending_pw');
    sessionStorage.removeItem('watchlivo_auth_pending_email');
    sessionStorage.removeItem('vortex_temp_guest_v1');
  } catch (e) { /* ignore */ }
  try {
    getFirebaseAuth().then((fb) => fb?.auth?.signOut?.()).catch(() => {});
  } catch (_) {}
  resetCloudSyncState();
  const gTag = Math.floor(1000 + Math.random() * 9000);
  const gid = 'guest_' + Math.random().toString(36).slice(2, 10);
  const guest = {
    id: gid,
    uid: gid,
    name: `Misafir #${gTag}`,
    handle: `misafir${gTag}`,
    color: AVATAR_COLORS[gTag % AVATAR_COLORS.length],
    isGuest: true,
    verified: false,
    authToken: '',
  };
  try {
    set({
      self: guest,
      social: {
        friends: [],
        onlineCount: 0,
        requests: [],
        requestCount: 0,
        outgoingRequests: [],
        blocked: [],
        totalUnread: 0,
        privacy: { presenceVisibility: 'friends', hideWatching: false, allowInvites: 'friends' },
        threads: [],
        loaded: false,
      },
    });
  } catch (_) {}
  const provisionedGuest = saveGuestProfile({ ...guest, guestConfirmed: true });
  _syncLiveSelfEverywhere(provisionedGuest);
  return provisionedGuest;
}

export async function verifyAndRefreshSession() {
  const s = state.self;
  if (!s || s.isGuest) return null;
  if (s.authToken) {
    try {
      const r = await fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${s.authToken}` },
      });
      if (r.status === 401) {
        saveGuestProfile({
          name: (s.name && s.name !== 'Üye' && !/^Misafir/i.test(s.name)) ? s.name : '',
          color: s.color,
        });
        return null;
      }
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (d?.authenticated && d?.user) {
          const preservedAvatar = d.user.avatarUrl || (String(s.avatarUrl || '').startsWith('data:image/') ? s.avatarUrl : '');
          const refreshed = saveProfile({
            ...s,
            ...d.user,
            avatar: preservedAvatar,
            avatarUrl: preservedAvatar,
            authToken: d.authToken || s.authToken,
            isGuest: false,
            verified: true,
          });
          syncCloudUserMedia(true).catch(() => {});
          return refreshed;
        } else if (d && d.authenticated === false) {
          saveGuestProfile({
            name: (s.name && s.name !== 'Üye' && !/^Misafir/i.test(s.name)) ? s.name : '',
            color: s.color,
          });
          return null;
        }
      }
    } catch (e) { /* offline */ }
  }
  return null;
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
  const imgUrl = sanitizeAvatarUrl(user?.avatarUrl || user?.avatar || '');
  const hasImg = Boolean(imgUrl);
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
  const pendingPw = sessionStorage.getItem('watchlivo_auth_pending_pw') || '';
  const pendingEmail = sessionStorage.getItem('watchlivo_auth_pending_email') || '';

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
            body: { provider: 'google', idToken, email: pendingEmail || fbEmail, name: fbName, password: pendingPw.length >= 6 ? pendingPw : '' },
          });
          if (res?.ok && res.user) {
            localStorage.removeItem('watchlivo_auth_pending_redirect');
            sessionStorage.removeItem('watchlivo_auth_pending_pw');
            sessionStorage.removeItem('watchlivo_auth_pending_email');
            const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
            toast('✓ ' + prof.name + ' (@' + prof.handle + ') olarak giriş yapıldı');
            return prof;
          }
        }
      } catch (e) {
        console.warn('Redirect auth check failed:', e);
        toast(e?.message || 'Google girişi doğrulanamadı.');
      } finally {
        localStorage.removeItem('watchlivo_auth_pending_redirect');
        sessionStorage.removeItem('watchlivo_auth_pending_pw');
        sessionStorage.removeItem('watchlivo_auth_pending_email');
      }
      return null;
    })(),
    new Promise((resolve) => setTimeout(() => {
      localStorage.removeItem('watchlivo_auth_pending_redirect');
      sessionStorage.removeItem('watchlivo_auth_pending_pw');
      sessionStorage.removeItem('watchlivo_auth_pending_email');
      resolve(null);
    }, 12000))
  ]);
}

export function profileSetup({ current = null, initialTab = null, dismissable = true, onDone } = {}) {
  let isLoggedMember = Boolean(current && !current.isGuest && current.authToken && !/^Misafir/i.test(String(current.name || '')));
  let activeTab = initialTab || (isLoggedMember ? 'account' : 'login');
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

  const doSocialLogin = async (provider, fallbackName, { password = '', expectedEmail = '', email = '', errEl = null } = {}) => {
    const showErr = (msg) => {
      if (errEl) {
        errEl.style.color = '#fb7185';
        errEl.textContent = msg;
      } else {
        toast(msg);
      }
    };
    try {
      let idToken = '';
      let fbEmail = '';
      let fbName = '';
      if (provider !== 'google') {
        showErr('Bu giriş yöntemi henüz etkin değil. Google veya e-posta ile giriş yapın.');
        return;
      }
      const cleanPw = String(password || '');
      const cleanEmail = String(expectedEmail || email || '').trim().toLowerCase();
      if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
        showErr('Lütfen geçerli bir Google e-posta adresi girin (örn. ad@gmail.com).');
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
            showErr('Giriş tamamlanamadı: ' + res.error);
          }
        } catch (e) {
          console.warn('Desktop login api error:', e);
        }
        return;
      }
      const fb = await getFirebaseAuth();
      if (!fb?.auth || !fb?.signInWithPopup) {
        showErr('Giriş servisi yüklenemedi. Sayfayı yenileyip tekrar deneyin.');
        return;
      }
      try { await fb.auth.signOut?.(); } catch (_) {}
      const gProv = new fb.GoogleAuthProvider();
      gProv.addScope('email');
      gProv.addScope('profile');
      const customParams = { prompt: 'select_account' };
      if (cleanEmail) customParams.login_hint = cleanEmail;
      gProv.setCustomParameters(customParams);
      const isStandaloneApk = /WatchlivoApp/i.test(navigator.userAgent);
      if (isStandaloneApk) {
        localStorage.setItem('watchlivo_auth_pending_redirect', Date.now().toString());
        sessionStorage.setItem('watchlivo_auth_pending_pw', cleanPw);
        if (cleanEmail) sessionStorage.setItem('watchlivo_auth_pending_email', cleanEmail);
        toast('Google giriş sayfasına aktarılıyorsunuz...');
        await fb.signInWithRedirect(fb.auth, gProv);
        return;
      }
      try {
        toast('Google ile giriş penceresi açılıyor...');
        const cred = await fb.signInWithPopup(fb.auth, gProv);
        if (cred?.user) {
          idToken = await cred.user.getIdToken(true);
          fbEmail = (cred.user.email || '').trim().toLowerCase();
          fbName = cred.user.displayName || '';
        }
      } catch (popErr) {
        console.warn('Popup login failed, attempting fallback redirect:', popErr);
        if (fb.signInWithRedirect && /popup-blocked|operation-not-supported/i.test(String(popErr?.code || popErr?.message || ''))) {
          localStorage.setItem('watchlivo_auth_pending_redirect', Date.now().toString());
          sessionStorage.setItem('watchlivo_auth_pending_pw', cleanPw);
          if (cleanEmail) sessionStorage.setItem('watchlivo_auth_pending_email', cleanEmail);
          toast('Google giriş sayfasına aktarılıyorsunuz...');
          await fb.signInWithRedirect(fb.auth, gProv);
          return;
        }
        showErr('Google girişi iptal edildi veya tamamlanmadı. Lütfen tekrar deneyin.');
        return;
      }
      if (!idToken) {
        showErr('Google girişi doğrulanamadı.');
        return;
      }
      if (cleanEmail && fbEmail && cleanEmail !== fbEmail) {
        try { await fb.auth.signOut?.(); } catch (_) {}
        showErr(`Yazdığınız e-posta (${cleanEmail}) ile seçtiğiniz Google hesabı (${fbEmail}) eşleşmiyor!`);
        return;
      }
      const baseName = fbName || ((current && current.name && !/^Misafir/i.test(current.name)) ? current.name : fallbackName);
      const res = await api('/api/auth/oauth', {
        method: 'POST',
        body: { provider, idToken, email: cleanEmail || fbEmail, name: baseName, color, password: cleanPw },
      });
      if (res?.ok && res.user) {
        const prof = saveProfile({ ...res.user, authToken: res.authToken, isGuest: false, verified: true });
        finish(prof, `✓ ${prof.name} (@${prof.handle}) olarak Google ile giriş yapıldı`);
      }
    } catch (e) {
      showErr(e.message || 'Google ile giriş başarısız oldu');
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

  function renderSocialButtons({ hideGuestBtn = false, getFormCreds = null } = {}) {
    return h('div', { class: 'wl-social-stack' },
      h('div', { class: 'wl-auth-divider' }, h('span', {}, hideGuestBtn ? 'veya Google ile Hızlı Giriş' : 'veya Diğer Giriş Seçenekleri')),
      h('div', { class: 'wl-social-row' },
        h('button', {
          type: 'button',
          id: 'wl-google-signin-btn',
          class: 'wl-social-btn wl-social-google',
          onclick: () => {
            const creds = typeof getFormCreds === 'function' ? (getFormCreds() || {}) : {};
            doSocialLogin('google', 'GmailÜyesi', creds);
          },
        },
        h('span', { html: BRAND_SVGS.google || '', style: { display: 'inline-flex', alignItems: 'center' } }),
        h('span', {}, 'Google ile Giriş Yap'),
        lastProvider === 'google' ? h('span', { class: 'wl-last-used-badge' }, 'Son') : null),
        !hideGuestBtn ? h('button', {
          type: 'button',
          id: 'wl-instant-guest-btn',
          class: 'wl-social-btn wl-social-guest',
          style: {
            background: 'rgba(148, 163, 184, 0.12)',
            border: '1px solid rgba(148, 163, 184, 0.32)',
            color: '#cbd5e1',
            fontWeight: '600',
          },
          onclick: () => { activeTab = 'guest'; draw(); },
        },
        h('span', {}, '👤 Misafir Sekmesine Geç'),
        lastProvider === 'guest' ? h('span', { class: 'wl-last-used-badge' }, 'Son') : null) : null),
      h('div', { class: 'wl-security-footer' }, '🔒 256-bit SSL · Resmi Google Hesabınız ile Tek Tıkla Güvenli Giriş'));
  };

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
      activeTab = isLoggedMember ? 'account' : 'login';
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
      const handleInp = h('input', { class: 'input', id: 'wl-profile-handle-input', maxlength: '25', placeholder: '@kullaniciadi', value: profObj.handle ? `@${String(profObj.handle).replace(/^@+/, '')}` : '' });
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
      const userMins = Math.max(0, Number(profObj.watchMinutes || 0));
      const userMedal = profObj.medal || (userMins >= 300 ? '🥇 Altın İzleyici' : userMins >= 120 ? '🥈 Gümüş İzleyici' : userMins >= 30 ? '🥉 Bronz İzleyici' : '⚡ Yeni İzleyici');
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
            onclick: async () => {
              const v = addFrInp.value.trim();
              if (!v) return;
              const r = await sendFriendRequest(v);
              if (r?.ok) {
                addFrInp.value = '';
                toast(r.status === 'FRIENDS'
                  ? `🎉 ${r.friend?.name || v} ile artık karşılıklı arkadaşsınız!`
                  : `📩 ${r.target?.name || v} kişisine arkadaşlık isteği gönderildi (Onay bekleniyor)`);
                refreshLiveCard();
              } else {
                toast(r?.error || 'Kullanıcı bulunamadı. Tam @kullaniciadi yazın.');
              }
            },
          }, '+ İstek Gönder');
          const socialFriends = state.social?.friends?.length ? state.social.friends : myFriends;
          const reqCount = Number(state.social?.requestCount || state.social?.requests?.length || 0);
          const histCount = (getWatchHistory() || []).length;
          liveFriendsBox.append(
            h('div', {
              style: {
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '7px', marginBottom: '7px',
              },
            },
            h('button', {
              type: 'button',
              class: 'btn sm primary',
              id: 'wl-profile-open-history-btn',
              style: { justifyContent: 'center', padding: '8px 10px', fontSize: '.76rem' },
              onclick: () => {
                modalRef?.close?.();
                window.vortexOpenWatchHistory?.('all');
              },
            }, `🕒 İzleme Geçmişim (${histCount})`),
            h('button', {
              type: 'button',
              class: 'btn sm',
              id: 'wl-profile-open-friends-btn',
              style: { justifyContent: 'center', padding: '8px 10px', fontSize: '.76rem', background: 'rgba(99,102,241,0.16)', border: '1px solid rgba(99,102,241,0.38)', color: '#e0e7ff' },
              onclick: () => {
                modalRef?.close?.();
                window.vortexOpenFriendsModal?.(null, reqCount > 0 ? 'requests' : 'friends');
              },
            }, reqCount > 0 ? `👥 Arkadaşlar (${socialFriends.length}) · 🔔 ${reqCount}` : `👥 Arkadaşlarım (${socialFriends.length})`),
            h('button', {
              type: 'button',
              class: 'btn sm',
              id: 'wl-profile-open-dm-btn',
              style: { justifyContent: 'center', padding: '8px 10px', fontSize: '.76rem', background: 'rgba(39,220,200,0.12)', border: '1px solid rgba(39,220,200,0.32)', color: '#5eead4' },
              onclick: () => {
                modalRef?.close?.();
                openDmModal();
              },
            }, `💬 Mesajlarım${state.social?.totalUnread ? ` (${state.social.totalUnread})` : ''}`)),
            h('div', {
              style: {
                padding: '9px 11px', borderRadius: '12px', background: 'rgba(255,255,255,0.035)',
                border: '1px solid rgba(255,255,255,0.09)', display: 'flex', flexDirection: 'column', gap: '7px',
              },
            },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '.76rem', fontWeight: '700', color: 'rgba(255,255,255,0.85)' } },
              h('span', {}, `👥 Onaylı Arkadaşlarım (${socialFriends.length})`),
              h('span', { style: { fontSize: '.68rem', color: '#6ee7b7' } }, '🔒 Karşılıklı Onaylı')),
            socialFriends.length
              ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  socialFriends.slice(0, 10).map((fr) => h('span', {
                    style: {
                      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 8px',
                      borderRadius: '99px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      fontSize: '.74rem', color: '#f8fafc', cursor: 'pointer',
                    },
                    onclick: () => { modalRef?.close?.(); openDmModal(fr.uid || fr.id); },
                  }, avatar(fr, 18, { online: Boolean(fr.online) }), fr.name)))
              : h('div', { style: { fontSize: '.75rem', color: 'rgba(255,255,255,0.5)' } }, 'Henüz karşılıklı arkadaşın yok. @kullaniciadi ile istek gönder:'),
            h('div', { style: { display: 'flex', gap: '6px' } }, addFrInp, addFrBtn))
          );
        }
      };

      const syncAvatarEverywhere = (rawAvatarDataUrl) => {
        const newAvatarDataUrl = rawAvatarDataUrl ? sanitizeAvatarUrl(rawAvatarDataUrl) : '';
        if (rawAvatarDataUrl && !newAvatarDataUrl) {
          toast('⚠️ Geçersiz veya desteklenmeyen görsel biçimi engellendi.');
          return;
        }
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
        accept: 'image/png,image/jpeg,image/webp,image/gif',
        style: { position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' },
        onchange: (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (/svg/i.test(String(file.type || '')) || /\.svg$/i.test(String(file.name || ''))) {
            toast('⚠️ SVG dosyaları güvenlik nedeniyle profil fotoğrafı olarak kullanılamaz.');
            e.target.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = (ev) => {
            const rawDataUrl = String(ev.target?.result || '');
            if (!rawDataUrl || /^data:image\/svg/i.test(rawDataUrl)) {
              toast('⚠️ Geçersiz profil fotoğrafı biçimi.');
              return;
            }
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
                let outUrl = canvas.toDataURL('image/jpeg', 0.85);
                if (outUrl.length > 45000) outUrl = canvas.toDataURL('image/jpeg', 0.65);
                syncAvatarEverywhere(outUrl && outUrl.length > 64 && outUrl.length <= 45000 ? outUrl : sanitizeAvatarUrl(rawDataUrl));
                toast('📷 Profil fotoğrafın galeriden yüklendi ve kaydedildi!');
              } catch (_) {
                const safeFallback = rawDataUrl.length <= 45000 ? sanitizeAvatarUrl(rawDataUrl) : '';
                if (safeFallback) {
                  syncAvatarEverywhere(safeFallback);
                  toast('📷 Profil fotoğrafın güncellendi!');
                }
              }
            };
            img.onerror = () => {
              toast('⚠️ Seçilen görsel dosyası okunamadı.');
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
        const cleanVal = sanitizeAvatarUrl(avatarInp.value.trim());
        if (cleanVal) {
          selectedAvatarUrl = cleanVal;
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
              errBox.style.color = '#fb7185';
              errBox.textContent = '';
              const typedName = nameInp.value.trim();
              const typedHandleRaw = handleInp.value.trim().replace(/^@+/, '');
              if (typedName.length > 0 && typedName.length < 2) {
                errBox.textContent = 'Görünen ad en az 2 karakter olmalıdır.';
                nameInp.focus();
                return;
              }
              const name = typedName || profObj.name || 'İzleyici';
              const normTypedHandle = typedHandleRaw ? normalizeHandle(typedHandleRaw) : '';
              if (typedHandleRaw && normTypedHandle.length < 2) {
                errBox.textContent = 'Kullanıcı adı en az 2 geçerli karakter olmalıdır.';
                handleInp.focus();
                return;
              }
              const handle = normTypedHandle || normalizeHandle(profObj.handle || '', name);
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
                  const srvUser = res?.user || {};
                  const updated = saveProfile({
                    ...profObj,
                    ...payload,
                    ...srvUser,
                    authToken: res?.authToken || profObj.authToken,
                    isGuest: false,
                  });
                  finish(updated, `✓ Profilin kaydedildi (@${updated.handle})!`);
                  return;
                } catch (e) {
                  if (e && (e.status === 409 || e.status === 400 || e.status === 401)) {
                    errBox.textContent = e.message || 'Bu kullanıcı adı başka bir hesap tarafından kullanılıyor.';
                    handleInp.focus();
                    return;
                  }
                }
                const updated = saveProfile({ ...profObj, ...payload, isGuest: false });
                finish(updated, '✓ Profil bilgilerin güncellendi!');
              } else {
                const guestId = profObj.uid || profObj.id || ('guest_' + Math.random().toString(36).slice(2, 10));
                try {
                  const gRes = await api('/api/rave/social/guest', {
                    method: 'POST',
                    body: { uid: guestId, ...payload },
                  });
                  const gUser = gRes?.user || {};
                  const updated = saveGuestProfile({
                    ...profObj,
                    ...payload,
                    uid: gUser.uid || guestId,
                    handle: gUser.handle || handle,
                    guestToken: gRes?.guestToken || profObj.guestToken || '',
                    _skipProvision: true,
                  });
                  syncSocialState(true).catch(() => {});
                  pushPresenceHeartbeat().catch(() => {});
                  finish(updated, `✓ Profil kartın kaydedildi (@${updated.handle})!`);
                  return;
                } catch (e) {
                  if (e && (e.status === 409 || e.status === 400)) {
                    errBox.textContent = e.message || 'Bu kullanıcı adı şu an kullanımda.';
                    handleInp.focus();
                    return;
                  }
                }
                const updated = saveGuestProfile({ ...profObj, ...payload, uid: guestId });
                finish(updated, '✓ Profil kartın ve gizlilik ayarların kaydedildi!');
              }
            },
          }, '💾 Profili & Gizlilik Ayarlarını Kaydet'),
          isLoggedMember ? (() => {
            const curPwInp = h('input', { class: 'input', type: 'password', id: 'wl-cur-password-input', autocomplete: 'current-password', placeholder: 'Mevcut şifreniz' });
            const newPwInp = h('input', { class: 'input', type: 'password', id: 'wl-new-password-input', autocomplete: 'new-password', placeholder: 'Yeni şifre (en az 6 karakter)' });
            return h('details', { class: 'wl-account-sec-details', style: { width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '11px', padding: '8px 10px' } },
              h('summary', { style: { cursor: 'pointer', fontSize: '.78rem', fontWeight: '700', color: '#cbd5e1' } }, '🔐 Şifre Değiştir & Hesap Yönetimi'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', marginTop: '8px' } },
                curPwInp,
                newPwInp,
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button',
                    id: 'wl-change-password-btn',
                    class: 'btn sm primary',
                    onclick: async () => {
                      const cp = curPwInp.value;
                      const np = newPwInp.value;
                      if (!cp || np.length < 6) {
                        errBox.textContent = 'Mevcut şifrenizi ve en az 6 karakterli yeni şifrenizi girin.';
                        return;
                      }
                      try {
                        const r = await api('/api/auth/password', { method: 'POST', body: { currentPassword: cp, newPassword: np } });
                        if (r?.ok) {
                          const saved = saveProfile({ ...profObj, ...(r.user || {}), authToken: r.authToken || profObj.authToken, isGuest: false });
                          Object.assign(profObj, saved);
                          curPwInp.value = '';
                          newPwInp.value = '';
                          toast('✓ Şifreniz güncellendi ve diğer oturumlar sonlandırıldı!');
                        }
                      } catch (e) {
                        errBox.textContent = e?.message || 'Şifre güncellenemedi.';
                      }
                    },
                  }, '🔑 Şifreyi Güncelle'),
                  h('button', {
                    type: 'button',
                    id: 'wl-delete-account-btn',
                    class: 'btn sm danger',
                    onclick: async () => {
                      const cp = curPwInp.value;
                      if (!cp) {
                        errBox.textContent = 'Hesabı silmek için mevcut şifrenizi kutuya girin.';
                        curPwInp.focus();
                        return;
                      }
                      try {
                        const r = await api('/api/auth/delete', { method: 'POST', body: { password: cp } });
                        if (r?.ok) {
                          const guestProf = logoutProfile();
                          onDone?.(guestProf);
                          toast('Hesabınız kalıcı olarak silindi.');
                          modalRef?.close?.();
                        }
                      } catch (e) {
                        errBox.textContent = e?.message || 'Hesap silinemedi.';
                      }
                    },
                  }, '🗑️ Hesabı Sil'))));
          })() : null,
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
      const idInp = h('input', { class: 'input', placeholder: 'E-posta adresi veya @kullaniciadi (zorunlu)', autocomplete: 'username' });
      const pwInp = h('input', { class: 'input', type: 'password', placeholder: 'Şifreniz (zorunlu)', autocomplete: 'current-password' });
      const errBox = h('div', { class: 'wl-auth-err' });

      const submitLogin = async () => {
        errBox.style.color = '#fb7185';
        errBox.textContent = '';
        const identifier = idInp.value.trim();
        const password = pwInp.value;
        if (!identifier) {
          errBox.textContent = 'Lütfen e-posta adresinizi veya @kullanıcı adınızı girin.';
          idInp.focus();
          return;
        }
        if (!password || password.length < 4) {
          errBox.textContent = 'Şifre yazmadan giriş yapılamaz! Lütfen şifrenizi girin.';
          pwInp.focus();
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
        h('form', { class: 'wl-auth-form', onsubmit: (e) => { e.preventDefault(); submitLogin(); } },
          idInp,
          pwInp,
          errBox,
          h('button', { type: 'submit', class: 'btn primary wl-btn-full wl-btn-primary-gradient' }, '🔑 Hesabımla Giriş Yap'),
          h('button', {
            type: 'button',
            class: 'wl-auth-link-btn',
            onclick: sendResetEmail,
          }, 'Şifrenizi mi unuttunuz? E-posta ile sıfırlayın')),
        renderSocialButtons({
          getFormCreds: () => ({
            email: idInp.value.includes('@') ? idInp.value.trim() : '',
            password: pwInp.value,
            errEl: errBox,
          }),
        }));
      return;
    }

    // activeTab === 'register'
    const nameInp = h('input', { class: 'input', maxlength: '24', placeholder: 'Görünen Adın (Örn: Deniz — zorunlu)', value: (current && !current.isGuest && current.name && !/^Misafir/i.test(current.name)) ? current.name : '' });
    const handleInp = h('input', { class: 'input', maxlength: '25', placeholder: '@kullaniciadi (Örn: @izleyici)' });
    const emailInp = h('input', { class: 'input', type: 'email', placeholder: 'E-posta adresin (Örn: ad@gmail.com — zorunlu)', autocomplete: 'email' });
    const pwInp = h('input', { class: 'input', type: 'password', placeholder: 'Şifre belirle (en az 6 karakter — zorunlu)', autocomplete: 'new-password' });
    const errBox = h('div', { class: 'wl-auth-err' });

    const submitReg = async () => {
      errBox.style.color = '#fb7185';
      errBox.textContent = '';
      const name = nameInp.value.trim();
      const handle = handleInp.value.trim();
      const email = emailInp.value.trim();
      const password = pwInp.value;
      if (name.length < 2) { errBox.textContent = 'Görünen ad en az 2 karakter olmalıdır.'; nameInp.focus(); return; }
      if (handle && normalizeHandle(handle).length < 2) { errBox.textContent = 'Kullanıcı adı en az 2 geçerli karakter olmalıdır.'; handleInp.focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { errBox.textContent = 'Kayıt olmak için geçerli bir e-posta adresi girmelisiniz.'; emailInp.focus(); return; }
      if (!password || password.length < 6) { errBox.textContent = 'Şifre yazmadan kayıt olunamaz! Lütfen en az 6 karakterli bir şifre belirleyin.'; pwInp.focus(); return; }
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
      h('form', { class: 'wl-auth-form', onsubmit: (e) => { e.preventDefault(); submitReg(); } },
        nameInp,
        handleInp,
        emailInp,
        pwInp,
        h('label', { class: 'wl-field-label' }, 'Profil Neon Rengin'),
        renderColorPicker(),
        errBox,
        h('button', { type: 'submit', class: 'btn primary wl-btn-full wl-btn-primary-gradient' }, '✨ Hesap Oluştur & Başla')),
      renderSocialButtons({
        getFormCreds: () => ({
          email: emailInp.value.trim(),
          password: pwInp.value,
          errEl: errBox,
        }),
      }));
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
  let socialData = { friends: [], requests: [], outgoingRequests: [], threads: [], totalUnread: 0 };
  let activePeerId = initialPeerId || '';
  let activeDmMeta = { canMessage: false, friendState: 'NONE', peerTyping: false, settings: { expirySec: 0 }, peer: null };
  let activeMessages = [];
  let replyTarget = null;
  let lastTypingSentAt = 0;
  let lastRenderSig = '';
  let dmModal = null;
  let pollTimer = null;

  const root = h('div', { class: 'DMThreads DirectMessageView wl-dm-root' });
  const topBarWrap = h('div', { class: 'wl-dm-topbar' });
  const requestsWrap = h('div', { class: 'wl-dm-requests-slot' });
  const threadsCol = h('div', { class: 'DMThreads__list wl-dm-threads' });
  const peerHeaderEl = h('div', { class: 'wl-dm-peer-header' });
  const msgListEl = h('div', { class: 'DirectMessageView__messages wl-dm-messages' });
  const typingBarEl = h('div', { class: 'wl-dm-typing-bar', style: { display: 'none' } });
  const replyBarEl = h('div', { class: 'wl-dm-reply-bar', style: { display: 'none' } });
  const composerWrap = h('div', { class: 'wl-dm-composer-slot' });

  const addInp = h('input', {
    class: 'input',
    placeholder: '@kullaniciadi ile arkadaş ekle (Karşılıklı onaylı)',
    style: { flex: '1', height: '36px', fontSize: '.82rem' },
  });
  const addBtn = h('button', {
    type: 'button',
    class: 'btn primary sm',
    onclick: async () => {
      const val = addInp.value.trim();
      if (!val) return;
      const r = await sendFriendRequest(val);
      if (r?.ok) {
        addInp.value = '';
        toast(r.status === 'FRIENDS'
          ? `🎉 ${r.friend?.name || val} ile artık arkadaşsınız!`
          : `📩 ${r.target?.name || val} kişisine arkadaşlık isteği gönderildi`);
        await refreshAll(r.friend?.uid || r.target?.uid || activePeerId, true);
      } else {
        toast(r?.error || 'Kullanıcı bulunamadı');
      }
    },
  }, '➕ İstek Gönder');
  addInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

  const openHubBtn = h('button', {
    type: 'button',
    class: 'btn sm',
    onclick: () => {
      dmModal?.close?.();
      window.vortexOpenFriendsModal?.(null, 'search');
    },
  }, '🔎 Rehber');
  topBarWrap.append(addInp, addBtn, openHubBtn);

  const dmInp = h('input', {
    class: 'input',
    id: 'wl-dm-message-input',
    placeholder: 'Mesaj yaz... (Enter ile gönder)',
    style: { flex: '1', height: '40px' },
  });

  const emitTyping = () => {
    if (!activePeerId || !activeDmMeta.canMessage) return;
    const now = Date.now();
    if (now - lastTypingSentAt < 2500) return;
    lastTypingSentAt = now;
    api('/api/rave/social/dm', {
      method: 'POST',
      body: { uid: myUid, peerId: activePeerId, action: 'typing' },
    }).catch(() => {});
  };
  dmInp.addEventListener('input', emitTyping);

  const setReply = (msg) => {
    replyTarget = msg ? { id: msg.id, fromName: msg.fromName || 'İzleyici', text: String(msg.text || '').slice(0, 90) } : null;
    if (!replyTarget) {
      replyBarEl.style.display = 'none';
      replyBarEl.replaceChildren();
      return;
    }
    replyBarEl.style.display = 'flex';
    replyBarEl.replaceChildren(
      h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `↩ ${replyTarget.fromName}: "${replyTarget.text}"`),
      h('button', { type: 'button', class: 'btn sm', style: { padding: '2px 7px', fontSize: '.7rem' }, onclick: () => setReply(null) }, '✕')
    );
    dmInp.focus();
  };

  const sendDmNow = async (extra = {}) => {
    if (!activePeerId) return;
    const txt = (extra.text !== undefined ? extra.text : dmInp.value).trim();
    if (!txt && !extra.audioNote && !extra.roomInvite && !extra.roomInviteCard) return;
    if (extra.text === undefined) dmInp.value = '';
    const replyPayload = replyTarget;
    setReply(null);
    try {
      const r = await api('/api/rave/social/dm', {
        method: 'POST',
        body: {
          uid: myUid,
          fromName: me.name || 'İzleyici',
          color: me.color || '#27dcc8',
          peerId: activePeerId,
          text: txt,
          replyTo: replyPayload,
          ...extra,
        },
      });
      if (r?.ok) {
        activeMessages = r.messages || [];
        lastRenderSig = '';
        await refreshAll(activePeerId, true);
      } else {
        toast(r?.error || 'Mesaj gönderilemedi');
      }
    } catch (e) {
      toast(e?.message || 'Karşılıklı arkadaş olmadan mesaj gönderilemez');
    }
  };
  dmInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDmNow(); });

  let dmVoiceRec = null;
  let isRecordingDmVoice = false;
  const joinRoomById = (rid, autoCall = false, rawUrl = '') => {
    if (!rid && !rawUrl) return;
    dmVoiceRec?.stop?.(false);
    dmVoiceRec = null;
    isRecordingDmVoice = false;
    dmModal?.close?.();
    let navTarget = `/mesh/${encodeURIComponent(rid)}`;
    if (rawUrl) {
      const cleanHash = String(rawUrl).replace(/^https?:\/\/[^/]+/i, '').replace(/^\/?#/, '');
      if (cleanHash.startsWith('/mesh/')) navTarget = cleanHash;
    }
    if (autoCall && !navTarget.includes('autocall=1')) {
      navTarget += (navTarget.includes('?') ? '&' : '?') + 'autocall=1';
    }
    if (typeof window.vortexNavigate === 'function') window.vortexNavigate(navTarget);
    else window.location.href = `/#${navTarget}`;
  };

  const renderParts = (forceScroll = false) => {
    requestsWrap.replaceChildren();
    if (socialData.requests?.length) {
      requestsWrap.append(h('div', { class: 'rave-friend-requests-bar' },
        h('div', { style: { fontSize: '.76rem', fontWeight: '800', color: '#a5b4fc' } }, `🔔 Bekleyen Arkadaşlık İstekleri (${socialData.requests.length})`),
        ...socialData.requests.map((req) => h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '.81rem' } },
            avatar({ name: req.fromName, color: req.color, avatarUrl: req.avatarUrl }, 28),
            h('span', {}, `${req.fromName} (${req.fromHandle || '@uye'})`)),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', {
              type: 'button',
              class: 'btn primary sm',
              onclick: async () => {
                await updateFriendAction('accept', { requestId: req.id, targetUid: req.fromUid });
                toast(`🎉 ${req.fromName} ile artık karşılıklı arkadaşsınız!`);
                await refreshAll(req.fromUid || activePeerId, true);
              },
            }, '✓ Kabul Et'),
            h('button', {
              type: 'button',
              class: 'btn sm',
              onclick: async () => {
                await updateFriendAction('decline', { requestId: req.id, targetUid: req.fromUid });
                await refreshAll(activePeerId, true);
              },
            }, '✕ Reddet'))))));
    }

    const friends = socialData.friends || [];
    threadsCol.replaceChildren(...(friends.length ? friends.map((fr) => {
      const isAct = fr.uid === activePeerId;
      const th = (socialData.threads || []).find((t) => t.peer?.uid === fr.uid);
      const unread = Number(th?.unreadCount || fr.unread || 0);
      const pState = fr.presenceState || (fr.online ? 'online' : 'offline');
      return h('button', {
        type: 'button',
        class: `dm-thread-item wl-dm-thread-item ${isAct ? 'on active' : ''}`,
        onclick: () => { lastRenderSig = ''; refreshAll(fr.uid, true); },
      },
      h('div', { style: { position: 'relative', flexShrink: '0' } },
        avatar(fr, 36),
        h('span', { class: `wl-pres-dot is-${pState}` })),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' } },
          h('strong', { style: { fontSize: '.82rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `${fr.bestFriend ? '⭐ ' : ''}${fr.name}`),
          unread > 0 ? h('span', { class: 'wl-dm-unread-pill' }, String(unread)) : null),
        h('div', { class: `wl-dm-pres-line is-${pState}` },
          pState === 'watching' && fr.mediaTitle ? `🎬 ${fr.mediaTitle}` : (pState === 'online' ? '🟢 Çevrimiçi' : (pState === 'idle' ? '🌙 Uzakta' : `⚫ ${fr.lastSeenLabel || 'Çevrimdışı'}`))),
        h('div', { style: { fontSize: '.71rem', color: 'rgba(255,255,255,0.52)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, th?.lastMessage?.text || 'Mesaj gönder...')));
    }) : [
      h('div', { style: { padding: '14px 8px', fontSize: '.78rem', color: 'rgba(255,255,255,0.55)', textAlign: 'center' } }, 'Henüz onaylı arkadaşın yok. Yukarıdan @kullaniciadi ile istek gönder ✨'),
    ]));

    const activePeer = friends.find((f) => f.uid === activePeerId) || activeDmMeta.peer || null;
    peerHeaderEl.replaceChildren();
    composerWrap.replaceChildren();
    typingBarEl.style.display = activeDmMeta.peerTyping && activePeer ? 'flex' : 'none';
    if (activeDmMeta.peerTyping && activePeer) {
      typingBarEl.textContent = `💬 ${activePeer.name} yazıyor...`;
    }

    if (!activePeer) {
      msgListEl.replaceChildren(h('div', { class: 'wl-dm-empty-placeholder' },
        h('div', { style: { fontSize: '1.8rem' } }, '💬'),
        h('strong', {}, 'Özel Mesajlaşma & Oda Davetleri'),
        h('span', {}, 'Soldan bir arkadaşını seç veya yukarıdan @kullaniciadi yazarak arkadaşlık isteği gönder.')));
      return;
    }

    const pState = activePeer.presenceState || (activePeer.online ? 'online' : 'offline');
    const expOn = Number(activeDmMeta.settings?.expirySec || 0) > 0;
    peerHeaderEl.append(
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', minWidth: '0' } },
        h('div', { style: { position: 'relative', flexShrink: '0' } },
          avatar(activePeer, 36),
          h('span', { class: `wl-pres-dot is-${pState}` })),
        h('div', { style: { minWidth: '0' } },
          h('strong', { style: { fontSize: '.86rem', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${activePeer.name} (@${String(activePeer.handle || 'uye').replace(/^@+/, '')})`),
          h('div', { class: `wl-dm-pres-line is-${pState}` },
            pState === 'watching' && activePeer.mediaTitle
              ? `🎬 ${activePeer.mediaTitle} izliyor`
              : (pState === 'online' ? '🟢 Şu an çevrimiçi' : (pState === 'idle' ? '🌙 Uzakta' : `⚫ Çevrimdışı · ${activePeer.lastSeenLabel || 'Son görülme yakın zamanda'}`))))),
      h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' } },
        pState === 'watching' && activePeer.roomId ? h('button', {
          type: 'button',
          class: 'btn primary sm',
          onclick: () => joinRoomById(activePeer.roomId),
        }, '▶ Odasına Katıl') : null,
        activeDmMeta.canMessage ? h('button', {
          type: 'button',
          class: 'btn sm',
          id: 'btn-dm-voice-call',
          title: 'Sesli Arama Başlat',
          style: { background: 'rgba(34,197,94,0.18)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.42)' },
          onclick: async () => {
            try {
              let callRoomId = state.mesh?.id || '';
              let callRoomName = state.mesh?.name || `${me.name || 'Watchlivo'} · Sesli Arama`;
              if (!callRoomId) {
                let cid = '';
                try {
                  cid = sessionStorage.getItem('vortex_cid') || ('h_' + Math.random().toString(36).slice(2, 10));
                  sessionStorage.setItem('vortex_cid', cid);
                } catch (_) {}
                const cr = await api('/api/rooms/create', {
                  method: 'POST',
                  body: { name: callRoomName, privacy: 'friends', creator: me.name || 'Üye', creatorId: myUid, clientId: cid },
                });
                callRoomId = cr?.id || cr?.room?.id || '';
                try {
                  if (callRoomId && cr?.clientToken) sessionStorage.setItem('vortex_ct_' + callRoomId, cr.clientToken);
                  if (callRoomId && (cr?.clientId || cid)) sessionStorage.setItem('vortex_creator_' + callRoomId, cr?.clientId || cid);
                  if (callRoomId && cr?.room?.syncToken) sessionStorage.setItem('vortex_st_' + callRoomId, cr.room.syncToken);
                } catch (_) {}
              }
              if (!callRoomId) {
                toast('Sesli arama odası oluşturulamadı');
                return;
              }
              const callSyncTok = state.mesh?.syncToken || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('vortex_st_' + callRoomId) : '') || '';
              const callUrl = `/#/mesh/${encodeURIComponent(callRoomId)}?autocall=1${callSyncTok && callSyncTok.length < 6000 ? '&r_tok=' + encodeURIComponent(callSyncTok) : ''}`;
              await sendDmNow({
                text: `📞 ${me.name || 'Arkadaşın'} seni sesli aramaya çağırıyor!`,
                roomInvite: callRoomId,
                roomInviteCard: { roomId: callRoomId, roomName: callRoomName, mediaTitle: '📞 Canlı Sesli Arama', url: callUrl },
              });
              toast(`📞 ${activePeer.name} aranıyor...`);
              joinRoomById(callRoomId, true, callUrl);
            } catch (_) {
              toast('Sesli arama başlatılamadı');
            }
          },
        }, '📞 Sesli Ara') : null,
        activeDmMeta.canMessage ? h('button', {
          type: 'button',
          class: 'btn sm',
          title: 'El Salla (Anlık Bildirim)',
          onclick: async () => {
            const r = await sendRoomInvite(activePeer.uid, 'poke');
            if (r?.ok) toast(`👋 ${activePeer.name} kişisine el salladın!`);
          },
        }, '👋') : null,
        activeDmMeta.canMessage && state.mesh?.id ? h('button', {
          type: 'button',
          class: 'btn sm',
          style: { background: 'rgba(39,220,200,0.16)', color: '#5eead4', border: '1px solid rgba(39,220,200,0.38)' },
          onclick: async () => {
            const r = await sendRoomInvite(activePeer.uid, 'send');
            if (r?.ok) {
              toast(`📩 ${activePeer.name} odana davet edildi!`);
              await refreshAll(activePeer.uid, true);
            }
          },
        }, '📩 Odaya Davet') : null,
        activeDmMeta.canMessage ? h('button', {
          type: 'button',
          class: 'btn sm',
          title: 'Kaybolan Mesaj Süresi (Kalıcı / 24 Saat)',
          style: { fontSize: '.71rem', opacity: expOn ? '1' : '.75', borderColor: expOn ? '#fbbf24' : '' },
          onclick: async () => {
            const nextSec = expOn ? 0 : 86400;
            await api('/api/rave/social/dm', { method: 'POST', body: { uid: myUid, peerId: activePeer.uid, action: 'settings', expirySec: nextSec } });
            toast(nextSec ? '⏱️ 24 saatlik kaybolan mesaj modu açıldı' : '∞ Mesajlar kalıcı moda alındı');
            lastRenderSig = '';
            await refreshAll(activePeer.uid, false);
          },
        }, expOn ? '⏱️ 24s' : '∞') : null,
        activePeer.uid ? h('button', {
          type: 'button',
          class: 'btn sm danger',
          title: 'Kullanıcıyı Engelle',
          onclick: async () => {
            await updateFriendAction('block', { targetUid: activePeer.uid, targetName: activePeer.name });
            toast(`🚫 ${activePeer.name} engellendi`);
            activePeerId = '';
            lastRenderSig = '';
            await refreshAll('', true);
          },
        }, '🚫 Engelle') : null)
    );

    if (!activeDmMeta.canMessage) {
      const fSt = activeDmMeta.friendState || 'NONE';
      msgListEl.replaceChildren(h('div', { class: 'wl-dm-empty-placeholder non-friend-placeholder' },
        h('div', { style: { fontSize: '1.9rem' } }, '🔒'),
        h('strong', {}, 'Karşılıklı Arkadaş Onayı Gerekli'),
        h('span', {}, fSt === 'OUTGOING_PENDING'
          ? `${activePeer.name} kişisine arkadaşlık isteği gönderdin. Onayladığında mesajlaşma ve oda daveti açılacak.`
          : fSt === 'INCOMING_PENDING'
            ? `${activePeer.name} sana arkadaşlık isteği gönderdi! Hemen kabul ederek sohbete başlayabilirsin.`
            : `${activePeer.name} ile mesajlaşmak ve birbirinizi odaya davet etmek için önce arkadaşlık isteği gönderin.`),
        fSt === 'INCOMING_PENDING'
          ? h('button', {
              type: 'button',
              class: 'btn primary',
              onclick: async () => {
                await updateFriendAction('accept', { targetUid: activePeer.uid });
                toast(`🎉 ${activePeer.name} ile artık arkadaşsınız!`);
                lastRenderSig = '';
                await refreshAll(activePeer.uid, true);
              },
            }, '✓ Arkadaşlık İsteğini Kabul Et')
          : fSt === 'OUTGOING_PENDING'
            ? h('span', { class: 'wl-verified-pill' }, '⏳ Onay Bekleniyor')
            : h('button', {
                type: 'button',
                class: 'btn primary',
                onclick: async () => {
                  const r = await sendFriendRequest(activePeer.uid);
                  if (r?.ok) {
                    toast(`📩 ${activePeer.name} kişisine istek gönderildi!`);
                    lastRenderSig = '';
                    await refreshAll(activePeer.uid, false);
                  }
                },
              }, '➕ Arkadaşlık İsteği Gönder')));
      return;
    }

    dmInp.placeholder = `${activePeer.name} kişisine mesaj yaz...`;
    const dmVoiceBtn = h('button', {
      type: 'button',
      class: 'btn sm wl-dm-mic-btn',
      id: 'btn-dm-voice-rec',
      title: 'Sesli Mesaj Gönder',
      style: { minWidth: '40px', height: '40px', padding: '0 10px' },
      onclick: async () => {
        if (dmVoiceRec) {
          dmVoiceRec.stop(true);
          return;
        }
        const handle = await startUniversalVoiceRecorder({
          maxSeconds: 24,
          apiFn: api,
          onTick: (sec) => {
            dmVoiceBtn.textContent = `🔴 0:${String(sec).padStart(2, '0')}`;
          },
          onFinish: async (audioNote) => {
            dmVoiceRec = null;
            isRecordingDmVoice = false;
            dmVoiceBtn.classList.remove('recording');
            dmVoiceBtn.textContent = '🎙️';
            if (!root.isConnected) return;
            await sendDmNow({ text: '', audioNote });
          },
          onError: (msg) => {
            dmVoiceRec = null;
            isRecordingDmVoice = false;
            dmVoiceBtn.classList.remove('recording');
            dmVoiceBtn.textContent = '🎙️';
            toast(msg || 'Mikrofon izni gerekli');
          },
        });
        if (handle) {
          dmVoiceRec = handle;
          isRecordingDmVoice = true;
          dmVoiceBtn.classList.add('recording');
          dmVoiceBtn.textContent = '🔴 0:00';
        }
      },
    }, '🎙️');
    composerWrap.append(
      dmInp,
      dmVoiceBtn,
      h('button', { type: 'button', class: 'btn primary', onclick: () => sendDmNow() }, 'Gönder ➤')
    );

    msgListEl.replaceChildren(...(activeMessages.length ? activeMessages.map((m) => {
      const isMe = m.fromUid === myUid;
      const card = m.roomInviteCard || (m.roomInvite ? { roomId: m.roomInvite, roomName: `Oda #${m.roomInvite}` } : null);
      const isVoiceCallCard = Boolean(card?.mediaTitle && String(card.mediaTitle).includes('Sesli Arama'));
      const vnPlayer = m.audioNote ? buildUniversalAudioNotePlayer(m.audioNote, { h, toast }) : null;
      const reactions = m.reactions && typeof m.reactions === 'object' ? Object.entries(m.reactions).filter(([, arr]) => Array.isArray(arr) && arr.length > 0) : [];
      return h('div', { class: `wl-dm-bubble ${isMe ? 'is-me' : 'is-peer'}` },
        h('div', { class: 'wl-dm-bubble-meta' },
          h('strong', { style: { color: isMe ? '#5eead4' : (m.color || '#a5b4fc') } }, isMe ? 'Sen' : (m.fromName || activePeer.name)),
          h('span', {}, [m.time || '', isMe ? (m.readAt ? ' · ✓✓' : ' · ✓') : ''].join(''))),
        m.replyTo ? h('div', { class: 'wl-dm-reply-quote' }, `↩ ${m.replyTo.fromName || ''}: ${m.replyTo.text || ''}`) : null,
        m.text ? h('div', { class: 'wl-dm-bubble-text' }, m.text) : null,
        vnPlayer,
        card?.roomId ? h('div', { class: 'wl-dm-invite-card' },
          (card.poster || card.mediaPoster) ? h('img', { src: card.poster || card.mediaPoster, alt: '', class: 'wl-dm-invite-poster' }) : h('div', { class: 'wl-dm-invite-icon' }, isVoiceCallCard ? '📞' : '🎬'),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('strong', { style: { display: 'block', fontSize: '.8rem', color: '#fff' } }, card.mediaTitle || card.roomName || 'Canlı Sinema Odası'),
            h('span', { style: { fontSize: '.71rem', color: 'rgba(255,255,255,0.65)' } }, `${card.roomName || 'Watchlivo Odası'} · ${isVoiceCallCard ? 'Ses Kanalı' : 'Canlı İzleme'}`)),
          h('button', { type: 'button', class: 'btn primary sm', onclick: () => joinRoomById(card.roomId, isVoiceCallCard, card.url || '') }, isVoiceCallCard ? '📞 Katıl' : '▶ Katıl')) : null,
        reactions.length ? h('div', { class: 'wl-dm-reactions-row' },
          ...reactions.map(([emo, uids]) => h('button', {
            type: 'button',
            class: `wl-dm-react-chip ${uids.includes(myUid) ? 'on' : ''}`,
            onclick: async () => {
              await api('/api/rave/social/dm', { method: 'POST', body: { uid: myUid, peerId: activePeer.uid, action: 'react', messageId: m.id, emoji: emo } });
              lastRenderSig = '';
              await refreshAll(activePeer.uid, false);
            },
          }, `${emo} ${uids.length}`))) : null,
        h('div', { class: 'wl-dm-bubble-actions' },
          ...['❤️', '😂', '🔥', '🍿'].map((emo) => h('button', {
            type: 'button',
            class: 'wl-dm-mini-act',
            onclick: async () => {
              await api('/api/rave/social/dm', { method: 'POST', body: { uid: myUid, peerId: activePeer.uid, action: 'react', messageId: m.id, emoji: emo } });
              lastRenderSig = '';
              await refreshAll(activePeer.uid, false);
            },
          }, emo)),
          h('button', { type: 'button', class: 'wl-dm-mini-act', title: 'Yanıtla', onclick: () => setReply(m) }, '↩'),
          isMe ? h('button', {
            type: 'button',
            class: 'wl-dm-mini-act',
            title: 'Mesajı Sil',
            onclick: async () => {
              await api('/api/rave/social/dm', { method: 'POST', body: { uid: myUid, peerId: activePeer.uid, action: 'delete', messageId: m.id } });
              lastRenderSig = '';
              await refreshAll(activePeer.uid, false);
            },
          }, '🗑️') : null));
    }) : [
      h('div', { class: 'wl-dm-empty-placeholder' }, `${activePeer.name} ile sohbet başlat veya bir odaya davet gönder 💬`),
    ]));

    if (forceScroll) {
      setTimeout(() => { msgListEl.scrollTop = msgListEl.scrollHeight; }, 20);
    }
  };

  const refreshAll = async (peerId = activePeerId, forceScroll = false) => {
    if (!peerId) {
      try {
        const st0 = await syncSocialState(true);
        if (st0?.ok) socialData = st0;
      } catch (_) {}
      if (socialData.friends?.length) peerId = socialData.friends[0].uid;
    }
    activePeerId = peerId || '';
    if (activePeerId) {
      try {
        const d = await api(`/api/rave/social/dm?uid=${encodeURIComponent(myUid)}&peerId=${encodeURIComponent(activePeerId)}`);
        if (d?.ok) {
          activeMessages = d.messages || [];
          activeDmMeta = {
            canMessage: Boolean(d.canMessage),
            friendState: d.friendState || 'NONE',
            peerTyping: Boolean(d.peerTyping),
            settings: d.settings || { expirySec: 0 },
            peer: d.peer || null,
          };
        }
      } catch (_) {
        activeMessages = [];
      }
    }
    try {
      const st = await syncSocialState(true);
      if (st?.ok) socialData = st;
    } catch (_) {}
    const sig = JSON.stringify([
      activePeerId,
      activeDmMeta.canMessage,
      activeDmMeta.friendState,
      activeDmMeta.peerTyping,
      activeDmMeta.settings?.expirySec,
      (socialData.requests || []).length,
      (socialData.friends || []).map((f) => `${f.uid}:${f.presenceState}:${f.unread || 0}`),
      (socialData.threads || []).map((t) => `${t.peer?.uid}:${t.unreadCount || 0}:${t.lastMessage?.id || ''}`),
      activeMessages.map((m) => `${m.id}:${m.readAt || 0}:${JSON.stringify(m.reactions || {})}`),
    ]);
    const isPlayingDmAudio = Array.from(msgListEl.querySelectorAll('audio')).some((el) => !el.paused);
    if ((sig !== lastRenderSig || forceScroll) && !isRecordingDmVoice && !isPlayingDmAudio) {
      const hadFocus = document.activeElement === dmInp;
      lastRenderSig = sig;
      renderParts(forceScroll);
      if (hadFocus && dmInp.isConnected) dmInp.focus();
    }
  };

  const rightCol = h('div', { class: 'wl-dm-right-col' },
    peerHeaderEl,
    msgListEl,
    typingBarEl,
    replyBarEl,
    composerWrap
  );
  root.append(topBarWrap, requestsWrap, h('div', { class: 'wl-dm-split' }, threadsCol, rightCol));

  await refreshAll(activePeerId, true);

  const cleanupDmModal = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (dmVoiceRec) {
      try { dmVoiceRec.stop(false); } catch (_) {}
      dmVoiceRec = null;
    }
    isRecordingDmVoice = false;
    stopActiveVoiceNoteGlobal();
  };

  dmModal = popup({
    title: '💬 Özel Mesajlar (DM) & Arkadaş Sohbeti',
    content: root,
    dismissable: true,
    wide: true,
    onClose: cleanupDmModal,
    options: [{ label: 'Kapat', class: 'btn' }],
  });

  pollTimer = setInterval(() => {
    if (!root.isConnected) {
      cleanupDmModal();
      return;
    }
    refreshAll(activePeerId, false).catch(() => {});
  }, 2800);
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
  const uHandle = normalizeHandle(targetUser.handle || '', uName);
  const safeSocialUid = String(targetUser.uid || (/^(u_wl_|guest_|u_)/i.test(String(targetUser.id || '')) ? targetUser.id : '') || '').trim();
  const uBio = String(targetUser.bio || '').trim();
  const uStatusEmoji = targetUser.statusEmoji || '🍿';
  const uStatusText = String(targetUser.statusText || '').trim();
  const uHideWatching = asBool(targetUser.hideWatching);
  const uHideFriends = asBool(targetUser.hideFriends);
  const uMedal = targetUser.medal || '🍿 İzleyici';
  const uMins = Math.max(0, Number(targetUser.watchMinutes || 0));
  const inCurrentMesh = Boolean(state.mesh && Array.isArray(state.mesh.participants) && state.mesh.participants.some((p) =>
    (targetUser.id && p.id === targetUser.id) || (safeSocialUid && p.uid && p.uid === safeSocialUid)
  ));
  const activeMediaTitle = targetUser.nowWatching || targetUser.watchingRoom?.mediaTitle || targetUser.mediaTitle || (inCurrentMesh ? (state.mesh?.media?.title || '') : '');
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
      (() => {
        const matchedFriend = (state.social?.friends || []).find((f) =>
          (safeSocialUid && f.uid === safeSocialUid) ||
          (f.handle && normalizeHandle(f.handle) === uHandle)
        );
        const matchedOutReq = (state.social?.outgoingRequests || []).find((o) =>
          (safeSocialUid && o.toUid === safeSocialUid) ||
          (o.toHandle && normalizeHandle(o.toHandle) === uHandle)
        );
        const matchedInReq = (state.social?.requests || []).find((req) =>
          (safeSocialUid && req.fromUid === safeSocialUid) ||
          (req.fromHandle && normalizeHandle(req.fromHandle) === uHandle)
        );
        let targetUid = safeSocialUid || matchedFriend?.uid || matchedOutReq?.toUid || matchedInReq?.fromUid || '';
        let isMutual = Boolean(matchedFriend) || isFriend(targetUser);
        let isPendingOut = Boolean(matchedOutReq);
        let isPendingIn = Boolean(matchedInReq);
        const friendActionBtn = h('button', {
          type: 'button',
          class: `btn ${isMutual || isPendingOut ? '' : 'primary'}`,
          style: { flex: '1', justifyContent: 'center' },
          onclick: async (e) => {
            const btn = e.currentTarget;
            if (isMutual && targetUid) {
              const res = await updateFriendAction('remove', { targetUid });
              if (res?.ok !== false) {
                isMutual = false;
                isPendingOut = false;
                btn.classList.add('primary');
                btn.textContent = '👥 + Arkadaş Ekle';
                toast(`${uName} arkadaş listesinden çıkarıldı`);
              }
              return;
            }
            if (isPendingOut && targetUid) {
              const res = await updateFriendAction('cancel', { targetUid });
              if (res?.ok !== false) {
                isPendingOut = false;
                isMutual = false;
                btn.classList.add('primary');
                btn.textContent = '👥 + Arkadaş Ekle';
                toast('Arkadaşlık isteği geri çekildi');
              }
              return;
            }
            if (isPendingIn && targetUid) {
              const res = await updateFriendAction('accept', { requestId: matchedInReq?.id, targetUid });
              if (res?.ok !== false) {
                isPendingIn = false;
                isMutual = true;
                isPendingOut = false;
                btn.classList.remove('primary');
                btn.textContent = '✓ Arkadaşsınız';
                toast(`🎉 ${uName} ile artık arkadaşsınız!`);
              }
              return;
            }
            const r = await sendFriendRequest(targetUid || `@${uHandle}`);
            if (r?.ok) {
              if (r.friend?.uid || r.target?.uid) targetUid = r.friend?.uid || r.target?.uid || targetUid;
              isMutual = r.status === 'FRIENDS';
              isPendingOut = r.status !== 'FRIENDS';
              btn.classList.remove('primary');
              btn.textContent = isMutual ? '✓ Arkadaşsınız' : '⏳ Onay Bekleniyor';
              toast(isMutual ? `🎉 ${uName} ile artık arkadaşsınız!` : `📩 ${uName} kişisine arkadaşlık isteği gönderildi`);
            } else {
              toast(r?.error || 'İstek gönderilemedi');
            }
          },
        }, isMutual ? '✓ Arkadaşsınız' : (isPendingOut ? '⏳ Onay Bekleniyor' : (isPendingIn ? '✓ İsteği Kabul Et' : '👥 + Arkadaş Ekle')));
        return friendActionBtn;
      })(),
      state.mesh?.id ? h('button', {
        type: 'button',
        class: 'btn',
        style: { flex: '1', justifyContent: 'center', background: 'rgba(39,220,200,0.14)', border: '1px solid rgba(39,220,200,0.35)', color: '#5eead4' },
        onclick: async (e) => {
          const btn = e.currentTarget;
          const r = await sendRoomInvite(safeSocialUid || `@${uHandle}`, 'send');
          if (r?.ok) {
            btn.textContent = '✓ Odaya Davet Edildi';
            toast(`📩 ${uName} kişisine oda daveti gönderildi!`);
          } else {
            toast(r?.error || 'Davet gönderilemedi');
          }
        },
      }, '📩 Odaya Davet Et') : null,
      h('button', {
        type: 'button',
        class: 'btn',
        style: { flex: '1', justifyContent: 'center' },
        onclick: () => {
          userModal?.close?.();
          openDmModal(safeSocialUid || `@${uHandle}`);
        },
      }, '💬 Özel Mesaj'),
      h('button', {
        type: 'button',
        class: 'btn danger',
        style: { flex: '1', justifyContent: 'center' },
        onclick: async () => {
          await updateFriendAction('block', { targetUid: safeSocialUid || `@${uHandle}`, targetName: uName });
          toast(`🚫 ${uName} engellendi`);
          userModal?.close?.();
        },
      }, '🚫 Engelle')));

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
export async function syncGoogleYoutubeOAuth(password = '', expectedEmail = '') {
  let rawPw = String(password || '').trim();
  let rawEm = String(expectedEmail || '').trim();
  if (rawPw.includes('@') && !rawEm) {
    rawEm = rawPw;
    rawPw = '';
  }
  const cleanPw = rawPw;
  const cleanEmail = rawEm.toLowerCase();
  const fb = await getFirebaseAuth();
  if (!fb?.auth || !fb?.GoogleAuthProvider || !fb?.signInWithPopup) {
    throw new Error('Google kimlik doğrulama modülü yüklenemedi.');
  }
  try { await fb.auth.signOut?.(); } catch (_) {}
  const gProv = new fb.GoogleAuthProvider();
  gProv.addScope('https://www.googleapis.com/auth/youtube.readonly');
  const customParams = { prompt: 'select_account' };
  if (cleanEmail) customParams.login_hint = cleanEmail;
  gProv.setCustomParameters(customParams);
  const cred = await fb.signInWithPopup(fb.auth, gProv);
  const oauthCred = fb.GoogleAuthProvider.credentialFromResult(cred);
  const ytAccessToken = oauthCred?.accessToken || '';
  const fbEmail = (cred?.user?.email || '').trim().toLowerCase();
  const fbName = cred?.user?.displayName || '';
  if (cleanEmail && fbEmail && cleanEmail !== fbEmail) {
    try { await fb.auth.signOut?.(); } catch (_) {}
    throw new Error(`Yazdığınız e-posta (${cleanEmail}) ile seçtiğiniz Google hesabı (${fbEmail}) eşleşmiyor!`);
  }
  const idToken = await cred.user.getIdToken(true);
  const authRes = await api('/api/auth/oauth', {
    method: 'POST',
    body: { provider: 'google', idToken, email: cleanEmail || fbEmail, name: fbName, password: cleanPw.length >= 6 ? cleanPw : '' },
  });
  if (authRes?.ok && authRes.user) {
    saveProfile({ ...authRes.user, authToken: authRes.authToken, isGuest: false, verified: true });
    await syncCloudUserMedia(true);
  }
  const syncRes = await pushYtPrefsAction({
    action: 'import_oauth',
    ytAccessToken,
    googleConnected: true,
    googleEmail: fbEmail,
    googleChannelTitle: fbName,
  });
  invalidateYtFeedCache();
  return {
    ok: true,
    email: fbEmail,
    name: fbName,
    importedSubs: Number(syncRes?.importedSubs || 0),
    importedLikes: Number(syncRes?.importedLikes || 0),
  };
}
