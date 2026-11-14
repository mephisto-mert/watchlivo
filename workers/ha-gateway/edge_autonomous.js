import {
  handleEdgeResolveCatalog,
  handleEdgeHlsManifest,
  handleEdgeStreamProxy,
  handleEdgeSubtitle,
  handleEdgePoster,
} from "./edge_streams.js";
import {
  handleEdgeRoomCreate,
  handleEdgeRoomSync,
  handleEdgeRoomWs,
} from "./edge_rooms.js";
import { handleEdgeMusicRoute } from "./edge_music.js";

let _bootCache = null;
let _curatedMap = null;
const _edgeSearchCache = new Map();
let _blockedCache = { ts: 0, set: new Set() };
const DEFAULT_TMDB_KEY = "4f042878f22ef63cb94f25e60cb4ec6e";

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
  return { version: "20261114_v215", catalog: [], curatedRooms: DEFAULT_CURATED_LIVE_ROOMS, newReleases: [], latestEpisodes: [] };
}

function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

function extractSessionToken(request) {
  const authHdr = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const cookieStr = request.headers.get("Cookie") || "";
  const cookieMatch = cookieStr.match(/(?:^|;\s*)wl_auth=([^;]+)/);
  const raw = authHdr || (cookieMatch ? decodeURIComponent(cookieMatch[1]) : "");
  return raw.trim();
}

async function resolveAuthUser(request, env) {
  const tok = extractSessionToken(request);
  if (!tok) return { user: null, token: "", invalidToken: false };
  if (tok.length < 16 || !env?.WATCHLIVO_KV) return { user: null, token: tok, invalidToken: true };
  const user = await env.WATCHLIVO_KV.get(`session:${tok}`, "json").catch(() => null);
  return { user, token: tok, invalidToken: !user };
}

