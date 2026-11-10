// Minimal reactive store (mirrors Rave's redux slices: self, view, mesh, selection, uiPrefs/theme schemas).
const _STORE_SINGLETON = (typeof window !== 'undefined' && window.__wlStoreSingleton) || null;
const listeners = _STORE_SINGLETON ? _STORE_SINGLETON.listeners : new Set();
const UI_PREFS_KEY = 'vortex_ui_prefs_v1';

export const THEME_SCHEMAS = [
  { id: 'supabase',   name: 'Zümrüt Stüdyo',    badge: 'Zümrüt Kontrast',    desc: 'Obsidyen zemin & zümrüt-turkuaz stüdyo', swatch: 'linear-gradient(135deg, #06090e 0%, #0d1f1d 100%)', bg: '#06090e', accent: '#27dcc8', accent2: '#10b981', ink: '#041014' },
  { id: 'vercel',     name: 'Saf OLED Siyah',   badge: 'Gerçek Siyah',       desc: '#000000 OLED & gümüş sinema kontrastı',  swatch: 'linear-gradient(135deg, #000000 0%, #111318 100%)', bg: '#000000', accent: '#38bdf8', accent2: '#e2e8f0', ink: '#041014' },
  { id: 'graphite',   name: 'Antrasit Sinema',  badge: 'Göz Dostu',          desc: 'Mat antrasit uzun maraton salonu',       swatch: 'linear-gradient(135deg, #0d0f14 0%, #181c26 100%)', bg: '#0d0f14', accent: '#818cf8', accent2: '#a5b4fc', ink: '#070914' },
  { id: 't3chat',     name: 'Kozmik Fuşya',     badge: 'Sosyal Parti',       desc: 'Gece moru & neon eflatun enerjisi',      swatch: 'linear-gradient(135deg, #0c0916 0%, #1e1136 100%)', bg: '#0c0916', accent: '#c084fc', accent2: '#f472b6', ink: '#090412' },
  { id: 'indigo',     name: 'Gece IMAX',        badge: 'Varsayılan · IMAX',  desc: 'Derin gece mavisi & okyanus ışıltısı',   swatch: 'linear-gradient(135deg, #060b16 0%, #0f2042 100%)', bg: '#060b16', accent: '#60a5fa', accent2: '#38bdf8', ink: '#040b16' },
  { id: 'amber',      name: 'Altın Loca VIP',   badge: 'Sıcak Kehribar',     desc: 'Altın-kehribar özel gösterim salonu',    swatch: 'linear-gradient(135deg, #0e0b07 0%, #271c0c 100%)', bg: '#0e0b07', accent: '#f59e0b', accent2: '#fbbf24', ink: '#140c02' },
  { id: 'catppuccin', name: 'Kadife Gece',      badge: 'Anime & Pastel',     desc: 'Yumuşak mocha & pastel lavanta dokusu',  swatch: 'linear-gradient(135deg, #11111b 0%, #1e1e2e 100%)', bg: '#11111b', accent: '#b4befe', accent2: '#cba6f7', ink: '#0b0b14' },
  { id: 'mint',       name: 'Kuzey Işığı',      badge: 'Canlı Yayın',        desc: 'Arduvaz gece & nane yeşili netlik',      swatch: 'linear-gradient(135deg, #071013 0%, #0d2629 100%)', bg: '#071013', accent: '#2dd4bf', accent2: '#14b8a6', ink: '#031210' },
];

const LEGACY_THEME_MAP = {
  obsidian: 'indigo',
  oled: 'vercel',
  crimson: 't3chat',
  midnight: 'indigo',
  emerald: 'mint',
};

function normalizeThemeId(id) {
  if (!id) return 'indigo';
  const mapped = LEGACY_THEME_MAP[id] || id;
  return THEME_SCHEMAS.some((t) => t.id === mapped) ? mapped : 'indigo';
}

function loadUiPrefs() {
  const defaults = {
    theme: 'indigo',
    ambient: 'medium',
    density: 'comfortable',
    cardStyle: 'glass',
    subSize: 'md',
    subColor: 'white',
    subDual: false,
    subOffsetSec: 0,
    voiceDucking: true,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    const merged = { ...defaults, ...raw };
    merged.theme = normalizeThemeId(merged.theme);
    return merged;
  } catch (e) {
    return defaults;
  }
}

export function applyUiPrefs(prefs = state?.uiPrefs) {
  if (typeof document === 'undefined' || !prefs) return;
  const root = document.documentElement;
  const themeId = normalizeThemeId(prefs.theme);
  root.dataset.theme = themeId;
  root.dataset.ambient = prefs.ambient || 'low';
  root.dataset.density = prefs.density || 'comfortable';
  root.dataset.cardStyle = prefs.cardStyle || 'glass';
  root.dataset.subSize = prefs.subSize || 'md';
  root.dataset.subColor = prefs.subColor || 'white';
  const schema = THEME_SCHEMAS.find((t) => t.id === themeId) || THEME_SCHEMAS[0];
  if (schema) {
    root.style.setProperty('--theme-accent', schema.accent);
    root.style.setProperty('--theme-accent-2', schema.accent2 || schema.accent);
    root.style.setProperty('--accent-ink', schema.ink || '#041014');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme && schema.bg) metaTheme.setAttribute('content', schema.bg);
  }
  const sizeMap = { sm: '0.92rem', md: '1.15rem', lg: '1.42rem', xl: '1.72rem' };
  const colorMap = { white: '#ffffff', yellow: '#fde047', cyan: '#6366f1', box: '#ffffff' };
  const bgMap = { white: 'rgba(7, 8, 13, 0.72)', yellow: 'rgba(7, 8, 13, 0.78)', cyan: 'rgba(7, 8, 13, 0.82)', box: 'rgba(0, 0, 0, 0.92)' };
  root.style.setProperty('--sub-font-size', sizeMap[prefs.subSize] || sizeMap.md);
  root.style.setProperty('--sub-color', colorMap[prefs.subColor] || '#ffffff');
  root.style.setProperty('--sub-bg', bgMap[prefs.subColor] || 'rgba(7, 8, 13, 0.75)');
  if (typeof window !== 'undefined') {
    window.__kinoxVoiceDuckEnabled = prefs.voiceDucking !== false;
    try { localStorage.setItem('vortex_voice_duck', prefs.voiceDucking === false ? '0' : '1'); } catch (e) { /* ignore */ }
  }
}

export const state = _STORE_SINGLETON ? _STORE_SINGLETON.state : {
  self: null,                         // { id, name, color, emoji }
  route: { name: 'home', params: {} },
  view: { left: 'Collapsed', right: 'Collapsed' },   // Rave mesh/view: Search, Vote, Friends, Participants, Globe, Settings, MeshList, Collapsed
  mesh: null,                         // serialized room from server
  clientId: null,
  connection: 'offline',              // offline | connecting | online
  voice: { inCall: false, micOn: false, camOn: false, screenOn: false, deafened: false, speaking: false },
  selection: { provider: null, query: '' },
  chatVisible: true,
  unseenChat: 0,
  uiPrefs: loadUiPrefs(),
  social: {
    friends: [],
    onlineCount: 0,
    requests: [],
    requestCount: 0,
    outgoingRequests: [],
    blocked: [],
    totalUnread: 0,
    privacy: { presenceVisibility: 'friends', hideWatching: false, allowInvites: 'friends' },
    loaded: false,
  },
};
if (typeof window !== 'undefined' && !window.__wlStoreSingleton) {
  window.__wlStoreSingleton = { state, listeners };
}

applyUiPrefs(state.uiPrefs);

let _activeAccountScope = '';

