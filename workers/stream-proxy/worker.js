/**
 * Watchlivo Zero-Egress Edge Stream & Binary Asset Proxy (Cloudflare Workers)
 * Byte-exact HMAC-SHA256 compatibility with server.py (_proxy_sig / _proxy_sig_ok).
 */

const UA137 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const HAKUNA_UA =
  "com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function isPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = (u.hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (host.startsWith("[") || host.includes(":")) {
    return false;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
  }
  return true;
}

let cachedKeySecret = "";
let cachedCryptoKey = null;

async function getHmacKey(secret) {
  if (cachedCryptoKey && cachedKeySecret === secret) return cachedCryptoKey;
  const enc = new TextEncoder();
  cachedCryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  cachedKeySecret = secret;
  return cachedCryptoKey;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyProxySig(url, ref, sig, secret) {
  if (!secret || !sig || !sig.includes(".")) return false;
  const dotIdx = sig.lastIndexOf(".");
  const digest = sig.slice(0, dotIdx);
  const expRaw = sig.slice(dotIdx + 1);
  if (digest.length !== 24 || !/^\d+$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  const key = await getHmacKey(secret);
  const msg = new TextEncoder().encode(`${url}|${ref}|${exp}`);
  const macBuf = await crypto.subtle.sign("HMAC", key, msg);
  const hex = Array.from(new Uint8Array(macBuf))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqualStr(hex, digest.toLowerCase());
}

function inferReferer(url, explicitRef) {
  const trimmed = (explicitRef || "").trim();
  if (trimmed) return trimmed;
  if (url.includes("hakunaymatata.com")) return "";
  if (url.includes("filmboom")) return "https://filmboom.top/";
  if (
    ["zenoak.top", "paleoak.top", "olivewave.top", "goldenkite.top", "cleartree.top", "vividstone.top", "crispwave.top", "greennova.top", "finalsignal.top", "workers.dev"].some((d) =>
      url.includes(d)
    ) ||
    /https?:\/\/[^/]+\.top\/vd[a-z0-9]*\//i.test(url)
  ) {
    return "https://vidy.st/";
  }
  if (url.includes("lightspeed.st")) return "https://cinejoy.pk/";
  if (url.includes("archive.org")) return "https://archive.org/";
  if (url.includes("tau-video")) return "https://tau-video.xyz/";
  if (url.includes("fastplay.") || url.includes(".cfd/")) {
    return url.includes("ag2m5.cfd") ? "https://x.ag2m5.cfd/" : "https://fastplay.mom/";
  }
  if (url.includes("uk-traffic-") || url.includes("cdn77s.com")) return "https://x.ag2m5.cfd/";
  if (url.includes("pilavyer")) {
    try {
      return `https://${new URL(url).host || "play2.pilavyerplay.top"}/`;
    } catch {
      return "https://play2.pilavyerplay.top/";
    }
  }
  if (url.includes("dragonballzfans")) return "https://flixer.su/";
  if ((url.includes("cdnimages") && url.includes("/hls/")) || url.includes("playmix.uno") || url.includes("hdfilmcehennemi.mobi")) {
    return "https://hdfilmcehennemi.mobi/";
  }
  if (
    url.includes("cdnimgs") ||
    (url.includes("cdnimg") && !(url.includes("cdnimages") && url.includes("/hls/"))) ||
    url.includes("rapidvid") ||
    /https:\/\/s\d+\.[^/]+\.shop\//.test(url)
  ) {
    return "https://rapidvid.org/";
  }
  if (url.includes("molystream") || url.includes("/sheila_")) return "https://dbx.molystream.org/";
  if (url.includes("makesomthingup") || url.includes("centralodsseyproud") || url.includes("/r6/")) {
    return "https://one.makesomthingup.click/";
  }
  if (url.includes("daioncdn.net/startv")) return "https://www.startv.com.tr/";
  if (url.includes("daioncdn.net/ntv")) return "https://www.ntv.com.tr/";
  if (url.includes("daioncdn.net/halktv")) return "https://halktv.com.tr/";
  if (["vidmoly.", "vmbox.", "vmnow.", "vmpx."].some((d) => url.includes(d))) return "https://vidmoly.biz/";
  return "";
}

function resolveMediaContentType(url, extHint, upstreamCt) {
  const rawCt = (upstreamCt || "").toLowerCase();
  const cleanPath = url.toLowerCase().split("?")[0];
  if (extHint === ".key" || url.includes("key.php") || cleanPath.endsWith(".key")) {
    return "application/octet-stream";
  }
  if (
    extHint === ".m4s" ||
    extHint === ".mp4" ||
    cleanPath.endsWith(".m4s") ||
    cleanPath.endsWith(".mp4") ||
    cleanPath.includes("init-") ||
    cleanPath.includes("/init.") ||
    cleanPath.includes("_init.") ||
    url.toLowerCase().includes("/file/tau-video/") ||
    url.toLowerCase().includes("drive.usercontent.google.com")
  ) {
    return "video/mp4";
  }
  if (cleanPath.endsWith(".webm") || extHint === ".webm") return "video/webm";
  if (cleanPath.endsWith(".vtt")) return "text/vtt; charset=utf-8";
  if (
    extHint === ".ts" ||
    cleanPath.endsWith(".ts") ||
    cleanPath.endsWith(".png") ||
    cleanPath.endsWith(".jpg") ||
    cleanPath.endsWith(".webp") ||
    url.includes(".cfd/") ||
    url.includes("/r6/s/") ||
    url.includes("pilavyer")
  ) {
    return "video/mp2t";
  }
  if (rawCt.includes("video/") || rawCt.includes("audio/") || rawCt.includes("mpegurl") || rawCt.includes("json")) {
    return upstreamCt;
  }
  return "video/mp2t";
}

async function serveBinaryAsset(request, env, assetPath, filename, contentType) {
  if (!env.ASSETS) return jsonResponse({ error: "Asset store unavailable" }, 404);
  const assetUrl = new URL(assetPath, request.url);
  const rangeHdr = request.headers.get("Range") || "";
  const fetchHeaders = new Headers();
  if (rangeHdr && request.method === "GET") {
    fetchHeaders.set("Range", rangeHdr);
  }
  const resp = await env.ASSETS.fetch(
    new Request(assetUrl.toString(), { method: "GET", headers: fetchHeaders })
  );
  if (!resp.ok && resp.status !== 206) {
    return jsonResponse({ error: "Dosya bulunamadı" }, 404);
  }
  const hdrs = new Headers();
  hdrs.set("Content-Type", contentType);
  hdrs.set("Content-Disposition", `attachment; filename="${filename}"`);
  hdrs.set("Accept-Ranges", "bytes");
  hdrs.set("Cache-Control", "public, max-age=300");
  hdrs.set("X-Content-Type-Options", "nosniff");
  hdrs.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  for (const [k, v] of Object.entries(CORS_HEADERS)) hdrs.set(k, v);

  const upCl = resp.headers.get("Content-Length") || "";
  const upCr = resp.headers.get("Content-Range") || "";
  if (request.method === "HEAD") {
    if (upCl) {
      hdrs.set("Content-Length", upCl);
      resp.body?.cancel?.();
    } else if (resp.body) {
      let totalBytes = 0;
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
      }
      hdrs.set("Content-Length", String(totalBytes));
    }
    return new Response(null, { status: 200, headers: hdrs });
  }

  if (rangeHdr && resp.status === 200) {
    const m = rangeHdr.match(/^bytes=(\d*)-(\d*)$/i);
    const knownTotal = Number(upCl || 0);
    if (m && knownTotal > 0 && resp.body) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : knownTotal - 1;
      if (!m[1] && m[2]) {
        const suffix = parseInt(m[2], 10);
        start = Math.max(0, knownTotal - suffix);
        end = knownTotal - 1;
      }
      if (start >= knownTotal || start < 0 || end < start) {
        resp.body?.cancel?.();
        hdrs.set("Content-Range", `bytes */${knownTotal}`);
        return new Response(null, { status: 416, headers: hdrs });
      }
      end = Math.min(end, knownTotal - 1);
      const wantLen = end - start + 1;
      let offset = 0;
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = resp.body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkEnd = offset + value.byteLength;
            if (chunkEnd > start && offset <= end) {
              const sIdx = Math.max(0, start - offset);
              const eIdx = Math.min(value.byteLength, end + 1 - offset);
              await writer.write(value.subarray(sIdx, eIdx));
            }
            offset = chunkEnd;
            if (offset > end) {
              await reader.cancel();
              break;
            }
          }
          await writer.close();
        } catch (err) {
          try { await writer.abort(err); } catch {}
        }
      })();
      hdrs.set("Content-Range", `bytes ${start}-${end}/${knownTotal}`);
      hdrs.set("Content-Length", String(wantLen));
      return new Response(readable, { status: 206, headers: hdrs });
    } else if (m) {
      const fullBuf = await resp.arrayBuffer();
      const total = fullBuf.byteLength;
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (!m[1] && m[2]) {
        const suffix = parseInt(m[2], 10);
        start = Math.max(0, total - suffix);
        end = total - 1;
      }
      if (start >= total || start < 0 || end < start) {
        hdrs.set("Content-Range", `bytes */${total}`);
        return new Response(null, { status: 416, headers: hdrs });
      }
      end = Math.min(end, total - 1);
      const slice = fullBuf.slice(start, end + 1);
      hdrs.set("Content-Range", `bytes ${start}-${end}/${total}`);
      hdrs.set("Content-Length", String(slice.byteLength));
      return new Response(slice, { status: 206, headers: hdrs });
    }
  }

  if (upCl) hdrs.set("Content-Length", upCl);
  if (upCr && resp.status === 206) hdrs.set("Content-Range", upCr);
  return new Response(resp.body, {
    status: resp.status,
    headers: hdrs,
  });
}

