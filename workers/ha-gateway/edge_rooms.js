export function buildCuratedLiveTvRooms() {
  const wrapUrl = (u) => ["ercdn.net", "daioncdn.net", "radyotvonline."].some((d) => u.includes(d))
    ? `/api/rave/stream?u=${encodeURIComponent(u)}&proxy_segs=1&ext=.m3u8`
    : u;
  const tvSpecs = [
    ["trt1", "TRT 1", "https://tv-trt1.medya.trt.com.tr/master.m3u8"],
    ["atv", "ATV", "https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/atv/atv.m3u8"],
    ["now-tv", "NOW", "https://uycyyuuzyh.turknet.ercdn.net/nphindgytw/nowtv/nowtv.m3u8"],
    ["star-tv", "Star TV", "https://dogus.daioncdn.net/startv/startv.m3u8?ce=3&app=a20ac41e-bdc3-4aa1-934d-26b484480ac9"],
    ["trt-spor", "TRT Spor", "https://tv-trtspor1.medya.trt.com.tr/master.m3u8"],
    ["a-spor", "A Spor", "https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/aspor/aspor.m3u8"],
    ["ntv", "NTV", "https://dogus.daioncdn.net/ntv/ntv.m3u8?ce=3&app=7c4bb802-0c41-409e-8cd2-799984995694"],
    ["haberturk", "Habertürk TV", "https://tv.ensonhaber.com/haberturk/haberturk.m3u8"],
    ["halk-tv", "Halk TV", "https://halktv-live.daioncdn.net/halktv/halktv.m3u8"],
    ["trt-haber", "TRT Haber", "https://tv-trthaber.medya.trt.com.tr/master.m3u8"],
    ["cnbc-e", "CNBC-e", "https://hnpsechtsc.turknet.ercdn.net/xpnvudnlsv/cnbc-e/cnbc-e.m3u8"],
    ["trt-belgesel", "TRT Belgesel", "https://tv-trtbelgesel.medya.trt.com.tr/master.m3u8"],
  ].map(([rid, name, u]) => {
    const playU = wrapUrl(u);
    return {
      id: `tv-${rid}`,
      name: `7/24 ${name} Canlı Yayın`,
      rawName: `7/24 ${name} Canlı Yayın`,
      creator: "Watchlivo Canlı TV",
      privacy: "public",
      playMode: "leader",
      curated: true,
      media: {
        provider: "hls",
        streamType: "hls",
        title: `📺 ${name} · Canlı Yayın`,
        url: playU,
        altUrls: playU !== u && u.startsWith("https://") ? [u] : [],
        channel: "Canlı TV · 7/24",
        thumbnail: "/static/watchlivo-poster.svg",
        poster: "/static/watchlivo-poster.svg",
        live: true,
        mediaType: "live",
        duration: 0,
      },
    };
  });
  const radioSpecs = [
    ["radyo-power-turk", "Power Türk", "https://live.powerapp.com.tr/powerturk/abr/powerturk/128/playlist.m3u8", "hls"],
    ["radyo-kral-fm", "Kral FM", "https://dygedge2.radyotvonline.net/kralfm/playlist.m3u8", "hls"],
    ["radyo-super-fm", "Süper FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/SUPER_FM_SC", "direct"],
    ["radyo-metro-fm", "Metro FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/METRO_FM_SC", "direct"],
    ["radyo-power-fm", "Power FM", "https://listen.powerapp.com.tr/powerdance/abr/powerdance/128/playlist.m3u8", "hls"],
    ["radyo-joy-turk", "Joy Türk", "https://playerservices.streamtheworld.com/api/livestream-redirect/JOY_TURK_SC", "direct"],
    ["radyo-slow-turk", "Slow Türk", "https://radyo1.radyo-dinle.tc/8062/stream", "direct"],
    ["radyo-best-fm", "Best FM", "https://ssldyg.radyotvonline.com/best/bestfm.stream/playlist.m3u8", "hls"],
    ["radyo-alem-fm", "Alem FM", "http://turkmedya.radyotvonline.com/turkmedya/alemfm.stream/playlist.m3u8", "hls"],
  ].map(([rid, name, u, kind, altU]) => {
    const playU = kind === "hls" ? wrapUrl(u) : u;
    const altList = [];
    if (playU !== u && u.startsWith("https://")) altList.push(u);
    if (altU && altU.startsWith("https://")) altList.push(wrapUrl(altU));
    return {
      id: rid,
      name: `7/24 ${name} Canlı Radyo`,
      rawName: `7/24 ${name} Canlı Radyo`,
      creator: "Watchlivo Canlı Radyo",
      privacy: "public",
      playMode: "leader",
      curated: true,
      media: {
        provider: kind,
        streamType: kind === "hls" ? "hls" : "mp3",
        title: `📻 ${name} · Canlı Radyo`,
        url: playU,
        altUrls: altList,
        channel: "Canlı Radyo · 7/24",
        thumbnail: "/static/watchlivo-poster.svg",
        poster: "/static/watchlivo-poster.svg",
        live: true,
        isMusic: true,
        mediaType: "music",
        artist: name,
        songTitle: "Canlı Yayın",
        musicPlatformLabel: "Canlı Radyo",
        duration: 0,
      },
    };
  });
  const cinemaClubRoom = {
    id: "cinema-club",
    name: "7/24 Sinema Kulübü",
    rawName: "7/24 Sinema Kulübü",
    creator: "Watchlivo Sinema Kulübü",
    privacy: "public",
    playMode: "leader",
    curated: true,
    media: {
      provider: "hls",
      streamType: "hls",
      title: "🍿 Watchlivo Sinema Kulübü · 7/24 Canlı",
      url: "https://tv-trt1.medya.trt.com.tr/master.m3u8",
      altUrls: ["https://tv-trtbelgesel.medya.trt.com.tr/master.m3u8"],
      channel: "Sinema Kulübü · 7/24",
      thumbnail: "/static/watchlivo-poster.svg",
      poster: "/static/watchlivo-poster.svg",
      live: true,
      mediaType: "live",
      duration: 0,
    },
  };
  return [...tvSpecs, ...radioSpecs, cinemaClubRoom];
}

function normalizeCuratedRoomId(roomId) {
  const raw = String(roomId || "").trim().toLowerCase();
  if (raw === "cinema_club" || raw === "sinema-kulubu" || raw === "sinema_kulubu" || raw === "cinema-club") {
    return "cinema-club";
  }
  return String(roomId || "");
}

export const DEFAULT_CURATED_LIVE_ROOMS = buildCuratedLiveTvRooms();
export const DEFAULT_CURATED_MAP = new Map(DEFAULT_CURATED_LIVE_ROOMS.map((rm) => [rm.id, rm]));

function nowSec() {
  return Date.now() / 1000;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let _ephemeralRoomSecret = "";
function getRoomSecret(env) {
  const s = String(env?.PROXY_SECRET || env?.VORTEX_SECRET || env?.ADMIN_SECRET || "").trim();
  if (s) return s;
  if (!_ephemeralRoomSecret) {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    _ephemeralRoomSecret = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return _ephemeralRoomSecret;
}

const _roomKeyCache = new Map();
async function hmacRoomHex(payload, env) {
  const secret = getRoomSecret(env);
  let key = _roomKeyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (_roomKeyCache.size >= 4) _roomKeyCache.clear();
    _roomKeyCache.set(secret, key);
  }
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str || "")));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeHexNonce(len = 8) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function setRoomPassword(rm, rawPwd) {
  const pwd = String(rawPwd || "");
  delete rm.password;
  if (!pwd) {
    rm.pwdSalt = "";
    rm.passwordHash = "";
    return;
  }
  rm.pwdSalt = makeHexNonce(8);
  rm.passwordHash = await sha256Hex(`wl_room_pwd_v1:${rm.pwdSalt}:${pwd}`);
}

async function verifyRoomPassword(rm, suppliedPwd) {
  if (rm.passwordHash && rm.pwdSalt) {
    const cand = await sha256Hex(`wl_room_pwd_v1:${rm.pwdSalt}:${String(suppliedPwd || "")}`);
    return timingSafeEqualStr(cand, rm.passwordHash);
  }
  if (rm.password) {
    const ok = timingSafeEqualStr(String(suppliedPwd || ""), String(rm.password));
    if (ok) await setRoomPassword(rm, suppliedPwd);
    return ok;
  }
  return true;
}

async function signRoomClientToken(roomId, cid, env) {
  const exp = Math.floor(nowSec()) + 86400;
  const payload = `${roomId}|${cid}|${exp}`;
  const sig = await hmacRoomHex(payload, env);
  return `${cid}.${exp}.${sig}`;
}

