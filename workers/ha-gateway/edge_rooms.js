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

async function verifyRoomClientToken(token, roomId, cid, env) {
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
      if (obj.host_id) rm.host_id = obj.host_id;
      if (obj.creatorCid) rm.creatorCid = obj.creatorCid;
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
    playing,
    currentTime: pos,
    rate: Number(m.rate || 1) || 1,
    updatedAt: t,
    lastActionBy: creator,
    meshStateStatus: playing ? "PLAYING" : "PAUSED",
    meshStatePosition: pos,
    meshStateTime: t,
    meshStatePlaybackSpeed: Number(m.rate || 1) || 1,
  };
}

function makeRoomSkeleton(roomId, opts = {}) {
  const t = nowSec();
  const cid = opts.clientId || `h_${makeHexNonce(4)}`;
  const creator = String(opts.creator || opts.username || "Misafir").slice(0, 40);
  return {
    id: roomId,
    name: String(opts.name || "Watchlivo Sinema Odası").slice(0, 64),
    rawName: String(opts.name || "Watchlivo Sinema Odası").slice(0, 64),
    privacy: opts.privacy === "private" ? "private" : "public",
    pwdSalt: "",
    passwordHash: "",
    playMode: opts.playMode === "cohost" ? "cohost" : "leader",
    voipMode: "all",
    isMature: Boolean(opts.isMature),
    creator,
    creatorCid: cid,
    host_id: cid,
    co_hosts: [cid],
    rev: 1,
    curated: Boolean(opts.curated),
    media: buildFreshMedia(opts.media, creator, t),
    participants: {},
    kicked: [],
    skip_votes: [],
    pollVotes: {},
    chat: [],
    events: [],
    signals: [],
    updatedAt: t,
  };
}

function buildMediaOut(rm) {
  const t = nowSec();
  const m = rm.media || {};
  const elapsed = Math.max(0, t - (Number(m.updatedAt) || t));
  const livePos = m.playing ? (Number(m.currentTime) || 0) + elapsed * (Number(m.rate) || 1) : (Number(m.currentTime) || 0);
  return {
    ...m,
    liveTime: livePos,
    elapsedSinceUpdate: elapsed,
    serverNow: t,
    meshStateStatus: m.playing ? "PLAYING" : "PAUSED",
    meshStatePosition: livePos,
    meshStateTime: t,
  };
}

function pruneStaleParticipants(rm) {
  const cutoff = nowSec() - 45;
  let pruned = false;
  for (const [pid, p] of Object.entries(rm.participants || {})) {
    if ((p.lastSeen || 0) < cutoff) {
      delete rm.participants[pid];
      pruned = true;
    }
  }
  const remIds = Object.keys(rm.participants || {});
  if (remIds.length && (!rm.host_id || !rm.participants[rm.host_id])) {
    rm.host_id = remIds[0];
    pruned = true;
  }
  return pruned;
}

