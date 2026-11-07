/**
 * Watchlivo Multi-Cloud High-Availability Edge Gateway + Keep-Alive Cron (v135)
 *
 * Routes: watchlivo.online/*, www.watchlivo.online/*
 * Primary Origin:   Vercel (via Cloudflare Zone DNS -> 216.198.79.1)
 * Secondary Origin: Render EU Frankfurt (https://watchlivo-origin-eu.onrender.com)
 * Stream Proxy:     Cloudflare Service Binding STREAM_PROXY (watchlivo-stream-proxy)
 */

const DEFAULT_SECONDARY_ORIGIN = "https://watchlivo-origin-eu.onrender.com";
const DEFAULT_STREAM_PROXY_ORIGIN = "https://watchlivo-stream-proxy.watchlivo-edge.workers.dev";
const BYPASS_WORKER_HOSTS = ["hakunaymatata.com"];

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

const MAX_BUFFER_BYTES = Math.floor(4.2 * 1024 * 1024);

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
  const nosniff = (resp.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff";
  return ct.includes("application/json") || nosniff;
}

function shouldFailoverResponse(resp) {
  if (!resp) return true;
  const vercelErr = (resp.headers.get("x-vercel-error") || "").toUpperCase();
  if (vercelErr && VERCEL_PAUSE_TOKENS.some((tok) => vercelErr.includes(tok))) {
    return true;
  }
  if (!vercelErr && [429, 500, 502, 503, 504].includes(resp.status) && isAppManagedError(resp)) {
    return false;
  }
  return FAILOVER_STATUSES.has(resp.status);
}

function buildForwardHeaders(originalHeaders, clientIp, originalHost, targetHost, env, keepHost = false) {
  const h = new Headers(originalHeaders);
  if (!keepHost && targetHost) {
    h.set("Host", targetHost);
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
    return 25_000;
  }
  return 8_500;
}