export function set(patch) {
  const prevScope = _activeAccountScope || getAccountStorageScope();
  const resolvedPatch = typeof patch === 'function' ? patch(state) : patch;
  Object.assign(state, resolvedPatch);
  if (resolvedPatch && Object.prototype.hasOwnProperty.call(resolvedPatch, 'self')) {
    const nextScope = getAccountStorageScope();
    if (nextScope !== _activeAccountScope) {
      if (prevScope && prevScope.startsWith('guest_') && nextScope.startsWith('acct_')) {
        try {
          for (const keyFn of [_historyKey, _favKey, _musicKey, _ytPrefsKey]) {
            const gVal = localStorage.getItem(keyFn(prevScope));
            const aKey = keyFn(nextScope);
            const aVal = localStorage.getItem(aKey);
            if (gVal && gVal !== '[]' && gVal !== '{}' && (!aVal || aVal === '[]' || aVal === '{}')) {
              localStorage.setItem(aKey, gVal);
            }
          }

        } catch (_) {}
      }
      _activeAccountScope = nextScope;
      _lastCloudSyncAt = 0;
      _lastCloudProgPush.clear();
      purgeLegacySharedHistoryKeys();
      if (isCloudAuthenticated()) {
        Promise.resolve().then(() => syncCloudUserMedia(true).catch(() => {}));
      }
    }
  }
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error('[store listener]', e); }
  }
}

export function setUiPref(patch, val) {
  const patchObj = typeof patch === 'string' ? { [patch]: val } : (patch && typeof patch === 'object' ? patch : {});
  const next = { ...state.uiPrefs, ...patchObj };
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  applyUiPrefs(next);
  set({ uiPrefs: next });
}

export function transitionTheme(themeId, evt = null) {
  const target = normalizeThemeId(themeId);
  if (state.uiPrefs?.theme === target) return;
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !reduced) {
    const x = Number.isFinite(evt?.clientX) ? evt.clientX : window.innerWidth / 2;
    const y = Number.isFinite(evt?.clientY) ? evt.clientY : 48;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    document.documentElement.style.setProperty('--vt-x', `${x}px`);
    document.documentElement.style.setProperty('--vt-y', `${y}px`);
    document.documentElement.style.setProperty('--vt-r', `${Math.ceil(endRadius)}px`);
    try {
      const vt = document.startViewTransition(() => {
        setUiPref({ theme: target });
      });
      vt.ready.then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${Math.ceil(endRadius)}px at ${x}px ${y}px)`] },
          { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      }).catch(() => {});
      return;
    } catch (e) { /* fallback */ }
  }
  setUiPref({ theme: target });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setView(side, value) {
  const cur = state.view[side];
  const next = cur === value ? 'Collapsed' : value;
  const other = side === 'left' ? 'right' : 'left';
  const collapseOther = next !== 'Collapsed' && typeof window !== 'undefined' && window.innerWidth <= 1180;
  set({ view: { ...state.view, [side]: next, ...(collapseOther ? { [other]: 'Collapsed' } : {}) } });
}

export const isCreatorSelf = () => {
  if (!state.mesh || state.mesh.curated) return false;
  const myCid = state.clientId;
  if (!myCid) return false;
  const meP = Array.isArray(state.mesh.participants) ? state.mesh.participants.find((p) => p.id === myCid) : null;
  if (meP?.isCreator) return true;
  if (state.mesh.creatorCid && state.mesh.creatorCid !== myCid) {
    const creatorAlive = Array.isArray(state.mesh.participants) && state.mesh.participants.some((p) => p.id === state.mesh.creatorCid);
    if (creatorAlive) return false;
  }
  try {
    const savedCreator = sessionStorage.getItem(`vortex_creator_${state.mesh.id}`);
    if (savedCreator && savedCreator === myCid) return true;
  } catch (e) { /* ignore */ }
  return false;
};
export const isActiveTimeKeeper = () => {
  if (!state.mesh || state.mesh.curated) return false;
  const myCid = state.clientId;
  const hostId = state.mesh.host_id;
  if (hostId && myCid && hostId === myCid) return true;
  const meP = Array.isArray(state.mesh.participants) ? state.mesh.participants.find((p) => p.id === myCid) : null;
  if (meP?.isHost) return true;
  if ((!hostId || String(hostId).startsWith('bot_')) && isCreatorSelf()) return true;
  return false;
};
export const isHostOnly = () => {
  if (!state.mesh || state.mesh.curated) return false;
  if (isActiveTimeKeeper() || isCreatorSelf()) return true;
  return false;
};
export const isLeader = () => {
  if (!state.mesh) return false;
  if (state.mesh.curated) return false;
  if (isHostOnly()) return true;
  if (state.mesh.playMode === 'cohost') return true;
  if (Array.isArray(state.mesh.co_hosts) && state.clientId && state.mesh.co_hosts.includes(state.clientId)) return true;
  const meCoP = Array.isArray(state.mesh.participants) ? state.mesh.participants.find((p) => p.id === state.clientId) : null;
  if (meCoP?.isCoHost) return true;
  return false;
};
export function isRoomMediaPlaying(media) {
  if (!media) return false;
  if (media.meshStateStatus === 'PAUSED') return false;
  if (media.meshStateStatus === 'PLAYING') return true;
  return Boolean(media.playing);
}

export function normalizeRoomMediaState(prev, patch) {
  const merged = { ...(prev || {}), ...(patch || {}) };
  if (patch && typeof patch.meshStateStatus === 'string' && patch.meshStateStatus) {
    merged.meshStateStatus = patch.meshStateStatus;
    merged.playing = patch.meshStateStatus === 'PLAYING';
  } else if (patch && typeof patch.playing === 'boolean') {
    merged.playing = patch.playing;
    merged.meshStateStatus = patch.playing ? 'PLAYING' : 'PAUSED';
  } else if (merged.meshStateStatus === 'PLAYING' || merged.meshStateStatus === 'PAUSED') {
    merged.playing = merged.meshStateStatus === 'PLAYING';
  } else if (typeof merged.playing === 'boolean') {
    merged.meshStateStatus = merged.playing ? 'PLAYING' : 'PAUSED';
  }
  return merged;
}

export const canSelectVideo = () => {
  if (!state.mesh) return true;
  if (state.mesh.curated) return false;
  if (state.mesh.playMode !== 'leader') return true;
  return isLeader();
};

const CLOUD_UID_KEY = 'vortex_cloud_uid_v1';
let _lastCloudSyncAt = 0;
const _lastCloudProgPush = new Map();

export function purgeLegacySharedHistoryKeys() {
  try {
    for (const k of [
      'vortex_watch_history_v1',
      'vortex_favorites_v1',
      'kinox_music_recent_v3',
      'kinox_friends_v1',
      'vortex_recent_rooms',
      'vortex_room_snapshots_v1',
      'vortex_yt_account_v1',
    ]) {
      localStorage.removeItem(k);
    }
  } catch (e) { /* ignore */ }
}
purgeLegacySharedHistoryKeys();

export function isCloudAuthenticated() {
  const s = state.self;
  return Boolean(s && !s.isGuest && s.authToken && (s.uid || s.id || s.email));
}

export function getAccountStorageScope() {
  const s = state.self;
  if (s && !s.isGuest) {
    const raw = s.uid || s.id || s.email || s.handle || '';
    const clean = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.@-]/g, '').slice(0, 64);
    if (clean && !clean.startsWith('guest_')) return `acct_${clean}`;
  }
  const gId = String((s && (s.id || s.uid)) || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 48);
  if (gId) return `guest_${gId}`;
  try {
    let dev = localStorage.getItem(CLOUD_UID_KEY);
    if (!dev) {
      dev = `u_dev_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(CLOUD_UID_KEY, dev);
    }
    return `guest_${dev}`;
  } catch (e) {
    return 'guest_anon';
  }
}

const _historyKey = (scope = getAccountStorageScope()) => `vortex_watch_history_v2:${scope}`;
const _favKey = (scope = getAccountStorageScope()) => `vortex_favorites_v2:${scope}`;
const _musicKey = (scope = getAccountStorageScope()) => `vortex_music_recent_v4:${scope}`;
const _friendsKey = (scope = getAccountStorageScope()) => `vortex_friends_v2:${scope}`;
export const getRecentRoomsKey = () => `vortex_recent_rooms_v2:${getAccountStorageScope()}`;
export const getRoomSnapshotsKey = () => `vortex_room_snapshots_v2:${getAccountStorageScope()}`;
export const getYtAccountKey = () => `vortex_yt_account_v2:${getAccountStorageScope()}`;
const _ytPrefsKey = (scope = getAccountStorageScope()) => `vortex_yt_prefs_v2:${scope}`;
const _ytFeedCache = new Map();
export function invalidateYtFeedCache() { _ytFeedCache.clear(); }