async function serializeEdgeRoom(rm, viewerCid = "", env = null) {
  const t = nowSec();
  const parts = [];
  for (const [pid, p] of Object.entries(rm.participants || {})) {
    parts.push({
      ...p,
      isHost: pid === rm.host_id,
      isCoHost: (rm.co_hosts || []).includes(pid),
      isCreator: pid === rm.creatorCid,
    });
  }
  const mediaOut = buildMediaOut(rm);
  const syncObj = {
    id: rm.id,
    name: rm.name,
    privacy: rm.privacy,
    playMode: rm.playMode,
    host_id: rm.host_id,
    creatorCid: rm.creatorCid,
    rev: rm.rev,
    media: rm.media,
  };
  const syncToken = await signSyncToken(syncObj, env);
  const isViewerCreator = Boolean(viewerCid && viewerCid === rm.creatorCid);
  const isViewerHost = Boolean(viewerCid && viewerCid === rm.host_id);
  const filteredSignals = (rm.signals || [])
    .filter((s) => viewerCid && (s.targetId === viewerCid || s.fromId === viewerCid))
    .slice(-30);
  const skipNeeded = Math.max(1, Math.ceil(Math.max(1, parts.length) / 2));
  return {
    id: rm.id,
    name: rm.name,
    rawName: rm.rawName || rm.name,
    privacy: rm.privacy || "public",
    playMode: rm.playMode || "leader",
    voipMode: rm.voipMode || "all",
    isMature: Boolean(rm.isMature),
    hasPassword: Boolean(rm.passwordHash || rm.password),
    creator: rm.creator || "Misafir",
    creatorCid: isViewerCreator ? rm.creatorCid : "",
    host_id: isViewerHost ? rm.host_id : "",
    co_hosts: (rm.co_hosts || []).filter((id) => id === viewerCid),
    isHost: isViewerHost,
    isCreator: isViewerCreator,
    stage_speakers: [],
    curated: Boolean(rm.curated),
    rev: rm.rev || 1,
    media: mediaOut,
    queue: [],
    skip_votes: rm.skip_votes || [],
    skipNeeded,
    pollVotes: rm.pollVotes || {},
    participants: parts,
    participantCount: parts.length,
    chat: (rm.chat || []).slice(-60),
    events: (rm.events || []).slice(-40),
    signals: filteredSignals,
    serverNow: t,
    syncToken,
  };
}

function serializePublicSummary(roomOut) {
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
    media: roomOut.media ? {
      title: roomOut.media.title || "",
      poster: roomOut.media.poster || "",
      thumbnail: roomOut.media.thumbnail || "",
      mediaType: roomOut.media.mediaType || "movie",
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

function sanitizeAvatarUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("https://") || s.startsWith("/static/") || s.startsWith("/uploads/")) return s.slice(0, 512);
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(s) && s.length <= 45000) return s;
  return "";
}