export async function verifyRoomClientToken(token, roomId, cid, env) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) return false;
  const [tokCid, expStr, sig] = parts;
  if (!tokCid || tokCid !== cid) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(nowSec())) return false;
  const expected = await hmacRoomHex(`${roomId}|${tokCid}|${expStr}`, env);
  return timingSafeEqualStr(sig, expected);
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64DecodeUtf8(b64) {
  const norm = String(b64 || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function signSyncToken(syncObj, env) {
  try {
    const b64 = b64EncodeUtf8(JSON.stringify(syncObj));
    const sig = await hmacRoomHex(`sync|${b64}`, env);
    return `${b64}.${sig}`;
  } catch {
    return "";
  }
}

async function tryRestoreSyncToken(roomId, syncToken, env) {
  if (!syncToken || typeof syncToken !== "string" || !syncToken.includes(".")) return null;
  try {
    const dot = syncToken.lastIndexOf(".");
    const b64 = syncToken.slice(0, dot);
    const sig = syncToken.slice(dot + 1);
    const expected = await hmacRoomHex(`sync|${b64}`, env);
    if (!timingSafeEqualStr(sig, expected)) return null;
    const obj = JSON.parse(b64DecodeUtf8(b64));
    if (obj && typeof obj === "object" && (!obj.id || obj.id === roomId)) {
      const rm = makeRoomSkeleton(roomId, obj);
      if (obj.media) rm.media = { ...rm.media, ...obj.media };
      if (!rm.curated) {
        if (obj.host_id) rm.host_id = obj.host_id;
        if (obj.creatorCid) rm.creatorCid = obj.creatorCid;
        if (Array.isArray(obj.co_hosts)) rm.co_hosts = Array.from(new Set(obj.co_hosts.filter(Boolean)));
        if (obj.hostTransferred) rm.hostTransferred = true;
      }
      return rm;
    }
  } catch {}
  return null;
}

function generateOpaqueRoomId() {
  return `wl-${makeHexNonce(5)}`;
}

function buildFreshMedia(initMedia = {}, creator = "Misafir", t = nowSec()) {
  const m = initMedia && typeof initMedia === "object" ? initMedia : {};
  const pos = Math.max(0, Number(m.currentTime || 0) || 0);
  const playing = m.playing !== undefined ? Boolean(m.playing) : Boolean(m.url || m.videoId || m.embedUrl);
  const rate = Math.min(4, Math.max(0.25, Number(m.rate ?? m.meshStatePlaybackSpeed ?? 1) || 1));
  return {
    provider: m.provider || (m.url ? "hls" : ""),
    videoId: m.videoId || "",
    tmdbId: String(m.tmdbId || ""),
    mediaType: m.mediaType || "movie",
    season: Number(m.season || 0),
    episode: Number(m.episode || 0),
    url: m.url || "",
    embedUrl: m.embedUrl || "",
    streamType: m.streamType || (m.embedUrl && !m.url ? "embed" : "hls"),
    title: m.title || "",
    seriesTitle: m.seriesTitle || "",
    originalTitle: m.originalTitle || "",
    catalogProvider: m.catalogProvider || "",
    poster: m.poster || m.thumbnail || "",
    backdrop: m.backdrop || m.poster || m.thumbnail || "",
    thumbnail: m.thumbnail || m.poster || "",
    altUrls: Array.isArray(m.altUrls) ? m.altUrls : [],
    servers: Array.isArray(m.servers) ? m.servers : [],
    audioTracks: Array.isArray(m.audioTracks) ? m.audioTracks : [],
    subtitleTracks: Array.isArray(m.subtitleTracks) ? m.subtitleTracks : [],
    duration: Number(m.duration || 0),
    live: Boolean(m.live),
    isMusic: Boolean(m.isMusic),
    channel: m.channel || "",
    artist: m.artist || "",
    songTitle: m.songTitle || "",
    musicPlatformLabel: m.musicPlatformLabel || "",
    intro: m.intro ?? null,
    imdbId: String(m.imdbId || ""),
    origLang: String(m.origLang || ""),
    year: String(m.year || ""),
    musicMode: m.musicMode || "",
    playing,
    currentTime: pos,
    rate,
    updatedAt: t,
    lastActionBy: creator,
    meshStateStatus: playing ? "PLAYING" : "PAUSED",
    meshStatePosition: pos,
    meshStateTime: t,
    meshStatePlaybackSpeed: rate,
  };
}

function makeRoomSkeleton(roomId, opts = {}) {
  const t = nowSec();
  const isCur = Boolean(opts.curated);
  const cid = isCur ? "kinox_bot" : (opts.clientId || `h_${makeHexNonce(4)}`);
  const creator = String(opts.creator || opts.username || (isCur ? "Watchlivo Canlı TV" : "Misafir")).slice(0, 40);
  const rmName = String(opts.name || "Watchlivo Sinema Odası").slice(0, 64);
  const validPlayModes = ["leader", "cohost", "autoplay", "quickplay", "vote", "free"];
  const playMode = isCur
    ? (opts.playMode || "leader")
    : (validPlayModes.includes(opts.playMode) ? opts.playMode : "leader");
  const rawVoip = opts.voipMode === "on" ? "all" : opts.voipMode;
  const voipMode = isCur
    ? "all"
    : (["all", "stage", "leader", "off"].includes(rawVoip) ? rawVoip : "all");
  const hideWatching = isCur ? false : Boolean(opts.hideWatching);
  const hideLocation = isCur ? false : Boolean(opts.hideLocation);
  const hideFriends = isCur ? false : Boolean(opts.hideFriends);
  const creatorUid = isCur ? "" : String(opts.creatorUid || opts.creatorId || opts.uid || "").trim().slice(0, 64);
  const invitedUids = isCur || !Array.isArray(opts.invitedUids)
    ? []
    : Array.from(new Set(opts.invitedUids.map((x) => String(x || "").trim().slice(0, 64)).filter(Boolean))).slice(0, 100);
  return {
    id: roomId,
    name: rmName,
    rawName: String(opts.rawName || rmName).slice(0, 64),
    customName: Boolean(opts.customName),
    privacy: isCur ? "public" : (["public", "friends", "private"].includes(opts.privacy) ? opts.privacy : "public"),
    pwdSalt: "",
    passwordHash: "",
    playMode,
    voipMode,
    isMature: Boolean(opts.isMature),
    locked: isCur ? false : Boolean(opts.locked),
    hideWatching,
    hideLocation,
    hideFriends,
    friendsPreview: isCur ? [] : sanitizeFriendsPreview(opts.friendsPreview, false),
    creator,
    creatorCid: cid,
    creatorUid,
    hostTransferred: Boolean(opts.hostTransferred),
    host_id: cid,
    co_hosts: isCur ? [] : [cid],
    stage_speakers: [],
    invitedUids,
    rev: 1,
    curated: isCur,
    createdFromApi: Boolean(opts.createdFromApi),
    media: buildFreshMedia(opts.media, creator, t),
    queue: [],
    voteEndsAt: 0,
    participants: {},
    kicked: Array.isArray(opts.kicked) ? opts.kicked.slice(-100) : [],
    kickedUids: Array.isArray(opts.kickedUids) ? opts.kickedUids.slice(-100) : [],
    bannedCids: Array.isArray(opts.bannedCids) ? opts.bannedCids.slice(-100) : [],
    bannedUids: Array.isArray(opts.bannedUids) ? opts.bannedUids.slice(-100) : [],
    skip_votes: [],
    polls: [],
    pollVotes: {},
    chat: [],
    chatClearedAt: Number(opts.chatClearedAt || 0),
    events: [],
    signals: [],
    updatedAt: t,
  };
}

function getCuratedSeed(roomId, curatedMap = null, explicitSeed = null) {
  const normId = normalizeCuratedRoomId(roomId);
  if (explicitSeed && typeof explicitSeed === "object" && (explicitSeed.id === roomId || explicitSeed.id === normId) && explicitSeed.curated) {
    return explicitSeed;
  }
  return curatedMap?.get(roomId) || curatedMap?.get(normId) || DEFAULT_CURATED_MAP.get(roomId) || DEFAULT_CURATED_MAP.get(normId) || null;
}

function reconcileCuratedRoom(rm, seed) {
  if (!rm || !seed || !seed.curated) return false;
  let changed = false;
  const targetPrivacy = seed.privacy || "public";
  const targetPlayMode = seed.playMode || "leader";
  if (rm.curated !== true) { rm.curated = true; changed = true; }
  if (rm.name !== seed.name) { rm.name = seed.name; changed = true; }
  if (rm.rawName !== (seed.rawName || seed.name)) { rm.rawName = seed.rawName || seed.name; changed = true; }
  if (rm.creator !== seed.creator) { rm.creator = seed.creator; changed = true; }
  if (rm.privacy !== targetPrivacy) { rm.privacy = targetPrivacy; changed = true; }
  if (rm.playMode !== targetPlayMode) { rm.playMode = targetPlayMode; changed = true; }
  if (rm.creatorCid !== "kinox_bot") { rm.creatorCid = "kinox_bot"; changed = true; }
  if (rm.host_id !== "kinox_bot") { rm.host_id = "kinox_bot"; changed = true; }
  if (Array.isArray(rm.co_hosts) && rm.co_hosts.length > 0) { rm.co_hosts = []; changed = true; }
  if (rm.password || rm.passwordHash || rm.pwdSalt) {
    delete rm.password;
    rm.passwordHash = "";
    rm.pwdSalt = "";
    changed = true;
  }
  const sm = seed.media || {};
  if (
    !rm.media?.url ||
    rm.media.url !== sm.url ||
    rm.media.title !== sm.title ||
    !rm.media.live ||
    Boolean(rm.media.isMusic) !== Boolean(sm.isMusic)
  ) {
    rm.media = buildFreshMedia(sm, seed.creator, nowSec());
    changed = true;
  }
  return changed;
}

function parseTrustedSeedHeader(request) {
  try {
    const raw = request.headers.get("x-watchlivo-curated-seed");
    if (!raw) return null;
    const obj = JSON.parse(b64DecodeUtf8(raw));
    if (obj && typeof obj === "object" && obj.curated && obj.id) return obj;
  } catch {}
  return null;
}

function buildMediaOut(rm) {
  const t = nowSec();
  const m = rm.media || {};
  const rate = Math.min(4, Math.max(0.25, Number(m.rate ?? m.meshStatePlaybackSpeed ?? 1) || 1));
  const elapsed = Math.max(0, t - (Number(m.updatedAt) || t));
  const livePos = m.playing ? (Number(m.currentTime) || 0) + elapsed * rate : (Number(m.currentTime) || 0);
  return {
    ...m,
    rate,
    meshStatePlaybackSpeed: rate,
    liveTime: livePos,
    elapsedSinceUpdate: elapsed,
    serverNow: t,
    meshStateStatus: m.playing ? "PLAYING" : "PAUSED",
    meshStatePosition: livePos,
    meshStateTime: t,
  };
}

function pruneStaleParticipants(rm, activeCids = null) {
  const tNow = nowSec();
  const cutoff = tNow - 45;
  let pruned = false;
  const prunedCids = new Set();
  for (const [pid, p] of Object.entries(rm.participants || {})) {
    if (activeCids && activeCids.has(pid)) {
      p.lastSeen = tNow;
      continue;
    }
    if ((p.lastSeen || 0) < cutoff) {
      delete rm.participants[pid];
      prunedCids.add(pid);
      pruned = true;
    }
  }
  if (prunedCids.size && Array.isArray(rm.stage_speakers) && rm.stage_speakers.length) {
    const nextSpeakers = rm.stage_speakers.filter((x) => !prunedCids.has(x));
    if (nextSpeakers.length !== rm.stage_speakers.length) {
      rm.stage_speakers = nextSpeakers;
      pruned = true;
    }
  }
  const remIds = Object.keys(rm.participants || {});
  if (!rm.curated && remIds.length && (!rm.host_id || !rm.participants[rm.host_id])) {
    rm.host_id = remIds[0];
    pruned = true;
  }
  return pruned;
}

function isBotParticipant(pid, p) {
  if (!p || typeof p !== "object") return true;
  const id = String(pid || p.id || "");
  return Boolean(p.isBot || p.transport === "bot" || id === "kinox_bot" || id.startsWith("bot_"));
}

async function serializeEdgeRoom(rm, viewerCid = "", env = null) {
  const t = nowSec();
  const isCur = Boolean(rm.curated);
  const stageSet = new Set(Array.isArray(rm.stage_speakers) ? rm.stage_speakers : []);
  const parts = [];
  for (const [pid, p] of Object.entries(rm.participants || {})) {
    parts.push({
      ...p,
      country: p.hideLocation ? "" : (p.country || ""),
      friendsPreview: p.hideFriends ? [] : (Array.isArray(p.friendsPreview) ? p.friendsPreview : []),
      muted: p.muted !== undefined ? Boolean(p.muted) : true,
      speaking: Boolean(p.speaking),
      cam: Boolean(p.cam),
      screen: Boolean(p.screen),
      inCall: Boolean(p.inCall),
      deafened: Boolean(p.deafened),
      handRaised: Boolean(p.handRaised),
      isHost: !isCur && pid === rm.host_id,
      isCoHost: !isCur && (rm.co_hosts || []).includes(pid),
      isCreator: !isCur && pid === rm.creatorCid,
      isStageSpeaker: !isCur && stageSet.has(pid),
    });
  }
  const mediaOut = buildMediaOut(rm);
  const syncObj = {
    id: rm.id,
    name: rm.name,
    creator: rm.creator,
    curated: isCur,
    privacy: rm.privacy,
    playMode: rm.playMode,
    voipMode: rm.voipMode || "all",
    creatorUid: rm.creatorUid || "",
    locked: Boolean(!isCur && rm.locked),
    hideWatching: Boolean(!isCur && rm.hideWatching),
    hideLocation: Boolean(!isCur && rm.hideLocation),
    hideFriends: Boolean(!isCur && rm.hideFriends),
    hostTransferred: Boolean(!isCur && rm.hostTransferred),
    host_id: rm.host_id,
    creatorCid: rm.creatorCid,
    co_hosts: isCur ? [] : (Array.isArray(rm.co_hosts) ? rm.co_hosts : []),
    rev: rm.rev,
    media: rm.media,
  };
  const syncToken = await signSyncToken(syncObj, env);
  const isViewerCreator = Boolean(!isCur && viewerCid && viewerCid === rm.creatorCid);
  const isViewerHost = Boolean(!isCur && viewerCid && viewerCid === rm.host_id);
  const filteredSignals = (rm.signals || [])
    .filter((s) => s && (t - Number(s.ts || 0)) < 25 && viewerCid && (s.targetId === viewerCid || s.fromId === viewerCid))
    .slice(-120);
  const humanCount = Object.entries(rm.participants || {}).filter(([pid, p]) => !isBotParticipant(pid, p)).length;
  const skipNeeded = Math.max(1, Math.floor(humanCount / 2) + 1);
  const skipVotes = Array.isArray(rm.skip_votes) ? rm.skip_votes : [];
  return {
    id: rm.id,
    name: rm.name,
    rawName: rm.rawName || rm.name,
    customName: Boolean(rm.customName),
    privacy: rm.privacy || "public",
    playMode: rm.playMode || "leader",
    voipMode: rm.voipMode || "all",
    isMature: Boolean(rm.isMature),
    locked: Boolean(!isCur && rm.locked),
    hideWatching: Boolean(!isCur && rm.hideWatching),
    hideLocation: Boolean(!isCur && rm.hideLocation),
    hideFriends: Boolean(!isCur && rm.hideFriends),
    friendsPreview: (isCur || rm.hideFriends) ? [] : (Array.isArray(rm.friendsPreview) ? rm.friendsPreview : []),
    hasPassword: Boolean(!isCur && (rm.passwordHash || rm.password)),
    creator: rm.creator || "Misafir",
    creatorCid: isViewerCreator ? rm.creatorCid : "",
    host_id: isViewerHost ? rm.host_id : "",
    co_hosts: isCur ? [] : (rm.co_hosts || []).filter((id) => id === viewerCid),
    isHost: isViewerHost,
    isCreator: isViewerCreator,
    stage_speakers: isCur ? [] : (Array.isArray(rm.stage_speakers) ? rm.stage_speakers : []),
    curated: isCur,
    rev: rm.rev || 1,
    media: mediaOut,
    queue: Array.isArray(rm.queue) ? rm.queue : [],
    voteEndsAt: Number(rm.voteEndsAt || 0),
    skip_votes: skipVotes,
    skipVotes,
    skipNeeded,
    polls: Array.isArray(rm.polls) ? rm.polls : [],
    pollVotes: rm.pollVotes || {},
    participants: parts,
    participantCount: parts.length,
    chat: (rm.chat || []).slice(-60),
    chatClearedAt: Number(rm.chatClearedAt || 0),
    events: (rm.events || []).slice(-50),
    signals: filteredSignals,
    serverNow: t,
    syncToken,
  };
}

function serializePublicSummary(roomOut) {
  const maskMediaUrls = Boolean(!roomOut.curated && (roomOut.hasPassword || roomOut.privacy !== "public"));
  return {
    id: roomOut.id,
    name: roomOut.name,
    rawName: roomOut.rawName,
    privacy: roomOut.privacy,
    playMode: roomOut.playMode,
    isMature: roomOut.isMature,
    hasPassword: roomOut.hasPassword,
    creator: roomOut.creator,
    curated: roomOut.curated,
    participantCount: roomOut.participantCount,
    count: roomOut.participantCount,
    updatedAt: nowSec(),
    media: roomOut.media ? {
      title: roomOut.media.title || "",
      poster: roomOut.media.poster || "",
      thumbnail: roomOut.media.thumbnail || "",
      mediaType: roomOut.media.mediaType || "movie",
      isMusic: Boolean(roomOut.media.isMusic),
      url: maskMediaUrls ? "" : (roomOut.media.url || ""),
      streamType: maskMediaUrls ? "" : (roomOut.media.streamType || ""),
      altUrls: maskMediaUrls ? [] : (Array.isArray(roomOut.media.altUrls) ? roomOut.media.altUrls : []),
      playing: Boolean(roomOut.media.playing),
      live: Boolean(roomOut.media.live),
    } : {},
  };
}

function isHostOrCreator(rm, cid) {
  return Boolean(cid && (cid === rm.host_id || cid === rm.creatorCid));
}

function isPrivilegedInRoom(rm, cid) {
  return isHostOrCreator(rm, cid) || (rm.co_hosts || []).includes(cid);
}

function isCidOccupiedOrReferenced(rm, cid) {
  if (!rm || !cid) return false;
  return Boolean(
    cid === rm.creatorCid ||
    cid === rm.host_id ||
    (rm.co_hosts || []).includes(cid) ||
    rm.participants?.[cid] ||
    (rm.stage_speakers || []).includes(cid) ||
    (rm.chat || []).some((m) => m?.cid === cid) ||
    (rm.queue || []).some((q) => q?.addedByCid === cid)
  );
}

function safeDecodeURIComponent(v) {
  let cur = String(v || "");
  for (let pass = 0; pass < 2; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      next = cur.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
        try {
          return decodeURIComponent(seq);
        } catch {
          return seq.replace(/%[0-9a-fA-F]{2}/g, (triplet) => {
            try {
              return decodeURIComponent(triplet);
            } catch {
              return triplet;
            }
          });
        }
      });
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function sanitizeAvatarUrl(raw) {
  const rawStr = String(raw || "");
  if (/[\u0000-\u001f\u007f]/.test(rawStr)) return "";
  const s = rawStr.trim();
  if (!s) return "";
  const compact = s.replace(/\s+/g, "");
  if (/^(?:javascript:|vbscript:|data:text\/|data:application\/|data:image\/svg)/i.test(compact)) return "";
  if (/image\/svg\+xml/i.test(compact) || /\.svgz?(?:$|[?&#/])/i.test(compact)) return "";
  try {
    const parsed = new URL(s, "https://watchlivo.online");
    const decPath = safeDecodeURIComponent(parsed.pathname || "").trim();
    const decFull = safeDecodeURIComponent(s).trim();
    if (/\.svgz?$/i.test(decPath) || /\.svgz?(?:$|[?&#\s/])/i.test(decPath)) return "";
    if (/image\/svg\+xml/i.test(decFull) || /\.svgz?(?:$|[?&#\s/])/i.test(decFull)) return "";
    for (const [k, v] of parsed.searchParams.entries()) {
      const dk = safeDecodeURIComponent(k || "").trim();
      const dv = safeDecodeURIComponent(v || "").trim();
      if (/\.svgz?(?:$|[?&#\s/])/i.test(dk) || /\.svgz?(?:$|[?&#\s/])/i.test(dv) || /image\/svg\+xml/i.test(dv)) {
        return "";
      }
    }
  } catch {}
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(compact)) {
    return compact.length <= 45000 ? compact : "";
  }
  if (/^https:\/\//i.test(s)) return s.length <= 2048 ? s : "";
  if ((s.startsWith("/static/") || s.startsWith("/uploads/")) && !s.startsWith("//")) {
    return s.length <= 512 ? s : "";
  }
  return "";
}

function sanitizeFriendsPreview(list, hideFriends = false) {
  if (hideFriends || !Array.isArray(list)) return [];
  const out = [];
  for (const f of list.slice(0, 12)) {
    if (!f || typeof f !== "object") continue;
    const uid = String(f.uid || f.id || "").trim().slice(0, 64);
    const name = String(f.name || f.username || "").trim().slice(0, 40);
    if (!uid && !name) continue;
    out.push({
      uid,
      name,
      handle: String(f.handle || "").trim().slice(0, 40),
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(f.color || "")) ? f.color : "#27DCC8",
      avatarUrl: sanitizeAvatarUrl(f.avatarUrl || ""),
    });
  }
  return out;
}

const TRUSTED_GIF_HOSTS = ["giphy.com", "tenor.com", "klipy.com", "wikimedia.org", "watchlivo.online"];

function sanitizeChatGif(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 512) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "";
    if (u.username || u.password) return "";
    const host = u.hostname.toLowerCase();
    const trusted = TRUSTED_GIF_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
    return trusted ? u.toString().slice(0, 512) : "";
  } catch {
    return "";
  }
}

async function readRoomAuthKv(env, key, wantJson = false) {
  const k = String(key || "");
  if (!k) return { value: null, storageError: false };
  const parseVal = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (!wantJson) return raw;
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };
  if (env?.WATCHLIVO_KV && typeof env.WATCHLIVO_KV.getDetailed === "function") {
    try {
      const res = await env.WATCHLIVO_KV.getDetailed(k, wantJson ? "json" : undefined);
      if (res && !res.storageError) {
        return { value: res.value ?? null, storageError: false };
      }
    } catch {}
  }
  let anySucceeded = false;
  if (env?.ROOM_DO && Date.now() >= _doQuotaExhaustedUntil) {
    try {
      const authStub = env.ROOM_DO.get(env.ROOM_DO.idFromName("__watchlivo_auth_store_v1__"));
      const resp = await authStub.fetch(new Request("https://do.local/__kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "get", key: k, ephemeral: false }),
      }));
      if (resp.ok) {
        const res = await resp.json();
        anySucceeded = true;
        if (res && res.found) {
          if (res.deleted || res.value === null || res.value === undefined) {
            return { value: null, storageError: false };
          }
          return { value: parseVal(res.value), storageError: false };
        }
      }
    } catch {}
  }
  if (env?.ROOMS_DB) {
    try {
      const row = await env.ROOMS_DB.prepare("SELECT v, exp, deleted FROM edge_kv WHERE k = ?").bind(k).first();
      anySucceeded = true;
      if (row) {
        const nowS = Math.floor(nowSec());
        if (Number(row.exp || 0) > 0 && Number(row.exp) < nowS) {
          return { value: null, storageError: false };
        }
        if (Number(row.deleted || 0) === 1 || row.v === null || row.v === undefined) {
          return { value: null, storageError: false };
        }
        return { value: parseVal(row.v), storageError: false };
      }
    } catch {}
  }
  if (env?.WATCHLIVO_KV && typeof env.WATCHLIVO_KV.get === "function") {
    try {
      const rv = await env.WATCHLIVO_KV.get(k, wantJson ? "json" : undefined);
      anySucceeded = true;
      if (rv !== null && rv !== undefined) {
        return { value: parseVal(rv), storageError: false };
      }
    } catch {}
  }
  return { value: null, storageError: !anySucceeded };
}

async function resolveRoomCallerUid(request, env, body = null, url = null) {
  try {
    const vuidHdr = String(request?.headers?.get("x-watchlivo-edge-vuid") || "").trim();
    if (vuidHdr && vuidHdr.includes(".")) {
      const dot = vuidHdr.lastIndexOf(".");
      const uid = vuidHdr.slice(0, dot).trim();
      const sig = vuidHdr.slice(dot + 1).trim();
      if (uid && sig) {
        const expected = await hmacRoomHex(`vuid|${uid}`, env);
        if (timingSafeEqualStr(sig, expected)) return uid.slice(0, 64);
      }
    }
  } catch {}

  let tok = "";
  const authHdr = String(request?.headers?.get("Authorization") || "").trim();
  if (/^Bearer\s+/i.test(authHdr)) {
    tok = authHdr.replace(/^Bearer\s+/i, "").trim();
  }
  if (!tok) {
    const cookieStr = String(request?.headers?.get("Cookie") || "");
    const m = cookieStr.match(/(?:^|;\s*)wl_auth=([^;]+)/);
    if (m) {
      try { tok = decodeURIComponent(m[1]).trim(); } catch { tok = m[1].trim(); }
    }
  }
  if (!tok && body && typeof body === "object") {
    tok = String(body.authToken || body.guestToken || "").trim();
  }
  if (!tok && url) {
    tok = String(url.searchParams.get("authToken") || url.searchParams.get("guestToken") || "").trim();
  }
  if (!tok || tok.length < 16) return "";

  const hasBackingStore = Boolean(env?.WATCHLIVO_KV || env?.ROOM_DO || env?.ROOMS_DB);

  if (tok.startsWith("wl2.")) {
    const parts = tok.split(".");
    if (parts.length !== 3) return "";
    const [, bodyB64, sig] = parts;
    if (!bodyB64 || !sig) return "";
    const rawSecret = String(env?.PROXY_SECRET || env?.VORTEX_SECRET || env?.ADMIN_SECRET || "").trim();
    if (rawSecret) {
      const expected = await hmacRoomHex(`wl2.${bodyB64}`, env);
      if (!timingSafeEqualStr(sig, expected)) return "";
      try {
        const claims = JSON.parse(b64DecodeUtf8(bodyB64));
        if (!claims || typeof claims !== "object") return "";
        if (Number(claims.exp || 0) < Math.floor(nowSec())) return "";
        const uid = String(claims.uid || "").trim().slice(0, 64);
        if (!uid) return "";
        if (hasBackingStore) {
          const revKey = `revoked:${(await sha256Hex(tok)).slice(0, 24)}`;
          const email = String(claims.email || "").trim().toLowerCase();
          const [revRes, delRes, acctRes] = await Promise.all([
            readRoomAuthKv(env, revKey, false),
            email ? readRoomAuthKv(env, `deleted_acct:${email}`, false) : Promise.resolve({ value: null, storageError: false }),
            email ? readRoomAuthKv(env, `acct:${email}`, true) : Promise.resolve({ value: null, storageError: false }),
          ]);
          if (revRes.storageError || delRes.storageError) return "";
          if (revRes.value) return "";
          if (email) {
            const delAt = Number(delRes.value || 0) || 0;
            const issuedAt = Number(claims.exp || 0) - 2592000;
            if (delAt > 0 && delAt >= issuedAt) return "";
            if (acctRes.value && typeof acctRes.value === "object" && Number(acctRes.value.sv || 0) !== Number(claims.sv || 0)) {
              return "";
            }
          }
        }
        return uid;
      } catch {
        return "";
      }
    }
  }

  if (hasBackingStore) {
    const sessRes = await readRoomAuthKv(env, `session:${tok}`, true);
    if (!sessRes.storageError && sessRes.value && typeof sessRes.value === "object") {
      return String(sessRes.value.uid || sessRes.value.id || "").trim().slice(0, 64);
    }
  }
  return "";
}

async function forwardEdgeAuthHeaders(request, verifiedUid, env, extraHeaders = null) {
  const hdrs = new Headers();
  const auth = request?.headers?.get("Authorization");
  const cookie = request?.headers?.get("Cookie");
  if (auth) hdrs.set("Authorization", auth);
  if (cookie) hdrs.set("Cookie", cookie);
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) hdrs.set(k, String(v));
    }
  }
  hdrs.delete("x-watchlivo-edge-vuid");
  if (verifiedUid) {
    const sig = await hmacRoomHex(`vuid|${verifiedUid}`, env);
    hdrs.set("x-watchlivo-edge-vuid", `${verifiedUid}.${sig}`);
  }
  return hdrs;
}

function getKickBanStatus(rm, cid, uid = "") {
  const uLow = String(uid || "").trim().toLowerCase();
  const banned = Boolean(
    (cid && Array.isArray(rm.bannedCids) && rm.bannedCids.includes(cid)) ||
    (uLow && Array.isArray(rm.bannedUids) && rm.bannedUids.includes(uLow))
  );
  const kicked = Boolean(
    (cid && Array.isArray(rm.kicked) && rm.kicked.includes(cid)) ||
    (uLow && Array.isArray(rm.kickedUids) && rm.kickedUids.includes(uLow)) ||
    (uLow && Array.isArray(rm.kicked) && rm.kicked.includes(`uid:${uLow}`))
  );
  return { banned, kicked, blocked: banned || kicked };
}

async function hasFriendsRoomAccess(rm, { cid, tokenVerified, verifiedUid, validSyncToken, env, isInfo = false }) {
  if (!rm || rm.curated || rm.privacy !== "friends") return true;
  if (tokenVerified && (rm.participants?.[cid] || isHostOrCreator(rm, cid) || (rm.co_hosts || []).includes(cid))) {
    return true;
  }
  if (validSyncToken) return true;
  const hasUidPolicy = Boolean(
    rm.creatorUid ||
    (Array.isArray(rm.friendsPreview) && rm.friendsPreview.length > 0) ||
    (Array.isArray(rm.invitedUids) && rm.invitedUids.length > 0)
  );
  if (!hasUidPolicy) return !isInfo;
  const vLow = String(verifiedUid || "").trim().toLowerCase();
  if (!vLow) return false;
  if (rm.creatorUid && String(rm.creatorUid).trim().toLowerCase() === vLow) return true;
  if (Array.isArray(rm.invitedUids) && rm.invitedUids.some((u) => String(u || "").trim().toLowerCase() === vLow)) return true;
  if (Array.isArray(rm.friendsPreview) && rm.friendsPreview.some((f) => String(f?.uid || f?.id || "").trim().toLowerCase() === vLow)) return true;
  if (env?.WATCHLIVO_KV || env?.ROOM_DO || env?.ROOMS_DB) {
    if (rm.creatorUid) {
      const socRes = await readRoomAuthKv(env, `soc:u:${rm.creatorUid}`, true);
      const soc = socRes.value;
      if (Array.isArray(soc?.friends) && soc.friends.some((f) => String(f?.uid || f?.id || f || "").trim().toLowerCase() === vLow)) {
        return true;
      }
    }
    const rawVuid = String(verifiedUid || "").trim();
    let ntfsRes = await readRoomAuthKv(env, `soc:ntf:${vLow}`, true);
    if (!ntfsRes.value && rawVuid && vLow !== rawVuid) {
      ntfsRes = await readRoomAuthKv(env, `soc:ntf:${rawVuid}`, true);
    }
    const ntfs = ntfsRes.value;
    const tNow = nowSec();
    if (Array.isArray(ntfs) && ntfs.some((n) => {
      if (!n || n.type !== "room_invite" || n.roomId !== rm.id) return false;
      const expRaw = Number(n.expiresAt ?? n.exp ?? 0);
      const expSec = expRaw > 1e12 ? expRaw / 1000 : expRaw;
      return !expSec || expSec >= tNow;
    })) {
      return true;
    }
  }
  return false;
}

function checkRoomActionRateLimit(rm, cid, act, t) {
  const rules = {
    chat: { windowSec: 2.0, max: 4 },
    reaction: { windowSec: 1.0, max: 3 },
    soundfx: { windowSec: 1.5, max: 3 },
    poll_create: { windowSec: 3.5, max: 1 },
    break_request: { windowSec: 1.5, max: 1 },
  };
  const rule = rules[act];
  if (!rule || !cid) return false;
  rm._rl = rm._rl && typeof rm._rl === "object" ? rm._rl : {};
  const keys = Object.keys(rm._rl);
  if (keys.length > 200) {
    for (const k of keys) {
      if (!rm.participants?.[k]) delete rm._rl[k];
    }
  }
  const bucket = (rm._rl[cid] = rm._rl[cid] && typeof rm._rl[cid] === "object" ? rm._rl[cid] : {});
  const prev = Array.isArray(bucket[act]) ? bucket[act] : [];
  const fresh = prev.filter((ts) => t - ts < rule.windowSec);
  if (fresh.length >= rule.max) {
    bucket[act] = fresh;
    return true;
  }
  fresh.push(t);
  bucket[act] = fresh;
  return false;
}

function sanitizeChatSnapshot(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https:\/\//i.test(s)) return s.slice(0, 512);
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s) && s.length <= 240000) return s;
  return "";
}

function sanitizeChatAudioNote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rawUrl = String(raw.url || "").trim();
  let url = "";
  if (/^\/api\/rave\/voice-note\/[a-zA-Z0-9_-]{4,40}$/.test(rawUrl) || /^https:\/\//i.test(rawUrl)) {
    url = rawUrl.slice(0, 512);
  }
  let dataUrl = "";
  if (!url) {
    const rawData = String(raw.dataUrl || "").trim();
    if (/^data:(?:audio\/[a-zA-Z0-9.+-]+|video\/(?:webm|mp4))(?:;[a-zA-Z0-9.=+-]+)*;base64,[A-Za-z0-9+/=]+$/i.test(rawData) && rawData.length <= 360000) {
      dataUrl = rawData;
    }
  }
  if (!url && !dataUrl) return null;
  let mime = String(raw.mime || "audio/webm").trim().slice(0, 48);
  if (!mime.startsWith("audio/")) mime = "audio/webm";
  const dur = Math.max(0.2, Math.min(120, Number(raw.duration) || 1));
  const peaks = Array.isArray(raw.peaks)
    ? raw.peaks.slice(0, 80).map((n) => Math.max(0, Math.min(1, Number(n) || 0)))
    : [];
  const out = { mime, duration: Math.round(dur * 10) / 10, peaks };
  if (url) out.url = url;
  if (dataUrl) out.dataUrl = dataUrl;
  return out;
}

function sanitizeChatReplyTo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const user = String(raw.user || "").trim().slice(0, 40);
  const text = String(raw.text || "").trim().slice(0, 140);
  if (!user && !text) return null;
  return {
    id: String(raw.id || "").slice(0, 64),
    user: user || "Mesaj",
    text,
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color || "")) ? raw.color : "#6366f1",
  };
}

