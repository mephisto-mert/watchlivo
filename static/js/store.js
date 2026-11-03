// Minimal reactive store (mirrors Rave's redux slices: self, view, mesh, selection, uiPrefs/theme schemas).
const listeners = new Set();
const UI_PREFS_KEY = 'vortex_ui_prefs_v1';

export const THEME_SCHEMAS = [
  { id: 'supabase',   name: 'Supabase Horizon', badge: '98p · Varsayılan', desc: '21st.dev Obsidyen & Zümrüt-Turkuaz stüdyo', swatch: 'linear-gradient(135deg, #06090e 0%, #0d1f1d 100%)', accent: '#27dcc8', accent2: '#10b981' },
  { id: 'vercel',     name: 'Vercel OLED',      badge: '97p · Saf Siyah',  desc: '21st.dev #000000 OLED & 1px gümüş kontrast', swatch: 'linear-gradient(135deg, #000000 0%, #111318 100%)', accent: '#38bdf8', accent2: '#e2e8f0' },
  { id: 'graphite',   name: 'Graphite Cinema',  badge: '95p · Göz Dostu',  desc: '21st.dev Mat antrasit uzun maraton sinema', swatch: 'linear-gradient(135deg, #0d0f14 0%, #181c26 100%)', accent: '#818cf8', accent2: '#6366f1' },
  { id: 't3chat',     name: 'T3 Chat Cosmic',   badge: '94p · Sosyal Oda', desc: '21st.dev Kozmik mor & neon eflatun parti', swatch: 'linear-gradient(135deg, #0c0916 0%, #1e1136 100%)', accent: '#c084fc', accent2: '#f472b6' },
  { id: 'indigo',     name: 'Indigo IMAX',      badge: '93p · 4K IMAX',    desc: '21st.dev Gece mavisi & Oceanic Glow', swatch: 'linear-gradient(135deg, #060b16 0%, #0f2042 100%)', accent: '#3b82f6', accent2: '#06b6d4' },
  { id: 'amber',      name: 'Amber VIP Luxury', badge: '92p · Altın Sinema', desc: '21st.dev Sıcak altın-kehribar VIP salon', swatch: 'linear-gradient(135deg, #0e0b07 0%, #271c0c 100%)', accent: '#f59e0b', accent2: '#fbbf24' },
  { id: 'catppuccin', name: 'Catppuccin Mocha', badge: '90p · Anime Gece', desc: '21st.dev Kadife mocha & pastel lavanta', swatch: 'linear-gradient(135deg, #11111b 0%, #1e1e2e 100%)', accent: '#b4befe', accent2: '#cba6f7' },
  { id: 'mint',       name: 'Mint Signal',      badge: '89p · Canlı Yayın', desc: '21st.dev Arduvaz & sinyal yeşili kontrast', swatch: 'linear-gradient(135deg, #071013 0%, #0d2629 100%)', accent: '#2dd4bf', accent2: '#14b8a6' },
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

export const state = {
  self: null,                         // { id, name, color, emoji }
  route: { name: 'home', params: {} },
  view: { left: 'Collapsed', right: 'Collapsed' },   // Rave mesh/view: Search, Vote, Friends, Participants, Globe, Settings, MeshList, Collapsed
  mesh: null,                         // serialized room from server
  clientId: null,
  connection: 'offline',              // offline | connecting | online
  selection: { provider: null, query: '' },
  chatVisible: true,
  unseenChat: 0,
  uiPrefs: loadUiPrefs(),
};

applyUiPrefs(state.uiPrefs);

export function set(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error('[store listener]', e); }
  }
}

