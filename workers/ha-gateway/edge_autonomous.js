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

let _bootCache = null;
let _curatedMap = null;
const _edgeSearchCache = new Map();
const DEFAULT_TMDB_KEY = "4f042878f22ef63cb94f25e60cb4ec6e";

async function getBootstrap(env) {
  if (_bootCache) return _bootCache;
  if (env?.ASSETS) {
    try {
      const r = await env.ASSETS.fetch(new Request("https://assets.local/_edge/bootstrap.json"));
      if (r.ok) {
        _bootCache = await r.json();
        _curatedMap = new Map((_bootCache.curatedRooms || []).map((rm) => [rm.id, rm]));
        return _bootCache;
      }
    } catch {}
  }
  return { version: "20261112_v208", catalog: [], curatedRooms: [], newReleases: [], latestEpisodes: [] };
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

async function resolveAuthUser(request, env) {
  if (!env?.WATCHLIVO_KV) return null;
  const authHdr = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const cookieStr = request.headers.get("Cookie") || "";
  const cookieMatch = cookieStr.match(/(?:^|;\s*)wl_auth=([^;]+)/);
  const tok = authHdr || (cookieMatch ? decodeURIComponent(cookieMatch[1]) : "");
  if (!tok || tok.length < 16) return null;
  return await env.WATCHLIVO_KV.get(`session:${tok}`, "json").catch(() => null);
}

async function serveSpaIndex(env, method = "GET") {
  if (!env?.ASSETS) return new Response("Watchlivo Edge Ready", { status: 200 });
  const r = await env.ASSETS.fetch(new Request("https://assets.local/index.html"));
  if (!r.ok) return new Response("Index missing", { status: 404 });
  const nonce = makeNonce();
  const rawHtml = await r.text();
  const html = rawHtml.replace(/<script(?![^>]*\bsrc=)/gi, `<script nonce="${nonce}"`);
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

function mapTmdbItem(r) {
  const mt = r.media_type === "tv" ? "tv" : "movie";
  const tid = String(r.id || "");
  const title = (r.title || r.name || "").trim();
  const orig = (r.original_title || r.original_name || title).trim();
  const rel = (r.release_date || r.first_air_date || "").slice(0, 4);
  const gids = Array.isArray(r.genre_ids) ? r.genre_ids : [];
  const cats = [mt === "tv" ? "series" : "movies"];
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
    const scoreA = (qa === normQ || qoa === normQ ? 10000 : (qa.includes(normQ) || qoa.includes(normQ) ? 2000 : 0)) + Math.min(a.voteCount || 0, 5000);
    const scoreB = (qb === normQ || qob === normQ ? 10000 : (qb.includes(normQ) || qob.includes(normQ) ? 2000 : 0)) + Math.min(b.voteCount || 0, 5000);
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

function filterCatalog(items, url) {
  const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim().toLowerCase();
  const normQ = normalizeSearchText(q);
  const altQ = normQ ? expandTurkishPhoneticQuery(q) : "";
  const cat = (url.searchParams.get("category") || url.searchParams.get("genre") || "all").trim().toLowerCase();
  const provider = (url.searchParams.get("provider") || "cinema").trim().toLowerCase();
  let list = items;
  if (provider === "anime") {
    list = list.filter((x) => (x.categories || []).includes("anime") || String(x.id || "").startsWith("ac-"));
  } else if (provider === "series" || cat === "series" || cat === "diziler") {
    list = list.filter((x) => x.mediaType === "tv" || (x.categories || []).includes("series"));
  } else if (cat === "movies" || cat === "filmler") {
    list = list.filter((x) => x.mediaType === "movie" || (x.categories || []).includes("movies"));
  } else if (cat && cat !== "all" && cat !== "recommended" && cat !== "for_you" && cat !== "vizyon") {
    list = list.filter((x) => (x.categories || []).map((c) => String(c).toLowerCase()).includes(cat));
  }
  if (normQ) {
    list = list.filter((x) => {
      const t = normalizeSearchText(x.title);
      const ot = normalizeSearchText(x.originalTitle);
      const gl = normalizeSearchText(x.genreLabel);
      return t.includes(normQ) || ot.includes(normQ) || gl.includes(normQ) || (altQ && (t.includes(altQ) || ot.includes(altQ)));
    });
  }
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 48) || 48));
  const start = (page - 1) * limit;
  return { provider, query: q, page, total: list.length, totalAvailable: list.length, items: list.slice(start, start + limit), hasMore: list.length > start + limit };
}

