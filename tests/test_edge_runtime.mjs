import test from "node:test";
import assert from "node:assert/strict";

import {
  isPublicHttpUrl,
  signProxySig,
  verifyProxySig,
  handleEdgeStreamProxy,
  handleEdgeSubtitle,
  handleEdgePoster,
} from "../workers/ha-gateway/edge_streams.js";
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

test("edge_streams: isPublicHttpUrl SSRF blocklist rejects private/loopback/metadata", () => {
  for (const blocked of [
    "http://127.0.0.1:8765/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/admin",
    "http://172.16.0.5/internal",
    "http://192.168.1.10/router",
    "http://[::1]/secret",
    "http://localhost:8080/api",
    "http://0.0.0.0/",
    "file:///etc/passwd",
  ]) {
    assert.equal(isPublicHttpUrl(blocked), false, `Expected blocked: ${blocked}`);
  }
  assert.equal(isPublicHttpUrl("https://cdn.example.com/hls/master.m3u8"), true);
});

test("edge_streams: fail-closed verifyProxySig and valid signed round-trip", async () => {
  const target = "https://cdn.example.com/video/seg01.ts";
  const ref = "https://cdn.example.com/";
  assert.equal(await verifyProxySig(target, ref, "", {}), false);
  assert.equal(await verifyProxySig(target, ref, "deadbeef", {}), false);

  const sig = await signProxySig(target, ref, TEST_ENV);
  assert.ok(sig.length >= 16);
  assert.equal(await verifyProxySig(target, ref, sig, TEST_ENV), true);
  assert.equal(await verifyProxySig(target, ref, sig, { PROXY_SECRET: "wrong" }), false);
  assert.equal(await verifyProxySig(target + "?tamper=1", ref, sig, TEST_ENV), false);
});