function formatIstanbulHHMM() {
  try {
    return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  } catch {
    const d = new Date();
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
}

function sanitizeQueueItem(raw, uname, cid) {
  if (!raw || typeof raw !== "object") return null;
  const url = String(raw.url || "").trim().slice(0, 1500);
  const videoId = String(raw.videoId || "").trim().slice(0, 128);
  const embedUrl = String(raw.embedUrl || "").trim().slice(0, 1500);
  const tmdbId = String(raw.tmdbId || "").trim().slice(0, 32);
  if (!url && !videoId && !embedUrl && !tmdbId) return null;
  return {
    id: String(raw.id || `q_${Date.now().toString(36)}_${makeHexNonce(3)}`).slice(0, 64),
    provider: String(raw.provider || "hls").slice(0, 32),
    streamType: String(raw.streamType || "hls").slice(0, 32),
    url,
    embedUrl,
    videoId,
    tmdbId,
    imdbId: String(raw.imdbId || "").trim().slice(0, 32),
    origLang: String(raw.origLang || "").trim().slice(0, 16),
    year: String(raw.year || "").trim().slice(0, 8),
    mediaType: String(raw.mediaType || "movie").slice(0, 24),
    season: Number(raw.season || 0) || 0,
    episode: Number(raw.episode || 0) || 0,
    title: String(raw.title || raw.songTitle || "Video").slice(0, 140),
    songTitle: String(raw.songTitle || "").slice(0, 140),
    artist: String(raw.artist || "").slice(0, 100),
    seriesTitle: String(raw.seriesTitle || "").slice(0, 140),
    originalTitle: String(raw.originalTitle || "").slice(0, 140),
    catalogProvider: String(raw.catalogProvider || "").slice(0, 48),
    poster: String(raw.poster || raw.thumbnail || "").slice(0, 512),
    backdrop: String(raw.backdrop || raw.poster || raw.thumbnail || "").slice(0, 512),
    thumbnail: String(raw.thumbnail || raw.poster || "").slice(0, 512),
    duration: Number(raw.duration || 0) || 0,
    live: Boolean(raw.live),
    isMusic: Boolean(raw.isMusic),
    channel: String(raw.channel || "").slice(0, 80),
    musicPlatformLabel: String(raw.musicPlatformLabel || "").slice(0, 64),
    altUrls: Array.isArray(raw.altUrls) ? raw.altUrls.slice(0, 12) : [],
    servers: Array.isArray(raw.servers) ? raw.servers.slice(0, 16) : [],
    audioTracks: Array.isArray(raw.audioTracks) ? raw.audioTracks.slice(0, 12) : [],
    subtitleTracks: Array.isArray(raw.subtitleTracks) ? raw.subtitleTracks.slice(0, 16) : [],
    addedBy: uname,
    addedByCid: cid,
    votes: [],
  };
}

function canUserSpeakOrStream(rm, cid) {
  const mode = String(rm.voipMode || "all");
  if (mode === "off") return false;
  if (mode === "leader") return isPrivilegedInRoom(rm, cid);
  if (mode === "stage") {
    return isPrivilegedInRoom(rm, cid) || (Array.isArray(rm.stage_speakers) && rm.stage_speakers.includes(cid));
  }
  return true;
}

function enforceVoipModeOnParticipants(rm) {
  const mode = String(rm.voipMode || "all");
  if (mode === "all" || mode === "on") return;
  for (const [pid, p] of Object.entries(rm.participants || {})) {
    if (!p) continue;
    if (!canUserSpeakOrStream(rm, pid)) {
      p.muted = true;
      p.speaking = false;
      p.cam = false;
      p.screen = false;
    }
  }
}

function makeUserTag(uname, cid) {
  const base = String(uname || "Misafir").split("#")[0].trim() || "Misafir";
  const tail = String(cid || "").slice(-4);
  return tail ? `${base}#${tail}` : base;
}

function applyRoomAction(rm, cid, body, opts = {}) {
  const t = nowSec();
  const act = String(body.type || "poll");
  const pushedEvents = [];
  const privateSignals = [];
  const kickedTargets = [];
  let dirty = Boolean(opts.initialDirty);
  let roomClosed = false;
  let forbiddenError = "";
  let rateLimitedError = "";
  let pendingPassword;

  if (act === "batch" && Array.isArray(body.items)) {
    const sharedMeta = {
      clientId: body.clientId,
      clientToken: body.clientToken,
      uid: body.uid,
      username: body.username,
      name: body.name,
      handle: body.handle,
      avatarUrl: body.avatarUrl,
      bio: body.bio,
      statusText: body.statusText,
      statusEmoji: body.statusEmoji,
      medal: body.medal,
      watchMinutes: body.watchMinutes,
      hideWatching: body.hideWatching,
      hideFriends: body.hideFriends,
      hideLocation: body.hideLocation,
      friendsPreview: body.friendsPreview,
      color: body.color,
      device: body.device,
      country: body.country,
      activeMedia: body.activeMedia,
    };
    let lastRateErr = "";
    let nonSignalCount = 0;
    for (const item of body.items.slice(0, 80)) {
      if (!item || typeof item !== "object") continue;
      const subType = String(item.type || "poll");
      if (subType === "batch") continue;
      if (!["webrtc_offer", "webrtc_answer", "webrtc_ice"].includes(subType)) {
        nonSignalCount += 1;
        if (nonSignalCount > 25) continue;
      }
      const sub = applyRoomAction(rm, cid, { ...sharedMeta, ...item }, opts);
      if (sub.rateLimitedError) {
        lastRateErr = sub.rateLimitedError;
        continue;
      }
      dirty = dirty || sub.dirty;
      pushedEvents.push(...sub.pushedEvents);
      privateSignals.push(...sub.privateSignals);
      if (sub.kickedTargets?.length) kickedTargets.push(...sub.kickedTargets);
      if (sub.roomClosed) roomClosed = true;
      if (sub.forbiddenError) forbiddenError = sub.forbiddenError;
      if (sub.pendingPassword !== undefined) pendingPassword = sub.pendingPassword;
    }
    if (!dirty && pushedEvents.length === 0 && privateSignals.length === 0 && lastRateErr) {
      rateLimitedError = lastRateErr;
    }
    return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError, rateLimitedError, pendingPassword };
  }

  const tokenVerified = Boolean(opts.tokenVerified);
  const uname = String(body.username || body.name || rm.participants?.[cid]?.name || "Misafir").trim().slice(0, 40) || "Misafir";
  if (act === "leave") {
    if (rm._rl && rm._rl[cid]) delete rm._rl[cid];
    if (rm.participants?.[cid]) {
      delete rm.participants[cid];
      if (Array.isArray(rm.stage_speakers)) {
        rm.stage_speakers = rm.stage_speakers.filter((x) => x !== cid);
      }
      rm.rev = (rm.rev || 1) + 1;
      dirty = true;
    }
    return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError, rateLimitedError };
  }

  const prevP = rm.participants?.[cid];
  const isVoicePayload = act === "voice_state";
  let nextMuted = body.muted !== undefined ? Boolean(body.muted) : Boolean(prevP?.muted ?? true);
  let nextSpeaking = body.speaking !== undefined ? Boolean(body.speaking) : Boolean(prevP?.speaking ?? false);
  let nextCam = body.cam !== undefined ? Boolean(body.cam) : Boolean(prevP?.cam ?? false);
  let nextScreen = body.screen !== undefined ? Boolean(body.screen) : Boolean(prevP?.screen ?? false);
  let nextInCall = body.inCall !== undefined ? Boolean(body.inCall) : Boolean(prevP?.inCall ?? false);
  let nextDeafened = body.deafened !== undefined ? Boolean(body.deafened) : Boolean(prevP?.deafened ?? false);
  const nextHandRaised = body.handRaised !== undefined ? Boolean(body.handRaised) : Boolean(prevP?.handRaised ?? false);

  if (isVoicePayload && !canUserSpeakOrStream(rm, cid)) {
    nextMuted = true;
    nextSpeaking = false;
    nextCam = false;
    nextScreen = false;
    if (rm.voipMode === "off") nextInCall = false;
  }
  if (nextMuted) nextSpeaking = false;
  if (nextCam || nextScreen || !nextMuted) nextInCall = true;

  const nextAvatar = body.avatarUrl !== undefined ? sanitizeAvatarUrl(body.avatarUrl) : (prevP?.avatarUrl || "");
  const nextColor = /^#[0-9a-fA-F]{3,8}$/.test(String(body.color || "")) ? body.color : (prevP?.color || "#27DCC8");
  const nextVerifiedUid = String(opts.verifiedUid || (tokenVerified ? prevP?.verifiedUid : "") || "").trim().slice(0, 64);
  const nextUid = nextVerifiedUid || (body.uid !== undefined ? String(body.uid || "").trim().slice(0, 64) : (prevP?.uid || ""));
  const nextHandle = body.handle !== undefined ? String(body.handle || "").slice(0, 40) : (prevP?.handle || "");
  const nextStatusText = body.statusText !== undefined ? String(body.statusText || "").slice(0, 80) : (prevP?.statusText || "");
  const nextStatusEmoji = body.statusEmoji !== undefined ? String(body.statusEmoji || "🍿").slice(0, 12) : (prevP?.statusEmoji || "🍿");
  const nextBio = body.bio !== undefined ? String(body.bio || "").slice(0, 160) : (prevP?.bio || "");
  const nextMedal = body.medal !== undefined ? String(body.medal || "").slice(0, 32) : (prevP?.medal || "");
  const nextWatchMinutes = body.watchMinutes !== undefined ? Math.max(0, Number(body.watchMinutes) || 0) : Number(prevP?.watchMinutes || 0);
  const nextHideWatching = body.hideWatching !== undefined ? Boolean(body.hideWatching) : Boolean(prevP?.hideWatching);
  const nextHideFriends = body.hideFriends !== undefined ? Boolean(body.hideFriends) : Boolean(prevP?.hideFriends);
  const nextHideLocation = body.hideLocation !== undefined ? Boolean(body.hideLocation) : Boolean(prevP?.hideLocation);
  const nextFriendsPreview = sanitizeFriendsPreview(
    body.friendsPreview !== undefined ? body.friendsPreview : prevP?.friendsPreview,
    nextHideFriends
  );
  const nextDevice = String(body.device || prevP?.device || "Web").slice(0, 24);
  const nextCountry = nextHideLocation ? "" : String(body.country || prevP?.country || "TR").slice(0, 4);

  const partChanged = Boolean(
    !prevP ||
    prevP.name !== uname ||
    prevP.uid !== nextUid ||
    (prevP.verifiedUid || "") !== nextVerifiedUid ||
    prevP.handle !== nextHandle ||
    prevP.bio !== nextBio ||
    prevP.statusEmoji !== nextStatusEmoji ||
    prevP.medal !== nextMedal ||
    Number(prevP.watchMinutes || 0) !== nextWatchMinutes ||
    Boolean(prevP.hideWatching) !== nextHideWatching ||
    Boolean(prevP.hideFriends) !== nextHideFriends ||
    Boolean(prevP.hideLocation) !== nextHideLocation ||
    (prevP.country || "") !== nextCountry ||
    prevP.muted !== nextMuted ||
    Boolean(prevP.speaking) !== nextSpeaking ||
    Boolean(prevP.cam) !== nextCam ||
    Boolean(prevP.screen) !== nextScreen ||
    Boolean(prevP.inCall) !== nextInCall ||
    Boolean(prevP.deafened) !== nextDeafened ||
    Boolean(prevP.handRaised) !== nextHandRaised ||
    prevP.color !== nextColor ||
    prevP.avatarUrl !== nextAvatar ||
    prevP.statusText !== nextStatusText
  );
  if (partChanged) {
    dirty = true;
    rm.rev = (rm.rev || 1) + 1;
  }
  const nextHostMutedAt = (isVoicePayload && !nextMuted) ? 0 : Number(prevP?.hostMutedAt || 0);
  rm.participants[cid] = {
    ...(prevP || {}),
    id: cid,
    uid: nextUid,
    verifiedUid: nextVerifiedUid,
    name: uname,
    handle: nextHandle,
    color: nextColor,
    avatarUrl: nextAvatar,
    bio: nextBio,
    statusText: nextStatusText,
    statusEmoji: nextStatusEmoji,
    medal: nextMedal,
    watchMinutes: nextWatchMinutes,
    hideWatching: nextHideWatching,
    hideFriends: nextHideFriends,
    hideLocation: nextHideLocation,
    friendsPreview: nextFriendsPreview,
    device: nextDevice,
    country: nextCountry,
    muted: nextMuted,
    speaking: nextSpeaking,
    cam: nextCam,
    screen: nextScreen,
    inCall: nextInCall,
    deafened: nextDeafened,
    handRaised: nextHandRaised,
    hostMutedAt: nextHostMutedAt,
    lastSeen: t,
  };

  if (!rm.curated && (!rm.host_id || !rm.participants[rm.host_id])) {
    rm.host_id = cid;
    dirty = true;
  }
  if (!rm.curated && body.activeMedia && !rm.media?.url && !rm.media?.videoId && (body.activeMedia.url || body.activeMedia.videoId || body.activeMedia.embedUrl)) {
    rm.media = buildFreshMedia(body.activeMedia, uname, t);
    rm.rev = (rm.rev || 1) + 1;
    dirty = true;
  }

  const pushEv = (ev, optsEv = {}) => {
    const evId = ev.id || `ev_${Date.now()}_${makeHexNonce(3)}`;
    const fullEv = { id: evId, cid, user: uname, username: uname, ts: t, ...ev };
    rm.events = [...(rm.events || []).slice(-49), fullEv];
    rm.rev = (rm.rev || 1) + 1;
    pushedEvents.push({ ev: fullEv, attachRoom: Boolean(optsEv.attachRoom) });
    dirty = true;
    return fullEv;
  };

  const advanceQueueItem = (targetIdx = -1, targetId = "") => {
    rm.queue = Array.isArray(rm.queue) ? rm.queue : [];
    if (!rm.queue.length) return false;
    let idx = -1;
    if (targetId) idx = rm.queue.findIndex((q) => q && q.id === targetId);
    if (idx < 0 && Number.isInteger(targetIdx) && targetIdx >= 0 && targetIdx < rm.queue.length) idx = targetIdx;
    if (idx < 0) {
      if (rm.playMode === "vote") {
        let bestIdx = 0;
        let bestVotes = -1;
        rm.queue.forEach((q, i) => {
          const cnt = Array.isArray(q?.votes) ? q.votes.length : 0;
          if (cnt > bestVotes) { bestVotes = cnt; bestIdx = i; }
        });
        idx = bestIdx;
      } else {
        idx = 0;
      }
    }
    const [picked] = rm.queue.splice(idx, 1);
    if (!picked) return false;
    rm.media = buildFreshMedia({ ...picked, currentTime: 0, playing: true }, uname, t);
    rm.skip_votes = [];
    rm.voteEndsAt = 0;
    pushEv({ type: "queue_updated", queue: rm.queue, voteEndsAt: 0 });
    pushEv({ type: "media_changed", action: "queue_play", media: buildMediaOut(rm) }, { attachRoom: true });
    return true;
  };

  if (["chat", "reaction", "soundfx", "poll_create", "break_request"].includes(act) && checkRoomActionRateLimit(rm, cid, act, t)) {
    return {
      dirty,
      pushedEvents,
      privateSignals,
      kickedTargets,
      roomClosed,
      forbiddenError,
      rateLimitedError: "Çok hızlı işlem yapıyorsunuz, lütfen kısa bir süre bekleyin.",
      pendingPassword,
    };
  }

  if (act === "play" || act === "pause" || act === "seek" || act === "rate" || act === "video_ended") {
    if (act === "video_ended" && !rm.curated && Array.isArray(rm.queue) && rm.queue.length > 0 && ["autoplay", "vote", "quickplay", "cohost"].includes(rm.playMode || "")) {
      if (rm.playMode === "vote") {
        if (!rm.voteEndsAt || Number(rm.voteEndsAt) <= 0) {
          rm.media.playing = false;
          rm.media.updatedAt = t;
          rm.voteEndsAt = t + 8;
          pushEv({ type: "vote_updated", queue: rm.queue, voteEndsAt: rm.voteEndsAt });
        } else if (t >= Number(rm.voteEndsAt) - 0.5) {
          advanceQueueItem(-1, "");
        }
      } else {
        advanceQueueItem(-1, "");
      }
    } else {
      if (rm.playMode === "leader" && !isPrivilegedInRoom(rm, cid)) {
        return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Lider modunda oynatma kontrolü yalnızca oda yöneticisine aittir.", rateLimitedError };
      }
      if (body.currentTime !== undefined) rm.media.currentTime = Math.max(0, Number(body.currentTime) || 0);
      if (act === "play") rm.media.playing = true;
      if (act === "pause" || act === "video_ended") rm.media.playing = false;
      if (act === "video_ended") rm.media.currentTime = 0;
      if (body.rate !== undefined) {
        rm.media.rate = Math.min(4, Math.max(0.25, Number(body.rate) || 1));
        rm.media.meshStatePlaybackSpeed = rm.media.rate;
      }
      rm.media.updatedAt = t;
      rm.media.lastActionBy = uname;
      pushEv({
        type: act === "video_ended" ? "video_ended" : "sync",
        action: act,
        currentTime: rm.media.currentTime,
        playing: rm.media.playing,
        rate: rm.media.rate,
        meshStatePlaybackSpeed: rm.media.rate,
        media: buildMediaOut(rm),
      });
    }
  } else if (act === "heartbeat" && isHostOrCreator(rm, cid) && body.currentTime !== undefined) {
    const prevPlaying = Boolean(rm.media.playing);
    const prevElapsed = Math.max(0, t - (Number(rm.media.updatedAt) || t));
    const prevRate = Number(rm.media.rate) || 1;
    const prevExp = prevPlaying ? (Number(rm.media.currentTime) || 0) + prevElapsed * prevRate : (Number(rm.media.currentTime) || 0);
    const rawPos = Math.max(0, Number(body.currentTime) || 0);
    if (body.playing !== undefined) rm.media.playing = Boolean(body.playing);
    const rawAt = Number(body.atTime || 0);
    const transit = (rm.media.playing && rawAt > 1e9 && t - rawAt > 0 && t - rawAt < 0.85) ? (t - rawAt) : 0;
    const rate = Number(rm.media.rate) || 1;
    const nextPos = rawPos + transit * rate;
    rm.media.currentTime = nextPos;
    rm.media.updatedAt = t;
    const driftSec = Math.abs(nextPos - prevExp);
    const playingChanged = prevPlaying !== Boolean(rm.media.playing);
    const significantDrift = Boolean(body.anchor || playingChanged || driftSec >= 1.8);
    if (significantDrift || !rm._lastHbSave || (t - Number(rm._lastHbSave || 0) >= 20)) {
      rm._lastHbSave = t;
      dirty = true;
    }
    if (significantDrift) {
      pushedEvents.push({
        attachRoom: false,
        ev: {
          id: `hb_${Date.now()}_${makeHexNonce(3)}`,
          cid,
          user: uname,
          username: uname,
          ts: t,
          type: "sync",
          action: "heartbeat",
          currentTime: rm.media.currentTime,
          playing: rm.media.playing,
          rate: rm.media.rate,
          media: buildMediaOut(rm),
        },
      });
    }
  } else if (act === "change_media" || act === "resolve_media") {
    if (rm.playMode === "leader" && !isPrivilegedInRoom(rm, cid)) {
      return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Medya değiştirme yetkisi oda yöneticisine aittir.", rateLimitedError };
    }
    if (rm.curated) {
      return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Sabit 7/24 odalarda medya değiştirilemez.", rateLimitedError };
    }
    const m = body.media || body;
    if (act === "change_media") {
      rm.media = buildFreshMedia({
        ...m,
        currentTime: m.currentTime !== undefined ? Number(m.currentTime) || 0 : 0,
        playing: m.playing !== undefined ? Boolean(m.playing) : true,
      }, uname, t);
      rm.skip_votes = [];
    } else {
      const nextRate = Math.min(4, Math.max(0.25, Number(m.rate ?? m.meshStatePlaybackSpeed ?? rm.media.rate ?? 1) || 1));
      rm.media = {
        ...rm.media,
        provider: m.provider || rm.media.provider || "hls",
        videoId: m.videoId ?? rm.media.videoId ?? "",
        tmdbId: String(m.tmdbId ?? rm.media.tmdbId ?? ""),
        imdbId: String(m.imdbId ?? rm.media.imdbId ?? ""),
        origLang: String(m.origLang ?? rm.media.origLang ?? ""),
        year: String(m.year ?? rm.media.year ?? ""),
        intro: m.intro !== undefined ? m.intro : (rm.media.intro ?? null),
        mediaType: m.mediaType || rm.media.mediaType || "movie",
        season: Number(m.season ?? rm.media.season ?? 0),
        episode: Number(m.episode ?? rm.media.episode ?? 0),
        url: m.url || rm.media.url || "",
        embedUrl: m.embedUrl ?? rm.media.embedUrl ?? "",
        streamType: m.streamType || rm.media.streamType || "hls",
        title: m.title || rm.media.title || "",
        seriesTitle: m.seriesTitle ?? rm.media.seriesTitle ?? "",
        originalTitle: m.originalTitle ?? rm.media.originalTitle ?? "",
        catalogProvider: m.catalogProvider ?? rm.media.catalogProvider ?? "",
        poster: m.poster || m.thumbnail || rm.media.poster || "",
        backdrop: m.backdrop || m.poster || rm.media.backdrop || "",
        thumbnail: m.thumbnail || m.poster || rm.media.thumbnail || "",
        altUrls: Array.isArray(m.altUrls) ? m.altUrls : (rm.media.altUrls || []),
        servers: Array.isArray(m.servers) ? m.servers : (rm.media.servers || []),
        audioTracks: Array.isArray(m.audioTracks) ? m.audioTracks : (rm.media.audioTracks || []),
        subtitleTracks: Array.isArray(m.subtitleTracks) ? m.subtitleTracks : (rm.media.subtitleTracks || []),
        duration: m.duration !== undefined ? Number(m.duration) || 0 : (rm.media.duration || 0),
        currentTime: m.currentTime !== undefined ? Number(m.currentTime) || 0 : rm.media.currentTime,
        playing: m.playing !== undefined ? Boolean(m.playing) : true,
        rate: nextRate,
        meshStatePlaybackSpeed: nextRate,
        lastActionBy: uname,
        updatedAt: t,
      };
    }
    pushEv({ type: "media_changed", action: act, media: buildMediaOut(rm) }, { attachRoom: true });
  } else if (act === "chat") {
    const cleanText = String(body.text || "").trim().slice(0, 1000);
    const cleanGif = sanitizeChatGif(body.gif);
    const cleanSnap = sanitizeChatSnapshot(body.snapshot);
    const cleanAudio = sanitizeChatAudioNote(body.audioNote);
    if (cleanText || cleanGif || cleanSnap || cleanAudio) {
      const msgId = String(body.clientMsgId || body.id || `m_${Date.now()}_${makeHexNonce(3)}`).slice(0, 64);
      if (!(rm.chat || []).some((x) => x && x.id === msgId)) {
        const videoTime = body.videoTime !== undefined && body.videoTime !== null && Number.isFinite(Number(body.videoTime))
          ? Math.max(0, Number(body.videoTime))
          : null;
        const msg = {
          id: msgId,
          clientMsgId: msgId,
          cid,
          uid: nextUid,
          verifiedUid: rm.participants[cid].verifiedUid || "",
          handle: nextHandle,
          user: uname,
          username: uname,
          color: rm.participants[cid].color,
          avatarUrl: rm.participants[cid].avatarUrl || "",
          text: cleanText,
          gif: cleanGif || "",
          snapshot: cleanSnap || null,
          audioNote: cleanAudio || null,
          videoTime,
          replyTo: sanitizeChatReplyTo(body.replyTo),
          reactions: {},
          time: formatIstanbulHHMM(),
          ts: t,
        };
        rm.chat = [...(rm.chat || []).slice(-59), msg];
        pushEv({ type: "chat", message: msg, ...msg });
      }
    }
  } else if (act === "msg_react" && body.msgId && body.emoji) {
    const mid = String(body.msgId).slice(0, 64);
    const emo = String(body.emoji).slice(0, 16);
    const targetMsg = (rm.chat || []).find((x) => x && x.id === mid);
    if (targetMsg) {
      targetMsg.reactions = targetMsg.reactions || {};
      const reactTag = makeUserTag(uname, cid);
      const baseName = String(uname || "").split("#")[0].trim();
      const prevArr = Array.isArray(targetMsg.reactions[emo]) ? [...targetMsg.reactions[emo]] : [];
      const existingIdx = prevArr.findIndex((u) => u === reactTag || u === cid || (!String(u).includes("#") && baseName && u === baseName));
      let addedReact = false;
      if (existingIdx >= 0) prevArr.splice(existingIdx, 1);
      else { prevArr.push(reactTag); addedReact = true; }
      if (prevArr.length) targetMsg.reactions[emo] = prevArr;
      else delete targetMsg.reactions[emo];
      pushEv({ type: "msg_reacted", msgId: mid, emoji: emo, added: addedReact, reactions: targetMsg.reactions });
    }
  } else if (act === "poll_create") {
    const question = String(body.question || "").trim().slice(0, 140);
    const rawOpts = Array.isArray(body.options) ? body.options : [];
    const optsClean = rawOpts.map((o) => String(o || "").trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    if (question && optsClean.length >= 2) {
      const pollId = `poll_${Date.now().toString(36)}_${makeHexNonce(3)}`;
      const pollObj = {
        id: pollId,
        question,
        options: optsClean.map((text) => ({ text, votes: [] })),
        createdBy: uname,
        cid,
        ts: t,
      };
      rm.polls = [...(Array.isArray(rm.polls) ? rm.polls : []).slice(-19), pollObj];
      const msgId = `m_${pollId}`;
      const pollMsg = {
        id: msgId,
        cid,
        uid: nextUid,
        verifiedUid: rm.participants[cid].verifiedUid || "",
        user: uname,
        username: uname,
        color: rm.participants[cid].color,
        avatarUrl: rm.participants[cid].avatarUrl || "",
        text: "",
        pollId,
        reactions: {},
        time: formatIstanbulHHMM(),
        ts: t,
      };
      rm.chat = [...(rm.chat || []).slice(-59), pollMsg];
      pushEv({ type: "chat", message: pollMsg, ...pollMsg });
      pushEv({ type: "poll_updated", pollId, polls: rm.polls });
    }
  } else if (act === "poll_vote") {
    if (body.pollId && Number.isInteger(Number(body.optionIndex))) {
      const pid = String(body.pollId).slice(0, 64);
      const optIdx = Number(body.optionIndex);
      rm.polls = Array.isArray(rm.polls) ? rm.polls : [];
      const poll = rm.polls.find((p) => p && p.id === pid);
      if (poll && Array.isArray(poll.options) && optIdx >= 0 && optIdx < poll.options.length) {
        const voteTag = makeUserTag(uname, cid);
        const baseName = String(uname || "").split("#")[0].trim();
        const isMine = (u) => u === voteTag || u === cid || (!String(u).includes("#") && baseName && u === baseName);
        poll.options = poll.options.map((opt, idx) => {
          const cur = Array.isArray(opt.votes) ? [...opt.votes] : [];
          const hadMe = cur.some(isMine);
          if (idx === optIdx) {
            return { ...opt, votes: hadMe ? cur.filter((u) => !isMine(u)) : [...cur, voteTag] };
          }
          return { ...opt, votes: cur.filter((u) => !isMine(u)) };
        });
        pushEv({ type: "poll_updated", pollId: pid, polls: rm.polls });
      }
    } else if (body.option !== undefined) {
      const opt = String(body.option).slice(0, 80);
      rm.pollVotes = rm.pollVotes || {};
      rm.pollVotes[cid] = opt;
      pushEv({ type: "poll_vote", option: opt, pollVotes: rm.pollVotes });
    }
  } else if (act === "queue_add") {
    if (!rm.curated) {
      const item = sanitizeQueueItem(body.item || body.media || body, uname, cid);
      if (item) {
        rm.queue = [...(Array.isArray(rm.queue) ? rm.queue : []).slice(-49), item];
        pushEv({ type: "queue_updated", queue: rm.queue, voteEndsAt: Number(rm.voteEndsAt || 0) });
      }
    }
  } else if (act === "queue_add_batch" && Array.isArray(body.items)) {
    if (!rm.curated) {
      const added = [];
      for (const rawIt of body.items.slice(0, 25)) {
        const clean = sanitizeQueueItem(rawIt, uname, cid);
        if (clean) added.push(clean);
      }
      if (added.length) {
        rm.queue = [...(Array.isArray(rm.queue) ? rm.queue : []), ...added].slice(-50);
        pushEv({ type: "queue_updated", queue: rm.queue, voteEndsAt: Number(rm.voteEndsAt || 0) });
      }
    }
  } else if (act === "queue_vote" || act === "vote_video") {
    rm.queue = Array.isArray(rm.queue) ? rm.queue : [];
    const targetId = String(body.id || "");
    const targetIdx = Number.isInteger(Number(body.index)) ? Number(body.index) : -1;
    let idx = targetId ? rm.queue.findIndex((q) => q && q.id === targetId) : -1;
    if (idx < 0 && targetIdx >= 0 && targetIdx < rm.queue.length) idx = targetIdx;
    if (idx >= 0) {
      const item = rm.queue[idx];
      const votes = new Set(Array.isArray(item.votes) ? item.votes : []);
      if (votes.has(cid)) votes.delete(cid); else votes.add(cid);
      item.votes = Array.from(votes);
      rm.queue.sort((a, b) => (Array.isArray(b?.votes) ? b.votes.length : 0) - (Array.isArray(a?.votes) ? a.votes.length : 0));
      pushEv({ type: "queue_updated", queue: rm.queue, voteEndsAt: Number(rm.voteEndsAt || 0) });
    }
  } else if (act === "queue_play" || act === "queue_play_index") {
    if (!rm.curated) {
      const canPlayQ = isPrivilegedInRoom(rm, cid) || ["cohost", "quickplay", "free"].includes(rm.playMode || "");
      if (!canPlayQ) {
        return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Sıradaki videoyu yalnızca oda lideri başlatabilir.", rateLimitedError };
      }
      const targetId = String(body.id || "");
      const targetIdx = Number.isInteger(Number(body.index)) ? Number(body.index) : 0;
      advanceQueueItem(targetIdx, targetId);
    }
  } else if (act === "queue_remove") {
    rm.queue = Array.isArray(rm.queue) ? rm.queue : [];
    const targetId = String(body.id || "");
    const targetIdx = Number.isInteger(Number(body.index)) ? Number(body.index) : -1;
    let idx = targetId ? rm.queue.findIndex((q) => q && q.id === targetId) : -1;
    if (idx < 0 && targetIdx >= 0 && targetIdx < rm.queue.length) idx = targetIdx;
    if (idx >= 0) {
      const item = rm.queue[idx];
      if (!tokenVerified || (!isPrivilegedInRoom(rm, cid) && item?.addedByCid !== cid)) {
        return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Bu öğeyi sıradan kaldırma yetkiniz yok.", rateLimitedError };
      }
      rm.queue.splice(idx, 1);
      pushEv({ type: "queue_updated", queue: rm.queue, voteEndsAt: Number(rm.voteEndsAt || 0) });
    }
  } else if (act === "vote_skip") {
    const humanIds = new Set(
      Object.entries(rm.participants || {})
        .filter(([pid, p]) => !isBotParticipant(pid, p))
        .map(([pid]) => pid)
    );
    const votes = new Set((rm.skip_votes || []).filter((v) => humanIds.has(v)));
    if (humanIds.has(cid)) {
      if (votes.has(cid)) votes.delete(cid); else votes.add(cid);
    }
    rm.skip_votes = Array.from(votes);
    const skipNeeded = Math.max(1, Math.floor(humanIds.size / 2) + 1);
    pushEv({ type: "skip_votes", votes: rm.skip_votes, needed: skipNeeded, skip_votes: rm.skip_votes, skipNeeded });
    if (!rm.curated && rm.skip_votes.length >= skipNeeded && Array.isArray(rm.queue) && rm.queue.length > 0) {
      advanceQueueItem(-1, "");
    }
  } else if (act === "voice_state") {
    pushEv({
      type: "voice_state",
      muted: nextMuted,
      speaking: nextSpeaking,
      cam: nextCam,
      screen: nextScreen,
      inCall: nextInCall,
      deafened: nextDeafened,
    });
  } else if (act === "break_request") {
    if (!rm.curated) {
      const brkId = String(body.actionId || `brk_${Date.now().toString(36)}_${makeHexNonce(3)}`).slice(0, 64);
      pushEv({ type: "break_request", id: brkId, videoTime: Math.max(0, Number(body.videoTime) || 0) });
    }
  } else if (act === "hand_raise") {
    const raised = Boolean(body.raised);
    rm.participants[cid].handRaised = raised;
    pushEv({ type: "hand_raised", raised });
  } else if (act === "host_action") {
    const subAct = String(body.subAction || body.action || "");
    const targetCid = String(body.targetId || body.targetCid || "");
    const allowCoHostSub = ["toggle_stage_mode", "toggle_stage_speaker"].includes(subAct);
    const permitted = allowCoHostSub ? isPrivilegedInRoom(rm, cid) : isHostOrCreator(rm, cid);
    if (!tokenVerified || !permitted) {
      return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Bu yönetici işlemi için geçerli host doğrulaması gerekli.", rateLimitedError };
    }
    const validPlayModes = ["leader", "cohost", "autoplay", "quickplay", "vote", "free"];
    const validVoipModes = ["all", "stage", "leader", "off", "on"];
    if (subAct === "set_play_mode" && validPlayModes.includes(body.playMode)) {
      rm.playMode = body.playMode;
      pushEv({ type: "host_action", subAction: subAct, playMode: rm.playMode }, { attachRoom: true });
    } else if (subAct === "set_privacy" && !rm.curated) {
      let changed = false;
      if (["public", "friends", "private"].includes(body.privacy)) {
        rm.privacy = body.privacy;
        changed = true;
      }
      if (validPlayModes.includes(body.playMode)) {
        rm.playMode = body.playMode;
        changed = true;
      }
      if (validVoipModes.includes(body.voipMode)) {
        rm.voipMode = body.voipMode === "on" ? "all" : body.voipMode;
        if (rm.voipMode !== "stage") rm.stage_speakers = [];
        enforceVoipModeOnParticipants(rm);
        changed = true;
      }
      if (body.locked !== undefined) {
        rm.locked = Boolean(body.locked);
        changed = true;
      }
      if (Array.isArray(body.invitedUids)) {
        rm.invitedUids = Array.from(new Set(body.invitedUids.map((x) => String(x || "").trim().slice(0, 64)).filter(Boolean))).slice(0, 100);
        changed = true;
      }
      if (typeof body.name === "string" && body.name.trim()) {
        const cleanName = body.name.trim().slice(0, 64);
        rm.name = cleanName;
        rm.rawName = cleanName;
        rm.customName = true;
        changed = true;
      }
      if (body.password !== undefined) {
        pendingPassword = String(body.password || "").trim();
        changed = true;
      }
      if (changed) {
        pushEv({ type: "host_action", subAction: "set_privacy", privacy: rm.privacy, playMode: rm.playMode, voipMode: rm.voipMode, locked: Boolean(rm.locked), name: rm.name }, { attachRoom: true });
      }
    } else if ((subAct === "toggle_lock" || subAct === "set_locked") && !rm.curated) {
      rm.locked = subAct === "toggle_lock" ? !Boolean(rm.locked) : Boolean(body.locked ?? true);
      pushEv({ type: "host_action", subAction: subAct, locked: rm.locked }, { attachRoom: true });
    } else if (subAct === "toggle_stage_mode") {
      rm.voipMode = rm.voipMode === "stage" ? "all" : "stage";
      if (rm.voipMode !== "stage") {
        rm.stage_speakers = [];
        for (const p of Object.values(rm.participants || {})) {
          if (p) p.handRaised = false;
        }
      } else {
        enforceVoipModeOnParticipants(rm);
      }
      pushEv({ type: "host_action", subAction: "toggle_stage_mode", voipMode: rm.voipMode }, { attachRoom: true });
    } else if (subAct === "toggle_stage_speaker" && targetCid && rm.participants?.[targetCid]) {
      const curSpk = Array.isArray(rm.stage_speakers) ? rm.stage_speakers : [];
      if (curSpk.includes(targetCid)) {
        rm.stage_speakers = curSpk.filter((x) => x !== targetCid);
        if (!isPrivilegedInRoom(rm, targetCid)) {
          rm.participants[targetCid].muted = true;
          rm.participants[targetCid].speaking = false;
          rm.participants[targetCid].cam = false;
          rm.participants[targetCid].screen = false;
        }
      } else {
        rm.stage_speakers = Array.from(new Set([...curSpk, targetCid]));
      }
      rm.participants[targetCid].handRaised = false;
      pushEv({ type: "host_action", subAction: "toggle_stage_speaker", targetCid, stage_speakers: rm.stage_speakers }, { attachRoom: true });
    } else if (subAct === "kick" && targetCid && targetCid !== cid && targetCid !== rm.creatorCid && targetCid !== rm.host_id) {
      const explicitTargetUid = String(body.targetUid || "").trim().toLowerCase().slice(0, 64);
      const targetVerifiedUid = String(rm.participants?.[targetCid]?.verifiedUid || "").trim().toLowerCase().slice(0, 64);
      const kickedUid = targetVerifiedUid || explicitTargetUid;
      const creatorUidLow = String(rm.creatorUid || "").trim().toLowerCase();
      if (!kickedUid || kickedUid !== creatorUidLow) {
        const dropCids = new Set([targetCid]);
        if (kickedUid) {
          for (const [pid, p] of Object.entries(rm.participants || {})) {
            const pVuid = String(p?.verifiedUid || "").trim().toLowerCase();
            if (p && pVuid === kickedUid && pid !== rm.creatorCid && pid !== rm.host_id) {
              dropCids.add(pid);
            }
          }
        }
        rm.kicked = Array.from(new Set([...(rm.kicked || []), ...dropCids])).slice(-100);
        if (kickedUid) {
          rm.kickedUids = Array.from(new Set([...(rm.kickedUids || []), kickedUid])).slice(-100);
        }
        for (const dc of dropCids) {
          delete rm.participants[dc];
          kickedTargets.push(dc);
        }
        if (kickedUid) kickedTargets.push(`uid:${kickedUid}`);
        rm.co_hosts = (rm.co_hosts || []).filter((x) => !dropCids.has(x));
        rm.stage_speakers = (rm.stage_speakers || []).filter((x) => !dropCids.has(x));
        pushEv({ type: "host_action", subAction: "kick", targetCid }, { attachRoom: true });
      }
    } else if (subAct === "ban" && !rm.curated) {
      const explicitTargetUid = String(body.targetUid || "").trim().toLowerCase().slice(0, 64);
      const targetVerifiedUid = String(rm.participants?.[targetCid]?.verifiedUid || "").trim().toLowerCase().slice(0, 64);
      const targetUid = targetVerifiedUid || explicitTargetUid;
      const creatorUidLow = String(rm.creatorUid || "").trim().toLowerCase();
      if ((targetCid || targetUid) && targetCid !== cid && targetCid !== rm.creatorCid && targetCid !== rm.host_id && (!targetUid || targetUid !== creatorUidLow)) {
        const dropCids = new Set(targetCid ? [targetCid] : []);
        if (targetUid) {
          for (const [pid, p] of Object.entries(rm.participants || {})) {
            const pVuid = String(p?.verifiedUid || "").trim().toLowerCase();
            if (p && pVuid === targetUid && pid !== rm.creatorCid && pid !== rm.host_id) {
              dropCids.add(pid);
            }
          }
        }
        if (dropCids.size > 0) {
          rm.bannedCids = Array.from(new Set([...(rm.bannedCids || []), ...dropCids])).slice(-100);
          rm.kicked = Array.from(new Set([...(rm.kicked || []), ...dropCids])).slice(-100);
        }
        if (targetUid) {
          rm.bannedUids = Array.from(new Set([...(rm.bannedUids || []), targetUid])).slice(-100);
          rm.kickedUids = Array.from(new Set([...(rm.kickedUids || []), targetUid])).slice(-100);
        }
        for (const dc of dropCids) {
          delete rm.participants[dc];
          kickedTargets.push(dc);
        }
        if (targetUid) kickedTargets.push(`uid:${targetUid}`);
        rm.co_hosts = (rm.co_hosts || []).filter((x) => !dropCids.has(x));
        rm.stage_speakers = (rm.stage_speakers || []).filter((x) => !dropCids.has(x));
        pushEv({ type: "host_action", subAction: "ban", targetCid, targetUid }, { attachRoom: true });
      }
    } else if (subAct === "unban" && !rm.curated) {
      const targetUid = String(body.targetUid || "").trim().toLowerCase().replace(/^uid:/, "").slice(0, 64);
      if (targetCid || targetUid) {
        if (targetCid) {
          rm.bannedCids = (rm.bannedCids || []).filter((x) => x !== targetCid);
          rm.kicked = (rm.kicked || []).filter((x) => x !== targetCid);
        }
        if (targetUid) {
          rm.bannedUids = (rm.bannedUids || []).filter((x) => x !== targetUid);
          rm.kickedUids = (rm.kickedUids || []).filter((x) => x !== targetUid);
          rm.kicked = (rm.kicked || []).filter((x) => x !== `uid:${targetUid}`);
        }
        pushEv({ type: "host_action", subAction: "unban", targetCid, targetUid }, { attachRoom: true });
      }
    } else if (subAct === "promote" && targetCid) {
      rm.co_hosts = Array.from(new Set([...(rm.co_hosts || []), targetCid]));
      pushEv({ type: "host_action", subAction: "promote", targetCid }, { attachRoom: true });
    } else if (subAct === "demote" && targetCid && targetCid !== rm.creatorCid) {
      rm.co_hosts = (rm.co_hosts || []).filter((x) => x !== targetCid);
      pushEv({ type: "host_action", subAction: "demote", targetCid }, { attachRoom: true });
    } else if (subAct === "toggle_cohost" && targetCid && targetCid !== rm.creatorCid) {
      const curList = rm.co_hosts || [];
      if (curList.includes(targetCid)) {
        rm.co_hosts = curList.filter((x) => x !== targetCid);
      } else {
        rm.co_hosts = Array.from(new Set([...curList, targetCid]));
      }
      pushEv({ type: "host_action", subAction: "toggle_cohost", targetCid }, { attachRoom: true });
    } else if (subAct === "transfer_host" && targetCid && rm.participants?.[targetCid] && !rm.curated) {
      const prevHostCid = rm.host_id;
      const prevCreatorCid = rm.creatorCid;
      const targetP = rm.participants[targetCid];
      rm.host_id = targetCid;
      rm.creatorCid = targetCid;
      rm.hostTransferred = true;
      rm.creatorUid = targetP?.verifiedUid ? String(targetP.verifiedUid).slice(0, 64) : "";
      if (targetP?.name) rm.creator = targetP.name;
      rm.co_hosts = Array.from(new Set([
        ...(rm.co_hosts || []).filter((x) => x !== prevHostCid && x !== prevCreatorCid),
        targetCid,
      ]));
      pushEv({ type: "host_action", subAction: "transfer_host", targetCid }, { attachRoom: true });
    } else if (subAct === "mute" && targetCid && rm.participants?.[targetCid]) {
      rm.participants[targetCid].muted = true;
      rm.participants[targetCid].speaking = false;
      rm.participants[targetCid].hostMutedAt = t;
      pushEv({ type: "host_action", subAction: "mute", targetCid }, { attachRoom: true });
    }
  } else if (act === "delete_msg") {
    const targetMsgId = String(body.msgId || body.id || "").trim().slice(0, 64);
    const chatArr = Array.isArray(rm.chat) ? rm.chat : [];
    const idx = targetMsgId ? chatArr.findIndex((m) => m && m.id === targetMsgId) : -1;
    if (idx >= 0) {
      const targetMsg = chatArr[idx];
      const callerVerifiedUid = String(opts.verifiedUid || (tokenVerified ? prevP?.verifiedUid : "") || "").trim();
      const isSender = Boolean(
        (targetMsg.cid && targetMsg.cid === cid) ||
        (callerVerifiedUid && targetMsg.verifiedUid && callerVerifiedUid === targetMsg.verifiedUid)
      );
      if (!tokenVerified || (!isPrivilegedInRoom(rm, cid) && !isSender)) {
        return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Bu mesajı silme yetkiniz yok.", rateLimitedError, pendingPassword };
      }
      chatArr.splice(idx, 1);
      rm.chat = chatArr;
      pushEv({ type: "msg_deleted", msgId: targetMsgId });
    }
  } else if (act === "clear_chat") {
    if (rm.curated) {
      return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "7/24 canlı yayın odalarında sohbet geçmişi silinemez.", rateLimitedError, pendingPassword };
    }
    if (!tokenVerified || !isPrivilegedInRoom(rm, cid)) {
      return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError: "Sohbeti temizleme yetkisi yok.", rateLimitedError, pendingPassword };
    }
    rm.chat = [];
    rm.chatClearedAt = t;
    pushEv({ type: "chat_cleared", chatClearedAt: rm.chatClearedAt });
  } else if (act === "profile_update") {
    const pCur = rm.participants[cid] || {};
    const safePart = {
      ...pCur,
      country: pCur.hideLocation ? "" : (pCur.country || ""),
      friendsPreview: pCur.hideFriends ? [] : (Array.isArray(pCur.friendsPreview) ? pCur.friendsPreview : []),
      isHost: !rm.curated && cid === rm.host_id,
      isCoHost: !rm.curated && (rm.co_hosts || []).includes(cid),
      isCreator: !rm.curated && cid === rm.creatorCid,
    };
    pushEv({ type: "profile_updated", cid, profile: safePart, participant: safePart }, { attachRoom: true });
  } else if (act === "reaction" || act === "typing" || act === "soundfx") {
    const actId = String(body.actionId || "").trim().slice(0, 64);
    const validSfx = ["clap", "laugh", "suspense", "fanfare"].includes(String(body.sfx || "")) ? String(body.sfx) : "fanfare";
    pushEv({ ...(actId ? { id: actId } : {}), type: act, emoji: String(body.emoji || "❤️").slice(0, 16), typing: Boolean(body.typing), ...(act === "soundfx" ? { sfx: validSfx } : {}) });
  } else if (["webrtc_offer", "webrtc_answer", "webrtc_ice"].includes(act) && body.targetId) {
    const sig = {
      id: String(body.signalId || `sg_${Date.now()}_${makeHexNonce(3)}`).slice(0, 64),
      type: act,
      fromId: cid,
      targetId: String(body.targetId).slice(0, 64),
      sdp: body.sdp,
      candidate: body.candidate,
      ts: t,
    };
    const freshSigs = (rm.signals || []).filter((s) => s && (t - Number(s.ts || 0)) < 25);
    rm.signals = [...freshSigs.slice(-179), sig];
    rm.rev = (rm.rev || 1) + 1;
    privateSignals.push(sig);
    dirty = true;
  }
  if (dirty) rm.updatedAt = t;
  return { dirty, pushedEvents, privateSignals, kickedTargets, roomClosed, forbiddenError, rateLimitedError, pendingPassword };
}