async function fetchPublicWithRedirects(initialUrl, baseHeaders, maxHops = 4, method = "GET", bodyBuf = undefined, timeoutMs = 15_000) {
  let curUrl = initialUrl;
  let curMethod = method;
  let curBody = bodyBuf;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!isPublicHttpUrl(curUrl)) {
      throw new Error("Blocked redirect target");
    }
    const resp = await fetch(curUrl, {
      method: curMethod,
      headers: baseHeaders,
      body: curMethod === "POST" ? curBody : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("Location");
      if (!loc) return { resp, finalUrl: curUrl };
      resp.body?.cancel?.();
      curUrl = new URL(loc, curUrl).toString();
      if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
        curMethod = "GET";
        curBody = undefined;
      }
      continue;
    }
    return { resp, finalUrl: curUrl };
  }
  throw new Error("Too many redirects");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
      });
    }
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;
    if (path !== "/api/rave/edge-fetch" && request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (path === "/health" || path === "/api/health") {
      return jsonResponse({
        ok: true,
        service: "watchlivo-stream-proxy",
        colo: request.cf?.colo || "edge",
      });
    }

    if (path === "/download/apk" || /^\/download\/Watchlivo.*\.apk$/i.test(path) || path === "/Watchlivo-v2.0.apk") {
      return serveBinaryAsset(request, env, "/Watchlivo-v2.0.apk", "Watchlivo-v2.0.apk", "application/vnd.android.package-archive");
    }

    if (path === "/download/ipa" || /^\/download\/Watchlivo.*\.ipa$/i.test(path) || path === "/Watchlivo.ipa") {
      return serveBinaryAsset(request, env, "/Watchlivo.ipa", "Watchlivo.ipa", "application/octet-stream");
    }

    if (path === "/api/rave/edge-fetch") {
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      const efUrl = (reqUrl.searchParams.get("url") || "").trim();
      const efRef = (reqUrl.searchParams.get("referer") || "").trim();
      const efSig = (reqUrl.searchParams.get("sig") || "").trim();
      if (!efUrl || !(await verifyProxySig(efUrl, efRef, efSig, env.PROXY_SECRET || ""))) {
        return jsonResponse({ error: "İmzasız kenar isteği reddedildi" }, 403);
      }
      if (!isPublicHttpUrl(efUrl)) {
        return jsonResponse({ error: "Geçersiz hedef URL" }, 403);
      }
      const efHeaders = new Headers();
      efHeaders.set("User-Agent", UA137);
      efHeaders.set("Accept", reqUrl.searchParams.get("accept") || request.headers.get("X-Edge-Accept") || "application/json, text/plain, */*");
      efHeaders.set("Accept-Language", "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7");
      const effEfRef = inferReferer(efUrl, efRef);
      if (effEfRef) {
        efHeaders.set("Referer", effEfRef);
        try {
          const rObj = new URL(effEfRef);
          efHeaders.set("Origin", `${rObj.protocol}//${rObj.host}`);
        } catch {}
      }
      if (reqUrl.searchParams.get("xhr") === "1" || request.headers.get("X-Edge-XHR") === "1" || efUrl.includes("animecix.tv/secure/")) {
        efHeaders.set("X-Requested-With", "XMLHttpRequest");
      }
      const csrfTok = request.headers.get("X-Edge-CSRF") || "";
      if (csrfTok) efHeaders.set("X-CSRF-Token", csrfTok);
      const reqCt = request.headers.get("Content-Type") || "";
      if (reqCt && request.method === "POST") efHeaders.set("Content-Type", reqCt);
      const bodyBuf = request.method === "POST" ? await request.arrayBuffer() : undefined;
      try {
        const { resp: upEf, finalUrl: efFinalUrl } = await fetchPublicWithRedirects(
          efUrl,
          efHeaders,
          4,
          request.method,
          bodyBuf,
          10_000
        );
        const outEfHeaders = new Headers();
        outEfHeaders.set("Content-Type", upEf.headers.get("Content-Type") || "application/octet-stream");
        outEfHeaders.set("Cache-Control", "no-store");
        outEfHeaders.set("X-Final-Url", efFinalUrl);
        for (const [k, v] of Object.entries(CORS_HEADERS)) outEfHeaders.set(k, v);
        return new Response(request.method === "HEAD" ? null : upEf.body, {
          status: upEf.status,
          headers: outEfHeaders,
        });
      } catch {
        return jsonResponse({ error: "Kenar kaynağına ulaşılamadı" }, 502);
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (
      path !== "/api/rave/stream-proxy" &&
      path !== "/api/rave/stream_chunk" &&
      path !== "/stream-proxy"
    ) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    const targetUrl = (reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u") || "").trim();
    const ref = (reqUrl.searchParams.get("referer") || "").trim();
    const sig = (reqUrl.searchParams.get("sig") || "").trim();
    const extHint = (reqUrl.searchParams.get("ext") || "").trim().toLowerCase();

    if (!targetUrl || !(await verifyProxySig(targetUrl, ref, sig, env.PROXY_SECRET || ""))) {
      return jsonResponse({ error: "İmzasız proxy isteği reddedildi" }, 403);
    }
    if (!isPublicHttpUrl(targetUrl)) {
      return jsonResponse({ error: "Geçersiz hedef URL" }, 403);
    }

    const rangeHdr = request.headers.get("Range") || "";
    const isUnrangedGet = request.method === "GET" && !rangeHdr;
    const isHlsSeg =
      extHint === ".ts" ||
      extHint === ".m4s" ||
      /\.(ts|m4s)(\?|$)/i.test(targetUrl) ||
      targetUrl.includes("/hls/") ||
      targetUrl.includes("/r6/s/");

    const cache = caches.default;
    const cacheKey = isUnrangedGet && isHlsSeg ? new Request(`https://edge-cache.watchlivo.internal/seg?u=${encodeURIComponent(targetUrl)}`, { method: "GET" }) : null;
    if (cacheKey) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    const isHakuna = targetUrl.includes("hakunaymatata.com");
    const effRef = inferReferer(targetUrl, ref);
    const upHeaders = new Headers();
    upHeaders.set("User-Agent", isHakuna ? HAKUNA_UA : UA137);
    upHeaders.set("Accept", "*/*");
    if (effRef) {
      upHeaders.set("Referer", effRef);
      try {
        const refObj = new URL(effRef);
        upHeaders.set("Origin", `${refObj.protocol}//${refObj.host}`);
      } catch {}
    }
    if (rangeHdr) {
      upHeaders.set("Range", rangeHdr);
    } else if (request.method === "HEAD") {
      upHeaders.set("Range", "bytes=0-0");
    }

    let upResp;
    try {
      ({ resp: upResp } = await fetchPublicWithRedirects(targetUrl, upHeaders, 4));
    } catch {
      return jsonResponse({ error: "Akış kaynağına ulaşılamadı." }, 502);
    }

    if (!upResp.ok && upResp.status !== 206 && upResp.status !== 416) {
      upResp.body?.cancel?.();
      if (
        (upResp.status === 403 || upResp.status === 427 || upResp.status === 428) &&
        env.FALLBACK_ORIGIN &&
        !reqUrl.searchParams.get("cf_fb")
      ) {
        const fbUrl = new URL("/api/rave/stream-proxy" + reqUrl.search, env.FALLBACK_ORIGIN);
        fbUrl.searchParams.set("cf_fb", "1");
        return new Response(null, {
          status: 302,
          headers: { Location: fbUrl.toString(), "Cache-Control": "no-store", ...CORS_HEADERS },
        });
      }
      const passthroughStatus = [403, 404, 410, 429].includes(upResp.status) ? upResp.status : 502;
      return jsonResponse({ error: "Akış kaynağı hata döndürdü.", upstreamStatus: upResp.status }, passthroughStatus);
    }

    const upCt = (upResp.headers.get("Content-Type") || "").toLowerCase();
    let streamBody = upResp.body;
    if (upCt.includes("text/html") && upResp.body && request.method !== "HEAD") {
      const reader = upResp.body.getReader();
      const first = await reader.read();
      const chunk = first?.value;
      const headAscii = chunk
        ? new TextDecoder("utf-8", { fatal: false }).decode(chunk.subarray(0, Math.min(chunk.length, 256))).trimStart().toLowerCase()
        : "";
      if (!chunk || headAscii.startsWith("<!doctype") || headAscii.startsWith("<html") || headAscii.startsWith("<head") || headAscii.startsWith("<body")) {
        try { await reader.cancel(); } catch {}
        return jsonResponse({ error: "Akış kaynağı medya yerine HTML döndürdü." }, 502);
      }
      streamBody = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
        },
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    } else if (upCt.includes("text/html") && request.method === "HEAD" && extHint !== ".key" && extHint !== ".ts" && extHint !== ".m4s" && extHint !== ".mp4" && extHint !== ".aac") {
      upResp.body?.cancel?.();
      return jsonResponse({ error: "Akış kaynağı medya yerine HTML döndürdü." }, 502);
    }

    const finalCt = resolveMediaContentType(targetUrl, extHint, upResp.headers.get("Content-Type") || "");
    const outHeaders = new Headers();
    outHeaders.set("Content-Type", finalCt);
    outHeaders.set("Accept-Ranges", "bytes");
    outHeaders.set("Vary", "Range");
    outHeaders.set("X-Content-Type-Options", "nosniff");
    for (const [k, v] of Object.entries(CORS_HEADERS)) outHeaders.set(k, v);

    const upCr = upResp.headers.get("Content-Range") || "";
    const upCl = upResp.headers.get("Content-Length") || "";

    if (request.method === "HEAD" && !rangeHdr) {
      upResp.body?.cancel?.();
      const mTot = upCr.match(/\/(\d+)$/);
      if (mTot) outHeaders.set("Content-Length", mTot[1]);
      else if (upCl) outHeaders.set("Content-Length", upCl);
      outHeaders.set("Cache-Control", "public, max-age=300");
      return new Response(null, { status: 200, headers: outHeaders });
    }

    if (upCl) outHeaders.set("Content-Length", upCl);
    if (upCr && (upResp.status === 206 || upResp.status === 416)) {
      outHeaders.set("Content-Range", upCr);
    }

    const isPartial = Boolean(rangeHdr || upResp.status === 206);
    outHeaders.set(
      "Cache-Control",
      isPartial ? "private, max-age=300" : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600"
    );

    const outStatus = [200, 206, 416].includes(upResp.status) ? upResp.status : 200;

    if (cacheKey && outStatus === 200 && Number(upCl || 0) <= 15 * 1024 * 1024) {
      const [bodyClient, bodyCache] = streamBody ? streamBody.tee() : [null, null];
      if (bodyCache) {
        const cacheResp = new Response(bodyCache, { status: 200, headers: outHeaders });
        ctx.waitUntil(cache.put(cacheKey, cacheResp).catch(() => {}));
      }
      return new Response(request.method === "HEAD" ? null : bodyClient, {
        status: outStatus,
        headers: outHeaders,
      });
    }

    return new Response(request.method === "HEAD" ? null : streamBody, {
      status: outStatus,
      headers: outHeaders,
    });
  },
};