function applyRoomAction(rm, cid, body, opts = {}) {
  const t = nowSec();
  const act = String(body.type || "poll");
  const pushedEvents = [];
  const privateSignals = [];
  let dirty = Boolean(opts.initialDirty);
  let roomClosed = false;
  let forbiddenError = "";

  if (act === "batch" && Array.isArray(body.items)) {
    for (const item of body.items) {
      const sub = applyRoomAction(rm, cid, { ...body, ...item }, opts);
      dirty = dirty || sub.dirty;
      pushedEvents.push(...sub.pushedEvents);
      privateSignals.push(...sub.privateSignals);
      if (sub.roomClosed) roomClosed = true;
      if (sub.forbiddenError) forbiddenError = sub.forbiddenError;
    }
    return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError };
  }

  const tokenVerified = Boolean(opts.tokenVerified);
  const uname = String(body.username || rm.participants?.[cid]?.name || "Misafir").slice(0, 40);
  if (act === "leave") {
    if (rm.participants?.[cid]) {
      delete rm.participants[cid];
      rm.rev = (rm.rev || 1) + 1;
      dirty = true;
    }
    return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError };
  }

  const prevP = rm.participants?.[cid];
  const nextMuted = body.muted !== undefined ? Boolean(body.muted) : Boolean(prevP?.muted ?? true);
  const nextSpeaking = Boolean(body.speaking);
  const nextCam = Boolean(body.cam);
  const nextAvatar = body.avatarUrl !== undefined ? sanitizeAvatarUrl(body.avatarUrl) : (prevP?.avatarUrl || "");
  const nextColor = /^#[0-9a-fA-F]{3,8}$/.test(String(body.color || "")) ? body.color : (prevP?.color || "#27DCC8");

  if (!prevP || prevP.name !== uname || prevP.muted !== nextMuted || prevP.cam !== nextCam || prevP.color !== nextColor || prevP.avatarUrl !== nextAvatar) {
    dirty = true;
  }
  rm.participants[cid] = {
    ...(prevP || {}),
    id: cid,
    name: uname,
    color: nextColor,
    avatarUrl: nextAvatar,
    device: String(body.device || prevP?.device || "Web").slice(0, 24),
    country: String(body.country || prevP?.country || "TR").slice(0, 4),
    muted: nextMuted,
    speaking: nextSpeaking,
    cam: nextCam,
    lastSeen: t,
  };

  if (!rm.curated && (!rm.host_id || !rm.participants[rm.host_id])) {
    rm.host_id = cid;
    dirty = true;
  }
  if (body.activeMedia && !rm.media?.url && !rm.media?.videoId && (body.activeMedia.url || body.activeMedia.videoId || body.activeMedia.embedUrl)) {
    rm.media = buildFreshMedia(body.activeMedia, uname, t);
    rm.rev = (rm.rev || 1) + 1;
    dirty = true;
  }

  const pushEv = (ev, optsEv = {}) => {
    const fullEv = { id: `ev_${Date.now()}_${makeHexNonce(3)}`, cid, username: uname, ts: t, ...ev };
    rm.events = [...(rm.events || []).slice(-39), fullEv];
    rm.rev = (rm.rev || 1) + 1;
    pushedEvents.push({ ev: fullEv, attachRoom: Boolean(optsEv.attachRoom) });
    dirty = true;
    return fullEv;
  };

  if (act === "play" || act === "pause" || act === "seek" || act === "rate" || act === "video_ended") {
    if (rm.playMode === "leader" && !isPrivilegedInRoom(rm, cid)) {
      return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError: "Lider modunda oynatma kontrolü yalnızca oda yöneticisine aittir." };
    }
    if (body.currentTime !== undefined) rm.media.currentTime = Math.max(0, Number(body.currentTime) || 0);
    if (act === "play") rm.media.playing = true;
    if (act === "pause" || act === "video_ended") rm.media.playing = false;
    if (act === "video_ended") rm.media.currentTime = 0;
    if (body.rate !== undefined) rm.media.rate = Math.min(4, Math.max(0.25, Number(body.rate) || 1));
    rm.media.updatedAt = t;
    rm.media.lastActionBy = uname;
    pushEv({
      type: act === "video_ended" ? "video_ended" : "sync",
      action: act,
      currentTime: rm.media.currentTime,
      playing: rm.media.playing,
      rate: rm.media.rate,
      media: buildMediaOut(rm),
    });
  } else if (act === "heartbeat" && isHostOrCreator(rm, cid) && body.currentTime !== undefined) {
    rm.media.currentTime = Math.max(0, Number(body.currentTime) || 0);
    rm.media.updatedAt = t;
    dirty = true;
  } else if (act === "change_media" || act === "resolve_media") {
    if (rm.playMode === "leader" && !isPrivilegedInRoom(rm, cid)) {
      return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError: "Medya değiştirme yetkisi oda yöneticisine aittir." };
    }
    if (rm.curated) {
      return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError: "Sabit 7/24 odalarda medya değiştirilemez." };
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
      rm.media = {
        ...rm.media,
        provider: m.provider || rm.media.provider || "hls",
        videoId: m.videoId ?? rm.media.videoId ?? "",
        tmdbId: String(m.tmdbId ?? rm.media.tmdbId ?? ""),
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
        lastActionBy: uname,
        updatedAt: t,
      };
    }
    pushEv({ type: "media_changed", action: act, media: buildMediaOut(rm) }, { attachRoom: true });
  } else if (act === "chat" && body.text) {
    const msgId = String(body.clientMsgId || body.id || `m_${Date.now()}_${makeHexNonce(3)}`).slice(0, 64);
    if (!(rm.chat || []).some((x) => x && x.id === msgId)) {
      const msg = {
        id: msgId,
        clientMsgId: msgId,
        cid,
        user: uname,
        username: uname,
        color: rm.participants[cid].color,
        avatarUrl: rm.participants[cid].avatarUrl || "",
        text: String(body.text).slice(0, 1000),
        reactions: {},
        ts: t,
      };
      rm.chat = [...(rm.chat || []).slice(-59), msg];
      pushEv({ type: "chat", message: msg, ...msg });
    }
  } else if (act === "msg_react" && body.msgId && body.emoji) {
    const mid = String(body.msgId).slice(0, 64);
    const emo = String(body.emoji).slice(0, 16);
    const targetMsg = (rm.chat || []).find((x) => x.id === mid);
    if (targetMsg) {
      targetMsg.reactions = targetMsg.reactions || {};
      const arr = new Set(Array.isArray(targetMsg.reactions[emo]) ? targetMsg.reactions[emo] : []);
      if (arr.has(cid)) arr.delete(cid); else arr.add(cid);
      targetMsg.reactions[emo] = Array.from(arr);
      pushEv({ type: "msg_react", msgId: mid, emoji: emo, reactions: targetMsg.reactions });
    }
  } else if (act === "poll_vote" && body.option !== undefined) {
    const opt = String(body.option).slice(0, 80);
    rm.pollVotes = rm.pollVotes || {};
    rm.pollVotes[cid] = opt;
    pushEv({ type: "poll_vote", option: opt, pollVotes: rm.pollVotes });
  } else if (act === "vote_skip") {
    const votes = new Set(rm.skip_votes || []);
    if (votes.has(cid)) votes.delete(cid); else votes.add(cid);
    rm.skip_votes = Array.from(votes);
    const skipNeeded = Math.max(1, Math.ceil(Math.max(1, Object.keys(rm.participants || {}).length) / 2));
    pushEv({ type: "vote_skip", skip_votes: rm.skip_votes, skipNeeded });
  } else if (act === "voice_state") {
    pushEv({ type: "voice_state", muted: nextMuted, speaking: nextSpeaking, cam: nextCam });
  } else if (act === "host_action") {
    if (!tokenVerified || !isHostOrCreator(rm, cid)) {
      return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError: "Bu yönetici işlemi için geçerli host doğrulaması gerekli." };
    }
    const subAct = String(body.subAction || body.action || "");
    const targetCid = String(body.targetId || body.targetCid || "");
    if (subAct === "set_play_mode" && (body.playMode === "leader" || body.playMode === "cohost")) {
      rm.playMode = body.playMode;
      pushEv({ type: "host_action", subAction: subAct, playMode: rm.playMode }, { attachRoom: true });
    } else if (subAct === "kick" && targetCid && targetCid !== rm.creatorCid) {
      rm.kicked = Array.from(new Set([...(rm.kicked || []), targetCid])).slice(-100);
      delete rm.participants[targetCid];
      pushEv({ type: "host_action", subAction: "kick", targetCid }, { attachRoom: true });
    } else if (subAct === "promote" && targetCid) {
      rm.co_hosts = Array.from(new Set([...(rm.co_hosts || []), targetCid]));
      pushEv({ type: "host_action", subAction: "promote", targetCid }, { attachRoom: true });
    } else if (subAct === "demote" && targetCid && targetCid !== rm.creatorCid) {
      rm.co_hosts = (rm.co_hosts || []).filter((x) => x !== targetCid);
      pushEv({ type: "host_action", subAction: "demote", targetCid }, { attachRoom: true });
    }
  } else if (act === "clear_chat") {
    if (!tokenVerified || !isPrivilegedInRoom(rm, cid)) {
      return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError: "Sohbeti temizleme yetkisi yok." };
    }
    rm.chat = [];
    pushEv({ type: "clear_chat" });
  } else if (act === "reaction" || act === "typing" || act === "soundfx") {
    pushEv({ type: act, emoji: String(body.emoji || "❤️").slice(0, 16), typing: Boolean(body.typing), sfx: body.sfx });
  } else if (["webrtc_offer", "webrtc_answer", "webrtc_ice"].includes(act) && body.targetId) {
    const sig = {
      id: `sg_${Date.now()}_${makeHexNonce(3)}`,
      type: act,
      fromId: cid,
      targetId: String(body.targetId).slice(0, 64),
      sdp: body.sdp,
      candidate: body.candidate,
      ts: t,
    };
    rm.signals = [...(rm.signals || []).slice(-29), sig];
    rm.rev = (rm.rev || 1) + 1;
    privateSignals.push(sig);
    dirty = true;
  }
  if (dirty) rm.updatedAt = t;
  return { dirty, pushedEvents, privateSignals, roomClosed, forbiddenError };
}