function serializeRoomInfo(rm, tokenVerified = false) {
  const isCur = Boolean(rm.curated);
  const mediaOut = buildMediaOut(rm);
  const hasPw = Boolean(!isCur && (rm.passwordHash || rm.password));
  const shouldMask = !isCur && (rm.privacy === "private" || rm.privacy === "friends" || hasPw) && !tokenVerified;
  const parts = Object.values(rm.participants || {});
  const safeMedia = shouldMask
    ? {
        title: mediaOut.title || "",
        poster: mediaOut.poster || "",
        thumbnail: mediaOut.thumbnail || "",
        mediaType: mediaOut.mediaType || "movie",
        playing: Boolean(mediaOut.playing),
        live: Boolean(mediaOut.live),
        url: "",
        embedUrl: "",
        altUrls: [],
      }
    : mediaOut;
  return {
    id: rm.id,
    name: rm.name,
    rawName: rm.rawName || rm.name,
    customName: Boolean(rm.customName),
    privacy: rm.privacy || "public",
    playMode: rm.playMode || "leader",
    voipMode: rm.voipMode || "all",
    isMature: Boolean(rm.isMature),
    locked: Boolean(!isCur && rm.locked),
    hideWatching: Boolean(!isCur && rm.hideWatching),
    hideLocation: Boolean(!isCur && rm.hideLocation),
    hideFriends: Boolean(!isCur && rm.hideFriends),
    hasPassword: hasPw,
    creator: rm.creator || "Misafir",
    curated: isCur,
    rev: rm.rev || 1,
    participantCount: parts.length,
    count: parts.length,
    participants: shouldMask
      ? []
      : parts.map((p) => ({
          ...p,
          country: p.hideLocation ? "" : (p.country || ""),
          friendsPreview: p.hideFriends ? [] : (Array.isArray(p.friendsPreview) ? p.friendsPreview : []),
          isHost: !isCur && p.id === rm.host_id,
          isCoHost: !isCur && (rm.co_hosts || []).includes(p.id),
          isCreator: !isCur && p.id === rm.creatorCid,
        })),
    media: safeMedia,
  };
}