function buildCuratedLiveTvRooms() {
  const wrapUrl = (u) => ["ercdn.net", "daioncdn.net", "radyotvonline."].some((d) => u.includes(d))
    ? `/api/rave/stream?u=${encodeURIComponent(u)}&proxy_segs=1&ext=.m3u8`
    : u;
  const tvSpecs = [
    ["trt1", "TRT 1", "https://tv-trt1.medya.trt.com.tr/master.m3u8"],
    ["atv", "ATV", "https://trkvz-live.daioncdn.net/atv/atv.m3u8"],
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
      id: `tv-${rid}`, name: `7/24 ${name} Canlı Yayın`, creator: "Watchlivo Canlı TV", privacy: "public", playMode: "leader", curated: true,
      media: { provider: "hls", streamType: "hls", title: `📺 ${name} · Canlı Yayın`, url: playU, altUrls: playU !== u ? [u] : [], channel: "Canlı TV · 7/24", thumbnail: "/static/watchlivo-poster.svg", live: true, mediaType: "live", duration: 0 },
    };
  });
  const radioSpecs = [
    ["radyo-power-turk", "Power Türk", "https://live.powerapp.com.tr/powerturk/abr/powerturk/128/playlist.m3u8", "hls"],
    ["radyo-kral-fm", "Kral FM", "https://dygedge2.radyotvonline.net/kralfm/playlist.m3u8", "hls"],
    ["radyo-super-fm", "Süper FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/SUPER_FM_SC", "direct"],
    ["radyo-metro-fm", "Metro FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/METRO_FM_SC", "direct"],
    ["radyo-power-fm", "Power FM", "https://listen.powerapp.com.tr/powerfm/256/chunks.m3u8", "hls"],
    ["radyo-joy-turk", "Joy Türk", "https://playerservices.streamtheworld.com/api/livestream-redirect/JOY_TURK_SC", "direct"],
    ["radyo-slow-turk", "Slow Türk", "https://radyo1.radyo-dinle.tc/8062/stream", "direct"],
    ["radyo-best-fm", "Best FM", "https://ssldyg.radyotvonline.com/best/bestfm.stream/playlist.m3u8", "hls"],
    ["radyo-alem-fm", "Alem FM", "https://turkmedya.radyotvonline.com/turkmedya/alemfm.stream/playlist.m3u8", "hls"],
  ].map(([rid, name, u, kind]) => {
    const playU = kind === "hls" ? wrapUrl(u) : u;
    return {
      id: rid, name: `7/24 ${name} Canlı Radyo`, creator: "Watchlivo Canlı Radyo", privacy: "public", playMode: "leader", curated: true,
      media: { provider: kind, streamType: kind === "hls" ? "hls" : "mp3", title: `📻 ${name} · Canlı Radyo`, url: playU, altUrls: playU !== u ? [u] : [], channel: "Canlı Radyo · 7/24", thumbnail: "/static/watchlivo-poster.svg", live: true, isMusic: true, mediaType: "music", artist: name, songTitle: "Canlı Yayın", musicPlatformLabel: "Canlı Radyo", duration: 0 },
    };
  });
  return [...tvSpecs, ...radioSpecs];
}
const DEFAULT_CURATED_LIVE_ROOMS = buildCuratedLiveTvRooms();

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
  28: "aksiyon",
  12: "macera",
  16: "animasyon",
  35: "komedi",
  80: "suc",
  99: "belgesel",
  18: "dram",
  10751: "aile",
  14: "fantastik",
  36: "tarih",
  27: "korku",
  10402: "muzik",
  9648: "gizem",
  10749: "romantik",
  878: "bilim_kurgu",
  53: "gerilim",
  10752: "savas",
  37: "western",
  10759: "aksiyon",
  10765: "bilim_kurgu",
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
    const tag = TMDB_GENRE_TAGS[gid];
    if (tag && !cats.includes(tag)) cats.push(tag);
  }
  if (gids.includes(16) && (r.original_language === "ja" || gids.includes(10759) || gids.includes(10765))) {
    cats.push("anime");
  }
  return {
    id: `tmdb-${mt}-${tid}`,
    tmdbId: tid,
    title,
    originalTitle: orig,
    year: rel,
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

function matchesProviderAndCategory(x, provider, cat) {
  if (provider === "anime") {
    if (!((x.categories || []).includes("anime") || String(x.id || "").startsWith("ac-") || (Array.isArray(x.genreIds) && x.genreIds.includes(16) && x.origLang === "ja"))) {
      return false;
    }
  } else if (provider === "series") {
    if (!(x.mediaType === "tv" || (x.categories || []).includes("series"))) return false;
  } else if (provider === "movies") {
    if (!(x.mediaType === "movie" || (x.categories || []).includes("movies"))) return false;
  } else if (provider === "livetv" || provider === "tv") {
    if (!(x.live || provider === String(x.provider || "").toLowerCase() || (x.categories || []).includes("livetv"))) return false;
  }
  const cats = (x.categories || []).map((c) => String(c).toLowerCase());
  if (cat === "series" || cat === "diziler") {
    return x.mediaType === "tv" || cats.includes("series");
  }
  if (cat === "movies" || cat === "filmler") {
    return x.mediaType === "movie" || cats.includes("movies");
  }
  if (cat === "vizyon") {
    return Boolean(x.isVizyon || x.customRelease || cats.includes("vizyon") || Number(x.year || 0) >= 2025);
  }
  if (cat === "tr") {
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
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 48) || 48));
  const start = (page - 1) * limit;
  return { provider, query: q, page, total: list.length, totalAvailable: list.length, items: list.slice(start, start + limit), hasMore: list.length > start + limit };
}