export class WatchlivoRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.sockets = new Map();
  }

  async _load(roomId, seed = null) {
    if (!this.room) {
      this.room = (await this.state.storage.get("room")) || seed || makeRoomSkeleton(roomId, {});
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

  async fetch(request) {
    const u = new URL(request.url);
    const roomId = u.searchParams.get("roomId") || "room";
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const closedMark = await this.state.storage.get("closed");
      if (closedMark) {
        return Response.json({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, { status: 410 });
      }
      const rm = await this._load(roomId, await tryRestoreSyncToken(roomId, u.searchParams.get("syncToken"), this.env));
      const pwdOk = await verifyRoomPassword(rm, u.searchParams.get("pwd") || "");
      if (!pwdOk) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.send(JSON.stringify({ type: "password_required", error: "Oda şifresi gerekli." }));
        try { server.close(4003, "password_required"); } catch {}
        return new Response(null, { status: 101, webSocket: client });
      }

      let cid = u.searchParams.get("clientId") || `h_${makeHexNonce(4)}`;
      const suppliedTok = u.searchParams.get("clientToken") || "";
      let tokVerified = await verifyRoomClientToken(suppliedTok, roomId, cid, this.env);
      if ((cid === rm.creatorCid || cid === rm.host_id) && !tokVerified) {
        cid = `h_${makeHexNonce(4)}`;
      }
      if ((rm.kicked || []).includes(cid)) {
        return new Response("Kicked", { status: 410 });
      }
      const uname = u.searchParams.get("username") || u.searchParams.get("name") || "Misafir";
      const pruned = pruneStaleParticipants(rm);
      const initAct = applyRoomAction(rm, cid, { type: "init", username: uname, color: u.searchParams.get("color") || "#27DCC8" }, { tokenVerified: true });
      if (initAct.dirty || pruned) await this._save();

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(server, { cid, uname });
      const initTok = tokVerified ? suppliedTok : await signRoomClientToken(roomId, cid, this.env);
      const roomPayload = await serializeEdgeRoom(rm, cid, this.env);
      server.send(JSON.stringify({ type: "init", clientId: cid, clientToken: initTok, serverTime: nowSec(), room: roomPayload }));

      server.addEventListener("message", async (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "ping") {
          server.send(JSON.stringify({ type: "pong", t0: msg.t0, t0Epoch: msg.t0Epoch, serverTime: nowSec() }));
          return;
        }
        const pr = pruneStaleParticipants(rm);
        const res = applyRoomAction(rm, cid, msg, { tokenVerified: true });
        if (res.forbiddenError) {
          server.send(JSON.stringify({ type: "error", error: res.forbiddenError }));
          return;
        }
        if (res.dirty || pr) await this._save();
        for (const item of res.pushedEvents) {
          const pkt = item.attachRoom
            ? { ...item.ev, room: await serializeEdgeRoom(rm, item.ev.cid, this.env) }
            : item.ev;
          this._broadcast(pkt, item.ev.type === "chat" ? null : server);
        }
        for (const sig of res.privateSignals) {
          this._unicast(sig.targetId, sig);
        }
      });
      server.addEventListener("close", async () => {
        this.sockets.delete(server);
        applyRoomAction(rm, cid, { type: "leave" }, { tokenVerified: true });
        await this._save();
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (u.pathname === "/create") {
      await this.state.storage.delete("closed");
      this.room = makeRoomSkeleton(roomId, body);
      await setRoomPassword(this.room, body.password || "");
      applyRoomAction(this.room, this.room.creatorCid, { type: "init", username: this.room.creator, color: body.color || "#27DCC8" }, { initialDirty: true, tokenVerified: true });
      await this._save();
      const cid = this.room.creatorCid;
      const clientToken = await signRoomClientToken(roomId, cid, this.env);
      return Response.json({ ok: true, clientId: cid, clientToken, room: await serializeEdgeRoom(this.room, cid, this.env) });
    }

    const closedMark = await this.state.storage.get("closed");
    if (closedMark) {
      return Response.json({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, { status: 410 });
    }
    const rm = await this._load(roomId, await tryRestoreSyncToken(roomId, body.syncToken, this.env));
    if (!(await verifyRoomPassword(rm, body.pwd || ""))) {
      return Response.json({ ok: false, error: "password_required", message: "Oda şifresi hatalı." }, { status: 403 });
    }
    let cid = String(body.clientId || `h_${makeHexNonce(4)}`);
    const suppliedTok = String(body.clientToken || "").trim();
    const tokenVerified = await verifyRoomClientToken(suppliedTok, roomId, cid, this.env);
    if ((cid === rm.creatorCid || cid === rm.host_id) && !tokenVerified) {
      if (rm.participants?.[cid] || rm.curated || rm.createdFromApi) {
        cid = `h_${makeHexNonce(4)}`;
      }
    }
    if ((rm.kicked || []).includes(cid)) {
      return Response.json({ ok: false, error: "kicked" }, { status: 410 });
    }
    if (body.type === "close_room") {
      if (!tokenVerified || !isHostOrCreator(rm, cid) || rm.curated) {
        return Response.json({ ok: false, error: "Sadece oda kurucusu odayı kapatabilir." }, { status: 403 });
      }
      this._broadcast({ type: "room_closed", roomId });
      for (const [ws] of this.sockets.entries()) {
        try { ws.close(4010, "room_closed"); } catch {}
      }
      this.sockets.clear();
      await this.state.storage.delete("room");
      await this.state.storage.put("closed", true);
      this.room = null;
      return Response.json({ ok: true, roomClosed: true });
    }

    const pruned = pruneStaleParticipants(rm);
    const res = applyRoomAction(rm, cid, body, { tokenVerified });
    if (res.forbiddenError) {
      return Response.json({ ok: false, error: res.forbiddenError }, { status: 403 });
    }
    if (res.dirty || pruned) await this._save();
    for (const item of res.pushedEvents) {
      const pkt = item.attachRoom
        ? { ...item.ev, room: await serializeEdgeRoom(rm, item.ev.cid, this.env) }
        : item.ev;
      this._broadcast(pkt, null);
    }
    for (const sig of res.privateSignals) {
      this._unicast(sig.targetId, sig);
    }
    const clientToken = tokenVerified ? suppliedTok : await signRoomClientToken(roomId, cid, this.env);
    return Response.json({ ok: true, clientId: cid, clientToken, serverTime: nowSec(), room: await serializeEdgeRoom(rm, cid, this.env) });
  }
}

export async function handleEdgeRoomCreate(request, env, jsonResp) {
  const body = await request.json().catch(() => ({}));
  const roomId = generateOpaqueRoomId();
  const cid = String(body.clientId || `h_${makeHexNonce(4)}`);
  const createPayload = { ...body, clientId: cid, createdFromApi: true };
  let out;
  if (env.ROOM_DO) {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const r = await stub.fetch(`https://do.local/create?roomId=${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify(createPayload) });
    out = await r.json();
  } else {
    const rm = makeRoomSkeleton(roomId, createPayload);
    rm.createdFromApi = true;
    await setRoomPassword(rm, body.password || "");
    applyRoomAction(rm, cid, { type: "init", username: rm.creator, color: body.color || "#27DCC8" }, { initialDirty: true, tokenVerified: true });
    if (env.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 });
    out = { ok: true, clientId: cid, clientToken: await signRoomClientToken(roomId, cid, env), room: await serializeEdgeRoom(rm, cid, env) };
  }
  if (env.WATCHLIVO_KV && out?.room?.privacy === "public") {
    const idx = (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [];
    const summary = serializePublicSummary(out.room);
    const filtered = [summary, ...idx.filter((x) => x && x.id !== roomId)].slice(0, 40);
    await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(filtered), { expirationTtl: 21600 });
  }
  return jsonResp(out);
}

export async function handleEdgeRoomSync(roomId, request, env, jsonResp, curatedMap) {
  const body = await request.json().catch(() => ({}));
  if (env.WATCHLIVO_KV) {
    const closedKv = await env.WATCHLIVO_KV.get(`room_closed:${roomId}`).catch(() => null);
    if (closedKv) return jsonResp({ ok: false, error: "Oda kapatıldı.", roomClosed: true }, 410);
  }
  if (env.ROOM_DO) {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const seed = curatedMap?.get(roomId);
    if (seed && !body.activeMedia && seed.media) body.activeMedia = seed.media;
    const r = await stub.fetch(`https://do.local/sync?roomId=${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify(body) });
    const data = await r.json();
    if (body.type === "close_room" && r.ok && data?.roomClosed && env.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`room_closed:${roomId}`, "1", { expirationTtl: 3600 }).catch(() => {});
      const idx = (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [];
      await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(idx.filter((x) => x && x.id !== roomId)), { expirationTtl: 21600 }).catch(() => {});
    }
    return jsonResp(data, r.status);
  }

  let cid = String(body.clientId || `h_${makeHexNonce(4)}`);
  let rm = env.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`room:${roomId}`, "json").catch(() => null) : null;
  if (!rm) {
    rm = (await tryRestoreSyncToken(roomId, body.syncToken, env)) || makeRoomSkeleton(roomId, curatedMap?.get(roomId) || body);
    if (curatedMap?.get(roomId)) rm.curated = true;
    await setRoomPassword(rm, body.password || "");
  }
  if (!(await verifyRoomPassword(rm, body.pwd || ""))) {
    return jsonResp({ ok: false, error: "password_required", message: "Oda şifresi hatalı." }, 403);
  }
  const suppliedTok = String(body.clientToken || "").trim();
  const tokenVerified = await verifyRoomClientToken(suppliedTok, roomId, cid, env);
  if ((cid === rm.creatorCid || cid === rm.host_id) && !tokenVerified && (rm.participants?.[cid] || rm.curated || rm.createdFromApi)) {
    cid = `h_${makeHexNonce(4)}`;
  }
  if ((rm.kicked || []).includes(cid)) return jsonResp({ ok: false, error: "kicked" }, 410);
  if (body.type === "close_room") {
    if (!tokenVerified || !isHostOrCreator(rm, cid) || rm.curated) {
      return jsonResp({ ok: false, error: "Sadece oda kurucusu odayı kapatabilir." }, 403);
    }
    if (env.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.delete(`room:${roomId}`).catch(() => {});
      await env.WATCHLIVO_KV.put(`room_closed:${roomId}`, "1", { expirationTtl: 3600 }).catch(() => {});
      const idx = (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [];
      await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(idx.filter((x) => x && x.id !== roomId)), { expirationTtl: 21600 }).catch(() => {});
    }
    return jsonResp({ ok: true, roomClosed: true });
  }
  const pruned = pruneStaleParticipants(rm);
  const res = applyRoomAction(rm, cid, body, { tokenVerified });
  if (res.forbiddenError) return jsonResp({ ok: false, error: res.forbiddenError }, 403);
  if ((res.dirty || pruned) && env.WATCHLIVO_KV) {
    await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 });
  }
  const nextTok = tokenVerified ? suppliedTok : await signRoomClientToken(roomId, cid, env);
  return jsonResp({ ok: true, clientId: cid, clientToken: nextTok, serverTime: nowSec(), room: await serializeEdgeRoom(rm, cid, env) });
}

export async function handleEdgeRoomWs(roomId, request, url, env) {
  if (!env.ROOM_DO) return new Response("WS fallback to HTTP poll", { status: 503 });
  const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
  const doUrl = new URL("https://do.local/ws");
  url.searchParams.forEach((v, k) => doUrl.searchParams.set(k, v));
  doUrl.searchParams.set("roomId", roomId);
  return stub.fetch(new Request(doUrl.toString(), request));
}