export class WatchlivoRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.sockets = new Map();
    this.voiceRelay = [];
    this.memKv = new Map();
  }

  async _load(roomId, seed = null, curatedSeed = null) {
    let healed = false;
    if (!this.room) {
      let stored = await this.state.storage.get("room");
      if (!stored && this.env?.ROOMS_DB) {
        const d1Rec = await d1GetRoomRecord(this.env, roomId);
        if (d1Rec?.rm && !d1Rec.closed) {
          stored = d1Rec.rm;
          healed = true;
        }
      }
      if (stored) {
        this.room = stored;
      } else if (seed) {
        this.room = seed;
      } else if (curatedSeed) {
        this.room = makeRoomSkeleton(roomId, curatedSeed);
        healed = true;
      } else {
        return null;
      }
    }
    if (curatedSeed && reconcileCuratedRoom(this.room, curatedSeed)) {
      healed = true;
    }
    if (healed) {
      await this._save();
    }
    return this.room;
  }

  async _save() {
    if (this.room) await this.state.storage.put("room", this.room);
  }

  _broadcast(pkt, excludeWs = null) {
    const str = JSON.stringify(pkt);
    for (const [ws] of this.sockets.entries()) {
      if (ws === excludeWs) continue;
      try { ws.send(str); } catch { this.sockets.delete(ws); }
    }
  }

  _unicast(targetCid, pkt) {
    const str = JSON.stringify(pkt);
    for (const [ws, meta] of this.sockets.entries()) {
      if (meta?.cid !== targetCid) continue;
      try { ws.send(str); } catch { this.sockets.delete(ws); }
    }
  }

  async _broadcastRoomEvent(rm, item, excludeWs = null) {
    if (!item?.attachRoom) {
      this._broadcast(item.ev, excludeWs);
      return;
    }
    for (const [ws, meta] of this.sockets.entries()) {
      if (ws === excludeWs) continue;
      try {
        const scopedRoom = await serializeEdgeRoom(rm, meta?.cid || "", this.env);
        ws.send(JSON.stringify({ ...item.ev, room: scopedRoom }));
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  _ejectKickedSockets(roomId, targetCids) {
    if (!Array.isArray(targetCids) || !targetCids.length) return;
    const kickSet = new Set(targetCids.map((x) => String(x || "")));
    const payload = JSON.stringify({ type: "kicked", roomId });
    for (const [ws, meta] of this.sockets.entries()) {
      const uidKey = meta?.verifiedUid ? `uid:${String(meta.verifiedUid).trim().toLowerCase()}` : "";
      if (!kickSet.has(meta?.cid) && !(uidKey && kickSet.has(uidKey))) continue;
      try { ws.send(payload); } catch {}
      try { ws.close(4008, "kicked"); } catch {}
      this.sockets.delete(ws);
    }
  }

  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === "/__kv") {
      const b = await request.json().catch(() => ({}));
      const op = String(b.op || "");
      const key = String(b.key || "").slice(0, 512);
      const ephemeral = Boolean(b.ephemeral);
      const nowS = Math.floor(Date.now() / 1000);
      if (!key) return Response.json({ ok: false, error: "missing_key" }, { status: 400 });
      if (ephemeral) {
        if (op === "get") {
          const rec = this.memKv.get(key);
          if (!rec) return Response.json({ ok: true, found: false, value: null });
          if (rec.exp && rec.exp > 0 && rec.exp < nowS) {
            this.memKv.delete(key);
            return Response.json({ ok: true, found: false, value: null });
          }
          return Response.json({ ok: true, found: true, deleted: Boolean(rec.d), value: rec.d ? null : rec.v });
        }
        if (op === "put") {
          const ttl = Number(b.ttl || 0);
          const exp = ttl > 0 ? nowS + Math.round(ttl) : nowS + 3600;
          if (this.memKv.size > 4000) {
            for (const [mk, mv] of this.memKv.entries()) {
              if (!mv?.exp || mv.exp < nowS) this.memKv.delete(mk);
              if (this.memKv.size <= 3000) break;
            }
          }
          this.memKv.set(key, { v: String(b.value ?? ""), exp, d: false });
          return Response.json({ ok: true });
        }
        if (op === "delete" || op === "tombstone") {
          this.memKv.set(key, { v: null, exp: nowS + 3600, d: true });
          return Response.json({ ok: true });
        }
        return Response.json({ ok: false, error: "bad_op" }, { status: 400 });
      }
      const sKey = `kv:${key}`;
      if (op === "get") {
        const rec = await this.state.storage.get(sKey);
        if (!rec || typeof rec !== "object") {
          return Response.json({ ok: true, found: false, deleted: false, value: null });
        }
        if (rec.exp && rec.exp > 0 && rec.exp < nowS) {
          await this.state.storage.delete(sKey).catch(() => {});
          return Response.json({ ok: true, found: false, deleted: false, value: null });
        }
        return Response.json({ ok: true, found: true, deleted: Boolean(rec.d), value: rec.d ? null : (rec.v ?? null) });
      }
      if (op === "put") {
        const ttl = Number(b.ttl || 0);
        const exp = ttl > 0 ? nowS + Math.round(ttl) : 0;
        await this.state.storage.put(sKey, { v: String(b.value ?? ""), exp, d: false });
        return Response.json({ ok: true });
      }
      if (op === "delete" || op === "tombstone") {
        await this.state.storage.put(sKey, { v: null, exp: 0, d: true });
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "bad_op" }, { status: 400 });
    }
    const roomId = u.searchParams.get("roomId") || "room";
    const headerSeed = parseTrustedSeedHeader(request);

    if (u.pathname === "/info") {
      const curatedSeed = getCuratedSeed(roomId, null, headerSeed);
      if (curatedSeed) {
        await this.state.storage.delete("closed").catch(() => {});
        const stored = this.room || (await this.state.storage.get("room"));
        if (stored) {
          this.room = stored;
          const healed = reconcileCuratedRoom(this.room, curatedSeed);
          const pruned = pruneStaleParticipants(this.room, this._activeWsCids());
          if (healed || pruned) await this._save();
          return Response.json({ ok: true, room: serializeRoomInfo(this.room, true) });
        }
        return Response.json({ ok: true, room: serializeRoomInfo(makeRoomSkeleton(roomId, curatedSeed), true) });
      }
      const closedMark = await this.state.storage.get("closed");
      if (closedMark) {
        return Response.json({ ok: false, error: "Bu oda artık mevcut değil", roomClosed: true }, { status: 410 });
      }
      const rm = await this._load(roomId, null, null);
      if (!rm) {
        return Response.json({ ok: false, error: "Bu oda artık mevcut değil" }, { status: 404 });
      }
      this.room = rm;
      const pruned = pruneStaleParticipants(this.room, this._activeWsCids());
      if (pruned) await this._save();
      const cid = String(u.searchParams.get("clientId") || "");
      const suppliedTok = String(u.searchParams.get("clientToken") || "").trim();
      const tokVerified = Boolean(cid && suppliedTok && (await verifyRoomClientToken(suppliedTok, roomId, cid, this.env)));
      if (this.room.privacy === "friends") {
        const verifiedUid = await resolveRoomCallerUid(request, this.env, null, u);
        const allowed = await hasFriendsRoomAccess(this.room, {
          cid,
          tokenVerified: tokVerified,
          verifiedUid,
          validSyncToken: false,
          env: this.env,
          isInfo: true,
        });
        if (!allowed) {
          return Response.json({ ok: false, error: "friends_only", message: "Bu oda yalnızca arkadaşlara açıktır." }, { status: 403 });
        }
      }
      return Response.json({ ok: true, room: serializeRoomInfo(this.room, tokVerified) });
    }

    if (u.pathname === "/voice-relay") {
      const closedMark = await this.state.storage.get("closed");
      if (closedMark) {
        return Response.json({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, { status: 410 });
      }
      const stored = this.room || (await this.state.storage.get("room"));
      const curatedSeed = getCuratedSeed(roomId, null, headerSeed);
      if (stored) this.room = stored;
      const rmInfo = this.room || (curatedSeed ? makeRoomSkeleton(roomId, curatedSeed) : null);
      if (!rmInfo) {
        return Response.json({ ok: false, error: "Oda bulunamadı" }, { status: 404 });
      }
      const b = request.method === "POST" ? await request.json().catch(() => null) : null;
      const cidRaw = String((request.method === "POST" ? b?.clientId : u.searchParams.get("clientId")) || "");
      const cid = /^[a-zA-Z0-9_-]{1,64}$/.test(cidRaw) ? cidRaw : "";
      const ctok = String((request.method === "POST" ? b?.clientToken : u.searchParams.get("clientToken")) || "").trim();
      if (!cid || !ctok || !(await verifyRoomClientToken(ctok, roomId, cid, this.env))) {
        return Response.json({ ok: false, error: "Yetkisiz istemci" }, { status: 403 });
      }
      const tNow = nowSec();
      if (String(rmInfo.voipMode || "all") === "off") {
        if (request.method === "GET") return Response.json({ ok: true, serverTime: Math.round(tNow * 10000) / 10000, packets: [] });
        return Response.json({ ok: false, error: "Ses kanalı kapalı" }, { status: 403 });
      }
      this.voiceRelay = (Array.isArray(this.voiceRelay) ? this.voiceRelay : []).filter((p) => p && (tNow - Number(p.ts || 0)) < 10.0);
      if (request.method === "POST") {
        if (!canUserSpeakOrStream(rmInfo, cid)) {
          return Response.json({ ok: false, error: "Bu modda ses gönderme yetkiniz yok" }, { status: 403 });
        }
        const b64 = String(b?.b64 || "").replace(/\s+/g, "");
        if (!b64 || b64.length > 80000) return Response.json({ ok: false, error: "Geçersiz ses paketi" }, { status: 400 });
        const seq = Math.max(0, Math.min(999999999, Number(b?.seq || 0) || 0));
        let mime = String(b?.mime || "audio/wav").trim().slice(0, 32);
        if (!mime.startsWith("audio/")) mime = "audio/wav";
        const pkt = { id: `${cid}_${seq}_${Date.now()}`, fromId: cid, seq, ts: Math.round(tNow * 10000) / 10000, mime, b64 };
        this.voiceRelay.push(pkt);
        if (this.voiceRelay.length > 64) this.voiceRelay = this.voiceRelay.slice(-64);
        return Response.json({ ok: true, ts: pkt.ts });
      }
      const sinceTs = Number(u.searchParams.get("sinceTs") || 0) || 0;
      const outPkts = this.voiceRelay.filter((p) => p.fromId !== cid && Number(p.ts || 0) > sinceTs);
      return Response.json({ ok: true, serverTime: Math.round(tNow * 10000) / 10000, packets: outPkts });
    }

    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const curatedSeed = getCuratedSeed(roomId, null, headerSeed);
      if (curatedSeed) {
        await this.state.storage.delete("closed").catch(() => {});
      } else {
        const closedMark = await this.state.storage.get("closed");
        if (closedMark) {
          const cpair = new WebSocketPair();
          const [cClient, cServer] = Object.values(cpair);
          cServer.accept();
          cServer.send(JSON.stringify({ type: "room_closed", roomId, roomClosed: true, error: "Oda kapatıldı." }));
          try { cServer.close(4010, "room_closed"); } catch {}
          return new Response(null, { status: 101, webSocket: cClient });
        }
      }
      const existingRm = await this._load(roomId, null, curatedSeed);
      const restoredSeed = !existingRm && !curatedSeed ? await tryRestoreSyncToken(roomId, u.searchParams.get("syncToken"), this.env) : null;
      const rm = existingRm || (restoredSeed ? await this._load(roomId, restoredSeed, null) : null);
      if (!rm) {
        if (typeof WebSocketPair !== "undefined") {
          const nfPair = new WebSocketPair();
          const [nfClient, nfServer] = Object.values(nfPair);
          nfServer.accept();
          nfServer.send(JSON.stringify({ type: "room_closed", roomId, roomClosed: false, roomNotFound: true, error: "Bu oda artık mevcut değil" }));
          try { nfServer.close(4010, "room_not_found"); } catch {}
          return new Response(null, { status: 101, webSocket: nfClient });
        }
        return Response.json({ ok: false, error: "Bu oda artık mevcut değil", roomNotFound: true }, { status: 404 });
      }
      const verifiedUid = await resolveRoomCallerUid(request, this.env, null, u);
      const rawUid = String(u.searchParams.get("uid") || "").trim().slice(0, 64);
      const blockUid = verifiedUid || rawUid;
      const wsCidEarly = u.searchParams.get("clientId") || "";
      const wsTokEarly = u.searchParams.get("clientToken") || "";
      const wsTrusted = Boolean(
        wsCidEarly && wsTokEarly &&
        (rm.participants?.[wsCidEarly] || isHostOrCreator(rm, wsCidEarly)) &&
        (await verifyRoomClientToken(wsTokEarly, roomId, wsCidEarly, this.env))
      );
      const pwdOk = curatedSeed || rm.curated || wsTrusted ? true : await verifyRoomPassword(rm, u.searchParams.get("pwd") || "");
      if (!pwdOk) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.send(JSON.stringify({ type: "password_required", error: "Oda şifresi gerekli." }));
        try { server.close(4003, "password_required"); } catch {}
        return new Response(null, { status: 101, webSocket: client });
      }

      const origCid = u.searchParams.get("clientId") || "";
      let cid = origCid || `h_${makeHexNonce(4)}`;
      const suppliedTok = u.searchParams.get("clientToken") || "";
      let tokVerified = await verifyRoomClientToken(suppliedTok, roomId, cid, this.env);
      const kbCheck = getKickBanStatus(rm, origCid || cid, blockUid);
      if (kbCheck.banned) {
        return Response.json({ ok: false, error: "kicked", banned: true, message: "Bu odadan yasaklandınız." }, { status: 403 });
      }
      if (kbCheck.kicked) {
        return new Response("Kicked", { status: 410 });
      }
      if (!rm.curated && rm.privacy === "friends") {
        const allowed = await hasFriendsRoomAccess(rm, {
          cid,
          tokenVerified: tokVerified,
          verifiedUid,
          validSyncToken: Boolean(restoredSeed),
          env: this.env,
          isInfo: false,
        });
        if (!allowed) {
          return Response.json({ ok: false, error: "friends_only", message: "Bu oda yalnızca arkadaşlara açıktır." }, { status: 403 });
        }
      }
      const isExistingOrCreator = Boolean(
        (tokVerified && (rm.participants?.[cid] || isHostOrCreator(rm, cid) || (rm.co_hosts || []).includes(cid))) ||
        restoredSeed ||
        (verifiedUid && rm.creatorUid && verifiedUid.toLowerCase() === String(rm.creatorUid).toLowerCase())
      );
      if (rm.locked && !rm.curated && !isExistingOrCreator) {
        return Response.json({ ok: false, error: "room_locked", message: "Oda kilitli." }, { status: 403 });
      }
      if (!tokVerified && isCidOccupiedOrReferenced(rm, cid)) {
        do {
          cid = `h_${makeHexNonce(4)}`;
        } while (isCidOccupiedOrReferenced(rm, cid));
      }
      if (getKickBanStatus(rm, cid, blockUid).kicked) {
        return new Response("Kicked", { status: 410 });
      }
      const uname = u.searchParams.get("username") || u.searchParams.get("name") || "Misafir";
      const pruned = pruneStaleParticipants(rm, this._activeWsCids());
      const initAct = applyRoomAction(rm, cid, {
        type: "init",
        username: uname,
        uid: blockUid,
        handle: u.searchParams.get("handle") || "",
        avatarUrl: u.searchParams.get("avatarUrl") || "",
        bio: u.searchParams.get("bio") || "",
        statusText: u.searchParams.get("statusText") || "",
        statusEmoji: u.searchParams.get("statusEmoji") || "🍿",
        medal: u.searchParams.get("medal") || "",
        watchMinutes: Number(u.searchParams.get("watchMinutes") || 0) || 0,
        hideWatching: u.searchParams.get("hideWatching") === "1" || u.searchParams.get("hideWatching") === "true" ? true : undefined,
        hideFriends: u.searchParams.get("hideFriends") === "1" || u.searchParams.get("hideFriends") === "true" ? true : undefined,
        hideLocation: u.searchParams.get("hideLocation") === "1" || u.searchParams.get("hideLocation") === "true" ? true : undefined,
        device: u.searchParams.get("device") || "Web",
        country: u.searchParams.get("country") || "TR",
        color: u.searchParams.get("color") || "#27DCC8",
      }, { tokenVerified: true, verifiedUid });
      if (initAct.dirty || pruned) await this._save();

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(server, { cid, uid: blockUid, verifiedUid, uname });
      const initTok = tokVerified ? suppliedTok : await signRoomClientToken(roomId, cid, this.env);
      tokVerified = true;
      const roomPayload = await serializeEdgeRoom(rm, cid, this.env);
      server.send(JSON.stringify({ type: "init", clientId: cid, clientToken: initTok, serverTime: nowSec(), room: roomPayload }));
      await this._broadcastRoomEvent(rm, { attachRoom: true, ev: { type: "user_joined", user: { id: cid, name: uname } } }, server);
      for (const item of initAct.pushedEvents || []) {
        await this._broadcastRoomEvent(rm, item, server);
      }

      server.addEventListener("message", async (ev) => {
        const kbMsg = getKickBanStatus(rm, cid, rm.participants?.[cid]?.verifiedUid || blockUid);
        if (kbMsg.blocked) {
          try { server.send(JSON.stringify({ type: "kicked", roomId, banned: kbMsg.banned })); } catch {}
          try { server.close(4008, "kicked"); } catch {}
          this.sockets.delete(server);
          return;
        }
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "ping") {
          const tNow = nowSec();
          if (rm.participants?.[cid]) {
            rm.participants[cid].lastSeen = tNow;
          }
          server.send(JSON.stringify({ type: "pong", t0: msg.t0, t0Epoch: msg.t0Epoch, serverTime: tNow }));
          if (rm.privacy === "public" && (!rm._lastIdxSync || tNow - rm._lastIdxSync > 45)) {
            rm._lastIdxSync = tNow;
            await syncPublicRoomIndex(roomId, await serializeEdgeRoom(rm, "", this.env), this.env);
          }
          return;
        }
        if (msg.type === "close_room") {
          if (curatedSeed || rm.curated || !tokVerified || !isHostOrCreator(rm, cid)) {
            const errTxt = "Sadece oda kurucusu odayı kapatabilir.";
            server.send(JSON.stringify({ type: "error", error: errTxt, message: errTxt }));
            return;
          }
          await this._closeRoom(roomId);
          return;
        }
        const pr = pruneStaleParticipants(rm, this._activeWsCids());
        const res = applyRoomAction(rm, cid, msg, { tokenVerified: true, verifiedUid });
        if (res.pendingPassword !== undefined) {
          await setRoomPassword(rm, res.pendingPassword);
        }
        if (res.dirty || pr || res.pendingPassword !== undefined) await this._save();
        if (res.kickedTargets?.length) {
          this._ejectKickedSockets(roomId, res.kickedTargets);
        }
        if (res.forbiddenError) {
          server.send(JSON.stringify({ type: "error", error: res.forbiddenError, message: res.forbiddenError }));
          return;
        }
        if (res.rateLimitedError) {
          server.send(JSON.stringify({ type: "error", error: "rate_limited", message: res.rateLimitedError }));
          return;
        }
        if (msg.type === "leave" || msg.type === "host_action" || pr) {
          await syncPublicRoomIndex(roomId, await serializeEdgeRoom(rm, "", this.env), this.env);
        }
        for (const item of res.pushedEvents) {
          const echoToSender = ["chat", "chat_cleared", "msg_deleted", "profile_updated", "poll_updated", "msg_reacted", "queue_updated", "vote_updated", "skip_votes", "hand_raised", "host_action", "media_changed"].includes(item.ev.type);
          await this._broadcastRoomEvent(rm, item, echoToSender ? null : server);
        }
        for (const sig of res.privateSignals) {
          this._unicast(sig.targetId, sig);
        }
      });
      server.addEventListener("close", async () => {
        this.sockets.delete(server);
        const closedMark = await this.state.storage.get("closed").catch(() => false);
        if (closedMark || !this.room) return;
        const res = applyRoomAction(rm, cid, { type: "leave" }, { tokenVerified: true, verifiedUid });
        await this._save();
        await syncPublicRoomIndex(roomId, await serializeEdgeRoom(rm, "", this.env), this.env);
        await this._broadcastRoomEvent(rm, { attachRoom: true, ev: { type: "user_left", user: { id: cid, name: uname } } }, null);
        for (const item of res?.pushedEvents || []) {
          await this._broadcastRoomEvent(rm, item, null);
        }
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (u.pathname === "/create") {
      let rawBody = null;
      if (request.method === "POST") {
        const rawText = await request.text().catch(() => "");
        if (!rawText || !rawText.trim()) {
          return Response.json({ ok: false, error: "invalid_json", message: "Geçersiz oda oluşturma verisi." }, { status: 400 });
        }
        try {
          rawBody = JSON.parse(rawText);
        } catch {
          return Response.json({ ok: false, error: "invalid_json", message: "Geçersiz JSON verisi." }, { status: 400 });
        }
      }
      if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return Response.json({ ok: false, error: "invalid_json", message: "Oda oluşturma verisi bir JSON nesnesi olmalıdır." }, { status: 400 });
      }
      const { curated: _sCur, __curatedSeed: _sSeed, ...createBody } = rawBody;
      const verifiedUid = await resolveRoomCallerUid(request, this.env, createBody, u);
      const creatorUid = verifiedUid || String(createBody.creatorUid || createBody.creatorId || createBody.uid || "").trim().slice(0, 64);
      await this.state.storage.delete("closed");
      this.room = makeRoomSkeleton(roomId, { ...createBody, creatorUid, curated: false });
      await setRoomPassword(this.room, String(createBody.password || "").trim());
      applyRoomAction(this.room, this.room.creatorCid, {
        type: "init",
        username: this.room.creator,
        uid: this.room.creatorUid || createBody.uid || "",
        handle: createBody.handle || "",
        avatarUrl: createBody.avatarUrl || "",
        bio: createBody.bio || "",
        statusText: createBody.statusText || "",
        statusEmoji: createBody.statusEmoji || "🍿",
        medal: createBody.medal || "",
        watchMinutes: Number(createBody.watchMinutes || 0) || 0,
        hideWatching: Boolean(createBody.hideWatching),
        hideFriends: Boolean(createBody.hideFriends),
        hideLocation: Boolean(createBody.hideLocation),
        friendsPreview: createBody.friendsPreview,
        device: createBody.device || "Web",
        country: createBody.hideLocation ? "" : (createBody.country || "TR"),
        color: createBody.color || "#27DCC8",
      }, { initialDirty: true, tokenVerified: true, verifiedUid });
      await this._save();
      const cid = this.room.creatorCid;
      const clientToken = await signRoomClientToken(roomId, cid, this.env);
      return Response.json({ ok: true, clientId: cid, clientToken, room: await serializeEdgeRoom(this.room, cid, this.env) });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const bodySeed = (body.__curatedSeed && (body.__curatedSeed.id === roomId || body.__curatedSeed.id === normalizeCuratedRoomId(roomId)) && body.__curatedSeed.curated) ? body.__curatedSeed : null;
    delete body.__curatedSeed;
    const curatedSeed = getCuratedSeed(roomId, null, bodySeed || headerSeed);

    if (curatedSeed) {
      await this.state.storage.delete("closed").catch(() => {});
    } else {
      const closedMark = await this.state.storage.get("closed");
      if (closedMark) {
        return Response.json({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, { status: 410 });
      }
    }
    const existingRm = await this._load(roomId, null, curatedSeed);
    const restoredSeed = !existingRm && !curatedSeed ? await tryRestoreSyncToken(roomId, body.syncToken, this.env) : null;
    const rm = existingRm || (restoredSeed ? await this._load(roomId, restoredSeed, null) : null);
    if (!rm) {
      return Response.json({ ok: false, error: "Bu oda artık mevcut değil", roomNotFound: true }, { status: 404 });
    }
    const verifiedUid = await resolveRoomCallerUid(request, this.env, body, u);
    const blockUid = verifiedUid || String(body.uid || "").trim().slice(0, 64);
    const origCid = String(body.clientId || "");
    let cid = origCid || `h_${makeHexNonce(4)}`;
    const suppliedTok = String(body.clientToken || "").trim();
    const tokenVerified = await verifyRoomClientToken(suppliedTok, roomId, cid, this.env);
    const pwTrustedMember = Boolean(tokenVerified && (rm.participants?.[cid] || isHostOrCreator(rm, cid)));
    if (!curatedSeed && !rm.curated && !pwTrustedMember && !(await verifyRoomPassword(rm, body.pwd || ""))) {
      return Response.json({ ok: false, error: "password_required", message: "Oda şifresi hatalı." }, { status: 403 });
    }
    const kb = getKickBanStatus(rm, origCid || cid, blockUid);
    if (kb.banned) {
      return Response.json({ ok: false, error: "kicked", banned: true, message: "Bu odadan yasaklandınız." }, { status: 403 });
    }
    if (kb.kicked) {
      return Response.json({ ok: false, error: "kicked" }, { status: 410 });
    }
    if (!rm.curated && rm.privacy === "friends") {
      const allowed = await hasFriendsRoomAccess(rm, {
        cid,
        tokenVerified,
        verifiedUid,
        validSyncToken: Boolean(restoredSeed),
        env: this.env,
        isInfo: false,
      });
      if (!allowed) {
        return Response.json({ ok: false, error: "friends_only", message: "Bu oda yalnızca arkadaşlara açıktır." }, { status: 403 });
      }
    }
    const isExistingOrCreator = Boolean(
      (tokenVerified && (rm.participants?.[cid] || isHostOrCreator(rm, cid) || (rm.co_hosts || []).includes(cid))) ||
      restoredSeed ||
      (verifiedUid && rm.creatorUid && verifiedUid.toLowerCase() === String(rm.creatorUid).toLowerCase())
    );
    if (rm.locked && !rm.curated && !isExistingOrCreator) {
      return Response.json({ ok: false, error: "room_locked", message: "Oda kilitli." }, { status: 403 });
    }
    if (!tokenVerified && isCidOccupiedOrReferenced(rm, cid)) {
      do {
        cid = `h_${makeHexNonce(4)}`;
      } while (isCidOccupiedOrReferenced(rm, cid));
    }
    if (getKickBanStatus(rm, cid, blockUid).kicked) {
      return Response.json({ ok: false, error: "kicked" }, { status: 410 });
    }
    if (body.type === "close_room") {
      if (curatedSeed || rm.curated || !tokenVerified || !isHostOrCreator(rm, cid)) {
        return Response.json({ ok: false, error: curatedSeed || rm.curated ? "Sabit 7/24 odalar kapatılamaz." : "Sadece oda kurucusu odayı kapatabilir." }, { status: 403 });
      }
      await this._closeRoom(roomId);
      return Response.json({ ok: true, roomClosed: true });
    }

    const pruned = pruneStaleParticipants(rm, this._activeWsCids());
    const res = applyRoomAction(rm, cid, body, { tokenVerified, verifiedUid });
    if (res.pendingPassword !== undefined) {
      await setRoomPassword(rm, res.pendingPassword);
    }
    if (res.dirty || pruned || res.pendingPassword !== undefined) await this._save();
    if (res.kickedTargets?.length) {
      this._ejectKickedSockets(roomId, res.kickedTargets);
    }
    if (res.forbiddenError) {
      return Response.json({ ok: false, error: res.forbiddenError, message: res.forbiddenError }, { status: 403 });
    }
    if (res.rateLimitedError) {
      return Response.json({ ok: false, error: "rate_limited", message: res.rateLimitedError }, { status: 429 });
    }
    for (const item of res.pushedEvents) {
      await this._broadcastRoomEvent(rm, item, null);
    }
    for (const sig of res.privateSignals) {
      this._unicast(sig.targetId, sig);
    }
    const tSyncNow = nowSec();
    let idxNeedsRefresh = false;
    if (rm.privacy === "public" && (!rm._lastIdxSync || tSyncNow - rm._lastIdxSync > 45)) {
      rm._lastIdxSync = tSyncNow;
      idxNeedsRefresh = true;
    }
    const clientToken = tokenVerified ? suppliedTok : await signRoomClientToken(roomId, cid, this.env);
    return Response.json({ ok: true, clientId: cid, clientToken, pruned: Boolean(pruned), idxNeedsRefresh, serverTime: tSyncNow, room: await serializeEdgeRoom(rm, cid, this.env) });
  }

  _activeWsCids() {
    const s = new Set();
    for (const meta of this.sockets.values()) {
      if (meta?.cid) s.add(meta.cid);
    }
    return s;
  }

  async _closeRoom(roomId) {
    if (this.room?.curated || DEFAULT_CURATED_MAP.has(normalizeCuratedRoomId(roomId))) {
      return false;
    }
    this._broadcast({ type: "room_closed", roomId });
    for (const [ws] of this.sockets.entries()) {
      try { ws.close(4010, "room_closed"); } catch {}
    }
    this.sockets.clear();
    await this.state.storage.delete("room");
    await this.state.storage.put("closed", true);
    this.room = null;
    if (this.env?.WATCHLIVO_KV) {
      await this.env.WATCHLIVO_KV.put(`room_closed:${roomId}`, "1", { expirationTtl: 3600 }).catch(() => {});
      await removePublicRoomIndex(roomId, this.env);
    }
    return true;
  }
}

let _d1RoomsSchemaReady = false;
let _d1RoomsSchemaPromise = null;

async function ensureD1RoomsSchema(env) {
  const db = env?.ROOMS_DB;
  if (!db) return false;
  if (_d1RoomsSchemaReady) return true;
  if (!_d1RoomsSchemaPromise) {
    _d1RoomsSchemaPromise = db
      .prepare("CREATE TABLE IF NOT EXISTS edge_rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)")
      .run()
      .then(() => { _d1RoomsSchemaReady = true; return true; })
      .catch(() => false)
      .finally(() => { _d1RoomsSchemaPromise = null; });
  }
  return await _d1RoomsSchemaPromise;
}

async function d1GetRoomRecord(env, roomId) {
  if (!env?.ROOMS_DB || !roomId) return null;
  if (!(await ensureD1RoomsSchema(env))) return null;
  try {
    const row = await env.ROOMS_DB.prepare("SELECT data, closed, updated_at FROM edge_rooms WHERE id = ?").bind(roomId).first();
    if (!row) return null;
    if (Number(row.closed || 0) === 1) {
      const closedAge = Math.floor(nowSec()) - Number(row.updated_at || 0);
      if (closedAge < 3600) return { rm: null, closed: true };
      return null;
    }
    const age = Math.floor(nowSec()) - Number(row.updated_at || 0);
    if (age > 43200) return null;
    const parsed = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (parsed && typeof parsed === "object") return { rm: parsed, closed: false };
  } catch {}
  return null;
}

async function d1PutRoom(env, roomId, rm) {
  if (!env?.ROOMS_DB || !roomId || !rm) return false;
  if (!(await ensureD1RoomsSchema(env))) return false;
  try {
    const t = Math.floor(nowSec());
    await env.ROOMS_DB
      .prepare("INSERT INTO edge_rooms (id, data, closed, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, closed = 0, updated_at = excluded.updated_at")
      .bind(roomId, JSON.stringify(rm), t)
      .run();
    return true;
  } catch {
    return false;
  }
}

async function d1MarkRoomClosed(env, roomId) {
  if (!env?.ROOMS_DB || !roomId) return false;
  if (!(await ensureD1RoomsSchema(env))) return false;
  try {
    const t = Math.floor(nowSec());
    await env.ROOMS_DB
      .prepare("INSERT INTO edge_rooms (id, data, closed, updated_at) VALUES (?, '{}', 1, ?) ON CONFLICT(id) DO UPDATE SET data = '{}', closed = 1, updated_at = excluded.updated_at")
      .bind(roomId, t)
      .run();
    return true;
  } catch {
    return false;
  }
}

async function d1ClearRoomClosed(env, roomId) {
  if (!env?.ROOMS_DB || !roomId) return;
  if (!(await ensureD1RoomsSchema(env))) return;
  try {
    await env.ROOMS_DB.prepare("DELETE FROM edge_rooms WHERE id = ? AND closed = 1").bind(roomId).run();
  } catch {}
}

export async function listGlobalPublicRooms(env) {
  if (env?.ROOMS_DB) {
    const rec = await d1GetRoomRecord(env, "__public_index__");
    if (rec?.rm && Array.isArray(rec.rm)) return rec.rm;
  }
  if (env?.WATCHLIVO_KV) {
    const kvIdx = await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null);
    if (Array.isArray(kvIdx)) return kvIdx;
  }
  return [];
}