test("edge_streams: handleEdgeStreamProxy blocks redirect SSRF and HTML/SVG + emits safe headers", async () => {
  const origFetch = globalThis.fetch;
  try {
    const ssrfTarget = "https://cdn.example.com/redir-ssrf.ts";
    const ssrfSig = await signProxySig(ssrfTarget, "", TEST_ENV);
    globalThis.fetch = async () =>
      new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } });
    const ssrfReqUrl = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(ssrfTarget)}&sig=${ssrfSig}`
    );
    const rSsrf = await handleEdgeStreamProxy(new Request(ssrfReqUrl), ssrfReqUrl, TEST_ENV);
    assert.equal(rSsrf.status, 403);

    const htmlTarget = "https://cdn.example.com/evil.ts";
    const htmlSig = await signProxySig(htmlTarget, "", TEST_ENV);
    globalThis.fetch = async () =>
      new Response("<html><script>alert(1)</script></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const htmlReqUrl = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(htmlTarget)}&sig=${htmlSig}`
    );
    const rHtml = await handleEdgeStreamProxy(new Request(htmlReqUrl), htmlReqUrl, TEST_ENV);
    assert.equal(rHtml.status, 502);

    const tsTarget = "https://cdn.example.com/ok/seg01.ts";
    const tsSig = await signProxySig(tsTarget, "", TEST_ENV);
    const tsBytes = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0xaa, 0xbb]);
    globalThis.fetch = async () =>
      new Response(tsBytes, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": "6" } });
    const tsReqUrl = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(tsTarget)}&sig=${tsSig}&ext=.ts`
    );
    const rOk = await handleEdgeStreamProxy(new Request(tsReqUrl), tsReqUrl, TEST_ENV);
    assert.equal(rOk.status, 200);
    assert.equal(rOk.headers.get("Vary"), "Range");
    assert.equal(rOk.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(rOk.headers.get("Content-Security-Policy"), "sandbox");
    assert.equal(rOk.headers.get("Content-Type"), "video/mp2t");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("edge_streams: handleEdgeSubtitle normalizes Windows-1254 SRT, ASS, and 1-digit SRT timestamps", async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1-digit hour SRT encoded in Windows-1254 (Turkish chars: İ ğ ü ş ı ö ç -> bytes 0xDD, 0xF0, 0xFC, 0xFE, 0xFD, 0xF6, 0xE7)
    const srtBytes = new Uint8Array([
      ...Buffer.from("1\r\n0:01:02,50 --> 0:01:05,750\r\nMerhaba ", "ascii"),
      0xfe, 0x69, 0x6d, 0xf0, 0x69, // "şimgi"
      ...Buffer.from("\r\n\r\n", "ascii"),
    ]);
    globalThis.fetch = async () => new Response(srtBytes, { status: 200 });
    const subUrl1 = new URL(`https://watchlivo.online/api/rave/subtitle.vtt?url=${encodeURIComponent("https://cdn.example.com/tr.srt")}`);
    const res1 = await handleEdgeSubtitle(subUrl1, TEST_ENV);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("Content-Type"), "text/vtt; charset=utf-8");
    const txt1 = await res1.text();
    assert.ok(txt1.startsWith("WEBVTT"));
    assert.ok(txt1.includes("00:01:02.500 --> 00:01:05.750"), `Bad VTT ts: ${txt1}`);
    assert.ok(txt1.includes("ş") && txt1.includes("ğ"), `Expected decoded cp1254 chars: ${txt1}`);

    const assText = `[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:02:10.50,0:02:14.25,Default,,0,0,0,,{\\i1}Selam{\\i0}\\NCanim\n`;
    globalThis.fetch = async () => new Response(assText, { status: 200 });
    const subUrl2 = new URL(`https://watchlivo.online/api/rave/subtitle.vtt?url=${encodeURIComponent("https://cdn.example.com/tr.ass")}`);
    const res2 = await handleEdgeSubtitle(subUrl2, TEST_ENV);
    assert.equal(res2.status, 200);
    const txt2 = await res2.text();
    assert.ok(txt2.includes("00:02:10.500 --> 00:02:14.250"), `Bad ASS VTT ts: ${txt2}`);
    assert.ok(txt2.includes("Selam") && txt2.includes("Canim") && !txt2.includes("{\\i1}"), `Unexpected ASS tags: ${txt2}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("edge_streams: handleEdgePoster rejects SVG upstream and serves JPEG with nosniff + sandbox", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const s = typeof input === "string" ? input : input.url;
      if (s.includes("evil-svg.example")) {
        return new Response("<svg onload=alert(1)/>", { status: 200, headers: { "Content-Type": "image/svg+xml" } });
      }
      if (s.includes("image.tmdb.org") || s.includes("valid-jpeg.example")) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }
      return new Response("Not Found", { status: 404 });
    };

    const svgReqUrl = new URL(`https://watchlivo.online/api/rave/poster?u=${encodeURIComponent("https://evil-svg.example/p.svg")}`);
    const rSvgFallback = await handleEdgePoster(svgReqUrl, TEST_ENV);
    // SVG must NOT pass through as image/svg+xml
    assert.notEqual((rSvgFallback.headers.get("Content-Type") || "").toLowerCase(), "image/svg+xml");

    const jpgReqUrl = new URL(`https://watchlivo.online/api/rave/poster?u=${encodeURIComponent("https://valid-jpeg.example/p.jpg")}`);
    const rJpg = await handleEdgePoster(jpgReqUrl, TEST_ENV);
    assert.equal(rJpg.status, 200);
    assert.equal(rJpg.headers.get("Content-Type"), "image/jpeg");
    assert.equal(rJpg.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(rJpg.headers.get("Content-Security-Policy"), "sandbox");
  } finally {
    globalThis.fetch = origFetch;
  }
});

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

