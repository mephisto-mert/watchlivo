import test from "node:test";
import assert from "node:assert/strict";

import {
  inferStreamReferer,
  isPublicHttpUrl,
  signProxySig,
  verifyProxySig,
  handleEdgeResolveCatalog,
  handleEdgeHlsManifest,
  handleEdgeStreamProxy,
  handleEdgeSubtitle,
  handleEdgePoster,
} from "../workers/ha-gateway/edge_streams.js";
import {
  isBlockedAdHost,
  isDirectEmbedPageUrl,
  decryptFilemoonPlayback,
  filterM3u8AdDiscontinuities,
  unpackDeanEdwards,
  resolveTurkishCatalogStream,
  extractSinemaccMovie,
} from "../workers/ha-gateway/edge_extractors.js";
import { isTrustedEmbedUrl } from "../static/js/players/embed.js";
import fs from "node:fs";
import {
  WatchlivoRoomDO,
  handleEdgeRoomCreate,
  handleEdgeRoomSync,
} from "../workers/ha-gateway/edge_rooms.js";
import { handleAutonomousEdge, fetchLiveSinemaccVizyonMovies } from "../workers/ha-gateway/edge_autonomous.js";
import { parseLrcToVtt, handleEdgeMusicRoute } from "../workers/ha-gateway/edge_music.js";
import streamProxyWorker from "../workers/stream-proxy/worker.js";

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
  //    (TMDB discover unavailable -> local bootstrap catalog fallback contract)
  const realFetchCat = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(typeof input === "string" ? input : input?.url || "");
    if (u.includes("api.themoviedb.org") || u.includes("sinemacc.com")) return new Response("{}", { status: 503 });
    return realFetchCat(input, init);
  };
  try {
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
  } finally {
    globalThis.fetch = realFetchCat;
  }

  // 3b. TMDB discover available -> totals come from TMDB total_results, local verified items lead page 1
  globalThis.fetch = async (input, init) => {
    const u = String(typeof input === "string" ? input : input?.url || "");
    if (u.includes("api.themoviedb.org/3/discover/")) {
      const isTv = u.includes("/discover/tv");
      const results = Array.from({ length: 20 }, (_, i) => ({
        id: (isTv ? 900000 : 800000) + i, name: `Disc TV ${i}`, title: `Disc Movie ${i}`,
        poster_path: "/p.jpg", genre_ids: [18], vote_average: 7, vote_count: 100,
        first_air_date: "2020-01-01", release_date: "2020-01-01",
      }));
      return new Response(JSON.stringify({ results, total_results: isTv ? 21000 : 54000 }), { status: 200 });
    }
    return realFetchCat(input, init);
  };
  try {
    const dReq = new Request("https://watchlivo.online/api/rave/catalog?provider=cinema&category=dram&page=1", { headers: { "X-Watchlivo-Token": edgeToken } });
    const dJson = await (await handleAutonomousEdge(dReq, new URL(dReq.url), "/api/rave/catalog", env)).json();
    assert.equal(dJson.source, "tmdb-discover");
    assert.equal(dJson.totalTv, 21000);
    assert.equal(dJson.totalMovies, 54000);
    assert.equal(dJson.totalAvailable, 75000);
    assert.equal(dJson.hasMore, true);
    assert.ok(dJson.items.length >= 40);
  } finally {
    globalThis.fetch = realFetchCat;
  }

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

