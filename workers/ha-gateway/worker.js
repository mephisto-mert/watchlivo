/**
 * Watchlivo Multi-Cloud High-Availability Edge Gateway + Keep-Alive Cron (v135)
 *
 * Routes: watchlivo.online/*, www.watchlivo.online/*
 * Primary Origin:   Vercel (via Cloudflare Zone DNS -> 216.198.79.1)
 * Secondary Origin: Render EU Frankfurt (https://watchlivo-origin-eu.onrender.com)
 * Stream Proxy:     Cloudflare Service Binding STREAM_PROXY (watchlivo-stream-proxy)
 */

import { handleAutonomousEdge } from "./edge_autonomous.js";
export { WatchlivoRoomDO } from "./edge_rooms.js";

const DEFAULT_SECONDARY_ORIGIN = "https://watchlivo-origin-eu.onrender.com";
const DEFAULT_STREAM_PROXY_ORIGIN = "https://watchlivo-stream-proxy.watchlivo-edge.workers.dev";
const BYPASS_WORKER_HOSTS = [
  "hakunaymatata.com",
  "vidmoly.",
  "vmbox.",
  "vmnow.",
  "vmpx.",
  "hdfilmcehennemi.mobi",
  "ag2m5.cfd",
  "uk-traffic-",
  "fastplay.",
  "radyotvonline.com",
  "nexa.mov",
  "dplayer",
  "playmix.",
  "makesomthingup.",
  "cdnimages.",
  "ercdn.net",
  "daioncdn.net",
  "dragonballzfans",
  "molystream.org",
  "irtau1.",
  "lightspeed.st",
  "bright67.",
  "centralodsseyproud",
  "5d06cffcf9563c",
  "gamma.",
  ".click",
];
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const EDGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

function normalizeSafePath(pathname) {
  const raw = typeof pathname === "string" ? pathname : "/";
  const collapsed = raw.replace(/^\/+/, "/");
  return collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
}

function buildSafeOriginUrl(baseOrigin, pathname, searchStr = "") {
  const target = new URL(baseOrigin);
  target.pathname = normalizeSafePath(pathname);
  target.search = searchStr ? (searchStr.startsWith("?") ? searchStr : `?${searchStr}`) : "";
  return target;
}

const FAILOVER_STATUSES = new Set([
  402, 429, 451, 500, 502, 503, 504,
  520, 521, 522, 523, 524, 525, 526, 530,
]);

const VERCEL_PAUSE_TOKENS = [
  "DEPLOYMENT_PAUSED",
  "DEPLOYMENT_DISABLED",
  "DEPLOYMENT_NOT_FOUND",
  "PROJECT_PAUSED",
  "ACCOUNT_BLOCKED",
  "PAYMENT_REQUIRED",
  "FUNCTION_INVOCATION_FAILED",
  "FUNCTION_INVOCATION_TIMEOUT",
  "FUNCTION_THROTTLED",
  "EDGE_FUNCTION_INVOCATION_FAILED",
];

let primaryCircuitOpenUntil = 0;
let secondaryCircuitOpenUntil = 0;
let tunnelOfflineUntil = 0;

function hasAutonomousEdge(env) {
  return Boolean(env && (env.ASSETS || env.WATCHLIVO_KV || env.ROOM_DO));
}

async function runAutonomousFallback(request, url, safePath, bodyBuf, env) {
  const init = { method: request.method, headers: request.headers };
  if (bodyBuf !== null && bodyBuf !== undefined && request.method !== "GET" && request.method !== "HEAD") {
    init.body = bodyBuf;
  }
  const edgeReq = new Request(request.url, init);
  return await handleAutonomousEdge(edgeReq, url, safePath, env);
}

const MAX_BUFFER_BYTES = 262_144;

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAdminEdge(request, env) {
  const secret = (env.ADMIN_SECRET || env.EDGE_ORIGIN_SECRET || "").trim();
  if (!secret) return false;
  const hdr = (request.headers.get("x-admin-secret") || "").trim();
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return timingSafeEq(hdr, secret) || timingSafeEq(bearer, secret);
}