async function saveGlobalPublicRooms(env, list) {
  if (env?.ROOMS_DB) {
    await d1PutRoom(env, "__public_index__", list);
  }
  if (env?.WATCHLIVO_KV) {
    await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(list), { expirationTtl: 21600 }).catch(() => {});
  }
}

async function removePublicRoomIndex(roomId, env) {
  if (!env?.ROOMS_DB && !env?.WATCHLIVO_KV) return;
  const idx = await listGlobalPublicRooms(env);
  const next = idx.filter((x) => x && x.id !== roomId);
  if (next.length !== idx.length) {
    await saveGlobalPublicRooms(env, next);
  }
}

async function syncPublicRoomIndex(roomId, serializedRoom, env) {
  if ((!env?.ROOMS_DB && !env?.WATCHLIVO_KV) || !serializedRoom) return;
  const idx = await listGlobalPublicRooms(env);
  const hasViewers = Number(serializedRoom.participantCount || 0) > 0;
  if (serializedRoom.privacy === "public" && (hasViewers || serializedRoom.curated)) {
    const summary = serializePublicSummary(serializedRoom);
    const filtered = [summary, ...idx.filter((x) => x && x.id !== roomId)].slice(0, 40);
    await saveGlobalPublicRooms(env, filtered);
  } else {
    const next = idx.filter((x) => x && x.id !== roomId);
    if (next.length !== idx.length) {
      await saveGlobalPublicRooms(env, next);
    }
  }
}