async function handleEdgeCatalogSearch(boot, url, env) {
  const rawQ = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  if (rawQ.length < 2) return filterCatalog(boot.catalog, url);

  const { provider, cat, list: localAll } = filterCatalogUnpaged(boot.catalog, url);
  const tmdbHits = await searchTmdbEdge(rawQ, env);
  const filteredTmdb = tmdbHits.filter((x) => matchesProviderAndCategory(x, provider, cat));

  const seenIds = new Set();
  const merged = [];
  for (const it of [...localAll, ...filteredTmdb]) {
    const k = it.tmdbId ? `${it.mediaType}:${it.tmdbId}` : `t:${normalizeSearchText(it.title)}`;
    if (seenIds.has(k)) continue;
    seenIds.add(k);
    merged.push(it);
  }
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 48) || 48));
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

export async function handleAutonomousEdge(request, url, safePath, env) {
  const boot = await getBootstrap(env);

  // 1. Native WebSockets (/ws/<roomId>)
  if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket" && safePath.startsWith("/ws/")) {
    const roomId = decodeURIComponent(safePath.slice(4).split("/")[0] || "lobby");
    return await handleEdgeRoomWs(roomId, request, url, env);
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
  if (safePath === "/api/ios/version") {
    const rv = env?.ASSETS ? await env.ASSETS.fetch(new Request("https://assets.local/ios_version.json")) : null;
    if (rv?.ok) return edgeJson(await rv.json());
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
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // 4. Health & Diagnostics
  if (safePath === "/health" || safePath === "/api/health" || safePath === "/api/rave/server-health") {
    return edgeJson({ ok: true, version: boot.version, mode: "cf-autonomous-edge", sharedStore: true, vercel: false, activeRooms: boot.curatedRooms.length });
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
    const res = await handleEdgeCatalogSearch(boot, url, env);
    const filtered = blockedSet.size ? (res.items || []).filter((it) => !isItemBlocked(it, blockedSet)) : (res.items || []);
    return edgeJson({ query: res.query || "", tmdb: filtered, justwatch: [], youtube: [], items: filtered });
  }
  if (safePath === "/api/rave/new-releases") {
    const items = blockedSet.size ? boot.newReleases.filter((it) => !isItemBlocked(it, blockedSet)) : boot.newReleases;
    return edgeJson({ ok: true, items });
  }
  if (safePath === "/api/rave/latest-episodes") {
    const items = blockedSet.size ? boot.latestEpisodes.filter((it) => !isItemBlocked(it, blockedSet)) : boot.latestEpisodes;
    return edgeJson({ ok: true, items });
  }
  if (isSeasonsPath) {
    const rawId = (url.searchParams.get("id") || "").trim();
    let tid = (url.searchParams.get("tmdbId") || (/^\d+$/.test(rawId) ? rawId : "")).trim();
    const reqMediaType = (url.searchParams.get("mediaType") || url.searchParams.get("type") || "").trim().toLowerCase();
    if (reqMediaType === "movie") {
      return edgeJson({ ok: true, tmdbId: tid, mediaType: "movie", seasons: [], episodes: [] });
    }
    const qTitle = (url.searchParams.get("title") || "").trim();
    const sNum = Math.max(1, Number(url.searchParams.get("season") || url.searchParams.get("s") || 1) || 1);
    const cacheKey = `seasons:v2:${tid || rawId || qTitle.toLowerCase()}:${sNum}`;
    if (env?.WATCHLIVO_KV) {
      const cached = await env.WATCHLIVO_KV.get(cacheKey, "json").catch(() => null);
      if (cached && !cached.isFallback && Array.isArray(cached.seasons) && cached.seasons.length && Array.isArray(cached.episodes) && cached.episodes.length) {
        return edgeJson(cached);
      }
    }
    const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
    let acTitleObj = null;
    try {
      const acMatch = rawId.match(/^ac-(\d+)$/);
      if (!/^\d+$/.test(tid) && acMatch) {
        const acRes = await fetch(`https://animecix.tv/secure/titles/${acMatch[1]}?seasonNumber=${sNum}`, {
          headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://animecix.tv/" },
          signal: AbortSignal.timeout(3500),
        }).catch(() => null);
        if (acRes && acRes.ok) {
          const acJson = await acRes.json().catch(() => null);
          acTitleObj = acJson?.title || null;
          if (acTitleObj?.tmdb_id && /^\d+$/.test(String(acTitleObj.tmdb_id))) {
            tid = String(acTitleObj.tmdb_id);
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
      if (/^\d+$/.test(tid)) {
        const [tvResp, seaResp] = await Promise.all([
          fetch(`https://api.themoviedb.org/3/tv/${tid}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(3500) }),
          fetch(`https://api.themoviedb.org/3/tv/${tid}/season/${sNum}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(3500) }),
        ]);
        const tvJson = tvResp.ok ? await tvResp.json() : {};
        let seaJson = seaResp.ok ? await seaResp.json() : {};
        if (!Array.isArray(seaJson.episodes) || !seaJson.episodes.length) {
          const enResp = await fetch(`https://api.themoviedb.org/3/tv/${tid}/season/${sNum}?api_key=${encodeURIComponent(apiKey)}&language=en-US`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
          if (enResp && enResp.ok) {
            const enJson = await enResp.json().catch(() => null);
            if (Array.isArray(enJson?.episodes) && enJson.episodes.length) seaJson = enJson;
          }
        }
        seasons = (tvJson.seasons || []).filter((x) => Number(x.season_number) > 0 && Number(x.episode_count || 0) > 0).map((x) => ({
          season: x.season_number,
          name: x.name || `${x.season_number}. Sezon`,
          episodeCount: x.episode_count || 1,
        }));
        episodes = (seaJson.episodes || []).map((ep) => ({
          episode: ep.episode_number,
          name: ep.name || `${ep.episode_number}. Bölüm`,
          overview: ep.overview || "",
          still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : "",
        }));
      }
      if (!seasons.length && acTitleObj && Array.isArray(acTitleObj.seasons) && acTitleObj.seasons.length) {
        seasons = acTitleObj.seasons.filter((x) => Number(x.number || x.season_number || 0) > 0).map((x) => ({
          season: Number(x.number || x.season_number),
          name: `${Number(x.number || x.season_number)}. Sezon`,
          episodeCount: Number(x.episodes_count || x.episode_count || 1),
        }));
      }
      if (!episodes.length && acTitleObj?.season?.episodes?.length) {
        episodes = acTitleObj.season.episodes.map((ep, idx) => ({
          episode: Number(ep.episode_number || idx + 1),
          name: ep.name || `${Number(ep.episode_number || idx + 1)}. Bölüm`,
          overview: ep.description || "",
          still: ep.poster || "",
        }));
      }
      const isFallback = !seasons.length && !episodes.length;
      const out = {
        ok: true,
        tmdbId: tid,
        seasons: seasons.length ? seasons : [{ season: 1, name: "1. Sezon", episodeCount: episodes.length || 1 }],
        episodes: episodes.length ? episodes : [{ episode: 1, name: "1. Bölüm" }],
        ...(isFallback ? { isFallback: true } : {}),
      };
      if (env?.WATCHLIVO_KV && !isFallback) {
        await env.WATCHLIVO_KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 3600 }).catch(() => {});
      }
      return edgeJson(out);
    } catch {
      return edgeJson({ ok: true, seasons: [{ season: 1, name: "1. Sezon", episodeCount: 1 }], episodes: [{ episode: 1, name: "1. Bölüm" }], isFallback: true });
    }
  }
  if (safePath === "/api/rave/resolve-catalog" || safePath === "/api/rave/resolve-stream") {
    const reqTid = (url.searchParams.get("tmdbId") || url.searchParams.get("id") || "").trim();
    const reqMt = (url.searchParams.get("type") || url.searchParams.get("mediaType") || "movie").trim().toLowerCase() === "tv" ? "tv" : "movie";
    if (reqTid && (blockedSet.has(reqTid) || blockedSet.has(`${reqMt}:${reqTid}`))) {
      return edgeJson({ ok: false, error: "Bu içerik kaldırma talebi nedeniyle erişime kapatıldı." }, 404);
    }
    return await handleEdgeResolveCatalog(url, env, edgeJson);
  }
  if (safePath === "/api/rave/stream" || safePath === "/api/rave/stream_manifest" || safePath === "/api/rave/stream-manifest" || safePath === "/api/rave/hls-proxy") {
    return await handleEdgeHlsManifest(url, env);
  }
  if (safePath === "/api/rave/stream-proxy" || safePath === "/api/rave/stream_chunk") {
    return await handleEdgeStreamProxy(request, url, env);
  }
  if (safePath === "/api/rave/subtitle.vtt") {
    return await handleEdgeSubtitle(url, env);
  }
  if (safePath === "/api/rave/subtitles") {
    return edgeJson({ ok: true, subtitleTracks: [], audioTracks: [], intro: null, mode: "cf-autonomous-edge" });
  }
  if (safePath === "/api/rave/poster") {
    return await handleEdgePoster(url, env);
  }

  // 6. Rooms (24/7 Durable Object + KV + 21 Live TV Curated Rooms)
  if (safePath === "/api/rooms" || safePath === "/api/rave/meshes") {
    if (request.method === "POST") return await handleEdgeRoomCreate(request, env, edgeJson);
    const pub = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [] : [];
    const seen = new Set(pub.map((r) => r.id));
    const curated = (boot.curatedRooms && boot.curatedRooms.length) ? boot.curatedRooms : DEFAULT_CURATED_LIVE_ROOMS;
    const merged = [...pub, ...curated.filter((r) => !seen.has(r.id))];
    return edgeJson({ rooms: merged });
  }
  if (safePath === "/api/rooms/create") {
    return await handleEdgeRoomCreate(request, env, edgeJson);
  }
  const syncMatch = safePath.match(/^\/api\/(?:rooms|rave\/meshes)\/([^/]+)\/sync$/);
  if (syncMatch) {
    return await handleEdgeRoomSync(decodeURIComponent(syncMatch[1]), request, env, edgeJson, _curatedMap);
  }

  // 7. KV-backed Auth & Per-User Lists
  if (safePath === "/api/auth/me") {
    const authRes = await resolveAuthUser(request, env);
    if (authRes.user) return edgeJson({ ok: true, authenticated: true, user: authRes.user });
    if (authRes.invalidToken) return edgeJson({ ok: false, authenticated: false, user: null, error: "invalid_session" }, 401);
    return edgeJson({ ok: true, authenticated: false, user: null });
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
    const displayName = String(b.name || b.username || email.split("@")[0]).trim().slice(0, 40) || "Kullanıcı";
    const user = { id: uid, uid, email, name: displayName, username: displayName, color: "#27DCC8" };
    await env.WATCHLIVO_KV.put(`acct:${email}`, JSON.stringify({ user, passHash }));
    const nameKey = normalizeSearchText(displayName);
    if (nameKey && !(await env.WATCHLIVO_KV.get(`acct_name:${nameKey}`))) {
      await env.WATCHLIVO_KV.put(`acct_name:${nameKey}`, email);
    }
    const authToken = `${uid}_${makeNonce()}${makeNonce()}`;
    await env.WATCHLIVO_KV.put(`session:${authToken}`, JSON.stringify(user), { expirationTtl: 2592000 });
    return edgeJson({ ok: true, authToken, user }, 200, {
      "Set-Cookie": `wl_auth=${encodeURIComponent(authToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  if (safePath === "/api/auth/login" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    let ident = String(b.identifier || b.email || b.username || "").trim().toLowerCase();
    const pass = String(b.password || "");
    if (!ident || !pass) return edgeJson({ ok: false, error: "E-posta/kullanıcı adı ve şifre gerekli." }, 400);
    if (!ident.includes("@")) {
      const mappedEmail = await env.WATCHLIVO_KV.get(`acct_name:${normalizeSearchText(ident)}`);
      if (mappedEmail) ident = mappedEmail.trim().toLowerCase();
    }
    const rec = await env.WATCHLIVO_KV.get(`acct:${ident}`, "json");
    if (!rec || !(await verifyPasswordHash(pass, ident, rec.passHash))) {
      return edgeJson({ ok: false, error: "E-posta veya şifre hatalı." }, 401);
    }
    if (!String(rec.passHash || "").startsWith("pbkdf2_v1$")) {
      const upgraded = await hashPasswordPbkdf2(pass);
      await env.WATCHLIVO_KV.put(`acct:${ident}`, JSON.stringify({ user: rec.user, passHash: upgraded })).catch(() => {});
    }
    const authToken = `${rec.user.id}_${makeNonce()}${makeNonce()}`;
    await env.WATCHLIVO_KV.put(`session:${authToken}`, JSON.stringify(rec.user), { expirationTtl: 2592000 });
    return edgeJson({ ok: true, authToken, user: rec.user }, 200, {
      "Set-Cookie": `wl_auth=${encodeURIComponent(authToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  if (safePath === "/api/auth/logout") {
    const tok = extractSessionToken(request);
    if (tok && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.delete(`session:${tok}`).catch(() => {});
    }
    return edgeJson({ ok: true }, 200, {
      "Set-Cookie": "wl_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    });
  }
  if (safePath === "/api/user/progress" || safePath === "/api/user/watchlist" || safePath === "/api/user/music-history") {
    const { user } = await resolveAuthUser(request, env);
    if (!user) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    const kvKey = `ulist:${user.id}:${safePath.split("/").pop()}`;
    if (request.method === "GET") {
      const items = (env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(kvKey, "json") : null) || [];
      return edgeJson({ ok: true, authenticated: true, uid: user.id, items });
    }
    const body = await request.json().catch(() => ({}));
    if (body.action === "clear") {
      if (env?.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(kvKey, "[]");
      return edgeJson({ ok: true, authenticated: true, uid: user.id, items: [] });
    }
    const cur = (env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(kvKey, "json") : null) || [];
    const item = body.item || body;
    const itemKey = String(item.key || item.videoId || item.tmdbId || Date.now());
    const prev = cur.find((x) => String(x.key || x.videoId || x.tmdbId) === itemKey);
    const mergedEp = (prev?.epProgress || item?.epProgress)
      ? { ...(prev?.epProgress || {}), ...(item?.epProgress || {}) }
      : undefined;
    const nextItem = { ...prev, ...item, key: itemKey, ...(mergedEp ? { epProgress: mergedEp } : {}) };
    const next = body.action === "remove"
      ? cur.filter((x) => String(x.key || x.videoId || x.tmdbId) !== itemKey)
      : [nextItem, ...cur.filter((x) => String(x.key || x.videoId || x.tmdbId) !== itemKey)].slice(0, 100);
    if (env?.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(kvKey, JSON.stringify(next));
    return edgeJson({ ok: true, authenticated: true, uid: user.id, items: next });
  }

  const musicResp = await handleEdgeMusicRoute(request, url, safePath, env);
  if (musicResp) {
    return musicResp;
  }

  // 8. Explicit 503 for origin-dependent media extraction / unresolved origin routes
  if (safePath === "/api/rave/extract-video" || safePath === "/api/rave/resolve-music") {
    return edgeJson({
      ok: false,
      error: "Medya çözümleme servisi geçici olarak meşgul, birkaç saniye sonra tekrar deneyin.",
      code: "origin_required",
      mode: "cf-autonomous-edge",
    }, 503);
  }
  if (safePath.startsWith("/api/")) {
    return edgeJson({ ok: true, items: [], friends: [], notifications: [], mode: "cf-autonomous-edge" });
  }

  return await serveSpaIndex(env, request.method);
}