function isAppManagedError(resp) {
  if (!resp) return false;
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json");
}

function shouldFailoverResponse(resp) {
  if (!resp) return true;
  const vercelErr = (resp.headers.get("x-vercel-error") || "").toUpperCase();
  if (vercelErr && VERCEL_PAUSE_TOKENS.some((tok) => vercelErr.includes(tok))) {
    return true;
  }
  if (!vercelErr && resp.status === 429 && isAppManagedError(resp)) {
    return false;
  }
  return FAILOVER_STATUSES.has(resp.status);
}

function buildForwardHeaders(originalHeaders, clientIp, originalHost, targetHost, env, keepHost = false) {
  const h = new Headers(originalHeaders);
  if (!keepHost && targetHost) {
    h.set("Host", targetHost);
    if (targetHost.toLowerCase().includes("pinggy")) {
      h.set("X-Pinggy-No-Screen", "1");
    }
  }
  h.set("X-Forwarded-Host", originalHost);
  h.set("X-Forwarded-Proto", "https");
  h.delete("x-forwarded-for");
  h.delete("x-vercel-forwarded-for");
  h.delete("x-real-ip");
  h.delete("x-watchlivo-client-ip");
  h.delete("x-watchlivo-edge-secret");
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  if (clientIp) {
    h.set("X-Real-IP", clientIp);
    h.set("X-Forwarded-For", clientIp);
    h.set("X-Watchlivo-Client-IP", clientIp);
    const edgeSecret = (env?.EDGE_ORIGIN_SECRET || env?.ADMIN_SECRET || "").trim();
    if (edgeSecret) {
      h.set("X-Watchlivo-Edge-Secret", edgeSecret);
    }
  }
  return h;
}

function originTimeoutMs(pathname) {
  if (
    pathname.startsWith("/api/rave/resolve") ||
    pathname.startsWith("/api/rave/subtitles") ||
    pathname.startsWith("/api/rave/stream") ||
    pathname === "/api/upload"
  ) {
    return 18_000;
  }
  return 5_500;
}

function isStaticCacheablePath(pathname) {
  const p = normalizeSafePath(pathname);
  if (p === "/static/desktop-auth.html" || p === "/desktop-auth.html") {
    return false;
  }
  return (
    p.startsWith("/static/") ||
    p === "/favicon.ico" ||
    p === "/apple-touch-icon.png" ||
    p === "/apple-touch-icon-precomposed.png" ||
    p === "/manifest.json" ||
    p === "/manifest.webmanifest"
  );
}

function getEdgeCache() {
  try {
    return typeof caches !== "undefined" && caches?.default ? caches.default : null;
  } catch {
    return null;
  }
}

function buildGracefulOverloadResponse(request, url) {
  const accept = (request?.headers?.get?.("accept") || "").toLowerCase();
  const safePath = url ? normalizeSafePath(url.pathname) : "";
  if (safePath.startsWith("/api/") || accept.includes("application/json")) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Sunucu şu an yoğun, lütfen birkaç saniye içinde tekrar deneyin.",
        retryable: true,
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "2",
          "X-Watchlivo-Origin": "edge-fallback",
          ...EDGE_SECURITY_HEADERS,
        },
      }
    );
  }
  const nonceBytes = new Uint8Array(12);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const retryHref = url ? `${normalizeSafePath(url.pathname)}${url.search ? `${url.search}&_r=${Date.now()}` : `?_r=${Date.now()}`}` : `/?_r=${Date.now()}`;
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>Watchlivo — Bağlanıyor...</title><style>body{margin:0;background:#06090e;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.box{padding:28px;max-width:360px}.sp{width:36px;height:36px;border:3px solid rgba(39,220,200,.2);border-top-color:#27DCC8;border-radius:50%;animation:s .8s linear infinite;margin:0 auto 16px}@keyframes s{to{transform:rotate(360deg)}}h1{font-size:18px;margin:0 0 8px}p{font-size:13px;color:#8b949e;margin:0 0 18px}.btn{display:inline-block;padding:10px 20px;border-radius:10px;background:#27DCC8;color:#041014;font-weight:700;font-size:14px;text-decoration:none}</style></head><body><div class="box"><div class="sp"></div><h1>Watchlivo'ya bağlanılıyor...</h1><p>Yayın sunucusu hazırlanıyor, sayfa otomatik açılacak.</p><a class="btn" href="${retryHref}">Şimdi Bağlan</a></div><script nonce="${nonce}">(function(){var busy=false;function p(){if(busy)return;busy=true;fetch('/api/health?_t='+Date.now(),{cache:'no-store'}).then(function(r){if(r&&r.ok){var u=new URL(location.href);u.searchParams.set('_r',String(Date.now()));location.replace(u.toString());return;}busy=false;}).catch(function(){busy=false;});}setInterval(p,1500);setTimeout(p,600);})();</script></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Retry-After": "2",
      "X-Watchlivo-Origin": "edge-fallback",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'`,
      ...EDGE_SECURITY_HEADERS,
    },
  });
}

