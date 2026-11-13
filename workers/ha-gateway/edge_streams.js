const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

function fnv1aBucket(key, buckets = 64) {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(key);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % buckets;
}

function b64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(sid) {
  const norm = String(sid || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function inferStreamReferer(u) {
  if (!u || u.includes("hakunaymatata.com")) return "";
  if (u.includes("filmboom")) return "https://filmboom.top/";
  if (u.includes("tau-video") || u.includes("irtau1.")) return "https://tau-video.xyz/";
  if (u.includes("molystream") || u.includes("/sheila_")) return "https://dbx.molystream.org/";
  if ((u.includes("cdnimages") && u.includes("/hls/")) || u.includes("playmix.uno") || u.includes("hdfilmcehennemi.mobi")) return "https://hdfilmcehennemi.mobi/";
  if (u.includes("cdnimg") || u.includes("rapidvid") || /https:\/\/s\d+\.[^/]+\.shop\//.test(u)) return "https://rapidvid.org/";
  if (u.includes("makesomthingup") || u.includes("centralodsseyproud") || u.includes("/r6/")) return "https://one.makesomthingup.click/";
  if (["vidmoly.", "vmbox.", "vmnow.", "vmpx."].some((d) => u.includes(d))) return "https://vidmoly.biz/";
  return "";
}

let _hmacCacheKey = "";
let _hmacCrypto = null;

export async function signProxySig(targetUrl, ref, env) {
  const secret = String(env?.PROXY_SECRET || env?.VORTEX_SECRET || "watchlivo-edge-default-secret-2026").trim();
  if (!_hmacCrypto || _hmacCacheKey !== secret) {
    _hmacCrypto = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    _hmacCacheKey = secret;
  }
  const exp = Math.floor(Date.now() / 1000) + 21600;
  const mac = await crypto.subtle.sign("HMAC", _hmacCrypto, new TextEncoder().encode(`${targetUrl}|${ref || ""}|${exp}`));
  const hex = Array.from(new Uint8Array(mac)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}.${exp}`;
}

async function buildSignedProxyPath(targetUrl, ref, ext, env) {
  const cleanRef = ref !== undefined ? ref : inferStreamReferer(targetUrl);
  const sig = await signProxySig(targetUrl, cleanRef, env);
  const q = new URLSearchParams({ url: targetUrl, sig, ext: ext || ".ts" });
  if (cleanRef) q.set("referer", cleanRef);
  return `/api/rave/stream-proxy?${q.toString()}`;
}

async function lookupVaultStream(keys, env) {
  if (!env?.ASSETS) return null;
  for (const k of keys) {
    if (!k) continue;
    const hex = fnv1aBucket(k).toString(16).padStart(2, "0");
    try {
      const r = await env.ASSETS.fetch(new Request(`https://assets.local/_edge/streams/b${hex}.json`));
      if (r.ok) {
        const shard = await r.json();
        if (shard && shard[k] && Array.isArray(shard[k].streams) && shard[k].streams.length) return shard[k];
      }
    } catch {}
  }
  return null;
}

export async function handleEdgeResolveCatalog(url, env, jsonResp) {
  const id = (url.searchParams.get("id") || "").trim();
  const tmdbId = (url.searchParams.get("tmdbId") || "").trim();
  const mtype = (url.searchParams.get("type") || url.searchParams.get("mediaType") || "movie").trim();
  const s = Number(url.searchParams.get("season") || url.searchParams.get("s") || 1) || 1;
  const e = Number(url.searchParams.get("episode") || url.searchParams.get("e") || 1) || 1;
  const offUrl = (url.searchParams.get("officialUrl") || url.searchParams.get("url") || "").trim();

  const lookupKeys = [];
  if (id) lookupKeys.push(`id:${id}`);
  if (tmdbId && mtype === "tv") lookupKeys.push(`tmdb:${tmdbId}:s${s}e${e}`, `tmdb:${tmdbId}:${s}:${e}`);
  if (tmdbId) lookupKeys.push(`tmdb:${tmdbId}`);
  if (offUrl) lookupKeys.push(`url:${offUrl}`);

  const hit = await lookupVaultStream(lookupKeys, env);
  if (!hit) {
    const embed = tmdbId
      ? (mtype === "tv" ? `https://vidsrc.cc/v2/embed/tv/${encodeURIComponent(tmdbId)}/${s}/${e}` : `https://vidsrc.cc/v2/embed/movie/${encodeURIComponent(tmdbId)}`)
      : "";
    return jsonResp({ id: tmdbId || id, provider: "embed", tmdbId, mediaType: mtype, season: s, episode: e, streamType: "embed", url: embed, embedUrl: embed, altUrls: [], servers: embed ? [{ id: "srv-embed", label: "🌐 Bulut Embed Kaynağı", url: embed, streamType: "embed" }] : [], subtitleTracks: [] });
  }

  const urls = [];
  const servers = [];
  for (let i = 0; i < hit.streams.length; i++) {
    const pair = hit.streams[i];
    const rawU = Array.isArray(pair) ? pair[0] : pair?.url;
    const kind = String(Array.isArray(pair) ? pair[1] || "" : pair?.kind || "").toLowerCase();
    if (!rawU) continue;
    const isMp4 = kind.includes("mp4") || /\.mp4(\?|$)/i.test(rawU) || rawU.includes("hakunaymatata.com") || rawU.includes("/file/tau-video/");
    const proxied = isMp4
      ? await buildSignedProxyPath(rawU, inferStreamReferer(rawU), ".mp4", env)
      : `/api/rave/stream?tmdbId=${encodeURIComponent(tmdbId || id)}&mtype=${encodeURIComponent(mtype)}&sid=${b64UrlEncode(rawU)}&ext=.m3u8`;
    urls.push({ url: proxied, streamType: isMp4 ? "mp4" : "hls", label: `📡 Sunucu ${i + 1} · Edge Direct (${isMp4 ? "MP4 HD" : "1080p HLS"})` });
    servers.push({ id: `srv-${i + 1}`, label: `📡 Sunucu ${i + 1} · Cloudflare 7/24 (${isMp4 ? "MP4 HD" : "1080p HLS"})`, url: proxied, streamType: isMp4 ? "mp4" : "hls" });
  }

  const subs = (hit.subs || []).filter((t) => t?.url).map((t, idx) => ({
    id: `sub-${idx}`,
    lang: t.lang || "tr",
    label: t.lang === "tr" ? "🇹🇷 Türkçe" : (t.lang === "en" ? "🇬🇧 İngilizce" : String(t.lang || "Altyazı").toUpperCase()),
    url: `/api/rave/subtitle.vtt?url=${encodeURIComponent(t.url)}`,
  }));

  const primary = urls[0] || { url: "", streamType: "hls" };
  return jsonResp({
    id: tmdbId || id,
    provider: "netflix",
    catalogProvider: "netflix",
    tmdbId: tmdbId || hit.tmdbId || "",
    mediaType: hit.mediaType || mtype,
    season: mtype === "tv" ? s : 0,
    episode: mtype === "tv" ? e : 0,
    seriesTitle: hit.title || "",
    originalTitle: hit.originalTitle || "",
    year: hit.year || "",
    streamType: primary.streamType,
    url: primary.url,
    embedUrl: "",
    altUrls: urls.slice(1).map((x) => x.url),
    servers,
    subtitleTracks: subs,
  });
}

export async function handleEdgeHlsManifest(url, env) {
  let target = (url.searchParams.get("url") || "").trim();
  const sid = (url.searchParams.get("sid") || "").trim();
  if (!target && sid) {
    try { target = b64UrlDecode(sid); } catch { return new Response("Invalid sid", { status: 400 }); }
  }
  if (!target.startsWith("http")) return new Response("Missing stream URL", { status: 400 });
  const ref = inferStreamReferer(target);
  const hdrs = { "User-Agent": UA_CHROME, Accept: "*/*" };
  if (ref) { hdrs.Referer = ref; hdrs.Origin = ref.replace(/\/$/, ""); }
  const up = await fetch(target, { headers: hdrs, redirect: "follow", signal: AbortSignal.timeout(14000) });
  if (!up.ok) return new Response(`Upstream HLS ${up.status}`, { status: 502 });
  const finalBase = up.url || target;
  const text = await up.text();
  if (!text.lstrip?.()?.startsWith("#EXTM3U") && !text.trimStart().startsWith("#EXTM3U")) {
    return Response.redirect(await buildSignedProxyPath(finalBase, ref, ".mp4", env), 302);
  }
  const isMaster = text.includes("#EXT-X-STREAM-INF");
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        const replaced = await replaceAsyncUri(line, finalBase, ref, env, trimmed.startsWith("#EXT-X-MEDIA"));
        out.push(replaced);
      } else {
        out.push(line);
      }
      continue;
    }
    const abs = new URL(trimmed, finalBase).toString();
    if (isMaster || /\.m3u8(\?|$)/i.test(abs)) {
      out.push(`/api/rave/stream?sid=${b64UrlEncode(abs)}&proxy_segs=1&ext=.m3u8`);
    } else {
      const ext = /\.m4s(\?|$)/i.test(abs) ? ".m4s" : ".ts";
      out.push(await buildSignedProxyPath(abs, ref, ext, env));
    }
  }
  return new Response(out.join("\n"), {
    status: 200,
    headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
}

async function replaceAsyncUri(line, base, ref, env, isMediaPlaylist) {
  const m = line.match(/URI="([^"]+)"/);
  if (!m) return line;
  const abs = new URL(m[1], base).toString();
  const rew = isMediaPlaylist || /\.m3u8(\?|$)/i.test(abs)
    ? `/api/rave/stream?sid=${b64UrlEncode(abs)}&proxy_segs=1&ext=.m3u8`
    : await buildSignedProxyPath(abs, ref, line.includes("#EXT-X-KEY") ? ".key" : ".mp4", env);
  return line.replace(m[0], `URI="${rew}"`);
}

export async function handleEdgeSubtitle(url) {
  const target = (url.searchParams.get("url") || "").trim();
  if (!target.startsWith("http")) return new Response("WEBVTT\n\n", { status: 200, headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
  try {
    const r = await fetch(target, { headers: { "User-Agent": UA_CHROME }, signal: AbortSignal.timeout(10000) });
    let txt = await r.text();
    if (!txt.trimStart().startsWith("WEBVTT")) {
      txt = "WEBVTT\n\n" + txt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    }
    return new Response(txt, {
      status: 200,
      headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new Response("WEBVTT\n\n", { status: 200, headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
  }
}

export async function handleEdgePoster(url) {
  const target = (url.searchParams.get("url") || "").trim();
  if (!target.startsWith("https://")) return new Response("Bad poster URL", { status: 400 });
  try {
    const r = await fetch(target, { headers: { "User-Agent": UA_CHROME }, cf: { cacheTtl: 86400, cacheEverything: true } });
    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("Poster unavailable", { status: 502 });
  }
}