async function fetchSecondary(request, url, bodyBuf, env, originTag = "render-eu-failover") {
  const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
  const cleanSearch = new URLSearchParams(url.search);
  cleanSearch.delete("__simulate_vercel_pause");
  const qs = cleanSearch.toString();
  const secUrl = new URL(url.pathname + (qs ? `?${qs}` : ""), secondaryBase);
  const clientIp = request.headers.get("CF-Connecting-IP") || "";
  const headers = buildForwardHeaders(request.headers, clientIp, "watchlivo.online", secUrl.host, env, false);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(originTimeoutMs(url.pathname)),
  };
  if (bodyBuf !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = bodyBuf;
  }
  const resp = await fetch(secUrl.toString(), init);
  const outHeaders = new Headers(resp.headers);
  outHeaders.set("X-Watchlivo-Origin", originTag);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: outHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Canonical www -> apex redirect
    if (url.hostname === "www.watchlivo.online") {
      url.hostname = "watchlivo.online";
      return Response.redirect(url.toString(), 308);
    }

    // 2. Gateway diagnostic endpoint
    if (url.pathname === "/api/ha-status") {
      const adminOk = isAdminEdge(request, env);
      const statusPayload = {
        ok: true,
        gateway: "watchlivo-ha-gateway-v136",
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
        },
      });
    }

    // 3. Direct zero-egress offload via Service Binding (0ms RPC) for APK/IPA and stream-proxy
    const isBinaryDownload =
      url.pathname === "/download/apk" ||
      url.pathname === "/download/ipa" ||
      /^\/download\/Watchlivo.*\.(apk|ipa)$/i.test(url.pathname);
    const isStreamProxyPath =
      url.pathname === "/api/rave/stream-proxy" ||
      url.pathname === "/api/rave/stream_chunk";
    if (isBinaryDownload || isStreamProxyPath) {
      const cfFallback = url.searchParams.get("cf_fb") === "1";
      let bypassWorker = cfFallback;
      if (!bypassWorker && isStreamProxyPath) {
        const rawTarget = (url.searchParams.get("url") || url.searchParams.get("u") || "").trim();
        try {
          const parsedHost = new URL(rawTarget).hostname.toLowerCase();
          bypassWorker = BYPASS_WORKER_HOSTS.some(
            (h) => parsedHost === h || parsedHost.endsWith(`.${h}`)
          );
        } catch {
          bypassWorker = false;
        }
      }
      if (!bypassWorker) {
        if (env.STREAM_PROXY) {
          return env.STREAM_PROXY.fetch(request);
        }
        const edgeBase = (env.STREAM_PROXY_ORIGIN || DEFAULT_STREAM_PROXY_ORIGIN).replace(/\/+$/, "");
        const edgeUrl = new URL(url.pathname + url.search, edgeBase);
        return Response.redirect(edgeUrl.toString(), 302);
      }
    }

    // 4. Native WebSockets (/ws/*) -> route directly to stateful ASGI Secondary Origin (Render)
    const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
    if (upgrade === "websocket") {
      if (Date.now() < secondaryCircuitOpenUntil) {
        return new Response("WebSocket origin temporarily unavailable", {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "5" },
        });
      }
      const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
      const wsTarget = new URL(url.pathname + url.search, secondaryBase);
      const clientIp = request.headers.get("CF-Connecting-IP") || "";
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
          method: request.method,
          headers: wsHeaders,
        });
        if (wsResp.status >= 502) {
          secondaryCircuitOpenUntil = Date.now() + 15_000;
        }
        return wsResp;
      } catch {
        secondaryCircuitOpenUntil = Date.now() + 15_000;
        return new Response("WebSocket origin unreachable", {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "5" },
        });
      }
    }

    // 5. Buffer non-streaming request bodies (<= 4.2 MB) so POST/PUT/DELETE can failover cleanly
    let bodyBuf = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const contentLen = parseInt(request.headers.get("content-length") || "0", 10);
      if (!Number.isNaN(contentLen) && contentLen > MAX_BUFFER_BYTES) {
        const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
        const secUrl = new URL(url.pathname + url.search, secondaryBase);
        const headers = buildForwardHeaders(
          request.headers,
          request.headers.get("CF-Connecting-IP") || "",
          "watchlivo.online",
          secUrl.host,
          env,
          false
        );
        return fetch(secUrl.toString(), {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(25_000),
        });
      }
      bodyBuf = await request.arrayBuffer();
      if (bodyBuf.byteLength > MAX_BUFFER_BYTES) {
        const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
        const secUrl = new URL(url.pathname + url.search, secondaryBase);
        const headers = buildForwardHeaders(
          request.headers,
          request.headers.get("CF-Connecting-IP") || "",
          "watchlivo.online",
          secUrl.host,
          env,
          false
        );
        return fetch(secUrl.toString(), {
          method: request.method,
          headers,
          body: bodyBuf,
          redirect: "manual",
          signal: AbortSignal.timeout(25_000),
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
        return fetchSecondary(request, url, bodyBuf, env);
      }
    }

    // 6b. Stateful Origin Affinity (rooms, voice-relay, uploads, stream/catalog caches) -> Render EU primary with instant Vercel fallback
    const prefersStatefulOrigin =
      url.pathname === "/api/rooms" ||
      url.pathname.startsWith("/api/rooms/") ||
      url.pathname.startsWith("/api/rave/voice-relay/") ||
      url.pathname === "/api/rave/resolve-catalog" ||
      url.pathname === "/api/rave/resolve-stream" ||
      url.pathname === "/api/rave/stream" ||
      url.pathname === "/api/rave/stream-manifest" ||
      url.pathname === "/api/rave/stream_manifest" ||
      url.pathname === "/api/rave/hls-proxy" ||
      url.pathname === "/api/upload" ||
      url.pathname.startsWith("/uploads/");

    if (prefersStatefulOrigin && Date.now() >= secondaryCircuitOpenUntil) {
      try {
        const statefulResp = await fetchSecondary(request, url, bodyBuf, env, "render-eu-stateful");
        if (!shouldFailoverResponse(statefulResp)) {
          return statefulResp;
        }
        secondaryCircuitOpenUntil = Date.now() + 20_000;
      } catch {
        secondaryCircuitOpenUntil = Date.now() + 20_000;
      }
      if (url.pathname === "/api/upload" || url.pathname.startsWith("/uploads/")) {
        return new Response(JSON.stringify({ ok: false, error: "Yükleme servisi geçici olarak meşgul." }), {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    }

    // Mirror auth logout to stateful secondary origin so in-memory token caches evict immediately across origins
    if (request.method === "POST" && url.pathname === "/api/auth/logout" && Date.now() >= secondaryCircuitOpenUntil) {
      ctx.waitUntil(
        fetchSecondary(request, url, bodyBuf, env, "render-eu-logout-mirror").catch(() => null)
      );
    }

    if (
      url.hostname.endsWith(".workers.dev") ||
      env.FORCE_SECONDARY === "1" ||
      (Date.now() < primaryCircuitOpenUntil && Date.now() >= secondaryCircuitOpenUntil)
    ) {
      return fetchSecondary(request, url, bodyBuf, env);
    }

    // 7. Try Primary (Vercel via Cloudflare Zone DNS -> 216.198.79.1), failover to Render on pause/5xx
    try {
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
        signal: AbortSignal.timeout(originTimeoutMs(url.pathname)),
      };
      if (bodyBuf !== null && request.method !== "GET" && request.method !== "HEAD") {
        primaryInit.body = bodyBuf;
      }
      const primaryResp = await fetch(request.url, primaryInit);
      if (shouldFailoverResponse(primaryResp)) {
        primaryCircuitOpenUntil = Date.now() + 60_000;
        return await fetchSecondary(request, url, bodyBuf, env);
      }
      const outHeaders = new Headers(primaryResp.headers);
      outHeaders.set("X-Watchlivo-Origin", "vercel-primary");
      return new Response(primaryResp.body, {
        status: primaryResp.status,
        statusText: primaryResp.statusText,
        headers: outHeaders,
      });
    } catch (_err) {
      primaryCircuitOpenUntil = Date.now() + 60_000;
      return fetchSecondary(request, url, bodyBuf, env);
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