let _doQuotaExhaustedUntil = 0;
const _memFallbackRooms = new Map();
const _memClosedRooms = new Map();

function isDoQuotaOrTransientError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("exceeded allowed volume") ||
    msg.includes("durable object") ||
    msg.includes("free tier") ||
    msg.includes("overloaded") ||
    msg.includes("quota") ||
    msg.includes("rate limit")
  );
}

function noteDoFailure(err) {
  if (isDoQuotaOrTransientError(err)) {
    _doQuotaExhaustedUntil = Date.now() + 180_000;
  }
}

function canUseRoomDo(env) {
  return Boolean(env?.ROOM_DO) && Date.now() >= _doQuotaExhaustedUntil;
}

function memGetRoom(roomId) {
  const rec = _memFallbackRooms.get(roomId);
  if (!rec) return null;
  if (Date.now() - rec.ts > 43_200_000) {
    _memFallbackRooms.delete(roomId);
    return null;
  }
  return rec.rm;
}

function memSetRoom(roomId, rm) {
  if (!roomId || !rm) return;
  if (_memFallbackRooms.size >= 300 && !_memFallbackRooms.has(roomId)) {
    const oldest = _memFallbackRooms.keys().next().value;
    if (oldest !== undefined) _memFallbackRooms.delete(oldest);
  }
  _memFallbackRooms.set(roomId, { rm, ts: Date.now() });
}

function memIsClosed(roomId) {
  const exp = _memClosedRooms.get(roomId);
  if (!exp) return false;
  if (Date.now() > exp) {
    _memClosedRooms.delete(roomId);
    return false;
  }
  return true;
}

function memMarkClosed(roomId) {
  _memFallbackRooms.delete(roomId);
  _memClosedRooms.set(roomId, Date.now() + 3_600_000);
}

export function resetRoomDoQuotaGuardForTests() {
  _doQuotaExhaustedUntil = 0;
  _d1RoomsSchemaReady = false;
  _d1RoomsSchemaPromise = null;
  _memFallbackRooms.clear();
  _memClosedRooms.clear();
}

export async function handleEdgeRoomCreate(request, env, jsonResp) {
  const rawText = await request.text().catch(() => "");
  if (!rawText || !rawText.trim()) {
    return jsonResp({ ok: false, error: "invalid_json", message: "Geçersiz oda oluşturma verisi." }, 400);
  }
  let rawBody;
  try {
    rawBody = JSON.parse(rawText);
  } catch {
    return jsonResp({ ok: false, error: "invalid_json", message: "Geçersiz JSON verisi." }, 400);
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return jsonResp({ ok: false, error: "invalid_json", message: "Oda oluşturma verisi bir JSON nesnesi olmalıdır." }, 400);
  }
  const { curated: _spoofCurated, __curatedSeed: _spoofSeed, ...body } = rawBody;
  const roomId = generateOpaqueRoomId();
  const cid = String(body.clientId || `h_${makeHexNonce(4)}`);
  const verifiedUid = await resolveRoomCallerUid(request, env, body, new URL(request.url));
  const creatorUid = verifiedUid || String(body.creatorUid || body.creatorId || body.uid || "").trim().slice(0, 64);
  const createPayload = { ...body, clientId: cid, creatorUid, createdFromApi: true };
  let out = null;
  if (canUseRoomDo(env)) {
    try {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
      const doHdrs = await forwardEdgeAuthHeaders(request, verifiedUid, env, { "Content-Type": "application/json" });
      const r = await stub.fetch(`https://do.local/create?roomId=${encodeURIComponent(roomId)}`, { method: "POST", headers: doHdrs, body: JSON.stringify(createPayload) });
      if (r.ok) {
        out = await r.json();
      } else if (r.status === 400) {
        const errData = await r.json().catch(() => ({ ok: false, error: "invalid_json" }));
        return jsonResp(errData, 400);
      } else {
        const errTxt = await r.text().catch(() => "");
        noteDoFailure(errTxt || `do_${r.status}`);
      }
    } catch (err) {
      noteDoFailure(err);
    }
  }
  if (!out) {
    const rm = makeRoomSkeleton(roomId, createPayload);
    rm.createdFromApi = true;
    await setRoomPassword(rm, String(body.password || "").trim());
    applyRoomAction(rm, cid, {
      type: "init",
      username: rm.creator,
      uid: rm.creatorUid || body.uid || "",
      handle: body.handle || "",
      avatarUrl: body.avatarUrl || "",
      bio: body.bio || "",
      statusText: body.statusText || "",
      statusEmoji: body.statusEmoji || "🍿",
      medal: body.medal || "",
      watchMinutes: Number(body.watchMinutes || 0) || 0,
      hideWatching: Boolean(body.hideWatching),
      hideFriends: Boolean(body.hideFriends),
      hideLocation: Boolean(body.hideLocation),
      friendsPreview: body.friendsPreview,
      device: body.device || "Web",
      country: body.hideLocation ? "" : (body.country || "TR"),
      color: body.color || "#27DCC8",
    }, { initialDirty: true, tokenVerified: true, verifiedUid });
    memSetRoom(roomId, rm);
    await d1PutRoom(env, roomId, rm);
    if (env.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 }).catch(() => {});
    out = { ok: true, clientId: cid, clientToken: await signRoomClientToken(roomId, cid, env), room: await serializeEdgeRoom(rm, cid, env) };
  }
  if ((env.ROOMS_DB || env.WATCHLIVO_KV) && out?.room?.privacy === "public") {
    await syncPublicRoomIndex(roomId, out.room, env);
  }
  return jsonResp(out);
}