export function setUiPref(patch) {
  const next = { ...state.uiPrefs, ...patch };
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  applyUiPrefs(next);
  set({ uiPrefs: next });
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
export const canSelectVideo = () => {
  if (!state.mesh) return true;
  if (state.mesh.curated) return false;
  if (state.mesh.playMode !== 'leader') return true;
  return isLeader();
};

const HISTORY_KEY = 'vortex_watch_history_v1';
const FAV_KEY = 'vortex_favorites_v1';
const CLOUD_UID_KEY = 'vortex_cloud_uid_v1';
let _lastCloudSyncAt = 0;
const _lastCloudProgPush = new Map();

const _normTs = (v) => {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
};

const _authHdrs = () => {
  const tok = state.self?.authToken;
  return (tok && !state.self?.isGuest) ? { Authorization: `Bearer ${tok}` } : {};
};

export function getCloudUid() {
  const s = state.self;
  const isRealAccount = Boolean(s && !s.isGuest && (s.email || s.authToken || (s.id && !String(s.id).startsWith('guest_'))));
  const raw = isRealAccount ? (s.uid || s.id || s.handle || s.email || '') : '';
  const clean = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_.@-]/g, '').slice(0, 64);
  if (clean) return clean;
  try {
    let dev = localStorage.getItem(CLOUD_UID_KEY);
    if (!dev) {
      dev = `u_dev_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(CLOUD_UID_KEY, dev);
    }
    return dev;
  } catch (e) {
    return 'guest_local';
  }
}

export async function syncCloudUserMedia(force = false) {
  if (typeof fetch !== 'function') return { historyChanged: false, favsChanged: false };
  const now = Date.now();
  if (!force && now - _lastCloudSyncAt < 8000) return { historyChanged: false, favsChanged: false };
  _lastCloudSyncAt = now;
  const uid = getCloudUid();
  let historyChanged = false;
  let favsChanged = false;
  try {
    const [pRes, wRes] = await Promise.allSettled([
      fetch(`/api/user/progress?uid=${encodeURIComponent(uid)}`, { credentials: 'same-origin', headers: _authHdrs() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/user/watchlist?uid=${encodeURIComponent(uid)}`, { credentials: 'same-origin', headers: _authHdrs() }).then((r) => (r.ok ? r.json() : null)),
    ]);
    const cloudProg = pRes.status === 'fulfilled' && Array.isArray(pRes.value?.items) ? pRes.value.items : null;
    if (cloudProg && cloudProg.length) {
      const localList = getWatchHistory();
      const byKey = new Map();
      for (const loc of localList) {
        const k = String(loc.historyId || loc.key || '');
        if (k) byKey.set(k, loc);
      }
      for (const c of cloudProg) {
        const mtype = c.mediaType === 'tv' ? 'tv' : 'movie';
        const k = String(c.key || (c.tmdbId ? `${mtype}:${c.tmdbId}` : c.title || ''));
        if (!k) continue;
        const cTs = _normTs(c.updatedAt);
        const prev = byKey.get(k);
        if (!prev || cTs >= _normTs(prev.updatedAt)) {
          const syncedPos = Math.max(0, Math.floor(Number(c.currentTime ?? c.position ?? prev?.currentTime ?? 0)));
          const mergedEpProg = {
            ...(prev?.epProgress && typeof prev.epProgress === 'object' ? prev.epProgress : {}),
            ...(c.epProgress && typeof c.epProgress === 'object' ? c.epProgress : {}),
          };
          byKey.set(k, {
            ...(prev || {}),
            historyId: k,
            key: k,
            title: c.title || prev?.title || 'Sinema',
            originalTitle: c.originalTitle || prev?.originalTitle || '',
            seriesTitle: c.seriesTitle || prev?.seriesTitle || '',
            thumbnail: c.poster || c.backdrop || prev?.thumbnail || '',
            poster: c.poster || prev?.poster || prev?.thumbnail || '',
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
            percent: Number(c.percent ?? prev?.percent ?? 0),
            epProgress: mergedEpProg,
            year: c.year || prev?.year || '',
            updatedAt: cTs || now,
          });
          historyChanged = true;
        }
      }
      if (historyChanged) {
        const merged = [...byKey.values()].sort((a, b) => _normTs(b.updatedAt) - _normTs(a.updatedAt)).slice(0, 40);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(merged)); } catch (e) { /* ignore */ }
      }
    }
    const cloudWlist = wRes.status === 'fulfilled' && Array.isArray(wRes.value?.items) ? wRes.value.items : null;
    if (cloudWlist && cloudWlist.length) {
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
            imdbId: cw.imdbId || '',
            mediaType: mtype,
            title: cw.title || 'Yapım',
            originalTitle: cw.title || '',
            year: cw.year || '',
            rating: Number(cw.rating || 8.0) || 8.0,
            poster: cw.poster || '',
            backdrop: cw.poster || '',
            provider: cw.provider || 'cinema',
            addedAt: _normTs(cw.addedAt) || now,
          });
          favsChanged = true;
        }
      }
      if (favsChanged) {
        const mergedFavs = [...byFav.values()].sort((a, b) => _normTs(b.addedAt) - _normTs(a.addedAt)).slice(0, 60);
        try { localStorage.setItem(FAV_KEY, JSON.stringify(mergedFavs)); } catch (e) { /* ignore */ }
      }
    }
    if (historyChanged || favsChanged) set({ cloudSyncedAt: Date.now() });
  } catch (e) { /* ignore */ }
  return { historyChanged, favsChanged };
}

