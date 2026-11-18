import test from "node:test";
import assert from "node:assert/strict";

import {
  WatchlivoRoomDO,
  handleEdgeRoomCreate,
  handleEdgeRoomSync,
} from "../workers/ha-gateway/edge_rooms.js";
import { handleAutonomousEdge } from "../workers/ha-gateway/edge_autonomous.js";
import { parseLrcToVtt } from "../workers/ha-gateway/edge_music.js";

function createMockKv() {
  const map = new Map();
  return {
    _map: map,
    async get(k, type) {
      const v = map.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      map.set(k, typeof v === "string" ? v : JSON.stringify(v));
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

function createMockDoState() {
  const storageMap = new Map();
  return {
    storage: {
      async get(k) {
        return storageMap.get(k);
      },
      async put(k, v) {
        storageMap.set(k, v);
      },
      async delete(k) {
        storageMap.delete(k);
      },
    },
  };
}

function createFakeWsPairClass() {
  return class FakeWebSocketPair {
    constructor() {
      const mkSide = () => ({
        accepted: false,
        closed: false,
        closeCode: null,
        closeReason: "",
        sent: [],
        listeners: new Map(),
        peer: null,
        accept() {
          this.accepted = true;
        },
        addEventListener(type, fn) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type).push(fn);
        },
        _emit(type, payload) {
          for (const fn of this.listeners.get(type) || []) {
            fn(payload);
          }
        },
        send(data) {
          this.sent.push(String(data));
          if (this.peer && !this.peer.closed) {
            this.peer._emit("message", { data: String(data) });
          }
        },
        close(code = 1000, reason = "") {
          this.closed = true;
          this.closeCode = code;
          this.closeReason = reason;
          if (this.peer && !this.peer.closed) {
            this.peer.closed = true;
            this.peer._emit("close", { code, reason });
          }
        },
      });
      const client = mkSide();
      const server = mkSide();
      client.peer = server;
      server.peer = client;
      this[0] = client;
      this[1] = server;
    }
  };
}

const TEST_ENV = {
  PROXY_SECRET: "unit-test-proxy-secret-32bytes-ok",
  VORTEX_SECRET: "unit-test-vortex-secret-32bytes",
  ADMIN_SECRET: "unit-test-admin-secret",
};

test("edge_rooms: WatchlivoRoomDO handles >40 WS events, chat echo, password, masking, unicast WebRTC, and close_room 410", async () => {
  const origWsPair = globalThis.WebSocketPair;
  const OrigResponse = globalThis.Response;
  globalThis.WebSocketPair = createFakeWsPairClass();
  globalThis.Response = class extends OrigResponse {
    constructor(body, init) {
      if (init && init.status === 101 && init.webSocket) {
        return { status: 101, ok: true, webSocket: init.webSocket, headers: new Headers(init.headers || {}) };
      }
      super(body, init);
    }
  };
  try {
    const kv = createMockKv();
    const doState = createMockDoState();
    const doInst = new WatchlivoRoomDO(doState, { ...TEST_ENV, WATCHLIVO_KV: kv });

    const stubEnv = {
      ...TEST_ENV,
      WATCHLIVO_KV: kv,
      ROOM_DO: {
        idFromName(name) { return `do_${name}`; },
        get() {
          return {
            fetch(input, init) {
              return doInst.fetch(input instanceof Request ? input : new Request(input, init));
            },
          };
        },
      },
    };
    const jsonResp = (data, status = 200) => Response.json(data, { status });

    // Create password-protected room
    const rCreate = await handleEdgeRoomCreate(
      new Request("https://watchlivo.online/api/rooms/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Oda", creator: "Sahip", creatorId: "u_owner", clientId: "h_owner", password: "gizli" }),
      }),
      stubEnv,
      jsonResp
    );
    assert.equal(rCreate.status, 200);
    const created = await rCreate.json();
    const roomId = created.room.id;
    const ownerCid = created.clientId;
    const ownerTok = created.clientToken;
    assert.equal(created.room.creatorCid, ownerCid);
    assert.equal(created.room.hasPassword, true);

    // Wrong password rejected with 403
    const rBadPwd = await handleEdgeRoomSync(
      roomId,
      new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "init", clientId: "h_viewer", username: "Izleyici", pwd: "wrong" }),
      }),
      stubEnv,
      jsonResp
    );
    assert.equal(rBadPwd.status, 403);

    // Viewer sync masks creatorCid / host_id
    const rViewerSync = await handleEdgeRoomSync(
      roomId,
      new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "init", clientId: "h_viewer", username: "Izleyici", pwd: "gizli" }),
      }),
      stubEnv,
      jsonResp
    );
    assert.equal(rViewerSync.status, 200);
    const vData = await rViewerSync.json();
    assert.equal(vData.room.creatorCid, "");
    assert.equal(vData.room.host_id, "");
    const viewerCid = vData.clientId;

    // Upgrade Owner & Viewer WS connections
    const wsRes1 = await doInst.fetch(
      new Request(`https://do.internal/?roomId=${roomId}&clientId=${ownerCid}&clientToken=${encodeURIComponent(ownerTok)}&username=Sahip&pwd=gizli`, {
        headers: { Upgrade: "websocket" },
      })
    );
    assert.equal(wsRes1.status, 101);
    const ownerSock = wsRes1.webSocket;

    const wsRes2 = await doInst.fetch(
      new Request(`https://do.internal/?roomId=${roomId}&clientId=${viewerCid}&clientToken=${encodeURIComponent(vData.clientToken)}&username=Izleyici&pwd=gizli`, {
        headers: { Upgrade: "websocket" },
      })
    );
    assert.equal(wsRes2.status, 101);
    const viewerSock = wsRes2.webSocket;

    // Add 3rd spectator to prove WebRTC unicast never leaks to wrong peers
    const wsRes3 = await doInst.fetch(
      new Request(`https://do.internal/?roomId=${roomId}&clientId=h_other&username=Diger&pwd=gizli`, {
        headers: { Upgrade: "websocket" },
      })
    );
    const otherSock = wsRes3.webSocket;

    const ownerInbox = [];
    const viewerInbox = [];
    const otherInbox = [];
    ownerSock.addEventListener("message", (e) => ownerInbox.push(JSON.parse(e.data)));
    viewerSock.addEventListener("message", (e) => viewerInbox.push(JSON.parse(e.data)));
    otherSock.addEventListener("message", (e) => otherInbox.push(JSON.parse(e.data)));

    // Fire 45 chat events (> old 40 cap!) + verify self clientMsgId echo on ownerSock
    for (let i = 1; i <= 45; i++) {
      ownerSock.send(JSON.stringify({ type: "chat", clientMsgId: `cm_${i}`, text: `msg ${i}` }));
      await new Promise((r) => setTimeout(r, 0));
    }
    const ownerEchoes = ownerInbox.filter((m) => m.type === "chat");
    const viewerChats = viewerInbox.filter((m) => m.type === "chat");
    assert.equal(ownerEchoes.length, 45, "Expected all 45 self chat echoes without 40-event cutoff");
    assert.equal(viewerChats.length, 45, "Expected all 45 viewer chat broadcasts without 40-event cutoff");
    assert.equal(ownerEchoes[44].clientMsgId, "cm_45");

    // WebRTC offer sent from owner -> viewer only (otherSock MUST NOT receive it)
    ownerSock.send(JSON.stringify({ type: "webrtc_offer", targetId: viewerCid, sdp: { type: "offer", sdp: "v=0" } }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(viewerInbox.filter((m) => m.type === "webrtc_offer").length, 1);
    assert.equal(otherInbox.filter((m) => m.type === "webrtc_offer").length, 0);

    // serializeEdgeRoom signals filter via HTTP sync: viewer sees signal, other does NOT
    const vPoll = await (await handleEdgeRoomSync(
      roomId,
      new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "poll", clientId: viewerCid, clientToken: vData.clientToken, pwd: "gizli" }),
      }),
      stubEnv,
      jsonResp
    )).json();
    assert.ok(vPoll.room.signals.some((s) => s.type === "webrtc_offer" && s.targetId === viewerCid));

    const oPoll = await (await handleEdgeRoomSync(
      roomId,
      new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "poll", clientId: "h_other", pwd: "gizli" }),
      }),
      stubEnv,
      jsonResp
    )).json();
    assert.equal(oPoll.room.signals.length, 0);

    // close_room writes DO+KV tombstone and subsequent sync returns 410
    const rClose = await handleEdgeRoomSync(
      roomId,
      new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "close_room", clientId: ownerCid, clientToken: ownerTok, pwd: "gizli" }),
      }),
      stubEnv,
      jsonResp
    );
    assert.equal(rClose.status, 200);
    assert.equal((await rClose.json()).roomClosed, true);

    const rAfterClose = await handleEdgeRoomSync(
      roomId,
      new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "poll", clientId: viewerCid }),
      }),
      stubEnv,
      jsonResp
    );
    assert.equal(rAfterClose.status, 410);
  } finally {
    if (origWsPair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = origWsPair;
    globalThis.Response = OrigResponse;
  }
});