async function fetchOriginBase(baseOrigin, request, url, bodyBuf, env, originTag = "render-eu-failover") {
  const cleanBase = (baseOrigin || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
  const cleanSearch = new URLSearchParams(url.search);
  cleanSearch.delete("__simulate_vercel_pause");
  const qs = cleanSearch.toString();
  const safePath = normalizeSafePath(url.pathname);
  const secUrl = buildSafeOriginUrl(cleanBase, safePath, qs);
  const clientIp = request.headers.get("CF-Connecting-IP") || "";
  const headers = buildForwardHeaders(request.headers, clientIp, "watchlivo.online", secUrl.host, env, false);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(originTimeoutMs(safePath)),
  };
  if (bodyBuf !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = bodyBuf;
  }
  const resp = await fetch(secUrl.toString(), init);
  if (resp.status === 101) {
    return resp;
  }
  const outHeaders = new Headers(resp.headers);
  outHeaders.set("X-Watchlivo-Origin", originTag);
  const safeBody = NULL_BODY_STATUSES.has(resp.status) || request.method === "HEAD" ? null : resp.body;
  return new Response(safeBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: outHeaders,
  });
}

async function fetchSecondary(request, url, bodyBuf, env, originTag = "render-eu-failover") {
  const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
  const tertiaryBase = (env.TERTIARY_ORIGIN || "").trim().replace(/\/+$/, "");
  try {
    const resp = await fetchOriginBase(secondaryBase, request, url, bodyBuf, env, originTag);
    if (tertiaryBase && tertiaryBase !== secondaryBase && shouldFailoverResponse(resp)) {
      resp.body?.cancel?.();
      return await fetchOriginBase(tertiaryBase, request, url, bodyBuf, env, "tertiary-lhr-failover");
    }
    return resp;
  } catch (err) {
    if (tertiaryBase && tertiaryBase !== secondaryBase) {
      return await fetchOriginBase(tertiaryBase, request, url, bodyBuf, env, "tertiary-lhr-failover");
    }
    throw err;
  }
}

const BOT_UA_RE = /bot|crawl|spider|slurp|mediapartners|inspection|lighthouse|headless|facebookexternalhit|discordbot|telegrambot|whatsapp|twitterbot/i;

function canCloneForEdgeCache(resp) {
  const cc = (resp.headers.get("cache-control") || "").toLowerCase();
  if (cc.includes("private") || cc.includes("no-store")) return false;
  const clRaw = resp.headers.get("content-length");
  if (clRaw !== null) {
    const cl = Number(clRaw);
    if (!Number.isFinite(cl) || cl < 0 || cl > 8_388_608) return false;
    return true;
  }
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  return (
    ct.includes("text/") ||
    ct.includes("javascript") ||
    ct.includes("json") ||
    ct.includes("svg") ||
    ct.includes("manifest")
  );
}

