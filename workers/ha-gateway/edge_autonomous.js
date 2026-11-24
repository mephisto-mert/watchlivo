import {
  handleEdgeResolveCatalog,
  handleEdgeHlsManifest,
  handleEdgeStreamProxy,
  handleEdgeSubtitle,
  handleEdgePoster,
  isPublicHttpUrl,
  signProxySig,
  normalizeSubLang,
  formatSubLabel,
  detectSubtitleTextLang,
  isCorruptOrForeignSubtitleText,
  decodeSubtitleBytes,
} from "./edge_streams.js";
import {
  DEFAULT_CURATED_LIVE_ROOMS,
  DEFAULT_CURATED_MAP,
  handleEdgeRoomCreate,
  handleEdgeRoomInfo,
  handleEdgeRoomSync,
  handleEdgeRoomVoiceRelay,
  handleEdgeRoomWs,
  listGlobalPublicRooms,
  verifyRoomClientToken,
} from "./edge_rooms.js";
import { handleEdgeMusicRoute } from "./edge_music.js";

let _bootCache = null;
let _curatedMap = null;
const _edgeSearchCache = new Map();
const _authRateLimitMap = new Map();
let _blockedCache = { ts: 0, set: new Set() };
const DEFAULT_TMDB_KEY = "4f042878f22ef63cb94f25e60cb4ec6e";

const _memEphemeralStore = new Map();
const _memPersistFallback = new Map();
let _authDoQuotaUntil = 0;
let _d1KvSchemaReady = false;
let _d1KvSchemaPromise = null;

async function ensureD1KvSchema(db) {
  if (!db) return false;
  if (_d1KvSchemaReady) return true;
  if (!_d1KvSchemaPromise) {
    _d1KvSchemaPromise = db
      .prepare("CREATE TABLE IF NOT EXISTS edge_kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)")
      .run()
      .then(() => { _d1KvSchemaReady = true; return true; })
      .catch(() => false)
      .finally(() => { _d1KvSchemaPromise = null; });
  }
  return await _d1KvSchemaPromise;
}

async function d1KvGet(db, k) {
  if (!db) return { found: false, deleted: false, value: null, error: false };
  if (!(await ensureD1KvSchema(db))) return { found: false, deleted: false, value: null, error: true };
  try {
    const row = await db.prepare("SELECT v, exp, deleted FROM edge_kv WHERE k = ?").bind(k).first();
    if (!row) return { found: false, deleted: false, value: null, error: false };
    const nowS = Math.floor(Date.now() / 1000);
    if (Number(row.exp || 0) > 0 && Number(row.exp) < nowS) {
      await db.prepare("DELETE FROM edge_kv WHERE k = ?").bind(k).run().catch(() => {});
      return { found: false, deleted: false, value: null, error: false };
    }
    return { found: true, deleted: Number(row.deleted || 0) === 1, value: Number(row.deleted || 0) === 1 ? null : row.v, error: false };
  } catch {
    return { found: false, deleted: false, value: null, error: true };
  }
}

async function d1KvPut(db, k, strVal, ttlSec = 0) {
  if (!db || !(await ensureD1KvSchema(db))) return false;
  try {
    const exp = ttlSec > 0 ? Math.floor(Date.now() / 1000) + Math.round(ttlSec) : 0;
    await db
      .prepare("INSERT INTO edge_kv (k, v, exp, deleted) VALUES (?, ?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp, deleted = 0")
      .bind(k, strVal, exp)
      .run();
    return true;
  } catch {
    return false;
  }
}

async function d1KvDelete(db, k) {
  if (!db || !(await ensureD1KvSchema(db))) return false;
  try {
    await db
      .prepare("INSERT INTO edge_kv (k, v, exp, deleted) VALUES (?, NULL, 0, 1) ON CONFLICT(k) DO UPDATE SET v = NULL, exp = 0, deleted = 1")
      .bind(k)
      .run();
    return true;
  } catch {
    return false;
  }
}

function isEphemeralStoreKey(key) {
  const k = String(key || "");
  return (
    k.startsWith("rl:") ||
    k.startsWith("soc:pres:") ||
    k.startsWith("soc:typ:") ||
    k.startsWith("tmdb_q:") ||
    k.startsWith("tmdb2imdb:") ||
    k.startsWith("sub:") ||
    k.startsWith("subs:") ||
    k.startsWith("seasons:") ||
    k.startsWith("edge_sub:") ||
    k.startsWith("edge_cat:") ||
    k.startsWith("vizyon_cache:") ||
    k.startsWith("live:") ||
    k.startsWith("catdisc:") ||
    k.startsWith("cat_live:") ||
    k.startsWith("music:") ||
    k.startsWith("ac_tmdb_v2:") ||
    k.startsWith("ac_ep:") ||
    k.startsWith("analytics:")
  );
}

function getEdgeCacheDefault() {
  try {
    return typeof caches !== "undefined" && caches?.default ? caches.default : null;
  } catch {
    return null;
  }
}

function memStoreGet(map, key) {
  const rec = map.get(key);
  if (!rec) return { hit: false, value: null };
  if (rec.exp > 0 && Date.now() > rec.exp) {
    map.delete(key);
    return { hit: false, value: null };
  }
  return { hit: true, value: rec.val, deleted: Boolean(rec.deleted) };
}

function memStoreSet(map, key, val, ttlSec = 0, deleted = false, maxEntries = 1500) {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  const exp = ttlSec > 0 ? (Date.now() + ttlSec * 1000) : 0;
  map.set(key, { val, exp, deleted });
}

function createDurableKvAdapter(env) {
  const rawKv = env?.WATCHLIVO_KV || null;
  const roomDo = env?.ROOM_DO || null;
  const d1Db = env?.ROOMS_DB || null;
  if (!roomDo && !d1Db) return rawKv;

  const getAuthStub = () => roomDo.get(roomDo.idFromName("__watchlivo_auth_store_v1__"));

  const callDoKv = async (payload) => {
    if (!roomDo || Date.now() < _authDoQuotaUntil) throw new Error("do_quota_cooldown");
    const stub = getAuthStub();
    const resp = await stub.fetch(new Request("https://do.local/__kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));
    if (!resp.ok) throw new Error(`do_kv_${resp.status}`);
    return await resp.json();
  };

  const noteAuthDoErr = (err) => {
    const msg = String(err?.message || err || "").toLowerCase();
    if (msg.includes("exceeded allowed volume") || msg.includes("free tier") || msg.includes("quota") || msg.includes("overloaded")) {
      _authDoQuotaUntil = Date.now() + 180_000;
    }
  };

  const parseOut = (strVal, wantJson) => {
    if (strVal === null || strVal === undefined) return null;
    if (wantJson) {
      try { return JSON.parse(strVal); } catch { return null; }
    }
    return strVal;
  };

  const edgeCacheUrl = (key) => `https://cache.watchlivo.internal/ephemeral/${encodeURIComponent(String(key))}`;
  const isDirectRoomStoreKey = (k) => k.startsWith("room:") || k.startsWith("room_closed:") || k === "rooms:public_index";

  return {
    async getDetailed(key, typeOrOpts) {
      const k = String(key);
      const wantJson = typeOrOpts === "json" || (typeOrOpts && typeof typeOrOpts === "object" && typeOrOpts.type === "json");
      if (isDirectRoomStoreKey(k)) {
        if (rawKv && typeof rawKv.get === "function") {
          try {
            const rv = await rawKv.get(k, typeOrOpts);
            return { value: rv ?? null, storageError: false };
          } catch {
            return { value: null, storageError: true };
          }
        }
        return { value: null, storageError: false };
      }
      const eph = isEphemeralStoreKey(k);
      if (eph) {
        // Ephemeral keys NEVER touch Durable Objects (saves >95% of DO free-tier request quota!)
        const mHit = memStoreGet(_memEphemeralStore, k);
        if (mHit.hit) return { value: mHit.deleted ? null : parseOut(mHit.value, wantJson), storageError: false };
        const ec = getEdgeCacheDefault();
        if (ec) {
          try {
            const cResp = await ec.match(edgeCacheUrl(k));
            if (cResp && cResp.ok) {
              const txt = await cResp.text();
              memStoreSet(_memEphemeralStore, k, txt, 60);
              return { value: parseOut(txt, wantJson), storageError: false };
            }
          } catch {}
        }
        if (rawKv && typeof rawKv.get === "function") {
          const legacyVal = await rawKv.get(k, "text").catch(() => null);
          if (legacyVal !== null && legacyVal !== undefined) {
            memStoreSet(_memEphemeralStore, k, legacyVal, 60);
            return { value: parseOut(legacyVal, wantJson), storageError: false };
          }
        }
        return { value: null, storageError: false };
      }

      // Persistent Auth / Profile / Social / VoiceRelay keys: DO SQLite primary -> Global D1 SQLite -> rawKv -> isolate cache
      let anyBackendSucceeded = false;
      if (roomDo && Date.now() >= _authDoQuotaUntil) {
        try {
          const res = await callDoKv({ op: "get", key: k, ephemeral: false });
          anyBackendSucceeded = true;
          if (res && res.found) {
            if (res.deleted || res.value === null || res.value === undefined) return { value: null, storageError: false };
            memStoreSet(_memPersistFallback, k, res.value, 600, false, 600);
            return { value: parseOut(res.value, wantJson), storageError: false };
          }
        } catch (err) {
          noteAuthDoErr(err);
        }
      }
      if (d1Db) {
        const d1Res = await d1KvGet(d1Db, k);
        if (!d1Res.error) {
          anyBackendSucceeded = true;
          if (d1Res.found) {
            if (d1Res.deleted || d1Res.value === null || d1Res.value === undefined) return { value: null, storageError: false };
            memStoreSet(_memPersistFallback, k, d1Res.value, 600, false, 600);
            return { value: parseOut(d1Res.value, wantJson), storageError: false };
          }
        }
      }
      let rawOk = false;
      let rawVal = null;
      if (rawKv && typeof rawKv.get === "function") {
        try {
          rawVal = await rawKv.get(k, typeOrOpts);
          anyBackendSucceeded = true;
          rawOk = true;
        } catch {}
      }
      if (!anyBackendSucceeded) {
        return { value: null, storageError: true };
      }
      const pHit = memStoreGet(_memPersistFallback, k);
      if (pHit.hit) {
        return { value: pHit.deleted ? null : parseOut(pHit.value, wantJson), storageError: false };
      }
      return { value: rawOk ? (rawVal ?? null) : null, storageError: false };
    },
    async get(key, typeOrOpts) {
      return (await this.getDetailed(key, typeOrOpts)).value;
    },
    async put(key, value, opts = {}) {
      const k = String(key);
      const strVal = typeof value === "string" ? value : JSON.stringify(value);
      const ttl = Number(opts?.expirationTtl || 0);
      if (isDirectRoomStoreKey(k)) {
        if (rawKv && typeof rawKv.put === "function") {
          await rawKv.put(k, strVal, opts).catch(() => {});
        }
        return;
      }
      const eph = isEphemeralStoreKey(k);
      if (eph) {
        const effTtl = ttl > 0 ? Math.min(ttl, 86400) : 300;
        memStoreSet(_memEphemeralStore, k, strVal, effTtl);
        const ec = getEdgeCacheDefault();
        if (ec) {
          try {
            await ec.put(edgeCacheUrl(k), new Response(strVal, {
              status: 200,
              headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": `public, max-age=${effTtl}` },
            }));
          } catch {}
        }
        return;
      }

      memStoreSet(_memPersistFallback, k, strVal, ttl > 0 ? Math.min(ttl, 3600) : 1800, false, 600);
      let persisted = false;
      if (roomDo && Date.now() >= _authDoQuotaUntil) {
        try {
          await callDoKv({ op: "put", key: k, value: strVal, ttl, ephemeral: false });
          persisted = true;
        } catch (err) {
          noteAuthDoErr(err);
        }
      }
      if (!persisted && d1Db) {
        persisted = await d1KvPut(d1Db, k, strVal, ttl);
      }
      if (!persisted && rawKv && typeof rawKv.put === "function") {
        await rawKv.put(k, strVal, opts).catch(() => {});
      }
    },
    async delete(key) {
      const k = String(key);
      if (isDirectRoomStoreKey(k)) {
        if (rawKv && typeof rawKv.delete === "function") {
          await rawKv.delete(k).catch(() => {});
        }
        return;
      }
      const eph = isEphemeralStoreKey(k);
      if (eph) {
        memStoreSet(_memEphemeralStore, k, null, 60, true);
        const ec = getEdgeCacheDefault();
        if (ec) {
          try { await ec.delete(edgeCacheUrl(k)); } catch {}
        }
        return;
      }
      memStoreSet(_memPersistFallback, k, null, 300, true, 600);
      if (roomDo && Date.now() >= _authDoQuotaUntil) {
        try {
          await callDoKv({ op: "tombstone", key: k, ephemeral: false });
        } catch (err) {
          noteAuthDoErr(err);
        }
      }
      if (d1Db) {
        await d1KvDelete(d1Db, k);
      }
      if (rawKv && typeof rawKv.delete === "function") {
        await rawKv.delete(k).catch(() => {});
      }
    },
  };
}

function b64UrlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(String(str || ""));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecodeUtf8(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function signMemberSessionToken(user, sv, env) {
  const exp = Math.floor(Date.now() / 1000) + 2592000;
  const claims = {
    uid: String(user.uid || user.id || ""),
    email: String(user.email || "").trim().toLowerCase(),
    name: String(user.name || "").slice(0, 40),
    handle: String(user.handle || "").slice(0, 32),
    color: String(user.color || "#00f5d4").slice(0, 16),
    authProvider: String(user.authProvider || "email").slice(0, 16),
    sv: Number(sv || 0),
    exp,
    jti: makeNonce().slice(0, 12),
  };
  const bodyB64 = b64UrlEncodeUtf8(JSON.stringify(claims));
  const sig = await hmacTokenHex(`wl2.${bodyB64}`, env);
  if (sig) {
    return `wl2.${bodyB64}.${sig}`;
  }
  return `${claims.uid || "u"}_${makeNonce()}${makeNonce()}`;
}

async function verifyMemberSessionToken(tok, env) {
  const s = String(tok || "").trim();
  if (!s.startsWith("wl2.")) return null;
  const parts = s.split(".");
  if (parts.length !== 3) return null;
  const [, bodyB64, sig] = parts;
  if (!bodyB64 || !sig) return null;
  const expected = await hmacTokenHex(`wl2.${bodyB64}`, env);
  if (!expected || !timingSafeEqualStr(sig, expected)) return null;
  try {
    const claims = JSON.parse(b64UrlDecodeUtf8(bodyB64));
    if (!claims || typeof claims !== "object") return null;
    if (Number(claims.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    if (!claims.uid || !claims.email) return null;
    return claims;
  } catch {
    return null;
  }
}

function parseSessionDeviceLabel(ua = "") {
  const s = String(ua || "");
  if (!s) return "Web Tarayıcı";
  if (/iphone|ipad|ipod/i.test(s)) return "iOS / Safari";
  if (/android/i.test(s)) return "Android Cihaz";
  if (/macintosh|mac os/i.test(s)) return "macOS Tarayıcı";
  if (/windows/i.test(s)) return "Windows Tarayıcı";
  if (/linux/i.test(s)) return "Linux Tarayıcı";
  return "Web Tarayıcı";
}

async function issueAuthSessionToken(user, sv, env, request = null) {
  const authToken = await signMemberSessionToken(user, sv, env);
  if (env?.WATCHLIVO_KV) {
    await env.WATCHLIVO_KV.put(`session:${authToken}`, JSON.stringify({ ...user, _sv: Number(sv || 0) }), { expirationTtl: 2592000 }).catch(() => {});
    const uid = String(user?.uid || user?.id || "").trim();
    if (uid) {
      const nowS = Math.floor(Date.now() / 1000);
      let jti = makeNonce().slice(0, 12);
      let exp = nowS + 2592000;
      if (authToken.startsWith("wl2.")) {
        try {
          const c = JSON.parse(b64UrlDecodeUtf8(authToken.split(".")[1] || ""));
          if (c?.jti) jti = String(c.jti);
          if (Number(c?.exp || 0) > 0) exp = Number(c.exp);
        } catch {}
      }
      const ua = String(request?.headers?.get("User-Agent") || "").slice(0, 180);
      const tokHashPrefix = (await sha256Hex(authToken)).slice(0, 16);
      const entry = {
        id: jti,
        tokenHashPrefix: tokHashPrefix,
        device: parseSessionDeviceLabel(ua),
        userAgent: ua,
        authProvider: String(user?.authProvider || "email"),
        issuedAt: nowS,
        lastUsedAt: nowS,
        exp,
        sv: Number(sv || 0),
      };
      const sessKey = `acct_sessions:${uid}`;
      const existing = await env.WATCHLIVO_KV.get(sessKey, "json").catch(() => null);
      const list = (Array.isArray(existing) ? existing : [])
        .filter((s) => s && Number(s.sv || 0) === Number(sv || 0) && Number(s.exp || 0) > nowS && s.id !== jti);
      list.unshift(entry);
      await env.WATCHLIVO_KV.put(sessKey, JSON.stringify(list.slice(0, 12)), { expirationTtl: 2592000 }).catch(() => {});
    }
  }
  return authToken;
}

const CRAWLER_BOT_RX = /(?:googlebot|bingbot|yandex|baiduspider|slurp|duckduckbot|ahrefsbot|semrushbot|dotbot|mj12bot|bytespider|petalbot|markmonitor|corsearch|opsec|digimarc|muso|leakix|censys|shodan|netcraft|screaming\s*frog|turnitin|scrapy)/i;
const SOCIAL_PREVIEW_BOT_RX = /(?:telegrambot|twitterbot|discordbot|whatsapp|facebookexternalhit|slackbot)/i;

const CLOAKED_HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <title>Watchlivo — Senkron Video &amp; Sesli Sohbet Odası</title>
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex, nocache" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0e17; color: #94a3b8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 520px; padding: 32px; background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; text-align: center; }
    h1 { color: #f8fafc; font-size: 22px; margin-bottom: 12px; font-weight: 600; }
    p { font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Watchlivo Sync Workspace</h1>
    <p>Watchlivo, arkadaşlarınızla özel davet bağlantıları üzerinden WebRTC sesli sohbet ve gerçek zamanlı senkronize medya oturumları düzenlemenizi sağlayan bir iletişim alanıdır.</p>
    <p style="color:#64748b; font-size:12px; margin-top:20px;">Private Synchronized Room Engine &bull; dmca@watchlivo.online</p>
  </div>
</body>
</html>`;

function isCrawlerBot(request) {
  const ua = request.headers.get("User-Agent") || "";
  if (!ua) return false;
  if (SOCIAL_PREVIEW_BOT_RX.test(ua)) return false;
  return CRAWLER_BOT_RX.test(ua);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacTokenHex(payload, env) {
  const secret = String(env?.PROXY_SECRET || env?.VORTEX_SECRET || env?.ADMIN_SECRET || "").trim();
  if (!secret) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function signEdgeClientToken(env) {
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const jti = makeNonce().slice(0, 12);
  const payload = `${exp}.${jti}`;
  const sig = await hmacTokenHex(payload, env);
  if (!sig) return "";
  return `${payload}.${sig}`;
}

async function verifyEdgeClientToken(token, env) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) return false;
  const [expStr, jti, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !jti || !sig) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacTokenHex(`${expStr}.${jti}`, env);
  if (!expected) return false;
  return timingSafeEqualStr(sig, expected);
}

async function getBlockedTmdbSet(env) {
  const now = Date.now();
  if (now - _blockedCache.ts < 60_000) return _blockedCache.set;
  let arr = [];
  if (env?.WATCHLIVO_KV) {
    try {
      const v = await env.WATCHLIVO_KV.get("blocked:tmdb_ids", "json");
      if (Array.isArray(v)) arr = v;
    } catch {}
  }
  const s = new Set(arr.map((x) => String(x || "").trim()).filter(Boolean));
  _blockedCache = { ts: now, set: s };
  return s;
}

function isItemBlocked(it, blockedSet) {
  if (!blockedSet || !blockedSet.size || !it) return false;
  const tid = String(it.tmdbId || it.id || "").trim();
  const mt = it.mediaType === "tv" ? "tv" : "movie";
  return Boolean(tid && (blockedSet.has(tid) || blockedSet.has(`${mt}:${tid}`)));
}

async function isEdgeOriginAllowed(request, env, requireToken = false) {
  const secSite = (request.headers.get("Sec-Fetch-Site") || "").toLowerCase();
  if (secSite === "cross-site") return false;
  const hostAllowed = (h) =>
    h === "watchlivo.online" || h === "www.watchlivo.online" || h === "localhost" || h === "127.0.0.1";
  const orig = (request.headers.get("Origin") || "").trim();
  if (orig) {
    if (!/^(?:android-app|capacitor|ionic):\/\//i.test(orig)) {
      try {
        if (!hostAllowed(new URL(orig).hostname.toLowerCase())) return false;
      } catch { return false; }
    }
  }
  const ref = (request.headers.get("Referer") || "").trim();
  if (ref) {
    if (!/^(?:android-app|capacitor|ionic):\/\//i.test(ref)) {
      try {
        if (!hostAllowed(new URL(ref).hostname.toLowerCase())) return false;
      } catch { return false; }
    }
  }
  const adminSec = String(env?.ADMIN_SECRET || "").trim();
  const adminHdr = (request.headers.get("X-Admin-Secret") || "").trim();
  if (adminSec && adminHdr && timingSafeEqualStr(adminHdr, adminSec)) {
    return true;
  }
  const tok = (request.headers.get("X-Watchlivo-Token") || "").trim();
  if (tok) {
    return await verifyEdgeClientToken(tok, env);
  }
  if (requireToken) return false;
  if (!orig && !ref) {
    const ua = (request.headers.get("User-Agent") || "").toLowerCase();
    if (/(?:bot|crawler|spider|scrapy|curl\/|wget\/|python-urllib|python-requests|httpx|aiohttp|go-http-client|dmca|abuse)/i.test(ua)) {
      return false;
    }
  }
  return true;
}

async function getBootstrap(env) {
  if (_bootCache) return _bootCache;
  if (env?.ASSETS) {
    try {
      const r = await env.ASSETS.fetch(new Request("https://assets.local/_edge/bootstrap.json"));
      if (r.ok) {
        const parsed = await r.json();
        const curated = Array.isArray(parsed.curatedRooms) && parsed.curatedRooms.length ? parsed.curatedRooms : DEFAULT_CURATED_LIVE_ROOMS;
        _bootCache = { ...parsed, curatedRooms: curated };
        _curatedMap = new Map(curated.map((rm) => [rm.id, rm]));
        return _bootCache;
      }
    } catch {}
  }
  _curatedMap = new Map(DEFAULT_CURATED_LIVE_ROOMS.map((rm) => [rm.id, rm]));
  return { version: "20261124_v239", catalog: [], curatedRooms: DEFAULT_CURATED_LIVE_ROOMS, newReleases: [], latestEpisodes: [] };
}

function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const GUEST_UID_RE = /^guest_[a-z0-9]{4,40}$/i;

function makeGuestUid() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return `guest_${Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 10)}`;
}

async function isGuestUidClaimed(env, uid) {
  if (!env?.WATCHLIVO_KV || !uid) return false;
  const v = await env.WATCHLIVO_KV.get(`soc:gclaim:${String(uid).toLowerCase()}`).catch(() => null);
  return Boolean(v);
}

function buildAppCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://www.gstatic.com https://apis.google.com https://www.youtube.com https://s.ytimg.com https://player.vimeo.com https://www.googletagmanager.com https://www.google-analytics.com https://ssl.google-analytics.com`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self' https: wss: ws: blob: data: http://127.0.0.1:* http://localhost:*",
    "frame-src 'self' https:",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function edgeJson(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "Content-Security-Policy": buildAppCsp(makeNonce()),
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), display-capture=(self), autoplay=*, fullscreen=*, picture-in-picture=*",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "SAMEORIGIN",
      "X-Watchlivo-Origin": "cf-autonomous-edge",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      ...extra,
    },
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPasswordPbkdf2(password, saltBytes = null) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password || "")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const sB64 = btoa(String.fromCharCode(...salt));
  const hB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `pbkdf2_v1$${sB64}$${hB64}`;
}

async function verifyPasswordHash(password, email, storedHash) {
  const stored = String(storedHash || "");
  if (stored.startsWith("pbkdf2_v1$")) {
    const [, sB64, hB64] = stored.split("$");
    if (!sB64 || !hB64) return false;
    try {
      const bin = atob(sB64);
      const salt = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) salt[i] = bin.charCodeAt(i);
      const candidate = await hashPasswordPbkdf2(password, salt);
      return timingSafeEqualStr(candidate, stored);
    } catch {
      return false;
    }
  }
  const legacy = await sha256Hex(`wl_salt_v1:${email}:${String(password || "")}`);
  return timingSafeEqualStr(legacy, stored);
}

function extractSessionToken(request, body = null) {
  const authHdr = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const cookieStr = request.headers.get("Cookie") || "";
  const cookieMatch = cookieStr.match(/(?:^|;\s*)wl_auth=([^;]+)/);
  const bodyTok = body && typeof body === "object" && typeof body.authToken === "string" ? body.authToken.trim() : "";
  const raw = authHdr || (cookieMatch ? decodeURIComponent(cookieMatch[1]) : "") || bodyTok;
  return raw.trim();
}

async function kvReadStrict(kv, key, typeOrOpts) {
  if (!kv) return { value: null, storageError: true };
  if (typeof kv.getDetailed === "function") {
    return await kv.getDetailed(key, typeOrOpts);
  }
  try {
    const value = await kv.get(key, typeOrOpts);
    return { value: value ?? null, storageError: false };
  } catch {
    return { value: null, storageError: true };
  }
}

async function resolveAuthUser(request, env, body = null) {
  const tok = extractSessionToken(request, body);
  if (!tok) return { user: null, token: "", invalidToken: false, storageError: false };
  if (tok.length < 16) return { user: null, token: tok, invalidToken: true, storageError: false };

  // Fail-closed HMAC-SHA256 signed wl2 session verification (verifies revocation, tombstone, and active acct record)
  if (tok.startsWith("wl2.")) {
    const claims = await verifyMemberSessionToken(tok, env);
    if (!claims) return { user: null, token: tok, invalidToken: true, storageError: false };
    if (!env?.WATCHLIVO_KV) {
      return { user: null, token: tok, invalidToken: false, storageError: true };
    }
    const revKey = `revoked:${(await sha256Hex(tok)).slice(0, 24)}`;
    const [revRes, delRes, acctRes] = await Promise.all([
      kvReadStrict(env.WATCHLIVO_KV, revKey),
      kvReadStrict(env.WATCHLIVO_KV, `deleted_acct:${claims.email}`),
      kvReadStrict(env.WATCHLIVO_KV, `acct:${claims.email}`, "json"),
    ]);
    if (revRes.storageError || delRes.storageError || acctRes.storageError) {
      return { user: null, token: tok, invalidToken: false, storageError: true };
    }
    if (revRes.value) {
      return { user: null, token: tok, invalidToken: true, storageError: false };
    }
    const delAt = Number(delRes.value || 0) || 0;
    const issuedAt = Number(claims.exp || 0) - 2592000;
    if (delAt > 0 && delAt >= issuedAt) {
      return { user: null, token: tok, invalidToken: true, storageError: false };
    }
    const rec = acctRes.value;
    if (!rec || typeof rec !== "object" || !rec.user || Number(rec.sv || 0) !== Number(claims.sv || 0)) {
      return { user: null, token: tok, invalidToken: true, storageError: false };
    }
    const normUser = normalizeMemberUserObj(rec.user, claims.email);
    if (!rec.passHash && normUser) normUser.passwordSet = false;
    return { user: normUser, token: tok, invalidToken: false, storageError: false };
  }

  if (!env?.WATCHLIVO_KV) return { user: null, token: tok, invalidToken: false, storageError: true };
  const sessRes = await kvReadStrict(env.WATCHLIVO_KV, `session:${tok}`, "json");
  if (sessRes.storageError) return { user: null, token: tok, invalidToken: false, storageError: true };
  const raw = sessRes.value;
  if (!raw || typeof raw !== "object") return { user: null, token: tok, invalidToken: true, storageError: false };
  const { _sv: sessSv, ...user } = raw;
  const uidStr = String(user.uid || user.id || "");
  const isGuestSess = Boolean(user.isGuest) || uidStr.startsWith("guest_");
  const email = String(user.email || "").trim().toLowerCase();
  if (!isGuestSess && email) {
    const acctRes = await kvReadStrict(env.WATCHLIVO_KV, `acct:${email}`, "json");
    if (acctRes.storageError) return { user: null, token: tok, invalidToken: false, storageError: true };
    const rec = acctRes.value;
    if (!rec?.user || Number(rec.sv || 0) !== Number(sessSv || 0)) {
      await env.WATCHLIVO_KV.delete(`session:${tok}`).catch(() => {});
      return { user: null, token: tok, invalidToken: true, storageError: false };
    }
    if (!rec.passHash) user.passwordSet = false;
  }
  return { user, token: tok, invalidToken: false, storageError: false };
}

async function resolveMemberUser(request, env, body = null) {
  const res = await resolveAuthUser(request, env, body);
  if (!res.user) return { ...res, isGuest: false };
  const uid = String(res.user.id || res.user.uid || "");
  if (res.user.isGuest || uid.startsWith("guest_")) {
    return { user: null, token: res.token, invalidToken: false, storageError: false, isGuest: true };
  }
  return { ...res, isGuest: false };
}

async function serveSpaIndex(env, method = "GET") {
  if (!env?.ASSETS) return new Response("Watchlivo Edge Ready", { status: 200 });
  const r = await env.ASSETS.fetch(new Request("https://assets.local/index.html"));
  if (!r.ok) return new Response("Index missing", { status: 404 });
  const nonce = makeNonce();
  const edgeTok = await signEdgeClientToken(env);
  const rawHtml = await r.text();
  const html = rawHtml
    .replace(/<script(?![^>]*\bsrc=)/gi, `<script nonce="${nonce}"`)
    .replace(/<\/head>/i, `  <meta name="wl-edge-token" content="${edgeTok}" />\n</head>`);
  return new Response(method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Content-Security-Policy": buildAppCsp(nonce),
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), display-capture=(self), autoplay=*, fullscreen=*, picture-in-picture=*",
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "X-Watchlivo-Origin": "cf-autonomous-edge",
    },
  });
}

function normalizeSearchText(s) {
  return String(s || "")
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandTurkishPhoneticQuery(q) {
  const norm = normalizeSearchText(q);
  const rules = [
    [/\baktivite(ler|si)?\b/g, "activity"],
    [/\bdoktor\b/g, "doctor"],
    [/\bkaptan\b/g, "captain"],
    [/\bsuper\b/g, "super"],
    [/\bfantastik\b/g, "fantastic"],
    [/\bekspres\b/g, "express"],
    [/\bmisyon\b/g, "mission"],
    [/\bprofesor\b/g, "professor"],
  ];
  let alt = norm;
  for (const [rx, rep] of rules) alt = alt.replace(rx, rep);
  return alt !== norm ? alt : "";
}

const TMDB_GENRE_TAGS = {
  28: ["action", "aksiyon"],
  12: ["adventure", "macera"],
  16: ["animation", "animasyon"],
  35: ["comedy", "komedi"],
  80: ["crime", "suc"],
  99: ["doc", "documentary", "belgesel"],
  18: ["drama", "dram"],
  10751: ["family", "aile"],
  14: ["fantasy", "fantastik"],
  36: ["history", "tarih"],
  27: ["horror", "korku"],
  10402: ["music", "muzik"],
  9648: ["mystery", "gizem"],
  10749: ["romance", "romantik"],
  878: ["scifi", "bilim_kurgu"],
  53: ["thriller", "gerilim"],
  10752: ["war", "savas"],
  37: ["western"],
  10759: ["action", "aksiyon", "adventure", "macera"],
  10765: ["scifi", "bilim_kurgu", "fantasy", "fantastik"],
  10768: ["war", "savas", "history", "tarih"],
};

const CATEGORY_ALIASES = {
  action: ["action", "aksiyon", "adventure", "macera", "western"],
  aksiyon: ["action", "aksiyon", "adventure", "macera", "western"],
  adventure: ["adventure", "macera", "action", "aksiyon"],
  macera: ["adventure", "macera", "action", "aksiyon"],
  scifi: ["scifi", "bilim_kurgu", "bilim kurgu", "fantasy", "fantastik"],
  bilim_kurgu: ["scifi", "bilim_kurgu", "bilim kurgu", "fantasy", "fantastik"],
  "bilim kurgu": ["scifi", "bilim_kurgu", "bilim kurgu", "fantasy", "fantastik"],
  fantasy: ["fantasy", "fantastik", "scifi", "bilim_kurgu"],
  fantastik: ["fantasy", "fantastik", "scifi", "bilim_kurgu"],
  drama: ["drama", "dram", "crime", "suc", "mystery", "gizem"],
  dram: ["drama", "dram", "crime", "suc", "mystery", "gizem"],
  crime: ["crime", "suc", "drama", "dram"],
  suc: ["crime", "suc", "drama", "dram"],
  mystery: ["mystery", "gizem", "horror", "korku", "thriller", "gerilim"],
  gizem: ["mystery", "gizem", "horror", "korku", "thriller", "gerilim"],
  comedy: ["comedy", "komedi", "romance", "romantik"],
  komedi: ["comedy", "komedi", "romance", "romantik"],
  romance: ["romance", "romantik", "comedy", "komedi"],
  romantik: ["romance", "romantik", "comedy", "komedi"],
  horror: ["horror", "korku", "thriller", "gerilim"],
  korku: ["horror", "korku", "thriller", "gerilim"],
  thriller: ["thriller", "gerilim", "horror", "korku"],
  gerilim: ["thriller", "gerilim", "horror", "korku"],
  animation: ["animation", "animasyon", "family", "aile"],
  animasyon: ["animation", "animasyon", "family", "aile"],
  family: ["family", "aile", "animation", "animasyon"],
  aile: ["family", "aile", "animation", "animasyon"],
  doc: ["doc", "documentary", "belgesel", "history", "tarih", "war", "savas"],
  documentary: ["doc", "documentary", "belgesel", "history", "tarih", "war", "savas"],
  belgesel: ["doc", "documentary", "belgesel", "history", "tarih", "war", "savas"],
  history: ["history", "tarih", "doc", "belgesel"],
  tarih: ["history", "tarih", "doc", "belgesel"],
  war: ["war", "savas", "history", "tarih"],
  savas: ["war", "savas", "history", "tarih"],
  music: ["music", "muzik"],
  muzik: ["music", "muzik"],
  western: ["western", "action", "aksiyon"],
};

function mapTmdbItem(r) {
  const mt = r.media_type === "tv" ? "tv" : "movie";
  const tid = String(r.id || "");
  const title = (r.title || r.name || "").trim();
  const orig = (r.original_title || r.original_name || title).trim();
  const rel = (r.release_date || r.first_air_date || "").slice(0, 4);
  const gids = Array.isArray(r.genre_ids) ? r.genre_ids : [];
  const cats = [mt === "tv" ? "series" : "movies"];
  for (const gid of gids) {
    const tags = TMDB_GENRE_TAGS[gid];
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (tag && !cats.includes(tag)) cats.push(tag);
      }
    }
  }
  if (gids.includes(16) && r.original_language === "ja") {
    cats.push("anime");
  }
  return {
    id: `tmdb-${mt}-${tid}`,
    tmdbId: tid,
    title,
    originalTitle: orig,
    overview: String(r.overview || "").trim(),
    year: rel,
    releaseDate: String(r.release_date || r.first_air_date || ""),
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : 0,
    voteCount: Number(r.vote_count || 0),
    mediaType: mt,
    origLang: r.original_language || "",
    genreIds: gids,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : "",
    backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : "",
    categories: cats,
    genreLabel: mt === "tv" ? "📺 Dizi · TMDB" : "🎬 Film · TMDB",
    sourceBadge: "🌐 Bulut Arşiv",
    provider: "cinema",
    _fromTmdb: true,
  };
}

async function fetchTmdbMulti(query, lang, apiKey) {
  const u = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(apiKey)}&language=${encodeURIComponent(lang)}&query=${encodeURIComponent(query)}&page=1`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(2200) });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || []).filter((x) => (x.media_type === "movie" || x.media_type === "tv") && x.poster_path).map(mapTmdbItem);
  } catch {
    return [];
  }
}

async function searchTmdbEdge(rawQ, env) {
  const normQ = normalizeSearchText(rawQ);
  if (normQ.length < 2) return [];
  const now = Date.now();
  const memHit = _edgeSearchCache.get(normQ);
  if (memHit && now - memHit.ts < 300_000) return memHit.items;

  if (env?.WATCHLIVO_KV) {
    try {
      const kvHit = await env.WATCHLIVO_KV.get(`tmdb_q:v1:${normQ}`, "json");
      if (Array.isArray(kvHit) && kvHit.length) {
        if (_edgeSearchCache.size >= 150) _edgeSearchCache.delete(_edgeSearchCache.keys().next().value);
        _edgeSearchCache.set(normQ, { ts: now, items: kvHit });
        return kvHit;
      }
    } catch {}
  }

  const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
  const altQ = expandTurkishPhoneticQuery(rawQ);
  const reqs = [
    fetchTmdbMulti(rawQ, "tr-TR", apiKey),
    fetchTmdbMulti(rawQ, "en-US", apiKey),
  ];
  if (altQ) reqs.push(fetchTmdbMulti(altQ, "en-US", apiKey));
  const batches = await Promise.all(reqs);

  const seen = new Set();
  const items = [];
  for (const batch of batches) {
    for (const it of batch) {
      const k = `${it.mediaType}:${it.tmdbId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }
  items.sort((a, b) => {
    const qa = normalizeSearchText(a.title);
    const qb = normalizeSearchText(b.title);
    const qoa = normalizeSearchText(a.originalTitle);
    const qob = normalizeSearchText(b.originalTitle);
    const popA = Math.round(Math.sqrt(Math.max(0, Number(a.voteCount || 0))) * 20);
    const popB = Math.round(Math.sqrt(Math.max(0, Number(b.voteCount || 0))) * 20);
    const scoreA = (qa === normQ || qoa === normQ ? 10000 : (qa.includes(normQ) || qoa.includes(normQ) ? 2000 : 0)) + popA;
    const scoreB = (qb === normQ || qob === normQ ? 10000 : (qb.includes(normQ) || qob.includes(normQ) ? 2000 : 0)) + popB;
    return scoreB - scoreA;
  });
  const top = items.slice(0, 48);
  if (top.length) {
    if (_edgeSearchCache.size >= 150) _edgeSearchCache.delete(_edgeSearchCache.keys().next().value);
    _edgeSearchCache.set(normQ, { ts: now, items: top });
    if (env?.WATCHLIVO_KV) {
      env.WATCHLIVO_KV.put(`tmdb_q:v1:${normQ}`, JSON.stringify(top), { expirationTtl: 3600 }).catch(() => {});
    }
  }
  return top;
}

const TR_DOMESTIC_PROVIDERS = new Set(["exxen", "blutv", "gain", "tod", "tabii", "tvplus", "puhutv"]);
const GLOBAL_OTT_PROVIDERS = new Set(["netflix", "disney", "prime", "max", "hbomax", "apple", "appletv", "mubi", "hulu", "paramount", "peacock", "plex", "pluto", "tubi", "vk"]);

function matchesProviderAndCategory(x, provider, cat) {
  const cats = (x.categories || []).map((c) => String(c).toLowerCase());
  const itemProv = String(x.provider || "").toLowerCase();
  const isAnimeItem = Array.isArray(x.genreIds) && x.genreIds.length
    ? (x.genreIds.includes(16) && (String(x.origLang || "").toLowerCase() === "ja" || cats.includes("anime")))
    : (cats.includes("anime") || String(x.id || "").startsWith("ac-"));

  if (provider === "anime") {
    if (!isAnimeItem) return false;
  } else if (provider === "crunchyroll") {
    if (!(itemProv === "crunchyroll" || x._fromTmdbDiscover || isAnimeItem)) return false;
  } else if (provider === "series") {
    if (!(x.mediaType === "tv" || cats.includes("series"))) return false;
  } else if (provider === "movies") {
    if (!(x.mediaType === "movie" || cats.includes("movies"))) return false;
  } else if (provider === "livetv" || provider === "tv") {
    if (!(x.live || provider === itemProv || cats.includes("livetv"))) return false;
  } else if (TR_DOMESTIC_PROVIDERS.has(provider)) {
    const isTrOrigin = String(x.origLang || "").toLowerCase() === "tr" || cats.includes("tr");
    if (!(x._fromTmdbDiscover || itemProv === provider || (x._fromTmdb && isTrOrigin))) return false;
  } else if (GLOBAL_OTT_PROVIDERS.has(provider)) {
    const provMatch = itemProv === provider || (provider === "appletv" && itemProv === "apple") || (provider === "apple" && itemProv === "appletv") || (provider === "hbomax" && itemProv === "max") || (provider === "max" && itemProv === "hbomax");
    if (!(x._fromTmdbDiscover || provMatch)) return false;
  }

  if (cat === "series" || cat === "diziler") {
    return x.mediaType === "tv" || cats.includes("series");
  }
  if (cat === "movies" || cat === "filmler") {
    return x.mediaType === "movie" || cats.includes("movies");
  }
  if (cat === "anime") {
    return isAnimeItem;
  }
  if (cat === "vizyon") {
    return Boolean(x.isVizyon || x.customRelease || cats.includes("vizyon") || Number(x.year || 0) >= 2025);
  }
  if (cat === "tr" || cat === "yerli") {
    return Boolean(
      cats.includes("tr") ||
      String(x.origLang || "").toLowerCase() === "tr" ||
      String(x.country || "").toUpperCase() === "TR" ||
      /yerli/i.test(`${x.sourceBadge || ""} ${x.genreLabel || ""}`)
    );
  }
  if (cat === "dublaj") {
    return Boolean(
      cats.includes("dublaj") ||
      x.hasTrDub ||
      String(x.origLang || "").toLowerCase() === "tr" ||
      /dublaj|türkçe|yerli/i.test(`${x.sourceBadge || ""} ${x.audioBadge || ""}`)
    );
  }
  if (cat === "trend") {
    return cats.includes("trend") || Number(x.rating || 0) >= 7.5;
  }
  if (cat && cat !== "all" && cat !== "recommended" && cat !== "for_you" && cat !== "trending") {
    const gLabel = normalizeSearchText(x.genreLabel || "");
    const normCat = normalizeSearchText(cat);
    const aliases = CATEGORY_ALIASES[cat] || CATEGORY_ALIASES[normCat] || [cat, normCat];
    if (aliases.some((a) => cats.includes(a))) return true;
    return cats.includes(cat) || cats.includes(normCat) || (normCat.length >= 3 && gLabel.includes(normCat));
  }
  return true;
}

function filterCatalogUnpaged(items, url) {
  const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  const normQ = normalizeSearchText(q);
  const altQ = normQ ? expandTurkishPhoneticQuery(q) : "";
  const cat = (url.searchParams.get("category") || url.searchParams.get("genre") || "all").trim().toLowerCase();
  const provider = (url.searchParams.get("provider") || "cinema").trim().toLowerCase();
  let list = (Array.isArray(items) ? items : []).filter((x) => matchesProviderAndCategory(x, provider, cat));
  if (!normQ && ["exxen", "blutv", "gain", "tabii", "tod", "puhutv"].includes(provider)) {
    const isDomMatch = (x) =>
      String(x.provider || "").toLowerCase() === provider ||
      String(x.sourceBadge || "").toLowerCase().includes(provider) ||
      String(x.genreLabel || "").toLowerCase().includes(provider) ||
      String(x.origLang || "").toLowerCase() === "tr";
    const first = [];
    const rest = [];
    for (const x of list) (isDomMatch(x) ? first : rest).push(x);
    if (first.length) list = [...first, ...rest];
  }
  if (normQ) {
    list = list.filter((x) => {
      const t = normalizeSearchText(x.title);
      const ot = normalizeSearchText(x.originalTitle);
      const gl = normalizeSearchText(x.genreLabel);
      return t.includes(normQ) || ot.includes(normQ) || gl.includes(normQ) || (altQ && (t.includes(altQ) || ot.includes(altQ)));
    });
  }
  return { provider, q, cat, list };
}

function filterCatalog(items, url) {
  const { provider, q, list } = filterCatalogUnpaged(items, url);
  const totalTv = list.filter((x) => x.mediaType === "tv").length;
  const totalMovies = list.filter((x) => x.mediaType !== "tv").length;
  const shuffleFlag = ["1", "true", "yes"].includes((url.searchParams.get("shuffle") || url.searchParams.get("random") || "").trim().toLowerCase());
  let ordered = list;
  if (shuffleFlag && !q && list.length > 1) {
    ordered = [...list];
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
  }
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 48) || 48));
  const start = (page - 1) * limit;
  return {
    provider,
    query: q,
    page,
    total: ordered.length,
    totalAvailable: ordered.length,
    totalTv,
    totalMovies,
    ...(shuffleFlag && !q ? { shuffled: true } : {}),
    items: ordered.slice(start, start + limit),
    hasMore: ordered.length > start + limit,
  };
}

function scoreSearchItem(it, normQ) {
  if (!it || !normQ) return 0;
  const nt = normalizeSearchText(it.title);
  const no = normalizeSearchText(it.originalTitle);
  const ntPref = normalizeSearchText(String(it.title || "").split(/[:\-–—]/)[0]);
  const noPref = normalizeSearchText(String(it.originalTitle || "").split(/[:\-–—]/)[0]);
  let tier = 0;
  if (nt === normQ || no === normQ) tier = 4_000_000;
  else if (nt.startsWith(`${normQ} `) || no.startsWith(`${normQ} `) || ntPref === normQ || noPref === normQ) tier = 3_000_000;
  else if (` ${nt} `.includes(` ${normQ} `) || ` ${no} `.includes(` ${normQ} `)) tier = 2_000_000;
  else if (nt.includes(normQ) || no.includes(normQ)) tier = 1_000_000;
  const pop = Math.min(900_000, Math.round(Math.sqrt(Math.max(0, Number(it.voteCount || 0))) * 20) + Math.round(Number(it.rating || 0) * 10));
  return tier + pop;
}

async function handleEdgeCatalogSearch(boot, url, env) {
  const rawQ = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  const provider = (url.searchParams.get("provider") || "cinema").trim().toLowerCase();
  const cat = (url.searchParams.get("category") || url.searchParams.get("genre") || "all").trim().toLowerCase();
  if (!rawQ) {
    const shuffleOnly = ["1", "true", "yes"].includes((url.searchParams.get("shuffle") || url.searchParams.get("random") || "").trim().toLowerCase());
    if (!shuffleOnly) {
      const disc = await handleEdgeTmdbDiscoverCatalog(boot, url, env).catch(() => null);
      if (disc) return disc;
    }
    return filterCatalog(boot.catalog, url);
  }
  const normQ = normalizeSearchText(rawQ);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 48) || 48));
  if (!normQ) {
    return { provider, query: rawQ, page, total: 0, totalAvailable: 0, totalTv: 0, totalMovies: 0, items: [], hasMore: false };
  }
  if (normQ.length === 1) {
    const exactOne = (Array.isArray(boot.catalog) ? boot.catalog : []).filter((x) => {
      if (!matchesProviderAndCategory(x, provider, cat)) return false;
      return normalizeSearchText(x.title) === normQ || normalizeSearchText(x.originalTitle) === normQ;
    });
    const startOne = (page - 1) * limit;
    return {
      provider,
      query: rawQ,
      page,
      total: exactOne.length,
      totalAvailable: exactOne.length,
      totalTv: exactOne.filter((x) => x.mediaType === "tv").length,
      totalMovies: exactOne.filter((x) => x.mediaType !== "tv").length,
      items: exactOne.slice(startOne, startOne + limit),
      hasMore: exactOne.length > startOne + limit,
    };
  }

  const { list: localAll } = filterCatalogUnpaged(boot.catalog, url);
  const tmdbHits = await searchTmdbEdge(rawQ, env);
  const filteredTmdb = tmdbHits.filter((x) => matchesProviderAndCategory(x, provider, cat));

  const seenIdx = new Map();
  const merged = [];
  for (const it of [...localAll, ...filteredTmdb]) {
    const k = it.tmdbId ? `${it.mediaType}:${it.tmdbId}` : `t:${normalizeSearchText(it.title)}`;
    if (seenIdx.has(k)) {
      const existing = merged[seenIdx.get(k)];
      if (existing) {
        if (!existing.overview && it.overview) existing.overview = it.overview;
        if (Number(it.voteCount || 0) > Number(existing.voteCount || 0)) existing.voteCount = it.voteCount;
      }
      continue;
    }
    seenIdx.set(k, merged.length);
    merged.push({ ...it });
  }
  merged.sort((a, b) => scoreSearchItem(b, normQ) - scoreSearchItem(a, normQ));
  const start = (page - 1) * limit;
  return {
    provider,
    query: rawQ,
    page,
    total: merged.length,
    totalAvailable: merged.length,
    totalTv: merged.filter((x) => x.mediaType === "tv").length,
    totalMovies: merged.filter((x) => x.mediaType !== "tv").length,
    items: merged.slice(start, start + limit),
    hasMore: merged.length > start + limit,
  };
}

// ---------------------------------------------------------------------------
// TMDB Discover-backed catalog (parity with Python origin `/api/rave/catalog`)
// ---------------------------------------------------------------------------
const DISCOVER_GENRES = {
  aksiyon: ["10759|37", "28|12|37"], action: ["10759|37", "28|12|37"],
  macera: ["10759", "12"], adventure: ["10759", "12"],
  animasyon: ["16|10751|10762", "16|10751"], animation: ["16|10751|10762", "16|10751"],
  komedi: ["35", "35|10749"], comedy: ["35", "35|10749"],
  suc: ["80", "80"], crime: ["80", "80"],
  belgesel: ["99", "99|36"], documentary: ["99", "99|36"], doc: ["99", "99|36"],
  dram: ["18|80|9648", "18|80|9648"], drama: ["18|80|9648", "18|80|9648"],
  aile: ["10751", "10751"], family: ["10751", "10751"],
  fantastik: ["10765", "14"], fantasy: ["10765", "14"],
  tarih: ["10768", "36"], history: ["10768", "36"],
  korku: ["9648|10765", "27|53"], horror: ["9648|10765", "27|53"],
  muzik: ["", "10402"], music: ["", "10402"],
  gizem: ["9648", "9648"], mystery: ["9648", "9648"],
  romantik: ["10749", "10749"], romance: ["10749", "10749"],
  bilim_kurgu: ["10765", "878|14"], scifi: ["10765", "878|14"],
  gerilim: ["80", "53"], thriller: ["80", "53"],
  savas: ["10768", "10752"], war: ["10768", "10752"],
  western: ["37", "37"],
};
const OTT_WATCH_PROVIDERS = {
  netflix: "8",
  disney: "337",
  prime: "119",
  max: "1899|384",
  hbomax: "1899|384",
  crunchyroll: "283",
  apple: "350",
  appletv: "350",
  mubi: "11",
  hulu: "15",
  paramount: "531|582|2303|2616",
  peacock: "386",
  plex: "538",
  pluto: "300",
  tubi: "73",
};
const OTT_TV_NETWORKS = {
  netflix: "213",
  prime: "1024",
  disney: "2739|420",
  max: "49|3186|3308",
  hbomax: "49|3186|3308",
  apple: "2552",
  appletv: "2552",
  paramount: "4330|67",
  hulu: "453|88",
  peacock: "3353|6",
};
const OTT_US_PRIMARY_PROVIDERS = new Set(["hulu", "paramount", "peacock", "plex", "pluto", "tubi"]);
const TR_DOMESTIC_GENRES = {
  exxen: ["35", "35"],
  blutv: ["18|80", "18|80"],
  gain: ["18|35", "18|35"],
  tod: ["80|9648|18", "80|9648|18"],
  tabii: ["18|36|35|10759", "18|36|35|10759"],
  tvplus: ["18|10759", "18|28"],
  puhutv: ["18", "18"],
};
const _discoverMemCache = new Map();
const _liveVizyonMemCache = { ts: 0, items: [] };

function decodeHtmlBasicEdge(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#8217;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchLiveSinemaccVizyonMovies(env, { forceRefresh = false, maxItems = 18 } = {}) {
  const now = Date.now();
  if (!forceRefresh && _liveVizyonMemCache.items.length >= 6 && now - _liveVizyonMemCache.ts < 600_000) {
    return _liveVizyonMemCache.items.slice(0, maxItems);
  }
  const kvKey = "live:sinemacc_vizyon_v2";
  if (!forceRefresh && env?.WATCHLIVO_KV) {
    const kvHit = await env.WATCHLIVO_KV.get(kvKey, "json").catch(() => null);
    if (kvHit && Array.isArray(kvHit.items) && kvHit.items.length >= 6) {
      _liveVizyonMemCache.ts = now;
      _liveVizyonMemCache.items = kvHit.items;
      return kvHit.items.slice(0, maxItems);
    }
  }

  const SC_ORIGIN = "https://sinemacc.com";
  const curYr = new Date().getUTCFullYear();
  const minYr = curYr - 1;
  const fetchScHtml = async (u, timeoutMs = 3200) => {
    try {
      const r = await fetch(u, {
        headers: { "User-Agent": EDGE_UA, Referer: `${SC_ORIGIN}/`, "Accept-Language": "tr-TR,tr;q=0.9" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) { r.body?.cancel?.(); return ""; }
      return await r.text();
    } catch {
      return "";
    }
  };

  // Fetch latest current-year listing pages in parallel (3 subrequests)
  const listingPages = await Promise.all([
    fetchScHtml(`${SC_ORIGIN}/yil/${curYr}/`, 3200),
    fetchScHtml(`${SC_ORIGIN}/yil/${curYr}/page/2/`, 3200),
    fetchScHtml(`${SC_ORIGIN}/yil/${curYr}/page/3/`, 3200),
  ]);

  const rawCands = [];
  const seenSlugs = new Set();
  const cardRe = /<div[^>]+class=["'][^"']*\bfilm_kutusu\b[^"']*["'][^>]*>([\s\S]{0,1200}?)<\/a>/gi;
  for (const html of listingPages) {
    if (!html) continue;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const block = m[1];
      // Require an actual dub/sub playback badge — excludes trailer-only unreleased theater titles
      if (!/icon_tr|icon_subtitle|icon_dublaj|flg/i.test(block)) continue;
      if (/fragman|yakinda|yakında/i.test(block)) continue;
      const hrefM = block.match(/href=["'](https?:\/\/(?:www\.)?sinemacc\.com\/film\/([a-z0-9-]+)\/?)["']/i);
      if (!hrefM?.[1] || !hrefM?.[2]) continue;
      const href = hrefM[1];
      const slug = hrefM[2];
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      const spanTitle = decodeHtmlBasicEdge(block.match(/<span[^>]+class=["']text["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
      const attrTitle = decodeHtmlBasicEdge(block.match(/<a[^>]+title=["']([^"']+)["']/i)?.[1] || "").replace(/\s*(?:İzle|izle|HD|Full)\s*$/i, "").trim();
      const title = spanTitle || attrTitle;
      if (!title) continue;
      const yrM = slug.match(/(?:^|-)((?:19|20)\d{2})$/) || block.match(/<span[^>]+class=["']years["'][^>]*>\s*((?:19|20)\d{2})\b/i);
      const yrStr = yrM?.[1] || String(curYr);
      const yrNum = Number(yrStr) || curYr;
      if (yrNum < minYr || yrNum > curYr) continue;
      const imdbM = block.match(/class=['"]imdb[^'"]*['"][^>]*>[\s\S]{0,120}?<\/svg>\s*([0-9.]+)/i);
      const rating = imdbM?.[1] ? Math.min(9.9, Math.max(4.0, Number(imdbM[1]) || 6.5)) : 6.5;
      const dataSrc = block.match(/data-src=["'](https?:\/\/[^"']+)["']/i)?.[1] || "";
      const hasDubFlag = /icon_tr|icon_dublaj/i.test(block);
      const hasSubFlag = /icon_subtitle/i.test(block);
      rawCands.push({ href, slug, title, year: yrStr, rating, poster: dataSrc, hasDubFlag, hasSubFlag, idx: rawCands.length });
    }
  }
  if (!rawCands.length) return [];

  // Prioritize recognizable higher-rated current-year releases while preserving freshness
  rawCands.sort((a, b) => {
    const scoreA = (a.rating >= 7.0 ? 25 : a.rating >= 6.0 ? 12 : 0) + (a.hasDubFlag ? 6 : 0) - a.idx * 0.6;
    const scoreB = (b.rating >= 7.0 ? 25 : b.rating >= 6.0 ? 12 : 0) + (b.hasDubFlag ? 6 : 0) - b.idx * 0.6;
    return scoreB - scoreA;
  });

  // Verify up to 18 pages in parallel for active filmizle.in video players (excludes DMCA abuse-telif & trailer-only pages)
  const verifyCand = async (c) => {
    const ph = await fetchScHtml(c.href, 2800);
    if (!ph) return null;
    let hasPlayer = false;
    let hasDub = c.hasDubFlag;
    let hasSub = c.hasSubFlag;
    for (const bm of ph.matchAll(/aHR0c[A-Za-z0-9+/=]{16,}/g)) {
      try {
        let b64 = bm[0];
        while (b64.length % 4 !== 0) b64 += "=";
        const decoded = atob(b64).trim();
        if (/^https:\/\/(?:[a-z0-9-]+\.)?filmizle\.in\/video\/[a-f0-9]{16,}/i.test(decoded)) {
          hasPlayer = true;
          if (decoded.includes("lng=tur")) hasDub = true;
          if (decoded.includes("lng=trsub")) hasSub = true;
        }
      } catch {}
    }
    if (!hasPlayer) return null;

    const h1Title = decodeHtmlBasicEdge(ph.match(/<h1[^>]*class=["'][^"']*baslik[^"']*["'][^>]*>([\s\S]{0,160}?)<\/h1>/i)?.[1] || "")
      .replace(/\s*(?:İzle|izle|HD|Full)\s*$/i, "")
      .trim();
    const h2Orig = decodeHtmlBasicEdge(ph.match(/<h2[^>]*class=["'][^"']*orj[^"']*["'][^>]*>([\s\S]{0,160}?)<\/h2>/i)?.[1] || "");
    const imdbId = ph.match(/\b(tt\d{7,9})\b/)?.[1] || "";
    const ogImg = ph.match(/property=["']og:image["'][^>]+content=["'](https?:\/\/[^"']+)["']/i)?.[1]
      || ph.match(/content=["'](https?:\/\/[^"']+)["'][^>]+property=["']og:image["']/i)?.[1]
      || "";
    const poster = ogImg || c.poster || `/api/rave/poster?t=${encodeURIComponent(h1Title || c.title)}&mt=movie`;
    const finalTitle = h1Title || c.title;
    const finalOrig = h2Orig || finalTitle;
    const audioText = hasDub && hasSub ? "Dublaj & Altyazı" : hasDub ? "Türkçe Dublaj" : "Türkçe Altyazı";
    const cats = ["vizyon", "movies", "trend"];
    if (hasDub) cats.push("dublaj");

    return {
      id: `sc-${c.slug}`,
      tmdbId: "",
      imdbId,
      mediaType: "movie",
      title: finalTitle,
      originalTitle: finalOrig,
      year: c.year,
      rating: Number(c.rating.toFixed(1)),
      voteCount: 250,
      hasTrDub: hasDub,
      poster,
      backdrop: poster,
      still: poster,
      categories: cats,
      genreLabel: `🇹🇷 Vizyon ${c.year} · ${audioText} · 1080p`,
      episodeLabel: `🎬 VİZYON ${c.year}`,
      sourceBadge: "🍿 Yeni Vizyon Filmi",
      provider: "cinema",
      sourceUrl: c.href,
      officialUrl: c.href,
      isVizyon: true,
    };
  };

  const verified = (await Promise.all(rawCands.slice(0, 18).map(verifyCand))).filter(Boolean);
  if (verified.length >= 4) {
    _liveVizyonMemCache.ts = now;
    _liveVizyonMemCache.items = verified;
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(kvKey, JSON.stringify({ items: verified, ts: Math.floor(now / 1000) }), { expirationTtl: 1800 }).catch(() => {});
    }
  }
  return verified.slice(0, maxItems);
}

async function fetchTmdbDiscoverPage(u, dtype) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(4500) });
    if (!r.ok) return { total: 0, items: [] };
    const data = await r.json();
    const items = (data.results || [])
      .filter((x) => x && x.poster_path)
      .map((x) => mapTmdbItem({ ...x, media_type: x.media_type || dtype }));
    return { total: Number(data.total_results || 0), dtype, items };
  } catch {
    return { total: 0, dtype, items: [] };
  }
}

const SUPPORTED_DISCOVER_PROVIDERS = new Set([
  "cinema", "all", "free_tr", "netflix", "disney", "prime", "max", "hbomax", "crunchyroll",
  "apple", "appletv", "mubi", "hulu", "paramount", "peacock", "plex", "pluto", "tubi", "vk",
  "exxen", "blutv", "gain", "tod", "tabii", "tvplus", "puhutv",
]);

async function handleEdgeTmdbDiscoverCatalog(boot, url, env) {
  const provider = (url.searchParams.get("provider") || "cinema").trim().toLowerCase();
  if (!SUPPORTED_DISCOVER_PROVIDERS.has(provider)) return null;
  const cat = (url.searchParams.get("category") || url.searchParams.get("genre") || "all").trim().toLowerCase();
  const mtFlt = (url.searchParams.get("mediaType") || url.searchParams.get("type") || "").trim().toLowerCase();
  const pg = Math.max(1, Math.min(500, Number(url.searchParams.get("page") || 1) || 1));
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const cacheKey = `catdisc:v5:${provider}:${cat}:${mtFlt}:${pg}`;
  const now = Date.now();
  const mem = _discoverMemCache.get(cacheKey);
  if (!forceRefresh && mem && now - mem.ts < 600_000) return mem.payload;
  if (!forceRefresh && env?.WATCHLIVO_KV) {
    const kvHit = await env.WATCHLIVO_KV.get(cacheKey, "json").catch(() => null);
    if (kvHit && Array.isArray(kvHit.items) && kvHit.items.length) {
      _discoverMemCache.set(cacheKey, { ts: now, payload: kvHit });
      return kvHit;
    }
  }

  const apiKey = encodeURIComponent(String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim());
  const today = new Date().toISOString().slice(0, 10);
  const mvCut = new Date(Date.now() - 21 * 86400_000).toISOString().slice(0, 10);
  const vizyonMinCut = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const vizyonVodCut = new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10);
  const isTrCat = cat === "tr" || cat === "yerli";
  const isDomesticTrProv = TR_DOMESTIC_PROVIDERS.has(provider);
  const ottProvId = OTT_WATCH_PROVIDERS[provider] || "";
  const tvMinVotes = isTrCat || isDomesticTrProv ? 5 : (cat === "anime" || provider === "crunchyroll" ? 20 : (ottProvId ? 15 : 5));
  const mvMinVotes = isTrCat || isDomesticTrProv ? 10 : (ottProvId ? 15 : 25);
  const tvWithoutGenres = (cat === "anime" || provider === "crunchyroll") ? "10762,10763,10764,10766,10767" : "10763,10764,10766,10767";
  let tvQ = `&without_genres=${tvWithoutGenres}&first_air_date.lte=${today}&vote_count.gte=${tvMinVotes}`;
  let mvQ = `&primary_release_date.lte=${mvCut}&vote_count.gte=${mvMinVotes}`;
  if (isTrCat || isDomesticTrProv) {
    tvQ += "&with_original_language=tr";
    mvQ += "&with_original_language=tr";
  }
  if (cat === "anime" || provider === "crunchyroll") {
    if (provider === "crunchyroll" && DISCOVER_GENRES[cat]) {
      const [tg, mg] = DISCOVER_GENRES[cat];
      tvQ += tg ? `&with_genres=16,${tg}&with_original_language=ja` : "&with_genres=16&with_original_language=ja";
      mvQ += mg ? `&with_genres=16,${mg}&with_original_language=ja` : "&with_genres=16&with_original_language=ja";
    } else {
      tvQ += "&with_genres=16&with_original_language=ja";
      mvQ += "&with_genres=16&with_original_language=ja";
    }
  } else if (cat === "dublaj") {
    tvQ += "&with_genres=10759|18|10765&vote_count.gte=40";
    mvQ += "&with_genres=28|12|878|14&vote_count.gte=50";
  } else if (DISCOVER_GENRES[cat]) {
    const [tg, mg] = DISCOVER_GENRES[cat];
    tvQ += tg ? `&with_genres=${tg}` : "&with_genres=-1";
    mvQ += mg ? `&with_genres=${mg}` : "";
  } else if (cat === "trend") {
    tvQ += "&vote_average.gte=7.5&vote_count.gte=150";
    mvQ += "&vote_average.gte=7.5&vote_count.gte=250";
  } else if (isDomesticTrProv && TR_DOMESTIC_GENRES[provider] && cat === "all") {
    const [tg, mg] = TR_DOMESTIC_GENRES[provider];
    if (tg) tvQ += `&with_genres=${tg}`;
    if (mg) mvQ += `&with_genres=${mg}`;
  }

  const wantTv = mtFlt !== "movie" && cat !== "movies";
  const wantMv = mtFlt !== "tv" && cat !== "series";

  const buildEndpointsForRegion = (region, useNetworkFallback = false) => {
    let provTvQ = tvQ;
    let provMvQ = mvQ;
    if (ottProvId) {
      if (useNetworkFallback && OTT_TV_NETWORKS[provider]) {
        provTvQ += `&with_networks=${encodeURIComponent(OTT_TV_NETWORKS[provider])}`;
        provMvQ += `&with_watch_providers=${encodeURIComponent(ottProvId)}&watch_region=${region}`;
      } else {
        provTvQ += `&with_watch_providers=${encodeURIComponent(ottProvId)}&watch_region=${region}`;
        provMvQ += `&with_watch_providers=${encodeURIComponent(ottProvId)}&watch_region=${region}`;
      }
    }
    const baseTv = `https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&language=tr-TR${provTvQ}`;
    const baseMv = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&language=tr-TR${provMvQ}`;
    const eps = [];
    if (cat === "vizyon" && !ottProvId && !isDomesticTrProv) {
      if (wantMv) {
        // Use digitally-released recent films (VOD window >=35d) instead of theater-only trailers from movie/now_playing
        eps.push([`https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&language=tr-TR&primary_release_date.gte=${vizyonMinCut}&primary_release_date.lte=${vizyonVodCut}&vote_count.gte=40&sort_by=popularity.desc&page=${pg}`, "movie"]);
        eps.push([`https://api.themoviedb.org/3/trending/movie/week?api_key=${apiKey}&language=tr-TR&page=${pg}`, "movie"]);
      }
      if (wantTv) {
        eps.push([`https://api.themoviedb.org/3/tv/on_the_air?api_key=${apiKey}&language=tr-TR&page=${pg}`, "tv"]);
        eps.push([`https://api.themoviedb.org/3/trending/tv/week?api_key=${apiKey}&language=tr-TR&page=${pg}`, "tv"]);
      }
    } else {
      const p1 = (pg - 1) * 2 + 1;
      const p2 = p1 + 1;
      if (wantTv) {
        eps.push([`${baseTv}&sort_by=vote_count.desc&page=${p1}`, "tv"]);
        eps.push([`${baseTv}&sort_by=popularity.desc&page=${p2}`, "tv"]);
      }
      if (wantMv) {
        eps.push([`${baseMv}&sort_by=vote_count.desc&page=${p1}`, "movie"]);
        eps.push([`${baseMv}&sort_by=popularity.desc&page=${p2}`, "movie"]);
      }
    }
    return eps;
  };

  const primaryRegion = OTT_US_PRIMARY_PROVIDERS.has(provider) ? "US" : "TR";
  const eps = buildEndpointsForRegion(primaryRegion, false);
  const liveVizyonPromise = (cat === "vizyon" && !ottProvId && !isDomesticTrProv && pg === 1 && wantMv)
    ? fetchLiveSinemaccVizyonMovies(env, { forceRefresh, maxItems: 18 }).catch(() => [])
    : Promise.resolve([]);
  let [results, liveVizyon] = await Promise.all([
    Promise.all(eps.map(([u, t]) => fetchTmdbDiscoverPage(u, t))),
    liveVizyonPromise,
  ]);
  const hasAnyDisc = results.some((r) => r.items.length > 0);
  if (!hasAnyDisc && ottProvId && primaryRegion === "TR") {
    const usEps = buildEndpointsForRegion("US", Boolean(OTT_TV_NETWORKS[provider]));
    results = await Promise.all(usEps.map(([u, t]) => fetchTmdbDiscoverPage(u, t)));
  }

  let totTv = 0;
  let totMv = 0;
  const seen = new Set();
  const tmdbItems = [];
  const maxLen = Math.max(0, ...results.map((r) => r.items.length));
  for (let i = 0; i < maxLen; i++) {
    for (const r of results) {
      const rawIt = r.items[i];
      if (!rawIt) continue;
      if (cat === "vizyon" && rawIt.mediaType === "movie" && rawIt.releaseDate && rawIt.releaseDate > vizyonVodCut) continue;
      if ((cat === "anime" || provider === "crunchyroll") && !(Array.isArray(rawIt.genreIds) && rawIt.genreIds.includes(16))) continue;
      const k = `${rawIt.mediaType}:${rawIt.tmdbId}`;
      if (seen.has(k)) continue;
      const it = {
        ...rawIt,
        _fromTmdbDiscover: true,
        ...(provider !== "cinema" && provider !== "all" && provider !== "free_tr" ? { provider } : {}),
        ...(cat === "dublaj" && !(rawIt.categories || []).includes("dublaj") ? { categories: [...(rawIt.categories || []), "dublaj"] } : {}),
      };
      if (provider === "crunchyroll" && DISCOVER_GENRES[cat] && !matchesProviderAndCategory(it, provider, cat)) continue;
      seen.add(k);
      tmdbItems.push(it);
    }
  }
  for (const r of results) {
    if (r.dtype === "tv") totTv = Math.max(totTv, r.total);
    else totMv = Math.max(totMv, r.total);
  }
  if (!tmdbItems.length && !liveVizyon.length) return null;
  const { list: localList } = filterCatalogUnpaged(boot.catalog, url);
  const localFiltered = localList.filter((x) => (mtFlt === "tv" ? x.mediaType === "tv" : mtFlt === "movie" ? x.mediaType !== "tv" : true));

  let items = tmdbItems;
  if (pg === 1 && cat === "vizyon" && liveVizyon.length) {
    const liveNormTitles = new Set(liveVizyon.flatMap((x) => [normalizeSearchText(x.title), normalizeSearchText(x.originalTitle)]).filter(Boolean));
    const filteredTmdb = tmdbItems.filter((x) => !liveNormTitles.has(normalizeSearchText(x.title)) && !liveNormTitles.has(normalizeSearchText(x.originalTitle)));
    items = [...liveVizyon, ...filteredTmdb];
  } else if (pg === 1 && localFiltered.length) {
    let leadLocal = localFiltered.slice(0, 24);
    if (cat === "all" && (provider === "cinema" || provider === "all" || provider === "free_tr")) {
      const isTrLocal = (x) => Boolean(
        (x.categories || []).includes("tr") ||
        String(x.origLang || "").toLowerCase() === "tr" ||
        String(x.country || "").toUpperCase() === "TR" ||
        /yerli/i.test(`${x.genreLabel || ""} ${x.sourceBadge || ""}`)
      );
      const trLead = localFiltered.filter(isTrLocal).slice(0, 8);
      if (trLead.length) {
        const trIds = new Set(trLead.map((x) => x.id || x.tmdbId || x.title));
        const nonTrLead = localFiltered.filter((x) => !trIds.has(x.id || x.tmdbId || x.title)).slice(0, 24 - trLead.length);
        leadLocal = [...trLead, ...nonTrLead];
      }
    }
    const localKeys = new Set(leadLocal.map((x) => (x.tmdbId ? `${x.mediaType === "tv" ? "tv" : "movie"}:${x.tmdbId}` : "")).filter(Boolean));
    items = [...leadLocal, ...tmdbItems.filter((x) => !localKeys.has(`${x.mediaType}:${x.tmdbId}`))];
  }
  const localTv = localFiltered.filter((x) => x.mediaType === "tv").length;
  const localMv = Math.max(localFiltered.length - localTv, liveVizyon.length);
  const totalTv = Math.max(totTv, localTv);
  const totalMovies = Math.max(totMv, localMv);
  const payload = {
    provider,
    query: "",
    page: pg,
    category: cat,
    total: totalTv + totalMovies,
    totalAvailable: totalTv + totalMovies,
    totalTv,
    totalMovies,
    items,
    hasMore: pg < 250 && tmdbItems.length >= 10,
    source: "tmdb-discover",
  };
  if (_discoverMemCache.size >= 200) _discoverMemCache.delete(_discoverMemCache.keys().next().value);
  _discoverMemCache.set(cacheKey, { ts: now, payload });
  if (env?.WATCHLIVO_KV) {
    await env.WATCHLIVO_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {});
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Social, Auth, YouTube & Media Helpers (F3 / F4a / F4b)
// ---------------------------------------------------------------------------
const EDGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const DEFAULT_FB_API_KEY = "AIzaSyAeyDRstvjN8c_D08U8CrqopcFT0_fz9fo";
const DEFAULT_GIPHY_KEY = "y66IkWFVC8eBWb4VWUgb8ad2RREu4v8T";
const YT_EXTRACT_RE = /(?:youtube\.com\/(?:[^/\n\s]+\/\s*)?(?:v\/|u\/\w\/|live\/|embed\/|watch\?v=|&v=|shorts\/)|youtu\.be\/)([^"&?/\s]{11})/i;
const _voiceRelayMem = new Map();
const _voiceNoteMem = new Map();

function cleanStr(v, maxLen = 120) {
  return String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, maxLen);
}

function foldHandleBase(raw) {
  return String(raw || "")
    .replace(/#\d{3,6}$/, "")
    .replace(/^@+/, "")
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 24);
}

function normalizeHandle(raw, fallbackName = "izleyici") {
  const h = foldHandleBase(raw);
  if (h.length >= 2) return h;
  const fb = foldHandleBase(fallbackName);
  return fb.length >= 2 ? fb : "izleyici";
}

function sanitizeColor(raw) {
  const s = String(raw || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : "#27DCC8";
}

function computeWatchMedal(mins) {
  const m = Math.max(0, Number(mins || 0) || 0);
  if (m >= 300) return "🥇 Altın İzleyici";
  if (m >= 120) return "🥈 Gümüş İzleyici";
  if (m >= 30) return "🥉 Bronz İzleyici";
  return "⚡ Yeni İzleyici";
}

function sanitizeAvatarUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const compact = s.replace(/[\u0000-\u0020]+/g, "");
  let decoded1 = compact;
  try { decoded1 = decodeURIComponent(compact); } catch {}
  let decoded2 = decoded1;
  try { decoded2 = decodeURIComponent(decoded1); } catch {}
  const variants = [s, compact, decoded1, decoded2];
  if (variants.some((v) => /[\u0000-\u001F\u007F]/.test(v))) return "__INVALID__";
  if (variants.some((v) => /^(?:javascript:|vbscript:|data:text\/|data:application\/)/i.test(v))) return "__INVALID__";
  if (variants.some((v) => /image\/svg(?:\+xml)?/i.test(v) || /\.svgz?(?:$|[?#&/;,]|[\u0000-\u0020])/i.test(v))) return "__INVALID__";
  for (const v of variants) {
    if (/^https:\/\//i.test(v)) {
      try {
        const u = new URL(v);
        const pathOnly = u.pathname.split(";")[0];
        if (/\.svgz?$/i.test(pathOnly) || /\.svgz?(?:$|\/|;)/i.test(u.pathname)) {
          return "__INVALID__";
        }
      } catch {
        return "__INVALID__";
      }
    }
  }
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(compact) && compact.length <= 45000) {
    return compact;
  }
  if (/^https:\/\//i.test(s) && !/[\u0000-\u001F\s<>"]/.test(s) && s.length <= 2048) {
    return s;
  }
  if ((s.startsWith("/static/") || s.startsWith("/uploads/")) && !s.startsWith("//") && !/[\u0000-\u001F\s<>"]/.test(s) && s.length <= 512) {
    return s;
  }
  return "__INVALID__";
}

function safeAvatarForCard(raw) {
  const r = sanitizeAvatarUrl(raw);
  return r === "__INVALID__" ? "" : r;
}

function normalizeMemberUserObj(u, fallbackEmail = "") {
  if (!u || typeof u !== "object") return null;
  const uid = String(u.uid || u.id || "");
  const name = cleanStr(u.name || u.username || "Kullanıcı", 40) || "Kullanıcı";
  const handle = normalizeHandle(u.handle || "", name);
  const watchMinutes = Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0));
  return {
    id: uid,
    uid,
    email: String(u.email || fallbackEmail || "").toLowerCase(),
    name,
    username: name,
    handle,
    color: sanitizeColor(u.color),
    avatarUrl: safeAvatarForCard(u.avatarUrl),
    bio: cleanStr(u.bio || "", 160),
    statusText: cleanStr(u.statusText || "", 60),
    statusEmoji: cleanStr(u.statusEmoji || "🍿", 12) || "🍿",
    hideWatching: Boolean(u.hideWatching),
    hideFriends: Boolean(u.hideFriends),
    hideLocation: Boolean(u.hideLocation),
    watchMinutes,
    medal: cleanStr(u.medal || computeWatchMedal(watchMinutes), 40) || computeWatchMedal(watchMinutes),
    authProvider: String(u.authProvider || u.provider || "email"),
    verified: u.verified !== false,
    passwordSet: u.passwordSet !== false,
    isGuest: false,
  };
}

async function getSocialDir(env) {
  if (!env?.WATCHLIVO_KV) return {};
  const d = await env.WATCHLIVO_KV.get("soc:dir:v1", "json").catch(() => null);
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

async function upsertSocialDir(env, card) {
  if (!env?.WATCHLIVO_KV || !card?.uid) return;
  const dir = await getSocialDir(env);
  dir[card.uid] = {
    uid: card.uid,
    name: cleanStr(card.name || "İzleyici", 32),
    handle: normalizeHandle(card.handle || "", card.name || "izleyici"),
    color: sanitizeColor(card.color),
    avatarUrl: safeAvatarForCard(card.avatarUrl),
    bio: cleanStr(card.bio || "", 160),
    isGuest: Boolean(card.isGuest || String(card.uid).startsWith("guest_")),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  const keys = Object.keys(dir);
  if (keys.length > 500) {
    keys.sort((a, b) => Number(dir[a]?.updatedAt || 0) - Number(dir[b]?.updatedAt || 0));
    for (const k of keys.slice(0, keys.length - 500)) delete dir[k];
  }
  await env.WATCHLIVO_KV.put("soc:dir:v1", JSON.stringify(dir)).catch(() => {});
  if (dir[card.uid].handle) {
    await env.WATCHLIVO_KV.put(`soc:handle:${dir[card.uid].handle}`, card.uid, { expirationTtl: 2592000 }).catch(() => {});
  }
}

async function removeSocialDir(env, uid) {
  if (!env?.WATCHLIVO_KV || !uid) return;
  const dir = await getSocialDir(env);
  const prev = dir[uid];
  if (prev?.handle) {
    await env.WATCHLIVO_KV.delete(`soc:handle:${prev.handle}`).catch(() => {});
  }
  if (dir[uid]) {
    delete dir[uid];
    await env.WATCHLIVO_KV.put("soc:dir:v1", JSON.stringify(dir)).catch(() => {});
  }
}

async function findAccountByIdent(env, rawIdent) {
  if (!env?.WATCHLIVO_KV) return { email: "", rec: null };
  const ident = String(rawIdent || "").trim().toLowerCase();
  if (!ident) return { email: "", rec: null };
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident);
  if (isEmail) {
    const rec = await env.WATCHLIVO_KV.get(`acct:${ident}`, "json").catch(() => null);
    return { email: ident, rec };
  }
  const noAt = ident.replace(/^@+/, "");
  const candHandles = Array.from(new Set([noAt, foldHandleBase(noAt)].filter(Boolean)));
  for (const h of candHandles) {
    const mapped = await env.WATCHLIVO_KV.get(`acct_handle:${h}`).catch(() => null);
    if (mapped) {
      const em = mapped.trim().toLowerCase();
      const rec = await env.WATCHLIVO_KV.get(`acct:${em}`, "json").catch(() => null);
      if (rec) return { email: em, rec };
    }
  }
  const nameKey = normalizeSearchText(noAt);
  if (nameKey) {
    const mappedName = await env.WATCHLIVO_KV.get(`acct_name:${nameKey}`).catch(() => null);
    if (mappedName) {
      const em = mappedName.trim().toLowerCase();
      const rec = await env.WATCHLIVO_KV.get(`acct:${em}`, "json").catch(() => null);
      if (rec) return { email: em, rec };
    }
  }
  return { email: "", rec: null };
}

async function ensureUserSocial(env, uid, defaults = {}, persist = true) {
  const cleanUid = cleanStr(uid, 64) || "guest_default";
  const key = `soc:u:${cleanUid}`;
  let u = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(key, "json").catch(() => null) : null;
  const nowS = Math.floor(Date.now() / 1000);
  if (!u || typeof u !== "object") {
    const defName = cleanStr(defaults.name || "İzleyici", 32) || "İzleyici";
    const defHandle = normalizeHandle(defaults.handle || "", defName);
    u = {
      uid: cleanUid,
      name: defName,
      handle: `@${defHandle}`,
      color: sanitizeColor(defaults.color),
      avatarUrl: safeAvatarForCard(defaults.avatarUrl),
      bio: cleanStr(defaults.bio || "", 160),
      statusText: cleanStr(defaults.statusText || "", 60),
      statusEmoji: cleanStr(defaults.statusEmoji || "🍿", 12) || "🍿",
      isGuest: cleanUid.startsWith("guest_"),
      privacy: {
        presenceVisibility: "friends",
        hideWatching: Boolean(defaults.hideWatching),
        hideFriends: Boolean(defaults.hideFriends),
        hideLocation: Boolean(defaults.hideLocation),
        allowInvites: "friends",
      },
      friends: [],
      requests: [],
      outgoingRequests: [],
      blocked: [],
      unread: {},
      watchMinutes: Math.max(0, Math.floor(Number(defaults.watchMinutes || 0) || 0)),
      _watchSec: 0,
      medal: computeWatchMedal(defaults.watchMinutes),
      lastSeen: nowS,
    };
    if (persist && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(key, JSON.stringify(u), { expirationTtl: 2592000 }).catch(() => {});
    }
  } else {
    let changed = false;
    if (defaults.name && defaults.name !== u.name) { u.name = cleanStr(defaults.name, 32); changed = true; }
    if (defaults.handle) {
      const nh = `@${normalizeHandle(defaults.handle, u.name)}`;
      if (nh !== u.handle) { u.handle = nh; changed = true; }
    }
    if (defaults.color) { u.color = sanitizeColor(defaults.color); changed = true; }
    if (defaults.avatarUrl !== undefined) {
      const av = safeAvatarForCard(defaults.avatarUrl);
      if (av !== u.avatarUrl) { u.avatarUrl = av; changed = true; }
    }
    if (defaults.bio !== undefined) { u.bio = cleanStr(defaults.bio, 160); changed = true; }
    if (defaults.statusText !== undefined) { u.statusText = cleanStr(defaults.statusText, 60); changed = true; }
    if (defaults.statusEmoji !== undefined) { u.statusEmoji = cleanStr(defaults.statusEmoji || "🍿", 12) || "🍿"; changed = true; }
    if (defaults.hideWatching !== undefined || defaults.hideFriends !== undefined || defaults.hideLocation !== undefined) {
      u.privacy = u.privacy || { presenceVisibility: "friends", hideWatching: false, hideFriends: false, hideLocation: false, allowInvites: "friends" };
      if (defaults.hideWatching !== undefined && Boolean(defaults.hideWatching) !== Boolean(u.privacy.hideWatching)) {
        u.privacy.hideWatching = Boolean(defaults.hideWatching);
        changed = true;
      }
      if (defaults.hideFriends !== undefined && Boolean(defaults.hideFriends) !== Boolean(u.privacy.hideFriends)) {
        u.privacy.hideFriends = Boolean(defaults.hideFriends);
        changed = true;
      }
      if (defaults.hideLocation !== undefined && Boolean(defaults.hideLocation) !== Boolean(u.privacy.hideLocation)) {
        u.privacy.hideLocation = Boolean(defaults.hideLocation);
        changed = true;
      }
    }
    if (!Array.isArray(u.friends)) u.friends = [];
    if (!Array.isArray(u.requests)) u.requests = [];
    if (!Array.isArray(u.outgoingRequests)) u.outgoingRequests = [];
    if (!Array.isArray(u.blocked)) u.blocked = [];
    if (!u.unread || typeof u.unread !== "object") u.unread = {};
    if (!u.privacy || typeof u.privacy !== "object") {
      u.privacy = { presenceVisibility: "friends", hideWatching: false, allowInvites: "friends" };
    }
    const mins = Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0));
    if (u.watchMinutes !== mins) { u.watchMinutes = mins; changed = true; }
    if (!Number.isFinite(Number(u._watchSec))) { u._watchSec = 0; }
    const expectedMedal = computeWatchMedal(u.watchMinutes);
    if (!u.medal || u.medal !== expectedMedal) { u.medal = expectedMedal; }
    if (changed && persist && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(key, JSON.stringify(u), { expirationTtl: 2592000 }).catch(() => {});
    }
  }
  return u;
}

async function saveUserSocial(env, u) {
  if (!env?.WATCHLIVO_KV || !u?.uid) return;
  await env.WATCHLIVO_KV.put(`soc:u:${u.uid}`, JSON.stringify(u), { expirationTtl: 2592000 }).catch(() => {});
}

async function syncAccountWatchMinutes(env, email, watchMinutes) {
  const em = String(email || "").trim().toLowerCase();
  if (!em || !env?.WATCHLIVO_KV) return null;
  const rec = await env.WATCHLIVO_KV.get(`acct:${em}`, "json").catch(() => null);
  if (!rec?.user) return null;
  const nextMins = Math.max(Math.floor(Number(rec.user.watchMinutes || 0) || 0), Math.floor(Number(watchMinutes || 0) || 0));
  const nextMedal = computeWatchMedal(nextMins);
  if (rec.user.watchMinutes !== nextMins || rec.user.medal !== nextMedal) {
    rec.user.watchMinutes = nextMins;
    rec.user.medal = nextMedal;
    await env.WATCHLIVO_KV.put(`acct:${em}`, JSON.stringify(rec)).catch(() => {});
  }
  return { watchMinutes: nextMins, medal: nextMedal };
}

async function computeLivePresence(env, targetUid, viewerUid = "", isFriend = false) {
  const nowS = Math.floor(Date.now() / 1000);
  const rec = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`soc:pres:${targetUid}`, "json").catch(() => null) : null;
  const lastSeen = Number(rec?.lastSeen || 0);
  const fresh = Boolean(rec && rec.state !== "offline" && lastSeen > 0 && (nowS - lastSeen) < 180);
  const vis = String(rec?.visibility || "friends").toLowerCase();
  const allowed = targetUid === viewerUid || vis === "everyone" || (vis === "friends" && isFriend);
  if (!fresh || !allowed) {
    return {
      online: false,
      presenceState: "offline",
      status: "Çevrimdışı",
      lastSeen,
      lastSeenLabel: lastSeen > 0 ? "Yakın zamanda aktifti" : "Çevrimdışı",
      roomId: "",
      mediaTitle: "",
      watchingTitle: "",
      hideWatching: Boolean(rec?.hideWatching),
      watchingRoom: null,
    };
  }
  const hideWatch = Boolean(rec?.hideWatching) && targetUid !== viewerUid;
  const customTxt = cleanStr(rec?.statusText || "", 60);
  const customEmj = cleanStr(rec?.statusEmoji || "🍿", 10);
  const roomId = !hideWatch ? cleanStr(rec?.roomId || "", 80) : "";
  const mediaTitle = !hideWatch ? cleanStr(rec?.mediaTitle || rec?.watchingTitle || "", 140) : "";
  const roomName = !hideWatch ? cleanStr(rec?.roomName || "", 100) : "";
  if (rec.state === "watching" && roomId) {
    const label = mediaTitle || roomName || "Canlı Oda";
    return {
      online: true,
      presenceState: "watching",
      status: `🎬 ${label}`,
      lastSeen,
      lastSeenLabel: "Şu an izliyor",
      roomId,
      mediaTitle: label,
      watchingTitle: label,
      hideWatching: false,
      watchingRoom: {
        roomId,
        roomName: roomName || "Watchlivo Odası",
        mediaTitle: label,
        mediaPoster: cleanStr(rec?.mediaPoster || "", 800),
        mediaProvider: cleanStr(rec?.mediaProvider || "cinema", 32),
      },
    };
  }
  return {
    online: true,
    presenceState: "online",
    status: customTxt ? `${customEmj} ${customTxt}`.trim() : "🟢 Çevrimiçi",
    lastSeen,
    lastSeenLabel: "Şu an çevrimiçi",
    roomId: "",
    mediaTitle: "",
    watchingTitle: "",
    hideWatching: Boolean(rec?.hideWatching),
    watchingRoom: null,
  };
}

function getFriendshipState(u, targetUid) {
  const t = cleanStr(targetUid, 64);
  if (!t || !u) return "NONE";
  if ((u.blocked || []).some((b) => b?.uid === t)) return "BLOCKED";
  if ((u.friends || []).some((f) => f?.uid === t)) return "FRIENDS";
  if ((u.outgoingRequests || []).some((r) => r?.toUid === t)) return "OUTGOING_PENDING";
  if ((u.requests || []).some((r) => r?.fromUid === t)) return "INCOMING_PENDING";
  return "NONE";
}

function dmThreadKey(a, b) {
  return [String(a || "").toLowerCase(), String(b || "").toLowerCase()].sort().join("::");
}

function formatHhMm(tsSec = Math.floor(Date.now() / 1000)) {
  const d = new Date((tsSec + 10800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function queueSocialNotification(env, targetUid, notif) {
  const tUid = cleanStr(targetUid, 64).toLowerCase();
  if (!tUid) return null;
  const nowS = Math.floor(Date.now() / 1000);
  const item = {
    id: notif.id || `ntf_${makeNonce().slice(0, 10)}`,
    ts: nowS,
    ...notif,
  };
  if (env?.WATCHLIVO_KV) {
    const key = `soc:ntf:${tUid}`;
    const cur = (await env.WATCHLIVO_KV.get(key, "json").catch(() => null)) || [];
    const active = (Array.isArray(cur) ? cur : []).filter((x) => x && (!(Number(x.expiresAt || 0) > 0) || Number(x.expiresAt) >= nowS));
    active.push(item);
    await env.WATCHLIVO_KV.put(key, JSON.stringify(active.slice(-40)), { expirationTtl: 86400 }).catch(() => {});
  }
  return item;
}

async function resolveSocialTarget(env, identifier, hintUid = "") {
  const dir = await getSocialDir(env);
  for (const cand of [hintUid, identifier]) {
    const cStr = cleanStr(cand, 80);
    if (!cStr) continue;
    if (dir[cStr]) return dir[cStr];
    if ((cStr.startsWith("u_") || cStr.startsWith("guest_")) && env?.WATCHLIVO_KV) {
      const su = await env.WATCHLIVO_KV.get(`soc:u:${cStr}`, "json").catch(() => null);
      if (su?.uid) {
        return {
          uid: su.uid,
          name: su.name || "İzleyici",
          handle: normalizeHandle(su.handle || "", su.name || "izleyici"),
          color: su.color || "#27DCC8",
          avatarUrl: su.avatarUrl || "",
          bio: su.bio || "",
          isGuest: Boolean(su.isGuest || su.uid.startsWith("guest_")),
        };
      }
    }
    const { rec } = await findAccountByIdent(env, cStr);
    if (rec?.user?.uid) {
      return normalizeMemberUserObj(rec.user);
    }
    const cFold = foldHandleBase(cStr);
    const cNameNorm = normalizeSearchText(cStr.replace(/^@+/, ""));
    if (cFold && env?.WATCHLIVO_KV) {
      const hUid = await env.WATCHLIVO_KV.get(`soc:handle:${cFold}`).catch(() => null);
      if (hUid && dir[hUid]) return dir[hUid];
    }
    for (const card of Object.values(dir)) {
      if (!card?.uid) continue;
      const cardH = foldHandleBase(card.handle || "");
      const cardN = normalizeSearchText(card.name || "");
      if ((cFold && cardH === cFold) || (cNameNorm && cardN === cNameNorm)) {
        return card;
      }
    }
  }
  return null;
}

async function resolveSocialCaller(request, env, fallbackUid = "", body = null) {
  let authRes = await resolveAuthUser(request, env, body);
  if (authRes.storageError) {
    return { uid: "guest_default", user: null, authenticated: false, isGuest: true, invalidToken: false, storageError: true };
  }
  const memberInvalidToken = Boolean(authRes.invalidToken);
  if (!authRes.user && !memberInvalidToken && env?.WATCHLIVO_KV) {
    const gTok = (request.headers.get("X-Guest-Token") || (body && typeof body.guestToken === "string" ? body.guestToken : "") || "").trim();
    if (gTok.length >= 16) {
      const gRes = await kvReadStrict(env.WATCHLIVO_KV, `session:${gTok}`, "json");
      if (gRes.storageError) {
        return { uid: "guest_default", user: null, authenticated: false, isGuest: true, invalidToken: false, storageError: true };
      }
      if (gRes.value) authRes = { user: gRes.value, token: gTok, invalidToken: false, storageError: false };
    }
  }
  if (authRes.user) {
    return {
      uid: String(authRes.user.uid || authRes.user.id || "guest_default"),
      user: authRes.user,
      authenticated: true,
      isGuest: Boolean(authRes.user.isGuest || String(authRes.user.uid || authRes.user.id || "").startsWith("guest_")),
      invalidToken: false,
      storageError: false,
    };
  }
  const fb = cleanStr(fallbackUid, 64);
  let safeGuestUid = fb && GUEST_UID_RE.test(fb) ? fb : "guest_default";
  if (safeGuestUid !== "guest_default" && (await isGuestUidClaimed(env, safeGuestUid))) {
    safeGuestUid = "guest_default";
  }
  return { uid: safeGuestUid, user: null, authenticated: false, isGuest: true, invalidToken: memberInvalidToken, storageError: false };
}

async function enrichSocialFriend(env, fr, viewerUid) {
  const pUid = cleanStr(fr?.uid, 64);
  const dir = await getSocialDir(env);
  const dCard = dir[pUid] || {};
  const pres = await computeLivePresence(env, pUid, viewerUid, true);
  const name = cleanStr(dCard.name || fr.name || "İzleyici", 32);
  const handle = `@${normalizeHandle(dCard.handle || fr.handle || "", name)}`;
  const watchMinutes = Math.max(0, Number(fr.watchMinutes || 0) || 0);
  return {
    ...fr,
    uid: pUid,
    name,
    handle,
    color: sanitizeColor(dCard.color || fr.color),
    avatarUrl: safeAvatarForCard(dCard.avatarUrl) || safeAvatarForCard(fr.avatarUrl),
    online: pres.online,
    presenceState: pres.presenceState,
    status: pres.status,
    lastSeen: pres.lastSeen,
    lastSeenLabel: pres.lastSeenLabel,
    roomId: pres.roomId,
    mediaTitle: pres.mediaTitle,
    watchingRoom: pres.watchingRoom,
    bestFriend: Boolean(fr.bestFriend),
    watchMinutes,
    medal: fr.medal || computeWatchMedal(watchMinutes),
  };
}

function defaultYtPrefs() {
  return {
    subscriptions: [],
    likedVideos: [],
    searchHistory: [],
    dismissedVideoIds: [],
    blockedChannels: [],
    topics: [],
    googleConnected: false,
    googleEmail: "",
    googleChannelTitle: "",
    updatedAt: 0,
  };
}

function extractYtVidAny(rawVal) {
  const s = String(rawVal || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

async function ytSearchEdge(q) {
  const cleanQ = cleanStr(q, 200);
  if (!cleanQ) return [];
  const items = [];
  try {
    const r = await fetch(`https://www.youtube.com/results?${new URLSearchParams({ search_query: cleanQ, hl: "tr", gl: "TR" })}`, {
      headers: { "User-Agent": EDGE_UA, "Accept-Language": "tr-TR,tr;q=0.9" },
      signal: AbortSignal.timeout(4200),
    });
    if (r.ok) {
      const html = await r.text();
      const idx = html.indexOf("var ytInitialData = ");
      if (idx >= 0) {
        const start = html.indexOf("{", idx);
        const end = html.indexOf(";</script>", start);
        if (start >= 0 && end > start) {
          const data = JSON.parse(html.slice(start, end));
          const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
          for (const sec of sections) {
            for (const it of sec?.itemSectionRenderer?.contents || []) {
              const vr = it?.videoRenderer;
              if (!vr?.videoId) continue;
              const vid = vr.videoId;
              const title = (vr.title?.runs || []).map((x) => x.text || "").join("") || "Video";
              const ownerRuns = vr.ownerText?.runs || vr.longBylineText?.runs || [];
              const channel = ownerRuns.map((x) => x.text || "").join("") || "YouTube";
              const chId = ownerRuns[0]?.navigationEndpoint?.browseEndpoint?.browseId || "";
              const thumbs = vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails || [];
              const chAvatar = thumbs.length ? (thumbs[thumbs.length - 1]?.url || "") : "";
              const views = vr.shortViewCountText?.simpleText || vr.viewCountText?.simpleText || "";
              const published = vr.publishedTimeText?.simpleText || "";
              const dur = vr.lengthText?.simpleText || "";
              const live = JSON.stringify(vr.badges || []).toUpperCase().includes("LIVE") || JSON.stringify(vr.badges || []).toUpperCase().includes("CANLI");
              items.push({
                videoId: vid,
                title,
                channel,
                channelId: chId,
                channelAvatar: chAvatar,
                views,
                published,
                duration: dur,
                live,
                thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                url: `https://www.youtube.com/watch?v=${vid}`,
              });
              if (items.length >= 24) break;
            }
            if (items.length >= 24) break;
          }
        }
      }
    }
  } catch {}
  if (!items.length) {
    try {
      const r2 = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": EDGE_UA, "Accept-Language": "tr-TR,tr;q=0.9" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion: "2.20250201.01.00", hl: "tr", gl: "TR" } },
          query: cleanQ,
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (r2.ok) {
        const d2 = await r2.json().catch(() => null);
        const secs = d2?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        for (const sec of secs) {
          for (const it of sec?.itemSectionRenderer?.contents || []) {
            const vr = it?.videoRenderer;
            if (!vr?.videoId) continue;
            const vid = vr.videoId;
            const title = (vr.title?.runs || []).map((x) => x.text || "").join("") || "Video";
            const ownerRuns = vr.ownerText?.runs || vr.longBylineText?.runs || [];
            const channel = ownerRuns.map((x) => x.text || "").join("") || "YouTube";
            items.push({
              videoId: vid,
              title,
              channel,
              channelId: ownerRuns[0]?.navigationEndpoint?.browseEndpoint?.browseId || "",
              channelAvatar: "",
              views: vr.shortViewCountText?.simpleText || "",
              published: vr.publishedTimeText?.simpleText || "",
              duration: vr.lengthText?.simpleText || "",
              live: false,
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${vid}`,
            });
            if (items.length >= 24) break;
          }
          if (items.length >= 24) break;
        }
      }
    } catch {}
  }
  return items;
}

async function ytNextRelatedEdge(videoId, reason = "") {
  const vid = extractYtVidAny(videoId);
  if (!vid) return [];
  const out = [];
  const seen = new Set([vid]);
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": EDGE_UA, "Accept-Language": "tr-TR,tr;q=0.9" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20250201.01.00", hl: "tr", gl: "TR" } },
        videoId: vid,
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return [];
    const data = await r.json().catch(() => null);
    const walk = (node) => {
      if (out.length >= 16 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const x of node) walk(x);
        return;
      }
      if (node.compactVideoRenderer?.videoId) {
        const cvr = node.compactVideoRenderer;
        const cvid = String(cvr.videoId || "");
        if (/^[A-Za-z0-9_-]{11}$/.test(cvid) && !seen.has(cvid)) {
          seen.add(cvid);
          const title = cvr.title?.simpleText || (cvr.title?.runs || []).map((x) => x.text || "").join("");
          if (title) {
            out.push({
              videoId: cvid,
              title,
              channel: (cvr.longBylineText?.runs || []).map((x) => x.text || "").join("") || "YouTube",
              channelId: "",
              channelAvatar: "",
              views: cvr.shortViewCountText?.simpleText || "",
              published: cvr.publishedTimeText?.simpleText || "",
              duration: cvr.lengthText?.simpleText || "",
              live: false,
              thumbnail: `https://i.ytimg.com/vi/${cvid}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${cvid}`,
              reason: reason || "✨ Sana Özel",
              sourceKind: "collaborative",
            });
          }
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") walk(v);
      }
    };
    walk(data);
  } catch {}
  return out;
}

async function ytChannelFeedEdge(channelId, channelName = "", channelAvatar = "") {
  const cid = cleanStr(channelId, 48);
  const cname = cleanStr(channelName, 100);
  const items = [];
  if (cid.startsWith("UC") && cid.length >= 20) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?${new URLSearchParams({ channel_id: cid })}`, {
        headers: { "User-Agent": EDGE_UA },
        signal: AbortSignal.timeout(3500),
      });
      if (r.ok) {
        const xml = await r.text();
        const chMatch = xml.match(/<author>\s*<name>([^<]+)<\/name>/i);
        const resolvedCh = (chMatch ? chMatch[1].trim() : cname) || "YouTube";
        const entries = xml.split("<entry>").slice(1, 13);
        for (const ent of entries) {
          const vidM = ent.match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/i);
          const titM = ent.match(/<title>([^<]+)<\/title>/i);
          if (!vidM || !titM) continue;
          const vid = vidM[1];
          const tit = titM[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
          const pubM = ent.match(/<published>([^<]+)<\/published>/i);
          items.push({
            videoId: vid,
            title: tit,
            channel: resolvedCh,
            channelId: cid,
            channelAvatar,
            views: "",
            published: pubM ? pubM[1].slice(0, 10) : "",
            duration: "",
            live: false,
            thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${vid}`,
            reason: `🔔 ${resolvedCh}`,
            sourceKind: "subscription",
          });
        }
      }
    } catch {}
  }
  if (!items.length && cname) {
    const sr = await ytSearchEdge(`${cname.replace(/^@+/, "")} yeni video`);
    for (const r of sr.slice(0, 10)) {
      items.push({
        ...r,
        channelAvatar: r.channelAvatar || channelAvatar,
        channelId: r.channelId || cid,
        reason: `🔔 ${cname}`,
        sourceKind: "subscription",
      });
    }
  }
  return items;
}

async function extractVideoEdge(rawUrl, fallbackTitle = "") {
  const u = String(rawUrl || "").trim();
  const ym = u.match(YT_EXTRACT_RE);
  if (ym) {
    const vid = ym[1];
    return { ok: true, provider: "youtube", videoId: vid, url: `https://www.youtube.com/watch?v=${vid}`, title: fallbackTitle || "YouTube videosu", thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` };
  }
  const vm = u.match(/vimeo\.com\/(?:video\/|channels\/[^/]+\/)?(\d+)/i);
  if (vm) {
    const vid = vm[1];
    return { ok: true, provider: "vimeo", videoId: vid, url: u, embedUrl: `https://player.vimeo.com/video/${vid}?autoplay=1`, title: fallbackTitle || `Vimeo #${vid}` };
  }
  const drv = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{10,})/i);
  if (drv) {
    const fid = drv[1];
    return { ok: true, provider: "drive", fileId: fid, url: `https://drive.google.com/file/d/${fid}/preview`, embedUrl: `https://drive.google.com/file/d/${fid}/preview`, title: fallbackTitle || "Google Drive Video" };
  }
  if (u.toLowerCase().includes("dropbox.com/")) {
    let dbx = u;
    try {
      const du = new URL(u);
      du.searchParams.delete("dl");
      du.searchParams.set("raw", "1");
      dbx = du.toString();
    } catch {
      if (!/[?&](?:raw|dl)=1\b/i.test(dbx)) dbx += (dbx.includes("?") ? "&" : "?") + "raw=1";
    }
    return { ok: true, provider: "direct", url: dbx, title: fallbackTitle || "Dropbox Video" };
  }
  const dm = u.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/i);
  if (dm) {
    const dmId = dm[1];
    return { ok: true, provider: "dailymotion", videoId: dmId, url: u, embedUrl: `https://www.dailymotion.com/embed/video/${dmId}?autoplay=1`, title: fallbackTitle || `Dailymotion #${dmId}` };
  }
  const tt = u.match(/tiktok\.com\/.*?(?:video)\/(\d+)/i);
  if (tt) {
    const ttId = tt[1];
    return { ok: true, provider: "tiktok", videoId: ttId, url: u, embedUrl: `https://www.tiktok.com/embed/v2/${ttId}`, title: fallbackTitle || `TikTok #${ttId}` };
  }
  const twClip = u.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^/]+\/clip\/)([A-Za-z0-9_-]+)/i);
  if (twClip) {
    const slug = twClip[1];
    return { ok: true, provider: "twitch", clip: slug, url: u, embedUrl: `https://clips.twitch.tv/embed?clip=${slug}&parent=watchlivo.online&parent=localhost`, title: fallbackTitle || `Twitch Klip · ${slug}` };
  }
  const tw = u.match(/(?:www\.|m\.)?twitch\.tv\/(?:videos\/(\d+)|([a-zA-Z0-9_]{2,30}))/i);
  if (tw) {
    const vod = tw[1];
    const ch = tw[2];
    if (vod) return { ok: true, provider: "twitch", video: vod, url: u, embedUrl: `https://player.twitch.tv/?video=${vod}&parent=watchlivo.online&parent=localhost`, title: fallbackTitle || `Twitch VOD #${vod}` };
    if (ch && !["directory", "videos", "clips", "login", "settings"].includes(ch.toLowerCase())) {
      return { ok: true, provider: "twitch", channel: ch, url: u, embedUrl: `https://player.twitch.tv/?channel=${ch}&parent=watchlivo.online&parent=localhost`, title: fallbackTitle || `Twitch Canlı · ${ch}` };
    }
  }
  const kick = u.match(/kick\.com\/(?:video\/([a-zA-Z0-9-]+)|([a-zA-Z0-9_.-]{2,30}))/i);
  if (kick) {
    const slug = kick[1] || kick[2];
    return { ok: true, provider: "kick", channel: slug, url: u, embedUrl: `https://player.kick.com/${slug}`, title: fallbackTitle || `Kick Canlı · ${slug}` };
  }
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u)) {
    const fname = new URL(u).pathname.split("/").pop() || "Video";
    return { ok: true, provider: "direct", url: u, title: fallbackTitle || fname };
  }
  if (/\.m3u8(\?|$)/i.test(u)) {
    return { ok: true, provider: "hls", url: u, title: fallbackTitle || "Canlı yayın" };
  }
  try {
    const r = await fetch(u, {
      headers: { "User-Agent": EDGE_UA, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8" },
      redirect: "manual",
      signal: AbortSignal.timeout(3500),
    });
    if (r.ok) {
      const ct = (r.headers.get("Content-Type") || "").toLowerCase();
      if (ct.includes("html") || !ct) {
        const html = (await r.text()).slice(0, 200000);
        const tM = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = fallbackTitle || (tM ? tM[1].replace(/\s+/g, " ").trim().slice(0, 150) : new URL(u).hostname);
        const imgM = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
        const thumb = imgM && imgM[1].startsWith("https://") ? imgM[1] : "";
        const m3uM = html.match(/(https?:\\?\/\\?\/[^\s"'<>]+?\.m3u8[^\s"'<>]*)/i);
        if (m3uM) {
          const mu = m3uM[1].replace(/\\\//g, "/");
          if (isPublicHttpUrl(mu)) return { ok: true, provider: "hls", url: mu, title, thumbnail: thumb };
        }
        const mp4M = html.match(/(https?:\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|webm)(?:\?[^\s"'<>]*)?)/i);
        if (mp4M) {
          const vu = mp4M[1].replace(/\\\//g, "/");
          if (isPublicHttpUrl(vu)) return { ok: true, provider: "direct", url: vu, title, thumbnail: thumb };
        }
        const ogVid = html.match(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)/i);
        if (ogVid) {
          const ogYt = ogVid[1].match(YT_EXTRACT_RE);
          if (ogYt) {
            return { ok: true, provider: "youtube", videoId: ogYt[1], url: `https://www.youtube.com/watch?v=${ogYt[1]}`, title, thumbnail: `https://i.ytimg.com/vi/${ogYt[1]}/hqdefault.jpg` };
          }
          if (/\.(mp4|webm|m3u8)(\?|$)/i.test(ogVid[1]) && isPublicHttpUrl(ogVid[1])) {
            return { ok: true, provider: ogVid[1].includes(".m3u8") ? "hls" : "direct", url: ogVid[1], title, thumbnail: thumb };
          }
        }
        const embYt = html.match(YT_EXTRACT_RE);
        if (embYt) {
          return { ok: true, provider: "youtube", videoId: embYt[1], url: `https://www.youtube.com/watch?v=${embYt[1]}`, title, thumbnail: `https://i.ytimg.com/vi/${embYt[1]}/hqdefault.jpg` };
        }
      }
    }
  } catch {}
  return null;
}

const RAVEDJ_FALLBACK_PRESETS = [
  { id: "wldj_preset_01", title: "🎧 Watchlivo DJ: Blinding Lights × Take On Me — The Weeknd & a-ha", songTitle: "Blinding Lights × Take On Me", artist: "The Weeknd & a-ha", trackA: "The Weeknd - Blinding Lights", trackB: "a-ha - Take On Me", bpm: 126, provider: "youtube", streamType: "youtube", videoId: "4NRXx6U8ABQ", url: "https://www.youtube.com/watch?v=4NRXx6U8ABQ", audioPreviewUrl: "/api/rave/yt-music-stream?v=4NRXx6U8ABQ&kind=audio", thumbnail: "https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg", duration: 200 },
  { id: "wldj_preset_02", title: "🎧 Watchlivo DJ: Starboy × Get Lucky — The Weeknd & Daft Punk", songTitle: "Starboy × Get Lucky", artist: "The Weeknd & Daft Punk", trackA: "The Weeknd - Starboy", trackB: "Daft Punk - Get Lucky", bpm: 120, provider: "youtube", streamType: "youtube", videoId: "34Na4j8AVgA", url: "https://www.youtube.com/watch?v=34Na4j8AVgA", audioPreviewUrl: "/api/rave/yt-music-stream?v=34Na4j8AVgA&kind=audio", thumbnail: "https://i.ytimg.com/vi/34Na4j8AVgA/hqdefault.jpg", duration: 230 },
  { id: "wldj_preset_03", title: "🎧 Watchlivo DJ: Levitating × Treasure — Dua Lipa & Bruno Mars", songTitle: "Levitating × Treasure", artist: "Dua Lipa & Bruno Mars", trackA: "Dua Lipa - Levitating", trackB: "Bruno Mars - Treasure", bpm: 118, provider: "youtube", streamType: "youtube", videoId: "TUVcZfQe-Kw", url: "https://www.youtube.com/watch?v=TUVcZfQe-Kw", audioPreviewUrl: "/api/rave/yt-music-stream?v=TUVcZfQe-Kw&kind=audio", thumbnail: "https://i.ytimg.com/vi/TUVcZfQe-Kw/hqdefault.jpg", duration: 203 },
  { id: "wldj_preset_04", title: "🎧 Watchlivo DJ: Can't Feel My Face × Billie Jean — The Weeknd & Michael Jackson", songTitle: "Can't Feel My Face × Billie Jean", artist: "The Weeknd & Michael Jackson", trackA: "The Weeknd - Can't Feel My Face", trackB: "Michael Jackson - Billie Jean", bpm: 116, provider: "youtube", streamType: "youtube", videoId: "KEI4qSrkPAs", url: "https://www.youtube.com/watch?v=KEI4qSrkPAs", audioPreviewUrl: "/api/rave/yt-music-stream?v=KEI4qSrkPAs&kind=audio", thumbnail: "https://i.ytimg.com/vi/KEI4qSrkPAs/hqdefault.jpg", duration: 213 },
  { id: "wldj_preset_05", title: "🎧 Watchlivo DJ: Titanium × In The End — David Guetta & Linkin Park", songTitle: "Titanium × In The End", artist: "David Guetta & Linkin Park", trackA: "David Guetta ft Sia - Titanium", trackB: "Linkin Park - In The End", bpm: 124, provider: "youtube", streamType: "youtube", videoId: "JRfuAukYTKg", url: "https://www.youtube.com/watch?v=JRfuAukYTKg", audioPreviewUrl: "/api/rave/yt-music-stream?v=JRfuAukYTKg&kind=audio", thumbnail: "https://i.ytimg.com/vi/JRfuAukYTKg/hqdefault.jpg", duration: 245 },
  { id: "wldj_preset_06", title: "🎧 Watchlivo DJ: One More Time × Around The World — Daft Punk", songTitle: "One More Time × Around The World", artist: "Daft Punk", trackA: "Daft Punk - One More Time", trackB: "Daft Punk - Around The World", bpm: 123, provider: "youtube", streamType: "youtube", videoId: "FGBhQbmPwH8", url: "https://www.youtube.com/watch?v=FGBhQbmPwH8", audioPreviewUrl: "/api/rave/yt-music-stream?v=FGBhQbmPwH8&kind=audio", thumbnail: "https://i.ytimg.com/vi/FGBhQbmPwH8/hqdefault.jpg", duration: 320 },
];

async function resolveMashupTrackEdge(queryOrUrl) {
  const q = cleanStr(queryOrUrl, 200);
  if (!q) return null;
  const ym = q.match(YT_EXTRACT_RE);
  let vid = ym ? ym[1] : (/^[A-Za-z0-9_-]{11}$/.test(q) ? q : "");
  let title = q;
  let artist = "Sanatçı";
  let thumb = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : "/static/watchlivo-poster.svg";
  let prev = "";
  if (!vid) {
    const [ytRes, itRes] = await Promise.allSettled([
      ytSearchEdge(q),
      fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term: q, country: "TR", media: "music", entity: "song", limit: "3" })}`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (itRes.status === "fulfilled" && itRes.value?.results?.[0]) {
      const it = itRes.value.results[0];
      prev = String(it.previewUrl || "").trim();
      title = String(it.trackName || q).trim();
      artist = String(it.artistName || "Sanatçı").trim();
      if (it.artworkUrl100) thumb = it.artworkUrl100.replace("100x100bb", "600x600bb");
    }
    if (ytRes.status === "fulfilled" && ytRes.value?.[0]) {
      vid = ytRes.value[0].videoId;
      if (title === q) title = ytRes.value[0].title || q;
      if (artist === "Sanatçı") artist = ytRes.value[0].channel || "Sanatçı";
      if (thumb === "/static/watchlivo-poster.svg") thumb = ytRes.value[0].thumbnail || thumb;
    }
  }
  const url = prev || (vid ? `https://www.youtube.com/watch?v=${vid}` : "");
  if (!url) return null;
  const bpm = 118 + ([...q].reduce((a, c) => a + c.charCodeAt(0), 0) % 18);
  return {
    videoId: vid,
    clipVideoId: vid,
    title,
    artist,
    url,
    altUrls: prev && vid ? [`https://www.youtube.com/watch?v=${vid}`] : [],
    audioPreviewUrl: prev || url,
    mvUrl: vid ? `https://www.youtube.com/watch?v=${vid}` : "",
    thumbnail: thumb,
    duration: 210,
    bpm,
  };
}

function detectAudioMimeEdge(bytes, declaredMime = "") {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return "audio/wav";
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "audio/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  if ((bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  const dm = String(declaredMime || "").split(";")[0].trim().toLowerCase();
  if (dm === "video/mp4" || dm === "audio/mp4" || dm === "audio/x-m4a" || dm === "audio/aac") return "audio/mp4";
  if (dm === "video/webm" || dm === "audio/webm") return "audio/webm";
  if (dm.startsWith("audio/")) return dm;
  return "audio/wav";
}

function decodeBase64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function encodeBytesToBase64(u8) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function persistEdgeAudioNote(env, rawAn) {
  if (!rawAn || typeof rawAn !== "object") return null;
  const durRaw = Number(rawAn.duration || 1.5);
  const dur = Number.isFinite(durRaw) ? Math.max(0.5, Math.min(60.0, durRaw)) : 2.0;
  const peaks = Array.isArray(rawAn.peaks)
    ? rawAn.peaks.slice(0, 36).map((x) => Math.round(Math.max(0.05, Math.min(1.0, Number(x) || 0.3)) * 100) / 100)
    : [0.3, 0.62, 0.84, 0.48, 0.74, 0.52, 0.86, 0.42];
  const existingUrl = String(rawAn.url || "").trim();
  const mu = existingUrl.match(/^\/api\/rave\/voice-note\/([a-zA-Z0-9_-]{4,40})$/);
  const anDu = String(rawAn.dataUrl || "").trim();
  if (mu && !anDu) {
    return {
      id: mu[1],
      url: `/api/rave/voice-note/${mu[1]}`,
      mime: cleanStr(rawAn.mime || "audio/wav", 40),
      duration: Math.round(dur * 10) / 10,
      peaks: peaks.length ? peaks : [0.3, 0.62, 0.84, 0.48],
    };
  }
  if (!anDu || anDu.length > 1_300_000 || !anDu.includes(",")) return null;
  const comma = anDu.indexOf(",");
  const hdr = anDu.slice(0, comma);
  const b64Part = anDu.slice(comma + 1);
  if (!/^data:(?:audio\/|video\/mp4|video\/webm|application\/octet-stream)/i.test(hdr)) return null;
  let rawBytes;
  try {
    rawBytes = decodeBase64ToBytes(b64Part);
  } catch {
    return null;
  }
  if (rawBytes.length < 32 || rawBytes.length > 950_000) return null;
  const declMime = hdr.slice(5).split(";")[0];
  const mime = detectAudioMimeEdge(rawBytes, declMime);
  const cleanB64 = encodeBytesToBase64(rawBytes);
  const nid = `vn_${makeNonce().slice(0, 14)}`;
  const entry = { id: nid, mime, b64: cleanB64, duration: Math.round(dur * 10) / 10, peaks, ts: Math.floor(Date.now() / 1000) };
  _voiceNoteMem.set(nid, entry);
  if (_voiceNoteMem.size > 40) _voiceNoteMem.delete(_voiceNoteMem.keys().next().value);
  if (env?.WATCHLIVO_KV) {
    await env.WATCHLIVO_KV.put(`vn:${nid}`, JSON.stringify(entry), { expirationTtl: 86400 }).catch(() => {});
  }
  return {
    id: nid,
    url: `/api/rave/voice-note/${nid}`,
    mime,
    dataUrl: `data:${mime};base64,${cleanB64}`,
    duration: entry.duration,
    peaks: entry.peaks,
  };
}

const DEFAULT_APP_VERSION = {
  ok: true,
  packageName: "online.watchlivo.app",
  versionCode: 27,
  versionName: "2.0.6-v206",
  apkUrl: "https://watchlivo.online/download/Watchlivo-v2.0.apk",
  fallbackUrl: "https://watchlivo.online/static/Watchlivo-v2.0.apk",
  sha256: "4d3f7044e4662505dafc10bd50aa59ea1bf1865e2b28605a22cde4e4f342c86b",
  sizeBytes: 63027,
  mandatory: true,
  autoInstall: true,
  publishedAt: "2026-11-11T23:45:00.000000+03:00",
  changelog: "v206: High-Throughput Keep-Alive Chunk Proxying & Intelligent Segment Prefetching with YouTube-Style Quality Locking Engine.",
  version: "20261114_v215",
  build: 1,
  description: "YouTube-Style Persistent Quality Locking Engine with server-side &res= master playlist filtering",
};

const DEFAULT_IOS_VERSION = {
  ok: true,
  bundleId: "online.watchlivo.app",
  packageName: "online.watchlivo.app",
  versionCode: 231,
  versionName: "2.2.11",
  ipaUrl: "https://watchlivo.online/download/ipa",
  fallbackUrl: "https://watchlivo.online/static/Watchlivo.ipa",
  manifestUrl: "https://watchlivo.online/api/ios/manifest.plist",
  sha256: "11df55b975211b243fe045e94252c50f26666b7d43ef162242c3647f2631f17d",
  sizeBytes: 682018,
  mandatory: true,
  autoInstall: true,
  remoteConfig: { baseUrl: "https://watchlivo.online", posterProxyEnabled: true, syncIntervalMs: 2000 },
};

function xmlEscapeEdge(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function handleAutonomousEdge(request, url, safePath, env, ctx = null) {
  if ((env?.ROOM_DO || env?.ROOMS_DB) && !env._durableWrapped) {
    env = { ...env, WATCHLIVO_KV: createDurableKvAdapter(env), _durableWrapped: true };
  }
  const boot = await getBootstrap(env);

  // 1. Native WebSockets (/ws/<roomId>)
  if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket" && safePath.startsWith("/ws/")) {
    const roomId = decodeURIComponent(safePath.slice(4).split("/")[0] || "lobby");
    return await handleEdgeRoomWs(roomId, request, url, env, _curatedMap);
  }

  // 2. Robots.txt, Edge Bot Cloaker & SPA HTML routes & /r/<id> invite redirect
  if (safePath === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  }
  const botReq = isCrawlerBot(request);
  if (botReq) {
    if (safePath === "/" || safePath === "/index.html" || safePath.startsWith("/r/") || safePath.startsWith("/join/")) {
      return new Response(request.method === "HEAD" ? null : CLOAKED_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
          "Vary": "User-Agent",
          "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex, nocache",
          "X-Watchlivo-Origin": "cf-autonomous-edge-cloak",
        },
      });
    }
    if (safePath.startsWith("/api/rave/") || safePath.startsWith("/api/rooms/")) {
      return new Response('{"error":"Forbidden","detail":"bot_access_restricted"}', {
        status: 403,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Vary": "User-Agent",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }
  if (safePath.startsWith("/r/") || safePath.startsWith("/join/")) {
    const seg = safePath.replace(/^\/(?:r|join)\//, "").split("/")[0] || "";
    if (seg) {
      return new Response(null, {
        status: 302,
        headers: { Location: `/#/mesh/${encodeURIComponent(seg)}${url.search || ""}`, "Cache-Control": "no-store" },
      });
    }
  }
  if (safePath === "/" || safePath === "/index.html" || safePath.startsWith("/r/") || safePath.startsWith("/join/")) {
    return await serveSpaIndex(env, request.method);
  }

  // 3. Version, Sitemap, Downloads & Static Assets via Cloudflare Workers Assets binding
  if (safePath === "/sitemap.xml") {
    const today = new Date().toISOString().slice(0, 10);
    const urls = [
      ["https://watchlivo.online/", "1.0", "daily"],
      ["https://watchlivo.online/r/tv-trt1", "0.9", "hourly"],
      ["https://watchlivo.online/r/tv-atv", "0.8", "hourly"],
      ["https://watchlivo.online/r/radyo-power-turk", "0.8", "daily"],
    ].map(([loc, prio, freq]) => `  <url><loc>${loc}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${prio}</priority></url>`).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    return new Response(request.method === "HEAD" ? null : xml, {
      status: 200,
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (safePath === "/download/ios") {
    if (env?.ASSETS) {
      const mr = await env.ASSETS.fetch(new Request("https://assets.local/static/Watchlivo.mobileconfig")).catch(() => null);
      if (mr?.ok) {
        return new Response(request.method === "HEAD" ? null : mr.body, {
          status: 200,
          headers: {
            "Content-Type": "application/x-apple-aspen-config",
            "Content-Disposition": 'attachment; filename="Watchlivo.mobileconfig"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    }
    return new Response(null, { status: 302, headers: { Location: "/#/?platform=ios", "Cache-Control": "no-store" } });
  }
  if (safePath === "/download/windows" || safePath === "/download/exe") {
    if (url.searchParams.get("check") === "1") {
      return edgeJson({ ok: false, available: false, platform: "windows", url: "/#/?platform=windows" });
    }
    return new Response(null, { status: 302, headers: { Location: "/#/?platform=windows", "Cache-Control": "no-store" } });
  }
  if (safePath === "/api/app/version") {
    let meta = { ...DEFAULT_APP_VERSION };
    if (env?.ASSETS) {
      const rv = await env.ASSETS.fetch(new Request("https://assets.local/app_version.json")).catch(() => null);
      if (rv?.ok) {
        const parsed = await rv.json().catch(() => null);
        if (parsed && typeof parsed === "object") meta = { ...meta, ...parsed };
      }
    }
    return new Response(request.method === "HEAD" ? null : JSON.stringify(meta), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "X-Watchlivo-Origin": "cf-autonomous-edge",
      },
    });
  }
  if (safePath === "/api/ios/version") {
    let meta = { ...DEFAULT_IOS_VERSION };
    if (env?.ASSETS) {
      const rv = await env.ASSETS.fetch(new Request("https://assets.local/ios_version.json")).catch(() => null);
      if (rv?.ok) {
        const parsed = await rv.json().catch(() => null);
        if (parsed && typeof parsed === "object") meta = { ...meta, ...parsed };
      }
    }
    return new Response(request.method === "HEAD" ? null : JSON.stringify(meta), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "X-Watchlivo-Origin": "cf-autonomous-edge",
      },
    });
  }
  if (safePath === "/api/ios/manifest.plist") {
    let meta = { ...DEFAULT_IOS_VERSION };
    if (env?.ASSETS) {
      const rv = await env.ASSETS.fetch(new Request("https://assets.local/ios_version.json")).catch(() => null);
      if (rv?.ok) {
        const parsed = await rv.json().catch(() => null);
        if (parsed && typeof parsed === "object") meta = { ...meta, ...parsed };
      }
    }
    const verName = xmlEscapeEdge(meta.versionName || "2.2.11");
    const bundleId = xmlEscapeEdge(meta.bundleId || "online.watchlivo.app");
    const ipaUrl = xmlEscapeEdge(meta.ipaUrl || "https://watchlivo.online/download/ipa");
    const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${ipaUrl}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>display-image</string>
          <key>url</key>
          <string>https://watchlivo.online/static/watchlivo-icon-192.png</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>full-size-image</string>
          <key>url</key>
          <string>https://watchlivo.online/static/watchlivo-icon-512.png</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${bundleId}</string>
        <key>bundle-version</key>
        <string>${verName}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>Watchlivo</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
    return new Response(request.method === "HEAD" ? null : plistXml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "X-Watchlivo-Origin": "cf-autonomous-edge",
      },
    });
  }
  if (safePath === "/desktop-auth.html" || safePath === "/static/desktop-auth.html") {
    if (env?.ASSETS) {
      const ar = await env.ASSETS.fetch(new Request("https://assets.local/static/desktop-auth.html"));
      if (ar.ok) {
        const nonce = makeNonce();
        const rawHtml = await ar.text();
        const html = rawHtml.replace(/<script(?![^>]*\bsrc=)/gi, `<script nonce="${nonce}"`);
        return new Response(request.method === "HEAD" ? null : html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Content-Security-Policy": buildAppCsp(nonce),
            "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "SAMEORIGIN",
            "X-Watchlivo-Origin": "cf-autonomous-edge",
          },
        });
      }
    }
  }
  if (
    safePath.startsWith("/static/") ||
    safePath === "/manifest.json" ||
    safePath === "/manifest.webmanifest" ||
    safePath === "/favicon.ico" ||
    safePath === "/apple-touch-icon.png" ||
    safePath === "/apple-touch-icon-precomposed.png" ||
    safePath === "/app_version.json" ||
    safePath === "/ios_version.json" ||
    safePath === "/sw.js"
  ) {
    const assetPath = safePath === "/sw.js" ? "/static/sw.js" : safePath;
    if (env?.ASSETS) {
      const ar = await env.ASSETS.fetch(new Request(`https://assets.local${assetPath}`));
      if (ar.ok) {
        const h = new Headers(ar.headers);
        h.set("X-Watchlivo-Origin", "cf-autonomous-edge");
        h.set("X-Content-Type-Options", "nosniff");
        h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        if (assetPath.toLowerCase().endsWith(".svg")) h.set("Content-Security-Policy", "sandbox");
        if (assetPath.endsWith("sw.js") || assetPath.endsWith(".json")) h.set("Cache-Control", "no-store");
        else h.set("Cache-Control", "public, max-age=86400");
        return new Response(request.method === "HEAD" ? null : ar.body, { status: 200, headers: h });
      }
    }
    if (safePath === "/manifest.json" || safePath === "/manifest.webmanifest") {
      return edgeJson({
        name: "Watchlivo — Birlikte Sinema, Dizi & Müzik Odaları",
        short_name: "Watchlivo",
        start_url: "/",
        display: "standalone",
        background_color: "#090c15",
        theme_color: "#090c15",
        icons: [
          { src: "/static/watchlivo-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/static/watchlivo-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          { src: "/static/watchlivo-logo.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      }, 200, { "Content-Type": "application/manifest+json; charset=utf-8" });
    }
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // 4. Health & Diagnostics
  if (safePath === "/health" || safePath === "/api/health" || safePath === "/api/rave/server-health") {
    const resp = edgeJson({ ok: true, version: "20261124_v239", mode: "cf-autonomous-edge", sharedStore: true, vercel: false, activeRooms: boot.curatedRooms.length });
    return request.method === "HEAD" ? new Response(null, { status: 200, headers: resp.headers }) : resp;
  }

  // 5. Catalog, Search & Streams (Origin/Bot Shield + Signed Token + KV Takedown Filter)
  if (safePath === "/api/rave/session-token") {
    if (!(await isEdgeOriginAllowed(request, env, false))) {
      return edgeJson({ ok: false, error: "Forbidden" }, 403);
    }
    const token = await signEdgeClientToken(env);
    if (!token) return edgeJson({ ok: false, error: "Edge signing secret unavailable" }, 503);
    return edgeJson({ ok: true, token, ttl: 7200 });
  }
  const isResolvePath = safePath === "/api/rave/resolve-catalog" || safePath === "/api/rave/resolve-stream";
  const isSeasonsPath = safePath === "/api/rave/seasons" || safePath === "/api/rave/series-info" || safePath === "/api/rave/series-episodes";
  if (
    safePath === "/api/rave/catalog" ||
    safePath === "/api/rave/supersearch" ||
    isResolvePath ||
    isSeasonsPath
  ) {
    if (!(await isEdgeOriginAllowed(request, env, isResolvePath))) {
      return edgeJson({ ok: false, error: "Forbidden: cross-site origin, missing client token, or automated crawler not allowed" }, 403);
    }
  }
  if (safePath === "/api/rave/admin/takedown") {
    const authHdr = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const adminHdr = (request.headers.get("X-Admin-Secret") || "").trim();
    const expected = String(env?.ADMIN_SECRET || "").trim();
    const valid = Boolean(expected) && (timingSafeEqualStr(authHdr, expected) || timingSafeEqualStr(adminHdr, expected));
    if (!valid) {
      return edgeJson({ ok: false, error: "Unauthorized" }, 401);
    }
    const blocked = await getBlockedTmdbSet(env);
    if (request.method === "GET") {
      return edgeJson({ ok: true, blocked: Array.from(blocked) });
    }
    const body = await request.json().catch(() => ({}));
    const addIds = Array.isArray(body.add) ? body.add : (body.tmdbId ? [body.tmdbId] : []);
    const remIds = Array.isArray(body.remove) ? body.remove : [];
    for (const id of addIds) { const s = String(id || "").trim(); if (s) blocked.add(s); }
    for (const id of remIds) { blocked.delete(String(id || "").trim()); }
    const nextArr = Array.from(blocked);
    _blockedCache = { ts: Date.now(), set: blocked };
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put("blocked:tmdb_ids", JSON.stringify(nextArr));
    }
    return edgeJson({ ok: true, count: nextArr.length, blocked: nextArr });
  }
  const blockedSet = await getBlockedTmdbSet(env);
  if (safePath === "/api/rave/catalog") {
    const prov = (url.searchParams.get("provider") || "").trim().toLowerCase();
    if (prov === "livetv" || prov === "radio") {
      const liveItems = (boot.curatedRooms || DEFAULT_CURATED_LIVE_ROOMS).map((rm) => ({
        id: rm.id,
        roomId: rm.id,
        title: rm.media?.title || rm.name,
        poster: rm.media?.thumbnail || "/static/watchlivo-poster.svg",
        url: rm.media?.url || "",
        altUrls: rm.media?.altUrls || [],
        streamType: rm.media?.streamType || "hls",
        mediaType: rm.media?.mediaType || "live",
        provider: rm.media?.isMusic ? "radio" : "livetv",
        live: true,
        curated: true,
        categories: [rm.media?.isMusic ? "radio" : "livetv"],
      })).filter((it) => prov === "livetv" || it.provider === "radio");
      if (liveItems.length) {
        return edgeJson({ provider: prov, query: "", page: 1, total: liveItems.length, totalAvailable: liveItems.length, items: liveItems, hasMore: false });
      }
    }
    const res = await handleEdgeCatalogSearch(boot, url, env);
    if (blockedSet.size && Array.isArray(res.items)) {
      res.items = res.items.filter((it) => !isItemBlocked(it, blockedSet));
    }
    return edgeJson(res);
  }
  if (safePath === "/api/rave/supersearch") {
    const rawQ = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
    const normQ = normalizeSearchText(rawQ);
    if (!rawQ || !normQ) {
      return edgeJson({ query: rawQ, tmdb: [], justwatch: [], youtube: [], items: [] });
    }
    const ytPromise = normQ.length >= 2
      ? Promise.race([
          ytSearchEdge(rawQ).catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve([]), 4500)),
        ])
      : Promise.resolve([]);
    const [res, ytItems] = await Promise.all([
      handleEdgeCatalogSearch(boot, url, env),
      ytPromise,
    ]);
    const filtered = blockedSet.size ? (res.items || []).filter((it) => !isItemBlocked(it, blockedSet)) : (res.items || []);
    return edgeJson({ query: res.query || rawQ, tmdb: filtered, justwatch: [], youtube: Array.isArray(ytItems) ? ytItems : [], items: filtered });
  }
  if (safePath === "/api/rave/new-releases") {
    if (request.method === "POST") {
      const expectedAdm = String(env?.ADMIN_SECRET || "").trim();
      const authHdrAdm = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const adminHdrAdm = (request.headers.get("X-Admin-Secret") || "").trim();
      if (!expectedAdm || (!timingSafeEqualStr(authHdrAdm, expectedAdm) && !timingSafeEqualStr(adminHdrAdm, expectedAdm))) {
        return edgeJson({ ok: false, error: "Vizyon katalog yönetimi için yönetici yetkisi gerekli." }, 403);
      }
      const b = await request.json().catch(() => null);
      if (!b || typeof b !== "object") {
        return edgeJson({ ok: false, error: "Geçersiz veri" }, 400);
      }
      const rawTitle = String(b.title || "").trim().slice(0, 160);
      const rawTid = String(b.tmdbId || "").trim().slice(0, 30);
      const rawMt = String(b.mediaType || b.type || "movie").trim().toLowerCase();
      const mtype = ["tv", "series", "show", "dizi"].includes(rawMt) ? "tv" : "movie";
      const rawStream = String(b.streamUrl || "").trim().slice(0, 800);
      if (rawStream && !isPublicHttpUrl(rawStream)) {
        return edgeJson({ ok: false, error: "Geçersiz veya güvenli olmayan akış bağlantısı" }, 400);
      }
      const rawSource = String(b.sourceUrl || "").trim().slice(0, 600);
      const safeSource = rawSource && isPublicHttpUrl(rawSource) ? rawSource : "";
      const rawPoster = String(b.poster || "").trim().slice(0, 600);
      let safePoster = rawPoster && isPublicHttpUrl(rawPoster) ? rawPoster : "";
      let safeBackdrop = String(b.backdrop || "").trim().slice(0, 600);
      safeBackdrop = safeBackdrop && isPublicHttpUrl(safeBackdrop) ? safeBackdrop : "";
      let tmHit = null;
      const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
      if (/^\d+$/.test(rawTid)) {
        try {
          const tr = await fetch(`https://api.themoviedb.org/3/${mtype}/${rawTid}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(2500) });
          if (tr.ok) {
            const td = await tr.json();
            if (td?.id) tmHit = mapTmdbItem({ ...td, media_type: mtype });
          }
        } catch {}
      } else if (rawTitle) {
        const hits = await searchTmdbEdge(rawTitle, env).catch(() => []);
        if (hits.length) tmHit = hits.find((h) => h.mediaType === mtype) || hits[0];
      }
      const title = rawTitle || tmHit?.title || "";
      if (!title) {
        return edgeJson({ ok: false, error: "Film veya dizi başlığı gerekli" }, 400);
      }
      const tid = rawTid || String(tmHit?.tmdbId || "") || `vizyon-${Math.abs([...normalizeSearchText(title)].reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 7))}`;
      safePoster = safePoster || tmHit?.poster || "";
      safeBackdrop = safeBackdrop || tmHit?.backdrop || safePoster;
      const item = {
        id: `vizyon-${mtype}-${tid}`,
        tmdbId: String(tid),
        imdbId: String(b.imdbId || "").trim().slice(0, 30),
        title,
        originalTitle: String(b.originalTitle || tmHit?.originalTitle || title).trim().slice(0, 160),
        year: String(b.year || tmHit?.year || "2026").trim().slice(0, 8),
        rating: Number(b.rating || tmHit?.rating || 7.8),
        voteCount: Number(tmHit?.voteCount || 120),
        mediaType: mtype,
        poster: safePoster,
        backdrop: safeBackdrop || safePoster,
        categories: Array.from(new Set([...(tmHit?.categories || []), "vizyon", "trend", mtype === "tv" ? "series" : "movies"])),
        genreLabel: `🇹🇷 Vizyon & Yeni · ${mtype === "tv" ? "Dizi" : "Sinema 4K"}`,
        sourceBadge: "🍿 Vizyonda & Yeni",
        provider: String(b.provider || "cinema").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "cinema",
        streamUrl: rawStream,
        sourceUrl: safeSource,
        officialUrl: safeSource || rawStream,
        customRelease: true,
        isVizyon: true,
        addedAt: Math.floor(Date.now() / 1000),
      };
      let pool = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get("vizyon:custom_releases", "json").catch(() => null)) || [] : [];
      if (!Array.isArray(pool)) pool = [];
      const normT = normalizeSearchText(title);
      pool = [item, ...pool.filter((x) => x && !(String(x.tmdbId || "") === String(tid) && x.mediaType === mtype) && normalizeSearchText(x.title) !== normT)].slice(0, 100);
      if (env?.WATCHLIVO_KV) {
        await env.WATCHLIVO_KV.put("vizyon:custom_releases", JSON.stringify(pool)).catch(() => {});
      }
      return edgeJson({ ok: true, item, totalCustom: pool.length });
    }
    const forceRefreshNr = url.searchParams.get("refresh") === "1";
    const [customPoolRaw, liveVizyonNr] = await Promise.all([
      env?.WATCHLIVO_KV ? env.WATCHLIVO_KV.get("vizyon:custom_releases", "json").catch(() => null) : Promise.resolve(null),
      fetchLiveSinemaccVizyonMovies(env, { forceRefresh: forceRefreshNr, maxItems: 18 }).catch(() => []),
    ]);
    const customPool = Array.isArray(customPoolRaw) ? customPoolRaw : [];
    const fallbackBootNr = liveVizyonNr.length >= 6
      ? []
      : (boot.newReleases || []).filter((x) => Number(String(x?.year || "").slice(0, 4)) >= 2025);
    const seenNr = new Set();
    const mergedNr = [];
    for (const it of [...customPool, ...liveVizyonNr, ...fallbackBootNr]) {
      if (!it || isItemBlocked(it, blockedSet)) continue;
      const k = it.tmdbId
        ? `${it.mediaType || "movie"}:${it.tmdbId}`
        : (it.id && String(it.id).startsWith("sc-") ? `id:${it.id}` : `t:${normalizeSearchText(it.title)}`);
      if (seenNr.has(k)) continue;
      seenNr.add(k);
      mergedNr.push(it);
    }
    return edgeJson({ ok: true, items: mergedNr });
  }
  if (safePath === "/api/rave/latest-episodes") {
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const kvCacheKey = "live:latest_vizyon_eps_v3";
    const EXCLUDED_EP_GENRES = new Set([10763, 10764, 10766, 10767]);
    const filterBlocked = (arr) => (blockedSet.size ? arr.filter((it) => it && !isItemBlocked(it, blockedSet)) : arr.filter(Boolean));
    if (!forceRefresh && env?.WATCHLIVO_KV) {
      const cached = await env.WATCHLIVO_KV.get(kvCacheKey, "json").catch(() => null);
      if (cached && Array.isArray(cached.items) && cached.items.length >= 6) {
        return edgeJson({ ok: true, items: filterBlocked(cached.items).slice(0, 16), cached: true });
      }
    }

    const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
    const todayIso = new Date().toISOString().slice(0, 10);
    const cutoffDate = new Date(Date.now() - 210 * 86400 * 1000).toISOString().slice(0, 10);
    const vodCutoffDate = new Date(Date.now() - 35 * 86400 * 1000).toISOString().slice(0, 10);

    const fetchJsonSafe = async (u, hdrs = {}, timeoutMs = 4200) => {
      try {
        const r = await fetch(u, { headers: { "User-Agent": EDGE_UA, ...hdrs }, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { r.body?.cancel?.(); return null; }
        return await r.json().catch(() => null);
      } catch {
        return null;
      }
    };

    const [liveVizyonMovies, discVod, onAir, trOnAir, popOnAir, acLatest] = await Promise.all([
      fetchLiveSinemaccVizyonMovies(env, { forceRefresh, maxItems: 10 }).catch(() => []),
      fetchJsonSafe(`https://api.themoviedb.org/3/discover/movie?api_key=${encodeURIComponent(apiKey)}&language=tr-TR&primary_release_date.gte=${cutoffDate}&primary_release_date.lte=${vodCutoffDate}&vote_count.gte=40&sort_by=popularity.desc&page=1`),
      fetchJsonSafe(`https://api.themoviedb.org/3/tv/on_the_air?api_key=${encodeURIComponent(apiKey)}&language=tr-TR&page=1`),
      fetchJsonSafe(`https://api.themoviedb.org/3/discover/tv?api_key=${encodeURIComponent(apiKey)}&language=tr-TR&with_original_language=tr&without_genres=10763,10764,10766,10767&air_date.gte=${cutoffDate}&air_date.lte=${todayIso}&sort_by=popularity.desc&page=1`),
      fetchJsonSafe(`https://api.themoviedb.org/3/discover/tv?api_key=${encodeURIComponent(apiKey)}&language=tr-TR&without_genres=10763,10764,10766,10767&vote_count.gte=40&air_date.gte=${cutoffDate}&air_date.lte=${todayIso}&sort_by=popularity.desc&page=1`),
      fetchJsonSafe("https://animecix.tv/secure/last-episodes?page=1&perPage=10", { Referer: "https://animecix.tv/", Accept: "application/json" }),
    ]);

    // 1. Live verified playable 2025/2026 movies first (excludes trailer-only theater releases), with VOD-window TMDB fallback
    const freshMovies = [];
    const seenMov = new Set();
    for (const lm of liveVizyonMovies) {
      if (!lm || !lm.title) continue;
      const mk = `t:${normalizeSearchText(lm.title)}`;
      if (seenMov.has(mk)) continue;
      seenMov.add(mk);
      freshMovies.push({ ...lm, streamReady: lm.streamReady !== false });
      if (freshMovies.length >= 8) break;
    }
    if (freshMovies.length < 8) {
      for (const m of (discVod?.results || [])) {
        if (!m || !m.id || !m.poster_path) continue;
        const rd = String(m.release_date || "");
        if (rd && (rd > vodCutoffDate || rd < cutoffDate)) continue;
        const tid = String(m.id);
        const mk = `t:${normalizeSearchText(m.title || m.original_title || "")}`;
        if (seenMov.has(tid) || seenMov.has(mk)) continue;
        seenMov.add(tid);
        seenMov.add(mk);
        const yr = rd ? rd.slice(0, 4) : todayIso.slice(0, 4);
        freshMovies.push({
          id: `tmdb-movie-${tid}`,
          tmdbId: tid,
          mediaType: "movie",
          title: String(m.title || m.original_title || "").trim(),
          originalTitle: String(m.original_title || m.title || "").trim(),
          year: yr,
          origLang: String(m.original_language || "").toLowerCase(),
          rating: Number(Number(m.vote_average || 0).toFixed(1)) || 7.2,
          poster: `https://image.tmdb.org/t/p/w342${m.poster_path}`,
          backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : `https://image.tmdb.org/t/p/w342${m.poster_path}`,
          still: m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : `https://image.tmdb.org/t/p/w342${m.poster_path}`,
          releaseDate: rd,
          episodeLabel: `🎬 VİZYON ${yr}`,
          sourceBadge: "🍿 Yeni Vizyon Filmi",
          provider: "cinema",
          streamReady: true,
        });
        if (freshMovies.length >= 8) break;
      }
    }

    // 2. Currently airing TV series with REAL last_episode_to_air season & episode numbers (no talk/reality/soap/news)
    const bootPlayableTids = new Set(
      (Array.isArray(boot.catalog) ? boot.catalog : [])
        .map((x) => String(x?.tmdbId || "").trim())
        .filter(Boolean)
    );
    const mergedAirMap = new Map();
    for (const pool of [trOnAir?.results || [], popOnAir?.results || [], onAir?.results || []]) {
      for (const t of pool) {
        if (!t || !t.id || !t.poster_path) continue;
        if (Array.isArray(t.genre_ids) && t.genre_ids.some((g) => EXCLUDED_EP_GENRES.has(Number(g)))) continue;
        if (String(t.original_language || "").match(/^(zh|th|vi|tl)$/i)) continue;
        const isTrOrPlayable = String(t.original_language || "").toLowerCase() === "tr" || bootPlayableTids.has(String(t.id));
        if (!isTrOrPlayable && Number(t.vote_count || 0) < 20) continue;
        if (!mergedAirMap.has(String(t.id))) mergedAirMap.set(String(t.id), t);
      }
    }
    const airCands = Array.from(mergedAirMap.values())
      .sort((a, b) => {
        const aTr = String(a.original_language || "").toLowerCase() === "tr" ? 1 : 0;
        const bTr = String(b.original_language || "").toLowerCase() === "tr" ? 1 : 0;
        if (bTr !== aTr) return bTr - aTr;
        const aPlay = bootPlayableTids.has(String(a.id)) ? 1 : 0;
        const bPlay = bootPlayableTids.has(String(b.id)) ? 1 : 0;
        if (bPlay !== aPlay) return bPlay - aPlay;
        return Number(b.popularity || 0) - Number(a.popularity || 0);
      })
      .slice(0, 12);
    const tvDetails = await Promise.all(
      airCands.map((t) => fetchJsonSafe(`https://api.themoviedb.org/3/tv/${t.id}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, {}, 3500))
    );
    const freshTvEps = [];
    const seenTv = new Set();
    for (const d of tvDetails) {
      if (!d || !d.id || !d.poster_path) continue;
      if (Array.isArray(d.genres) && d.genres.some((g) => EXCLUDED_EP_GENRES.has(Number(g?.id ?? g)))) continue;
      if (Array.isArray(d.genre_ids) && d.genre_ids.some((g) => EXCLUDED_EP_GENRES.has(Number(g)))) continue;
      const le = d.last_episode_to_air;
      const sNum = Number(le?.season_number || 0);
      const eNum = Number(le?.episode_number || 0);
      if (sNum < 1 || eNum < 1) continue;
      const airD = String(le?.air_date || "");
      if (airD && airD < cutoffDate) continue;
      const tid = String(d.id);
      if (seenTv.has(tid)) continue;
      seenTv.add(tid);
      const yr = String(d.first_air_date || "").slice(0, 4) || todayIso.slice(0, 4);
      const stillPath = le?.still_path || d.backdrop_path || d.poster_path;
      const epTitle = String(le?.name || "").trim();
      const isGenericEp = /^(?:\d+\.\s*bölüm|bölüm\s*\d+|episode\s*\d+|ep\.?\s*\d+|\d+\.\s*sezon\s*\d+\.\s*bölüm)$/i.test(epTitle);
      const cleanEpTitle = epTitle && !isGenericEp ? epTitle : "";
      freshTvEps.push({
        id: `tmdb-tv-${tid}-s${sNum}e${eNum}`,
        tmdbId: tid,
        mediaType: "tv",
        title: String(d.name || d.original_name || "").trim(),
        originalTitle: String(d.original_name || d.name || "").trim(),
        year: yr,
        origLang: String(d.original_language || "").toLowerCase(),
        rating: Number(Number(d.vote_average || 0).toFixed(1)) || 7.5,
        season: sNum,
        episode: eNum,
        episodeLabel: `S${sNum}:B${eNum}`,
        episodeTitle: cleanEpTitle,
        airDate: airD,
        poster: `https://image.tmdb.org/t/p/w342${d.poster_path}`,
        backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : `https://image.tmdb.org/t/p/w342${d.poster_path}`,
        still: stillPath ? `https://image.tmdb.org/t/p/w500${stillPath}` : `https://image.tmdb.org/t/p/w342${d.poster_path}`,
        sourceBadge: "📺 Yeni Bölüm",
        provider: "cinema",
        streamReady: true,
      });
      if (freshTvEps.length >= 8) break;
    }

    // 3. Live newly aired Anime episodes (AnimeciX)
    const freshAnimeEps = [];
    const rawAcArr = Array.isArray(acLatest?.data) ? acLatest.data : (Array.isArray(acLatest?.episodes) ? acLatest.episodes : (Array.isArray(acLatest) ? acLatest : []));
    const seenAc = new Set();
    for (const a of rawAcArr) {
      if (!a || typeof a !== "object") continue;
      const aTitle = String(a.title_name || a.title?.name || a.name || "").trim();
      const sNum = Number(a.season_number || a.season || 1);
      const eNum = Number(a.episode_number || a.episode || 0);
      const acId = String(a.title_id || a.title?.id || "").trim();
      if (!aTitle || eNum < 1 || !acId || seenAc.has(acId)) continue;
      seenAc.add(acId);
      const aPoster = String(a.title_poster || a.title?.poster || a.poster || "").trim();
      freshAnimeEps.push({
        id: `ac-${acId}`,
        tmdbId: a.tmdb_id ? String(a.tmdb_id) : "",
        mediaType: "tv",
        title: aTitle,
        originalTitle: aTitle,
        year: todayIso.slice(0, 4),
        origLang: "ja",
        rating: 8.0,
        season: Math.max(1, sNum),
        episode: eNum,
        episodeLabel: `S${Math.max(1, sNum)}:B${eNum}`,
        poster: aPoster.startsWith("http") ? aPoster : `/api/rave/poster?t=${encodeURIComponent(aTitle)}&mt=tv`,
        still: aPoster.startsWith("http") ? aPoster : "",
        sourceBadge: "⚡ Yeni Anime Bölümü",
        provider: "anime",
        catalogProvider: "anime",
        streamReady: true,
      });
      if (freshAnimeEps.length >= 4) break;
    }

    // 4. Interleave Movies + TV Episodes + Anime Episodes for a balanced "Yeni Vizyon & Son Bölümler" shelf
    const mergedLive = [];
    const seenKeys = new Set();
    const pushItem = (it) => {
      if (!it || mergedLive.length >= 16) return;
      const k = it.tmdbId ? `${it.mediaType}:${it.tmdbId}` : `id:${it.id}`;
      if (seenKeys.has(k)) return;
      seenKeys.add(k);
      mergedLive.push(it);
    };
    const maxLen = Math.max(freshTvEps.length, freshMovies.length, freshAnimeEps.length);
    for (let i = 0; i < maxLen && mergedLive.length < 16; i++) {
      if (freshTvEps[i]) pushItem(freshTvEps[i]);
      if (freshMovies[i]) pushItem(freshMovies[i]);
      if (i % 2 === 1 && freshAnimeEps[Math.floor(i / 2)]) pushItem(freshAnimeEps[Math.floor(i / 2)]);
    }

    // Include custom Vizyon releases if any exist in KV
    const customPool = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get("vizyon:custom_releases", "json").catch(() => null)) || [] : [];
    const finalItems = [];
    const seenFinal = new Set();
    for (const it of [...(Array.isArray(customPool) ? customPool.slice(0, 4) : []), ...mergedLive]) {
      if (!it || finalItems.length >= 16) break;
      const k = it.tmdbId ? `${it.mediaType || "movie"}:${it.tmdbId}` : `id:${it.id}`;
      if (seenFinal.has(k)) continue;
      seenFinal.add(k);
      finalItems.push(it);
    }

    // Fallback ONLY if all live upstreams failed completely
    if (finalItems.length < 4 && Array.isArray(boot.newReleases)) {
      for (const nr of boot.newReleases) {
        if (!nr || finalItems.length >= 12) break;
        const yrNum = Number(String(nr.year || "").slice(0, 4));
        if (yrNum && yrNum < 2025) continue;
        pushItem({
          ...nr,
          mediaType: nr.mediaType || "movie",
          episodeLabel: nr.mediaType === "tv" ? `S${nr.season || 1}:B${nr.episode || 1}` : `🎬 VİZYON ${nr.year || "2026"}`,
          sourceBadge: nr.sourceBadge || "🍿 Vizyonda & Yeni",
        });
      }
      for (const it of mergedLive) {
        if (finalItems.length >= 16) break;
        const k = it.tmdbId ? `${it.mediaType || "movie"}:${it.tmdbId}` : `id:${it.id}`;
        if (!seenFinal.has(k)) { seenFinal.add(k); finalItems.push(it); }
      }
    }

    if (finalItems.length >= 6 && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(kvCacheKey, JSON.stringify({ items: finalItems, ts: Math.floor(Date.now() / 1000) }), { expirationTtl: 1800 }).catch(() => {});
    }
    return edgeJson({ ok: true, items: filterBlocked(finalItems).slice(0, 16), cached: false });
  }
  if (isSeasonsPath) {
    const rawId = (url.searchParams.get("id") || "").trim();
    const rawTidIn = (url.searchParams.get("tmdbId") || "").trim();
    const tidMatch = rawId.match(/^(?:tmdb-(?:tv|movie)-)?(\d+)$/i);
    const acMatch = rawId.match(/^ac-(\d+)(?:-\d+)?$/) || rawTidIn.match(/^ac-(\d+)(?:-\d+)?$/);
    let tid = (/^\d+$/.test(rawTidIn) ? rawTidIn : (tidMatch ? tidMatch[1] : "")).trim();
    const isMoviePrefix = /^tmdb-movie-/i.test(rawId);
    const isTvPrefix = /^tmdb-tv-/i.test(rawId);
    const reqMediaType = (url.searchParams.get("mediaType") || url.searchParams.get("type") || "").trim().toLowerCase();
    if (reqMediaType === "movie" || (!reqMediaType && isMoviePrefix && !isTvPrefix)) {
      return edgeJson({ ok: true, tmdbId: tid, mediaType: "movie", seasons: [], episodes: [] });
    }
    const qTitle = (url.searchParams.get("title") || "").trim();
    const rawSParam = (url.searchParams.get("season") ?? url.searchParams.get("s") ?? "").trim();
    const sNum = /^\d+$/.test(rawSParam) ? Math.max(0, Number(rawSParam)) : 1;
    const cacheKey = `seasons:v3:${tid || rawId || qTitle.toLowerCase()}:${sNum}`;
    if (env?.WATCHLIVO_KV) {
      const cached = await env.WATCHLIVO_KV.get(cacheKey, "json").catch(() => null);
      if (cached && !cached.isFallback && Array.isArray(cached.seasons) && cached.seasons.length && Array.isArray(cached.episodes) && cached.episodes.length) {
        return edgeJson(cached);
      }
    }
    const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
    let acTitleObj = null;
    try {
      if (acMatch) {
        const acRes = await fetch(`https://animecix.tv/secure/titles/${acMatch[1]}?seasonNumber=${sNum}`, {
          headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://animecix.tv/" },
          signal: AbortSignal.timeout(3500),
        }).catch(() => null);
        if (acRes && acRes.ok) {
          const acJson = await acRes.json().catch(() => null);
          const candObj = acJson?.title || null;
          if (candObj && Number(candObj.id) === Number(acMatch[1])) {
            acTitleObj = candObj;
            if (!/^\d+$/.test(tid) && acTitleObj?.tmdb_id && /^\d+$/.test(String(acTitleObj.tmdb_id))) {
              tid = String(acTitleObj.tmdb_id);
            }
          }
        }
      }
      if (!/^\d+$/.test(tid) && qTitle) {
        const sr = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(qTitle)}&language=tr-TR`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (sr && sr.ok) {
          const sj = await sr.json().catch(() => null);
          const hit = (sj?.results || [])[0];
          if (hit?.id) tid = String(hit.id);
        }
      }
      let seasons = [];
      let episodes = [];
      let tvMeta = {};
      if (/^\d+$/.test(tid)) {
        const [tvResp, seaResp] = await Promise.all([
          fetch(`https://api.themoviedb.org/3/tv/${tid}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR&append_to_response=external_ids`, { signal: AbortSignal.timeout(3500) }).catch(() => null),
          fetch(`https://api.themoviedb.org/3/tv/${tid}/season/${sNum}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(3500) }).catch(() => null),
        ]);
        const tvJson = tvResp?.ok ? await tvResp.json().catch(() => ({})) : {};
        let seaJson = seaResp?.ok ? await seaResp.json().catch(() => ({})) : {};
        let enJson = null;
        const needEnFallback = !Array.isArray(seaJson.episodes) || !seaJson.episodes.length || seaJson.episodes.some((ep) => !ep?.overview || /^bölüm\s*\d+$/i.test(String(ep?.name || "").trim()));
        if (needEnFallback) {
          const enResp = await fetch(`https://api.themoviedb.org/3/tv/${tid}/season/${sNum}?api_key=${encodeURIComponent(apiKey)}&language=en-US`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
          if (enResp && enResp.ok) {
            enJson = await enResp.json().catch(() => null);
            if ((!Array.isArray(seaJson.episodes) || !seaJson.episodes.length) && Array.isArray(enJson?.episodes) && enJson.episodes.length) {
              seaJson = enJson;
            }
          }
        }
        const enEpMap = new Map(Array.isArray(enJson?.episodes) ? enJson.episodes.map((ep) => [Number(ep.episode_number), ep]) : []);
        const epRunArr = Array.isArray(tvJson.episode_run_time) ? tvJson.episode_run_time.filter((x) => Number(x) > 0) : [];
        const defaultRt = Number(epRunArr[0] || 45) || 45;
        tvMeta = {
          imdbId: String(tvJson?.external_ids?.imdb_id || "").trim(),
          title: String(tvJson?.name || tvJson?.original_name || "").trim(),
          originalTitle: String(tvJson?.original_name || tvJson?.name || "").trim(),
          year: String(tvJson?.first_air_date || "").slice(0, 4),
          rating: tvJson?.vote_average ? Math.round(Number(tvJson.vote_average) * 10) / 10 : 0,
          overview: String(tvJson?.overview || "").trim(),
          poster: tvJson?.poster_path ? `https://image.tmdb.org/t/p/w500${tvJson.poster_path}` : "",
          backdrop: tvJson?.backdrop_path ? `https://image.tmdb.org/t/p/w780${tvJson.backdrop_path}` : "",
          runtime: defaultRt,
        };
        seasons = (tvJson.seasons || [])
          .filter((x) => Number(x.season_number) >= 0 && Number(x.episode_count || 0) > 0)
          .sort((a, b) => {
            const sa = Number(a.season_number);
            const sb = Number(b.season_number);
            if (sa === 0 && sb !== 0) return 1;
            if (sb === 0 && sa !== 0) return -1;
            return sa - sb;
          })
          .map((x) => {
            const sno = Number(x.season_number);
            const cnt = Number(x.episode_count || 1);
            return {
              season: sno,
              name: sno === 0 ? (x.name || "Özel Bölümler") : (x.name || `${sno}. Sezon`),
              count: cnt,
              episodeCount: cnt,
            };
          });
        episodes = (seaJson.episodes || []).map((ep) => {
          const enEp = enEpMap.get(Number(ep.episode_number));
          const epName = String(ep.name || "").trim() || String(enEp?.name || "").trim() || `${ep.episode_number}. Bölüm`;
          const epOv = String(ep.overview || "").trim() || String(enEp?.overview || "").trim();
          return {
            episode: ep.episode_number,
            season: sNum,
            name: epName,
            overview: epOv,
            runtime: Number(ep.runtime || enEp?.runtime || defaultRt) || defaultRt,
            airDate: String(ep.air_date || enEp?.air_date || "").slice(0, 10),
            still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : (enEp?.still_path ? `https://image.tmdb.org/t/p/w300${enEp.still_path}` : ""),
          };
        });
      }
      const acDefaultRt = Number(acTitleObj?.runtime || 24) || 24;
      const acSeasons = (acTitleObj && Array.isArray(acTitleObj.seasons))
        ? acTitleObj.seasons
            .filter((x) => Number(x.number ?? x.season_number ?? 0) >= 0 && Number(x.episodes_count ?? x.episode_count ?? 1) > 0)
            .sort((a, b) => {
              const sa = Number(a.number ?? a.season_number ?? 0);
              const sb = Number(b.number ?? b.season_number ?? 0);
              if (sa === 0 && sb !== 0) return 1;
              if (sb === 0 && sa !== 0) return -1;
              return sa - sb;
            })
            .map((x) => {
              const num = Number(x.number ?? x.season_number ?? 0);
              const cnt = Number(x.episodes_count || x.episode_count || 1);
              return {
                season: num,
                name: num === 0 ? (x.name || "Özel Bölümler") : (x.name || `${num}. Sezon`),
                count: cnt,
                episodeCount: cnt,
              };
            })
        : [];
      const acEpisodes = acTitleObj?.season?.episodes?.length
        ? acTitleObj.season.episodes.map((ep, idx) => ({
            episode: Number(ep.episode_number || idx + 1),
            season: sNum,
            name: ep.name || `${Number(ep.episode_number || idx + 1)}. Bölüm`,
            overview: ep.description || "",
            runtime: Number(ep.runtime || acDefaultRt) || acDefaultRt,
            airDate: String(ep.release_date || ep.air_date || "").slice(0, 10),
            still: ep.poster || "",
          }))
        : [];
      const preferAc = acSeasons.length > 0 && (!seasons.length || acSeasons.length > seasons.length);
      if (preferAc) {
        seasons = acSeasons;
      }
      if ((!episodes.length || preferAc) && acEpisodes.length) {
        episodes = acEpisodes;
      }
      if (acTitleObj && !tvMeta.title) {
        tvMeta = {
          imdbId: String(acTitleObj.imdb_id || "").trim(),
          title: String(acTitleObj.name || "").trim(),
          originalTitle: String(acTitleObj.original_title || acTitleObj.name || "").trim(),
          year: String(acTitleObj.year || "").slice(0, 4),
          rating: acTitleObj.rating ? Math.round(Number(acTitleObj.rating) * 10) / 10 : 0,
          overview: String(acTitleObj.description || "").trim(),
          poster: String(acTitleObj.poster || ""),
          backdrop: String(acTitleObj.backdrop || acTitleObj.poster || ""),
          runtime: acDefaultRt,
        };
      }
      const isFallback = !seasons.length && !episodes.length;
      const fbCount = episodes.length || 1;
      const out = {
        ok: true,
        tmdbId: tid,
        imdbId: tvMeta.imdbId || "",
        mediaType: "tv",
        title: tvMeta.title || qTitle,
        originalTitle: tvMeta.originalTitle || tvMeta.title || qTitle,
        year: tvMeta.year || "",
        rating: tvMeta.rating || 0,
        overview: tvMeta.overview || "",
        poster: tvMeta.poster || "",
        backdrop: tvMeta.backdrop || "",
        runtime: tvMeta.runtime || 45,
        seasons: seasons.length ? seasons : [{ season: 1, name: "1. Sezon", count: fbCount, episodeCount: fbCount }],
        episodes: episodes.length ? episodes : [{ episode: 1, season: sNum, name: "1. Bölüm", runtime: tvMeta.runtime || 45, airDate: "" }],
        ...(isFallback ? { isFallback: true } : {}),
      };
      if (env?.WATCHLIVO_KV && !isFallback) {
        await env.WATCHLIVO_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 3600 }).catch(() => {});
      }
      return edgeJson(out);
    } catch {
      return edgeJson({ ok: true, tmdbId: tid, mediaType: "tv", seasons: [{ season: 1, name: "1. Sezon", count: 1, episodeCount: 1 }], episodes: [{ episode: 1, season: sNum, name: "1. Bölüm", runtime: 45, airDate: "" }], isFallback: true });
    }
  }
  if (safePath === "/api/rave/resolve-catalog" || safePath === "/api/rave/resolve-stream") {
    const rawReqId = (url.searchParams.get("id") || "").trim();
    const rawReqIdMatch = rawReqId.match(/^(?:tmdb-(?:tv|movie)-)?(\d+)$/i);
    const reqTid = (url.searchParams.get("tmdbId") || (rawReqIdMatch ? rawReqIdMatch[1] : rawReqId)).trim();
    const reqMt = (url.searchParams.get("type") || url.searchParams.get("mediaType") || "movie").trim().toLowerCase() === "tv" ? "tv" : "movie";
    if (reqTid && (blockedSet.has(reqTid) || blockedSet.has(`${reqMt}:${reqTid}`))) {
      return edgeJson({ ok: false, error: "Bu içerik kaldırma talebi nedeniyle erişime kapatıldı." }, 404);
    }
    return await handleEdgeResolveCatalog(url, env, edgeJson);
  }
  if (safePath === "/api/rave/stream" || safePath === "/api/rave/stream_manifest" || safePath === "/api/rave/stream-manifest" || safePath === "/api/rave/hls-proxy") {
    return await handleEdgeHlsManifest(url, env, ctx);
  }
  if (safePath === "/api/rave/stream-proxy" || safePath === "/api/rave/stream_chunk") {
    return await handleEdgeStreamProxy(request, url, env, ctx);
  }
  if (safePath === "/api/rave/subtitle.vtt") {
    return await handleEdgeSubtitle(url, env);
  }
  if (safePath === "/api/rave/subtitles") {
    const rawTidParam = (url.searchParams.get("tmdbId") || url.searchParams.get("tmdb_id") || url.searchParams.get("tid") || url.searchParams.get("id") || "").trim().slice(0, 48);
    const tidPrefixM = rawTidParam.match(/^(?:tmdb-(tv|movie)-)?(\d+)$/i);
    let tid = tidPrefixM ? tidPrefixM[2] : "";
    let imdbId = (url.searchParams.get("imdbId") || url.searchParams.get("imdb_id") || "").trim().slice(0, 30);
    if (!/^tt\d{5,10}$/i.test(imdbId)) imdbId = "";
    const rawVidParam = (url.searchParams.get("videoId") || url.searchParams.get("v") || "").trim().slice(0, 1500);
    const rawStreamUrl = (url.searchParams.get("url") || "").trim().slice(0, 1500);
    let ytVid = extractYtVidAny(rawVidParam);
    if (!ytVid && !tid && !imdbId && rawStreamUrl) {
      ytVid = extractYtVidAny(rawStreamUrl);
    }
    const bypassSubCache = url.searchParams.get("refresh") === "1" || url.searchParams.get("nocache") === "1";
    if (ytVid && !tid && !imdbId) {
      const ytSubKey = `subs:v4:yt:${ytVid}`;
      if (!bypassSubCache && env?.WATCHLIVO_KV) {
        const cachedYt = await env.WATCHLIVO_KV.get(ytSubKey, "json").catch(() => null);
        if (cachedYt && Array.isArray(cachedYt.subtitleTracks) && cachedYt.subtitleTracks.length) {
          return edgeJson(cachedYt);
        }
      }
      const fetchYtPlayerCaptions = async (clientCtx) => {
        try {
          const pr = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": EDGE_UA, "Accept-Language": "tr-TR,tr;q=0.9" },
            body: JSON.stringify({ context: { client: clientCtx }, videoId: ytVid }),
            signal: AbortSignal.timeout(4000),
          });
          if (!pr.ok) return [];
          const pj = await pr.json().catch(() => null);
          const tracks = pj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          return Array.isArray(tracks) ? tracks : [];
        } catch {
          return [];
        }
      };
      let capTracks = await fetchYtPlayerCaptions({ clientName: "IOS", clientVersion: "20.03.02", hl: "tr", gl: "TR" });
      if (!capTracks.length) {
        capTracks = await fetchYtPlayerCaptions({ clientName: "WEB", clientVersion: "2.20250201.01.00", hl: "tr", gl: "TR" });
      }
      const ytSubs = [];
      const seenYtLang = new Set();
      let hasTrYt = false;
      let bestSrcVttUrl = "";
      for (const trk of capTracks) {
        const baseUrl = String(trk?.baseUrl || "").trim();
        if (!baseUrl || !isPublicHttpUrl(baseUrl)) continue;
        const lcodeRaw = String(trk?.languageCode || "").trim().toLowerCase();
        const lcodeShort = lcodeRaw.split("-")[0] || "en";
        const isAsr = trk?.kind === "asr";
        const nameTxt = String(trk?.name?.simpleText || (trk?.name?.runs || []).map((x) => x.text || "").join("") || "").trim();
        const vttRawU = baseUrl.includes("fmt=vtt") ? baseUrl : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=vtt`;
        if (lcodeShort === "tr") hasTrYt = true;
        if (!bestSrcVttUrl && (lcodeShort === "en" || !isAsr)) bestSrcVttUrl = vttRawU;
        const dedupKey = `${lcodeShort}:${isAsr ? "asr" : "man"}`;
        if (seenYtLang.has(dedupKey)) continue;
        seenYtLang.add(dedupKey);
        ytSubs.push({
          id: `yt-${lcodeShort}${isAsr ? "-asr" : ""}`,
          lang: lcodeShort,
          ytLangCode: lcodeRaw || lcodeShort,
          label: formatSubLabel(lcodeShort, isAsr ? "YouTube Otomatik" : (nameTxt || "YouTube")),
          url: `/api/rave/subtitle.vtt?url=${encodeURIComponent(vttRawU)}&lang=${encodeURIComponent(lcodeShort)}`,
          kind: "subtitles",
          source: isAsr ? "youtube-asr" : "youtube",
        });
      }
      if (!bestSrcVttUrl && ytSubs.length) {
        const firstSrc = capTracks.find((t) => t?.baseUrl && isPublicHttpUrl(t.baseUrl))?.baseUrl || "";
        if (firstSrc) bestSrcVttUrl = firstSrc.includes("fmt=vtt") ? firstSrc : `${firstSrc}${firstSrc.includes("?") ? "&" : "?"}fmt=vtt`;
      }
      if (!hasTrYt && bestSrcVttUrl) {
        ytSubs.unshift({
          id: "yt-tr-auto",
          lang: "tr",
          ytLangCode: "tr",
          label: "🇹🇷 Türkçe (YouTube Otomatik Çeviri)",
          url: `/api/rave/subtitle.vtt?url=${encodeURIComponent(bestSrcVttUrl)}&lang=tr&translate=tr`,
          kind: "subtitles",
          source: "ai-tr",
        });
      }
      const ytRank = (s) => {
        if (s.lang === "tr" && s.source !== "ai-tr") return 0;
        if (s.lang === "tr") return 1;
        if (s.lang === "en") return 2;
        return 3;
      };
      ytSubs.sort((a, b) => ytRank(a) - ytRank(b));
      const ytPayload = { ok: true, subtitleTracks: ytSubs, subtitles: ytSubs, audioTracks: [], intro: null, mode: "cf-autonomous-edge" };
      if (ytSubs.length && env?.WATCHLIVO_KV) {
        await env.WATCHLIVO_KV.put(ytSubKey, JSON.stringify(ytPayload), { expirationTtl: 900 }).catch(() => {});
      }
      return edgeJson(ytPayload);
    }
    const mtypeParam = (url.searchParams.get("mediaType") || url.searchParams.get("type") || url.searchParams.get("mtype") || "").trim().toLowerCase();
    const hasExplicitSe = Boolean(url.searchParams.get("season") || url.searchParams.get("s") || url.searchParams.get("episode") || url.searchParams.get("e"));
    let mtype = (mtypeParam === "tv" || mtypeParam === "series" || mtypeParam === "show" || (!mtypeParam && (tidPrefixM?.[1]?.toLowerCase() === "tv" || hasExplicitSe))) ? "tv" : "movie";
    const s = Math.max(1, Number(url.searchParams.get("season") || url.searchParams.get("s") || 1) || 1);
    const e = Math.max(1, Number(url.searchParams.get("episode") || url.searchParams.get("e") || 1) || 1);
    const reqTitleSub = (url.searchParams.get("title") || "").trim().slice(0, 120);
    const reqDurSec = Number(url.searchParams.get("duration") || url.searchParams.get("dur") || 0) || 0;
    const subKey = `subs:v4:${mtype}:${tid || imdbId || normalizeSearchText(reqTitleSub).slice(0, 32)}:${s}:${e}`;
    if (!bypassSubCache && (tid || imdbId) && env?.WATCHLIVO_KV) {
      const cachedSubs = await env.WATCHLIVO_KV.get(subKey, "json").catch(() => null);
      if (cachedSubs && Array.isArray(cachedSubs.subtitleTracks) && cachedSubs.subtitleTracks.length) {
        return edgeJson(cachedSubs);
      }
    }
    const SECONDARY_LANGS = ["de", "fr", "es", "it", "ru", "ar", "pt", "nl", "ja", "ko", "az"];
    const scoreSubItem = (it) => {
      let sc = 0;
      const fn = String(it.subtitleFileName || it.movieReleaseName || it.SubFileName || it.MovieReleaseName || "").toLowerCase();
      const fmt = String(it.releaseFormat || "").toLowerCase();
      const rawFpsMilli = Number(it.fpsMilli || 0);
      const rawSubFps = Number(it.SubFPS || 0);
      const effFps = rawFpsMilli > 0 ? (rawFpsMilli / 1000) : rawSubFps;
      if (/\b(?:forced|foreign[\s._-]*only|signs[\s._&-]*songs?|trailer|teaser|fragman|promo|sample|cd\s*1|cd\s*2|disc\s*1|disc\s*2|part\s*1|korsub|hc)\b/i.test(fn)) sc -= 80;
      if (/(?:bluray|bdrip|brrip|web[-.]?dl|webrip|\bweb\b|amzn|nf\b|dsnp|hmax)/i.test(`${fmt} ${fn}`)) sc += 30;
      else if (/(?:hdtv|dvdrip|\bdvd\b)/i.test(`${fmt} ${fn}`)) sc += 12;
      if (/(?:telesync|\bts\b|\bcam\b|hdcam|\btc\b|hdts)/i.test(`${fmt} ${fn}`)) sc -= 28;
      if (effFps >= 23.9 && effFps <= 24.05) sc += 14;
      else if (effFps >= 24.9 && effFps <= 25.1) sc -= 26; // PAL 25fps speedup causes 4.27% drift (3-7 min off)
      else if (effFps >= 29.5 && effFps <= 30.1) sc -= 10;
      if (/(?:\b25\s*fps\b|\bpal\b)/i.test(fn)) sc -= 24;
      if (/utf-?8/i.test(String(it.SubEncoding || ""))) sc += 4;
      const dlCnt = Number(it.SubDownloadsCnt || 0);
      if (dlCnt >= 1000) sc += 12;
      else if (dlCnt >= 100) sc += 6;
      if (String(it.SubAutoTranslation || "") === "1") sc -= 25;
      return sc;
    };
    const extractFormatTag = (it) => {
      const sTxt = `${it.releaseFormat || ""} ${it.subtitleFileName || it.movieReleaseName || it.SubFileName || it.MovieReleaseName || ""}`;
      if (/bluray|bdrip|brrip/i.test(sTxt)) return "BluRay";
      if (/web[-.]?dl|webrip|\bweb\b|netflix|amzn|disney/i.test(sTxt)) return "WEB";
      if (/hdtv/i.test(sTxt)) return "HDTV";
      if (/dvd/i.test(sTxt)) return "DVD";
      return "";
    };

    const byLang = new Map();
    const seenSubU = new Set();
    const pushSubCand = (lang, rawUrl, score, fmtTag, source) => {
      if (!lang || !rawUrl || !isPublicHttpUrl(rawUrl) || seenSubU.has(rawUrl)) return;
      seenSubU.add(rawUrl);
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push({ lang, rawUrl, score, fmtTag, source });
    };

    try {
      const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
      // Title-only fallback when neither tmdbId nor imdbId was provided
      if (!tid && !imdbId && reqTitleSub) {
        const hits = await searchTmdbEdge(reqTitleSub, env).catch(() => []);
        const pick = hits.find((h) => h.mediaType === mtype) || hits[0];
        if (pick?.tmdbId && /^\d+$/.test(String(pick.tmdbId))) {
          tid = String(pick.tmdbId);
          if (!mtypeParam && pick.mediaType) mtype = pick.mediaType;
        }
      }
      if (/^\d+$/.test(tid) && !imdbId) {
        const mapKey = `tmdb2imdb:${mtype}:${tid}`;
        if (env?.WATCHLIVO_KV) {
          const cachedImdb = await env.WATCHLIVO_KV.get(mapKey).catch(() => null);
          if (cachedImdb && /^tt\d{5,10}$/i.test(String(cachedImdb).trim())) {
            imdbId = String(cachedImdb).trim();
          }
        }
        if (!imdbId) {
          const extR = await fetch(`https://api.themoviedb.org/3/${mtype}/${tid}/external_ids?api_key=${encodeURIComponent(apiKey)}`, {
            signal: AbortSignal.timeout(3500),
          }).catch(() => null);
          if (extR?.ok) {
            const extJ = await extR.json().catch(() => null);
            if (extJ?.imdb_id) {
              imdbId = String(extJ.imdb_id).trim();
              if (env?.WATCHLIVO_KV && /^tt\d{5,10}$/i.test(imdbId)) {
                await env.WATCHLIVO_KV.put(mapKey, imdbId, { expirationTtl: 604800 }).catch(() => {});
              }
            }
          }
        }
      }
      if (imdbId) {
        // 1. Primary: OpenSubtitles v3 Stremio addon
        const stremioUrl = mtype === "tv"
          ? `https://opensubtitles-v3.strem.io/subtitles/series/${encodeURIComponent(imdbId)}:${s}:${e}.json`
          : `https://opensubtitles-v3.strem.io/subtitles/movie/${encodeURIComponent(imdbId)}.json`;
        const stJ = await fetch(stremioUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(4200),
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (Array.isArray(stJ?.subtitles)) {
          for (const it of stJ.subtitles) {
            const rawU = String(it?.url || "").trim();
            if (!rawU || !isPublicHttpUrl(rawU)) continue;
            const fn = String(it.subtitleFileName || it.movieReleaseName || "");
            const normLang = normalizeSubLang(it.lang || "", fn, rawU);
            if (!normLang) continue;
            pushSubCand(normLang, rawU, scoreSubItem(it), extractFormatTag(it), "opensubtitles");
          }
        }

        // 2. Secondary (when TR < 2 or EN < 2): OpenSubtitles REST API -> subs5.strem.io UTF-8 ID bridge
        const curTrCnt = (byLang.get("tr") || []).length;
        const curEnCnt = (byLang.get("en") || []).length;
        const imdbDigits = imdbId.replace(/^tt/i, "").replace(/^0+/, "") || imdbId.replace(/^tt/i, "");
        if ((curTrCnt < 2 || curEnCnt < 2) && /^\d+$/.test(imdbDigits)) {
          const fetchOsRestLang = async (osLang3, normCode) => {
            const restUrl = mtype === "tv"
              ? `https://rest.opensubtitles.org/search/episode-${e}/imdbid-${imdbDigits}/season-${s}/sublanguageid-${osLang3}`
              : `https://rest.opensubtitles.org/search/imdbid-${imdbDigits}/sublanguageid-${osLang3}`;
            const arr = await fetch(restUrl, {
              headers: { "User-Agent": "TemporaryUserAgent", Accept: "application/json" },
              signal: AbortSignal.timeout(4200),
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
            if (!Array.isArray(arr)) return;
            for (const it of arr) {
              if (!it || typeof it !== "object") continue;
              const fmtLow = String(it.SubFormat || "").toLowerCase();
              if (fmtLow && fmtLow !== "srt" && fmtLow !== "vtt") continue;
              if (String(it.SubBad || "0") === "1") continue;
              if (Number(it.SubSumCD || 1) > 1) continue;
              if (mtype === "tv") {
                const rs = Number(it.SeriesSeason || 0);
                const re = Number(it.SeriesEpisode || 0);
                if (rs > 0 && rs !== s) continue;
                if (re > 0 && re !== e) continue;
              }
              const fileId = String(it.IDSubtitleFile || "").trim();
              if (!/^\d+$/.test(fileId)) continue;
              const bridgeUrl = `https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${fileId}`;
              pushSubCand(normCode, bridgeUrl, scoreSubItem(it) + 4, extractFormatTag(it), "opensubtitles");
            }
          };
          const restJobs = [];
          if (curTrCnt < 2) restJobs.push(fetchOsRestLang("tur", "tr"));
          if (curEnCnt < 2) restJobs.push(fetchOsRestLang("eng", "en"));
          if (restJobs.length) await Promise.allSettled(restJobs);
        }

        // 3. Tertiary TV fallback (Gestdown / Addic7ed mirror) when TR === 0 or EN === 0
        if (mtype === "tv" && ((byLang.get("tr") || []).length === 0 || (byLang.get("en") || []).length === 0)) {
          try {
            const gdShow = await fetch(`https://api.gestdown.info/shows/external/imdb/${encodeURIComponent(imdbId)}`, {
              headers: { "User-Agent": EDGE_UA, Accept: "application/json" },
              signal: AbortSignal.timeout(2500),
            }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
            const showId = gdShow?.shows?.[0]?.id || "";
            if (showId) {
              const gdLangs = [];
              if ((byLang.get("tr") || []).length === 0) gdLangs.push(["turkish", "tr"]);
              if ((byLang.get("en") || []).length === 0) gdLangs.push(["english", "en"]);
              await Promise.allSettled(gdLangs.map(async ([gdLangName, normCode]) => {
                const gdRes = await fetch(`https://api.gestdown.info/subtitles/get/${encodeURIComponent(showId)}/${s}/${e}/${gdLangName}`, {
                  headers: { "User-Agent": EDGE_UA, Accept: "application/json" },
                  signal: AbortSignal.timeout(2800),
                }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
                for (const sub of (gdRes?.matchingSubtitles || []).slice(0, 2)) {
                  const dlUri = String(sub?.downloadUri || "").trim();
                  if (!dlUri) continue;
                  const fullU = dlUri.startsWith("http") ? dlUri : `https://api.gestdown.info${dlUri.startsWith("/") ? "" : "/"}${dlUri}`;
                  pushSubCand(normCode, fullU, 18, "WEB", "gestdown");
                }
              }));
            }
          } catch {}
        }
      }
    } catch {}

    // Sort each language's candidates by quality score descending
    for (const arr of byLang.values()) arr.sort((a, b) => b.score - a.score);

    const selected = [];
    const trList = (byLang.get("tr") || []).slice(0, 5);
    const enList = (byLang.get("en") || []).slice(0, 4);
    selected.push(...trList, ...enList);
    let secAdded = 0;
    for (const sl of SECONDARY_LANGS) {
      if (secAdded >= 5) break;
      const arr = byLang.get(sl);
      if (arr && arr.length) {
        selected.push(arr[0]);
        secAdded += 1;
      }
    }
    // If neither TR nor EN nor major secondary languages exist, include up to 4 best available languages (1 per lang)
    if (!selected.length) {
      for (const arr of byLang.values()) {
        if (selected.length >= 4) break;
        if (arr && arr.length) selected.push(arr[0]);
      }
    }

    // Parallel probe on top 4 TR + top 4 EN tracks to reject dead/corrupt/Tamil-mojibake/wrong-episode/trailer uploads, penalize 25fps PAL, CD1 splits, forced subs & betting spam, & reclassify mislabeled files
    const probeTargets = [
      ...trList.slice(0, 4),
      ...enList.slice(0, 4),
    ];
    const minFullCues = mtype === "tv" ? 20 : 45;
    const parseTsSec = (h, m, sec) => (Number(h || 0) * 3600) + (Number(m || 0) * 60) + Number(sec || 0);
    const tsPairRe = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,]\d{1,3}\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,]\d{1,3}/g;
    if (probeTargets.length) {
      await Promise.allSettled(probeTargets.map(async (cand) => {
        try {
          const r = await fetch(cand.rawUrl, {
            headers: { "User-Agent": "Mozilla/5.0", Accept: "text/plain,text/vtt,*/*" },
            redirect: "follow",
            signal: AbortSignal.timeout(2400),
          });
          if (r.status === 404 || r.status === 410 || r.status >= 500) {
            r.body?.cancel?.();
            cand.dead = true;
            return;
          }
          if (!r.ok) {
            r.body?.cancel?.();
            return;
          }
          const buf = await r.arrayBuffer();
          const txt = decodeSubtitleBytes(buf);
          if (/^(?:<!doctype|<html|<script|<svg)/i.test(txt.trimStart())) {
            cand.dead = true;
            return;
          }
          if ((cand.lang === "tr" || cand.lang === "en") && isCorruptOrForeignSubtitleText(txt)) {
            cand.dead = true;
            return;
          }
          // Reject wrong TV season/episode explicitly declared inside subtitle header cues (e.g. S5E3 uploaded under S3E5)
          const headChunk = txt.slice(0, 2600);
          if (mtype === "tv" && s > 0 && e > 0) {
            const trEpM = headChunk.match(/\b(\d{1,2})\.\s*sezon[\s,.\-–—]*(\d{1,2})\.\s*b[oö]l[uü]m\b/i);
            const enEpM = headChunk.match(/\bS0?(\d{1,2})\s*[Ex]0?(\d{1,2})\b/i);
            const epM = trEpM || enEpM;
            if (epM) {
              const detS = Number(epM[1]);
              const detE = Number(epM[2]);
              if (detS > 0 && detE > 0 && (detS !== s || detE !== e)) {
                cand.dead = true;
                return;
              }
            }
          }
          if (/(?:para\s+yat[ıi]rma\s+bonusu|forumiptv\.org|\b1xbet\b|ho[şs]geldin\s+bonusu|canl[ıi]\s+bahis)/i.test(headChunk)) {
            cand.score -= 40;
          }
          let cueCount = 0;
          let firstCueSec = -1;
          let lastEndSec = 0;
          tsPairRe.lastIndex = 0;
          let tm;
          while ((tm = tsPairRe.exec(txt)) !== null) {
            cueCount += 1;
            const stSec = parseTsSec(tm[1], tm[2], tm[3]);
            const enSec = parseTsSec(tm[4], tm[5], tm[6]);
            if (firstCueSec < 0 && stSec >= 0) firstCueSec = stSec;
            if (enSec > lastEndSec && enSec < 28800) lastEndSec = enSec;
          }
          cand.cueCount = cueCount;
          if (firstCueSec >= 0) cand.firstCueSec = firstCueSec;
          if (lastEndSec > 0) cand.lastEndSec = lastEndSec;
          if (cueCount >= 3 && cueCount < minFullCues) {
            cand.isTrailerStub = true;
            cand.score -= 70;
          }
          const detected = detectSubtitleTextLang(txt);
          if (detected && (detected === "tr" || detected === "en") && detected !== cand.lang) {
            cand.lang = detected;
            cand.reclassified = true;
          }
        } catch {}
      }));
    }

    // Cross-track duration & PAL 25fps / wrong-cut / TV-recap alignment scoring
    const fullSpans = selected
      .filter((c) => !c.dead && !c.isTrailerStub && Number(c.cueCount || 0) >= minFullCues && Number(c.lastEndSec || 0) >= 600)
      .map((c) => c.lastEndSec)
      .sort((a, b) => a - b);
    const refSpanSec = reqDurSec >= 600
      ? reqDurSec
      : (fullSpans.length >= 2 ? fullSpans[Math.floor(fullSpans.length * 0.65)] : (fullSpans[0] || 0));
    if (refSpanSec >= 600) {
      for (const c of selected) {
        if (c.dead || c.isTrailerStub || !c.lastEndSec || c.lastEndSec < 300) continue;
        const ratio = c.lastEndSec / refSpanSec;
        if (ratio < 0.68) {
          c.score -= 95; // Half-length CD1/Disc1 split (e.g. Godfather 5594s on 10629s movie)
        } else if (refSpanSec >= 3600 && Number(c.cueCount || 0) > 0 && Number(c.cueCount || 0) < 150) {
          c.score -= 85; // Forced foreign-dialogue-only track on a full-length movie (e.g. Avatar Na'vi-only)
        } else if (ratio < 0.85 || ratio > 1.15) {
          c.score -= 48; // Wrong cut / wrong episode / wrong movie duration
        } else if (reqDurSec >= 600 && ratio > 1.025) {
          c.score -= 32; // Longer than actual video (e.g. includes unplayed TV recap)
        } else if (refSpanSec >= 2400 && ratio < 0.962 && ratio >= 0.915) {
          c.score -= 22; // Likely 25fps PAL speedup (~0.959x) relative to 23.976fps reference
        } else if (ratio >= 0.965 && ratio <= 1.015) {
          c.score += 10; // Strong match to reference runtime
        }
      }
      if (mtype === "tv") {
        for (const langKey of ["tr", "en"]) {
          const langFull = selected.filter((c) => !c.dead && !c.isTrailerStub && c.lang === langKey && c.lastEndSec >= 600);
          const hasNoRecapStart = langFull.some((c) => Number(c.firstCueSec || 0) >= 45 && c.lastEndSec <= refSpanSec * 1.015);
          if (hasNoRecapStart) {
            for (const c of langFull) {
              if (Number(c.firstCueSec || 0) < 8 && c.lastEndSec > refSpanSec + 45) {
                c.score -= 28; // Likely includes "Previously on..." recap absent in stream
              }
            }
          }
        }
      }
    }

    // Drop trailer stubs ONLY when at least one full-length subtitle exists in the same language
    const hasFullByLang = {};
    for (const c of selected) {
      if (!c.dead && !c.isTrailerStub && Number(c.cueCount || 0) >= minFullCues) {
        hasFullByLang[c.lang] = true;
      }
    }
    const liveSelected = selected.filter((c) => !c.dead && !(c.isTrailerStub && hasFullByLang[c.lang]));
    const rankLang = (l) => (l === "tr" ? 0 : (l === "en" ? 1 : 2));
    liveSelected.sort((a, b) => (rankLang(a.lang) - rankLang(b.lang)) || (b.score - a.score));

    // Final per-language cap & clean Turkish UI labels
    const capped = [];
    const langCapCount = {};
    for (const c of liveSelected) {
      const cap = c.lang === "tr" ? 4 : (c.lang === "en" ? 3 : 1);
      langCapCount[c.lang] = (langCapCount[c.lang] || 0) + 1;
      if (langCapCount[c.lang] > cap) continue;
      capped.push(c);
    }
    const finalCounts = {};
    for (const c of capped) finalCounts[c.lang] = (finalCounts[c.lang] || 0) + 1;
    const seenIdx = {};
    const outSubs = capped.map((c) => {
      seenIdx[c.lang] = (seenIdx[c.lang] || 0) + 1;
      const n = seenIdx[c.lang];
      const total = finalCounts[c.lang];
      let suffix = "";
      if (total > 1) {
        suffix = c.fmtTag ? `Seçenek ${n} · ${c.fmtTag}` : `Seçenek ${n}`;
      } else if (c.lang === "tr" || c.lang === "en") {
        suffix = c.fmtTag || (c.source === "gestdown" ? "Addic7ed" : "OpenSubtitles");
      }
      return {
        id: total > 1 ? `os-${c.lang}-${n}` : `os-${c.lang}`,
        lang: c.lang,
        label: formatSubLabel(c.lang, suffix),
        url: `/api/rave/subtitle.vtt?url=${encodeURIComponent(c.rawUrl)}`,
        source: c.source,
        ...(c.lastEndSec ? { spanSec: Math.round(c.lastEndSec) } : {}),
        ...(typeof c.firstCueSec === "number" && c.firstCueSec >= 0 ? { firstCueSec: Math.round(c.firstCueSec) } : {}),
      };
    });

    const payload = { ok: true, subtitleTracks: outSubs, subtitles: outSubs, audioTracks: [], intro: null, mode: "cf-autonomous-edge" };
    if (outSubs.length && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(subKey, JSON.stringify(payload), { expirationTtl: 1800 }).catch(() => {});
    }
    return edgeJson(payload);
  }
  if (safePath === "/api/rave/poster") {
    return await handleEdgePoster(url, env);
  }

  // 6. Rooms (24/7 Durable Object + D1 Global SQLite + KV + 21 Live TV Curated Rooms)
  if (safePath === "/api/rooms" || safePath === "/api/rave/meshes") {
    if (request.method === "POST") return await handleEdgeRoomCreate(request, env, edgeJson);
    const rawPub = await listGlobalPublicRooms(env);
    const nowS = Math.floor(Date.now() / 1000);
    const curatedBase = (boot.curatedRooms && boot.curatedRooms.length) ? boot.curatedRooms : DEFAULT_CURATED_LIVE_ROOMS;
    const curatedIdSet = new Set([...DEFAULT_CURATED_MAP.keys(), ...curatedBase.map((c) => c.id)]);
    const curatedCounts = new Map();
    const cleanedIdx = [];
    const pub = [];
    for (const r of rawPub) {
      if (!r || !r.id) continue;
      const fresh = Number(r.updatedAt || 0) > 0 && (nowS - Number(r.updatedAt)) < 120;
      const cnt = Number(r.participantCount ?? r.count ?? 0);
      if (curatedIdSet.has(r.id) || r.curated) {
        if (fresh) {
          curatedCounts.set(r.id, Math.max(0, cnt));
          cleanedIdx.push(r);
        }
        continue;
      }
      if (cnt > 0 && fresh) {
        cleanedIdx.push(r);
        pub.push(r);
      }
    }
    if (cleanedIdx.length !== rawPub.length && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(cleanedIdx), { expirationTtl: 21600 }).catch(() => {});
    }
    const curatedWithCounts = curatedBase.map((rm) => {
      const c = curatedCounts.get(rm.id);
      return c !== undefined ? { ...rm, participantCount: c, count: c } : rm;
    });
    const merged = [...pub, ...curatedWithCounts];
    return edgeJson({ rooms: merged });
  }
  if (safePath === "/api/rooms/create") {
    return await handleEdgeRoomCreate(request, env, edgeJson);
  }
  const roomActMatch = safePath.match(/^\/api\/(?:rooms|rave\/meshes)\/([^/]+)\/(sync|poll|action)$/);
  if (roomActMatch) {
    const rid = decodeURIComponent(roomActMatch[1]);
    const actKind = roomActMatch[2];
    if (actKind === "action" && request.method !== "POST") {
      return edgeJson({ ok: false, error: "Method Not Allowed" }, 405);
    }
    if ((actKind === "sync" || actKind === "poll") && request.method !== "GET" && request.method !== "POST") {
      return edgeJson({ ok: false, error: "Method Not Allowed" }, 405);
    }
    return await handleEdgeRoomSync(rid, request, env, edgeJson, _curatedMap, {
      defaultAction: actKind === "poll" ? "poll" : undefined,
    });
  }
  const roomInfoMatch = safePath.match(/^\/api\/(?:rooms|rave\/meshes)\/([^/]+)(?:\/info)?$/);
  if (roomInfoMatch && (request.method === "GET" || request.method === "HEAD")) {
    return await handleEdgeRoomInfo(decodeURIComponent(roomInfoMatch[1]), request, env, edgeJson, _curatedMap);
  }

  // 7. Durable DO/KV-backed Auth & Per-User Lists
  if ((safePath === "/api/auth/register" || safePath === "/api/auth/login" || safePath === "/api/auth/oauth") && request.method === "POST") {
    const ip = (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim();
    const bucket = Math.floor(Date.now() / 60000);
    const ipHash = (await sha256Hex(ip)).slice(0, 16);
    const rlKey = `${ipHash}:${bucket}`;
    if (_authRateLimitMap.size > 2000) {
      for (const k of _authRateLimitMap.keys()) {
        if (!k.endsWith(`:${bucket}`)) _authRateLimitMap.delete(k);
        if (_authRateLimitMap.size <= 1000) break;
      }
    }
    const attempts = Number(_authRateLimitMap.get(rlKey) || 0);
    if (attempts >= 30) {
      return edgeJson({ ok: false, error: "Çok fazla deneme. Lütfen bir dakika sonra tekrar deneyin." }, 429);
    }
    _authRateLimitMap.set(rlKey, attempts + 1);
  }
  if (safePath === "/api/auth/me" && request.method !== "DELETE") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    if (authRes.user) return edgeJson({ ok: true, authenticated: true, user: normalizeMemberUserObj(authRes.user) });
    if (authRes.isGuest) return edgeJson({ ok: true, authenticated: false, user: null });
    if (authRes.invalidToken) return edgeJson({ ok: false, authenticated: false, user: null, error: "invalid_session" }, 401);
    return edgeJson({ ok: true, authenticated: false, user: null });
  }
  if (safePath === "/api/auth/export" && request.method === "GET") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    if (!authRes.user || !env?.WATCHLIVO_KV) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    const email = String(authRes.user.email || "").toLowerCase();
    const uid = String(authRes.user.uid || authRes.user.id || "");
    const [acctRes, socRes, progRes, wlRes, mhRes, ytpRes, prefsRes] = await Promise.all([
      email ? kvReadStrict(env.WATCHLIVO_KV, `acct:${email}`, "json") : Promise.resolve({ value: null, storageError: false }),
      kvReadStrict(env.WATCHLIVO_KV, `soc:u:${uid}`, "json"),
      kvReadStrict(env.WATCHLIVO_KV, `ulist:${uid}:progress`, "json"),
      kvReadStrict(env.WATCHLIVO_KV, `ulist:${uid}:watchlist`, "json"),
      kvReadStrict(env.WATCHLIVO_KV, `ulist:${uid}:music-history`, "json"),
      kvReadStrict(env.WATCHLIVO_KV, `ulist:${uid}:ytprefs`, "json"),
      kvReadStrict(env.WATCHLIVO_KV, `ulist:${uid}:prefs`, "json"),
    ]);
    if (acctRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    const safeUser = acctRes.value?.user ? normalizeMemberUserObj(acctRes.value.user, email) : normalizeMemberUserObj(authRes.user, email);
    if (acctRes.value && !acctRes.value.passHash && safeUser) safeUser.passwordSet = false;
    return edgeJson({
      ok: true,
      exportedAt: new Date().toISOString(),
      schemaVersion: "1.0",
      user: safeUser,
      preferences: prefsRes.value && typeof prefsRes.value === "object" ? prefsRes.value : {},
      social: socRes.value && typeof socRes.value === "object" ? socRes.value : null,
      progress: Array.isArray(progRes.value) ? progRes.value : (progRes.value?.items || []),
      watchlist: Array.isArray(wlRes.value) ? wlRes.value : (wlRes.value?.items || []),
      musicHistory: Array.isArray(mhRes.value) ? mhRes.value : (mhRes.value?.items || []),
      ytPrefs: ytpRes.value && typeof ytpRes.value === "object" ? ytpRes.value : defaultYtPrefs(),
    });
  }
  if (safePath === "/api/auth/sessions" && request.method === "GET") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    if (!authRes.user || !env?.WATCHLIVO_KV) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    const email = String(authRes.user.email || "").toLowerCase();
    const uid = String(authRes.user.uid || authRes.user.id || "");
    const [acctRes, sessListRes] = await Promise.all([
      email ? kvReadStrict(env.WATCHLIVO_KV, `acct:${email}`, "json") : Promise.resolve({ value: null, storageError: false }),
      kvReadStrict(env.WATCHLIVO_KV, `acct_sessions:${uid}`, "json"),
    ]);
    if (acctRes.storageError || sessListRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const currentSv = Number(acctRes.value?.sv || 0);
    const nowS = Math.floor(Date.now() / 1000);
    let currentSessionId = "";
    let curClaims = null;
    if (authRes.token && authRes.token.startsWith("wl2.")) {
      curClaims = await verifyMemberSessionToken(authRes.token, env);
      currentSessionId = String(curClaims?.jti || "");
    }
    if (!currentSessionId && authRes.token) {
      currentSessionId = (await sha256Hex(authRes.token)).slice(0, 12);
    }
    const rawList = Array.isArray(sessListRes.value) ? sessListRes.value : [];
    const active = rawList
      .filter((s) => s && typeof s === "object" && Number(s.sv || 0) === currentSv && Number(s.exp || 0) > nowS)
      .map((s) => ({
        id: String(s.id || ""),
        device: String(s.device || "Web Tarayıcı"),
        userAgent: String(s.userAgent || ""),
        authProvider: String(s.authProvider || authRes.user.authProvider || "email"),
        issuedAt: Number(s.issuedAt || 0),
        lastUsedAt: Number(s.lastUsedAt || s.issuedAt || nowS),
        exp: Number(s.exp || 0),
        current: Boolean(currentSessionId && s.id === currentSessionId),
      }));
    if (currentSessionId && !active.some((s) => s.id === currentSessionId)) {
      const ua = String(request.headers.get("User-Agent") || "").slice(0, 180);
      active.unshift({
        id: currentSessionId,
        device: parseSessionDeviceLabel(ua),
        userAgent: ua,
        authProvider: String(curClaims?.authProvider || authRes.user.authProvider || "email"),
        issuedAt: curClaims ? Math.max(0, Number(curClaims.exp || 0) - 2592000) : nowS,
        lastUsedAt: nowS,
        exp: Number(curClaims?.exp || nowS + 2592000),
        current: true,
      });
    }
    return edgeJson({ ok: true, sessions: active, currentSessionId });
  }
  if (safePath === "/api/auth/register" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const pass = String(b.password || "");
    if (!email || !email.includes("@") || pass.length < 6) return edgeJson({ ok: false, error: "Geçerli e-posta ve en az 6 karakterli şifre girin." }, 400);
    const existing = await env.WATCHLIVO_KV.get(`acct:${email}`, "json");
    if (existing) return edgeJson({ ok: false, error: "Bu e-posta zaten kayıtlı." }, 409);
    const uid = `u_${(await sha256Hex(email)).slice(0, 14)}`;
    const passHash = await hashPasswordPbkdf2(pass);
    const displayName = cleanStr(b.name || b.username || email.split("@")[0], 40) || "Kullanıcı";
    const rawHandle = cleanStr(b.handle || "", 32);
    let cleanH = "";
    if (rawHandle) {
      cleanH = foldHandleBase(rawHandle);
      if (cleanH.length < 2) {
        return edgeJson({ ok: false, error: "Kullanıcı adı en az 2 geçerli harf veya rakam içermelidir." }, 400);
      }
      const hOwner = await env.WATCHLIVO_KV.get(`acct_handle:${cleanH}`).catch(() => null);
      const sOwner = await env.WATCHLIVO_KV.get(`soc:handle:${cleanH}`).catch(() => null);
      if ((hOwner && hOwner !== email) || (sOwner && sOwner !== uid)) {
        return edgeJson({ ok: false, error: `Bu kullanıcı adı (@${cleanH}) zaten kullanımda.` }, 409);
      }
    } else {
      const baseH = normalizeHandle("", displayName);
      const hOwner = await env.WATCHLIVO_KV.get(`acct_handle:${baseH}`).catch(() => null);
      const sOwner = await env.WATCHLIVO_KV.get(`soc:handle:${baseH}`).catch(() => null);
      cleanH = (hOwner && hOwner !== email) || (sOwner && sOwner !== uid) ? `${baseH.slice(0, 17)}_${uid.slice(-5)}` : baseH;
    }
    const user = normalizeMemberUserObj({
      id: uid,
      uid,
      email,
      name: displayName,
      username: displayName,
      handle: cleanH,
      color: sanitizeColor(b.color),
      avatarUrl: "",
      bio: "",
      statusText: "",
      statusEmoji: "🍿",
      hideWatching: false,
      hideFriends: false,
      hideLocation: false,
      authProvider: "email",
      verified: true,
      passwordSet: true,
      isGuest: false,
    }, email);
    await env.WATCHLIVO_KV.delete(`deleted_acct:${email}`).catch(() => {});
    await env.WATCHLIVO_KV.put(`acct:${email}`, JSON.stringify({ user, passHash })).catch(() => {});
    await env.WATCHLIVO_KV.put(`acct_handle:${cleanH}`, email).catch(() => {});
    const nameKey = normalizeSearchText(displayName);
    if (nameKey && !(await env.WATCHLIVO_KV.get(`acct_name:${nameKey}`).catch(() => null))) {
      await env.WATCHLIVO_KV.put(`acct_name:${nameKey}`, email).catch(() => {});
    }
    await upsertSocialDir(env, user);
    await ensureUserSocial(env, uid, user, true);
    const authToken = await issueAuthSessionToken(user, 0, env, request);
    return edgeJson({ ok: true, authToken, user }, 200, {
      "Set-Cookie": `wl_auth=${encodeURIComponent(authToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  if (safePath === "/api/auth/login" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    const rawIdent = String(b.identifier || b.email || b.handle || b.username || "").trim().toLowerCase();
    const pass = String(b.password || "");
    if (!rawIdent || !pass) return edgeJson({ ok: false, error: "E-posta/kullanıcı adı ve şifre gerekli." }, 400);
    const { email: ident, rec } = await findAccountByIdent(env, rawIdent);
    if (!rec || !ident || !(await verifyPasswordHash(pass, ident, rec.passHash))) {
      return edgeJson({ ok: false, error: "E-posta veya şifre hatalı." }, 401);
    }
    const normUser = normalizeMemberUserObj(rec.user, ident);
    if (!rec.passHash && normUser) normUser.passwordSet = false;
    let needUpdate = !rec.user?.handle || rec.user?.isGuest !== false;
    let nextHash = rec.passHash;
    if (!String(rec.passHash || "").startsWith("pbkdf2_v1$")) {
      nextHash = await hashPasswordPbkdf2(pass);
      needUpdate = true;
    }
    if (needUpdate) {
      await env.WATCHLIVO_KV.put(`acct:${ident}`, JSON.stringify({ user: normUser, passHash: nextHash, sv: Number(rec.sv || 0) })).catch(() => {});
    }
    if (normUser.handle) {
      await env.WATCHLIVO_KV.put(`acct_handle:${normUser.handle}`, ident).catch(() => {});
    }
    await upsertSocialDir(env, normUser);
    const authToken = await issueAuthSessionToken(normUser, Number(rec.sv || 0), env, request);
    return edgeJson({ ok: true, authToken, user: normUser }, 200, {
      "Set-Cookie": `wl_auth=${encodeURIComponent(authToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  if (safePath === "/api/auth/oauth" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    const idToken = String(b.idToken || "").trim();
    const provider = String(b.provider || "google").trim().toLowerCase() || "google";
    if (!idToken) {
      return edgeJson({ ok: false, error: "Giriş doğrulanamadı. Lütfen sağlayıcı penceresinden giriş yapın." }, 401);
    }
    let fbEmail = "";
    let fbName = "";
    const fbApiKey = env?.FIREBASE_WEB_API_KEY || DEFAULT_FB_API_KEY;
    try {
      const fbResp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(fbApiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(7500),
      });
      if (fbResp.ok) {
        const fbData = await fbResp.json().catch(() => ({}));
        const u0 = Array.isArray(fbData?.users) ? fbData.users[0] : null;
        if (u0) {
          const hasGoogleProv = Array.isArray(u0.providerUserInfo) && u0.providerUserInfo.some((p) => p?.providerId === "google.com" && p?.email);
          if (u0.email && (u0.emailVerified === true || hasGoogleProv)) {
            fbEmail = String(u0.email).trim().toLowerCase();
          }
          fbName = String(u0.displayName || "").trim().slice(0, 40);
          const fbPhone = String(u0.phoneNumber || "").replace(/[^\d+]/g, "");
          if (!fbEmail && fbPhone) {
            const digits = fbPhone.replace(/^\+/, "");
            fbEmail = `p${digits}@phone.watchlivo.online`;
            if (!fbName) fbName = `Üye ${digits.slice(-4)}`;
          }
        }
      }
    } catch {}
    if (!fbEmail && provider === "google") {
      try {
        const gResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
          headers: { "User-Agent": "WatchlivoAuth/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (gResp.ok) {
          const gInfo = await gResp.json().catch(() => ({}));
          const aud = String(gInfo?.aud || "").trim();
          const extraAuds = String(env?.GOOGLE_OAUTH_CLIENT_IDS || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
          const audOk =
            aud === "watchlivo-38ab6" ||
            (aud.startsWith("1034129375158-") && aud.endsWith(".apps.googleusercontent.com")) ||
            extraAuds.includes(aud);
          if (audOk && gInfo?.email && (gInfo.email_verified === true || String(gInfo.email_verified).toLowerCase() === "true")) {
            fbEmail = String(gInfo.email).trim().toLowerCase();
            fbName = String(gInfo.name || gInfo.given_name || "").trim().slice(0, 40);
          }
        }
      } catch {}
    }
    if (!fbEmail) {
      return edgeJson({ ok: false, error: "Google oturumu doğrulanamadı. Oturum süresi dolmuş veya geçersiz." }, 401);
    }
    const expectedEmail = String(b.email || "").trim().toLowerCase();
    if (expectedEmail && expectedEmail.includes("@") && expectedEmail !== fbEmail) {
      return edgeJson({ ok: false, error: `Yazdığınız e-posta (${expectedEmail}) ile seçilen Google hesabı (${fbEmail}) eşleşmiyor.` }, 401);
    }
    let rec = await env.WATCHLIVO_KV.get(`acct:${fbEmail}`, "json").catch(() => null);
    let user = rec?.user ? normalizeMemberUserObj(rec.user, fbEmail) : null;
    if (rec && !rec.passHash && user) user.passwordSet = false;
    if (!user) {
      const uid = `u_${(await sha256Hex(fbEmail)).slice(0, 14)}`;
      const displayName = (fbName || String(b.name || "").trim() || fbEmail.split("@")[0] || "Kullanıcı").slice(0, 40);
      const baseH = normalizeHandle("", displayName) || uid.slice(2, 10);
      const hOwner = await env.WATCHLIVO_KV.get(`acct_handle:${baseH}`).catch(() => null);
      const handleBase = hOwner && hOwner !== fbEmail ? `${baseH.slice(0, 17)}_${uid.slice(-5)}` : baseH;
      user = normalizeMemberUserObj({
        id: uid,
        uid,
        email: fbEmail,
        name: displayName,
        username: displayName,
        handle: handleBase,
        color: sanitizeColor(b.color),
        authProvider: provider,
        verified: true,
        passwordSet: false,
        isGuest: false,
      }, fbEmail);
      const pass = String(b.password || "");
      const passHash = pass.length >= 6 ? await hashPasswordPbkdf2(pass) : "";
      if (passHash) user.passwordSet = true;
      await env.WATCHLIVO_KV.delete(`deleted_acct:${fbEmail}`).catch(() => {});
      await env.WATCHLIVO_KV.put(`acct:${fbEmail}`, JSON.stringify({ user, passHash, sv: 0 })).catch(() => {});
      await env.WATCHLIVO_KV.put(`acct_handle:${handleBase}`, fbEmail).catch(() => {});
      const nameKey = normalizeSearchText(displayName);
      if (nameKey && !(await env.WATCHLIVO_KV.get(`acct_name:${nameKey}`).catch(() => null))) {
        await env.WATCHLIVO_KV.put(`acct_name:${nameKey}`, fbEmail).catch(() => {});
      }
    } else if (!rec?.passHash && String(b.password || "").length >= 6) {
      const passHash = await hashPasswordPbkdf2(String(b.password));
      user.passwordSet = true;
      await env.WATCHLIVO_KV.put(`acct:${fbEmail}`, JSON.stringify({ user, passHash, sv: Number(rec?.sv || 0) })).catch(() => {});
    }
    await upsertSocialDir(env, user);
    await ensureUserSocial(env, user.uid, user, true);
    const authToken = await issueAuthSessionToken(user, Number(rec?.sv || 0), env, request);
    return edgeJson({ ok: true, authToken, user }, 200, {
      "Set-Cookie": `wl_auth=${encodeURIComponent(authToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  if (safePath === "/api/auth/logout") {
    const b = request.method === "POST" ? await request.json().catch(() => ({})) : null;
    const tok = extractSessionToken(request, b);
    if (tok && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.delete(`session:${tok}`).catch(() => {});
      if (tok.startsWith("wl2.")) {
        const revKey = `revoked:${(await sha256Hex(tok)).slice(0, 24)}`;
        await env.WATCHLIVO_KV.put(revKey, "1", { expirationTtl: 2592000 }).catch(() => {});
        const claims = await verifyMemberSessionToken(tok, env);
        if (claims?.uid && claims?.jti) {
          const sessKey = `acct_sessions:${claims.uid}`;
          const existing = await env.WATCHLIVO_KV.get(sessKey, "json").catch(() => null);
          if (Array.isArray(existing)) {
            const pruned = existing.filter((s) => s && s.id !== claims.jti);
            await env.WATCHLIVO_KV.put(sessKey, JSON.stringify(pruned), { expirationTtl: 2592000 }).catch(() => {});
          }
        }
      }
    }
    return edgeJson({ ok: true }, 200, {
      "Set-Cookie": "wl_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    });
  }
  if (
    safePath === "/api/auth/delete" ||
    safePath === "/api/auth/account/delete" ||
    (safePath === "/api/auth/account" && request.method === "DELETE") ||
    (safePath === "/api/auth/me" && request.method === "DELETE") ||
    (safePath === "/api/auth/profile" && request.method === "DELETE")
  ) {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return edgeJson({ ok: false, error: "Bu işlem için POST veya DELETE gereklidir." }, 405, { Allow: "POST, DELETE" });
    }
    const b = await request.json().catch(() => ({}));
    const authRes = await resolveMemberUser(request, env, b);
    if (authRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const { user, token } = authRes;
    if (!user || !env?.WATCHLIVO_KV) {
      return edgeJson({ ok: false, error: "Oturum doğrulanamadı." }, 401);
    }
    const email = String(user.email || "").toLowerCase();
    const recRes = email ? await kvReadStrict(env.WATCHLIVO_KV, `acct:${email}`, "json") : { value: null, storageError: false };
    if (recRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const rec = recRes.value;
    if (!rec) return edgeJson({ ok: false, error: "Hesap bulunamadı." }, 401);
    if (rec.passHash) {
      const suppliedPw = String(b?.password || "");
      if (!suppliedPw || !(await verifyPasswordHash(suppliedPw, email, rec.passHash))) {
        return edgeJson({ ok: false, error: "Hesap silme işlemi için mevcut şifrenizi doğrulamalısınız." }, 401);
      }
    } else if (b?.confirmDelete !== true) {
      return edgeJson({ ok: false, error: "Şifresiz hesap silme işlemi için confirmDelete: true onayı gereklidir." }, 400);
    }
    const uid = String(rec.user?.uid || rec.user?.id || user.uid || user.id);
    const oldH = foldHandleBase(rec.user?.handle || user.handle || "");
    const oldNameKey = normalizeSearchText(rec.user?.name || user.name || "");
    await Promise.allSettled([
      email ? env.WATCHLIVO_KV.put(`deleted_acct:${email}`, String(Math.floor(Date.now() / 1000)), { expirationTtl: 2592000 }) : Promise.resolve(),
      email ? env.WATCHLIVO_KV.delete(`acct:${email}`) : Promise.resolve(),
      oldH ? env.WATCHLIVO_KV.delete(`acct_handle:${oldH}`) : Promise.resolve(),
      oldNameKey ? env.WATCHLIVO_KV.delete(`acct_name:${oldNameKey}`) : Promise.resolve(),
      token ? env.WATCHLIVO_KV.delete(`session:${token}`) : Promise.resolve(),
      token && token.startsWith("wl2.") ? env.WATCHLIVO_KV.put(`revoked:${(await sha256Hex(token)).slice(0, 24)}`, "1", { expirationTtl: 2592000 }) : Promise.resolve(),
      env.WATCHLIVO_KV.delete(`acct_sessions:${uid}`),
      env.WATCHLIVO_KV.delete(`ulist:${uid}:progress`),
      env.WATCHLIVO_KV.delete(`ulist:${uid}:watchlist`),
      env.WATCHLIVO_KV.delete(`ulist:${uid}:music-history`),
      env.WATCHLIVO_KV.delete(`ulist:${uid}:ytprefs`),
      env.WATCHLIVO_KV.delete(`ulist:${uid}:prefs`),
      env.WATCHLIVO_KV.delete(`soc:u:${uid}`),
      env.WATCHLIVO_KV.delete(`soc:pres:${uid}`),
      removeSocialDir(env, uid),
    ]);
    return edgeJson({ ok: true, deleted: true, message: "Hesabınız kalıcı olarak silindi." }, 200, {
      "Set-Cookie": "wl_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    });
  }
  if (safePath === "/api/auth/profile" && request.method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return edgeJson({ ok: false, error: "Geçersiz veri." }, 400);
    const authRes = await resolveMemberUser(request, env, b);
    if (authRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const { user, token } = authRes;
    if (!user || !env?.WATCHLIVO_KV) {
      return edgeJson({ ok: false, error: "Oturum doğrulanamadı. Lütfen tekrar giriş yapın." }, 401);
    }
    const email = String(user.email || "").toLowerCase();
    const recRes = email ? await kvReadStrict(env.WATCHLIVO_KV, `acct:${email}`, "json") : { value: null, storageError: false };
    if (recRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const rec = recRes.value;
    if (!rec?.user) return edgeJson({ ok: false, error: "Hesap bulunamadı. Lütfen tekrar giriş yapın." }, 401);
    const curUser = normalizeMemberUserObj(rec.user, email);
    if (!rec.passHash && curUser) curUser.passwordSet = false;
    if (b.name !== undefined && b.name !== null) {
      const nextName = cleanStr(b.name, 24);
      if (nextName.length < 2) return edgeJson({ ok: false, error: "Görünen ad en az 2 karakter olmalıdır." }, 400);
      curUser.name = nextName;
      curUser.username = nextName;
    }
    const oldHandle = curUser.handle;
    if (typeof b.handle === "string" && b.handle.trim()) {
      const nextH = foldHandleBase(b.handle);
      if (nextH.length < 2) {
        return edgeJson({ ok: false, error: "Kullanıcı adı en az 2 geçerli harf veya rakam içermelidir." }, 400);
      }
      const hOwner = await env.WATCHLIVO_KV.get(`acct_handle:${nextH}`).catch(() => null);
      if (hOwner && hOwner !== email) {
        return edgeJson({ ok: false, error: `Bu kullanıcı adı (@${nextH}) zaten kullanımda.` }, 409);
      }
      curUser.handle = nextH;
    }
    if (b.color !== undefined) curUser.color = sanitizeColor(b.color);
    if ("avatarUrl" in b) {
      const av = sanitizeAvatarUrl(b.avatarUrl);
      if (av === "__INVALID__") {
        return edgeJson({ ok: false, error: "Geçersiz profil görseli formatı (yalnızca 45 KB altı PNG/JPEG/WebP/GIF veya HTTPS görsel kabul edilir)." }, 400);
      }
      curUser.avatarUrl = av;
    }
    if ("bio" in b) curUser.bio = cleanStr(b.bio, 160);
    if ("statusText" in b) curUser.statusText = cleanStr(b.statusText, 60);
    if ("statusEmoji" in b) curUser.statusEmoji = cleanStr(b.statusEmoji || "🍿", 12) || "🍿";
    if ("hideWatching" in b) curUser.hideWatching = Boolean(b.hideWatching);
    if ("hideFriends" in b) curUser.hideFriends = Boolean(b.hideFriends);
    if ("hideLocation" in b) curUser.hideLocation = Boolean(b.hideLocation);

    await env.WATCHLIVO_KV.put(`acct:${email}`, JSON.stringify({ user: curUser, passHash: rec.passHash || "", sv: Number(rec.sv || 0) })).catch(() => {});
    if (curUser.handle && curUser.handle !== oldHandle) {
      if (oldHandle) await env.WATCHLIVO_KV.delete(`acct_handle:${oldHandle}`).catch(() => {});
      await env.WATCHLIVO_KV.put(`acct_handle:${curUser.handle}`, email).catch(() => {});
    }
    const oldNameKeyP = normalizeSearchText(rec.user?.name || "");
    const newNameKeyP = normalizeSearchText(curUser.name || "");
    if (oldNameKeyP && newNameKeyP && oldNameKeyP !== newNameKeyP) {
      const mappedOld = await env.WATCHLIVO_KV.get(`acct_name:${oldNameKeyP}`).catch(() => null);
      if (mappedOld === email) await env.WATCHLIVO_KV.delete(`acct_name:${oldNameKeyP}`).catch(() => {});
      const mappedNew = await env.WATCHLIVO_KV.get(`acct_name:${newNameKeyP}`).catch(() => null);
      if (!mappedNew) await env.WATCHLIVO_KV.put(`acct_name:${newNameKeyP}`, email).catch(() => {});
    }
    if (token) {
      await env.WATCHLIVO_KV.put(`session:${token}`, JSON.stringify({ ...curUser, _sv: Number(rec.sv || 0) }), { expirationTtl: 2592000 }).catch(() => {});
    }
    await upsertSocialDir(env, curUser);
    await ensureUserSocial(env, curUser.uid, curUser, true);
    return edgeJson({ ok: true, user: curUser, authToken: token });
  }
  if ((safePath === "/api/auth/password" || safePath === "/api/auth/change-password") && (request.method === "POST" || request.method === "PUT")) {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return edgeJson({ ok: false, error: "Geçersiz veri." }, 400);
    const authRes = await resolveMemberUser(request, env, b);
    if (authRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const { user, token } = authRes;
    if (!user || !env?.WATCHLIVO_KV) {
      return edgeJson({ ok: false, error: "Oturum doğrulanamadı. Lütfen tekrar giriş yapın." }, 401);
    }
    const email = String(user.email || "").toLowerCase();
    const recRes = email ? await kvReadStrict(env.WATCHLIVO_KV, `acct:${email}`, "json") : { value: null, storageError: false };
    if (recRes.storageError) {
      return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    }
    const rec = recRes.value;
    if (!rec?.user) return edgeJson({ ok: false, error: "Hesap bulunamadı." }, 401);
    const curPw = String(b.currentPassword || b.oldPassword || "");
    const newPw = String(b.newPassword || b.password || "");
    if (newPw.length < 6) return edgeJson({ ok: false, error: "Yeni şifre en az 6 karakter olmalıdır." }, 400);
    if (rec.passHash) {
      if (!curPw || !(await verifyPasswordHash(curPw, email, rec.passHash))) {
        return edgeJson({ ok: false, error: "Mevcut şifreniz hatalı." }, 401);
      }
    }
    const newHash = await hashPasswordPbkdf2(newPw);
    const normUser = normalizeMemberUserObj({ ...rec.user, passwordSet: true }, email);
    const nextSv = Number(rec.sv || 0) + 1;
    await env.WATCHLIVO_KV.put(`acct:${email}`, JSON.stringify({ user: normUser, passHash: newHash, sv: nextSv })).catch(() => {});
    if (token) {
      await env.WATCHLIVO_KV.delete(`session:${token}`).catch(() => {});
      if (token.startsWith("wl2.")) {
        await env.WATCHLIVO_KV.put(`revoked:${(await sha256Hex(token)).slice(0, 24)}`, "1", { expirationTtl: 2592000 }).catch(() => {});
      }
    }
    await env.WATCHLIVO_KV.delete(`acct_sessions:${normUser.uid}`).catch(() => {});
    const newTok = await issueAuthSessionToken(normUser, nextSv, env, request);
    return edgeJson({ ok: true, user: normUser, authToken: newTok, message: "Şifreniz başarıyla güncellendi." }, 200, {
      "Set-Cookie": `wl_auth=${encodeURIComponent(newTok)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  if ((safePath === "/api/auth/email-action" || safePath === "/api/auth/reset-password") && request.method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return edgeJson({ ok: false, error: "Geçersiz istek." }, 400);
    const action = String(b.action || (safePath === "/api/auth/reset-password" ? "reset_password" : "")).trim().toLowerCase();
    const fbApiKey = env?.FIREBASE_WEB_API_KEY || DEFAULT_FB_API_KEY;
    const callFb = async (ep, payload) => {
      try {
        const r = await fetch(`https://identitytoolkit.googleapis.com/v1/${ep}?key=${encodeURIComponent(fbApiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
        const j = await r.json().catch(() => null);
        return r.ok ? j : null;
      } catch {
        return null;
      }
    };
    if (action === "verify_reset_code" || action === "confirm_reset_password") {
      const oobCode = String(b.oobCode || b.code || "").trim().slice(0, 256);
      const newPw = String(b.newPassword || b.password || "");
      if (!oobCode) return edgeJson({ ok: false, error: "Sıfırlama kodu zorunludur." }, 400);
      if (newPw.length < 6) return edgeJson({ ok: false, error: "Yeni şifre en az 6 karakter olmalıdır." }, 400);
      const res = await callFb("accounts:resetPassword", { oobCode, newPassword: newPw });
      const rstEmail = String(res?.email || "").trim().toLowerCase();
      if (!rstEmail || !rstEmail.includes("@")) {
        return edgeJson({ ok: false, error: "Şifre sıfırlama kodu geçersiz veya süresi dolmuş." }, 401);
      }
      if (env?.WATCHLIVO_KV) {
        const rec = await env.WATCHLIVO_KV.get(`acct:${rstEmail}`, "json").catch(() => null);
        if (rec?.user) {
          const newHash = await hashPasswordPbkdf2(newPw);
          const normUser = normalizeMemberUserObj({ ...rec.user, passwordSet: true }, rstEmail);
          await env.WATCHLIVO_KV.put(`acct:${rstEmail}`, JSON.stringify({ user: normUser, passHash: newHash, sv: Number(rec.sv || 0) + 1 })).catch(() => {});
        }
      }
      return edgeJson({ ok: true, message: "Şifreniz başarıyla güncellendi. Yeni şifrenizle giriş yapabilirsiniz." });
    }
    const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return edgeJson({ ok: false, error: "Lütfen geçerli bir e-posta adresi girin." }, 400);
    }
    if (action === "reset_password") {
      const existing = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`acct:${email}`, "json").catch(() => null) : null;
      if (!existing) {
        return edgeJson({ ok: true, message: `Eğer ${email} adresine bağlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi.` });
      }
      await callFb("accounts:signUp", { email, password: `Wl!${makeNonce()}${makeNonce()}`, returnSecureToken: true });
      const res = await callFb("accounts:sendOobCode", { requestType: "PASSWORD_RESET", email });
      if (res?.email) {
        return edgeJson({ ok: true, message: `Şifre sıfırlama bağlantısı ${email} adresine gönderildi.` });
      }
      return edgeJson({ ok: false, error: "Sıfırlama e-postası gönderilemedi. Lütfen adresi kontrol edin." }, 400);
    }
    if (action === "magic_link") {
      const rawOrigin = String(b.origin || "https://watchlivo.online").replace(/\/+$/, "");
      const contUrl = `${rawOrigin}/?magic_email=${encodeURIComponent(email)}`;
      const res = await callFb("accounts:sendOobCode", {
        requestType: "EMAIL_SIGNIN",
        email,
        continueUrl: contUrl,
        canHandleCodeInApp: true,
      });
      if (res?.email) {
        return edgeJson({ ok: true, message: `Giriş bağlantısı ${email} adresine gönderildi (Gelen Kutusu / Spam kontrol edin).` });
      }
      return edgeJson({ ok: false, error: "E-posta bağlantısı gönderilemedi." }, 400);
    }
    if (action === "complete_magic_link") {
      const oobCode = String(b.oobCode || "").trim();
      if (!oobCode) return edgeJson({ ok: false, error: "Geçersiz giriş kodu." }, 400);
      const res = await callFb("accounts:signInWithEmailLink", { email, oobCode });
      if (!res?.idToken) {
        return edgeJson({ ok: false, error: "E-posta bağlantısı süresi dolmuş veya geçersiz." }, 401);
      }
      let rec = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`acct:${email}`, "json").catch(() => null) : null;
      let user = rec?.user ? normalizeMemberUserObj(rec.user, email) : null;
      if (!user) {
        const uid = `u_${(await sha256Hex(email)).slice(0, 14)}`;
        const name = email.split("@")[0].slice(0, 24) || "Kullanıcı";
        const h = normalizeHandle("", name);
        user = normalizeMemberUserObj({ id: uid, uid, email, name, handle: h, authProvider: "email", verified: true, passwordSet: false, isGuest: false }, email);
        if (env?.WATCHLIVO_KV) {
          await env.WATCHLIVO_KV.put(`acct:${email}`, JSON.stringify({ user, passHash: "" })).catch(() => {});
          await env.WATCHLIVO_KV.put(`acct_handle:${h}`, email).catch(() => {});
        }
      }
      await upsertSocialDir(env, user);
      const authToken = await issueAuthSessionToken(user, Number(rec?.sv || 0), env, request);
      return edgeJson({ ok: true, user, authToken }, 200, {
        "Set-Cookie": `wl_auth=${encodeURIComponent(authToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      });
    }
    return edgeJson({ ok: false, error: "Bilinmeyen işlem." }, 400);
  }
  if (safePath === "/api/user/preferences") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    const { user } = authRes;
    if (!user) return edgeJson({ ok: false, authenticated: false, error: "Oturum gerekli." }, 401);
    const prefKey = `ulist:${user.uid || user.id}:prefs`;
    const defaultUserPrefs = {
      theme: "dark",
      ambient: false,
      density: "comfortable",
      cardStyle: "poster",
      subSize: "md",
      subColor: "#ffffff",
      subDual: false,
      subOffsetSec: 0,
      subLang: "tr",
      audioLang: "tr",
      voiceDucking: true,
      notifSoundMuted: false,
      danmaku: true,
      ambilight: false,
      brightness: 100,
      videoFit: "contain",
      updatedAt: 0,
    };
    const readPrefsRes = env?.WATCHLIVO_KV ? await kvReadStrict(env.WATCHLIVO_KV, prefKey, "json") : { value: null, storageError: false };
    if (readPrefsRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    const curPrefs = { ...defaultUserPrefs, ...(readPrefsRes.value && typeof readPrefsRes.value === "object" && !Array.isArray(readPrefsRes.value) ? readPrefsRes.value : {}) };
    if (request.method === "GET") {
      return edgeJson({ ok: true, authenticated: true, uid: user.uid || user.id, preferences: curPrefs });
    }
    if (request.method !== "PUT" && request.method !== "POST") {
      return edgeJson({ ok: false, error: "Method Not Allowed" }, 405);
    }
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      return edgeJson({ ok: false, error: "Geçersiz tercih verisi." }, 400);
    }
    const inc = b.preferences && typeof b.preferences === "object" && !Array.isArray(b.preferences) ? b.preferences : b;
    const nextPrefs = { ...curPrefs };
    if ("theme" in inc) nextPrefs.theme = cleanStr(inc.theme || "dark", 24) || "dark";
    if ("ambient" in inc) nextPrefs.ambient = Boolean(inc.ambient);
    if ("density" in inc) nextPrefs.density = cleanStr(inc.density || "comfortable", 24) || "comfortable";
    if ("cardStyle" in inc) nextPrefs.cardStyle = cleanStr(inc.cardStyle || "poster", 24) || "poster";
    if ("subSize" in inc) nextPrefs.subSize = cleanStr(inc.subSize || "md", 16) || "md";
    if ("subColor" in inc) nextPrefs.subColor = /^#[0-9a-fA-F]{3,8}$/.test(String(inc.subColor || "").trim()) ? String(inc.subColor).trim() : curPrefs.subColor;
    if ("subDual" in inc) nextPrefs.subDual = Boolean(inc.subDual);
    if ("subOffsetSec" in inc) nextPrefs.subOffsetSec = Math.max(-120, Math.min(120, Number(inc.subOffsetSec || 0) || 0));
    if ("subLang" in inc) nextPrefs.subLang = cleanStr(inc.subLang || "tr", 12) || "tr";
    if ("audioLang" in inc) nextPrefs.audioLang = cleanStr(inc.audioLang || "tr", 12) || "tr";
    if ("voiceDucking" in inc) nextPrefs.voiceDucking = Boolean(inc.voiceDucking);
    if ("notifSoundMuted" in inc) nextPrefs.notifSoundMuted = Boolean(inc.notifSoundMuted);
    if ("danmaku" in inc) nextPrefs.danmaku = Boolean(inc.danmaku);
    if ("ambilight" in inc) nextPrefs.ambilight = Boolean(inc.ambilight);
    if ("brightness" in inc) nextPrefs.brightness = Math.max(0, Math.min(200, Number(inc.brightness ?? 100) || 0));
    if ("videoFit" in inc) nextPrefs.videoFit = cleanStr(inc.videoFit || "contain", 16) || "contain";
    nextPrefs.updatedAt = Math.floor(Date.now() / 1000);
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(prefKey, JSON.stringify(nextPrefs)).catch(() => {});
    }
    return edgeJson({ ok: true, authenticated: true, uid: user.uid || user.id, preferences: nextPrefs });
  }
  if (safePath === "/api/user/watch-minutes" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const authRes = await resolveMemberUser(request, env, b);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    const { user } = authRes;
    if (!user) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    const delta = Math.max(1, Math.min(60, Math.floor(Number(b?.minutes || 1) || 1)));
    const u = await ensureUserSocial(env, user.uid || user.id, user, true);
    u.watchMinutes = Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0)) + delta;
    u.medal = computeWatchMedal(u.watchMinutes);
    await saveUserSocial(env, u);
    if (user.email) {
      await syncAccountWatchMinutes(env, user.email, u.watchMinutes);
    }
    return edgeJson({ ok: true, uid: user.uid || user.id, watchMinutes: u.watchMinutes, medal: u.medal });
  }
  if (safePath === "/api/user/progress" || safePath === "/api/user/watchlist" || safePath === "/api/user/music-history") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    const { user } = authRes;
    if (!user) return edgeJson({ ok: false, authenticated: false, error: "Oturum gerekli." }, 401);
    const kvKey = `ulist:${user.id}:${safePath.split("/").pop()}`;
    const readList = async () => {
      if (!env?.WATCHLIVO_KV) return [];
      const raw = await env.WATCHLIVO_KV.get(kvKey, "json").catch(() => null);
      if (Array.isArray(raw)) return raw;
      if (raw && Array.isArray(raw.items)) return raw.items;
      return [];
    };
    const writeListSafe = async (arr) => {
      if (!env?.WATCHLIVO_KV) return true;
      const serialized = JSON.stringify(arr);
      try {
        await env.WATCHLIVO_KV.put(kvKey, serialized);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 260));
        try {
          await env.WATCHLIVO_KV.put(kvKey, serialized);
          return true;
        } catch {
          return false;
        }
      }
    };
    if (request.method === "GET") {
      const items = await readList();
      return edgeJson({ ok: true, authenticated: true, uid: user.id, items });
    }
    const body = await request.json().catch(() => ({}));
    if (body.action === "clear") {
      const saved = await writeListSafe([]);
      return edgeJson({ ok: true, authenticated: true, uid: user.id, items: [], ...(saved ? {} : { kvBusy: true }) });
    }
    const cur = await readList();
    const mergeEntry = (list, rawItem) => {
      if (!rawItem || typeof rawItem !== "object") return list;
      const itemKey = String(rawItem.key || rawItem.videoId || rawItem.tmdbId || Date.now());
      const prev = list.find((x) => x && String(x.key || x.videoId || x.tmdbId) === itemKey);
      const mergedEp = (prev?.epProgress || rawItem?.epProgress)
        ? { ...(prev?.epProgress || {}), ...(rawItem?.epProgress || {}) }
        : undefined;
      const nextItem = { ...prev, ...rawItem, key: itemKey, ...(mergedEp ? { epProgress: mergedEp } : {}) };
      return [nextItem, ...list.filter((x) => x && String(x.key || x.videoId || x.tmdbId) !== itemKey)].slice(0, 100);
    };
    let next = cur;
    if (body.action === "bulk_upsert" && Array.isArray(body.items)) {
      for (const rawIt of body.items.slice(0, 30).reverse()) {
        next = mergeEntry(next, rawIt);
      }
    } else if (body.action === "remove") {
      const item = body.item || body;
      const itemKey = String(item.key || item.videoId || item.tmdbId || "");
      next = cur.filter((x) => x && String(x.key || x.videoId || x.tmdbId) !== itemKey);
    } else {
      next = mergeEntry(cur, body.item || body);
    }
    const saved = await writeListSafe(next);
    return edgeJson({ ok: true, authenticated: true, uid: user.id, items: next, ...(saved ? {} : { kvBusy: true }) });
  }
  if (safePath === "/api/user/yt-preferences") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "Depolama servisi geçici olarak kullanılamıyor.", storageError: true }, 503);
    const { user } = authRes;
    if (!user) {
      return edgeJson({ ok: false, authenticated: false, uid: "", prefs: defaultYtPrefs() }, 401);
    }
    const kvKey = `ulist:${user.id}:ytprefs`;
    let prefs = (env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(kvKey, "json").catch(() => null) : null) || defaultYtPrefs();
    prefs = { ...defaultYtPrefs(), ...prefs };
    if (request.method === "GET") {
      return edgeJson({ ok: true, authenticated: true, uid: user.id, prefs });
    }
    const b = await request.json().catch(() => ({}));
    const action = cleanStr(b.action || "sync", 32).toLowerCase();
    const nowS = Math.floor(Date.now() / 1000);
    let importedStats = {};
    if (action === "reset") {
      prefs = defaultYtPrefs();
    } else if (action === "follow_channel" || action === "unfollow_channel" || action === "toggle_channel") {
      const ch = b.channel && typeof b.channel === "object" ? b.channel : b;
      const cid = cleanStr(ch.channelId || "", 48);
      const cname = cleanStr(ch.name || ch.channel || "", 100);
      if (cid || cname) {
        const subs = Array.isArray(prefs.subscriptions) ? prefs.subscriptions : [];
        const existed = subs.some((s) => (cid && s.channelId === cid) || (cname && String(s.name || "").toLowerCase() === cname.toLowerCase()));
        const nextSubs = subs.filter((s) => !((cid && s.channelId === cid) || (cname && String(s.name || "").toLowerCase() === cname.toLowerCase())));
        if (action === "follow_channel" || (action === "toggle_channel" && !existed)) {
          nextSubs.unshift({
            channelId: cid,
            name: cname || cid,
            avatar: cleanStr(ch.avatar || ch.channelAvatar || "", 800),
            handle: cleanStr(ch.handle || "", 64),
            addedAt: nowS,
          });
        }
        prefs.subscriptions = nextSubs.slice(0, 60);
      }
    } else if (action === "like_video" || action === "unlike_video" || action === "toggle_like") {
      const lv = b.video && typeof b.video === "object" ? b.video : b;
      const vid = cleanStr(lv.videoId || "", 20);
      if (vid) {
        const likes = Array.isArray(prefs.likedVideos) ? prefs.likedVideos : [];
        const existed = likes.some((x) => x.videoId === vid);
        const nextLikes = likes.filter((x) => x.videoId !== vid);
        if (action === "like_video" || (action === "toggle_like" && !existed)) {
          nextLikes.unshift({
            videoId: vid,
            title: cleanStr(lv.title || "", 160) || "YouTube Videosu",
            channel: cleanStr(lv.channel || "", 100) || "YouTube",
            channelId: cleanStr(lv.channelId || "", 48),
            channelAvatar: cleanStr(lv.channelAvatar || "", 800),
            thumbnail: cleanStr(lv.thumbnail || "", 800) || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            duration: Math.max(0, Math.min(86400, Number(lv.duration || 0) || 0)),
            likedAt: nowS,
          });
        }
        prefs.likedVideos = nextLikes.slice(0, 80);
      }
    } else if (action === "dismiss_video") {
      const vid = cleanStr(b.videoId || "", 24);
      if (vid) prefs.dismissedVideoIds = [vid, ...(prefs.dismissedVideoIds || []).filter((x) => x !== vid)].slice(0, 200);
    } else if (action === "undo_dismiss") {
      const vid = cleanStr(b.videoId || "", 24);
      prefs.dismissedVideoIds = (prefs.dismissedVideoIds || []).filter((x) => x !== vid);
    } else if (action === "block_channel") {
      const bch = cleanStr(b.channelId || b.channel || b.name || "", 100);
      if (bch) prefs.blockedChannels = [bch, ...(prefs.blockedChannels || []).filter((x) => x.toLowerCase() !== bch.toLowerCase())].slice(0, 80);
    } else if (action === "unblock_channel") {
      const bch = cleanStr(b.channelId || b.channel || b.name || "", 100);
      prefs.blockedChannels = (prefs.blockedChannels || []).filter((x) => x.toLowerCase() !== bch.toLowerCase());
    } else if (action === "add_search") {
      const q = cleanStr(b.query || b.q || "", 100);
      if (q.length >= 2) prefs.searchHistory = [q, ...(prefs.searchHistory || []).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 25);
    } else if (action === "import_oauth") {
      prefs.googleConnected = Boolean(b.googleConnected ?? true);
      if (b.googleEmail) prefs.googleEmail = cleanStr(b.googleEmail, 120);
      if (b.googleChannelTitle) prefs.googleChannelTitle = cleanStr(b.googleChannelTitle, 100);
      importedStats = { importedSubs: 0, importedLikes: 0, oauthOk: true };
    } else {
      const inc = b.prefs && typeof b.prefs === "object" ? b.prefs : b;
      for (const k of ["subscriptions", "likedVideos", "searchHistory", "dismissedVideoIds", "blockedChannels", "topics"]) {
        if (Array.isArray(inc[k])) prefs[k] = inc[k].slice(0, 100);
      }
      if ("googleConnected" in inc) prefs.googleConnected = Boolean(inc.googleConnected);
      if (inc.googleEmail) prefs.googleEmail = cleanStr(inc.googleEmail, 120);
      if (inc.googleChannelTitle) prefs.googleChannelTitle = cleanStr(inc.googleChannelTitle, 100);
    }
    prefs.updatedAt = nowS;
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(kvKey, JSON.stringify(prefs), { expirationTtl: 2592000 }).catch(() => {});
    }
    return edgeJson({ ok: true, authenticated: true, uid: user.id, prefs, ...importedStats });
  }

  const musicResp = await handleEdgeMusicRoute(request, url, safePath, env);
  if (musicResp) {
    return musicResp;
  }

  // 8. F3 / F4a / F4b Autonomous Edge Routes
  if (safePath === "/api/rave/ga-collect" || safePath.startsWith("/api/rave/ga-collect/")) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Cache-Control": "no-store",
        },
      });
    }
    const lowP = safePath.toLowerCase();
    const secDest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
    if (lowP.includes("sw_iframe") || lowP.includes("service_worker") || lowP.endsWith(".html") || secDest === "iframe" || secDest === "document") {
      return new Response("<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": "inline" },
      });
    }
    const qs = url.search ? url.search.slice(1, 4096) : "";
    const ua = request.headers.get("User-Agent") || EDGE_UA;
    const ip = (request.headers.get("CF-Connecting-IP") || "").trim();
    const relayUrl = `https://www.google-analytics.com/g/collect?${qs}${ip && !qs.includes("_uip=") ? `${qs ? "&" : ""}_uip=${encodeURIComponent(ip)}` : ""}`;
    const bodyBuf = request.method === "POST" ? await request.arrayBuffer().catch(() => null) : null;
    const relayTask = fetch(relayUrl, {
      method: request.method === "POST" ? "POST" : "GET",
      headers: { "User-Agent": ua },
      body: bodyBuf && bodyBuf.byteLength ? bodyBuf.slice(0, 32768) : undefined,
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    ctx?.waitUntil?.(relayTask);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Watchlivo-Origin": "cf-autonomous-edge" },
    });
  }

  if (safePath === "/api/rave/social/guest" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid || b?.id, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    const reuseCallerGuest = Boolean(caller.authenticated && caller.isGuest === true);
    let uid = reuseCallerGuest ? caller.uid : cleanStr(b?.uid || b?.id, 64);
    if (
      !uid ||
      uid === "guest_default" ||
      uid === "guest_local" ||
      (!reuseCallerGuest && (!GUEST_UID_RE.test(uid) || (await isGuestUidClaimed(env, uid))))
    ) {
      uid = makeGuestUid();
    }
    const name = cleanStr(b?.name, 32) || "Misafir";
    let rawHandle = cleanStr(b?.handle, 32);
    const color = sanitizeColor(b?.color);
    const avatarUrl = safeAvatarForCard(b?.avatarUrl);
    const strictHandle = b?.strictHandle === true;
    const explicitHandleProvided = Boolean(rawHandle);
    let candH = explicitHandleProvided ? foldHandleBase(rawHandle) : normalizeHandle("", name);
    if (explicitHandleProvided && candH.length < 2) {
      return edgeJson({ ok: false, error: "Kullanıcı adı en az 2 geçerli harf veya rakam içermelidir." }, 400);
    }
    if (candH.length >= 2) {
      const dir = await getSocialDir(env);
      const isHandleTaken = async (h) => {
        if (env?.WATCHLIVO_KV) {
          const regEmail = await env.WATCHLIVO_KV.get(`acct_handle:${h}`).catch(() => null);
          if (regEmail) {
            const regAcct = await env.WATCHLIVO_KV.get(`acct:${regEmail}`, "json").catch(() => null);
            if (regAcct?.user?.uid && regAcct.user.uid !== uid) return { taken: true, registered: true };
          }
          const socHandleUid = await env.WATCHLIVO_KV.get(`soc:handle:${h}`).catch(() => null);
          if (socHandleUid && socHandleUid !== uid) return { taken: true, registered: false };
        }
        for (const [dUid, dCard] of Object.entries(dir)) {
          if (!dUid || dUid === uid || !dCard) continue;
          if (foldHandleBase(dCard.handle || "") === h) return { taken: true, registered: false };
        }
        return { taken: false, registered: false };
      };
      const chk = await isHandleTaken(candH);
      if (chk.taken) {
        if (explicitHandleProvided && strictHandle && (chk.registered || !/^(?:misafir|guest)[a-z0-9_.-]{0,14}$/i.test(candH))) {
          return edgeJson({
            ok: false,
            error: chk.registered
              ? `Bu kullanıcı adı (@${candH}) kayıtlı bir üyeye ait.`
              : `Bu kullanıcı adı (@${candH}) zaten kullanımda.`,
          }, 409);
        }
        const uidSuf = uid.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-6) || makeNonce().slice(0, 4).toLowerCase();
        let recH = `${candH.slice(0, 15)}_${uidSuf}`;
        const chk2 = await isHandleTaken(recH);
        if (chk2.taken) {
          recH = `${candH.slice(0, 12)}_${makeNonce().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6)}`;
        }
        candH = recH;
        rawHandle = recH;
      }
    }
    const u = await ensureUserSocial(env, uid, {
      name,
      handle: rawHandle,
      color,
      avatarUrl,
      bio: b?.bio,
      statusText: b?.statusText,
      statusEmoji: b?.statusEmoji,
      hideWatching: b?.hideWatching,
    }, true);
    const cleanH = normalizeHandle(u.handle || rawHandle, name);
    const nowS = Math.floor(Date.now() / 1000);
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`soc:pres:${uid}`, JSON.stringify({
        uid,
        state: "online",
        lastSeen: nowS,
        visibility: u.privacy?.presenceVisibility || "friends",
        hideWatching: Boolean(u.privacy?.hideWatching),
      }), { expirationTtl: 180 }).catch(() => {});
    }
    const isGuest = uid.startsWith("guest_");
    const guestToken = isGuest ? `gst_${uid}_${makeNonce()}${makeNonce()}` : "";
    const guestUser = {
      uid,
      id: uid,
      name: u.name || name,
      handle: cleanH,
      color: u.color || color,
      avatarUrl: u.avatarUrl || avatarUrl,
      isGuest,
      ...(guestToken ? { guestToken } : {}),
    };
    if (guestToken && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`session:${guestToken}`, JSON.stringify({ ...guestUser, isGuest: true }), { expirationTtl: 2592000 }).catch(() => {});
      await env.WATCHLIVO_KV.put(`soc:gclaim:${uid.toLowerCase()}`, "1", { expirationTtl: 2592000 }).catch(() => {});
    }
    await upsertSocialDir(env, { ...guestUser, isGuest });
    return edgeJson({
      ok: true,
      uid,
      name: guestUser.name,
      handle: cleanH,
      color: guestUser.color,
      isGuest,
      authToken: guestToken,
      guestToken,
      user: guestUser,
    });
  }

  if (safePath === "/api/rave/social/claim-guest" && request.method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      return edgeJson({ ok: false, error: "Geçersiz JSON verisi." }, 400);
    }
    const authRes = await resolveMemberUser(request, env, b);
    if (authRes.storageError) {
      return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    }
    const { user } = authRes;
    if (!user) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    const guestUid = cleanStr(b.guestUid, 64);
    if (!guestUid || !GUEST_UID_RE.test(guestUid) || guestUid === "guest_default" || guestUid === "guest_local") {
      return edgeJson({ ok: false, error: "Geçerli bir misafir kimliği (guestUid) gerekli." }, 400);
    }
    const memberUid = String(user.uid || user.id || "");
    const gClaimKey = `soc:gclaim:${guestUid.toLowerCase()}`;
    const [gClaimRes, gSocRes] = env?.WATCHLIVO_KV
      ? await Promise.all([
          kvReadStrict(env.WATCHLIVO_KV, gClaimKey),
          kvReadStrict(env.WATCHLIVO_KV, `soc:u:${guestUid}`, "json"),
        ])
      : [{ value: null, storageError: false }, { value: null, storageError: false }];
    if (gClaimRes.storageError || gSocRes.storageError) {
      return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    }
    const gClaimVal = gClaimRes.value;
    const gSoc = gSocRes.value;
    if (gClaimVal && String(gClaimVal).startsWith("claimed:")) {
      if (gClaimVal !== `claimed:${memberUid}`) {
        return edgeJson({ ok: false, error: "Bu misafir profili başka bir hesap tarafından devralınmış." }, 409);
      }
      const mSocAlready = await ensureUserSocial(env, memberUid, user, false);
      return edgeJson({
        ok: true,
        claimed: true,
        alreadyClaimed: true,
        guestUid,
        uid: memberUid,
        watchMinutes: mSocAlready.watchMinutes || 0,
        medal: mSocAlready.medal || computeWatchMedal(mSocAlready.watchMinutes),
        mergedFriends: 0,
        user: normalizeMemberUserObj(user),
      });
    }
    const guestToken = cleanStr(b.guestToken, 240);
    if (gClaimVal === "1" || Boolean(gSoc && typeof gSoc === "object")) {
      const gSessRes = guestToken && env?.WATCHLIVO_KV ? await kvReadStrict(env.WATCHLIVO_KV, `session:${guestToken}`, "json") : { value: null, storageError: false };
      if (gSessRes.storageError) {
        return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
      }
      const gSess = gSessRes.value;
      if (!gSess || String(gSess.uid || gSess.id || "") !== guestUid) {
        return edgeJson({ ok: false, error: "Misafir oturum doğrulaması geçersiz." }, 403);
      }
    }

    const mSoc = await ensureUserSocial(env, memberUid, user, true);
    let mergedFriends = 0;
    if (gSoc && typeof gSoc === "object") {
      mSoc.watchMinutes = Math.max(0, Math.floor(Number(mSoc.watchMinutes || 0) || 0)) + Math.max(0, Math.floor(Number(gSoc.watchMinutes || 0) || 0));
      mSoc.medal = computeWatchMedal(mSoc.watchMinutes);
      const friendSet = new Set((mSoc.friends || []).map((f) => f?.uid).filter(Boolean));
      for (const fr of Array.isArray(gSoc.friends) ? gSoc.friends : []) {
        const fUid = cleanStr(fr?.uid, 64);
        if (!fUid || fUid === memberUid || fUid === guestUid) continue;
        if (!friendSet.has(fUid)) {
          friendSet.add(fUid);
          mSoc.friends.push(fr);
          mergedFriends += 1;
        }
        // Rewrite peer social friend record & migrate DM thread
        if (env?.WATCHLIVO_KV) {
          const pU = await env.WATCHLIVO_KV.get(`soc:u:${fUid}`, "json").catch(() => null);
          if (pU && typeof pU === "object") {
            const pFriends = Array.isArray(pU.friends) ? pU.friends : [];
            const alreadyPeer = pFriends.some((pf) => pf?.uid === memberUid);
            pU.friends = pFriends
              .filter((pf) => !(alreadyPeer && pf?.uid === guestUid))
              .map((pf) => (pf?.uid === guestUid ? { ...pf, uid: memberUid, name: mSoc.name, handle: mSoc.handle, color: mSoc.color, avatarUrl: mSoc.avatarUrl } : pf));
            await saveUserSocial(env, pU);
          }
          const oldTk = dmThreadKey(guestUid, fUid);
          const newTk = dmThreadKey(memberUid, fUid);
          if (oldTk !== newTk) {
            const oldMsgs = await env.WATCHLIVO_KV.get(`soc:dm:${oldTk}`, "json").catch(() => null);
            if (Array.isArray(oldMsgs) && oldMsgs.length) {
              const curMsgs = (await env.WATCHLIVO_KV.get(`soc:dm:${newTk}`, "json").catch(() => null)) || [];
              const seenMsgIds = new Set((Array.isArray(curMsgs) ? curMsgs : []).map((m) => m?.id).filter(Boolean));
              const combined = [...(Array.isArray(curMsgs) ? curMsgs : [])];
              for (const m of oldMsgs) {
                if (!m || (m.id && seenMsgIds.has(m.id))) continue;
                combined.push(m.fromUid === guestUid ? { ...m, fromUid: memberUid, fromName: mSoc.name } : m);
              }
              combined.sort((a, b2) => Number(a?.ts || 0) - Number(b2?.ts || 0));
              await env.WATCHLIVO_KV.put(`soc:dm:${newTk}`, JSON.stringify(combined.slice(-100)), { expirationTtl: 2592000 }).catch(() => {});
              await env.WATCHLIVO_KV.delete(`soc:dm:${oldTk}`).catch(() => {});
            }
          }
        }
      }
      const reqSet = new Set((mSoc.requests || []).map((r) => r?.fromUid).filter(Boolean));
      for (const rq of Array.isArray(gSoc.requests) ? gSoc.requests : []) {
        if (rq?.fromUid && rq.fromUid !== memberUid && !reqSet.has(rq.fromUid) && !friendSet.has(rq.fromUid)) {
          reqSet.add(rq.fromUid);
          mSoc.requests.push(rq);
        }
      }
      const outSet = new Set((mSoc.outgoingRequests || []).map((r) => r?.toUid).filter(Boolean));
      for (const rq of Array.isArray(gSoc.outgoingRequests) ? gSoc.outgoingRequests : []) {
        if (rq?.toUid && rq.toUid !== memberUid && !outSet.has(rq.toUid) && !friendSet.has(rq.toUid)) {
          outSet.add(rq.toUid);
          mSoc.outgoingRequests.push(rq);
        }
      }
      const blkSet = new Set((mSoc.blocked || []).map((x) => x?.uid).filter(Boolean));
      for (const bl of Array.isArray(gSoc.blocked) ? gSoc.blocked : []) {
        if (bl?.uid && bl.uid !== memberUid && !blkSet.has(bl.uid)) {
          blkSet.add(bl.uid);
          mSoc.blocked.push(bl);
        }
      }
      if (gSoc.unread && typeof gSoc.unread === "object") {
        for (const [k, v] of Object.entries(gSoc.unread)) {
          mSoc.unread[k] = Math.max(0, Number(mSoc.unread[k] || 0) || 0) + Math.max(0, Number(v || 0) || 0);
        }
      }
      await saveUserSocial(env, mSoc);
    }

    const mergeUserList = async (suffix, incoming) => {
      if (!Array.isArray(incoming) || !incoming.length || !env?.WATCHLIVO_KV) return;
      const listKey = `ulist:${memberUid}:${suffix}`;
      const raw = await env.WATCHLIVO_KV.get(listKey, "json").catch(() => null);
      const cur = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
      const seenK = new Set(cur.map((x) => String(x?.key || x?.videoId || x?.tmdbId || x?.id || "")).filter(Boolean));
      const merged = [...cur];
      for (const it of incoming.slice(0, 50)) {
        if (!it || typeof it !== "object") continue;
        const ik = String(it.key || it.videoId || it.tmdbId || it.id || "");
        if (!ik || seenK.has(ik)) continue;
        seenK.add(ik);
        merged.push({ ...it, key: ik });
      }
      await env.WATCHLIVO_KV.put(listKey, JSON.stringify(merged.slice(0, 100))).catch(() => {});
    };
    await Promise.all([
      mergeUserList("progress", b.progress),
      mergeUserList("watchlist", b.watchlist),
      mergeUserList("music-history", b.musicHistory),
    ]);

    if (env?.WATCHLIVO_KV) {
      await Promise.allSettled([
        env.WATCHLIVO_KV.put(gClaimKey, `claimed:${memberUid}`, { expirationTtl: 2592000 }),
        env.WATCHLIVO_KV.delete(`soc:u:${guestUid}`),
        env.WATCHLIVO_KV.delete(`soc:pres:${guestUid}`),
        guestToken ? env.WATCHLIVO_KV.delete(`session:${guestToken}`) : Promise.resolve(),
        removeSocialDir(env, guestUid),
      ]);
    }
    if (user.email) {
      await syncAccountWatchMinutes(env, user.email, mSoc.watchMinutes || 0);
    }
    const updatedUser = normalizeMemberUserObj({ ...user, watchMinutes: mSoc.watchMinutes || 0, medal: mSoc.medal || computeWatchMedal(mSoc.watchMinutes) }, user.email);
    return edgeJson({
      ok: true,
      claimed: true,
      guestUid,
      uid: memberUid,
      watchMinutes: updatedUser.watchMinutes,
      medal: updatedUser.medal,
      mergedFriends,
      user: updatedUser,
    });
  }

  if (safePath === "/api/rave/notifications/poll") {
    const caller = await resolveSocialCaller(request, env, url.searchParams.get("uid"));
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid.toLowerCase();
    const nowS = Math.floor(Date.now() / 1000);
    const since = Number(url.searchParams.get("since")) || (nowS - 30);
    const keys = uid && uid !== "guest_default" ? [uid] : [uid, "*"];
    const out = [];
    const seenIds = new Set();
    if (env?.WATCHLIVO_KV) {
      for (const k of keys) {
        const items = (await env.WATCHLIVO_KV.get(`soc:ntf:${k}`, "json").catch(() => null)) || [];
        for (const it of Array.isArray(items) ? items : []) {
          if (!it?.id || seenIds.has(it.id)) continue;
          const expAt = Number(it.expiresAt || 0);
          if (expAt > 0 && expAt < nowS) continue;
          if (Number(it.ts || 0) <= since) continue;
          if (String(it.fromUid || "").toLowerCase() === uid && uid !== "guest_default") continue;
          seenIds.add(it.id);
          out.push(it);
        }
      }
    }
    out.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const uRec = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`soc:u:${caller.uid}`, "json").catch(() => null) : null;
    const reqCnt = Array.isArray(uRec?.requests) ? uRec.requests.length : 0;
    const unrCnt = Object.values(uRec?.unread || {}).reduce((acc, v) => acc + Math.max(0, Number(v) || 0), 0);
    return edgeJson({
      ok: true,
      notifications: out.slice(-12),
      requestCount: reqCnt,
      totalUnread: unrCnt,
      serverTs: nowS,
      mode: "cf-autonomous-edge",
    });
  }

  if (safePath === "/api/rave/notifications/subscribe" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid || b?.name, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid.toLowerCase();
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`soc:push:${uid}`, JSON.stringify({
        uid,
        name: cleanStr(b?.name, 32),
        subscription: b?.subscription && typeof b.subscription === "object" ? b.subscription : {},
        updatedAt: Math.floor(Date.now() / 1000),
      }), { expirationTtl: 2592000 }).catch(() => {});
    }
    return edgeJson({ ok: true, subscribed: true, uid });
  }

  if (safePath === "/api/rave/notifications/send" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const rawFrom = cleanStr(b?.fromUid || b?.uid, 64).toLowerCase();
    const caller = await resolveSocialCaller(request, env, rawFrom, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    if (!caller.authenticated || caller.uid === "guest_default") {
      return edgeJson({ ok: false, error: "Oturum doğrulaması gerekli." }, 401);
    }
    const senderUid = caller.uid;
    const fromName = cleanStr(b?.fromName || b?.sender || "Arkadaşın", 40);
    const roomId = cleanStr(b?.roomId, 80);
    const roomTitle = cleanStr(b?.roomTitle || "Sinema Odası", 120);
    const targetUid = cleanStr(b?.targetUid, 64).toLowerCase();
    if (!targetUid) return edgeJson({ ok: false, error: "Geçerli bir hedef kullanıcı belirtilmelidir." }, 400);
    const rawUrl = String(b?.url || "").trim().slice(0, 16000);
    const ntfUrl = (rawUrl.startsWith("/#/") || rawUrl === "/") ? rawUrl : (roomId ? `/#/mesh/${encodeURIComponent(roomId)}` : "/#/");
    const title = cleanStr(b?.title || `🎬 ${fromName} seni odaya çağırıyor!`, 120);
    const msgBody = cleanStr(b?.body || `"${roomTitle}" odası şu an canlı. Tek tıkla katıl!`, 240);
    const nowS = Math.floor(Date.now() / 1000);
    if (targetUid === "*") {
      const senderU = await ensureUserSocial(env, senderUid, { name: fromName }, false);
      let delivered = 0;
      for (const fr of (senderU.friends || []).slice(0, 50)) {
        const fUid = cleanStr(fr?.uid || fr, 64).toLowerCase();
        if (fUid && fUid !== senderUid.toLowerCase()) {
          await queueSocialNotification(env, fUid, {
            type: cleanStr(b?.type || "room_invite", 32),
            title,
            body: msgBody,
            fromUid: senderUid,
            fromName,
            roomId,
            url: ntfUrl,
            expiresAt: nowS + 1800,
          });
          delivered++;
        }
      }
      return edgeJson({ ok: true, broadcast: true, sentCount: delivered });
    }
    if (targetUid.startsWith("u_")) {
      if (!caller.authenticated || senderUid === "guest_default") {
        return edgeJson({ ok: false, error: "Oturum doğrulaması gerekli." }, 401);
      }
      const senderU = await ensureUserSocial(env, senderUid, { name: fromName }, false);
      if (getFriendshipState(senderU, targetUid) !== "FRIENDS") {
        return edgeJson({ ok: false, error: "Yalnızca arkadaşlarınıza bildirim gönderebilirsiniz." }, 403);
      }
    }
    const item = await queueSocialNotification(env, targetUid, {
      type: cleanStr(b?.type || "room_invite", 32),
      title,
      body: msgBody,
      fromUid: senderUid,
      fromName,
      roomId,
      url: ntfUrl,
      expiresAt: nowS + 1800,
    });
    return edgeJson({ ok: true, notification: item, sentCount: 1 });
  }

  if (safePath === "/api/rave/social/state") {
    const caller = await resolveSocialCaller(request, env, url.searchParams.get("uid"));
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid;
    const u = await ensureUserSocial(env, uid, {
      name: url.searchParams.get("name"),
      handle: url.searchParams.get("handle"),
      color: url.searchParams.get("color"),
      avatarUrl: url.searchParams.get("avatarUrl"),
    }, false);
    const enrichedFriends = await Promise.all((u.friends || []).filter((f) => f && typeof f === "object").map((f) => enrichSocialFriend(env, f, uid)));
    const threads = [];
    let totalUnread = 0;
    const nowS = Math.floor(Date.now() / 1000);
    for (const fr of enrichedFriends) {
      const pUid = fr.uid;
      const tk = dmThreadKey(uid, pUid);
      const rawMsgs = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get(`soc:dm:${tk}`, "json").catch(() => null)) || [] : [];
      const msgs = (Array.isArray(rawMsgs) ? rawMsgs : []).filter((m) => !(Number(m?.expiryAt || 0) > 0 && Number(m.expiryAt) < nowS));
      const unr = Math.max(0, Number(u.unread?.[pUid] || 0) || 0);
      totalUnread += unr;
      threads.push({ peer: fr, lastMessage: msgs[msgs.length - 1] || null, unreadCount: unr, messageCount: msgs.length });
    }
    const onlineCount = enrichedFriends.filter((f) => f.online).length;
    const selfPresence = await computeLivePresence(env, uid, uid, true);
    return edgeJson({
      ok: true,
      uid,
      name: u.name || "İzleyici",
      handle: u.handle || "@izleyici",
      watchMinutes: Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0)),
      medal: u.medal || computeWatchMedal(u.watchMinutes),
      selfPresence,
      privacy: u.privacy || { presenceVisibility: "friends", hideWatching: false, allowInvites: "friends" },
      friends: enrichedFriends,
      onlineCount,
      requests: u.requests || [],
      requestCount: (u.requests || []).length,
      outgoingRequests: u.outgoingRequests || [],
      blocked: u.blocked || [],
      threads,
      totalUnread,
      mode: "cf-autonomous-edge",
    });
  }

  if (safePath === "/api/rave/social/presence") {
    if (request.method === "GET") {
      const caller = await resolveSocialCaller(request, env, url.searchParams.get("callerUid") || url.searchParams.get("uid"));
      if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
      if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
      let targetUid = cleanStr(url.searchParams.get("targetUid") || url.searchParams.get("uid") || caller.uid, 64);
      if (targetUid.startsWith("@") || (!targetUid.startsWith("u_") && !targetUid.startsWith("guest_"))) {
        const tc = await resolveSocialTarget(env, targetUid);
        if (tc?.uid) targetUid = tc.uid;
      }
      const targetU = await ensureUserSocial(env, targetUid, {}, false);
      const isFr = (targetU.friends || []).some((f) => String(f?.uid || "").toLowerCase() === caller.uid.toLowerCase());
      const pres = await computeLivePresence(env, targetUid, caller.uid, isFr);
      const card = { uid: targetUid, name: targetU.name || "İzleyici", handle: targetU.handle || "@izleyici", color: targetU.color || "#27DCC8", avatarUrl: targetU.avatarUrl || "", watchMinutes: targetU.watchMinutes || 0, medal: targetU.medal || computeWatchMedal(targetU.watchMinutes), ...pres };
      return edgeJson({ ok: true, uid: targetUid, presence: card, user: card, mode: "cf-autonomous-edge" });
    }
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid;
    const u = await ensureUserSocial(env, uid, {
      name: b?.name,
      handle: b?.handle,
      color: b?.color,
      avatarUrl: b?.avatarUrl,
      statusText: b?.statusText,
      statusEmoji: b?.statusEmoji,
      hideWatching: b?.hideWatching,
    }, true);
    const nowS = Math.floor(Date.now() / 1000);
    let rawSt = cleanStr(b?.state || "online", 16).toLowerCase();
    if (!["online", "watching", "idle", "offline"].includes(rawSt)) rawSt = "online";
    let vis = cleanStr(b?.visibility || u.privacy?.presenceVisibility || "friends", 16).toLowerCase();
    if (!["everyone", "friends", "nobody"].includes(vis)) vis = "friends";
    const hideW = "hideWatching" in b ? Boolean(b.hideWatching) : Boolean(u.privacy?.hideWatching);
    const prevPres = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`soc:pres:${uid}`, "json").catch(() => null) : null;
    if (rawSt === "watching") {
      if (prevPres?.state === "watching" && Number(prevPres.lastSeen || 0) > 0) {
        const elapsed = Math.max(0, Math.min(120, nowS - Number(prevPres.lastSeen)));
        u._watchSec = Math.max(0, Number(u._watchSec || 0)) + elapsed;
      }
      const extraMins = Math.max(0, Math.min(15, Number(b?.watchMinutesDelta || 0) || 0));
      if (extraMins > 0) {
        u._watchSec = Math.max(0, Number(u._watchSec || 0)) + extraMins * 60;
      }
      if (u._watchSec >= 60) {
        const addMins = Math.floor(u._watchSec / 60);
        u._watchSec = u._watchSec % 60;
        u.watchMinutes = Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0)) + addMins;
        u.medal = computeWatchMedal(u.watchMinutes);
        if (caller.user?.email) {
          await syncAccountWatchMinutes(env, caller.user.email, u.watchMinutes);
        }
      }
    }
    const rec = {
      uid,
      state: rawSt,
      lastSeen: nowS,
      roomId: (rawSt === "watching" || rawSt === "online") ? cleanStr(b?.roomId, 80) : "",
      roomName: cleanStr(b?.roomName, 100),
      roomPrivacy: cleanStr(b?.roomPrivacy || "public", 16),
      roomLocked: Boolean(b?.roomLocked || b?.hasPassword),
      mediaTitle: cleanStr(b?.mediaTitle || b?.watchingTitle, 140),
      watchingTitle: cleanStr(b?.watchingTitle || b?.mediaTitle, 140),
      mediaPoster: cleanStr(b?.mediaPoster, 800),
      mediaProvider: cleanStr(b?.mediaProvider, 32),
      statusText: cleanStr(b?.statusText, 60),
      statusEmoji: cleanStr(b?.statusEmoji || "🍿", 10),
      visibility: vis,
      hideWatching: hideW,
    };
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`soc:pres:${uid}`, JSON.stringify(rec), { expirationTtl: 180 }).catch(() => {});
    }
    u.lastSeen = nowS;
    await saveUserSocial(env, u);
    const pres = await computeLivePresence(env, uid, uid, true);
    return edgeJson({
      ok: true,
      uid,
      watchMinutes: Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0)),
      medal: u.medal || computeWatchMedal(u.watchMinutes),
      presence: { uid, name: u.name, handle: u.handle, color: u.color, avatarUrl: u.avatarUrl, ...pres },
      requestCount: (u.requests || []).length,
      totalUnread: Object.values(u.unread || {}).reduce((acc, v) => acc + Math.max(0, Number(v) || 0), 0),
      mode: "cf-autonomous-edge",
    });
  }

  if (safePath === "/api/rave/social/search") {
    const caller = await resolveSocialCaller(request, env, url.searchParams.get("uid"));
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid;
    const rawQ = cleanStr(url.searchParams.get("q") || url.searchParams.get("query"), 64);
    if (!rawQ) return edgeJson({ ok: true, users: [] });
    const u = await ensureUserSocial(env, uid, {}, false);
    const dir = await getSocialDir(env);
    const qFold = foldHandleBase(rawQ);
    const qNorm = normalizeSearchText(rawQ.replace(/^@+/, ""));
    const blockedSetU = new Set((u.blocked || []).map((b) => b?.uid));
    const found = [];
    for (const [dUid, card] of Object.entries(dir)) {
      if (!dUid || dUid === uid || dUid === "guest_default" || dUid === "guest_local" || !card) continue;
      if (card.isGuest && !caller.authenticated && !(rawQ.startsWith("@") && qFold && foldHandleBase(card.handle || "") === qFold)) continue;
      const hFold = foldHandleBase(card.handle || "");
      const nNorm = normalizeSearchText(card.name || "");
      if ((qFold && hFold.includes(qFold)) || (qNorm && (hFold.includes(qNorm) || nNorm.includes(qNorm)))) {
        const fstate = blockedSetU.has(dUid) ? "BLOCKED" : getFriendshipState(u, dUid);
        const pres = await computeLivePresence(env, dUid, uid, fstate === "FRIENDS");
        found.push({
          uid: dUid,
          name: cleanStr(card.name || "İzleyici", 32),
          handle: `@${normalizeHandle(card.handle || "", card.name || "izleyici")}`,
          color: sanitizeColor(card.color),
          avatarUrl: safeAvatarForCard(card.avatarUrl),
          bio: cleanStr(card.bio || "", 160),
          isGuest: Boolean(card.isGuest || dUid.startsWith("guest_")),
          friendshipState: fstate,
          online: pres.online,
          presenceState: pres.presenceState,
          status: pres.status,
          watchingRoom: pres.watchingRoom,
        });
      }
      if (found.length >= 20) break;
    }
    return edgeJson({ ok: true, users: found });
  }

  if (safePath === "/api/rave/social/friends" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid || b?.callerUid, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid;
    const u = await ensureUserSocial(env, uid, {
      name: cleanStr(b?.fromName || b?.name, 32) || "İzleyici",
      handle: b?.fromHandle || b?.handle,
      color: b?.color,
      avatarUrl: b?.avatarUrl,
    }, true);
    const action = cleanStr(b?.action, 24).toLowerCase();
    const nowS = Math.floor(Date.now() / 1000);
    const mkResp = async (extra = {}, st = 200) => {
      const ef = await Promise.all((u.friends || []).filter((f) => f && typeof f === "object").map((f) => enrichSocialFriend(env, f, uid)));
      return edgeJson({
        ok: st < 400,
        uid,
        friends: ef,
        requests: u.requests || [],
        requestCount: (u.requests || []).length,
        outgoingRequests: u.outgoingRequests || [],
        blocked: u.blocked || [],
        privacy: u.privacy || {},
        ...extra,
      }, st);
    };

    if (action === "request") {
      const rawIdent = cleanStr(b?.targetHandle || b?.targetEmail || b?.targetName || b?.target || b?.targetUid, 80);
      const tHint = cleanStr(b?.targetUid, 64);
      if (!rawIdent && !tHint) return mkResp({ error: "Kullanıcı adı (@handle) veya e-posta gerekli." }, 400);
      const targetCard = await resolveSocialTarget(env, rawIdent, tHint);
      if (!targetCard?.uid) return mkResp({ error: `"${rawIdent}" ile eşleşen kayıtlı bir Watchlivo hesabı bulunamadı.` }, 404);
      const targetUid = cleanStr(targetCard.uid, 64);
      if (targetUid === uid) return mkResp({ error: "Kendinize arkadaşlık isteği gönderemezsiniz." }, 400);
      const tU = await ensureUserSocial(env, targetUid, targetCard, true);
      if ((u.blocked || []).some((x) => x.uid === targetUid) || (tU.blocked || []).some((x) => x.uid === uid)) {
        return mkResp({ error: "Bu kullanıcı ile etkileşim engellenmiş." }, 403);
      }
      const existing = (u.friends || []).find((f) => f.uid === targetUid);
      if (existing) {
        return mkResp({ alreadyFriend: true, friendshipState: "FRIENDS", status: "FRIENDS", friend: await enrichSocialFriend(env, existing, uid) });
      }
      const incoming = (u.requests || []).find((r) => r.fromUid === targetUid);
      if (incoming) {
        u.requests = (u.requests || []).filter((r) => r.fromUid !== targetUid);
        tU.outgoingRequests = (tU.outgoingRequests || []).filter((r) => r.toUid !== uid);
        if (!(u.friends || []).some((f) => f.uid === targetUid)) {
          u.friends.unshift({ uid: targetUid, name: tU.name, handle: tU.handle, color: tU.color, avatarUrl: tU.avatarUrl, watchMinutes: 0, rankPill: "Onaylı Arkadaş", addedAt: nowS });
        }
        if (!(tU.friends || []).some((f) => f.uid === uid)) {
          tU.friends.unshift({ uid, name: u.name, handle: u.handle, color: u.color, avatarUrl: u.avatarUrl, watchMinutes: 0, rankPill: "Onaylı Arkadaş", addedAt: nowS });
        }
        await saveUserSocial(env, u);
        await saveUserSocial(env, tU);
        await queueSocialNotification(env, targetUid, {
          type: "friend_accepted",
          title: `🎉 ${u.name} arkadaşlık isteğini kabul etti!`,
          body: "Artık mesajlaşabilir ve odaya davet gönderebilirsiniz.",
          fromUid: uid,
          fromName: u.name,
          fromHandle: u.handle,
          fromColor: u.color,
          fromAvatarUrl: u.avatarUrl,
        });
        return mkResp({ mutualAccepted: true, friendshipState: "FRIENDS", status: "FRIENDS", friend: await enrichSocialFriend(env, u.friends[0], uid) });
      }
      if ((u.outgoingRequests || []).some((r) => r.toUid === targetUid)) {
        return mkResp({ pending: true, alreadyRequested: true, friendshipState: "OUTGOING_PENDING", status: "OUTGOING_PENDING", target: targetCard });
      }
      const reqId = `req_${makeNonce().slice(0, 10)}`;
      const outReq = { id: reqId, toUid: targetUid, toName: tU.name, toHandle: tU.handle, color: tU.color, avatarUrl: tU.avatarUrl, ts: nowS };
      const inReq = { id: reqId, fromUid: uid, fromName: u.name, fromHandle: u.handle, color: u.color, avatarUrl: u.avatarUrl, watchMinutes: 0, ts: nowS };
      u.outgoingRequests.unshift(outReq);
      tU.requests = [inReq, ...(tU.requests || []).filter((r) => r.fromUid !== uid)];
      await saveUserSocial(env, u);
      await saveUserSocial(env, tU);
      await queueSocialNotification(env, targetUid, {
        type: "friend_request",
        requestId: reqId,
        title: `👋 ${u.name} (${u.handle}) arkadaşlık isteği gönderdi`,
        body: "Mesajlaşmak ve odalara davet edebilmek için isteği onayla.",
        fromUid: uid,
        fromName: u.name,
        fromHandle: u.handle,
        fromColor: u.color,
        fromAvatarUrl: u.avatarUrl,
      });
      return mkResp({ pending: true, friendshipState: "OUTGOING_PENDING", status: "OUTGOING_PENDING", target: targetCard, request: outReq });
    }

    if (action === "accept" || action === "decline" || action === "reject") {
      let reqId = cleanStr(b?.requestId || b?.targetUid || b?.targetHandle || b?.target, 64);
      if (reqId && (reqId.startsWith("@") || (!reqId.startsWith("u_") && !reqId.startsWith("guest_") && !reqId.startsWith("req_")))) {
        const tc = await resolveSocialTarget(env, reqId);
        if (tc?.uid) reqId = tc.uid;
      }
      const targetReq = (u.requests || []).find((r) => r.id === reqId || r.fromUid === reqId || foldHandleBase(r.fromHandle || "") === foldHandleBase(reqId));
      if (!targetReq) return mkResp({ error: "İstek bulunamadı veya zaten işlendi." }, 404);
      const fromUid = cleanStr(targetReq.fromUid, 64);
      u.requests = (u.requests || []).filter((r) => r.id !== targetReq.id && r.fromUid !== fromUid);
      const sU = fromUid ? await ensureUserSocial(env, fromUid, { name: targetReq.fromName, handle: targetReq.fromHandle, color: targetReq.color, avatarUrl: targetReq.avatarUrl }, true) : null;
      if (sU) {
        sU.outgoingRequests = (sU.outgoingRequests || []).filter((r) => r.toUid !== uid && r.id !== targetReq.id);
      }
      if (action === "accept" && fromUid) {
        if (!(u.friends || []).some((f) => f.uid === fromUid)) {
          u.friends.unshift({ uid: fromUid, name: sU?.name || targetReq.fromName || "İzleyici", handle: sU?.handle || targetReq.fromHandle || "@izleyici", color: sU?.color || targetReq.color || "#F59E0B", avatarUrl: sU?.avatarUrl || targetReq.avatarUrl || "", watchMinutes: 0, rankPill: "Onaylı Arkadaş", addedAt: nowS });
        }
        if (sU && !(sU.friends || []).some((f) => f.uid === uid)) {
          sU.friends.unshift({ uid, name: u.name, handle: u.handle, color: u.color, avatarUrl: u.avatarUrl, watchMinutes: 0, rankPill: "Onaylı Arkadaş", addedAt: nowS });
        }
        await queueSocialNotification(env, fromUid, {
          type: "friend_accepted",
          title: `🎉 ${u.name} (${u.handle}) isteğini kabul etti!`,
          body: "Artık birbirinize mesaj gönderebilir ve odaya davet atabilirsiniz.",
          fromUid: uid,
          fromName: u.name,
          fromHandle: u.handle,
          fromColor: u.color,
          fromAvatarUrl: u.avatarUrl,
        });
      }
      await saveUserSocial(env, u);
      if (sU && fromUid) await saveUserSocial(env, sU);
      const st = action === "accept" ? "FRIENDS" : "NONE";
      return mkResp({ friendshipState: st, status: st });
    }

    if (action === "cancel") {
      let reqId = cleanStr(b?.requestId || b?.targetUid || b?.targetHandle || b?.target, 64);
      if (reqId && (reqId.startsWith("@") || (!reqId.startsWith("u_") && !reqId.startsWith("guest_") && !reqId.startsWith("req_")))) {
        const tc = await resolveSocialTarget(env, reqId);
        if (tc?.uid) reqId = tc.uid;
      }
      const hit = (u.outgoingRequests || []).find((r) => r.id === reqId || r.toUid === reqId || foldHandleBase(r.toHandle || "") === foldHandleBase(reqId));
      const hitUid = cleanStr(hit?.toUid || reqId, 64);
      u.outgoingRequests = (u.outgoingRequests || []).filter((r) => r.id !== reqId && r.toUid !== reqId && r.toUid !== hitUid);
      if (hitUid && (hitUid.startsWith("u_") || hitUid.startsWith("guest_"))) {
        const tU = await ensureUserSocial(env, hitUid, {}, true);
        tU.requests = (tU.requests || []).filter((r) => r.fromUid !== uid && (!hit || r.id !== hit.id));
        await saveUserSocial(env, tU);
      }
      await saveUserSocial(env, u);
      return mkResp({ friendshipState: "NONE" });
    }

    if (action === "remove") {
      let targetUid = cleanStr(b?.targetUid || b?.targetHandle || b?.target, 64);
      if (targetUid && (targetUid.startsWith("@") || (!targetUid.startsWith("u_") && !targetUid.startsWith("guest_")))) {
        const tc = await resolveSocialTarget(env, targetUid);
        if (tc?.uid) targetUid = tc.uid;
      }
      u.friends = (u.friends || []).filter((f) => f.uid !== targetUid && f.name !== targetUid && foldHandleBase(f.handle || "") !== foldHandleBase(targetUid));
      if (targetUid) {
        const tU = await ensureUserSocial(env, targetUid, {}, true);
        tU.friends = (tU.friends || []).filter((f) => f.uid !== uid);
        await saveUserSocial(env, tU);
      }
      await saveUserSocial(env, u);
      return mkResp({ friendshipState: "NONE" });
    }

    if (action === "toggle_best") {
      let targetUid = cleanStr(b?.targetUid || b?.targetHandle || b?.target, 64);
      if (targetUid && (targetUid.startsWith("@") || (!targetUid.startsWith("u_") && !targetUid.startsWith("guest_")))) {
        const tc = await resolveSocialTarget(env, targetUid);
        if (tc?.uid) targetUid = tc.uid;
      }
      for (const f of u.friends || []) {
        if (f.uid === targetUid) f.bestFriend = !Boolean(f.bestFriend);
      }
      await saveUserSocial(env, u);
      return mkResp();
    }

    if (action === "block" || action === "unblock") {
      let targetUid = cleanStr(b?.targetUid || b?.targetHandle || b?.target, 64);
      if (targetUid && (targetUid.startsWith("@") || (!targetUid.startsWith("u_") && !targetUid.startsWith("guest_")))) {
        const tc = await resolveSocialTarget(env, targetUid);
        if (tc?.uid) targetUid = tc.uid;
      }
      if (action === "block" && targetUid && targetUid !== uid) {
        u.friends = (u.friends || []).filter((f) => f.uid !== targetUid);
        u.requests = (u.requests || []).filter((r) => r.fromUid !== targetUid);
        u.outgoingRequests = (u.outgoingRequests || []).filter((r) => r.toUid !== targetUid);
        if (!(u.blocked || []).some((x) => x.uid === targetUid)) {
          u.blocked.push({ uid: targetUid, name: cleanStr(b?.targetName || targetUid, 32), ts: nowS });
        }
        const tU = await ensureUserSocial(env, targetUid, {}, true);
        tU.friends = (tU.friends || []).filter((f) => f.uid !== uid);
        tU.requests = (tU.requests || []).filter((r) => r.fromUid !== uid);
        tU.outgoingRequests = (tU.outgoingRequests || []).filter((r) => r.toUid !== uid);
        await saveUserSocial(env, tU);
      } else if (action === "unblock" && targetUid) {
        u.blocked = (u.blocked || []).filter((x) => x.uid !== targetUid && foldHandleBase(x.name || "") !== foldHandleBase(targetUid));
      }
      await saveUserSocial(env, u);
      return mkResp();
    }

    if (action === "privacy") {
      u.privacy = u.privacy || { presenceVisibility: "friends", hideWatching: false, allowInvites: "friends" };
      if (["everyone", "friends", "nobody"].includes(b?.presenceVisibility)) u.privacy.presenceVisibility = b.presenceVisibility;
      if ("hideWatching" in b) u.privacy.hideWatching = Boolean(b.hideWatching);
      if ("hideFriends" in b) u.privacy.hideFriends = Boolean(b.hideFriends);
      if ("hideLocation" in b) u.privacy.hideLocation = Boolean(b.hideLocation);
      if (["everyone", "friends", "nobody"].includes(b?.allowInvites)) u.privacy.allowInvites = b.allowInvites;
      await saveUserSocial(env, u);
      return mkResp();
    }

    if (action === "add_minutes") {
      const targetUid = cleanStr(b?.targetUid, 64);
      const delta = Math.max(1, Math.min(120, Number(b?.minutes || 5) || 5));
      for (const f of u.friends || []) {
        if (!targetUid || f.uid === targetUid) {
          f.watchMinutes = Math.max(0, Number(f.watchMinutes || 0) || 0) + delta;
          f.medal = computeWatchMedal(f.watchMinutes);
        }
      }
      u.watchMinutes = Math.max(0, Math.floor(Number(u.watchMinutes || 0) || 0)) + delta;
      u.medal = computeWatchMedal(u.watchMinutes);
      await saveUserSocial(env, u);
      if (caller.user?.email) {
        await syncAccountWatchMinutes(env, caller.user.email, u.watchMinutes);
      }
      return mkResp({ watchMinutes: u.watchMinutes, medal: u.medal });
    }

    return mkResp();
  }

  if (safePath === "/api/rave/social/invite" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid;
    const u = await ensureUserSocial(env, uid, { name: cleanStr(b?.fromName || b?.name, 32) || "İzleyici" }, true);
    const action = cleanStr(b?.action || "send", 24).toLowerCase();
    const nowS = Math.floor(Date.now() / 1000);
    if (action === "cancel") {
      const invId = cleanStr(b?.inviteId, 48);
      const targetUid = cleanStr(b?.targetUid, 64).toLowerCase();
      const roomId = cleanStr(b?.roomId, 80);
      if (targetUid && env?.WATCHLIVO_KV) {
        const cur = (await env.WATCHLIVO_KV.get(`soc:ntf:${targetUid}`, "json").catch(() => null)) || [];
        const next = (Array.isArray(cur) ? cur : []).filter((x) => !(x?.fromUid === uid && ((invId && x.id === invId) || (!invId && x.roomId === roomId))));
        await env.WATCHLIVO_KV.put(`soc:ntf:${targetUid}`, JSON.stringify(next), { expirationTtl: 86400 }).catch(() => {});
      }
      return edgeJson({ ok: true, cancelled: true });
    }
    if (action === "poke") {
      const targetUid = cleanStr(b?.targetUid, 64);
      if (!targetUid || getFriendshipState(u, targetUid) !== "FRIENDS") {
        return edgeJson({ ok: false, error: "El sallamak için arkadaş olmalısınız." }, 403);
      }
      const ntf = await queueSocialNotification(env, targetUid, {
        type: "poke",
        title: `👋 ${u.name} (${u.handle}) sana el salladı!`,
        body: "Sohbete geçmek veya birlikte bir oda açmak için dokun.",
        fromUid: uid,
        fromName: u.name,
        fromHandle: u.handle,
        fromColor: u.color,
        fromAvatarUrl: u.avatarUrl,
        expiresAt: nowS + 30,
      });
      return edgeJson({ ok: true, notification: ntf });
    }
    const roomId = cleanStr(b?.roomId, 80);
    if (!roomId) return edgeJson({ ok: false, error: "Oda kimliği (roomId) gerekli." }, 400);
    const roomName = cleanStr(b?.roomName || b?.roomTitle || "Watchlivo Odası", 100);
    const mediaTitle = cleanStr(b?.mediaTitle, 140);
    const mediaPoster = cleanStr(b?.mediaPoster, 800);
    const mediaProvider = cleanStr(b?.mediaProvider || "cinema", 32);
    const pwdQ = cleanStr(b?.password, 64);
    const syncTok = String(b?.syncToken || b?.r_tok || "").trim().slice(0, 32000);
    let targets = [];
    if (action === "invite_all_online") {
      for (const fr of u.friends || []) {
        if (!fr?.uid) continue;
        const pres = await computeLivePresence(env, fr.uid, uid, true);
        if (pres.online) targets.push(fr.uid);
      }
      if (!targets.length) return edgeJson({ ok: true, invited: 0, onlineCount: 0, sentCount: 0, invites: [] });
    } else if (Array.isArray(b?.targetUids)) {
      targets = b.targetUids.map((x) => cleanStr(x, 64)).filter(Boolean);
    } else if (b?.targetUid) {
      targets = [cleanStr(b.targetUid, 64)];
    }
    if (!targets.length) return edgeJson({ ok: false, error: "Davet edilecek arkadaş seçilmedi." }, 400);
    const qParts = [];
    if (pwdQ) qParts.push(`pwd=${encodeURIComponent(pwdQ)}`);
    if (mediaTitle) qParts.push(`t=${encodeURIComponent(mediaTitle)}`);
    if (syncTok) qParts.push(`r_tok=${encodeURIComponent(syncTok)}`);
    const joinUrl = `/#/mesh/${encodeURIComponent(roomId)}${qParts.length ? `?${qParts.join("&")}` : ""}`;
    const sentInvites = [];
    const rejected = [];
    for (const tUid of targets.slice(0, 25)) {
      if (!tUid || tUid === uid) continue;
      const tU = await ensureUserSocial(env, tUid, {}, false);
      if ((u.blocked || []).some((x) => x.uid === tUid) || (tU.blocked || []).some((x) => x.uid === uid)) {
        rejected.push({ uid: tUid, reason: "blocked" });
        continue;
      }
      const tAllow = String(tU?.privacy?.allowInvites || "friends").toLowerCase();
      if (tAllow === "nobody") {
        rejected.push({ uid: tUid, reason: "invites_disabled" });
        continue;
      }
      if (tAllow !== "everyone" && getFriendshipState(u, tUid) !== "FRIENDS") {
        rejected.push({ uid: tUid, reason: "friends_only" });
        continue;
      }
      const invId = `inv_${makeNonce().slice(0, 10)}`;
      const ntf = await queueSocialNotification(env, tUid, {
        id: invId,
        type: "room_invite",
        title: `🎬 ${u.name} seni odaya çağırıyor!`,
        body: `${mediaTitle || roomName} · Tek tıkla canlı odaya katıl!`,
        fromUid: uid,
        fromName: u.name,
        fromHandle: u.handle,
        fromColor: u.color,
        fromAvatarUrl: u.avatarUrl,
        roomId,
        roomName,
        mediaTitle,
        mediaPoster,
        poster: mediaPoster,
        mediaProvider,
        url: joinUrl,
        expiresAt: nowS + 1800,
      });
      if (env?.WATCHLIVO_KV) {
        const tk = dmThreadKey(uid, tUid);
        const curDm = (await env.WATCHLIVO_KV.get(`soc:dm:${tk}`, "json").catch(() => null)) || [];
        const dmList = Array.isArray(curDm) ? curDm : [];
        dmList.push({
          id: `dm_${makeNonce().slice(0, 10)}`,
          fromUid: uid,
          fromName: u.name,
          color: u.color,
          text: `🎬 Seni "${mediaTitle || roomName}" odasına davet ettim!`,
          time: formatHhMm(nowS),
          ts: nowS,
          reactions: {},
          roomInvite: roomId,
          roomInviteCard: { roomId, roomName, mediaTitle, mediaPoster, poster: mediaPoster, mediaProvider, url: joinUrl },
        });
        await env.WATCHLIVO_KV.put(`soc:dm:${tk}`, JSON.stringify(dmList.slice(-100)), { expirationTtl: 2592000 }).catch(() => {});
        tU.unread = tU.unread || {};
        tU.unread[uid] = Math.max(0, Number(tU.unread?.[uid] || 0) || 0) + 1;
        await saveUserSocial(env, tU);
      }
      if (ntf) sentInvites.push(ntf);
    }
    if (action !== "invite_all_online" && targets.length === 1 && sentInvites.length === 0 && rejected.length > 0) {
      const reason = rejected[0].reason;
      const errMsg = reason === "invites_disabled"
        ? "Bu kullanıcı oda davetlerini devre dışı bıraktı."
        : reason === "blocked"
          ? "Bu kullanıcıya davet gönderilemiyor."
          : "Yalnızca arkadaşlar oda daveti gönderebilir.";
      return edgeJson({ ok: false, error: errMsg, code: reason }, 403);
    }
    return edgeJson({ ok: true, sentCount: sentInvites.length, invites: sentInvites, ...(rejected.length ? { skippedCount: rejected.length, rejected } : {}) });
  }

  if (safePath === "/api/rave/social/dm") {
    if (request.method === "GET") {
      const caller = await resolveSocialCaller(request, env, url.searchParams.get("uid"));
      if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
      if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
      const uid = caller.uid;
      const rawPeer = cleanStr(url.searchParams.get("peerId"), 64);
      let peerId = rawPeer;
      if (peerId && (peerId.startsWith("@") || (!peerId.startsWith("u_") && !peerId.startsWith("guest_")))) {
        const tc = await resolveSocialTarget(env, peerId);
        if (tc?.uid) peerId = tc.uid;
      }
      const u = await ensureUserSocial(env, uid, {}, false);
      if (!peerId) peerId = cleanStr(u.friends?.[0]?.uid, 64);
      if (!peerId) return edgeJson({ ok: true, peerId: "", canMessage: false, friendshipState: "NONE", messages: [], mode: "cf-autonomous-edge" });
      const fstate = getFriendshipState(u, peerId);
      const nowS = Math.floor(Date.now() / 1000);
      const peerCard = (await resolveSocialTarget(env, peerId, peerId)) || { uid: peerId, name: peerId, handle: `@${peerId.slice(0, 16)}` };
      const pres = await computeLivePresence(env, peerId, uid, fstate === "FRIENDS");
      const tk = dmThreadKey(uid, peerId);
      const dmCfg = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`soc:dmcfg:${tk}`, "json").catch(() => null) : null;
      const expVal = Math.max(0, Math.min(604800, Number(dmCfg?.expirySec || 0) || 0));
      if (fstate !== "FRIENDS") {
        return edgeJson({
          ok: true,
          peerId,
          peer: { ...peerCard, ...pres },
          friendshipState: fstate,
          friendState: fstate,
          canMessage: false,
          peerTyping: false,
          expirySec: expVal,
          settings: { expirySec: expVal },
          messages: [],
          mode: "cf-autonomous-edge",
        });
      }
      if (u.unread && (peerId in u.unread || (rawPeer && rawPeer in u.unread))) {
        delete u.unread[peerId];
        if (rawPeer) delete u.unread[rawPeer];
        await saveUserSocial(env, u);
      }
      const rawMsgs = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get(`soc:dm:${tk}`, "json").catch(() => null)) || [] : [];
      const msgs = (Array.isArray(rawMsgs) ? rawMsgs : []).filter((m) => !(Number(m?.expiryAt || 0) > 0 && Number(m.expiryAt) < nowS));
      let dirty = msgs.length !== (Array.isArray(rawMsgs) ? rawMsgs.length : 0);
      if (rawPeer) {
        for (const m of msgs) {
          if (m.fromUid === peerId && !m.readAt) {
            m.readAt = nowS;
            dirty = true;
          }
        }
      }
      if (dirty && env?.WATCHLIVO_KV) {
        await env.WATCHLIVO_KV.put(`soc:dm:${tk}`, JSON.stringify(msgs.slice(-100)), { expirationTtl: 2592000 }).catch(() => {});
      }
      const typTs = env?.WATCHLIVO_KV ? Number(await env.WATCHLIVO_KV.get(`soc:typ:${tk}:${peerId}`).catch(() => 0)) || 0 : 0;
      return edgeJson({
        ok: true,
        peerId,
        peer: { ...peerCard, ...pres },
        friendshipState: fstate,
        friendState: fstate,
        canMessage: true,
        peerTyping: (nowS - typTs) < 6,
        expirySec: expVal,
        settings: { expirySec: expVal },
        messages: msgs.slice(-80),
        mode: "cf-autonomous-edge",
      });
    }
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid;
    let peerId = cleanStr(b?.peerId || b?.peerUid || b?.targetUid, 64);
    if (peerId && (peerId.startsWith("@") || (!peerId.startsWith("u_") && !peerId.startsWith("guest_")))) {
      const tcPost = await resolveSocialTarget(env, peerId);
      if (tcPost?.uid) peerId = tcPost.uid;
    }
    const subAction = cleanStr(b?.action || "send", 20).toLowerCase();
    if (!peerId) return edgeJson({ ok: false, error: "Alıcı (peerId) seçilmedi." }, 400);
    const u = await ensureUserSocial(env, uid, { name: cleanStr(b?.fromName || b?.name, 32) || "İzleyici", color: b?.color }, true);
    const fstate = getFriendshipState(u, peerId);
    const tk = dmThreadKey(uid, peerId);
    const nowS = Math.floor(Date.now() / 1000);
    if (subAction === "typing") {
      if (fstate === "FRIENDS" && env?.WATCHLIVO_KV) {
        await env.WATCHLIVO_KV.put(`soc:typ:${tk}:${uid}`, String(nowS), { expirationTtl: 15 }).catch(() => {});
      }
      return edgeJson({ ok: true, typing: true });
    }
    if (fstate !== "FRIENDS") {
      return edgeJson({ ok: false, canMessage: false, friendshipState: fstate, error: "Mesajlaşmak için karşılıklı arkadaşlık onayı gereklidir." }, 403);
    }
    if (subAction === "settings") {
      const expSec = Math.max(0, Math.min(604800, Number(b?.expirySec || 0) || 0));
      if (env?.WATCHLIVO_KV) {
        await env.WATCHLIVO_KV.put(`soc:dmcfg:${tk}`, JSON.stringify({ expirySec: expSec, updatedAt: nowS }), { expirationTtl: 2592000 }).catch(() => {});
      }
      return edgeJson({ ok: true, expirySec: expSec });
    }
    const rawThread = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get(`soc:dm:${tk}`, "json").catch(() => null)) || [] : [];
    let thread = (Array.isArray(rawThread) ? rawThread : []).filter((m) => !(Number(m?.expiryAt || 0) > 0 && Number(m.expiryAt) < nowS));
    if (subAction === "react") {
      const msgId = cleanStr(b?.messageId, 48);
      const emoji = cleanStr(b?.emoji || "❤️", 12);
      for (const m of thread) {
        if (m.id === msgId) {
          m.reactions = m.reactions || {};
          const users = Array.isArray(m.reactions[emoji]) ? [...m.reactions[emoji]] : [];
          const idx = users.indexOf(uid);
          if (idx >= 0) users.splice(idx, 1);
          else users.push(uid);
          if (users.length) m.reactions[emoji] = users.slice(0, 20);
          else delete m.reactions[emoji];
          break;
        }
      }
      if (env?.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(`soc:dm:${tk}`, JSON.stringify(thread.slice(-100)), { expirationTtl: 2592000 }).catch(() => {});
      return edgeJson({ ok: true, messages: thread.slice(-80) });
    }
    if (subAction === "delete") {
      const msgId = cleanStr(b?.messageId, 48);
      thread = thread.filter((m) => !(m.id === msgId && m.fromUid === uid));
      if (env?.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(`soc:dm:${tk}`, JSON.stringify(thread.slice(-100)), { expirationTtl: 2592000 }).catch(() => {});
      return edgeJson({ ok: true, messages: thread.slice(-80) });
    }
    const text = cleanStr(b?.text, 1000);
    const roomInvite = cleanStr(b?.roomInvite, 180);
    const rawCard = b?.roomInviteCard && typeof b.roomInviteCard === "object" ? b.roomInviteCard : null;
    let snap = String(b?.snapshot || "").trim();
    if (snap && (snap.length > 85000 || !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(snap))) snap = "";
    let audioNote = b?.audioNote && typeof b.audioNote === "object" ? await persistEdgeAudioNote(env, b.audioNote) : null;
    if (audioNote && String(audioNote.dataUrl || "").length > 48000) {
      const { dataUrl: _drop, ...restAn } = audioNote;
      audioNote = restAn;
    }
    if (!text && !snap && !audioNote && !roomInvite && !rawCard) {
      return edgeJson({ ok: false, error: "Boş mesaj gönderilemez." }, 400);
    }
    const dmCfg = env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(`soc:dmcfg:${tk}`, "json").catch(() => null) : null;
    const expSec = Math.max(0, Math.min(604800, Number(dmCfg?.expirySec || 0) || 0));
    const msg = {
      id: `dm_${makeNonce().slice(0, 10)}`,
      fromUid: uid,
      fromName: u.name || "İzleyici",
      color: u.color || "#27DCC8",
      text,
      time: formatHhMm(nowS),
      ts: nowS,
      reactions: {},
      expiryAt: expSec > 0 ? nowS + expSec : 0,
    };
    if (b?.replyTo && typeof b.replyTo === "object" && b.replyTo.id) {
      msg.replyTo = { id: cleanStr(b.replyTo.id, 48), fromName: cleanStr(b.replyTo.fromName, 32), text: cleanStr(b.replyTo.text, 140) };
    }
    if (roomInvite || rawCard) {
      const rId = cleanStr(rawCard?.roomId || roomInvite, 180);
      const rawCu = String(rawCard?.url || "").trim().slice(0, 16000);
      const safeCu = rawCu.startsWith("/#/mesh/") && !/[<>"'\s]/.test(rawCu) ? rawCu : "";
      msg.roomInvite = rId;
      msg.roomInviteCard = {
        roomId: rId,
        roomName: cleanStr(rawCard?.roomName || "Watchlivo Odası", 100),
        mediaTitle: cleanStr(rawCard?.mediaTitle || "", 140),
        mediaPoster: cleanStr(rawCard?.mediaPoster || "", 800),
        mediaProvider: cleanStr(rawCard?.mediaProvider || "cinema", 32),
        ...(safeCu ? { url: safeCu } : {}),
      };
    }
    if (snap) {
      msg.snapshot = snap;
      if (b?.isExplicit) msg.isExplicit = true;
    }
    if (audioNote) msg.audioNote = audioNote;
    thread.push(msg);
    if (env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put(`soc:dm:${tk}`, JSON.stringify(thread.slice(-100)), { expirationTtl: 2592000 }).catch(() => {});
      await env.WATCHLIVO_KV.delete(`soc:typ:${tk}:${uid}`).catch(() => {});
    }
    if (peerId !== uid) {
      const peerU = await ensureUserSocial(env, peerId, {}, true);
      peerU.unread[uid] = Math.max(0, Number(peerU.unread?.[uid] || 0) || 0) + 1;
      await saveUserSocial(env, peerU);
      const invR = msg.roomInvite || "";
      const invC = msg.roomInviteCard || {};
      await queueSocialNotification(env, peerId, {
        type: invR ? "room_invite" : "dm",
        title: invR ? `🎬 ${u.name} seni odaya davet etti!` : `💬 ${u.name} mesaj gönderdi`,
        body: text || (invR ? `"${invC.mediaTitle || invC.roomName || "Sinema Odası"}" — Tek tıkla katıl!` : (audioNote ? "🎙️ Sesli mesaj gönderdi" : "Yeni mesaj")),
        fromUid: uid,
        fromName: u.name,
        fromHandle: u.handle,
        fromColor: u.color,
        fromAvatarUrl: u.avatarUrl,
        roomId: invR,
        roomName: invC.roomName || "",
        mediaTitle: invC.mediaTitle || "",
        mediaPoster: invC.mediaPoster || "",
        url: invC.url || (invR ? `/#/mesh/${encodeURIComponent(invR)}` : "/#/"),
        expiresAt: invR ? nowS + 60 : 0,
      });
    }
    return edgeJson({ ok: true, canMessage: true, message: msg, messages: thread.slice(-80) });
  }

  if (safePath === "/api/rave/report" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const entry = {
      id: `rep_${makeNonce().slice(0, 8)}`,
      targetType: cleanStr(b?.targetType || "room", 20),
      targetId: cleanStr(b?.targetId, 80),
      reason: cleanStr(b?.reason || "Uygunsuz içerik", 120),
      details: cleanStr(b?.details, 500),
      reporter: cleanStr(b?.reporter || "Anonim", 32),
      ts: Math.floor(Date.now() / 1000),
    };
    if (env?.WATCHLIVO_KV) {
      const list = (await env.WATCHLIVO_KV.get("mod:reports:v1", "json").catch(() => null)) || [];
      const next = [...(Array.isArray(list) ? list : []), entry].slice(-100);
      await env.WATCHLIVO_KV.put("mod:reports:v1", JSON.stringify(next)).catch(() => {});
    }
    return edgeJson({ ok: true, reportId: entry.id, message: "Bildiriminiz moderasyon ekibine iletildi." });
  }

  if (safePath === "/api/rave/contact") {
    const maskEm = (em) => {
      const s = String(em || "").trim();
      if (!s || !s.includes("@")) return s ? "***" : "";
      const [loc, dom] = s.split("@");
      return `${loc.slice(0, 1) || "*"}***@${dom}`;
    };
    if (request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const cat = cleanStr(b?.category || "contact", 24);
      const name = cleanStr(b?.name || "Misafir", 64);
      const email = cleanStr(b?.email, 96);
      const subj = cleanStr(b?.subject, 140);
      const msg = cleanStr(b?.message, 1200);
      if (subj.length < 2 && msg.length < 2) {
        return edgeJson({ ok: false, error: "Lütfen bir başlık veya mesaj girin." }, 400);
      }
      const entry = {
        id: `cnt_${makeNonce().slice(0, 8)}`,
        ts: formatHhMm(),
        category: cat,
        name,
        email,
        subject: subj,
        message: msg,
      };
      if (env?.WATCHLIVO_KV) {
        const list = (await env.WATCHLIVO_KV.get("contact:msgs:v1", "json").catch(() => null)) || [];
        const next = [entry, ...(Array.isArray(list) ? list : [])].slice(0, 80);
        await env.WATCHLIVO_KV.put("contact:msgs:v1", JSON.stringify(next)).catch(() => {});
      }
      return edgeJson({ ok: true, officialEmail: "jokallame0@gmail.com", entry: { ...entry, email: maskEm(email) } });
    }
    const raw = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get("contact:msgs:v1", "json").catch(() => null)) || [] : [];
    const admSec = String(env?.ADMIN_SECRET || "").trim();
    const admHdr = (request.headers.get("X-Admin-Secret") || "").trim();
    const isAdm = Boolean(admSec && admHdr && timingSafeEqualStr(admHdr, admSec));
    const msgs = isAdm
      ? raw.slice(0, 30)
      : raw.slice(0, 30).map((m) => ({
          id: String(m?.id || ""),
          ts: String(m?.ts || ""),
          category: String(m?.category || "contact"),
          name: `${String(m?.name || "M").slice(0, 1)}***`,
          email: maskEm(m?.email),
          subject: String(m?.subject || ""),
        }));
    return edgeJson({ ok: true, officialEmail: "jokallame0@gmail.com", messages: msgs });
  }

  if (safePath === "/api/rave/accounts/status") {
    const caller = await resolveSocialCaller(request, env, url.searchParams.get("uid"));
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const provider = cleanStr(url.searchParams.get("provider"), 32).toLowerCase().replace(/^hbomax$/, "max");
    if (!caller.authenticated && !url.searchParams.get("uid")) {
      return edgeJson({ ok: true, authenticated: false, userId: "", provider: provider || "max", hasActiveConnection: false, loginSatisfied: false });
    }
    const acctMap = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get(`acct_prov:${caller.uid}`, "json").catch(() => null)) || {} : {};
    if (provider) {
      const st = acctMap[provider] || null;
      const active = Boolean(st?.loginSatisfied);
      return edgeJson({ ok: true, authenticated: true, userId: caller.uid, provider, hasActiveConnection: active, loginSatisfied: active, account: active ? st : null });
    }
    const maxSt = acctMap.max || {};
    return edgeJson({ ok: true, authenticated: true, userId: caller.uid, hasActiveMaxConnection: Boolean(maxSt.loginSatisfied), max: maxSt });
  }

  if (safePath === "/api/rave/accounts/verify" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    const uid = caller.uid === "guest_default" ? `guest_wl_${makeNonce().slice(0, 10)}` : caller.uid;
    let provider = cleanStr(b?.provider || "max", 32).toLowerCase();
    if (provider === "hbomax") provider = "max";
    if (!["netflix", "disney", "prime", "max", "crunchyroll", "tubi", "youtube", "exxen", "blutv", "gain", "tod"].includes(provider)) {
      return edgeJson({ ok: false, error: "Bilinmeyen platform", code: "unknown_provider" }, 400);
    }
    const authType = cleanStr(b?.auth_type || b?.authType || "sso", 24).toLowerCase();
    const accountEmail = cleanStr(b?.email || b?.account_email || b?.accountEmail, 120);
    const profileName = cleanStr(b?.profile_name || b?.profile || b?.profileName, 64) || `${provider.toUpperCase()} Üye`;
    const sessionTok = cleanStr(b?.session_token || b?.sessionToken || b?.cookie || b?.token, 1024);
    if (authType === "credentials") {
      if (provider !== "max") return edgeJson({ ok: false, error: "Platform şifre ile doğrulama desteklenmiyor.", code: "unsupported" }, 501);
      if (!accountEmail.includes("@") || String(b?.password || "").length < 6) {
        return edgeJson({ ok: false, error: "Geçerli e-posta ve en az 6 karakterli şifre gerekli.", code: "invalid_credentials" }, 400);
      }
    } else if (sessionTok.length < 12) {
      return edgeJson({ ok: false, error: "Geçerli bir oturum anahtarı veya çerez gereklidir.", code: "missing_token" }, 400);
    }
    const entry = { provider, accountEmail, profileName, loginSatisfied: true, has_active_connection: true, updatedAt: Math.floor(Date.now() / 1000) };
    if (env?.WATCHLIVO_KV) {
      const cur = (await env.WATCHLIVO_KV.get(`acct_prov:${uid}`, "json").catch(() => null)) || {};
      cur[provider] = entry;
      await env.WATCHLIVO_KV.put(`acct_prov:${uid}`, JSON.stringify(cur), { expirationTtl: 2592000 }).catch(() => {});
    }
    return edgeJson({ ok: true, provider, profileName, accountEmail, loginSatisfied: true, zeroKnowledge: true });
  }

  if (safePath === "/api/rave/accounts/logout" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const caller = await resolveSocialCaller(request, env, b?.uid, b);
    if (caller.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    if (caller.invalidToken) return edgeJson({ ok: false, error: "invalid_session", invalidToken: true }, 401);
    let provider = cleanStr(b?.provider, 32).toLowerCase();
    if (provider === "hbomax") provider = "max";
    if (caller.uid && provider && env?.WATCHLIVO_KV) {
      const cur = (await env.WATCHLIVO_KV.get(`acct_prov:${caller.uid}`, "json").catch(() => null)) || {};
      if (cur[provider]) {
        cur[provider].loginSatisfied = false;
        cur[provider].has_active_connection = false;
        await env.WATCHLIVO_KV.put(`acct_prov:${caller.uid}`, JSON.stringify(cur), { expirationTtl: 2592000 }).catch(() => {});
      }
    }
    return edgeJson({ ok: true, provider, domain: cleanStr(b?.domain, 80), loginSatisfied: false });
  }

  if (safePath === "/api/rave/extract-video") {
    const b = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const rawU = String(url.searchParams.get("url") || b?.url || "").trim().slice(0, 2000);
    const title = cleanStr(url.searchParams.get("title") || b?.title, 150);
    if (!rawU || !isPublicHttpUrl(rawU)) {
      return edgeJson({ ok: false, error: "Geçersiz veya yasaklı hedef URL." }, 400);
    }
    const extracted = await extractVideoEdge(rawU, title);
    if (extracted) {
      return edgeJson(extracted);
    }
    return edgeJson({
      ok: false,
      error: "Medya çözümleme servisi geçici olarak meşgul, birkaç saniye sonra tekrar deneyin.",
      code: "origin_required",
      mode: "cf-autonomous-edge",
    }, 503);
  }

  if (safePath === "/api/rave/oembed") {
    const targetUrl = String(url.searchParams.get("url") || "").trim();
    if (!/^https?:\/\/(www\.|player\.)?vimeo\.com\//i.test(targetUrl)) {
      return edgeJson({ error: "Geçersiz Vimeo bağlantısı" }, 400);
    }
    try {
      const r = await fetch(`https://vimeo.com/api/oembed.json?${new URLSearchParams({ url: targetUrl })}`, {
        headers: { "User-Agent": EDGE_UA },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return edgeJson({ error: "Vimeo bilgisi alınamadı (video gizli olabilir)" }, 404);
      const data = await r.json();
      return edgeJson({
        title: data?.title || null,
        author_name: data?.author_name || null,
        thumbnail_url: data?.thumbnail_url || null,
        duration: data?.duration || null,
        video_id: data?.video_id || null,
      });
    } catch {
      return edgeJson({ error: "Vimeo bilgisi alınamadı (video gizli olabilir)" }, 404);
    }
  }

  if (safePath === "/api/rave/gifs") {
    const q = cleanStr(url.searchParams.get("q"), 80);
    const giphyKey = String(env?.GIPHY_API_KEY || DEFAULT_GIPHY_KEY).trim();
    if (!giphyKey) return edgeJson({ gifs: [], error: "GIF servisi yapılandırılmamış" });
    try {
      const ep = q ? "search" : "trending";
      const r = await fetch(`https://api.giphy.com/v1/gifs/${ep}?${new URLSearchParams({ api_key: giphyKey, q, limit: "24", rating: "pg-13" })}`, {
        headers: { "User-Agent": EDGE_UA },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return edgeJson({ gifs: [] });
      const data = await r.json().catch(() => null);
      const out = [];
      for (const g of data?.data || []) {
        const im = g?.images || {};
        const full = im.fixed_height?.url;
        const small = im.fixed_height_small?.url;
        if (full) out.push({ id: g.id, title: g.title || "GIF", url: full, preview: small || full });
      }
      return edgeJson({ gifs: out });
    } catch {
      return edgeJson({ gifs: [] });
    }
  }

  if (safePath === "/api/search/youtube" || safePath === "/api/rave/yt-search") {
    const q = cleanStr(url.searchParams.get("q"), 200);
    if (!q) return edgeJson({ items: [] });
    const items = await ytSearchEdge(q);
    return edgeJson({ items });
  }

  if (safePath === "/api/rave/yt-personalized-feed") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    const { user } = authRes;
    const b = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const params = { ...Object.fromEntries(url.searchParams.entries()), ...(b && typeof b === "object" ? b : {}) };
    const chip = cleanStr(params.chip || "all", 80);
    const prefs = (user && env?.WATCHLIVO_KV)
      ? { ...defaultYtPrefs(), ...((await env.WATCHLIVO_KV.get(`ulist:${user.id}:ytprefs`, "json").catch(() => null)) || {}) }
      : defaultYtPrefs();
    const dismissedSet = new Set([...(prefs.dismissedVideoIds || []), ...(Array.isArray(params.dismissedVideoIds) ? params.dismissedVideoIds : [])].map(String));
    const blockedCh = new Set([...(prefs.blockedChannels || []), ...(Array.isArray(params.blockedChannels) ? params.blockedChannels : [])].map((x) => String(x || "").toLowerCase()));
    const followed = Array.isArray(prefs.subscriptions) ? [...prefs.subscriptions] : [];
    const seenFch = new Set(followed.map((c) => c.channelId || String(c.name || "").toLowerCase()));
    for (const cIn of Array.isArray(params.seedChannels) ? params.seedChannels : []) {
      if (cIn && typeof cIn === "object") {
        const ck = cIn.channelId || String(cIn.name || "").toLowerCase();
        if (ck && !seenFch.has(ck)) {
          seenFch.add(ck);
          followed.push({ channelId: String(cIn.channelId || ""), name: String(cIn.name || ""), avatar: String(cIn.avatar || "") });
        }
      }
    }
    const seedVids = [];
    const seenSv = new Set();
    const pushSeed = (vRaw, lbl) => {
      const v = extractYtVidAny(vRaw);
      if (v && !seenSv.has(v) && !dismissedSet.has(v)) {
        seenSv.add(v);
        seedVids.push([v, lbl]);
      }
    };
    for (const lv of (prefs.likedVideos || []).slice(0, 3)) pushSeed(lv?.videoId, `❤️ Beğendiğin: ${cleanStr(lv?.title, 28)}`);
    for (const cv of (Array.isArray(params.seedVideoIds) ? params.seedVideoIds : []).slice(0, 6)) {
      if (cv && typeof cv === "object") pushSeed(cv.videoId, `✨ İzlediğin: ${cleanStr(cv.title, 26)}` || "✨ Sana Özel");
      else pushSeed(cv, "✨ İzleme geçmişine göre");
    }
    const chips = [
      { id: "all", label: "Tümü" },
      { id: "for_you", label: "✨ Sana Özel" },
      { id: "subscriptions", label: followed.length ? `🔔 Takip Edilenler (${followed.length})` : "🔔 Takip Edilenler" },
      { id: "recent", label: "🆕 Yeni Yüklenenler" },
      ...followed.slice(0, 3).filter((f) => f.name).map((f) => ({ id: `ch:${f.channelId || ""}:${cleanStr(f.name, 32)}`, label: `📺 ${cleanStr(f.name, 20)}` })),
      { id: "music", label: "🎵 Müzik" },
      { id: "cinema", label: "🎬 Sinema & Fragman" },
      { id: "gaming", label: "🎮 Oyun" },
      { id: "live", label: "🔴 Canlı" },
    ];
    const tasks = [];
    if (chip === "subscriptions") {
      const targets = followed.slice(0, 4);
      for (const fc of targets) tasks.push(ytChannelFeedEdge(fc.channelId, fc.name, fc.avatar));
      if (!tasks.length) tasks.push(ytSearchEdge("Türkiye popüler içerik üreticileri son video 2026"));
    } else if (chip.startsWith("ch:")) {
      const parts = chip.split(":");
      tasks.push(ytChannelFeedEdge(parts[1] || "", parts.slice(2).join(":") || ""));
    } else if (chip.startsWith("q:")) {
      tasks.push(ytSearchEdge(chip.slice(2).trim()));
    } else if (["music", "cinema", "gaming", "live", "recent"].includes(chip)) {
      const catMap = {
        music: "Türkçe pop alternatif rap hit video klip 2026",
        cinema: "yeni film dizi resmi fragman inceleme Türkçe 2026",
        gaming: "Türkçe oyun inceleme gameplay eğlence 2026",
        live: "Türkiye canlı yayın haber müzik spor live",
        recent: "Türkiye bu hafta yeni yüklenen popüler videolar 2026",
      };
      tasks.push(ytSearchEdge(catMap[chip]));
      if (seedVids.length) tasks.push(ytNextRelatedEdge(seedVids[0][0], seedVids[0][1]));
    } else {
      for (const [svId, svLbl] of seedVids.slice(0, 2)) tasks.push(ytNextRelatedEdge(svId, svLbl));
      for (const fc of followed.slice(0, 2)) tasks.push(ytChannelFeedEdge(fc.channelId, fc.name, fc.avatar));
      for (const sq of [...(prefs.searchHistory || []).slice(0, 2), ...(Array.isArray(params.seedQueries) ? params.seedQueries.slice(0, 2) : [])].slice(0, 2)) {
        if (sq) tasks.push(ytSearchEdge(sq));
      }
      if (!tasks.length) tasks.push(ytSearchEdge("Türkiye popüler müzik sinema teknoloji eğlence 2026"));
    }
    const resBatches = await Promise.allSettled(tasks);
    const merged = [];
    const seenOut = new Set();
    const likedSet = new Set((prefs.likedVideos || []).map((x) => extractYtVidAny(x?.videoId)).filter(Boolean));
    for (const r of resBatches) {
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
      for (const it of r.value) {
        const vid = extractYtVidAny(it?.videoId);
        if (!vid || seenOut.has(vid) || dismissedSet.has(vid)) continue;
        const chLow = String(it.channel || "").toLowerCase();
        const chId = String(it.channelId || "");
        if ((chLow && blockedCh.has(chLow)) || (chId && blockedCh.has(chId.toLowerCase()))) continue;
        seenOut.add(vid);
        merged.push({
          ...it,
          isLiked: likedSet.has(vid),
          isFollowedChannel: Boolean((chId && seenFch.has(chId)) || (chLow && seenFch.has(chLow))),
          watchedPercent: 0,
          reason: it.reason || (seedVids.length ? "✨ Sana Özel" : "🔥 Önerilen"),
        });
        if (merged.length >= 32) break;
      }
      if (merged.length >= 32) break;
    }
    return edgeJson({
      ok: true,
      authenticated: Boolean(user),
      personalized: Boolean(seedVids.length || followed.length),
      chip,
      chips,
      followedChannels: followed.slice(0, 30),
      items: merged,
    });
  }

  if (safePath === "/api/rave/playlist") {
    const raw = cleanStr(url.searchParams.get("url") || url.searchParams.get("list"), 600);
    const m = raw.match(/(?:[?&]list=|^)((?:PL|UU|FL|OLAK|RD)[A-Za-z0-9_-]{8,120})/);
    const listId = m ? m[1] : "";
    if (!listId) {
      return edgeJson({ ok: false, error: "Geçerli bir YouTube Playlist bağlantısı veya ID'si girin." }, 400);
    }
    const items = [];
    let playlistTitle = `YouTube Playlist (${listId.slice(0, 12)})`;
    try {
      const r = await fetch(`https://www.youtube.com/playlist?${new URLSearchParams({ list: listId, hl: "tr" })}`, {
        headers: { "User-Agent": EDGE_UA, "Accept-Language": "tr-TR,tr;q=0.9" },
        signal: AbortSignal.timeout(4500),
      });
      if (r.ok) {
        const html = (await r.text()).slice(0, 650000);
        const tm = html.match(/<meta property="og:title" content="([^"]+)"/i);
        if (tm) playlistTitle = cleanStr(tm[1], 120);
        const seenVids = new Set();
        for (const blk of html.split('"playlistVideoRenderer":{').slice(1)) {
          const chunk = blk.slice(0, 2400);
          const vm = chunk.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
          if (!vm || seenVids.has(vm[1])) continue;
          const vid = vm[1];
          seenVids.add(vid);
          const vtM = chunk.match(/"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"\}/) || chunk.match(/"title":\{"simpleText":"((?:\\.|[^"\\])*)"\}/);
          let vTitle = vtM ? vtM[1] : "";
          try { if (vTitle) vTitle = JSON.parse(`"${vTitle}"`); } catch {}
          const lsM = chunk.match(/"lengthSeconds":"(\d+)"/);
          const durSec = lsM ? Math.max(0, Math.min(86400, Number(lsM[1]) || 210)) : 210;
          items.push({
            provider: "youtube",
            videoId: vid,
            url: `https://www.youtube.com/watch?v=${vid}`,
            title: cleanStr(vTitle, 140) || `YouTube #${items.length + 1}`,
            channel: playlistTitle,
            thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            duration: durSec,
          });
          if (items.length >= 30) break;
        }
      }
    } catch {}
    return edgeJson({ ok: true, playlistId: listId, title: playlistTitle, count: items.length, items });
  }

  if (safePath === "/api/rave/gdrive-folder") {
    const rawUrl = cleanStr(url.searchParams.get("url"), 1000);
    if (!rawUrl) return edgeJson({ ok: false, error: "Google Drive klasör veya dosya bağlantısı girin." }, 400);
    const signDrive = async (dlU) => {
      const sig = await signProxySig(dlU, "", env);
      return sig ? `/api/rave/stream-proxy?url=${encodeURIComponent(dlU)}&sig=${sig}` : dlU;
    };
    const folderM = rawUrl.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
    if (folderM) {
      const fid = folderM[1];
      const items = [];
      try {
        const r = await fetch(`https://drive.google.com/drive/folders/${fid}`, {
          headers: { "User-Agent": EDGE_UA },
          signal: AbortSignal.timeout(3800),
        });
        if (r.ok) {
          const html = (await r.text()).slice(0, 450000);
          const rx = /data-id="([A-Za-z0-9_-]{15,45})"[\s\S]*?data-tooltip="([^"]+)"/g;
          const seen = new Set();
          let m;
          while ((m = rx.exec(html)) !== null && items.length < 24) {
            const dId = m[1];
            const cleanT = cleanStr(m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"'), 140);
            if (seen.has(dId) || /\.(?:pdf|jpg|jpeg|png|gif|webp|zip|rar|7z|doc|docx|xls|xlsx|ppt|pptx|txt)$/i.test(cleanT)) continue;
            seen.add(dId);
            const ext = cleanT.includes(".") ? cleanT.split(".").pop().toLowerCase() : "mp4";
            const dlU = `https://drive.usercontent.google.com/download?id=${dId}&export=download&confirm=t`;
            const pMain = await signDrive(dlU);
            const p720 = await signDrive(`${dlU}&vq=hd720`);
            const p480 = await signDrive(`${dlU}&vq=medium`);
            items.push({
              id: dId,
              title: cleanT,
              format: ext.toUpperCase(),
              mime: ext === "mkv" ? "video/x-matroska" : (ext === "webm" ? "video/webm" : "video/mp4"),
              url: pMain,
              directUrl: dlU,
              qualities: [
                { label: "1080p Orijinal (Direct)", quality: "1080p", url: pMain },
                { label: "720p HD Stream", quality: "720p", url: p720 },
                { label: "480p SD Stream", quality: "480p", url: p480 },
              ],
            });
          }
        }
      } catch {}
      return edgeJson({
        ok: true,
        type: "folder",
        folderId: fid,
        items,
        ...(items.length ? {} : { warning: "Klasörde herkese açık video dosyası bulunamadı. Paylaşım ayarının 'Bağlantıya sahip olan herkes' olduğundan emin olun." }),
      });
    }
    const fileM = rawUrl.match(/\/file\/d\/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})/) || rawUrl.match(/([A-Za-z0-9_-]{15,45})/);
    const fidSingle = fileM ? (fileM[1] || fileM[2] || "") : "";
    if (!fidSingle) return edgeJson({ ok: false, error: "Geçerli bir Google Drive dosya veya klasör bağlantısı girin." }, 400);
    const dlU = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fidSingle)}&export=download&confirm=t`;
    const pMain = await signDrive(dlU);
    const p720 = await signDrive(`${dlU}&vq=hd720`);
    const p480 = await signDrive(`${dlU}&vq=medium`);
    return edgeJson({
      ok: true,
      type: "file",
      fileId: fidSingle,
      items: [{
        id: fidSingle,
        title: `Google Drive Video (${fidSingle.slice(0, 10)})`,
        format: "MP4/MKV",
        mime: "video/mp4",
        url: pMain,
        directUrl: dlU,
        qualities: [
          { label: "1080p Orijinal (Direct)", quality: "1080p", url: pMain },
          { label: "720p HD Stream", quality: "720p", url: p720 },
          { label: "480p SD Stream", quality: "480p", url: p480 },
        ],
      }],
    });
  }

  if (safePath === "/api/rave/ravedj-trending") {
    let items = [];
    try {
      const r = await fetch("https://rave.dj/", { headers: { "User-Agent": EDGE_UA, Accept: "text/html" }, signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const html = (await r.text()).slice(0, 450000);
        const marker = html.indexOf("Env.dataStore");
        if (marker >= 0) {
          const bStart = html.indexOf("{", marker);
          const bEnd = html.indexOf(";\n", bStart);
          if (bStart >= 0 && bEnd > bStart) {
            const ds = JSON.parse(html.slice(bStart, bEnd));
            for (const row of (ds?.content || []).slice(0, 16)) {
              const urls = row?.urls || {};
              const thumbs = row?.thumbnails || {};
              const vUrl = String(urls["720"] || urls.default || urls["480"] || urls.max || urls.audio || "").trim();
              if (!vUrl.startsWith("https://")) continue;
              const tRaw = cleanStr(row?.title || "Mashup", 90).replace(/ravedj/gi, "Watchlivo DJ");
              const artRaw = cleanStr(row?.artists || "Watchlivo DJ Mix", 70).replace(/ravedj/gi, "Watchlivo DJ");
              const parts = artRaw.split("&").map((x) => x.trim());
              items.push({
                id: `wldj_${row.id || makeNonce().slice(0, 8)}`,
                title: `🎧 Watchlivo DJ: ${tRaw} — ${artRaw}`,
                songTitle: tRaw,
                artist: artRaw,
                trackA: parts[0] || tRaw,
                trackB: parts[1] || tRaw,
                bpm: 124,
                provider: "direct",
                streamType: "mp4",
                url: vUrl,
                audioPreviewUrl: String(urls.audio || vUrl),
                thumbnail: String(thumbs.max || thumbs["720"] || thumbs.default || thumbs["480"] || "/static/watchlivo-poster.svg"),
                duration: Math.floor(Number(row?.duration || 180) || 180),
              });
            }
          }
        }
      }
    } catch {}
    if (!items.length) items = RAVEDJ_FALLBACK_PRESETS;
    return edgeJson({ ok: true, items, presets: items });
  }

  if (safePath === "/api/rave/ravedj-mashup") {
    const b = request.method === "POST" ? await request.json().catch(() => ({})) : Object.fromEntries(url.searchParams.entries());
    const qA = cleanStr(b?.trackA || b?.a, 200);
    const qB = cleanStr(b?.trackB || b?.b, 200);
    if (!qA || !qB) {
      return edgeJson({ ok: false, error: "Mashup oluşturmak için iki şarkı adı veya bağlantısı girin." }, 400);
    }
    const [trA, trB] = await Promise.all([resolveMashupTrackEdge(qA), resolveMashupTrackEdge(qB)]);
    if (!trA || !trB) {
      return edgeJson({ ok: false, error: "Seçilen parçalar için ses akışı çözümlenemedi." }, 404);
    }
    const targetBpm = Math.round((trA.bpm + trB.bpm) / 2);
    const shortA = cleanStr(trA.title.split("(")[0].split("|")[0].replace(/🎵/g, ""), 36);
    const shortB = cleanStr(trB.title.split("(")[0].split("|")[0].replace(/🎵/g, ""), 36);
    const combinedAlts = Array.from(new Set([trA.audioPreviewUrl, ...(trA.altUrls || []), trB.url, trB.audioPreviewUrl, ...(trB.altUrls || [])].filter((u) => u && u !== trA.url)));
    const mashup = {
      id: `wldj_${makeNonce().slice(0, 8)}`,
      provider: trA.url.includes("youtube.com") ? "youtube" : "direct",
      streamType: trA.url.includes("youtube.com") ? "youtube" : "direct",
      videoId: trA.videoId || "",
      clipVideoId: trA.clipVideoId || trB.clipVideoId || "",
      altVideoIds: trB.videoId ? [trB.videoId] : [],
      url: trA.url,
      altUrls: combinedAlts,
      audioPreviewUrl: trA.audioPreviewUrl || trA.url,
      mvUrl: trA.mvUrl || trB.mvUrl || "",
      title: `🎧 Watchlivo DJ: ${shortA} × ${shortB} (${targetBpm} BPM)`,
      songTitle: `${shortA} × ${shortB}`,
      artist: `Watchlivo DJ (${targetBpm} BPM)`,
      channel: "Watchlivo DJ Mashup Studio",
      thumbnail: trA.thumbnail,
      poster: trA.thumbnail,
      duration: trA.duration || 210,
      bpm: targetBpm,
      isMusic: true,
      isRemix: true,
      isRaveDJ: true,
      musicMode: "clip",
      versionBadge: `🎧 Watchlivo DJ ${targetBpm} BPM`,
      musicPlatformLabel: "Watchlivo DJ Beat-Match",
      mashupTracks: [trA, trB],
      crossfadePoints: [18, 45, 78, 112, 148, 180],
    };
    return edgeJson({ ok: true, mashup });
  }

  if (safePath === "/api/rave/voice-note" && request.method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return edgeJson({ ok: false, error: "Geçersiz veri" }, 400);
    const saved = await persistEdgeAudioNote(env, b);
    if (!saved) return edgeJson({ ok: false, error: "Ses kaydı işlenemedi" }, 400);
    const { dataUrl: _drop, ...respNote } = saved;
    return edgeJson({ ok: true, audioNote: respNote });
  }

  const vnMatch = safePath.match(/^\/api\/rave\/voice-note\/([a-zA-Z0-9_-]{4,40})$/);
  if (vnMatch) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type",
          "Accept-Ranges": "bytes",
        },
      });
    }
    const noteId = vnMatch[1];
    let entry = _voiceNoteMem.get(noteId) || null;
    if (!entry && env?.WATCHLIVO_KV) {
      entry = await env.WATCHLIVO_KV.get(`vn:${noteId}`, "json").catch(() => null);
    }
    if (!entry?.b64) return edgeJson({ ok: false, error: "Sesli mesaj bulunamadı" }, 404);
    let rawBytes;
    try {
      rawBytes = decodeBase64ToBytes(entry.b64);
    } catch {
      return edgeJson({ ok: false, error: "Ses verisi bozuk" }, 500);
    }
    const total = rawBytes.length;
    const hdrs = {
      "Content-Type": String(entry.mime || "audio/wav"),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": 'inline; filename="voice-note"',
    };
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: { ...hdrs, "Content-Length": String(total) } });
    }
    const rng = (request.headers.get("Range") || "").trim();
    if (rng) {
      const rm = rng.match(/^bytes=(\d*)-(\d*)$/);
      if (!rm || total <= 0 || (!rm[1] && !rm[2])) {
        return new Response(null, { status: 416, headers: { ...hdrs, "Content-Range": `bytes */${total}` } });
      }
      let start, end;
      if (!rm[1]) {
        const suffix = Number(rm[2]);
        if (suffix <= 0) return new Response(null, { status: 416, headers: { ...hdrs, "Content-Range": `bytes */${total}` } });
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Number(rm[1]);
        end = rm[2] ? Number(rm[2]) : total - 1;
        if (start >= total || (rm[2] && end < start)) {
          return new Response(null, { status: 416, headers: { ...hdrs, "Content-Range": `bytes */${total}` } });
        }
        end = Math.min(end, total - 1);
      }
      const chunk = rawBytes.subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: { ...hdrs, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(chunk.length) },
      });
    }
    return new Response(rawBytes, { status: 200, headers: { ...hdrs, "Content-Length": String(total) } });
  }

  if (safePath === "/api/rave/voice-relay" || safePath.startsWith("/api/rave/voice-relay/")) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" },
      });
    }
    const pathRid = safePath.startsWith("/api/rave/voice-relay/") ? decodeURIComponent(safePath.slice("/api/rave/voice-relay/".length).split("/")[0] || "") : "";
    const roomId = String(pathRid || url.searchParams.get("roomId") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48);
    if (!roomId) return edgeJson({ ok: false, error: "Geçersiz oda" }, 400);
    const relayHdrs = { "Access-Control-Allow-Origin": "*" };
    if (env?.ROOM_DO) {
      const doRelay = await handleEdgeRoomVoiceRelay(roomId, request, env, edgeJson, _curatedMap, relayHdrs);
      if (doRelay) return doRelay;
    }
    const b = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (request.method === "POST" && (!b || typeof b !== "object")) {
      return edgeJson({ ok: false, error: "Geçersiz JSON" }, 400, relayHdrs);
    }
    const cidRaw = String((request.method === "POST" ? b.clientId : url.searchParams.get("clientId")) || "");
    const cid = /^[a-zA-Z0-9_-]{1,64}$/.test(cidRaw) ? cidRaw : "";
    const ctok = String((request.method === "POST" ? b.clientToken : url.searchParams.get("clientToken")) || "").trim();
    if (!cid) return edgeJson({ ok: false, error: "İstemci kimliği gerekli" }, 400, relayHdrs);
    const tokOk = Boolean(ctok && (await verifyRoomClientToken(ctok, roomId, cid, env)));
    if (!tokOk) return edgeJson({ ok: false, error: "Yetkisiz istemci" }, 403, relayHdrs);
    // Verify room exists & participant via handleEdgeRoomInfo
    let roomInfo = null;
    const infoResp = await handleEdgeRoomInfo(roomId, new Request(`https://watchlivo.online/api/rooms/${encodeURIComponent(roomId)}?clientId=${encodeURIComponent(cid)}&clientToken=${encodeURIComponent(ctok)}`), env, (d, s = 200) => ({ status: s, data: d }), _curatedMap);
    if (infoResp.status !== 200 || !infoResp.data?.room) {
      return edgeJson({ ok: false, error: "Oda bulunamadı" }, 404, relayHdrs);
    }
    roomInfo = infoResp.data.room;
    if (String(roomInfo.voipMode || "all") === "off") {
      if (request.method === "GET") return edgeJson({ ok: true, serverTime: Date.now() / 1000, packets: [] }, 200, relayHdrs);
      return edgeJson({ ok: false, error: "Ses kanalı kapalı" }, 403, relayHdrs);
    }
    const nowSec = Date.now() / 1000;
    const kvKey = `vrelay:${roomId}`;
    let buf = _voiceRelayMem.get(roomId) || (env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(kvKey, "json").catch(() => null) : null) || [];
    buf = (Array.isArray(buf) ? buf : []).filter((p) => p && (nowSec - Number(p.ts || 0)) < 10.0);
    if (request.method === "POST") {
      const b64 = String(b.b64 || "").replace(/\s+/g, "");
      if (!b64 || b64.length > 80000) return edgeJson({ ok: false, error: "Geçersiz ses paketi" }, 400, relayHdrs);
      const seq = Math.max(0, Math.min(999999999, Number(b.seq || 0) || 0));
      let mime = cleanStr(b.mime || "audio/wav", 32);
      if (!mime.startsWith("audio/")) mime = "audio/wav";
      const pkt = { id: `${cid}_${seq}_${Date.now()}`, fromId: cid, seq, ts: Math.round(nowSec * 10000) / 10000, mime, b64 };
      buf.push(pkt);
      buf = buf.slice(-64);
      _voiceRelayMem.set(roomId, buf);
      if (env?.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(kvKey, JSON.stringify(buf), { expirationTtl: 60 }).catch(() => {});
      return edgeJson({ ok: true, ts: pkt.ts }, 200, relayHdrs);
    }
    const sinceTs = Number(url.searchParams.get("sinceTs") || 0) || 0;
    const outPkts = buf.filter((p) => p.fromId !== cid && Number(p.ts || 0) > sinceTs);
    return edgeJson({ ok: true, serverTime: Math.round(nowSec * 10000) / 10000, packets: outPkts }, 200, relayHdrs);
  }

  if (safePath === "/api/rave/tts") {
    const rawTxt = cleanStr(url.searchParams.get("q") || url.searchParams.get("text"), 220);
    const lang = cleanStr(url.searchParams.get("lang") || "tr", 5).toLowerCase() || "tr";
    if (!rawTxt) return edgeJson({ ok: false, error: "Metin gerekli." }, 400);
    try {
      const r = await fetch(`https://translate.googleapis.com/translate_tts?${new URLSearchParams({ ie: "UTF-8", client: "tw-ob", tl: lang, q: rawTxt })}`, {
        headers: { "User-Agent": EDGE_UA, Referer: "https://translate.google.com/" },
        signal: AbortSignal.timeout(4000),
      });
      if (r.ok) {
        const audioBuf = await r.arrayBuffer();
        if (audioBuf.byteLength > 0) {
          return new Response(audioBuf, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" },
          });
        }
      }
    } catch {}
    return edgeJson({ ok: false, code: "origin_required", error: "TTS ses sentezi kenar sunucuda kullanılamıyor.", mode: "cf-autonomous-edge" }, 503);
  }

  if (safePath === "/api/rave/yt-music-stream" || safePath === "/api/rave/yt-pip-hls.m3u8" || safePath === "/api/rave/yt-pip-track.m3u8") {
    return edgeJson({
      ok: false,
      code: "origin_required",
      error: "Bu doğrudan medya akışı kaynak sunucu gerektirir.",
      mode: "cf-autonomous-edge",
    }, 503);
  }

  if (safePath === "/api/rave/poster-proxy") {
    return new Response(null, { status: 302, headers: { Location: "/static/watchlivo-poster.svg", "Cache-Control": "no-store" } });
  }
  if (safePath === "/api/rave/ai-status") {
    return edgeJson({ ok: true, engines: [{ id: "edge-local", name: "Edge Local", configured: false }], mode: "cf-autonomous-edge" });
  }
  if (safePath === "/api/upload" || safePath === "/api/rave/ai-chat" || safePath === "/api/rave/suno-generate") {
    const authRes = await resolveMemberUser(request, env);
    if (authRes.storageError) return edgeJson({ ok: false, error: "storage_unavailable", storageError: true }, 503);
    const { user } = authRes;
    if (!user) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    return edgeJson({ ok: false, error: "not_implemented_on_edge" }, 501);
  }
  if (safePath === "/api/rave/accounts/login") {
    return edgeJson({ ok: false, code: "unsupported", error: "Üçüncü taraf hesap doğrulaması kenar sunucuda desteklenmiyor." }, 501);
  }
  if (safePath === "/api/rave/accounts") {
    return edgeJson({ ok: true, accounts: { netflix: { accountEmail: "", cookies: [], connected: false } }, mode: "cf-autonomous-edge" });
  }
  if (safePath === "/api/rave/analytics") {
    return edgeJson({ ok: true, recorded: true, mode: "cf-autonomous-edge" });
  }
  if (safePath.startsWith("/api/")) {
    return edgeJson({ ok: false, error: "not_found" }, 404);
  }

  return await serveSpaIndex(env, request.method);
}