export function getWatchHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

export function clearWatchHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, '[]');
    set({});
  } catch (e) { /* ignore */ }
  if (typeof fetch === 'function') {
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({ uid: getCloudUid(), action: 'clear' }),
      keepalive: true,
    }).catch(() => {});
  }
}

export function removeWatchProgress(itemKey) {
  const k = String(itemKey || '').trim();
  if (!k) return;
  try {
    const next = getWatchHistory().filter((it) => String(it.historyId || it.key || '') !== k && String(it.tmdbId || '') !== k);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    set({});
  } catch (e) { /* ignore */ }
  if (typeof fetch === 'function') {
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({ uid: getCloudUid(), action: 'remove', key: k }),
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
    const epSec = Math.floor(Number(epSaved?.currentTime ?? epSaved?.position ?? 0));
    if (epSaved && epSec > 3) {
      return {
        ...hit,
        season: sNum,
        episode: eNum,
        currentTime: epSec,
        position: epSec,
        duration: Math.max(0, Math.floor(Number(epSaved.duration || hit.duration || 0))),
        percent: Number(epSaved.percent || 0),
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
  const id = media.tmdbId ? `${mtype}:${media.tmdbId}` : String(media.key || media.videoId || media.url || media.title || '');
  const existingList = getWatchHistory();
  const prev = existingList.find((item) => String(item.historyId || item.key || '') === id);
  const sNum = Math.max(1, Number(media.season || 1));
  const eNum = Math.max(1, Number(media.episode || 1));
  const sameEp = Boolean(prev && (mtype !== 'tv' || (Number(prev.season || 1) === sNum && Number(prev.episode || 1) === eNum)));
  const prevEpObj = (!sameEp && mtype === 'tv' && prev?.epProgress) ? prev.epProgress[`${sNum}:${eNum}`] : null;
  const prevTime = sameEp
    ? Math.max(0, Math.floor(Number(prev.currentTime ?? prev.position ?? 0)))
    : Math.max(0, Math.floor(Number(prevEpObj?.currentTime ?? prevEpObj?.position ?? 0)));
  const preserveExistingPos = !opts?.resetPosition && opts?.preserveExistingPos !== false;
  const resumeTime = (rawTime === 0 && prevTime > 3 && preserveExistingPos) ? prevTime : rawTime;
  const dur = rawDur > 0 ? rawDur : (sameEp ? Math.max(0, Math.floor(Number(prev?.duration || 0))) : Math.max(0, Math.floor(Number(prevEpObj?.duration || 0))));
  const pct = dur > 30 ? Math.min(100, Math.round((resumeTime / dur) * 1000) / 10) : (resumeTime > 0 ? Math.max(8, Number(prev?.percent || 8)) : 4);
  if (mtype !== 'tv' && dur > 300 && pct >= 96 && resumeTime > 60) {
    removeWatchProgress(id);
    return;
  }
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
    list.unshift({
      historyId: id,
      key: id,
      title: media.title || prev?.title || 'Video',
      originalTitle: origTitle,
      seriesTitle: serTitle,
      channel: media.channel || media.artist || prev?.channel || '',
      thumbnail: media.poster || media.thumbnail || prev?.thumbnail || '',
      poster: media.poster || media.thumbnail || prev?.poster || '',
      backdrop: media.backdrop || prev?.backdrop || '',
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
      epProgress: epMap,
      updatedAt: Date.now(),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 40)));
  } catch (e) { /* ignore */ }
  const now = Date.now();
  const prevPush = _lastCloudProgPush.get(id) || 0;
  if (typeof fetch === 'function' && (opts?.forceCloud || now - prevPush >= 12000)) {
    _lastCloudProgPush.set(id, now);
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({
        uid: getCloudUid(),
        action: 'upsert',
        key: id,
        tmdbId: String(media.tmdbId || ''),
        imdbId: String(media.imdbId || ''),
        mediaType: mtype,
        provider: catProv,
        catalogProvider: catProv,
        streamType: sType,
        title: media.title || 'Video',
        originalTitle: origTitle,
        seriesTitle: serTitle,
        poster: media.poster || media.thumbnail || '',
        backdrop: media.backdrop || '',
        year: String(media.year || ''),
        season: sNum,
        episode: eNum,
        position: resumeTime,
        currentTime: resumeTime,
        duration: dur,
        percent: pct,
        epProgress: epMap,
        url: media.url || prev?.url || '',
        sourceUrl: media.officialUrl || prev?.officialUrl || media.url || '',
      }),
      keepalive: true,
    }).catch(() => {});
  }
}