function parseRoomGetParams(request) {
  const sp = new URL(request.url).searchParams;
  const out = {};
  for (const [k, v] of sp.entries()) {
    if (k === "sinceRev" || k === "currentTime" || k === "rate") {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (k === "activeMedia") {
      try { out.activeMedia = JSON.parse(v); } catch {}
    } else {
      out[k] = v;
    }
  }
  return out;
}

const RESERVED_CURATED_ID_RE = /^(?:tv|radyo)-/i;

export async function handleEdgeRoomSync(roomId, request, env, jsonResp, curatedMap = null, opts = {}) {
  if (RESERVED_CURATED_ID_RE.test(roomId) && !getCuratedSeed(roomId, curatedMap)) {
    return jsonResp({ ok: false, error: "Bu oda artık mevcut değil", roomNotFound: true }, 404);
  }
  const body = (request.method === "GET" || request.method === "HEAD")
    ? parseRoomGetParams(request)
    : await request.json().catch(() => ({}));
  delete body.__curatedSeed;
  if (opts?.defaultAction && !body.type) {
    body.type = opts.defaultAction;
  }
  const seed = getCuratedSeed(roomId, curatedMap);
  if (seed) {
    _memClosedRooms.delete(roomId);
    await d1ClearRoomClosed(env, roomId);
    if (env.WATCHLIVO_KV) await env.WATCHLIVO_KV.delete(`room_closed:${roomId}`).catch(() => {});
  } else {
    if (memIsClosed(roomId)) return jsonResp({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, 410);
    if (env.WATCHLIVO_KV) {
      const closedKv = await env.WATCHLIVO_KV.get(`room_closed:${roomId}`).catch(() => null);
      if (closedKv) return jsonResp({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, 410);
    }
  }
  const verifiedUid = await resolveRoomCallerUid(request, env, body, new URL(request.url));
  if (canUseRoomDo(env)) {
    try {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
      if (seed) {
        body.__curatedSeed = seed;
        if (!body.activeMedia && seed.media) body.activeMedia = seed.media;
      }
      const doHdrs = await forwardEdgeAuthHeaders(request, verifiedUid, env, { "Content-Type": "application/json" });
      const r = await stub.fetch(`https://do.local/sync?roomId=${encodeURIComponent(roomId)}`, { method: "POST", headers: doHdrs, body: JSON.stringify(body) });
      const data = await r.json();
      if (body.type === "close_room" && r.ok && data?.roomClosed && !seed) {
        memMarkClosed(roomId);
        await d1MarkRoomClosed(env, roomId);
        if (env.WATCHLIVO_KV) {
          await env.WATCHLIVO_KV.put(`room_closed:${roomId}`, "1", { expirationTtl: 3600 }).catch(() => {});
        }
        await removePublicRoomIndex(roomId, env);
      } else if (
        r.ok &&
        data?.room &&
        (env.ROOMS_DB || env.WATCHLIVO_KV) &&
        (["init", "join", "leave", "hb", "heartbeat", "play", "pause", "seek", "media", "set_media", "change_media", "resolve_media", "host_action", "kick", "privacy"].includes(body.type) ||
          Boolean(body.activeMedia) ||
          Boolean(data.pruned) ||
          Boolean(data.idxNeedsRefresh))
      ) {
        await syncPublicRoomIndex(roomId, data.room, env);
      }
      return jsonResp(data, r.status);
    } catch (err) {
      noteDoFailure(err);
    }
  }

  const origCid = String(body.clientId || "");
  let cid = origCid || `h_${makeHexNonce(4)}`;
  const blockUid = verifiedUid || String(body.uid || "").trim().slice(0, 64);
  // Always read global shared store (D1 -> KV) BEFORE local isolate memory to prevent cross-POP/cross-isolate split-brain!
  let rm = null;
  let loadedFromGlobal = false;
  if (env.ROOMS_DB) {
    const d1Rec = await d1GetRoomRecord(env, roomId);
    if (d1Rec?.closed && !seed) {
      memMarkClosed(roomId);
      return jsonResp({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, 410);
    }
    if (d1Rec?.rm) {
      rm = d1Rec.rm;
      loadedFromGlobal = true;
    }
  }
  if (!rm && env.WATCHLIVO_KV) {
    const kvRm = await env.WATCHLIVO_KV.get(`room:${roomId}`, "json").catch(() => null);
    if (kvRm && typeof kvRm === "object") {
      rm = kvRm;
      loadedFromGlobal = true;
    }
  }
  if (!rm) {
    rm = memGetRoom(roomId);
  }
  let healed = false;
  let isNewRoom = false;
  const restoredSeed = !rm && !seed ? await tryRestoreSyncToken(roomId, body.syncToken, env) : null;
  if (!rm) {
    if (seed) {
      isNewRoom = true;
      rm = makeRoomSkeleton(roomId, seed);
      healed = reconcileCuratedRoom(rm, seed) || true;
    } else if (restoredSeed) {
      isNewRoom = true;
      rm = restoredSeed;
    } else {
      return jsonResp({ ok: false, error: "Bu oda artık mevcut değil", roomNotFound: true }, 404);
    }
  } else if (seed) {
    healed = reconcileCuratedRoom(rm, seed);
  }
  const suppliedTok = String(body.clientToken || "").trim();
  const tokenVerified = await verifyRoomClientToken(suppliedTok, roomId, cid, env);
  const pwTrustedMember = Boolean(tokenVerified && (rm.participants?.[cid] || isHostOrCreator(rm, cid)));
  if (!seed && !rm.curated && !pwTrustedMember && !(await verifyRoomPassword(rm, body.pwd || ""))) {
    return jsonResp({ ok: false, error: "password_required", message: "Oda şifresi hatalı." }, 403);
  }
  const kb = getKickBanStatus(rm, origCid || cid, blockUid);
  if (kb.banned) {
    return jsonResp({ ok: false, error: "kicked", banned: true, message: "Bu odadan yasaklandınız." }, 403);
  }
  if (kb.kicked) {
    return jsonResp({ ok: false, error: "kicked" }, 410);
  }
  if (!seed && !rm.curated && rm.privacy === "friends") {
    const allowed = await hasFriendsRoomAccess(rm, {
      cid,
      tokenVerified,
      verifiedUid,
      validSyncToken: Boolean(restoredSeed),
      env,
      isInfo: false,
    });
    if (!allowed) {
      return jsonResp({ ok: false, error: "friends_only", message: "Bu oda yalnızca arkadaşlara açıktır." }, 403);
    }
  }
  const isExistingOrCreator = Boolean(
    (tokenVerified && (rm.participants?.[cid] || isHostOrCreator(rm, cid) || (rm.co_hosts || []).includes(cid))) ||
    restoredSeed ||
    (verifiedUid && rm.creatorUid && verifiedUid.toLowerCase() === String(rm.creatorUid).toLowerCase())
  );
  if (rm.locked && !rm.curated && !isExistingOrCreator) {
    return jsonResp({ ok: false, error: "room_locked", message: "Oda kilitli." }, 403);
  }
  if (!tokenVerified && isCidOccupiedOrReferenced(rm, cid)) {
    do {
      cid = `h_${makeHexNonce(4)}`;
    } while (isCidOccupiedOrReferenced(rm, cid));
  }
  if (getKickBanStatus(rm, cid, blockUid).kicked) return jsonResp({ ok: false, error: "kicked" }, 410);
  if (body.type === "close_room") {
    if (seed || rm.curated || !tokenVerified || !isHostOrCreator(rm, cid)) {
      return jsonResp({ ok: false, error: seed || rm.curated ? "Sabit 7/24 odalar kapatılamaz." : "Sadece oda kurucusu odayı kapatabilir." }, 403);
    }
    memMarkClosed(roomId);
    await d1MarkRoomClosed(env, roomId);
    if (env.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.delete(`room:${roomId}`).catch(() => {});
      await env.WATCHLIVO_KV.put(`room_closed:${roomId}`, "1", { expirationTtl: 3600 }).catch(() => {});
    }
    await removePublicRoomIndex(roomId, env);
    return jsonResp({ ok: true, roomClosed: true });
  }
  const prevSeen = Number(rm.participants?.[cid]?.lastSeen || 0);
  const hadParticipant = Boolean(rm.participants?.[cid]);
  const pruned = pruneStaleParticipants(rm);
  const res = applyRoomAction(rm, cid, body, { tokenVerified, verifiedUid });
  if (res.forbiddenError) return jsonResp({ ok: false, error: res.forbiddenError, message: res.forbiddenError }, 403);
  if (res.rateLimitedError) return jsonResp({ ok: false, error: "rate_limited", message: res.rateLimitedError }, 429);
  if (res.pendingPassword !== undefined) {
    await setRoomPassword(rm, res.pendingPassword);
  }
  const tStoreNow = nowSec();
  const keepaliveDue = Boolean(!hadParticipant || (tStoreNow - prevSeen >= 12));
  const idxRefresh = Boolean(rm.privacy === "public" && (!rm._lastIdxSync || tStoreNow - rm._lastIdxSync > 45));
  if (idxRefresh) rm._lastIdxSync = tStoreNow;
  memSetRoom(roomId, rm);
  const serialized = await serializeEdgeRoom(rm, cid, env);
  const mustPersist = Boolean(
    isNewRoom ||
    !loadedFromGlobal ||
    res.dirty ||
    pruned ||
    healed ||
    res.pendingPassword !== undefined ||
    keepaliveDue ||
    idxRefresh
  );
  if (mustPersist) {
    await d1PutRoom(env, roomId, rm);
    if (env.WATCHLIVO_KV && (isNewRoom || res.dirty || pruned || healed || res.pendingPassword !== undefined || idxRefresh)) {
      await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 }).catch(() => {});
    }
    if (
      ["init", "join", "leave", "media", "set_media", "change_media", "resolve_media", "host_action", "kick", "privacy"].includes(body.type) ||
      Boolean(body.activeMedia) ||
      pruned ||
      idxRefresh
    ) {
      await syncPublicRoomIndex(roomId, serialized, env);
    }
  }
  const nextTok = tokenVerified ? suppliedTok : await signRoomClientToken(roomId, cid, env);
  return jsonResp({ ok: true, clientId: cid, clientToken: nextTok, serverTime: nowSec(), room: serialized });
}

export async function handleEdgeRoomInfo(roomId, request, env, jsonResp, curatedMap = null) {
  const seed = getCuratedSeed(roomId, curatedMap);
  const url = new URL(request.url);
  const verifiedUid = await resolveRoomCallerUid(request, env, null, url);
  if (seed) {
    _memClosedRooms.delete(roomId);
    await d1ClearRoomClosed(env, roomId);
    if (env.WATCHLIVO_KV) await env.WATCHLIVO_KV.delete(`room_closed:${roomId}`).catch(() => {});
  } else {
    if (memIsClosed(roomId)) return jsonResp({ ok: false, error: "Bu oda artık mevcut değil", roomClosed: true }, 410);
    if (env.WATCHLIVO_KV) {
      const closedKv = await env.WATCHLIVO_KV.get(`room_closed:${roomId}`).catch(() => null);
      if (closedKv) return jsonResp({ ok: false, error: "Bu oda artık mevcut değil", roomClosed: true }, 410);
    }
  }
  if (canUseRoomDo(env)) {
    try {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
      const doUrl = new URL("https://do.local/info");
      doUrl.searchParams.set("roomId", roomId);
      const cid = url.searchParams.get("clientId") || "";
      const ctok = url.searchParams.get("clientToken") || "";
      const syncTok = url.searchParams.get("syncToken") || "";
      if (cid) doUrl.searchParams.set("clientId", cid);
      if (ctok) doUrl.searchParams.set("clientToken", ctok);
      if (syncTok) doUrl.searchParams.set("syncToken", syncTok);
      const hdrs = await forwardEdgeAuthHeaders(
        request,
        verifiedUid,
        env,
        seed ? { "x-watchlivo-curated-seed": b64EncodeUtf8(JSON.stringify(seed)) } : null
      );
      const r = await stub.fetch(new Request(doUrl.toString(), { method: "GET", headers: hdrs }));
      const data = await r.json();
      return jsonResp(data, r.status);
    } catch (err) {
      noteDoFailure(err);
    }
  }
  let rm = null;
  if (env.ROOMS_DB) {
    const d1Rec = await d1GetRoomRecord(env, roomId);
    if (d1Rec?.closed && !seed) {
      memMarkClosed(roomId);
      return jsonResp({ ok: false, error: "Bu oda artık mevcut değil", roomClosed: true }, 410);
    }
    if (d1Rec?.rm) rm = d1Rec.rm;
  }
  if (!rm && env.WATCHLIVO_KV) {
    rm = await env.WATCHLIVO_KV.get(`room:${roomId}`, "json").catch(() => null);
  }
  if (!rm) rm = memGetRoom(roomId);
  if (seed) {
    if (rm) {
      const healed = reconcileCuratedRoom(rm, seed);
      const pruned = pruneStaleParticipants(rm);
      memSetRoom(roomId, rm);
      if (healed || pruned) {
        await d1PutRoom(env, roomId, rm);
        if (env.WATCHLIVO_KV) {
          await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 }).catch(() => {});
        }
      }
      return jsonResp({ ok: true, room: serializeRoomInfo(rm, true) }, 200);
    }
    return jsonResp({ ok: true, room: serializeRoomInfo(makeRoomSkeleton(roomId, seed), true) }, 200);
  }
  if (!rm) {
    return jsonResp({ ok: false, error: "Bu oda artık mevcut değil" }, 404);
  }
  const pruned = pruneStaleParticipants(rm);
  memSetRoom(roomId, rm);
  if (pruned) {
    await d1PutRoom(env, roomId, rm);
    if (env.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 }).catch(() => {});
    }
  }
  const cid = String(url.searchParams.get("clientId") || "");
  const ctok = String(url.searchParams.get("clientToken") || "").trim();
  const tokVerified = Boolean(cid && ctok && (await verifyRoomClientToken(ctok, roomId, cid, env)));
  if (rm.privacy === "friends") {
    const allowed = await hasFriendsRoomAccess(rm, {
      cid,
      tokenVerified: tokVerified,
      verifiedUid,
      validSyncToken: false,
      env,
      isInfo: true,
    });
    if (!allowed) {
      return jsonResp({ ok: false, error: "friends_only", message: "Bu oda yalnızca arkadaşlara açıktır." }, 403);
    }
  }
  return jsonResp({ ok: true, room: serializeRoomInfo(rm, tokVerified) }, 200);
}

export async function handleEdgeRoomWs(roomId, request, url, env, curatedMap = null) {
  if (RESERVED_CURATED_ID_RE.test(roomId) && !getCuratedSeed(roomId, curatedMap)) {
    if (typeof WebSocketPair !== "undefined") {
      const nfPair = new WebSocketPair();
      const [nfClient, nfServer] = Object.values(nfPair);
      nfServer.accept();
      nfServer.send(JSON.stringify({ type: "room_closed", roomId, roomClosed: false, roomNotFound: true, error: "Bu oda artık mevcut değil" }));
      try { nfServer.close(4010, "room_not_found"); } catch {}
      return new Response(null, { status: 101, webSocket: nfClient });
    }
    return Response.json({ ok: false, error: "Bu oda artık mevcut değil", roomNotFound: true }, { status: 404 });
  }
  if (!canUseRoomDo(env)) return new Response("WS fallback to HTTP poll", { status: 503 });
  try {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const doUrl = new URL("https://do.local/ws");
    url.searchParams.forEach((v, k) => doUrl.searchParams.set(k, v));
    doUrl.searchParams.set("roomId", roomId);
    const seed = getCuratedSeed(roomId, curatedMap);
    const verifiedUid = await resolveRoomCallerUid(request, env, null, url);
    const hdrs = new Headers(request.headers);
    hdrs.delete("x-watchlivo-curated-seed");
    hdrs.delete("x-watchlivo-edge-vuid");
    if (verifiedUid) {
      const sig = await hmacRoomHex(`vuid|${verifiedUid}`, env);
      hdrs.set("x-watchlivo-edge-vuid", `${verifiedUid}.${sig}`);
    }
    if (seed) {
      hdrs.set("x-watchlivo-curated-seed", b64EncodeUtf8(JSON.stringify(seed)));
    }
    return await stub.fetch(new Request(doUrl.toString(), { method: request.method, headers: hdrs }));
  } catch (err) {
    noteDoFailure(err);
    return new Response("WS fallback to HTTP poll", { status: 503 });
  }
}

export async function handleEdgeRoomVoiceRelay(roomId, request, env, jsonResp, curatedMap = null, relayHdrs = {}) {
  if (!canUseRoomDo(env)) return null;
  try {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const srcUrl = new URL(request.url);
    const doUrl = new URL("https://do.local/voice-relay");
    srcUrl.searchParams.forEach((v, k) => doUrl.searchParams.set(k, v));
    doUrl.searchParams.set("roomId", roomId);
    const seed = getCuratedSeed(roomId, curatedMap);
    const hdrs = new Headers();
    if (seed) hdrs.set("x-watchlivo-curated-seed", b64EncodeUtf8(JSON.stringify(seed)));
    const init = { method: request.method, headers: hdrs };
    if (request.method === "POST") {
      hdrs.set("Content-Type", "application/json");
      init.body = await request.text();
    }
    const r = await stub.fetch(new Request(doUrl.toString(), init));
    const data = await r.json().catch(() => ({ ok: false, error: "Ses rölesi yanıt veremedi" }));
    return jsonResp(data, r.status, relayHdrs);
  } catch (err) {
    noteDoFailure(err);
    return null;
  }
}
