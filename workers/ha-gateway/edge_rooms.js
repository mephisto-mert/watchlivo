function nowSec() {
  return Date.now() / 1000;
}

function slugifyRoomName(name) {
  const base = String(name || "sinema-odasi")
    .toLowerCase()
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s")
    .replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "oda";
  const rand = Math.random().toString(16).slice(2, 7);
  return `${base}-${rand}`;
}

function makeRoomSkeleton(roomId, opts = {}) {
  const t = nowSec();
  const cid = opts.clientId || `h_${Math.random().toString(16).slice(2, 10)}`;
  const creator = String(opts.creator || opts.username || "Misafir").slice(0, 40);
  const initMedia = opts.media && typeof opts.media === "object" ? opts.media : {};
  const pos = Number(initMedia.currentTime || 0) || 0;
  const playing = Boolean(initMedia.url || initMedia.videoId);
  return {
    id: roomId,
    name: String(opts.name || "Watchlivo Sinema Odası").slice(0, 64),
    rawName: String(opts.name || "Watchlivo Sinema Odası").slice(0, 64),
    privacy: opts.privacy === "private" ? "private" : "public",
    password: String(opts.password || ""),
    playMode: opts.playMode === "cohost" ? "cohost" : "leader",
    voipMode: "all",
    isMature: Boolean(opts.isMature),
    creator,
    creatorCid: cid,
    host_id: cid,
    co_hosts: [cid],
    rev: 1,
    curated: Boolean(opts.curated),
    media: {
      provider: initMedia.provider || (initMedia.url ? "hls" : ""),
      videoId: initMedia.videoId || "",
      tmdbId: String(initMedia.tmdbId || ""),
      mediaType: initMedia.mediaType || "movie",
      season: Number(initMedia.season || 0),
      episode: Number(initMedia.episode || 0),
      url: initMedia.url || "",
      embedUrl: initMedia.embedUrl || "",
      streamType: initMedia.streamType || "hls",
      title: initMedia.title || "",
      thumbnail: initMedia.thumbnail || initMedia.poster || "",
      duration: Number(initMedia.duration || 0),
      playing,
      currentTime: pos,
      rate: Number(initMedia.rate || 1) || 1,
      updatedAt: t,
      lastActionBy: creator,
      meshStateStatus: playing ? "PLAYING" : "PAUSED",
      meshStatePosition: pos,
      meshStateTime: t,
      meshStatePlaybackSpeed: 1,
    },
    participants: {},
    chat: [],
    events: [],
    signals: [],
    updatedAt: t,
  };
}

function serializeEdgeRoom(rm) {
  const t = nowSec();
  const cutoff = t - 45;
  const parts = [];
  for (const [pid, p] of Object.entries(rm.participants || {})) {
    if ((p.lastSeen || 0) >= cutoff) {
      parts.push({
        ...p,
        isHost: pid === rm.host_id,
        isCoHost: (rm.co_hosts || []).includes(pid),
        isCreator: pid === rm.creatorCid,
      });
    } else {
      delete rm.participants[pid];
    }
  }
  if (parts.length && !rm.participants[rm.host_id]) {
    rm.host_id = parts[0].id;
    parts[0].isHost = true;
  }
  const m = rm.media || {};
  const elapsed = Math.max(0, t - (Number(m.updatedAt) || t));
  const livePos = m.playing ? (Number(m.currentTime) || 0) + elapsed * (Number(m.rate) || 1) : (Number(m.currentTime) || 0);
  const mediaOut = {
    ...m,
    liveTime: livePos,
    elapsedSinceUpdate: elapsed,
    serverNow: t,
    meshStateStatus: m.playing ? "PLAYING" : "PAUSED",
    meshStatePosition: livePos,
    meshStateTime: t,
  };
  const syncObj = { id: rm.id, name: rm.name, privacy: rm.privacy, playMode: rm.playMode, host_id: rm.host_id, rev: rm.rev, media: m };
  let syncToken = "";
  try { syncToken = btoa(unescape(encodeURIComponent(JSON.stringify(syncObj)))); } catch {}
  return {
    id: rm.id,
    name: rm.name,
    rawName: rm.rawName || rm.name,
    privacy: rm.privacy || "public",
    playMode: rm.playMode || "leader",
    voipMode: "all",
    isMature: Boolean(rm.isMature),
    hasPassword: Boolean(rm.password),
    creator: rm.creator || "Misafir",
    creatorCid: rm.creatorCid || "",
    host_id: rm.host_id || "",
    co_hosts: rm.co_hosts || [],
    stage_speakers: [],
    curated: Boolean(rm.curated),
    rev: rm.rev || 1,
    media: mediaOut,
    queue: [],
    skip_votes: [],
    skipNeeded: 1,
    participants: parts,
    participantCount: parts.length,
    chat: (rm.chat || []).slice(-60),
    events: (rm.events || []).slice(-40),
    signals: (rm.signals || []).slice(-30),
    serverNow: t,
    syncToken,
  };
}

