// Minimal reactive store (mirrors Rave's redux slices: self, view, mesh, selection, uiPrefs/theme schemas).
const listeners = new Set();
const UI_PREFS_KEY = 'vortex_ui_prefs_v1';

export const THEME_SCHEMAS = [
  { id: 'obsidian', name: 'Sinema İndigo',   desc: 'Watchlivo Studio koyu karbon & kraliyet indigosu', swatch: '#07080d', accent: '#6366f1' },
  { id: 'oled',     name: 'OLED Tam Siyah',  desc: 'Sıfır ışık sızıntılı #000000 sinema modu', swatch: '#000000', accent: '#38bdf8' },
  { id: 'crimson',  name: 'Kızıl Sinema',    desc: 'Netflix & Teleparty koyu kızıl ambiyans', swatch: '#0b0608', accent: '#f43f5e' },
  { id: 'midnight', name: 'Gece Safiri',     desc: 'Hyperbeam & IMAX gece mavisi tonları', swatch: '#070a10', accent: '#3b82f6' },
  { id: 'emerald',  name: 'Zümrüt Matris',   desc: 'Koyu zümrüt ve siber siyah kontrast', swatch: '#050b09', accent: '#6366f1' },
];

function loadUiPrefs() {
  const defaults = {
    theme: 'obsidian',
    ambient: 'low',
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
    return { ...defaults, ...raw };
  } catch (e) {
    return defaults;
  }
}

export function applyUiPrefs(prefs = state?.uiPrefs) {
  if (typeof document === 'undefined' || !prefs) return;
  const root = document.documentElement;
  root.dataset.theme = prefs.theme || 'obsidian';
  root.dataset.ambient = prefs.ambient || 'low';
  root.dataset.density = prefs.density || 'comfortable';
  root.dataset.cardStyle = prefs.cardStyle || 'glass';
  root.dataset.subSize = prefs.subSize || 'md';
  root.dataset.subColor = prefs.subColor || 'white';
  const sizeMap = { sm: '0.92rem', md: '1.15rem', lg: '1.42rem', xl: '1.72rem' };
  const colorMap = { white: '#ffffff', yellow: '#fde047', cyan: '#6366f1', box: '#ffffff' };
  const bgMap = { white: 'rgba(7, 8, 13, 0.72)', yellow: 'rgba(7, 8, 13, 0.78)', cyan: 'rgba(7, 8, 13, 0.82)', box: 'rgba(0, 0, 0, 0.92)' };
  root.style.setProperty('--sub-font-size', sizeMap[prefs.subSize] || sizeMap.md);
  root.style.setProperty('--sub-color', colorMap[prefs.subColor] || '#ffffff');
  root.style.setProperty('--sub-bg', bgMap[prefs.subColor] || 'rgba(7, 8, 13, 0.75)');
  if (typeof window !== 'undefined') {
    window.__kinoxVoiceDuckEnabled = prefs.voiceDucking !== false;
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

export const isHostOnly = () => {
  if (!state.mesh) return false;
  const myCid = state.clientId;
  const hostId = state.mesh.host_id;
  if (hostId && myCid && hostId === myCid) return true;
  if (!state.mesh.curated && state.self?.name && state.mesh.creator && state.self.name.trim().toLowerCase() === String(state.mesh.creator).trim().toLowerCase()) return true;
  const meP = Array.isArray(state.mesh.participants) ? state.mesh.participants.find((p) => p.id === myCid) : null;
  if (meP?.isHost) return true;
  try {
    const savedCreator = sessionStorage.getItem(`vortex_creator_${state.mesh.id}`);
    if (savedCreator && myCid && savedCreator === myCid) return true;
  } catch (e) { /* ignore */ }
  return false;
};
export const isLeader = () => {
  if (!state.mesh) return false;
  if (isHostOnly()) return true;
  if (state.mesh.playMode === 'cohost') return true;
  if (Array.isArray(state.mesh.co_hosts) && state.clientId && state.mesh.co_hosts.includes(state.clientId)) return true;
  const meCoP = Array.isArray(state.mesh.participants) ? state.mesh.participants.find((p) => p.id === state.clientId) : null;
  if (meCoP?.isCoHost) return true;
  return false;
};
export const canSelectVideo = () => {
  if (!state.mesh) return true;
  if (state.mesh.playMode !== 'leader') return true;
  return isLeader();
};

const HISTORY_KEY = 'vortex_watch_history_v1';
const FAV_KEY = 'vortex_favorites_v1';

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
}

export function saveWatchProgress(media, currentTime, duration) {
  if (!media || (!media.url && !media.videoId && !media.tmdbId)) return;
  const dur = Math.floor(Number(duration || media.duration || 0));
  const resumeTime = Number.isFinite(Number(currentTime)) && Number(currentTime) > 5 ? Math.floor(Number(currentTime)) : 0;
  try {
    const id = media.tmdbId ? `${media.mediaType || 'movie'}:${media.tmdbId}` : (media.videoId || media.url || media.title);
    const list = getWatchHistory().filter((item) => item.historyId !== id);
    list.unshift({
      historyId: id,
      title: media.title || 'Video',
      channel: media.channel || media.artist || '',
      thumbnail: media.thumbnail || '',
      provider: media.catalogProvider || media.provider || 'netflix',
      catalogProvider: media.catalogProvider || media.provider || 'netflix',
      tmdbId: media.tmdbId || '',
      imdbId: media.imdbId || '',
      mediaType: media.mediaType || 'movie',
      season: media.season || 1,
      episode: media.episode || 1,
      url: media.url || '',
      videoId: media.videoId || '',
      currentTime: resumeTime,
      duration: dur,
      updatedAt: Date.now(),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 40)));
  } catch (e) { /* ignore */ }
}

export function getFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
}

export function isFavoriteMedia(item) {
  if (!item) return false;
  const id = String(item.tmdbId || item.id || item.videoId || item.url || item.title || '');
  return getFavorites().some((f) => String(f.favId) === id);
}

export function toggleFavoriteMedia(item) {
  if (!item) return false;
  const id = String(item.tmdbId || item.id || item.videoId || item.url || item.title || '');
  if (!id) return false;
  const list = getFavorites();
  const exists = list.some((f) => String(f.favId) === id);
  const next = exists
    ? list.filter((f) => String(f.favId) !== id)
    : [{
        favId: id,
        tmdbId: item.tmdbId || item.id || '',
        imdbId: item.imdbId || '',
        mediaType: item.mediaType || 'movie',
        title: item.title || 'Yapım',
        originalTitle: item.originalTitle || item.title || '',
        year: item.year || '',
        rating: item.rating || 8.0,
        poster: item.poster || item.thumbnail || '',
        backdrop: item.backdrop || item.poster || item.thumbnail || '',
        provider: item.catalogProvider || item.provider || 'netflix',
      }, ...list].slice(0, 30);
  try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
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