test("edge_autonomous: UA gate, /r/ query preservation, single-slice catalog, tr/vizyon, PBKDF2 auth+logout, and seasons guards", async () => {
  const catalog = Array.from({ length: 40 }, (_, i) => ({
    id: `m_${i + 1}`,
    tmdbId: String(1000 + i + 1),
    mediaType: i % 2 === 0 ? "movie" : "tv",
    title: i === 0 ? "Gibi" : `Test Yapım ${i + 1}`,
    originalTitle: i === 0 ? "Gibi" : `Test Title ${i + 1}`,
    origLang: i === 0 ? "tr" : "en",
    year: i < 5 ? "2026" : "2022",
    rating: 8.1,
    categories: i === 0 ? ["series", "tr", "trend"] : [i % 2 === 0 ? "movies" : "series", "trend"],
    poster: "https://image.tmdb.org/t/p/w500/test.jpg",
  }));

  const bootPayload = JSON.stringify({
    version: "20261114_v215",
    catalog,
    curatedRooms: [],
    newReleases: catalog.slice(0, 4),
    latestEpisodes: [],
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

  // 1. Spoofed okhttp UA without valid origin/token must return 403
  const reqOkhttp = new Request("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=1001&type=movie", {
    headers: { "User-Agent": "okhttp/4.12.0" },
  });
  const rOkhttp = await handleAutonomousEdge(reqOkhttp, new URL(reqOkhttp.url), "/api/rave/resolve-catalog", env);
  assert.equal(rOkhttp.status, 403);

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

  // 3. Single-slice page=2&limit=10 on 40-item catalog returns exact slice [11..20] + tr/vizyon filter checks
  const catReq = new Request("https://watchlivo.online/api/rave/catalog?page=2&limit=10", {
    headers: { "X-Watchlivo-Token": edgeToken },
  });
  const rCat = await handleAutonomousEdge(catReq, new URL(catReq.url), "/api/rave/catalog", env);
  assert.equal(rCat.status, 200);
  const catJson = await rCat.json();
  assert.equal(catJson.total, 40);
  assert.equal(catJson.hasMore, true);
  assert.equal(catJson.items.length, 10);
  assert.equal(catJson.items[0].id, "m_11");
  assert.equal(catJson.items[9].id, "m_20");

  const trReq = new Request("https://watchlivo.online/api/rave/catalog?category=tr", { headers: { "X-Watchlivo-Token": edgeToken } });
  const trJson = await (await handleAutonomousEdge(trReq, new URL(trReq.url), "/api/rave/catalog", env)).json();
  assert.equal(trJson.total, 1);
  assert.equal(trJson.items[0].title, "Gibi");

  const vizReq = new Request("https://watchlivo.online/api/rave/catalog?category=vizyon", { headers: { "X-Watchlivo-Token": edgeToken } });
  const vizJson = await (await handleAutonomousEdge(vizReq, new URL(vizReq.url), "/api/rave/catalog", env)).json();
  assert.equal(vizJson.total, 5);

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

  // 5. /api/rave/seasons movie guard + isFallback guard
  const movSeaReq = new Request("https://watchlivo.online/api/rave/seasons?tmdbId=1001&mediaType=movie", {
    headers: { "X-Watchlivo-Token": edgeToken },
  });
  const movSeaJson = await (await handleAutonomousEdge(movSeaReq, new URL(movSeaReq.url), "/api/rave/seasons", env)).json();
  assert.deepEqual(movSeaJson.seasons, []);
  assert.deepEqual(movSeaJson.episodes, []);

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("TMDB Down", { status: 500 });
    const tvSeaReq = new Request("https://watchlivo.online/api/rave/seasons?tmdbId=999999&mediaType=tv", {
      headers: { "X-Watchlivo-Token": edgeToken },
    });
    const tvSeaJson = await (await handleAutonomousEdge(tvSeaReq, new URL(tvSeaReq.url), "/api/rave/seasons", env)).json();
    assert.equal(tvSeaJson.isFallback, true);
  } finally {
    globalThis.fetch = origFetch;
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