export function getFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
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
  try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  if (typeof fetch === 'function') {
    fetch('/api/user/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHdrs() },
      body: JSON.stringify({
        uid: getCloudUid(),
        action: exists ? 'remove' : 'add',
        key: ikey,
        tmdbId: String(item.tmdbId || item.id || ''),
        imdbId: String(item.imdbId || ''),
        mediaType: mtype,
        provider: item.catalogProvider || item.provider || 'cinema',
        title: item.title || 'Yapım',
        poster: item.poster || item.thumbnail || '',
        year: String(item.year || ''),
        rating: Number(item.rating || 8.0) || 8.0,
      }),
      keepalive: true,
    }).catch(() => {});
  }
  return !exists;
}

const FRIENDS_KEY = 'kinox_friends_v1';

export function getFriends() {
  try { return JSON.parse(localStorage.getItem(FRIENDS_KEY) || '[]'); } catch (e) { return []; }
}

export function isFriend(userOrName) {
  if (!userOrName) return false;
  const name = typeof userOrName === 'string' ? userOrName.trim().toLowerCase() : String(userOrName.name || '').trim().toLowerCase();
  const id = typeof userOrName === 'object' ? String(userOrName.id || userOrName.uid || '') : '';
  return getFriends().some((f) => (id && f.id === id) || (name && String(f.name || '').toLowerCase() === name));
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
  try { localStorage.setItem(FRIENDS_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  set({ friendsUpdated: Date.now() });
  return !exists;
}

export function addFriendByName(name, color = '#6366f1') {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return false;
  if (isFriend(clean)) return true;
  return toggleFriend({ id: `f_${clean.toLowerCase()}`, name: clean, color });
}

const MUSIC_HIST_KEY = 'kinox_music_recent_v3';
const DEFAULT_MUSIC_RECENT = [
  { id: 'seed_1', title: 'Semicenk — Çıkmaz Bir Sokakta', songTitle: 'Çıkmaz Bir Sokakta', artist: 'Semicenk', genre: 'Slow & Pop', sourceBadge: '🟢 Spotify', duration: 163, poster: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/49/bf/7c/49bf7c3f-ba04-f425-2766-a0d310fb7182/cover.jpg/600x600bb.jpg', isMusic: true },
  { id: 'seed_2', title: 'Duman — Senden Daha Güzel', songTitle: 'Senden Daha Güzel', artist: 'Duman', genre: 'Türkçe Rock', sourceBadge: '🍎 Apple Music', duration: 238, poster: 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/e3/6a/03/e36a0347-7191-da04-7d53-32569e5904fd/884977122039.jpg/600x600bb.jpg', isMusic: true },
  { id: 'seed_3', title: 'The Weeknd — Blinding Lights', songTitle: 'Blinding Lights', artist: 'The Weeknd', genre: 'Global Hit', sourceBadge: '🟢 Spotify', duration: 200, poster: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/2b/b9/fe/2bb9fef5-d7f3-8345-25a9-db0e79fde4e4/20UMGIM11048.rgb.jpg/600x600bb.jpg', isMusic: true },
  { id: 'seed_4', title: 'Linkin Park — Numb', songTitle: 'Numb', artist: 'Linkin Park', genre: 'Rock Efsane', sourceBadge: '🟣 Deezer Hi-Fi', duration: 187, poster: 'https://is1-ssl.mzstatic.com/image/thumb/Features125/v4/dd/7d/72/dd7d7259-d27f-5b3e-ce64-9e304d2cb40f/dj.rxzrauer.jpg/600x600bb.jpg', isMusic: true },
  { id: 'seed_5', title: 'Queen — Bohemian Rhapsody', songTitle: 'Bohemian Rhapsody', artist: 'Queen', genre: 'Klasik Rock', sourceBadge: '🔴 YouTube Music', duration: 355, poster: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/62/2e/97/622e97c4-d620-2ae1-2a47-a32e16a01492/602567988847.jpg/600x600bb.jpg', isMusic: true },
];

export function getMusicHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MUSIC_HIST_KEY) || '[]');
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_MUSIC_RECENT;
  } catch (e) {
    return DEFAULT_MUSIC_RECENT;
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
    localStorage.setItem(MUSIC_HIST_KEY, JSON.stringify(list.slice(0, 20)));
    set({ musicHistoryUpdated: Date.now() });
  } catch (e) { /* ignore */ }
}