export function resetCloudSyncState() {
  _lastCloudSyncAt = 0;
  _lastCloudProgPush.clear();
  _ytFeedCache.clear();
}

const _normTs = (v) => {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
};

const _authHdrs = () => {
  const s = state.self;
  const tok = s?.isGuest ? s?.guestToken : s?.authToken;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
};

function _boundProgressKey(raw) {
  const s = String(raw || '').trim();
  if (s.length <= 120) return s;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.slice(0, 96)}_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function getCloudUid() {
  const s = state.self;
  if (!isCloudAuthenticated()) return '';
  const raw = s.uid || s.id || s.email || s.handle || '';
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_.@-]/g, '').slice(0, 64);
}

const _normEpMap = (epObj) => {
  if (!epObj || typeof epObj !== 'object') return {};
  const out = {};
  for (const [ek, ev] of Object.entries(epObj)) {
    if (!ev || typeof ev !== 'object') continue;
    const sec = Math.max(0, Math.floor(Number(ev.currentTime ?? ev.position ?? ev.pos ?? 0)));
    const dur = Math.max(0, Math.floor(Number(ev.duration ?? ev.dur ?? 0)));
    const pct = Number(ev.percent ?? ev.pct ?? 0);
    out[ek] = { currentTime: sec, position: sec, pos: sec, duration: dur, dur, percent: pct, pct, updatedAt: _normTs(ev.updatedAt) };
  }
  return out;
};

export async function syncCloudUserMedia(force = false) {
  if (typeof fetch !== 'function' || !isCloudAuthenticated()) return { historyChanged: false, favsChanged: false, musicChanged: false };
  const now = Date.now();
  if (!force && now - _lastCloudSyncAt < 8000) return { historyChanged: false, favsChanged: false, musicChanged: false };
  _lastCloudSyncAt = now;
  const startScope = getAccountStorageScope();
  const startUid = getCloudUid();
  if (!startUid) return { historyChanged: false, favsChanged: false, musicChanged: false };
  let historyChanged = false;
  let favsChanged = false;
  let musicChanged = false;
  try {
    const reqOpts = { credentials: 'same-origin', cache: 'no-store', headers: _authHdrs() };
    const [pRes, wRes, mRes, yRes] = await Promise.allSettled([
      fetch('/api/user/progress', reqOpts).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/user/watchlist', reqOpts).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/user/music-history', reqOpts).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/user/yt-preferences', reqOpts).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (getAccountStorageScope() !== startScope || !isCloudAuthenticated()) {
      return { historyChanged: false, favsChanged: false, musicChanged: false };
    }
    const verifiedUid = String(pRes.value?.uid || wRes.value?.uid || mRes.value?.uid || '').trim().toLowerCase();
    if (verifiedUid && state.self && !state.self.isGuest && String(state.self.uid || '').toLowerCase() !== verifiedUid) {
      state.self.uid = verifiedUid;
      _activeAccountScope = getAccountStorageScope();
    }
    const effScope = getAccountStorageScope();
    const validP = pRes.status === 'fulfilled' && pRes.value?.authenticated === true && Array.isArray(pRes.value?.items) ? pRes.value.items : null;
    if (validP) {
      const cloudProg = validP;
      const cloudKeys = new Set();
      for (const c of cloudProg) {
        const mtype = c.mediaType === 'tv' ? 'tv' : 'movie';
        const ck = _boundProgressKey(c.key || (c.tmdbId ? `${mtype}:${c.tmdbId}` : c.title || ''));
        if (ck) cloudKeys.add(ck);
      }
      const localList = getWatchHistory();
      const byKey = new Map();
      for (const loc of localList) {
        const k = _boundProgressKey(loc.historyId || loc.key || '');
        if (!k) continue;
        if (!cloudKeys.has(k) && (loc.cloudSynced || (cloudProg.length === 0 && _normTs(loc.updatedAt) < now - 4000))) {
          historyChanged = true;
          continue;
        }
        byKey.set(k, loc);
      }
      for (const c of cloudProg) {
        const mtype = c.mediaType === 'tv' ? 'tv' : 'movie';
        const k = _boundProgressKey(c.key || (c.tmdbId ? `${mtype}:${c.tmdbId}` : c.title || ''));
        if (!k) continue;
        const cTs = _normTs(c.updatedAt);
        const prev = byKey.get(k);
        if (!prev || cTs >= _normTs(prev.updatedAt)) {
          const syncedPos = Math.max(0, Math.floor(Number(c.currentTime ?? c.position ?? prev?.currentTime ?? 0)));
          const mergedEpProg = {
            ..._normEpMap(prev?.epProgress),
            ..._normEpMap(c.epProgress),
          };
          const syncedPct = Number(c.percent ?? prev?.percent ?? 0);
          byKey.set(k, {
            ...(prev || {}),
            historyId: k,
            key: k,
            title: c.title || prev?.title || 'Sinema',
            originalTitle: c.originalTitle || prev?.originalTitle || '',
            seriesTitle: c.seriesTitle || prev?.seriesTitle || '',
            videoId: c.videoId || prev?.videoId || '',
            channel: c.channel || prev?.channel || '',
            channelId: c.channelId || prev?.channelId || '',
            channelAvatar: c.channelAvatar || prev?.channelAvatar || '',
            thumbnail: c.thumbnail || c.poster || c.backdrop || prev?.thumbnail || '',
            poster: c.poster || c.thumbnail || prev?.poster || prev?.thumbnail || '',
            backdrop: c.backdrop || prev?.backdrop || '',
            provider: c.provider || prev?.provider || 'cinema',
            catalogProvider: c.catalogProvider || c.provider || prev?.catalogProvider || 'cinema',
            streamType: c.streamType || prev?.streamType || '',
            tmdbId: c.tmdbId || prev?.tmdbId || '',
            imdbId: c.imdbId || prev?.imdbId || '',
            mediaType: mtype,
            season: Number(c.season || prev?.season || 1),
            episode: Number(c.episode || prev?.episode || 1),
            url: c.url || c.sourceUrl || prev?.url || '',
            officialUrl: c.sourceUrl || prev?.officialUrl || '',
            currentTime: syncedPos,
            position: syncedPos,
            duration: Math.max(0, Math.floor(Number(c.duration ?? prev?.duration ?? 0))),
            percent: syncedPct,
            completed: Boolean(c.completed || syncedPct >= 95),
            epProgress: mergedEpProg,
            year: c.year || prev?.year || '',
            cloudSynced: true,
            updatedAt: cTs || now,
          });
          historyChanged = true;
        }
      }
      if (historyChanged || effScope !== startScope) {
        const merged = [...byKey.values()].sort((a, b) => _normTs(b.updatedAt) - _normTs(a.updatedAt)).slice(0, 50);
        try { localStorage.setItem(_historyKey(effScope), JSON.stringify(merged)); } catch (e) { /* ignore */ }
      }
    }
    const validW = wRes.status === 'fulfilled' && wRes.value?.authenticated === true && Array.isArray(wRes.value?.items) ? wRes.value.items : null;
    if (validW && validW.length) {
      const cloudWlist = validW;
      const localFavs = getFavorites();
      const byFav = new Map();
      for (const f of localFavs) {
        const fk = String(f.key || (f.tmdbId ? `${f.mediaType || 'movie'}:${f.tmdbId}` : f.favId || ''));
        if (fk) byFav.set(fk, f);
      }
      for (const cw of cloudWlist) {
        const mtype = cw.mediaType === 'tv' ? 'tv' : 'movie';
        const fk = String(cw.key || (cw.tmdbId ? `${mtype}:${cw.tmdbId}` : cw.title || ''));
        if (!fk) continue;
        if (!byFav.has(fk)) {
          const favId = String(cw.tmdbId || fk.split(':')[1] || fk);
          byFav.set(fk, {
            favId,
            key: fk,
            tmdbId: cw.tmdbId || '',
            videoId: cw.videoId || '',
            imdbId: cw.imdbId || '',
            mediaType: mtype,
            title: cw.title || 'Yapım',
            originalTitle: cw.title || '',
            channel: cw.channel || '',
            channelId: cw.channelId || '',
            channelAvatar: cw.channelAvatar || '',
            duration: Number(cw.duration || 0) || 0,
            url: cw.url || cw.sourceUrl || '',
            year: cw.year || '',
            rating: Number(cw.rating || 8.0) || 8.0,
            thumbnail: cw.thumbnail || cw.poster || '',
            poster: cw.poster || cw.thumbnail || '',
            backdrop: cw.poster || cw.thumbnail || '',
            provider: cw.provider || 'cinema',
            addedAt: _normTs(cw.addedAt) || now,
          });
          favsChanged = true;
        }
      }
      if (favsChanged) {
        const mergedFavs = [...byFav.values()].sort((a, b) => _normTs(b.addedAt) - _normTs(a.addedAt)).slice(0, 60);
        try { localStorage.setItem(_favKey(effScope), JSON.stringify(mergedFavs)); } catch (e) { /* ignore */ }
      }
    }
    const validM = mRes.status === 'fulfilled' && mRes.value?.authenticated === true && Array.isArray(mRes.value?.items) ? mRes.value.items : null;
    if (validM && validM.length) {
      const localMus = (() => { try { return JSON.parse(localStorage.getItem(_musicKey(effScope)) || '[]'); } catch (e) { return []; } })();
      const byMus = new Map();
      for (const lm of (Array.isArray(localMus) ? localMus : [])) {
        const mk = `${(lm.artist || '').toLowerCase()}|${(lm.songTitle || '').toLowerCase()}`;
        if (mk !== '|') byMus.set(mk, lm);
      }
      for (const cm of validM) {
        const mk = `${(cm.artist || '').toLowerCase()}|${(cm.songTitle || '').toLowerCase()}`;
        if (mk === '|') continue;
        if (!byMus.has(mk)) {
          byMus.set(mk, cm);
          musicChanged = true;
        }
      }
      if (musicChanged) {
        const mergedMus = [...byMus.values()].sort((a, b) => _normTs(b.playedAt) - _normTs(a.playedAt)).slice(0, 20);
        try { localStorage.setItem(_musicKey(effScope), JSON.stringify(mergedMus)); } catch (e) { /* ignore */ }
      }
    }
    let ytPrefsChanged = false;
    const validY = yRes?.status === 'fulfilled' && yRes.value?.authenticated === true && yRes.value?.prefs ? yRes.value.prefs : null;
    if (validY) {
      const localY = getYtPrefs();
      if (Number(validY.updatedAt || 0) >= Number(localY.updatedAt || 0) || !(localY.subscriptions?.length || localY.likedVideos?.length)) {
        try {
          localStorage.setItem(_ytPrefsKey(effScope), JSON.stringify(validY));
          _ytFeedCache.clear();
          ytPrefsChanged = true;
        } catch (e) { /* ignore */ }
      }
    }
    if (historyChanged || favsChanged || musicChanged || ytPrefsChanged) set({ cloudSyncedAt: Date.now(), ytPrefsUpdated: Date.now() });
  } catch (e) { /* ignore */ }
  return { historyChanged, favsChanged, musicChanged };
}

