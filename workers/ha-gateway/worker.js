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

function shouldFailoverResponse(resp) {
  if (!resp) return true;
  const vercelErr = (resp.headers.get("x-vercel-error") || "").toUpperCase();
  if (vercelErr && VERCEL_PAUSE_TOKENS.some((tok) => vercelErr.includes(tok))) {
    return true;
  }
  if (resp.status === 429 || resp.status === 500) {
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (vercelErr || !ct.includes("application/json")) {
      return true;
    }
    return false;
  }
  return FAILOVER_STATUSES.has(resp.status);
}

function buildForwardHeaders(originalHeaders, clientIp, originalHost, targetHost) {
  const h = new Headers(originalHeaders);
  h.set("Host", targetHost);
  h.set("X-Forwarded-Host", originalHost);
  h.set("X-Forwarded-Proto", "https");
  if (clientIp) {
    h.set("X-Real-IP", clientIp);
  }
  h.delete("cf-connecting-ip");
  h.delete("cf-ipcountry");
  h.delete("cf-ray");
  h.delete("cf-visitor");
  return h;
}

async function fetchSecondary(request, url, bodyBuf, env) {
  const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
  const cleanSearch = new URLSearchParams(url.search);
  cleanSearch.delete("__simulate_vercel_pause");
  const qs = cleanSearch.toString();
  const secUrl = new URL(url.pathname + (qs ? `?${qs}` : ""), secondaryBase);
  const clientIp = request.headers.get("CF-Connecting-IP") || "";
  const headers = buildForwardHeaders(request.headers, clientIp, "watchlivo.online", secUrl.host);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (bodyBuf !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = bodyBuf;
  }
  const resp = await fetch(secUrl.toString(), init);
  const outHeaders = new Headers(resp.headers);
  outHeaders.set("X-Watchlivo-Origin", "render-eu-failover");
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
      return new Response(
        JSON.stringify({
          ok: true,
          gateway: "watchlivo-ha-gateway-v135",
          primaryCircuitOpen: Date.now() < primaryCircuitOpenUntil,
          secondaryOrigin: env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN,
          streamProxyOrigin: env.STREAM_PROXY_ORIGIN || DEFAULT_STREAM_PROXY_ORIGIN,
          hasStreamBinding: Boolean(env.STREAM_PROXY),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // 3. Direct zero-egress offload via Service Binding (0ms RPC) for APK/IPA and stream-proxy
    if (
      url.pathname === "/download/apk" ||
      url.pathname === "/download/ipa" ||
      url.pathname === "/api/rave/stream-proxy"
    ) {
      const targetParam = (url.searchParams.get("url") || "").toLowerCase();
      const bypassWorker =
        url.pathname === "/api/rave/stream-proxy" &&
        BYPASS_WORKER_HOSTS.some((h) => targetParam.includes(h));
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
      const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
      const wsTarget = new URL(url.pathname + url.search, secondaryBase);
      const wsHeaders = new Headers(request.headers);
      wsHeaders.set("Host", wsTarget.host);
      wsHeaders.set("X-Forwarded-Host", "watchlivo.online");
      wsHeaders.set("X-Forwarded-Proto", "https");
      return fetch(wsTarget.toString(), {
        method: request.method,
        headers: wsHeaders,
      });
    }

    // 5. Buffer non-streaming request bodies (< 10 MB) so POST/PUT/DELETE can failover cleanly
    let bodyBuf = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const contentLen = parseInt(request.headers.get("content-length") || "0", 10);
      if (!Number.isNaN(contentLen) && contentLen > 10 * 1024 * 1024) {
        if (Date.now() < primaryCircuitOpenUntil || env.FORCE_SECONDARY === "1") {
          const secondaryBase = (env.SECONDARY_ORIGIN || DEFAULT_SECONDARY_ORIGIN).replace(/\/+$/, "");
          const secUrl = new URL(url.pathname + url.search, secondaryBase);
          const headers = buildForwardHeaders(
            request.headers,
            request.headers.get("CF-Connecting-IP") || "",
            "watchlivo.online",
            secUrl.host
          );
          return fetch(secUrl.toString(), { method: request.method, headers, body: request.body });
        }
        return fetch(request);
      }
      bodyBuf = await request.arrayBuffer();
    }

    // 6. Deterministic failover chaos-test hook (?__simulate_vercel_pause=1) or workers.dev direct test
    if (url.searchParams.get("__simulate_vercel_pause") === "1") {
      const simulatedPaused = new Response("Deployment is paused", {
        status: 503,
        headers: { "x-vercel-error": "DEPLOYMENT_PAUSED" },
      });
      if (shouldFailoverResponse(simulatedPaused)) {
        return fetchSecondary(request, url, bodyBuf, env);
      }
    }

    if (
      url.hostname.endsWith(".workers.dev") ||
      env.FORCE_SECONDARY === "1" ||
      Date.now() < primaryCircuitOpenUntil
    ) {
      return fetchSecondary(request, url, bodyBuf, env);
    }

    // 7. Try Primary (Vercel via Cloudflare Zone DNS -> 216.198.79.1), failover to Render on pause/5xx
    try {
      const primaryInit = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
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
    ctx.waitUntil(
      fetch(`${secondaryBase}/api/health`, {
        method: "GET",
        headers: { "User-Agent": "Watchlivo-KeepAlive-Cron/1.0" },
      }).catch(() => null)
    );
  },
};