async function readBoundedBody(request, maxBytes) {
  if (!request.body) return { buf: new ArrayBuffer(0), overflowStream: null };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > maxBytes) {
      let idx = 0;
      const overflowStream = new ReadableStream({
        pull(controller) {
          if (idx < chunks.length) {
            controller.enqueue(chunks[idx++]);
            return;
          }
          return reader.read().then(({ done: rDone, value: rVal }) => {
            if (rDone) controller.close();
            else controller.enqueue(rVal);
          });
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { buf: null, overflowStream };
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { buf: merged.buffer, overflowStream: null };
}

async function fetchPrimary(request, url, bodyBuf, env) {
  const safePath = normalizeSafePath(url.pathname);
  const clientIp = request.headers.get("CF-Connecting-IP") || "";
  const primaryHeaders = buildForwardHeaders(
    request.headers,
    clientIp,
    "watchlivo.online",
    url.host,
    env,
    true
  );
  const primaryInit = {
    method: request.method,
    headers: primaryHeaders,
    redirect: "manual",
    signal: AbortSignal.timeout(originTimeoutMs(safePath)),
  };
  if (bodyBuf !== null && request.method !== "GET" && request.method !== "HEAD") {
    primaryInit.body = bodyBuf;
  }
  const primaryResp = await fetch(request.url, primaryInit);
  if (primaryResp.status === 101) {
    return primaryResp;
  }
  const outHeaders = new Headers(primaryResp.headers);
  outHeaders.set("X-Watchlivo-Origin", "vercel-primary");
  const safePrimaryBody = NULL_BODY_STATUSES.has(primaryResp.status) || request.method === "HEAD" ? null : primaryResp.body;
  return new Response(safePrimaryBody, {
    status: primaryResp.status,
    statusText: primaryResp.statusText,
    headers: outHeaders,
  });
}

async function safeFetchSecondary(
  request,
  url,
  bodyBuf,
  env,
  originTag = "render-eu-failover",
  ctx = null,
  allowPrimaryFallback = true
) {
  const isIdempotent = request.method === "GET" || request.method === "HEAD";
  const maxAttempts = isIdempotent ? 2 : 1;
  const cache = getEdgeCache();
  const safePath = normalizeSafePath(url.pathname);
  if (hasAutonomousEdge(env) && (url.searchParams.get("__edge_only") === "1" || Date.now() < tunnelOfflineUntil)) {
    return await runAutonomousFallback(request, url, safePath, bodyBuf, env);
  }
  const ua = request.headers.get("user-agent") || "";
  const isBotUa = BOT_UA_RE.test(ua);
  const rootCacheKey = isIdempotent && safePath === "/" && !isBotUa ? new Request("https://edge-cache.watchlivo.internal/__root_shell__", { method: "GET" }) : null;
  const staticCacheKey = isIdempotent && isStaticCacheablePath(safePath) ? new Request(`https://edge-cache.watchlivo.internal${safePath}${url.search}`, { method: "GET" }) : null;

  let sawExplicitSuspension = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetchSecondary(request, url, bodyBuf, env, originTag);
      const renderRouting = (resp.headers.get("x-render-routing") || "").toLowerCase();
      if (renderRouting.includes("suspend") || resp.status === 530) {
        sawExplicitSuspension = true;
        resp.body?.cancel?.();
        break;
      }
      if (resp.status >= 502 && resp.status <= 504 && attempt + 1 < maxAttempts) {
        resp.body?.cancel?.();
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (shouldFailoverResponse(resp)) {
        if (resp.status === 503) sawExplicitSuspension = true;
        resp.body?.cancel?.();
        break;
      }
      if (cache && request.method === "GET" && resp.status === 200 && canCloneForEdgeCache(resp)) {
        try {
          if (staticCacheKey) {
            const clone = resp.clone();
            const cHdrs = new Headers(clone.headers);
            const hasVersion = url.search.includes("v=");
            cHdrs.set(
              "Cache-Control",
              hasVersion
                ? "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400"
                : "public, max-age=300, s-maxage=900, stale-while-revalidate=600"
            );
            const cachePut = cache.put(staticCacheKey, new Response(clone.body, { status: 200, headers: cHdrs })).catch(() => {});
            ctx?.waitUntil?.(cachePut);
          } else if (rootCacheKey && !resp.headers.get("set-cookie")) {
            const clone = resp.clone();
            const cHdrs = new Headers(clone.headers);
            cHdrs.set("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
            const cachePut = cache.put(rootCacheKey, new Response(clone.body, { status: 200, headers: cHdrs })).catch(() => {});
            ctx?.waitUntil?.(cachePut);
          }
        } catch {}
      }
      tunnelOfflineUntil = 0;
      return resp;
    } catch (_err) {
      if (attempt + 1 < maxAttempts) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
    }
  }

  if (env.FORCE_SECONDARY !== "1") {
    if (sawExplicitSuspension) {
      secondaryCircuitOpenUntil = Date.now() + 60_000;
    } else if (!safePath.startsWith("/api/rave/resolve") && !safePath.startsWith("/api/rave/stream")) {
      secondaryCircuitOpenUntil = Date.now() + 15_000;
    }
  }

  if (allowPrimaryFallback && !url.hostname.endsWith(".workers.dev") && Date.now() >= primaryCircuitOpenUntil) {
    try {
      const primaryFallbackResp = await fetchPrimary(request, url, bodyBuf, env);
      if (!shouldFailoverResponse(primaryFallbackResp)) {
        return primaryFallbackResp;
      }
      primaryFallbackResp.body?.cancel?.();
      primaryCircuitOpenUntil = Date.now() + 60_000;
    } catch {
      primaryCircuitOpenUntil = Date.now() + 60_000;
    }
  }

  if (hasAutonomousEdge(env)) {
    tunnelOfflineUntil = Date.now() + 25_000;
    return await runAutonomousFallback(request, url, safePath, bodyBuf, env);
  }

  if (cache && isIdempotent) {
    try {
      const fallbackKey = staticCacheKey || rootCacheKey;
      if (fallbackKey) {
        const hit = await cache.match(fallbackKey);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set("X-Watchlivo-Origin", "edge-stale-cache");
          return new Response(request.method === "HEAD" ? null : hit.body, { status: 200, headers: h });
        }
      }
    } catch {}
  }
  return buildGracefulOverloadResponse(request, url);
}

export default {
  async fetch(request, env, ctx) {
    let url = null;
    try {
      url = new URL(request.url);
      const safePath = normalizeSafePath(url.pathname);

      // 1. Canonical www -> apex redirect
      if (url.hostname === "www.watchlivo.online") {
        const redirectUrl = new URL("https://watchlivo.online");
        redirectUrl.pathname = safePath;
        redirectUrl.search = url.search;
        return Response.redirect(redirectUrl.toString(), 308);
      }

      // 2. Gateway diagnostic endpoint
      if (safePath === "/api/ha-status") {
        const adminOk = isAdminEdge(request, env);
        const statusPayload = {
          ok: true,
          gateway: "watchlivo-ha-gateway-v196",
          primaryCircuitOpen: Date.now() < primaryCircuitOpenUntil,
          secondaryCircuitOpen: Date.now() < secondaryCircuitOpenUntil,
          hasStreamBinding: Boolean(env.STREAM_PROXY),
        };
        if (adminOk) {
          statusPayload.secondaryOrigin = env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN;
          statusPayload.streamProxyOrigin = env.STREAM_PROXY_ORIGIN || DEFAULT_STREAM_PROXY_ORIGIN;
        }
        return new Response(JSON.stringify(statusPayload), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...EDGE_SECURITY_HEADERS,
          },
        });
      }

      // 2b. Fast Edge Cache hit for static assets (/static/*, icons, manifest)
      const edgeCache = getEdgeCache();
      if (edgeCache && (request.method === "GET" || request.method === "HEAD") && isStaticCacheablePath(safePath)) {
        try {
          const staticKey = new Request(`https://edge-cache.watchlivo.internal${safePath}${url.search}`, { method: "GET" });
          const cachedStatic = await edgeCache.match(staticKey);
          if (cachedStatic) {
            const h = new Headers(cachedStatic.headers);
            h.set("X-Watchlivo-Origin", "edge-static-cache");
            return new Response(request.method === "HEAD" ? null : cachedStatic.body, { status: 200, headers: h });
          }
        } catch {}
      }

      // 3. Direct zero-egress offload via Service Binding (0ms RPC) for APK/IPA, stream-proxy, and edge-fetch
      const isBinaryDownload =
        safePath === "/download/apk" ||
        safePath === "/download/ipa" ||
        /^\/download\/Watchlivo.*\.(apk|ipa)$/i.test(safePath);
      const isEdgeFetchPath = safePath === "/api/rave/edge-fetch";
      const isStreamProxyPath =
        safePath === "/api/rave/stream-proxy" ||
        safePath === "/api/rave/stream_chunk" ||
        isEdgeFetchPath;
      if (isBinaryDownload || isStreamProxyPath) {
        const cfFallback = url.searchParams.get("cf_fb") === "1";
        let bypassWorker = cfFallback;
        if (!bypassWorker && isStreamProxyPath && !isEdgeFetchPath) {
          const rawTarget = (url.searchParams.get("url") || url.searchParams.get("u") || "").trim();
          const rawLower = rawTarget.toLowerCase();
          bypassWorker = BYPASS_WORKER_HOSTS.some((h) => rawLower.includes(h));
        }
        if (!bypassWorker) {
          if (env.STREAM_PROXY) {
            try {
              return await env.STREAM_PROXY.fetch(request);
            } catch {
              if (isEdgeFetchPath) {
                return new Response(JSON.stringify({ ok: false, error: "Kenar servisi geçici olarak meşgul." }), {
                  status: 502,
                  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...EDGE_SECURITY_HEADERS },
                });
              }
              return await safeFetchSecondary(request, url, null, env, "render-eu-stream-fallback", ctx);
            }
          }
          return await safeFetchSecondary(request, url, null, env, "tunnel-stream-proxy", ctx);
        }
      }

      // 4. Native WebSockets (/ws/*) -> route directly to stateful ASGI Secondary Origin (Render)
      const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
      if (upgrade === "websocket") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "GET", "Cache-Control": "no-store", ...EDGE_SECURITY_HEADERS },
          });
        }
        if (env.FORCE_SECONDARY !== "1" && Date.now() < secondaryCircuitOpenUntil) {
          return new Response("WebSocket origin temporarily unavailable", {
            status: 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "5", ...EDGE_SECURITY_HEADERS },
          });
        }
        if (hasAutonomousEdge(env) && (url.searchParams.get("__edge_only") === "1" || Date.now() < tunnelOfflineUntil)) {
          return await handleAutonomousEdge(request, url, safePath, env);
        }
        const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
        const tertiaryBase = (env.TERTIARY_ORIGIN || "").trim().replace(/\/+$/, "");
        const wsCandidates = [secondaryBase];
        if (tertiaryBase && tertiaryBase !== secondaryBase) wsCandidates.push(tertiaryBase);
        const clientIp = request.headers.get("CF-Connecting-IP") || "";
        for (let wi = 0; wi < wsCandidates.length; wi++) {
          const wsTarget = buildSafeOriginUrl(wsCandidates[wi], safePath, url.search);
          const wsHeaders = buildForwardHeaders(
            request.headers,
            clientIp,
            "watchlivo.online",
            wsTarget.host,
            env,
            false
          );
          wsHeaders.set("Upgrade", "websocket");
          try {
            const wsResp = await fetch(wsTarget.toString(), {
              method: "GET",
              headers: wsHeaders,
            });
            if (wsResp.status >= 502) {
              wsResp.body?.cancel?.();
              if (wi + 1 < wsCandidates.length) continue;
              if (hasAutonomousEdge(env)) {
                tunnelOfflineUntil = Date.now() + 25_000;
                return await handleAutonomousEdge(request, url, safePath, env);
              }
              if (safePath.startsWith("/ws/") && env.FORCE_SECONDARY !== "1") {
                secondaryCircuitOpenUntil = Date.now() + 15_000;
              }
              return new Response("WebSocket origin unreachable", { status: 503, headers: { "Cache-Control": "no-store", ...EDGE_SECURITY_HEADERS } });
            }
            tunnelOfflineUntil = 0;
            return wsResp;
          } catch {
            if (wi + 1 < wsCandidates.length) continue;
          }
        }
        if (hasAutonomousEdge(env)) {
          tunnelOfflineUntil = Date.now() + 25_000;
          return await handleAutonomousEdge(request, url, safePath, env);
        }
        if (safePath.startsWith("/ws/") && env.FORCE_SECONDARY !== "1") {
          secondaryCircuitOpenUntil = Date.now() + 15_000;
        }
        return new Response("WebSocket origin unreachable", {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "5", ...EDGE_SECURITY_HEADERS },
        });
      }

      // 5. Buffer small non-streaming request bodies (<= 256 KB) safely; stream larger/chunked payloads directly
      let bodyBuf = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        const contentLen = parseInt(request.headers.get("content-length") || "0", 10);
        const streamLargeToSecondary = async (streamBody) => {
          const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
          const secUrl = buildSafeOriginUrl(secondaryBase, safePath, url.search);
          const headers = buildForwardHeaders(
            request.headers,
            request.headers.get("CF-Connecting-IP") || "",
            "watchlivo.online",
            secUrl.host,
            env,
            false
          );
          try {
            const resp = await fetch(secUrl.toString(), {
              method: request.method,
              headers,
              body: streamBody,
              redirect: "manual",
              signal: AbortSignal.timeout(28_000),
            });
            if (resp.status === 101) return resp;
            const outH = new Headers(resp.headers);
            outH.set("X-Watchlivo-Origin", "render-eu-stream-upload");
            return new Response(NULL_BODY_STATUSES.has(resp.status) ? null : resp.body, {
              status: resp.status,
              statusText: resp.statusText,
              headers: outH,
            });
          } catch {
            return buildGracefulOverloadResponse(request, url);
          }
        };

        if (!Number.isNaN(contentLen) && contentLen > MAX_BUFFER_BYTES) {
          return await streamLargeToSecondary(request.body);
        }
        try {
          const { buf, overflowStream } = await readBoundedBody(request, MAX_BUFFER_BYTES);
          if (overflowStream) {
            return await streamLargeToSecondary(overflowStream);
          }
          bodyBuf = buf;
        } catch {
          return new Response(JSON.stringify({ ok: false, error: "İstek gövdesi okunamadı." }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...EDGE_SECURITY_HEADERS },
          });
        }
      }

      // 6. Deterministic failover chaos-test hook (admin-gated) or workers.dev direct test
      if (url.searchParams.get("__simulate_vercel_pause") === "1" && isAdminEdge(request, env)) {
        const simulatedPaused = new Response("Deployment is paused", {
          status: 503,
          headers: { "x-vercel-error": "DEPLOYMENT_PAUSED" },
        });
        if (shouldFailoverResponse(simulatedPaused)) {
          return await safeFetchSecondary(request, url, bodyBuf, env, "render-eu-failover", ctx);
        }
      }

      // 6b. Stateful Origin Affinity (rooms, voice-relay, uploads, stream/catalog caches) -> Render EU primary with instant Vercel fallback
      const isStreamOrResolveRoute =
        safePath === "/api/rave/resolve-catalog" ||
        safePath === "/api/rave/resolve-stream" ||
        safePath === "/api/rave/stream" ||
        safePath === "/api/rave/stream-manifest" ||
        safePath === "/api/rave/stream_manifest" ||
        safePath === "/api/rave/stream-proxy" ||
        safePath === "/api/rave/stream_chunk" ||
        safePath === "/api/rave/hls-proxy";

      const prefersStatefulOrigin =
        safePath === "/api/rooms" ||
        safePath.startsWith("/api/rooms/") ||
        safePath === "/api/rave/meshes" ||
        safePath.startsWith("/api/rave/meshes/") ||
        safePath === "/api/rave/voice-relay" ||
        safePath.startsWith("/api/rave/voice-relay/") ||
        safePath.startsWith("/api/rave/social/voice-relay") ||
        safePath.startsWith("/r/") ||
        safePath.startsWith("/join/") ||
        isStreamOrResolveRoute ||
        safePath === "/api/upload" ||
        safePath.startsWith("/uploads/");

      if (hasAutonomousEdge(env) && (url.searchParams.get("__edge_only") === "1" || Date.now() < tunnelOfflineUntil)) {
        return await runAutonomousFallback(request, url, safePath, bodyBuf, env);
      }

      let alreadyTriedSecondary = false;
      if (prefersStatefulOrigin && (env.FORCE_SECONDARY === "1" || Date.now() >= secondaryCircuitOpenUntil)) {
        alreadyTriedSecondary = true;
        try {
          const statefulResp = await fetchSecondary(request, url, bodyBuf, env, "render-eu-stateful");
          if (!shouldFailoverResponse(statefulResp)) {
            tunnelOfflineUntil = 0;
            return statefulResp;
          }
          const renderRouting = (statefulResp.headers.get("x-render-routing") || "").toLowerCase();
          const isExplicitlyDown =
            renderRouting.includes("suspend") || statefulResp.status === 503 || statefulResp.status === 530;
          statefulResp.body?.cancel?.();
          if (hasAutonomousEdge(env)) {
            tunnelOfflineUntil = Date.now() + 25_000;
            return await runAutonomousFallback(request, url, safePath, bodyBuf, env);
          }
          if (env.FORCE_SECONDARY !== "1") {
            if (isExplicitlyDown) {
              secondaryCircuitOpenUntil = Date.now() + 60_000;
            } else if (!isStreamOrResolveRoute) {
              secondaryCircuitOpenUntil = Date.now() + 15_000;
            }
          }
        } catch {
          if (hasAutonomousEdge(env)) {
            tunnelOfflineUntil = Date.now() + 25_000;
            return await runAutonomousFallback(request, url, safePath, bodyBuf, env);
          }
          if (env.FORCE_SECONDARY !== "1") {
            secondaryCircuitOpenUntil = Date.now() + 15_000;
          }
        }
      }

      // Mirror auth logout to stateful secondary origin so in-memory token caches evict immediately across origins
      if (request.method === "POST" && safePath === "/api/auth/logout" && Date.now() >= secondaryCircuitOpenUntil) {
        ctx?.waitUntil?.(
          fetchSecondary(request, url, bodyBuf, env, "render-eu-logout-mirror").catch(() => null)
        );
      }

      if (
        url.hostname.endsWith(".workers.dev") ||
        env.FORCE_SECONDARY === "1" ||
        (Date.now() < primaryCircuitOpenUntil && Date.now() >= secondaryCircuitOpenUntil)
      ) {
        return await safeFetchSecondary(request, url, bodyBuf, env, "render-eu-failover", ctx, true);
      }

      // 7. Try Primary (Vercel via Cloudflare Zone DNS -> 216.198.79.1), failover to Secondary on pause/5xx
      let primaryResp = null;
      try {
        primaryResp = await fetchPrimary(request, url, bodyBuf, env);
      } catch (_err) {
        primaryCircuitOpenUntil = Date.now() + 60_000;
        if (alreadyTriedSecondary) {
          return buildGracefulOverloadResponse(request, url);
        }
        return await safeFetchSecondary(request, url, bodyBuf, env, "render-eu-failover", ctx, false);
      }

      if (shouldFailoverResponse(primaryResp)) {
        primaryResp.body?.cancel?.();
        primaryCircuitOpenUntil = Date.now() + 60_000;
        if (alreadyTriedSecondary) {
          return buildGracefulOverloadResponse(request, url);
        }
        return await safeFetchSecondary(request, url, bodyBuf, env, "render-eu-failover", ctx, false);
      }

      return primaryResp;
    } catch (_topErr) {
      return buildGracefulOverloadResponse(request, url);
    }
  },

  async scheduled(_event, env, ctx) {
    const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
    const pingOnce = () =>
      fetch(`${secondaryBase}/api/health`, {
        method: "GET",
        headers: { "User-Agent": "Watchlivo-KeepAlive-Cron/1.1" },
        signal: AbortSignal.timeout(12_000),
      });
    ctx.waitUntil(
      pingOnce().catch(() => pingOnce()).catch(() => null)
    );
  },
};