test("anti_popup_betting_hardening: blocks 1xbet/vidlink embeds, strips allow-popups, unwraps vidmoly/fhd, filters m3u8 ads", async () => {
  // 1. embed.js sandbox & allowlist hardening
  const embedSrc = fs.readFileSync(new URL("../static/js/players/embed.js", import.meta.url), "utf8");
  assert.equal(embedSrc.includes("allow-popups"), false);
  for (const badEmbed of [
    "https://vidlink.pro/tv/316702/1/1",
    "https://vidsrc.to/embed/movie/550",
    "https://1xbet.com/promo",
    "https://tr.casibom.com/play",
  ]) {
    assert.equal(isTrustedEmbedUrl(badEmbed), false, `embed.js must reject ${badEmbed}`);
  }
  assert.equal(isTrustedEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ"), true);
  assert.equal(isTrustedEmbedUrl("https://player.twitch.tv/?channel=test&parent=watchlivo.online"), true);

  // 2. edge_streams & edge_extractors host/ad blocklist
  for (const badHost of [
    "https://1xbet-tr.com/landing",
    "https://melbet.org/stream",
    "https://vidlink.pro/movie/1184606",
    "https://popads.net/pop.js",
  ]) {
    assert.equal(isPublicHttpUrl(badHost), false, `isPublicHttpUrl must block ${badHost}`);
  }
  assert.equal(isBlockedAdHost("onebahis.com"), true);

  // 3. M3U8 discontinuity ad stripping preserves real segments and drops betting discontinuities
  const rawPlaylist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:6.0,",
    "https://cdn.example.com/seg1.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:10.0,",
    "https://ads.example.com/1xbet_preroll_01.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:6.0,",
    "https://cdn.example.com/seg2.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const stripped = filterM3u8AdDiscontinuities(rawPlaylist);
  assert.ok(stripped.includes("seg1.ts"));
  assert.ok(stripped.includes("seg2.ts"));
  assert.equal(stripped.includes("1xbet_preroll"), false);

  // 4. Dean Edwards static unpacker without eval()
  const packed = "eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0 1=\"2://3.4/5.6\";',7,7,'var|u|https|cdn|test|master|m3u8'.split('|'),0,{}))";
  assert.equal(unpackDeanEdwards(packed), 'var u="https://cdn.test/master.m3u8";');

  // 5. handleEdgeResolveCatalog never falls back to vidlink.pro and extracts Turkish rapidvid live
  const payloadJson = JSON.stringify({ cm: "https://s34.cdnimage123.shop/mm/test_stream", ct: [{ label: "Türkçe", file: "https://subs.rapidvid.org/1.vtt" }] });
  const b64Inner = Buffer.from(payloadJson, "utf8").toString("base64");
  const key = "K9L";
  let shifted = "";
  for (let i = 0; i < b64Inner.length; i++) shifted += String.fromCharCode(b64Inner.charCodeAt(i) + ((key.charCodeAt(i % 3) % 5) + 1));
  const p8Enc = Buffer.from(shifted, "latin1").toString("base64").split("").reverse().join("");
  const vodUrlB64 = Buffer.from("https://rapidvid.org/vx/testvod123", "utf8").toString("base64");
  const vodRot13 = vodUrlB64.replace(/[a-zA-Z]/g, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });

  const env = { ...TEST_ENV, WATCHLIVO_KV: createMockKv() };
  const jsonResp = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const s = typeof input === "string" ? input : input.url;
      if (s.includes("fullhdfilmizlesene.now/film/ataturk")) {
        return new Response(`<script>var scx = {"atom":{"sx":{"t":["${vodRot13}"]}}};</script>`, { status: 200 });
      }
      if (s.includes("rapidvid.org/vx/testvod123")) {
        return new Response(`<script>window._p8 = '${p8Enc}';</script>`, { status: 200 });
      }
      if (s.includes("vidmoly.biz/embed-abc123.html")) {
        return new Response(`<html><script>file:"https://box-10.vmbox.space/hls/test/master.m3u8"</script></html>`, { status: 200 });
      }
      if (s.includes("vmbox.space/hls/test/master.m3u8")) {
        return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nhttps://box-10.vmbox.space/hls/test/720.m3u8\n", {
          status: 200,
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const resFhf = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=1184606&type=movie&title=Ataturk&sourceUrl=https%3A%2F%2Fwww.fullhdfilmizlesene.now%2Ffilm%2Fataturk-1881-1919%2F"),
      env,
      jsonResp
    );
    assert.equal(resFhf.status, 200);
    const fhfJson = await resFhf.json();
    assert.equal(fhfJson.streamType, "hls");
    assert.ok(fhfJson.url.startsWith("/api/rave/stream?"));
    assert.equal(JSON.stringify(fhfJson).includes("vidlink.pro"), false);

    // Miss case must return 404, never vidlink.pro
    const resMiss = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=99999999&type=tv&season=1&episode=1&title=Nonexistent"),
      env,
      jsonResp
    );
    assert.equal(resMiss.status, 404);
    assert.equal((await resMiss.text()).includes("vidlink.pro"), false);

    // Vidmoly HTML embed inside HLS manifest endpoint unwraps cleanly to rewritten M3U8
    const resVm = await handleEdgeHlsManifest(
      new URL("https://watchlivo.online/api/rave/stream?url=https%3A%2F%2Fvidmoly.biz%2Fembed-abc123.html"),
      env
    );
    assert.equal(resVm.status, 200);
    const vmM3u8 = await resVm.text();
    assert.ok(vmM3u8.includes("#EXTM3U"));
    assert.ok(vmM3u8.includes("/api/rave/stream?sid="));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("regression: Animecix null-tmdb_id cannot hijack Son Masa (316702), Sheila beats vmpx /hls2/, and Ataturk (1184606) resolves to CF-safe shard", async () => {
  const origFetch = globalThis.fetch;
  try {
    const mockFetch = async (input) => {
      const u = typeof input === "string" ? input : input.url;
      if (u.includes("animecix.tv/secure/search/")) {
        return new Response(JSON.stringify({
          results: [{ id: 999999, name: "Final Table Anime", title_type: "anime", is_series: true, tmdb_id: null }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("animecix.tv/secure/titles/999999")) {
        return new Response(JSON.stringify({
          title: { videos: [{ url: "https://anime.example.com/hijack.mp4", name: "720p" }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u === "https://www.dizibox.live/final-table-1-sezon-1-bolum-izle/") {
        return new Response(
          `<html><title>Final Table 1. Sezon 1. Bölüm</title>` +
          `<iframe src="https://www.dizibox.live/player/moly/moly.php?h=m1"></iframe>` +
          `<iframe src="https://www.dizibox.live/player/king/king.php?v=k1"></iframe></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      if (u === "https://www.dizibox.live/player/moly/moly.php?h=m1") {
        return new Response(`<iframe src="https://vidmoly.biz/embed-mockvmpx.html"></iframe>`, { status: 200 });
      }
      if (u === "https://vidmoly.biz/embed-mockvmpx.html") {
        return new Response(`<script>sources: [{file:"https://prx-1350-ant-d.vmpx.online/hls2/01/master.m3u8"}]</script>`, { status: 200 });
      }
      if (u === "https://vidmoly.biz/embed-mockvmbox.html") {
        return new Response(`<script>sources: [{file:"https://box-1093-w.vmbox.space/hls/master.m3u8"}]</script>`, { status: 200 });
      }
      if (u === "https://www.dizibox.live/player/king/king.php?v=k1") {
        return new Response(`<iframe src="https://dbx.molystream.org/embed/sheilakey1"></iframe>`, { status: 200 });
      }
      if (u === "https://prx-1350-ant-d.vmpx.online/hls2/01/master.m3u8" || u === "https://box-1093-w.vmbox.space/hls/master.m3u8") {
        return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nseg.m3u8\n", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };
    globalThis.fetch = mockFetch;

    const jsonResp = (obj, st = 200) =>
      new Response(JSON.stringify(obj), { status: st, headers: { "Content-Type": "application/json" } });
    const env = {
      ...TEST_ENV,
      WATCHLIVO_KV: createMockKv(),
      ASSETS: { async fetch() { return new Response("Not Found", { status: 404 }); } },
    };
    const rSonMasa = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?id=hfnl-final-table-2026&tmdbId=316702&type=tv&season=1&episode=1&title=Son+Masa&originalTitle=Final+Table"),
      env,
      jsonResp
    );
    assert.equal(rSonMasa.status, 200);
    const sonMasaData = await rSonMasa.json();
    assert.equal(sonMasaData.catalogProvider, "cinema");
    const sonMasaRaw = JSON.stringify(sonMasaData);
    assert.ok(
      decodeURIComponent(sonMasaRaw).includes("dbx.molystream.org/embed/sheila/sheilakey1") ||
      sonMasaRaw.includes("bW9seXN0cmVhbS5vcmcvZW1iZWQvc2hlaWxhL3NoZWlsYWtleTE")
    );

    const vmpxOrdered = await resolveTurkishCatalogStream({
      title: "Son Masa",
      displayTitle: "Son Masa",
      originalTitle: "Final Table",
      sourceUrl: "https://www.dizibox.so/diziler/final-table/",
      mtype: "tv",
      s: 1,
      e: 1,
      fetchPublicFn: async (target) => ({ resp: await mockFetch(target) }),
    });
    assert.equal(vmpxOrdered?.url, "https://dbx.molystream.org/embed/sheila/sheilakey1");
    assert.equal(vmpxOrdered?.streams?.length, 2);
    assert.ok(vmpxOrdered.streams[0].url.includes("dbx.molystream.org"));
    assert.ok(vmpxOrdered.streams[1].url.includes("vmpx.online"));

    const vmboxFetch = async (target) => {
      if (target === "https://www.dizibox.live/player/moly/moly.php?h=m1") {
        return { resp: new Response(`<iframe src="https://vidmoly.biz/embed-mockvmbox.html"></iframe>`, { status: 200 }) };
      }
      return { resp: await mockFetch(target) };
    };
    const vmboxOrdered = await resolveTurkishCatalogStream({
      title: "Son Masa",
      displayTitle: "Son Masa",
      originalTitle: "Final Table",
      sourceUrl: "https://www.dizibox.so/diziler/final-table/",
      mtype: "tv",
      s: 1,
      e: 1,
      fetchPublicFn: vmboxFetch,
    });
    assert.equal(vmboxOrdered?.url, "https://box-1093-w.vmbox.space/hls/master.m3u8");
    assert.ok(vmboxOrdered.streams[0].url.includes("vmbox.space"));

    const shardEnv = {
      ...TEST_ENV,
      WATCHLIVO_KV: createMockKv(),
      ASSETS: {
        async fetch(req) {
          const u = new URL(typeof req === "string" ? req : req.url);
          try {
            const p = new URL(`../workers/ha-gateway/public${u.pathname}`, import.meta.url);
            const txt = fs.readFileSync(p, "utf8");
            return new Response(txt, { status: 200, headers: { "Content-Type": "application/json" } });
          } catch {
            return new Response("Not Found", { status: 404 });
          }
        },
      },
    };
    const rAtaturk = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?id=fhd-ataturk-1881-1919&tmdbId=1184606&type=movie&title=Atat%C3%BCrk+1881-1919"),
      shardEnv,
      jsonResp
    );
    assert.equal(rAtaturk.status, 200);
    const ataturkData = await rAtaturk.json();
    assert.equal(ataturkData.catalogProvider, "netflix");
    const ataturkRaw = JSON.stringify(ataturkData);
    assert.ok(
      decodeURIComponent(ataturkRaw).includes("s34.static8024.shop/m1/") ||
      ataturkRaw.includes("aHR0cHM6Ly9zMzQuc3RhdGljODAyNC5zaG9wL20x"),
      `Unexpected Ataturk payload: ${ataturkRaw.slice(0, 300)}`
    );

    const rSonMasaEp1 = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=316702&type=tv&season=1&episode=1&title=Son+Masa&originalTitle=Final+Table"),
      shardEnv,
      jsonResp
    );
    assert.equal(rSonMasaEp1.status, 200);
    const sonMasaEp1Data = await rSonMasaEp1.json();
    assert.equal(sonMasaEp1Data.catalogProvider, "netflix");
    assert.ok(JSON.stringify(sonMasaEp1Data).includes("aHR0cHM6Ly9obHMwOC5jZG52aWRlbzExLnNob3AvaGxzMDgvMTM3OTAvRXAx"));
    assert.ok(Array.isArray(sonMasaEp1Data.subtitleTracks) && sonMasaEp1Data.subtitleTracks.some((s) => s.lang === "tr"));

    const rSonMasaEp2 = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=316702&type=tv&season=1&episode=2&title=Son+Masa&originalTitle=Final+Table"),
      shardEnv,
      jsonResp
    );
    assert.equal(rSonMasaEp2.status, 200);
    const sonMasaEp2Data = await rSonMasaEp2.json();
    assert.equal(sonMasaEp2Data.catalogProvider, "netflix");
    assert.ok(JSON.stringify(sonMasaEp2Data).includes("aHR0cHM6Ly9obHMwOC5jZG52aWRlbzExLnNob3AvaGxzMDgvMTM3OTAvRXAy"));
    assert.equal(inferStreamReferer("https://hls08.cdnvideo11.shop/hls08/13790/Ep1.v715_index.m3u8"), "https://kisskh.co/");
    assert.equal(inferStreamReferer("https://hls08.streamingcdn5.site/13790/Ep1.v715_index0.ts"), "https://kisskh.co/");

    // Turkish displayTitle with 3+ words must still search Webteizle using originalTitle
    const wtOrigCalls = [];
    globalThis.fetch = async (input, init) => {
      const u = typeof input === "string" ? input : input.url;
      if (u === "https://webteizle.info/ajax/arama.asp") {
        const bodyStr = String(init?.body || "");
        wtOrigCalls.push(decodeURIComponent(bodyStr.replace(/^q=/, "")));
        if (bodyStr.includes("Paranormal+Activity") || bodyStr.includes("Paranormal%20Activity")) {
          return new Response(JSON.stringify({
            status: "success",
            results: { filmler: { results: [{ title: "Paranormal Activity (2007)", description: "", url: "/hakkinda/paranormal-activity" }] } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "success", results: { filmler: { results: [] } } }), { status: 200 });
      }
      if (u === "https://webteizle.info/hakkinda/paranormal-activity") {
        return new Response('<a href="/izle/dublaj/paranormal-activity">İzle</a>', { status: 200 });
      }
      if (u === "https://webteizle.info/izle/dublaj/paranormal-activity") {
        return new Response('<div id="dilsec" data-id="1001"><a data-dil="0"></a></div>', { status: 200 });
      }
      if (u === "https://webteizle.info/ajax/dataAlternatif3.asp") {
        return new Response(JSON.stringify({ status: "success", data: [{ id: 99, baslik: "VidMoly", kalitesi: 1 }] }), { status: 200 });
      }
      if (u === "https://webteizle.info/ajax/dataEmbed.asp") {
        return new Response("<script>vidmoly('pa1mock','rv1');</script>", { status: 200 });
      }
      if (u.startsWith("https://vidmoly.biz/embed-pa1mock.html")) {
        return new Response("sources:[{file:'https://box-1093-w.vmbox.space/hls/pa1/master.m3u8'}]", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };
    const wtOrigRes = await resolveTurkishCatalogStream({
      title: "Paranormal Aktivite: Hayalet Boyutu",
      displayTitle: "Paranormal Aktivite: Hayalet Boyutu",
      originalTitle: "Paranormal Activity",
      year: "2007",
      mtype: "movie",
      s: 1,
      e: 1,
      fetchPublicFn: async (target) => ({ resp: await globalThis.fetch(target) }),
    });
    assert.ok(wtOrigCalls.includes("Paranormal Activity"));
    assert.equal(wtOrigRes?.url, "https://box-1093-w.vmbox.space/hls/pa1/master.m3u8");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("regression: handleEdgeStreamProxy allows cloaked javascript/font MPEG-TS as video/mp2t while blocking JS/HTML and surfacing upstream status", async () => {
  const origFetch = globalThis.fetch;
  try {
    const cloakedTs = new Uint8Array([0x47, 0x40, 0x11, 0x10, 0x00, 0x42, 0xf0, 0x25]);

    const jsSegUrl = "https://epsilon.3d7f5e49f95bc7.click/seg1.js";
    const jsSegSig = await signProxySig(jsSegUrl, "", TEST_ENV);
    globalThis.fetch = async () =>
      new Response(cloakedTs, { status: 200, headers: { "Content-Type": "application/javascript" } });
    const reqJsSeg = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(jsSegUrl)}&sig=${jsSegSig}&ext=.js`
    );
    const rJsSeg = await handleEdgeStreamProxy(new Request(reqJsSeg), reqJsSeg, TEST_ENV);
    assert.equal(rJsSeg.status, 200);
    assert.equal(rJsSeg.headers.get("Content-Type"), "video/mp2t");
    assert.deepEqual(new Uint8Array(await rJsSeg.arrayBuffer()), cloakedTs);

    const fontSegUrl = "https://redirector.centralodsseyproud.click/seg2.ttf";
    const fontSegSig = await signProxySig(fontSegUrl, "", TEST_ENV);
    globalThis.fetch = async () =>
      new Response(cloakedTs, { status: 200, headers: { "Content-Type": "font/ttf" } });
    const reqFontSeg = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(fontSegUrl)}&sig=${fontSegSig}&ext=.ttf`
    );
    const rFontSeg = await handleEdgeStreamProxy(new Request(reqFontSeg), reqFontSeg, TEST_ENV);
    assert.equal(rFontSeg.status, 200);
    assert.equal(rFontSeg.headers.get("Content-Type"), "video/mp2t");

    const realJsUrl = "https://cdn.example.com/payload.js";
    const realJsSig = await signProxySig(realJsUrl, "", TEST_ENV);
    globalThis.fetch = async () =>
      new Response("globalThis.x = 1; console.log(1);", { status: 200, headers: { "Content-Type": "application/javascript" } });
    const reqRealJs = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(realJsUrl)}&sig=${realJsSig}`
    );
    const rRealJs = await handleEdgeStreamProxy(new Request(reqRealJs), reqRealJs, TEST_ENV);
    assert.equal(rRealJs.status, 502);
    assert.equal(await rRealJs.text(), "Disallowed upstream content type");

    const errHtmlUrl = "https://cdn.example.com/blocked.ts";
    const errHtmlSig = await signProxySig(errHtmlUrl, "", TEST_ENV);
    globalThis.fetch = async () =>
      new Response("<html>403 Forbidden</html>", { status: 403, headers: { "Content-Type": "text/html" } });
    const reqErrHtml = new URL(
      `https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(errHtmlUrl)}&sig=${errHtmlSig}`
    );
    const rErrHtml = await handleEdgeStreamProxy(new Request(reqErrHtml), reqErrHtml, TEST_ENV);
    assert.equal(rErrHtml.status, 502);
    assert.equal(await rErrHtml.text(), "Upstream 403");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("edge_extractors: webteizle movie, dizibox series & dead cdnimages shard fallback", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = typeof input === "string" ? input : input.url;
    if (u === "https://webteizle.info/ajax/arama.asp") {
      return new Response(JSON.stringify({
        status: "success",
        results: { filmler: { results: [{ title: "Atatürk 1881 - 1919 Part 1 (2024)", description: "", url: "/hakkinda/ataturk-1881-1919" }] } },
      }), { status: 200 });
    }
    if (u === "https://webteizle.info/hakkinda/ataturk-1881-1919") {
      return new Response('<a href="/izle/dublaj/ataturk-1881-1919">İzle</a>', { status: 200 });
    }
    if (u === "https://webteizle.info/izle/dublaj/ataturk-1881-1919") {
      return new Response('<div id="dilsec" data-id="16036"><a data-dil="0"></a></div>', { status: 200 });
    }
    if (u === "https://webteizle.info/ajax/dataAlternatif3.asp") {
      return new Response(JSON.stringify({ status: "success", data: [{ id: 524129, baslik: "VidMoly", kalitesi: 1 }] }), { status: 200 });
    }
    if (u === "https://webteizle.info/ajax/dataEmbed.asp") {
      return new Response("<script>vidmoly('xmtnmjjw6wa5','rv1');</script>", { status: 200 });
    }
    if (u.startsWith("https://vidmoly.biz/embed-xmtnmjjw6wa5.html")) {
      return new Response("sources:[{file:'https://prx-1350-ant-d.vmget.online/hls2/02/xmtnmjjw6wa5/master.m3u8'}]", { status: 200 });
    }
    if (u === "https://www.dizibox.live/final-table-1-sezon-1-bolum-izle/") {
      return new Response(
        '<title>Final Table 1.Sezon 1.Bölüm - DiziBOX</title><iframe src="https://www.dizibox.live/player/king/king.php?v=abc123"></iframe>',
        { status: 200 }
      );
    }
    if (u.startsWith("https://www.dizibox.live/player/king/king.php")) {
      return new Response('<iframe src="https://dbx.molystream.org/embed/24552-6adefc37f9a7672ac5127492"></iframe>', { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  };
  try {
    const jsonResp = (obj, st = 200) => new Response(JSON.stringify(obj), { status: st, headers: { "content-type": "application/json" } });
    // Vault has only dead cdnimages /hls/ shard -> must skip dead shard and resolve via Dizibox live extractor
    const staleKv = new Map([
      ["tmdb:tv:316702:s1e1", JSON.stringify({
        streams: [["https://srv8.cdnimages3739.cyou/hls/finaltable-s01e01-webdl.mp4/txt/master.txt?s=expired", "hls_hfnl_multi"]],
        subs: [],
      })],
    ]);
    const env = {
      PROXY_SECRET: "test-secret-key",
      WATCHLIVO_KV: { async get(k) { return staleKv.get(k) || null; } },
      ASSETS: { async fetch() { return new Response("Not Found", { status: 404 }); } },
    };

    const resTv = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=316702&type=tv&season=1&episode=1&title=Son+Masa&originalTitle=Final+Table"),
      env,
      jsonResp
    );
    assert.equal(resTv.status, 200);
    const tvJson = await resTv.json();
    assert.equal(tvJson.servers.length >= 1, true);
    assert.ok(tvJson.url.includes("bW9seXN0cmVhb") || decodeURIComponent(tvJson.url).includes("stream?"));

    const resMov = await handleEdgeResolveCatalog(
      new URL("https://watchlivo.online/api/rave/resolve-catalog?tmdbId=1184606&type=movie&title=Atat%C3%BCrk+1881-1919&year=2024"),
      env,
      jsonResp
    );
    assert.equal(resMov.status, 200);
    const movJson = await resMov.json();
    assert.equal(movJson.streamType, "hls");
    assert.ok(movJson.url.startsWith("/api/rave/stream?"));
    assert.equal(inferStreamReferer("https://prx-1316-ant.vmget.online/hls2/a/master.m3u8"), "https://vidmoly.biz/");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("security & fail-closed routes: edgeJson headers, /api/* 404/401/501, extract-video SSRF, stream-proxy decimal/hex IP", async () => {
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

  const ssrfRes = await callEdge(
    "/api/rave/extract-video?url=" + encodeURIComponent("http://127.0.0.1:8080/secret")
  );
  assert.equal(ssrfRes.status, 400);

  for (const badHost of ["http://2130706433/v.mp4", "http://0x7f000001/v.mp4", "http://0177.0.0.1/v.mp4"]) {
    const sig = await signProxySig(badHost, "", env);
    const spRes = await streamProxyWorker.fetch(
      new Request(`https://proxy.example.com/api/rave/stream-proxy?url=${encodeURIComponent(badHost)}&sig=${sig}`),
      env
    );
    assert.equal(spRes.status, 403);
  }
});

test("edge_extractors & edge_music: no double dizibox call and plainLyrics/audio YT fallback", async () => {
  const origFetch = globalThis.fetch;
  let dbxHits = 0;
  try {
    globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input.url;
      if (u.includes("dizibox.live")) {
        dbxHits++;
        return new Response("Not Found", { status: 404 });
      }
      if (u.startsWith("https://lrclib.net/api/get")) {
        return new Response(JSON.stringify({ plainLyrics: "Line one\nLine two" }), { status: 200 });
      }
      if (u.startsWith("https://www.youtube.com/results")) {
        return new Response('{"videoId":"dQw4w9WgXcQ"}', { status: 200 });
      }
      return new Response("", { status: 404 });
    };

    const resDbx = await resolveTurkishCatalogStream({
      title: "Missing Show",
      originalTitle: "Missing Show",
      sourceUrl: "https://www.dizibox.live/diziler/missing-show/",
      mtype: "tv",
      s: 1,
      e: 2,
      fetchPublicFn: async (u) => ({ resp: await fetch(u), finalUrl: u }),
    });
    assert.equal(resDbx, null);
    assert.equal(dbxHits, 2); // 2 unique slugs once, NOT 4 (no double invocation)

    const env = { WATCHLIVO_KV: createMockKv() };
    const vttRes = await handleEdgeMusicRoute(
      new Request("https://watchlivo.online/api/rave/music-lyrics.vtt?artist=Test&title=Song"),
      new URL("https://watchlivo.online/api/rave/music-lyrics.vtt?artist=Test&title=Song"),
      "/api/rave/music-lyrics.vtt",
      env
    );
    assert.equal(vttRes.status, 200);
    const vttTxt = await vttRes.text();
    assert.ok(vttTxt.includes("Line one") && vttTxt.includes("Line two"));

    const audRes = await handleEdgeMusicRoute(
      new Request("https://watchlivo.online/api/rave/music-resolve?artist=Test&title=Song&mode=audio"),
      new URL("https://watchlivo.online/api/rave/music-resolve?artist=Test&title=Song&mode=audio"),
      "/api/rave/music-resolve",
      env
    );
    assert.equal(audRes.status, 200);
    const audJson = await audRes.json();
    assert.equal(audJson.videoId, "dQw4w9WgXcQ");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("FileMoon AES-GCM playback decryption and direct embed page unwrapping", async () => {
  assert.equal(isDirectEmbedPageUrl("https://filemoon.sx/e/axwfo34qzc9e"), true);
  assert.equal(isBlockedAdHost("filemoon.sx"), true);

  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const toB64Url = (u8) => Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const parts = Array.from({ length: 30 }, () => toB64Url(crypto.getRandomValues(new Uint8Array(16))));
  parts[18] = toB64Url(keyBytes.slice(0, 16));
  parts[11] = toB64Url(keyBytes.slice(16, 32));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const plain = JSON.stringify({ sources: [{ url: "https://cdn.example.net/master.m3u8", mime_type: "application/vnd.apple.mpegurl" }] });
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivBytes }, cryptoKey, new TextEncoder().encode(plain));

  const decoded = await decryptFilemoonPlayback({
    version: "19",
    iv: toB64Url(ivBytes),
    payload: toB64Url(new Uint8Array(cipherBuf)),
    key_parts: parts,
  });
  assert.equal(decoded.sources[0].url, "https://cdn.example.net/master.m3u8");
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
  assert.equal(data.rooms.some((r) => r.id === "tv-atv"), true);

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

test("vizyon: extractSinemaccMovie parses film_kutusu title/span, dual-language slugs, apostrophes, and direct sourceUrl", async () => {
  const origFetch = globalThis.fetch;
  const playerB64 = Buffer.from("https://player.filmizle.in/video/abcdef0123456789abcd?lng=tur").toString("base64");
  const filmPageHtml = `<html><head><title>Test (2026)</title></head><body><script>var p="${playerB64}";</script></body></html>`;
  const searchHtml = `
    <html><body>
      <h2>Arama Sonuçları</h2>
      <div data-page="1" class="film_kutusu">
        <a href="https://sinemacc.com/film/son-bir-atis-one-last-shot-2026/" title="Son Bir Atış İzle">
          <span class="box type"><svg class="flg2 svgcon"><use href="/tema/_temaicons.svg#icon_subtitle"></use></svg></span>
          <span class="title"><span class="text">Son Bir Atış</span><span class="years">2026 | Aksiyon</span></span>
        </a>
      </div>
      <div data-page="1" class="film_kutusu">
        <a href="https://sinemacc.com/film/kotu-elmalar-bad-apples-2026/" title="Kötü Elmalar İzle">
          <span class="box type"><svg class="flg2 svgcon"><use href="/tema/_temaicons.svg#icon_tr"></use></svg></span>
          <span class="title"><span class="text">Kötü Elmalar</span><span class="years">2026 | Komedi</span></span>
        </a>
      </div>
      <div data-page="1" class="film_kutusu">
        <a href="https://sinemacc.com/film/tadin-sihirli-lambasi-tad-and-the-magic-lamp-2026/" title="Tad'ın Sihirli Lambası İzle">
          <span class="box type"><svg class="flg2 svgcon"><use href="/tema/_temaicons.svg#icon_tr"></use></svg></span>
          <span class="title"><span class="text">Tad'ın Sihirli Lambası</span><span class="years">2026 | Animasyon</span></span>
        </a>
      </div>
    </body></html>`;
  const mockFetchPub = async (u) => {
    const s = String(u);
    if (s.includes("sinemacc.com/arama/")) {
      return { resp: new Response(searchHtml, { status: 200 }), finalUrl: s };
    }
    if (s.includes("sinemacc.com/film/")) {
      return { resp: new Response(filmPageHtml, { status: 200 }), finalUrl: s };
    }
    if (s.includes("player.filmizle.in/video/")) {
      return { resp: new Response(`playerjsSubtitle = "[Türkçe]https://player.filmizle.in/sub/tr.vtt"`, { status: 200 }), finalUrl: s };
    }
    if (s.includes("player.filmizle.in/cdn/hls/")) {
      return { resp: new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n1080.m3u8\n", { status: 200 }), finalUrl: s };
    }
    return { resp: new Response("Not Found", { status: 404 }), finalUrl: s };
  };
  globalThis.fetch = async (u) => {
    if (String(u).includes("do=getVideo")) {
      return Response.json({ securedLink: "https://player.filmizle.in/cdn/hls/abcdef0123456789abcd/master.m3u8" });
    }
    return new Response("Not Found", { status: 404 });
  };
  try {
    // 1. Dual-language slug where Turkish title differs (Çürük Elmalar vs Kötü Elmalar, matching Bad Apples suffix)
    const rBad = await extractSinemaccMovie({ title: "Bad Apples", displayTitle: "Çürük Elmalar", originalTitle: "Bad Apples", year: "2025" }, mockFetchPub);
    assert.ok(rBad?.url?.includes("player.filmizle.in/cdn/hls/"), "Bad Apples dual-slug match failed");
    assert.equal(rBad.subs.length, 1);

    // 2. Apostrophe possessive title (Tad'ın Sihirli Lambası)
    const rTad = await extractSinemaccMovie({ title: "Tadeo Jones y la lámpara maravillosa", displayTitle: "Tad'ın Sihirli Lambası", originalTitle: "Tadeo Jones y la lámpara maravillosa", year: "2026" }, mockFetchPub);
    assert.ok(rTad?.url?.includes("player.filmizle.in/cdn/hls/"), "Tad'ın Sihirli Lambası match failed");

    // 3. Direct sourceUrl fast-path (skips /arama/)
    const rDirect = await extractSinemaccMovie({ title: "Odyssey", sourceUrl: "https://sinemacc.com/film/odyssey-the-odyssey-2026/", year: "2026" }, mockFetchPub);
    assert.ok(rDirect?.url?.includes("player.filmizle.in/cdn/hls/"), "Direct sinemacc sourceUrl fast-path failed");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("vizyon: fetchLiveSinemaccVizyonMovies excludes trailer-only and DMCA abuse-telif cards and keeps verified playable 2026 films", async () => {
  const origFetch = globalThis.fetch;
  const kv = createMockKv();
  const validB64 = Buffer.from("https://player.filmizle.in/video/112233445566778899aa?lng=trsub").toString("base64");
  const abuseB64 = Buffer.from("https://sinemacc.com/abuse-telif").toString("base64");
  const curYr = new Date().getUTCFullYear();
  const listingHtml = `
    <div class="film_kutusu">
      <a href="https://sinemacc.com/film/trailer-only-${curYr}/" title="Trailer Only İzle">
        <span class="imdb"><svg></svg>7.9</span>
        <span class="title"><span class="text">Trailer Only</span><span class="years">${curYr} | Aksiyon</span></span>
      </a>
    </div>
    <div class="film_kutusu">
      <a href="https://sinemacc.com/film/dmca-film-${curYr}/" title="DMCA Film İzle">
        <span class="box type"><svg class="flg2"><use href="#icon_subtitle"></use></svg></span>
        <span class="imdb"><svg></svg>6.9</span>
        <span class="title"><span class="text">DMCA Film</span><span class="years">${curYr} | Dram</span></span>
      </a>
    </div>
    <div class="film_kutusu">
      <a href="https://sinemacc.com/film/odyssey-the-odyssey-${curYr}/" title="Odyssey İzle">
        <span class="box type"><svg class="flg2"><use href="#icon_subtitle"></use></svg></span>
        <span class="imdb"><svg></svg>8.4</span>
        <img data-src="https://sinemacc.com/uploads/filmler/odyssey.webp" />
        <span class="title"><span class="text">Odyssey</span><span class="years">${curYr} | Macera</span></span>
      </a>
    </div>`;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes(`/yil/${curYr}/`)) {
      return new Response(s.includes("/page/") ? "" : listingHtml, { status: 200 });
    }
    if (s.includes(`dmca-film-${curYr}`)) {
      return new Response(`<h1 class="baslik">DMCA Film İzle</h1><script>var p="${abuseB64}";</script>`, { status: 200 });
    }
    if (s.includes(`odyssey-the-odyssey-${curYr}`)) {
      return new Response(
        `<meta property="og:image" content="https://sinemacc.com/uploads/filmler/odyssey_f.webp" />
         <h1 class="baslik">Odyssey İzle</h1><h2 class="baslik orj">The Odyssey</h2>
         <a href="https://www.imdb.com/title/tt33764258/">IMDb</a><script>var p="${validB64}";</script>`,
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  };
  try {
    const items = await fetchLiveSinemaccVizyonMovies({ WATCHLIVO_KV: kv }, { forceRefresh: true, maxItems: 10 });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, `sc-odyssey-the-odyssey-${curYr}`);
    assert.equal(items[0].title, "Odyssey");
    assert.equal(items[0].originalTitle, "The Odyssey");
    assert.equal(items[0].imdbId, "tt33764258");
    assert.equal(items[0].sourceUrl, `https://sinemacc.com/film/odyssey-the-odyssey-${curYr}/`);
    assert.equal(items[0].isVizyon, true);
    assert.equal(inferStreamReferer("https://ddizimag2.icu/film/test"), "https://ddizimag2.icu/");
  } finally {
    globalThis.fetch = origFetch;
  }
});