function applyRoomAction(rm, cid, body) {
  const t = nowSec();
  const act = String(body.type || "poll");
  if (act === "batch" && Array.isArray(body.items)) {
    for (const item of body.items) applyRoomAction(rm, cid, { ...body, ...item });
    return;
  }
  const uname = String(body.username || rm.participants?.[cid]?.name || "Misafir").slice(0, 40);
  if (act === "leave") {
    delete rm.participants[cid];
    rm.rev = (rm.rev || 1) + 1;
    return;
  }
  rm.participants[cid] = {
    ...(rm.participants[cid] || {}),
    id: cid,
    name: uname,
    color: body.color || rm.participants?.[cid]?.color || "#27DCC8",
    avatarUrl: body.avatarUrl || rm.participants?.[cid]?.avatarUrl || "",
    device: body.device || "Web",
    country: body.country || "TR",
    muted: body.muted !== undefined ? Boolean(body.muted) : Boolean(rm.participants?.[cid]?.muted ?? true),
    speaking: Boolean(body.speaking),
    cam: Boolean(body.cam),
    lastSeen: t,
  };
  if (!rm.host_id || !rm.participants[rm.host_id]) rm.host_id = cid;
  if (body.activeMedia && !rm.media?.url && (body.activeMedia.url || body.activeMedia.videoId)) {
    rm.media = { ...rm.media, ...body.activeMedia, updatedAt: t, playing: true };
    rm.rev = (rm.rev || 1) + 1;
  }
  const pushEv = (ev) => {
    rm.events = [...(rm.events || []).slice(-39), { id: `ev_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, cid, username: uname, ts: t, ...ev }];
    rm.rev = (rm.rev || 1) + 1;
  };
  if (act === "play" || act === "pause" || act === "seek" || act === "rate") {
    if (body.currentTime !== undefined) rm.media.currentTime = Math.max(0, Number(body.currentTime) || 0);
    if (act === "play") rm.media.playing = true;
    if (act === "pause") rm.media.playing = false;
    if (body.rate !== undefined) rm.media.rate = Number(body.rate) || 1;
    rm.media.updatedAt = t;
    rm.media.lastActionBy = uname;
    pushEv({ type: "sync", action: act, currentTime: rm.media.currentTime, playing: rm.media.playing, rate: rm.media.rate });
  } else if (act === "heartbeat" && cid === rm.host_id && body.currentTime !== undefined) {
    rm.media.currentTime = Math.max(0, Number(body.currentTime) || 0);
    rm.media.updatedAt = t;
  } else if (act === "change_media" || act === "resolve_media") {
    const m = body.media || body;
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
      title: m.title || rm.media.title || "",
      thumbnail: m.thumbnail || m.poster || rm.media.thumbnail || "",
      currentTime: m.currentTime !== undefined ? Number(m.currentTime) || 0 : (act === "resolve_media" ? rm.media.currentTime : 0),
      playing: m.playing !== undefined ? Boolean(m.playing) : true,
      updatedAt: t,
    };
    pushEv({ type: "media_changed", action: act, media: rm.media });
  } else if (act === "chat" && body.text) {
    const msg = { id: `m_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, cid, username: uname, color: rm.participants[cid].color, text: String(body.text).slice(0, 1000), ts: t };
    rm.chat = [...(rm.chat || []).slice(-59), msg];
    pushEv({ type: "chat", message: msg, ...msg });
  } else if (act === "reaction" || act === "typing" || act === "soundfx") {
    pushEv({ type: act, emoji: body.emoji || "❤️", typing: Boolean(body.typing), sfx: body.sfx });
  } else if (["webrtc_offer", "webrtc_answer", "webrtc_ice"].includes(act) && body.targetId) {
    rm.signals = [...(rm.signals || []).slice(-29), { id: `sg_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, type: act, fromId: cid, targetId: body.targetId, sdp: body.sdp, candidate: body.candidate, ts: t }];
    rm.rev = (rm.rev || 1) + 1;
  }
  rm.updatedAt = t;
}

function tryRestoreSyncToken(roomId, syncToken) {
  if (!syncToken) return null;
  try {
    const obj = JSON.parse(decodeURIComponent(escape(atob(syncToken))));
    if (obj && typeof obj === "object") {
      const rm = makeRoomSkeleton(roomId, obj);
      if (obj.media) rm.media = { ...rm.media, ...obj.media };
      return rm;
    }
  } catch {}
  return null;
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

  async fetch(request) {
    const u = new URL(request.url);
    const roomId = u.searchParams.get("roomId") || "room";
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const rm = await this._load(roomId, tryRestoreSyncToken(roomId, u.searchParams.get("syncToken")));
      if (rm.password && rm.password !== (u.searchParams.get("pwd") || "")) {
        return new Response("Forbidden", { status: 403 });
      }
      const cid = u.searchParams.get("clientId") || `h_${Math.random().toString(16).slice(2, 10)}`;
      const uname = u.searchParams.get("username") || u.searchParams.get("name") || "Misafir";
      applyRoomAction(rm, cid, { type: "init", username: uname, color: u.searchParams.get("color") || "#27DCC8" });
      await this._save();

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(server, { cid, uname });
      const initTok = `${cid}.${Math.floor(nowSec())}.edge`;
      server.send(JSON.stringify({ type: "init", clientId: cid, clientToken: initTok, serverTime: nowSec(), room: serializeEdgeRoom(rm) }));

      server.addEventListener("message", async (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "ping") {
          server.send(JSON.stringify({ type: "pong", t0: msg.t0, t0Epoch: msg.t0Epoch, serverTime: nowSec() }));
          return;
        }
        const prevLen = (rm.events || []).length;
        applyRoomAction(rm, cid, msg);
        await this._save();
        const newEvents = (rm.events || []).slice(prevLen);
        for (const e of newEvents) this._broadcast(e, e.type === "chat" ? null : server);
      });
      server.addEventListener("close", async () => {
        this.sockets.delete(server);
        applyRoomAction(rm, cid, { type: "leave" });
        await this._save();
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (u.pathname === "/create") {
      this.room = makeRoomSkeleton(roomId, body);
      applyRoomAction(this.room, this.room.creatorCid, { type: "init", username: this.room.creator, color: body.color || "#27DCC8" });
      await this._save();
      const cid = this.room.creatorCid;
      return Response.json({ ok: true, clientId: cid, clientToken: `${cid}.${Math.floor(nowSec())}.edge`, room: serializeEdgeRoom(this.room) });
    }

    const rm = await this._load(roomId, tryRestoreSyncToken(roomId, body.syncToken));
    if (rm.password && rm.password !== String(body.pwd || "")) {
      return Response.json({ ok: false, error: "Oda şifresi hatalı." }, { status: 403 });
    }
    const cid = String(body.clientId || `h_${Math.random().toString(16).slice(2, 10)}`);
    if (body.type === "close_room" && (cid === rm.creatorCid || cid === rm.host_id)) {
      await this.state.storage.delete("room");
      this.room = null;
      return Response.json({ ok: true, roomClosed: true });
    }
    applyRoomAction(rm, cid, body);
    await this._save();
    return Response.json({ ok: true, clientId: cid, clientToken: body.clientToken || `${cid}.${Math.floor(nowSec())}.edge`, serverTime: nowSec(), room: serializeEdgeRoom(rm) });
  }
}

export async function handleEdgeRoomCreate(request, env, jsonResp) {
  const body = await request.json().catch(() => ({}));
  const roomId = slugifyRoomName(body.name || body.media?.title || "watchlivo");
  const cid = String(body.clientId || `h_${Math.random().toString(16).slice(2, 10)}`);
  const createPayload = { ...body, clientId: cid };
  let out;
  if (env.ROOM_DO) {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const r = await stub.fetch(`https://do.local/create?roomId=${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify(createPayload) });
    out = await r.json();
  } else {
    const rm = makeRoomSkeleton(roomId, createPayload);
    applyRoomAction(rm, cid, { type: "init", username: rm.creator });
    if (env.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 });
    out = { ok: true, clientId: cid, clientToken: `${cid}.${Math.floor(nowSec())}.edge`, room: serializeEdgeRoom(rm) };
  }
  if (env.WATCHLIVO_KV && out?.room?.privacy === "public") {
    const idx = (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [];
    const filtered = [out.room, ...idx.filter((x) => x && x.id !== roomId)].slice(0, 40);
    await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(filtered), { expirationTtl: 21600 });
  }
  return jsonResp(out);
}

export async function handleEdgeRoomSync(roomId, request, env, jsonResp, curatedMap) {
  const body = await request.json().catch(() => ({}));
  if (env.ROOM_DO) {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const seed = curatedMap?.get(roomId);
    if (seed && !body.activeMedia && seed.media) body.activeMedia = seed.media;
    const r = await stub.fetch(`https://do.local/sync?roomId=${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify(body) });
    return jsonResp(await r.json(), r.status);
  }
  const cid = String(body.clientId || `h_${Math.random().toString(16).slice(2, 10)}`);
  let rm = env.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`room:${roomId}`, "json").catch(() => null) : null;
  if (!rm) rm = tryRestoreSyncToken(roomId, body.syncToken) || makeRoomSkeleton(roomId, curatedMap?.get(roomId) || body);
  if (rm.password && rm.password !== String(body.pwd || "")) return jsonResp({ ok: false, error: "Oda şifresi hatalı." }, 403);
  applyRoomAction(rm, cid, body);
  if (env.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(`room:${roomId}`, JSON.stringify(rm), { expirationTtl: 43200 });
  return jsonResp({ ok: true, clientId: cid, clientToken: body.clientToken || `${cid}.${Math.floor(nowSec())}.edge`, serverTime: nowSec(), room: serializeEdgeRoom(rm) });
}

export async function handleEdgeRoomWs(roomId, request, url, env) {
  if (!env.ROOM_DO) return new Response("WS fallback to HTTP poll", { status: 503 });
  const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
  const doUrl = new URL("https://do.local/ws");
  url.searchParams.forEach((v, k) => doUrl.searchParams.set(k, v));
  doUrl.searchParams.set("roomId", roomId);
  return stub.fetch(new Request(doUrl.toString(), request));
}