export function getWatchHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(_historyKey()) || '[]');
    if (!Array.isArray(raw)) return [];
    let modified = false;
    const sanitized = raw.map((item) => {
      if (!item || typeof item !== 'object') return item;
      let itMod = false;
      let poster = typeof item.poster === 'string' ? item.poster.trim() : '';
      let thumb = typeof item.thumbnail === 'string' ? item.thumbnail.trim() : '';
      let bdrop = typeof item.backdrop === 'string' ? item.backdrop.trim() : '';
      const titleStr = String(item.title || '');

      // Fix Solo Leveling mismatched One Piece backdrop/poster
      if (/solo leveling/i.test(titleStr) && (bdrop.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG') || thumb.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG') || poster.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))) {
        poster = 'https://image.tmdb.org/t/p/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/xMNH87maNLt9n2bMDYeI6db5VFm.jpg';
        thumb = poster;
        itMod = true;
      }

      // Purge dark fallback svg / undefined strings so dynamic poster route takes over
      if (poster.includes('watchlivo-poster.svg') || poster === 'undefined' || poster === 'null') {
        poster = '';
        itMod = true;
      }
      if (thumb.includes('watchlivo-poster.svg') || thumb === 'undefined' || thumb === 'null') {
        thumb = '';
        itMod = true;
      }
      if (bdrop.includes('watchlivo-poster.svg') || bdrop === 'undefined' || bdrop === 'null') {
        bdrop = '';
        itMod = true;
      }

      // If all images are missing/blank, populate authentic dynamic poster route
      if (!poster && !thumb && !bdrop && titleStr) {
        const cleanT = titleStr.replace(/\s*(?:[—–-]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon\s*\d+\.\s*Bölüm).*$/i, '').split(' — ')[0].replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '').trim();
        const yr = item.year || (titleStr.match(/\((19\d{2}|20\d{2})\)/) || [])[1] || '';
        const mt = item.mediaType || (/sezon|bölüm|s\d+:b\d+/i.test(titleStr) ? 'tv' : 'movie');
        const qp = `tid=${encodeURIComponent(item.tmdbId || '')}&t=${encodeURIComponent(cleanT || titleStr)}&y=${encodeURIComponent(yr)}&mt=${encodeURIComponent(mt)}`;
        poster = `/api/rave/poster?${qp}`;
        thumb = poster;
        itMod = true;
      }

      if (itMod) {
        modified = true;
        return { ...item, poster, thumbnail: thumb || poster, backdrop: bdrop || poster };
      }
      return item;
    });
    if (modified) {
      try { localStorage.setItem(_historyKey(), JSON.stringify(sanitized)); } catch (e) { /* ignore */ }
    }
    return sanitized;
  } catch (e) {
    return [];
  }
}

export function getContinueWatching() {
  return getWatchHistory().filter((it) => it && !it.completed && Number(it.percent || 0) < 95);
}

export function clearWatchHistory() {
  try {
    localStorage.setItem(_historyKey(), '[]');
    set({});
  } catch (e) { /* ignore */ }
  if (typeof fetch === 'function' && isCloudAuthenticated()) {
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({ action: 'clear' }),
      keepalive: true,
    }).catch(() => {});
  }
}

export function removeWatchProgress(itemKey) {
  const k = _boundProgressKey(itemKey);
  if (!k) return;
  let removedCloudKey = k;
  try {
    const prev = getWatchHistory();
    const matched = prev.find((it) => String(it.historyId || it.key || '') === k || String(it.tmdbId || '') === k);
    if (matched) removedCloudKey = String(matched.historyId || matched.key || k);
    _lastCloudProgPush.delete(removedCloudKey);
    _lastCloudProgPush.delete(k);
    const next = prev.filter((it) => String(it.historyId || it.key || '') !== k && String(it.tmdbId || '') !== k);
    localStorage.setItem(_historyKey(), JSON.stringify(next));
    set({});
  } catch (e) { /* ignore */ }
  if (typeof fetch === 'function' && isCloudAuthenticated()) {
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({ action: 'remove', key: removedCloudKey }),
      keepalive: true,
    }).catch(() => {});
  }
}