async function handleEdgeCatalogSearch(boot, url, env) {
  const rawQ = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  const localRes = filterCatalog(boot.catalog, url);
  if (rawQ.length < 2) return localRes;

  const tmdbHits = await searchTmdbEdge(rawQ, env);
  if (!tmdbHits.length) return localRes;

  const cat = (url.searchParams.get("category") || url.searchParams.get("genre") || "all").trim().toLowerCase();
  const provider = (url.searchParams.get("provider") || "cinema").trim().toLowerCase();
  let filteredTmdb = tmdbHits;
  if (provider === "anime") {
    filteredTmdb = filteredTmdb.filter((x) => (x.categories || []).includes("anime") || x.origLang === "ja");
  } else if (provider === "series" || cat === "series" || cat === "diziler") {
    filteredTmdb = filteredTmdb.filter((x) => x.mediaType === "tv");
  } else if (cat === "movies" || cat === "filmler") {
    filteredTmdb = filteredTmdb.filter((x) => x.mediaType === "movie");
  }

  const seenIds = new Set();
  const merged = [];
  for (const it of [...localRes.items, ...filteredTmdb]) {
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

  // 2. SPA HTML routes & /r/<id> invite redirect
  if (safePath.startsWith("/r/") || safePath.startsWith("/join/")) {
    const seg = safePath.replace(/^\/(?:r|join)\//, "").split("/")[0] || "";
    if (seg) {
      return new Response(null, {
        status: 302,
        headers: { Location: `/#/mesh/${encodeURIComponent(seg)}`, "Cache-Control": "no-store" },
      });
    }
  }
  if (safePath === "/" || safePath === "/index.html" || safePath.startsWith("/r/") || safePath.startsWith("/join/")) {
    return await serveSpaIndex(env, request.method);
  }

  // 3. Version & Static Assets via Cloudflare Workers Assets binding
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
        if (assetPath.endsWith("sw.js") || assetPath.endsWith(".json")) h.set("Cache-Control", "no-store");
        else h.set("Cache-Control", "public, max-age=86400");
        return new Response(request.method === "HEAD" ? null : ar.body, { status: 200, headers: h });
      }
    }
  }

  // 4. Health & Diagnostics
  if (safePath === "/api/health" || safePath === "/api/rave/server-health") {
    return edgeJson({ ok: true, version: boot.version, mode: "cf-autonomous-edge", sharedStore: true, vercel: false, activeRooms: boot.curatedRooms.length });
  }

  // 5. Catalog, Search & Streams
  if (safePath === "/api/rave/catalog") {
    return edgeJson(await handleEdgeCatalogSearch(boot, url, env));
  }
  if (safePath === "/api/rave/supersearch") {
    const res = await handleEdgeCatalogSearch(boot, url, env);
    return edgeJson({ query: res.query || "", tmdb: res.items || [], justwatch: [], youtube: [], items: res.items || [] });
  }
  if (safePath === "/api/rave/new-releases") {
    return edgeJson({ ok: true, items: boot.newReleases });
  }
  if (safePath === "/api/rave/latest-episodes") {
    return edgeJson({ ok: true, items: boot.latestEpisodes });
  }
  if (safePath === "/api/rave/seasons") {
    const tid = (url.searchParams.get("tmdbId") || url.searchParams.get("id") || "").trim();
    const sNum = Math.max(1, Number(url.searchParams.get("season") || 1) || 1);
    if (!/^\d+$/.test(tid)) return edgeJson({ ok: true, seasons: [{ season: 1, name: "1. Sezon", episodeCount: 1 }], episodes: [{ episode: 1, name: "1. Bölüm" }] });
    const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
    try {
      const [tvResp, seaResp] = await Promise.all([
        fetch(`https://api.themoviedb.org/3/tv/${tid}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(3000) }),
        fetch(`https://api.themoviedb.org/3/tv/${tid}/season/${sNum}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(3000) }),
      ]);
      const tvJson = tvResp.ok ? await tvResp.json() : {};
      const seaJson = seaResp.ok ? await seaResp.json() : {};
      const seasons = (tvJson.seasons || []).filter((x) => Number(x.season_number) > 0).map((x) => ({
        season: x.season_number,
        name: x.name || `${x.season_number}. Sezon`,
        episodeCount: x.episode_count || 1,
      }));
      const episodes = (seaJson.episodes || []).map((ep) => ({
        episode: ep.episode_number,
        name: ep.name || `${ep.episode_number}. Bölüm`,
        overview: ep.overview || "",
        still: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : "",
      }));
      return edgeJson({
        ok: true,
        tmdbId: tid,
        seasons: seasons.length ? seasons : [{ season: 1, name: "1. Sezon", episodeCount: episodes.length || 1 }],
        episodes: episodes.length ? episodes : [{ episode: 1, name: "1. Bölüm" }],
      });
    } catch {
      return edgeJson({ ok: true, seasons: [{ season: 1, name: "1. Sezon", episodeCount: 1 }], episodes: [{ episode: 1, name: "1. Bölüm" }] });
    }
  }
  if (safePath === "/api/rave/resolve-catalog" || safePath === "/api/rave/resolve-stream") {
    return await handleEdgeResolveCatalog(url, env, edgeJson);
  }
  if (safePath === "/api/rave/stream" || safePath === "/api/rave/stream_manifest" || safePath === "/api/rave/stream-manifest" || safePath === "/api/rave/hls-proxy") {
    return await handleEdgeHlsManifest(url, env);
  }
  if (safePath === "/api/rave/stream-proxy" || safePath === "/api/rave/stream_chunk") {
    return await handleEdgeStreamProxy(request, url);
  }
  if (safePath === "/api/rave/subtitle.vtt" || safePath === "/api/rave/subtitles") {
    return await handleEdgeSubtitle(url);
  }
  if (safePath === "/api/rave/poster") {
    return await handleEdgePoster(url, env);
  }

  // 6. Rooms (24/7 Durable Object + KV + 21 Live TV Curated Rooms)
  if (safePath === "/api/rooms" || safePath === "/api/rave/meshes") {
    if (request.method === "POST") return await handleEdgeRoomCreate(request, env, edgeJson);
    const pub = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [] : [];
    const seen = new Set(pub.map((r) => r.id));
    const merged = [...pub, ...boot.curatedRooms.filter((r) => !seen.has(r.id))];
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
    const user = await resolveAuthUser(request, env);
    return edgeJson(user ? { ok: true, authenticated: true, user } : { ok: true, authenticated: false, user: null });
  }
  if (safePath === "/api/auth/register" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const pass = String(b.password || "");
    if (!email || pass.length < 6) return edgeJson({ ok: false, error: "Geçerli e-posta ve en az 6 karakterli şifre girin." }, 400);
    const existing = await env.WATCHLIVO_KV.get(`acct:${email}`, "json");
    if (existing) return edgeJson({ ok: false, error: "Bu e-posta zaten kayıtlı." }, 409);
    const uid = `u_${(await sha256Hex(email)).slice(0, 14)}`;
    const passHash = await sha256Hex(`wl_salt_v1:${email}:${pass}`);
    const user = { id: uid, uid, email, name: String(b.name || email.split("@")[0]).slice(0, 40), color: "#27DCC8" };
    await env.WATCHLIVO_KV.put(`acct:${email}`, JSON.stringify({ user, passHash }));
    const authToken = `${uid}_${makeNonce()}${makeNonce()}`;
    await env.WATCHLIVO_KV.put(`session:${authToken}`, JSON.stringify(user), { expirationTtl: 2592000 });
    return edgeJson({ ok: true, authToken, user });
  }
  if (safePath === "/api/auth/login" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const rec = await env.WATCHLIVO_KV.get(`acct:${email}`, "json");
    const passHash = await sha256Hex(`wl_salt_v1:${email}:${String(b.password || "")}`);
    if (!rec || rec.passHash !== passHash) return edgeJson({ ok: false, error: "E-posta veya şifre hatalı." }, 401);
    const authToken = `${rec.user.id}_${makeNonce()}${makeNonce()}`;
    await env.WATCHLIVO_KV.put(`session:${authToken}`, JSON.stringify(rec.user), { expirationTtl: 2592000 });
    return edgeJson({ ok: true, authToken, user: rec.user });
  }
  if (safePath === "/api/auth/logout") {
    return edgeJson({ ok: true });
  }
  if (safePath === "/api/user/progress" || safePath === "/api/user/watchlist" || safePath === "/api/user/music-history") {
    const user = await resolveAuthUser(request, env);
    if (!user) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    const kvKey = `ulist:${user.id}:${safePath.split("/").pop()}`;
    if (request.method === "GET") {
      const items = (env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(kvKey, "json") : null) || [];
      return edgeJson({ ok: true, items });
    }
    const body = await request.json().catch(() => ({}));
    const cur = (env?.WATCHLIVO_KV ? await env.WATCHLIVO_KV.get(kvKey, "json") : null) || [];
    const item = body.item || body;
    const itemKey = String(item.key || item.videoId || item.tmdbId || Date.now());
    const next = body.action === "remove" ? cur.filter((x) => String(x.key || x.videoId || x.tmdbId) !== itemKey) : [{ ...item, key: itemKey }, ...cur.filter((x) => String(x.key || x.videoId || x.tmdbId) !== itemKey)].slice(0, 100);
    if (env?.WATCHLIVO_KV) await env.WATCHLIVO_KV.put(kvKey, JSON.stringify(next));
    return edgeJson({ ok: true, items: next });
  }

  // 8. Auxiliary endpoints graceful JSON response (analytics, social state, notifications)
  if (safePath.startsWith("/api/")) {
    return edgeJson({ ok: true, items: [], friends: [], notifications: [], mode: "cf-autonomous-edge" });
  }

  return await serveSpaIndex(env, request.method);
}
