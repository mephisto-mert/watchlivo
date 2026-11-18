import {
  handleEdgeRoomCreate,
  handleEdgeRoomSync,
  handleEdgeRoomWs,
} from "./edge_rooms.js";
import { handleEdgeMusicRoute } from "./edge_music.js";

let _bootCache = null;
let _curatedMap = null;

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
  return { version: "", curatedRooms: DEFAULT_CURATED_LIVE_ROOMS };
}

function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildAppCsp(nonce) {
  return [
    "default-src 'self'",
    "worker-src 'self' blob:",
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
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
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

// Curated 7/24 radio rooms: only stations' own public, directly playable streams (no re-streaming/proxying).
function buildCuratedRadioRooms() {
  const radioSpecs = [
    ["radyo-power-turk", "Power Türk", "https://live.powerapp.com.tr/powerturk/abr/powerturk/128/playlist.m3u8", "hls"],
    ["radyo-super-fm", "Süper FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/SUPER_FM_SC", "direct"],
    ["radyo-metro-fm", "Metro FM", "https://playerservices.streamtheworld.com/api/livestream-redirect/METRO_FM_SC", "direct"],
    ["radyo-power-fm", "Power FM", "https://listen.powerapp.com.tr/powerdance/abr/powerdance/128/playlist.m3u8", "hls"],
    ["radyo-joy-turk", "Joy Türk", "https://playerservices.streamtheworld.com/api/livestream-redirect/JOY_TURK_SC", "direct"],
  ];
  return radioSpecs.map(([rid, name, u, kind]) => ({
    id: rid, name: `7/24 ${name} Canlı Radyo`, creator: "Watchlivo Canlı Radyo", privacy: "public", playMode: "leader", curated: true,
    media: { provider: kind, streamType: kind === "hls" ? "hls" : "mp3", title: `📻 ${name} · Canlı Radyo`, url: u, altUrls: [], channel: "Canlı Radyo · 7/24", thumbnail: "/static/watchlivo-poster.svg", live: true, isMusic: true, mediaType: "music", artist: name, songTitle: "Canlı Yayın", musicPlatformLabel: "Canlı Radyo", duration: 0 },
  }));
}
const DEFAULT_CURATED_LIVE_ROOMS = buildCuratedRadioRooms();

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

export async function handleAutonomousEdge(request, url, safePath, env) {
  const boot = await getBootstrap(env);

  // 1. Native WebSockets (/ws/<roomId>)
  if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket" && safePath.startsWith("/ws/")) {
    const roomId = decodeURIComponent(safePath.slice(4).split("/")[0] || "lobby");
    return await handleEdgeRoomWs(roomId, request, url, env);
  }

  // 2. Robots.txt & SPA HTML routes & /r/<id> invite redirect
  if (safePath === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /$\nDisallow: /api/\nDisallow: /ws/\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
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
    if (safePath === "/manifest.json" || safePath === "/manifest.webmanifest") {
      return edgeJson({
        name: "Watchlivo — Birlikte Sinema, Dizi & Müzik Odaları",
        short_name: "Watchlivo",
        start_url: "/",
        display: "standalone",
        background_color: "#090c15",
        theme_color: "#090c15",
        icons: [{ src: "/static/watchlivo-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      }, 200, { "Content-Type": "application/manifest+json; charset=utf-8" });
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

  // 5. Rooms (24/7 Durable Object + KV + curated radio rooms)
  if (safePath === "/api/rooms" || safePath === "/api/rave/meshes") {
    if (request.method === "POST") return await handleEdgeRoomCreate(request, env, edgeJson);
    const rawPub = env?.WATCHLIVO_KV ? (await env.WATCHLIVO_KV.get("rooms:public_index", "json").catch(() => null)) || [] : [];
    const nowS = Math.floor(Date.now() / 1000);
    const pub = rawPub.filter((r) =>
      r && r.id && (
        r.curated ||
        (Number(r.participantCount || r.count || 0) > 0 && Number(r.updatedAt || 0) > 0 && (nowS - Number(r.updatedAt)) < 120)
      )
    );
    if (pub.length !== rawPub.length && env?.WATCHLIVO_KV) {
      await env.WATCHLIVO_KV.put("rooms:public_index", JSON.stringify(pub), { expirationTtl: 21600 }).catch(() => {});
    }
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
  if ((safePath === "/api/auth/register" || safePath === "/api/auth/login" || safePath === "/api/auth/oauth") && request.method === "POST" && env?.WATCHLIVO_KV) {
    const ip = (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim();
    const bucket = Math.floor(Date.now() / 60000);
    const ipHash = (await sha256Hex(ip)).slice(0, 16);
    const rlKey = `rl:auth:${ipHash}:${bucket}`;
    const attempts = Number(await env.WATCHLIVO_KV.get(rlKey).catch(() => 0)) || 0;
    if (attempts >= 20) {
      return edgeJson({ ok: false, error: "Çok fazla deneme. Lütfen bir dakika sonra tekrar deneyin." }, 429);
    }
    await env.WATCHLIVO_KV.put(rlKey, String(attempts + 1), { expirationTtl: 120 }).catch(() => {});
  }
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
  if (safePath === "/api/auth/oauth" && request.method === "POST" && env?.WATCHLIVO_KV) {
    const b = await request.json().catch(() => ({}));
    const idToken = String(b.idToken || "").trim();
    if (!idToken) {
      return edgeJson({ ok: false, error: "Giriş doğrulanamadı. Lütfen sağlayıcı penceresinden giriş yapın." }, 401);
    }
    let fbEmail = "";
    let fbName = "";
    const fbApiKey = env?.FIREBASE_WEB_API_KEY || "AIzaSyAeyDRstvjN8c_D08U8CrqopcFT0_fz9fo";
    const provider = ["google", "apple", "phone", "firebase"].includes(String(b.provider || "").toLowerCase())
      ? String(b.provider).toLowerCase()
      : "google";
    try {
      const fbResp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(fbApiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(5500),
      });
      if (fbResp.ok) {
        const fbData = await fbResp.json().catch(() => ({}));
        const u0 = Array.isArray(fbData?.users) ? fbData.users[0] : null;
        if (u0) {
          if (u0.email && u0.emailVerified === true) {
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
    if (!fbEmail) {
      try {
        const gResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (gResp.ok) {
          const gInfo = await gResp.json().catch(() => ({}));
          const verified = gInfo.email_verified === true || gInfo.email_verified === "true";
          const expectedAud = String(env?.GOOGLE_CLIENT_ID || "").trim();
          const audOk = !expectedAud || String(gInfo.aud || "") === expectedAud;
          if (gInfo.email && verified && audOk) {
            fbEmail = String(gInfo.email).trim().toLowerCase();
            fbName = fbName || String(gInfo.name || gInfo.given_name || "").trim().slice(0, 40);
          }
        }
      } catch {}
    }
    if (!fbEmail) {
      return edgeJson({ ok: false, error: "Giriş doğrulanamadı. Lütfen tekrar deneyin." }, 401);
    }
    const expectedEmail = String(b.email || "").trim().toLowerCase();
    if (expectedEmail && expectedEmail.includes("@") && expectedEmail !== fbEmail) {
      return edgeJson({ ok: false, error: "Hesap e-postası doğrulanan kimlikle eşleşmiyor." }, 401);
    }
    let rec = await env.WATCHLIVO_KV.get(`acct:${fbEmail}`, "json").catch(() => null);
    let user = rec?.user || null;
    if (!user) {
      const uid = `u_${(await sha256Hex(fbEmail)).slice(0, 14)}`;
      const displayName = (fbName || String(b.name || "").trim() || fbEmail.split("@")[0] || "Kullanıcı").slice(0, 40);
      const handleBase = normalizeSearchText(displayName).replace(/\s+/g, "").slice(0, 18) || uid.slice(2, 10);
      user = {
        id: uid,
        uid,
        email: fbEmail,
        name: displayName,
        username: displayName,
        handle: handleBase,
        color: /^#[0-9a-fA-F]{6}$/.test(String(b.color || "")) ? b.color : "#27DCC8",
        provider,
        verified: true,
      };
      const pass = String(b.password || "");
      const passHash = pass.length >= 6 ? await hashPasswordPbkdf2(pass) : "";
      await env.WATCHLIVO_KV.put(`acct:${fbEmail}`, JSON.stringify({ user, passHash }));
      const nameKey = normalizeSearchText(displayName);
      if (nameKey && !(await env.WATCHLIVO_KV.get(`acct_name:${nameKey}`))) {
        await env.WATCHLIVO_KV.put(`acct_name:${nameKey}`, fbEmail);
      }
    }
    const authToken = `${user.id}_${makeNonce()}${makeNonce()}`;
    await env.WATCHLIVO_KV.put(`session:${authToken}`, JSON.stringify(user), { expirationTtl: 2592000 });
    return edgeJson({ ok: true, authToken, user }, 200, {
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

  // 8. Origin-dependent routes
  if (safePath === "/api/rave/resolve-music") {
    return edgeJson({
      ok: false,
      error: "Medya çözümleme servisi geçici olarak meşgul, birkaç saniye sonra tekrar deneyin.",
      code: "origin_required",
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
    const { user } = await resolveAuthUser(request, env);
    if (!user) return edgeJson({ ok: false, error: "Oturum gerekli." }, 401);
    return edgeJson({ ok: false, error: "not_implemented_on_edge" }, 501);
  }
  if (safePath === "/api/rave/accounts/login") {
    return edgeJson({ ok: false, code: "unsupported", error: "Üçüncü taraf hesap doğrulaması kenar sunucuda desteklenmiyor." }, 501);
  }
  if (safePath === "/api/rave/accounts") {
    return edgeJson({ ok: true, accounts: { netflix: { accountEmail: "", cookies: [], connected: false } }, mode: "cf-autonomous-edge" });
  }
  if (safePath === "/api/rave/social/state") {
    return edgeJson({ ok: true, friends: [], incomingRequests: [], outgoingRequests: [], roomInvites: [], onlineUsers: [], mode: "cf-autonomous-edge" });
  }
  if (safePath === "/api/rave/social/presence" || safePath === "/api/rave/analytics") {
    return edgeJson({ ok: true, recorded: true, mode: "cf-autonomous-edge" });
  }
  if (safePath.startsWith("/api/")) {
    return edgeJson({ ok: false, error: "not_found" }, 404);
  }

  return await serveSpaIndex(env, request.method);
}