export function findSavedProgress(mediaOrItem, season = null, episode = null) {
  if (!mediaOrItem) return null;
  const list = getWatchHistory();
  if (!list.length) return null;
  const mtype = (mediaOrItem.mediaType === 'tv' || mediaOrItem.type === 'SHOW') ? 'tv' : 'movie';
  const tid = String(mediaOrItem.tmdbId || (/^\d+$/.test(String(mediaOrItem.id || '')) ? mediaOrItem.id : '') || '').trim();
  const baseTitle = String(mediaOrItem.seriesTitle || mediaOrItem.originalTitle || mediaOrItem.title || '').split(' — ')[0].trim().toLowerCase();
  const hit = list.find((it) => {
    if (!it) return false;
    const itType = it.mediaType === 'tv' ? 'tv' : 'movie';
    if (tid && String(it.tmdbId || '').trim() === tid && itType === mtype) return true;
    if (mediaOrItem.videoId && it.videoId && String(it.videoId) === String(mediaOrItem.videoId)) return true;
    const itBase = String(it.seriesTitle || it.originalTitle || it.title || '').split(' — ')[0].trim().toLowerCase();
    return Boolean(!tid && baseTitle && baseTitle.length >= 2 && itBase === baseTitle && itType === mtype);
  });
  if (!hit) return null;
  const effSeason = season ?? mediaOrItem.season ?? null;
  const effEpisode = episode ?? mediaOrItem.episode ?? null;
  if (mtype === 'tv' && effSeason != null && effEpisode != null && Number(effSeason) > 0 && Number(effEpisode) > 0) {
    const sNum = Math.max(1, Number(effSeason) || 1);
    const eNum = Math.max(1, Number(effEpisode) || 1);
    if (Number(hit.season || 1) === sNum && Number(hit.episode || 1) === eNum) {
      return hit;
    }
    const epSaved = hit.epProgress && typeof hit.epProgress === 'object' ? hit.epProgress[`${sNum}:${eNum}`] : null;
    const epSec = Math.floor(Number(epSaved?.currentTime ?? epSaved?.position ?? epSaved?.pos ?? 0));
    if (epSaved && epSec > 3) {
      return {
        ...hit,
        season: sNum,
        episode: eNum,
        currentTime: epSec,
        position: epSec,
        duration: Math.max(0, Math.floor(Number(epSaved.duration || epSaved.dur || hit.duration || 0))),
        percent: Number(epSaved.percent ?? epSaved.pct ?? 0),
      };
    }
    return null;
  }
  return hit;
}

export function saveWatchProgress(media, currentTime, duration, opts = {}) {
  if (!media || (!media.url && !media.videoId && !media.tmdbId)) return;
  const rawDur = Math.floor(Number(duration || media.duration || 0));
  const rawTime = Number.isFinite(Number(currentTime)) && Number(currentTime) > 3 ? Math.floor(Number(currentTime)) : 0;
  const mtype = media.mediaType === 'tv' ? 'tv' : 'movie';
  const id = _boundProgressKey(media.tmdbId ? `${mtype}:${media.tmdbId}` : String(media.key || media.videoId || media.url || media.title || ''));
  const existingList = getWatchHistory();
  const prev = existingList.find((item) => String(item.historyId || item.key || '') === id);
  const sNum = Math.max(1, Number(media.season || 1));
  const eNum = Math.max(1, Number(media.episode || 1));
  const sameEp = Boolean(prev && (mtype !== 'tv' || (Number(prev.season || 1) === sNum && Number(prev.episode || 1) === eNum)));
  const prevEpObj = (!sameEp && mtype === 'tv' && prev?.epProgress) ? prev.epProgress[`${sNum}:${eNum}`] : null;
  const prevTime = sameEp
    ? Math.max(0, Math.floor(Number(prev.currentTime ?? prev.position ?? prev.pos ?? 0)))
    : Math.max(0, Math.floor(Number(prevEpObj?.currentTime ?? prevEpObj?.position ?? prevEpObj?.pos ?? 0)));
  const preserveExistingPos = !opts?.resetPosition && opts?.preserveExistingPos !== false;
  const resumeTime = (rawTime === 0 && prevTime > 3 && preserveExistingPos) ? prevTime : rawTime;
  const dur = rawDur > 0 ? rawDur : (sameEp ? Math.max(0, Math.floor(Number(prev?.duration || 0))) : Math.max(0, Math.floor(Number(prevEpObj?.duration || 0))));
  const prevEpPct = sameEp ? Number(prev?.percent || 8) : Number(prevEpObj?.percent || 8);
  const pct = dur > 30 ? Math.min(100, Math.round((resumeTime / dur) * 1000) / 10) : (resumeTime > 0 ? Math.max(8, prevEpPct) : 4);
  const completed = Boolean(opts?.completed || (dur > 180 && pct >= 95));
  const epMap = { ...(prev?.epProgress && typeof prev.epProgress === 'object' ? prev.epProgress : {}) };
  if (mtype === 'tv') {
    epMap[`${sNum}:${eNum}`] = {
      currentTime: resumeTime,
      duration: dur,
      percent: pct,
      updatedAt: Date.now(),
    };
  }
  const origTitle = media.originalTitle || prev?.originalTitle || '';
  const serTitle = mtype === 'tv' ? (media.seriesTitle || prev?.seriesTitle || String(media.title || prev?.title || '').split(' — ')[0].trim()) : '';
  const catProv = media.catalogProvider || media.provider || prev?.catalogProvider || 'cinema';
  const sType = media.streamType || prev?.streamType || '';
  try {
    const list = existingList.filter((item) => String(item.historyId || item.key || '') !== id);
      const effSavedPoster = media.poster || media.thumbnail || prev?.poster || prev?.thumbnail || (media.title ? `/api/rave/poster?tid=${encodeURIComponent(media.tmdbId || '')}&t=${encodeURIComponent(media.title || '')}&y=${encodeURIComponent(media.year || '')}&mt=${encodeURIComponent(mtype)}` : '');
      const effSavedBackdrop = media.backdrop || prev?.backdrop || effSavedPoster || '';
      list.unshift({
        historyId: id,
        key: id,
        title: media.title || prev?.title || 'Video',
        originalTitle: origTitle,
        seriesTitle: serTitle,
        channel: media.channel || media.artist || prev?.channel || '',
        channelId: media.channelId || prev?.channelId || '',
        channelAvatar: media.channelAvatar || prev?.channelAvatar || '',
        thumbnail: effSavedPoster,
        poster: effSavedPoster,
        backdrop: effSavedBackdrop,
      provider: catProv,
      catalogProvider: catProv,
      streamType: sType,
      tmdbId: media.tmdbId || prev?.tmdbId || '',
      imdbId: media.imdbId || prev?.imdbId || '',
      mediaType: mtype,
      season: sNum,
      episode: eNum,
      year: media.year || prev?.year || '',
      url: media.url || prev?.url || '',
      officialUrl: media.officialUrl || prev?.officialUrl || '',
      videoId: media.videoId || prev?.videoId || '',
      currentTime: resumeTime,
      position: resumeTime,
      duration: dur,
      percent: pct,
      completed,
      epProgress: epMap,
      updatedAt: Date.now(),
    });
    localStorage.setItem(_historyKey(), JSON.stringify(list.slice(0, 50)));
  } catch (e) { /* ignore */ }
  const now = Date.now();
  const prevPush = _lastCloudProgPush.get(id) || 0;
  if (typeof fetch === 'function' && isCloudAuthenticated() && (opts?.forceCloud || completed || now - prevPush >= 12000)) {
    _lastCloudProgPush.set(id, now);
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({
        action: 'upsert',
        key: id,
        tmdbId: String(media.tmdbId || ''),
        imdbId: String(media.imdbId || ''),
        mediaType: mtype,
        provider: catProv,
        catalogProvider: catProv,
        streamType: sType,
        videoId: String(media.videoId || prev?.videoId || ''),
        title: media.title || 'Video',
        originalTitle: origTitle,
        seriesTitle: serTitle,
        channel: String(media.channel || media.artist || prev?.channel || ''),
        channelId: String(media.channelId || prev?.channelId || ''),
        channelAvatar: String(media.channelAvatar || prev?.channelAvatar || ''),
        thumbnail: media.thumbnail || media.poster || '',
        poster: media.poster || media.thumbnail || '',
        backdrop: media.backdrop || '',
        year: String(media.year || ''),
        season: sNum,
        episode: eNum,
        position: resumeTime,
        currentTime: resumeTime,
        duration: dur,
        percent: pct,
        completed,
        epProgress: epMap,
        url: media.url || prev?.url || '',
        sourceUrl: media.officialUrl || prev?.officialUrl || media.url || '',
      }),
      keepalive: true,
    }).catch(() => {});
  }
}

export function getFavorites() {
  try { return JSON.parse(localStorage.getItem(_favKey()) || '[]'); } catch (e) { return []; }
}