test("edge_autonomous: /r/ query preservation, PBKDF2 auth+logout, removed media routes 404", async () => {
  const bootPayload = JSON.stringify({
    version: "20261114_v215",
    curatedRooms: [],
  });

  const kv = createMockKv();
  const env = {
    ...TEST_ENV,
    WATCHLIVO_KV: kv,
    ASSETS: {
      async fetch(req) {
        const u = new URL(typeof req === "string" ? req : req.url);
        if (u.pathname === "/_edge/bootstrap.json") {
          return new Response(bootPayload, { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/" || u.pathname === "/index.html") {
          return new Response("<!doctype html><html><head><title>Watchlivo</title></head><body></body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    },
  };

  // Grab valid edge token from home HTML
  const rHome = await handleAutonomousEdge(new Request("https://watchlivo.online/"), new URL("https://watchlivo.online/"), "/", env);
  assert.equal(rHome.status, 200);
  const homeHtml = await rHome.text();
  const edgeToken = homeHtml.match(/name="wl-edge-token" content="([^"]+)"/)?.[1];
  assert.ok(edgeToken);

  // 2. /r/<id>?pwd=123&s=2&e=5 preserves query params in redirect
  const rInvite = await handleAutonomousEdge(
    new Request("https://watchlivo.online/r/cinema-club?pwd=123&s=2&e=5"),
    new URL("https://watchlivo.online/r/cinema-club?pwd=123&s=2&e=5"),
    "/r/cinema-club",
    env
  );
  assert.equal(rInvite.status, 302);
  assert.equal(rInvite.headers.get("Location"), "/#/mesh/cinema-club?pwd=123&s=2&e=5");

  // 4. PBKDF2 register -> /me -> login -> logout -> /me returns 401
  const rReg = await handleAutonomousEdge(
    new Request("https://watchlivo.online/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "edgeuser@watchlivo.online", name: "EdgeTest", password: "StrongPassword123!" }),
    }),
    new URL("https://watchlivo.online/api/auth/register"),
    "/api/auth/register",
    env
  );
  assert.equal(rReg.status, 200);
  const regData = await rReg.json();
  assert.ok(regData.authToken);

  const storedAcct = await kv.get("acct:edgeuser@watchlivo.online", "json");
  assert.ok(String(storedAcct.passHash || "").startsWith("pbkdf2_v1$"));

  const rMe = await handleAutonomousEdge(
    new Request("https://watchlivo.online/api/auth/me", { headers: { Authorization: `Bearer ${regData.authToken}` } }),
    new URL("https://watchlivo.online/api/auth/me"),
    "/api/auth/me",
    env
  );
  assert.equal((await rMe.json()).authenticated, true);

  const rLogin = await handleAutonomousEdge(
    new Request("https://watchlivo.online/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "edgeuser@watchlivo.online", password: "StrongPassword123!" }),
    }),
    new URL("https://watchlivo.online/api/auth/login"),
    "/api/auth/login",
    env
  );
  assert.equal(rLogin.status, 200);
  const loginTok = (await rLogin.json()).authToken;

  const rLogout = await handleAutonomousEdge(
    new Request("https://watchlivo.online/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${loginTok}` },
    }),
    new URL("https://watchlivo.online/api/auth/logout"),
    "/api/auth/logout",
    env
  );
  assert.equal(rLogout.status, 200);

  const rMeAfter = await handleAutonomousEdge(
    new Request("https://watchlivo.online/api/auth/me", { headers: { Authorization: `Bearer ${loginTok}` } }),
    new URL("https://watchlivo.online/api/auth/me"),
    "/api/auth/me",
    env
  );
  assert.equal(rMeAfter.status, 401);

  // 3. Removed catalog / resolve / stream routes are not served by the edge
  for (const p of ["/api/rave/catalog", "/api/rave/resolve-catalog", "/api/rave/stream-proxy", "/api/rave/extract-video", "/api/rave/supersearch"]) {
    const r = await handleAutonomousEdge(new Request(`https://watchlivo.online${p}`), new URL(`https://watchlivo.online${p}`), p, env);
    assert.equal(r.status, 404, `${p} must be 404`);
  }
});

test("edge_music: handles music-catalog, music-resolve, and synced LRC -> WebVTT conversion", async () => {
  const vtt = parseLrcToVtt("[00:12.50] İlk satır\n[00:18.250] İkinci satır\n");
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:12.500 --> 00:00:18.250\nİlk satır"));

  const env = { ...TEST_ENV, WATCHLIVO_KV: createMockKv() };
  const pageHtml = await (await handleAutonomousEdge(new Request("https://watchlivo.online/"), new URL("https://watchlivo.online/"), "/", env)).text();
  const tokMatch = pageHtml.match(/window\.__WL_EDGE_TOKEN="([^"]+)"/);
  const edgeToken = tokMatch ? tokMatch[1] : "";

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const s = typeof input === "string" ? input : input.url;
      if (s.includes("itunes.apple.com")) {
        return new Response(JSON.stringify({
          results: [{ trackId: 42, trackName: "Test Şarkısı", artistName: "Semicenk", previewUrl: "https://audio.example.com/p.m4a", trackTimeMillis: 195000 }],
        }), { status: 200 });
      }
      if (s.includes("lrclib.net")) {
        return new Response(JSON.stringify({ syncedLyrics: "[00:05.00] Merhaba dünya\n" }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };

    const catReq = new Request("https://watchlivo.online/api/rave/music-catalog?provider=music&category=all", {
      headers: { "X-Watchlivo-Token": edgeToken },
    });
    const catRes = await handleAutonomousEdge(catReq, new URL(catReq.url), "/api/rave/music-catalog", env);
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    assert.ok(Array.isArray(catData.shelves) && catData.shelves.length > 0);
    assert.ok(catData.items.some((x) => x.artist === "Semicenk"));

    const lrcReq = new Request("https://watchlivo.online/api/rave/music-lyrics.vtt?artist=Semicenk&title=Test", {
      headers: { "X-Watchlivo-Token": edgeToken },
    });
    const lrcRes = await handleAutonomousEdge(lrcReq, new URL(lrcReq.url), "/api/rave/music-lyrics.vtt", env);
    assert.equal(lrcRes.status, 200);
    assert.ok((await lrcRes.text()).includes("00:00:05.000 --> 00:00:10.000"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("security & fail-closed routes: edgeJson headers, /api/* 404/401/501", async () => {
  const env = {
    PROXY_SECRET: "test-secret-key",
    WATCHLIVO_KV: createMockKv(),
    ASSETS: { async fetch() { return new Response("Not Found", { status: 404 }); } },
  };
  const callEdge = (path, init) => {
    const u = new URL(`https://watchlivo.online${path}`);
    return handleAutonomousEdge(new Request(u, init), u, u.pathname, env);
  };
  const hRes = await callEdge("/api/health");
  assert.equal(hRes.status, 200);
  assert.equal(hRes.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(hRes.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.ok(hRes.headers.get("Content-Security-Policy")?.includes("frame-ancestors"));
  assert.ok(hRes.headers.get("Permissions-Policy")?.includes("geolocation=()"));

  const unkRes = await callEdge("/api/nonexistent-endpoint");
  assert.equal(unkRes.status, 404);

  const upRes = await callEdge("/api/upload", { method: "POST" });
  assert.equal(upRes.status, 401);

  const accLogin = await callEdge("/api/rave/accounts/login", { method: "POST" });
  assert.equal(accLogin.status, 501);
  assert.equal((await accLogin.json()).code, "unsupported");

});

test("rooms: GET /api/rooms filters 0-viewer and stale ghost rooms and leave removes empty public room from KV index", async () => {
  const kv = createMockKv();
  const nowS = Math.floor(Date.now() / 1000);
  await kv.put("rooms:public_index", JSON.stringify([
    { id: "wl-ghost-0", name: "Ghost Room", privacy: "public", curated: false, participantCount: 0, updatedAt: nowS },
    { id: "wl-stale-1", name: "Stale Pentest Room", privacy: "public", curated: false, participantCount: 1, updatedAt: nowS - 300 },
    { id: "wl-active-1", name: "Active Room", privacy: "public", curated: false, participantCount: 2, count: 2, updatedAt: nowS },
  ]));
  const env = {
    PROXY_SECRET: "test-secret-key",
    WATCHLIVO_KV: kv,
    ASSETS: { async fetch() { return new Response("Not Found", { status: 404 }); } },
  };
  const req = new Request("https://watchlivo.online/api/rooms", { headers: { "User-Agent": "Mozilla/5.0" } });
  const res = await handleAutonomousEdge(
    req,
    new URL(req.url),
    "/api/rooms",
    env
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.rooms.some((r) => r.id === "wl-ghost-0"), false);
  assert.equal(data.rooms.some((r) => r.id === "wl-stale-1"), false);
  assert.equal(data.rooms.some((r) => r.id === "wl-active-1"), true);
  assert.equal(data.rooms.some((r) => r.id === "radyo-power-turk"), true);
  assert.equal(data.rooms.some((r) => String(r.id).startsWith("tv-")), false);

  // Create a public room via KV fallback and leave it -> must be removed from rooms:public_index
  const cRes = await handleEdgeRoomCreate(
    new Request("https://watchlivo.online/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Temp Room", privacy: "public", clientId: "host_1", username: "Host" }),
    }),
    env,
    (obj, st = 200) => Response.json(obj, { status: st })
  );
  const cData = await cRes.json();
  assert.equal(cData.ok, true);
  const rId = cData.room.id;
  let idx = await kv.get("rooms:public_index", "json");
  assert.equal(idx.some((r) => r.id === rId), true);

  await handleEdgeRoomSync(
    rId,
    new Request(`https://watchlivo.online/api/rooms/${rId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "leave", clientId: "host_1", clientToken: cData.clientToken }),
    }),
    env,
    (obj, st = 200) => Response.json(obj, { status: st })
  );
  idx = await kv.get("rooms:public_index", "json");
  assert.equal(idx.some((r) => r.id === rId), false);
});

test("auth/oauth (Google Firebase), /manifest.json, and /api/rave/social/* + analytics return 200", async () => {
  const kv = createMockKv();
  const env = {
    PROXY_SECRET: "test-secret-key",
    WATCHLIVO_KV: kv,
    ASSETS: { async fetch() { return new Response("Not Found", { status: 404 }); } },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes("identitytoolkit.googleapis.com/v1/accounts:lookup")) {
      return Response.json({ users: [{ email: "tris@gmail.com", emailVerified: true, displayName: "Tris" }] });
    }
    return new Response("Not Found", { status: 404 });
  };
  try {
    // 1. Missing idToken -> 401
    const rBad = await handleAutonomousEdge(
      new Request("https://watchlivo.online/api/auth/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        body: JSON.stringify({ provider: "google" }),
      }),
      new URL("https://watchlivo.online/api/auth/oauth"),
      "/api/auth/oauth",
      env
    );
    assert.equal(rBad.status, 401);

    // 2. Valid Firebase idToken -> 200 + wl_auth cookie + user
    const rOk = await handleAutonomousEdge(
      new Request("https://watchlivo.online/api/auth/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        body: JSON.stringify({ provider: "google", idToken: "fake-valid-fb-jwt" }),
      }),
      new URL("https://watchlivo.online/api/auth/oauth"),
      "/api/auth/oauth",
      env
    );
    assert.equal(rOk.status, 200);
    const jOk = await rOk.json();
    assert.equal(jOk.ok, true);
    assert.equal(jOk.user.email, "tris@gmail.com");
    assert.ok((rOk.headers.get("Set-Cookie") || "").includes("wl_auth="));

    // 3. /manifest.json + social/state + social/presence + analytics -> 200
    for (const p of ["/manifest.json", "/api/rave/social/state", "/api/rave/social/presence", "/api/rave/analytics"]) {
      const rp = await handleAutonomousEdge(
        new Request(`https://watchlivo.online${p}`, { headers: { "User-Agent": "Mozilla/5.0" } }),
        new URL(`https://watchlivo.online${p}`),
        p,
        env
      );
      assert.equal(rp.status, 200, `${p} expected 200`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});