export function isFavoriteMedia(item) {
  if (!item) return false;
  const mtype = item.mediaType === 'tv' || item.type === 'SHOW' ? 'tv' : 'movie';
  const id = String(item.tmdbId || item.id || item.videoId || item.url || item.title || '').trim();
  if (!id) return false;
  const ikey = String(item.key || (item.tmdbId || item.id ? `${mtype}:${item.tmdbId || item.id}` : `${mtype}:${id}`)).trim();
  return getFavorites().some((f) => (id && String(f.favId || '').trim() === id) || (ikey && String(f.key || '').trim() === ikey));
}

export function toggleFavoriteMedia(item) {
  if (!item) return false;
  const mtype = item.mediaType === 'tv' || item.type === 'SHOW' ? 'tv' : 'movie';
  const id = String(item.tmdbId || item.id || item.videoId || item.url || item.title || '').trim();
  if (!id) return false;
  const ikey = item.key || `${mtype}:${id}`;
  const list = getFavorites();
  const exists = list.some((f) => String(f.favId) === id || String(f.key || '') === ikey);
  const next = exists
    ? list.filter((f) => String(f.favId) !== id && String(f.key || '') !== ikey)
    : [{
        favId: id,
        key: ikey,
        tmdbId: item.tmdbId || item.id || '',
        videoId: item.videoId || '',
        channel: item.channel || '',
        channelId: item.channelId || '',
        channelAvatar: item.channelAvatar || '',
        duration: Number(item.duration || 0) || 0,
        url: item.url || '',
        thumbnail: item.thumbnail || item.poster || '',
        imdbId: item.imdbId || '',
        mediaType: mtype,
        title: item.title || 'Yapım',
        originalTitle: item.originalTitle || item.title || '',
        year: item.year || '',
        rating: item.rating || 8.0,
        poster: item.poster || item.thumbnail || '',
        backdrop: item.backdrop || item.poster || item.thumbnail || '',
        provider: item.catalogProvider || item.provider || 'netflix',
        addedAt: Date.now(),
      }, ...list].slice(0, 60);
  try { localStorage.setItem(_favKey(), JSON.stringify(next)); } catch (e) { /* ignore */ }
  if (typeof fetch === 'function' && isCloudAuthenticated()) {
    fetch('/api/user/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({
        action: exists ? 'remove' : 'add',
        key: ikey,
        tmdbId: String(item.tmdbId || item.id || ''),
        videoId: String(item.videoId || ''),
        imdbId: String(item.imdbId || ''),
        mediaType: mtype,
        provider: item.catalogProvider || item.provider || 'cinema',
        title: item.title || 'Yapım',
        channel: String(item.channel || ''),
        channelId: String(item.channelId || ''),
        channelAvatar: String(item.channelAvatar || ''),
        duration: Number(item.duration || 0) || 0,
        url: String(item.url || ''),
        thumbnail: item.thumbnail || item.poster || '',
        poster: item.poster || item.thumbnail || '',
        year: String(item.year || ''),
        rating: Number(item.rating || 8.0) || 8.0,
      }),
      keepalive: true,
    }).catch(() => {});
  }
  return !exists;
}

let _lastSocialSyncAt = 0;

function _socialUidParam() {
  const s = state.self;
  return String(s?.uid || s?.id || s?.handle || '').trim();
}

function _applySocialPayload(data) {
  if (!data || typeof data !== 'object') return;
  const prev = state.social || {};
  const friends = Array.isArray(data.friends) ? data.friends : (prev.friends || []);
  const requests = Array.isArray(data.requests) ? data.requests : (prev.requests || []);
  const outgoingRequests = Array.isArray(data.outgoingRequests) ? data.outgoingRequests : (prev.outgoingRequests || []);
  const blocked = Array.isArray(data.blocked) ? data.blocked : (prev.blocked || []);
  const privacy = (data.privacy && typeof data.privacy === 'object') ? { ...(prev.privacy || {}), ...data.privacy } : (prev.privacy || { presenceVisibility: 'friends', hideWatching: false, allowInvites: 'friends' });
  const onlineCount = Number.isFinite(Number(data.onlineCount)) ? Number(data.onlineCount) : friends.filter((f) => f?.online).length;
  const totalUnread = Number.isFinite(Number(data.totalUnread)) ? Number(data.totalUnread) : (prev.totalUnread || 0);
  try {
    localStorage.setItem(_friendsKey(), JSON.stringify(friends.map((f) => ({ ...f, id: f.uid || f.id }))));
  } catch (e) { /* ignore */ }
  set({
    social: {
      ok: true,
      friends,
      onlineCount,
      requests,
      requestCount: requests.length,
      outgoingRequests,
      blocked,
      totalUnread,
      privacy,
      threads: Array.isArray(data.threads) ? data.threads : (prev.threads || []),
      loaded: true,
    },
    friendsUpdated: Date.now(),
  });
}

export async function syncSocialState(force = false) {
  if (typeof fetch !== 'function') return state.social;
  const now = Date.now();
  if (!force && state.social?.loaded && now - _lastSocialSyncAt < 4500) return state.social;
  _lastSocialSyncAt = now;
  try {
    const s = state.self || {};
    const qs = new URLSearchParams({
      uid: _socialUidParam(),
      name: s.name || '',
      handle: s.handle || '',
      color: s.color || '',
      avatarUrl: s.avatarUrl || '',
    });
    const r = await fetch(`/api/rave/social/state?${qs}`, { credentials: 'same-origin', cache: 'no-store', headers: _authHdrs() });
    if (r.ok) {
      const data = await r.json();
      if (data?.ok) _applySocialPayload(data);
    }
  } catch (e) { /* ignore */ }
  return state.social;
}

export async function searchUsersServer(query) {
  const q = String(query || '').trim();
  if (!q || typeof fetch !== 'function') return [];
  try {
    const s = state.self || {};
    const qs = new URLSearchParams({
      q,
      uid: _socialUidParam(),
      name: s.name || '',
      handle: s.handle || '',
    });
    const r = await fetch(`/api/rave/social/search?${qs}`, { credentials: 'same-origin', cache: 'no-store', headers: _authHdrs() });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.users) ? data.users : [];
  } catch (e) {
    return [];
  }
}

export async function sendFriendRequest(targetIdent, extra = {}) {
  const s = state.self || {};
  const r = await fetch('/api/rave/social/friends', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ..._authHdrs() },
    body: JSON.stringify({
      action: 'request',
      uid: _socialUidParam(),
      fromName: s.name || 'İzleyici',
      fromHandle: s.handle || '',
      color: s.color || '#27DCC8',
      avatarUrl: s.avatarUrl || '',
      target: String(targetIdent || '').trim(),
      targetName: String(targetIdent || '').trim(),
      ...extra,
    }),
  });
  const data = await r.json().catch(() => ({ ok: false, error: 'Sunucu yanıtı alınamadı.' }));
  if (data?.ok) _applySocialPayload(data);
  return data;
}

export async function updateFriendAction(action, payload = {}) {
  const s = state.self || {};
  const r = await fetch('/api/rave/social/friends', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ..._authHdrs() },
    body: JSON.stringify({
      action,
      uid: _socialUidParam(),
      fromName: s.name || 'İzleyici',
      fromHandle: s.handle || '',
      color: s.color || '#27DCC8',
      avatarUrl: s.avatarUrl || '',
      ...payload,
    }),
  });
  const data = await r.json().catch(() => ({ ok: false }));
  if (data?.ok) _applySocialPayload(data);
  return data;
}

export async function sendRoomInvite(targetOrPayload = {}, actionArg = 'send') {
  const payload = (typeof targetOrPayload === 'string')
    ? { targetUid: targetOrPayload, action: actionArg || 'send' }
    : (targetOrPayload || {});
  const s = state.self || {};
  const m = state.mesh;
  const rid = payload.roomId || m?.id || state.route?.params?.id || '';
  let pwd = payload.password || state.route?.params?.pwd || '';
  let syncTok = payload.syncToken || m?.syncToken || '';
  try {
    if (!pwd && rid) pwd = sessionStorage.getItem('vortex_pwd_' + rid) || '';
    if (!syncTok && rid) syncTok = sessionStorage.getItem('vortex_st_' + rid) || '';
  } catch (_) {}
  const r = await fetch('/api/rave/social/invite', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ..._authHdrs() },
    body: JSON.stringify({
      action: payload.action || actionArg || 'send',
      uid: _socialUidParam(),
      fromName: s.name || 'İzleyici',
      roomId: rid,
      roomName: payload.roomName || m?.name || 'Watchlivo Odası',
      mediaTitle: payload.mediaTitle || m?.media?.title || '',
      mediaPoster: payload.mediaPoster || m?.media?.poster || m?.media?.backdrop || m?.media?.thumbnail || '',
      mediaProvider: payload.mediaProvider || m?.media?.provider || 'cinema',
      password: pwd,
      syncToken: syncTok,
      ...payload,
    }),
  });
  return r.json().catch(() => ({ ok: false }));
}

export async function pushPresenceHeartbeat(override = {}) {
  if (typeof fetch !== 'function' || !state.self) return null;
  const s = state.self;
  const m = state.mesh;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const hideWatchFlag = Boolean(s.hideWatching ?? state.social?.privacy?.hideWatching);
  const visMode = state.social?.privacy?.presenceVisibility || 'friends';
  const shareWatch = Boolean(m?.id && !hideWatchFlag && visMode !== 'nobody' && (m?.privacy || 'public') !== 'private' && !m?.hasPassword);
  const defState = override.state || (shareWatch ? 'watching' : (hidden ? 'idle' : 'online'));
  try {
    const r = await fetch('/api/rave/social/presence', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({
        uid: _socialUidParam(),
        name: s.name || 'İzleyici',
        handle: s.handle || '',
        color: s.color || '#27DCC8',
        avatarUrl: s.avatarUrl || '',
        state: defState,
        roomId: shareWatch ? (m?.id || '') : '',
        roomName: shareWatch ? (m?.name || '') : '',
        roomPrivacy: shareWatch ? (m?.privacy || 'public') : 'private',
        mediaTitle: shareWatch ? (m?.media?.title || '') : '',
        mediaPoster: shareWatch ? (m?.media?.poster || m?.media?.thumbnail || '') : '',
        mediaProvider: shareWatch ? (m?.media?.provider || '') : '',
        statusText: s.statusText || '',
        statusEmoji: s.statusEmoji || '🍿',
        hideWatching: Boolean(hideWatchFlag || !shareWatch),
        visibility: visMode,
        ...override,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data?.ok && state.social) {
      const rc = Number.isFinite(Number(data.requestCount)) ? Number(data.requestCount) : state.social.requestCount;
      const tu = Number.isFinite(Number(data.totalUnread)) ? Number(data.totalUnread) : state.social.totalUnread;
      if (rc !== state.social.requestCount || tu !== state.social.totalUnread) {
        set({ social: { ...state.social, requestCount: rc, totalUnread: tu } });
      }
    }
    return data;
  } catch (e) {
    return null;
  }
}

export function getFriends() {
  if (state.social?.loaded && Array.isArray(state.social.friends)) {
    return state.social.friends;
  }
  try { return JSON.parse(localStorage.getItem(_friendsKey()) || '[]'); } catch (e) { return []; }
}

const _foldTrStore = (s = '') => String(s || '')
  .replace(/[İIı]/g, 'i').replace(/[Şş]/g, 's').replace(/[Ğğ]/g, 'g')
  .replace(/[Üü]/g, 'u').replace(/[Öö]/g, 'o').replace(/[Çç]/g, 'c')
  .replace(/\u0307/g, '').toLowerCase();

export function isFriend(userOrName) {
  if (!userOrName) return false;
  const name = _foldTrStore(typeof userOrName === 'string' ? userOrName.trim() : String(userOrName.name || '').trim());
  const handle = typeof userOrName === 'object' ? _foldTrStore(String(userOrName.handle || '').trim().replace(/^@+/, '').replace(/#\d{2,6}$/, '')) : '';
  const rawId = typeof userOrName === 'object' ? String(userOrName.uid || (!/^h_/i.test(String(userOrName.id || '')) ? userOrName.id : '') || '').trim() : '';
  return getFriends().some((f) =>
    (rawId && (f.uid === rawId || f.id === rawId)) ||
    (handle && _foldTrStore(String(f.handle || '').replace(/^@+/, '').replace(/#\d{2,6}$/, '')) === handle) ||
    (name && !rawId && !handle && _foldTrStore(String(f.name || '')) === name)
  );
}

export function toggleFriend(user) {
  if (!user) return false;
  const name = (typeof user === 'string' ? user : (user.name || '')).trim().slice(0, 24);
  if (!name) return false;
  const id = (typeof user === 'object' && (user.id || user.uid)) ? String(user.id || user.uid) : `f_${name.toLowerCase()}`;
  const color = (typeof user === 'object' && user.color) || '#6366f1';
  const list = getFriends();
  const exists = isFriend(user);
  const next = exists
    ? list.filter((f) => f.id !== id && String(f.name || '').toLowerCase() !== name.toLowerCase())
    : [{ id, name, color, addedAt: Date.now() }, ...list].slice(0, 50);
  try { localStorage.setItem(_friendsKey(), JSON.stringify(next)); } catch (e) { /* ignore */ }
  set({ friendsUpdated: Date.now() });
  return !exists;
}

export function addFriendByName(name, color = '#6366f1') {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return false;
  if (isFriend(clean)) return true;
  return toggleFriend({ id: `f_${clean.toLowerCase()}`, name: clean, color });
}

// Account-scoped music history (v4)
const DEFAULT_MUSIC_RECENT = [];

export function getMusicHistory() {
  try {
    const rawStr = localStorage.getItem(_musicKey());
    if (rawStr === '[]') return [];
    const parsed = JSON.parse(rawStr || '[]');
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_MUSIC_RECENT;
  } catch (e) {
    return DEFAULT_MUSIC_RECENT;
  }
}

export function clearMusicHistory() {
  try {
    localStorage.setItem(_musicKey(), '[]');
    set({ musicHistoryUpdated: Date.now() });
  } catch (e) { /* ignore */ }
  if (typeof fetch === 'function' && isCloudAuthenticated()) {
    fetch('/api/user/music-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({ action: 'clear' }),
      keepalive: true,
    }).catch(() => {});
  }
}

export function saveMusicHistory(item) {
  if (!item || (!item.songTitle && !item.title)) return;
  try {
    const rawTitle = String(item.title || '').replace(/^🎵\s*/, '').trim();
    const artist = item.artist || (rawTitle.includes('—') ? rawTitle.split('—')[0].trim() : 'Sanatçı');
    const songTitle = item.songTitle || (rawTitle.includes('—') ? rawTitle.split('—')[1].trim() : rawTitle);
    const key = `${artist.toLowerCase()}|${songTitle.toLowerCase()}`;
    const list = getMusicHistory().filter((x) => `${(x.artist || '').toLowerCase()}|${(x.songTitle || '').toLowerCase()}` !== key);
    list.unshift({
      id: item.id || item.videoId || `m_${Date.now()}`,
      videoId: item.videoId || '',
      title: `${artist} — ${songTitle}`,
      songTitle,
      artist,
      genre: item.genre || item.categoryLabel || 'Müzik & Klip',
      duration: item.duration || 200,
      poster: item.poster || item.thumbnail || '/static/watchlivo-poster.svg',
      thumbnail: item.poster || item.thumbnail || '/static/watchlivo-poster.svg',
      audioPreviewUrl: item.audioPreviewUrl || '',
      isMusic: true,
      playedAt: Date.now(),
    });
    const entry = list[0];
    localStorage.setItem(_musicKey(), JSON.stringify(list.slice(0, 20)));
    set({ musicHistoryUpdated: Date.now() });
    if (typeof fetch === 'function' && isCloudAuthenticated() && entry) {
      fetch('/api/user/music-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._authHdrs() },
        body: JSON.stringify({ action: 'upsert', ...entry }),
        keepalive: true,
      }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}
// ---------------------------------------------------------------------------
// Account-Bound YouTube Personalization Graph & Feed Client (v91)
// ---------------------------------------------------------------------------
export function getYtPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(_ytPrefsKey()) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
        likedVideos: Array.isArray(raw.likedVideos) ? raw.likedVideos : [],
        searchHistory: Array.isArray(raw.searchHistory) ? raw.searchHistory : [],
        dismissedVideoIds: Array.isArray(raw.dismissedVideoIds) ? raw.dismissedVideoIds : [],
        blockedChannels: Array.isArray(raw.blockedChannels) ? raw.blockedChannels : [],
        topics: Array.isArray(raw.topics) ? raw.topics : [],
        googleConnected: Boolean(raw.googleConnected),
        googleEmail: String(raw.googleEmail || ''),
        googleChannelTitle: String(raw.googleChannelTitle || ''),
        updatedAt: Number(raw.updatedAt || 0),
      };
    }
  } catch (e) { /* ignore */ }
  return {
    subscriptions: [], likedVideos: [], searchHistory: [],
    dismissedVideoIds: [], blockedChannels: [], topics: [],
    googleConnected: false, googleEmail: '', googleChannelTitle: '', updatedAt: 0,
  };
}

function _saveLocalYtPrefs(nextPrefs) {
  const merged = { ...getYtPrefs(), ...nextPrefs, updatedAt: Date.now() };
  try { localStorage.setItem(_ytPrefsKey(), JSON.stringify(merged)); } catch (e) { /* ignore */ }
  _ytFeedCache.clear();
  set({ ytPrefsUpdated: Date.now() });
  return merged;
}

export async function pushYtPrefsAction(payload) {
  if (typeof fetch !== 'function' || !isCloudAuthenticated()) return null;
  try {
    const r = await fetch('/api/user/yt-preferences', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data?.ok && data.prefs) {
      try { localStorage.setItem(_ytPrefsKey(), JSON.stringify(data.prefs)); } catch (e) { /* ignore */ }
      _ytFeedCache.clear();
      set({ ytPrefsUpdated: Date.now() });
    }
    return data;
  } catch (e) {
    return null;
  }
}

export function isYtChannelFollowed(channelId, channelName) {
  const subs = getYtPrefs().subscriptions;
  const cid = String(channelId || '').trim();
  const cn = String(channelName || '').trim().toLowerCase();
  return subs.some((s) => (cid && String(s.channelId || '') === cid) || (cn && String(s.name || '').toLowerCase() === cn));
}

export function toggleYtChannelFollow(ch) {
  const cid = String(ch?.channelId || '').trim();
  const cname = String(ch?.name || ch?.channel || '').trim();
  if (!cid && !cname) return false;
  const cur = getYtPrefs();
  const existed = isYtChannelFollowed(cid, cname);
  const subs = cur.subscriptions.filter((s) => !((cid && String(s.channelId || '') === cid) || (cname && String(s.name || '').toLowerCase() === cname.toLowerCase())));
  if (!existed) {
    subs.unshift({
      channelId: cid,
      name: cname || cid,
      avatar: String(ch?.avatar || ch?.channelAvatar || ''),
      handle: String(ch?.handle || ''),
      addedAt: Date.now(),
    });
  }
  _saveLocalYtPrefs({ subscriptions: subs.slice(0, 60) });
  pushYtPrefsAction({ action: existed ? 'unfollow_channel' : 'follow_channel', channel: { channelId: cid, name: cname, avatar: ch?.avatar || ch?.channelAvatar || '' } });
  return !existed;
}

export function isYtVideoLiked(videoId) {
  const vid = String(videoId || '').trim();
  if (!vid) return false;
  return getYtPrefs().likedVideos.some((x) => String(x.videoId || '') === vid)
    || getFavorites().some((f) => String(f.videoId || f.favId || '') === vid);
}

export function toggleYtVideoLike(media) {
  const vid = String(media?.videoId || '').trim();
  if (!vid) return false;
  const cur = getYtPrefs();
  const existed = cur.likedVideos.some((x) => String(x.videoId || '') === vid);
  const likes = cur.likedVideos.filter((x) => String(x.videoId || '') !== vid);
  if (!existed) {
    likes.unshift({
      videoId: vid,
      title: String(media.title || 'YouTube Videosu'),
      channel: String(media.channel || 'YouTube'),
      channelId: String(media.channelId || ''),
      channelAvatar: String(media.channelAvatar || ''),
      thumbnail: String(media.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`),
      duration: Number(media.duration || 0) || 0,
      likedAt: Date.now(),
    });
  }
  _saveLocalYtPrefs({ likedVideos: likes.slice(0, 80) });
  pushYtPrefsAction({ action: existed ? 'unlike_video' : 'like_video', video: media });
  return !existed;
}

export function dismissYtVideo(videoId) {
  const vid = String(videoId || '').trim();
  if (!vid) return;
  const cur = getYtPrefs();
  const next = [vid, ...cur.dismissedVideoIds.filter((x) => x !== vid)].slice(0, 200);
  _saveLocalYtPrefs({ dismissedVideoIds: next });
  pushYtPrefsAction({ action: 'dismiss_video', videoId: vid });
}

export function undoDismissYtVideo(videoId) {
  const vid = String(videoId || '').trim();
  if (!vid) return;
  const cur = getYtPrefs();
  _saveLocalYtPrefs({ dismissedVideoIds: cur.dismissedVideoIds.filter((x) => x !== vid) });
  pushYtPrefsAction({ action: 'undo_dismiss', videoId: vid });
}

export function blockYtChannel(channelIdent) {
  const bch = String(channelIdent || '').trim();
  if (!bch) return;
  const cur = getYtPrefs();
  const next = [bch, ...cur.blockedChannels.filter((x) => x.toLowerCase() !== bch.toLowerCase())].slice(0, 80);
  _saveLocalYtPrefs({ blockedChannels: next });
  pushYtPrefsAction({ action: 'block_channel', channel: bch });
}

export function recordYtSearchQuery(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 2 || /^https?:\/\//i.test(q)) return;
  const cur = getYtPrefs();
  const next = [q, ...cur.searchHistory.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 25);
  _saveLocalYtPrefs({ searchHistory: next });
  pushYtPrefsAction({ action: 'add_search', query: q });
}

export async function fetchPersonalizedYtFeed(chip = 'all', forceRefresh = false) {
  const scope = getAccountStorageScope();
  const ck = `${scope}|${chip}`;
  const now = Date.now();
  if (!forceRefresh && _ytFeedCache.has(ck)) {
    const hit = _ytFeedCache.get(ck);
    if (now - hit.ts < 45000) return hit.data;
  }
  const prefs = getYtPrefs();
  const watchHist = getWatchHistory();
  const musicHist = getMusicHistory();
  const seedVideoIds = [];
  const seenV = new Set();
  for (const lv of prefs.likedVideos.slice(0, 4)) {
    if (lv?.videoId && !seenV.has(lv.videoId)) { seenV.add(lv.videoId); seedVideoIds.push({ videoId: lv.videoId, title: lv.title || '' }); }
  }
  for (const w of watchHist) {
    const vid = String(w?.videoId || '').trim();
    if (vid && vid.length === 11 && !seenV.has(vid)) { seenV.add(vid); seedVideoIds.push({ videoId: vid, title: w.title || '' }); }
    if (seedVideoIds.length >= 6) break;
  }
  for (const m of musicHist.slice(0, 3)) {
    const vid = String(m?.videoId || '').trim();
    if (vid && vid.length === 11 && !seenV.has(vid)) { seenV.add(vid); seedVideoIds.push({ videoId: vid, title: m.title || '' }); }
  }
  const seedQueries = [...prefs.searchHistory.slice(0, 4)];
  const r = await fetch('/api/rave/yt-personalized-feed', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ..._authHdrs() },
    body: JSON.stringify({
      chip,
      refresh: Boolean(forceRefresh),
      seedVideoIds: seedVideoIds.slice(0, 6),
      seedChannels: prefs.subscriptions.slice(0, 8),
      seedQueries: seedQueries.slice(0, 4),
      dismissedVideoIds: prefs.dismissedVideoIds.slice(0, 120),
      blockedChannels: prefs.blockedChannels.slice(0, 50),
    }),
  });
  const data = await r.json();
  if (data?.ok && Array.isArray(data.items) && data.items.length) {
    _ytFeedCache.set(ck, { ts: now, data });
  }
  return data;
}
