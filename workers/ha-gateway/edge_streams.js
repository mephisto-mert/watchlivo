const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const DEFAULT_TMDB_KEY = "4f042878f22ef63cb94f25e60cb4ec6e";

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
  if (u.includes("pilavyer")) return "https://play2.pilavyerplay.top/";
  if (u.includes("dragonballzfans") || u.includes("hexa.su")) return "https://hexa.su/";
  if (u.includes("filmboom")) return "https://filmboom.top/";
  if (u.includes("tau-video") || u.includes("irtau1.")) return "https://tau-video.xyz/";
  if (u.includes("molystream") || u.includes("/sheila_")) return "https://dbx.molystream.org/";
  if ((u.includes("cdnimages") && u.includes("/hls/")) || u.includes("playmix.uno") || u.includes("hdfilmcehennemi")) return "https://www.hdfilmcehennemi.nl/";
  if (u.includes("fullhdfilmizlesene")) return "https://www.fullhdfilmizlesene.tv/";
  if (u.includes("dizibox")) return "https://www.dizibox.so/";
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

const OFFLOAD_PROXY_ORIGIN = "https://watchlivo-stream-proxy.watchlivo-edge.workers.dev";
const OFFLOAD_BYPASS_HOSTS = [
  "hakunaymatata.com", "vidmoly.", "vmbox.", "vmnow.", "vmpx.",
  "hdfilmcehennemi.mobi", "ag2m5.cfd", "uk-traffic-", "fastplay.",
  "radyotvonline.com", "nexa.mov", "dplayer", "playmix.",
  "makesomthingup.", "cdnimages.", "ercdn.net", "daioncdn.net",
  "dragonballzfans", "molystream.org", "irtau1.", "lightspeed.st",
  "bright67.", "centralodsseyproud", "5d06cffcf9563c", "gamma.", ".click",
];

async function buildSignedProxyPath(targetUrl, ref, ext, env) {
  const cleanRef = ref !== undefined ? ref : inferStreamReferer(targetUrl);
  const sig = await signProxySig(targetUrl, cleanRef, env);
  const q = new URLSearchParams({ url: targetUrl, sig, ext: ext || ".ts" });
  if (cleanRef) q.set("referer", cleanRef);
  const lower = String(targetUrl || "").toLowerCase();
  const useLocal = OFFLOAD_BYPASS_HOSTS.some((h) => lower.includes(h));
  const base = useLocal ? "" : OFFLOAD_PROXY_ORIGIN;
  return `${base}/api/rave/stream-proxy?${q.toString()}`;
}

async function lookupVaultStream(keys, env) {
  if (!env?.ASSETS) return null;
  const seen = new Set();
  for (const k of keys) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
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

function buildEmbedServers(tmdbId, mtype, s, e) {
  if (!tmdbId) return [];
  const tid = encodeURIComponent(tmdbId);
  const isTv = mtype === "tv";
  return [
    {
      id: "srv-vidlink",
      label: "⚡ Sunucu 1 · Ultra HD (TR Altyazı)",
      url: isTv ? `https://vidlink.pro/tv/${tid}/${s}/${e}?autoplay=true` : `https://vidlink.pro/movie/${tid}?autoplay=true`,
      streamType: "embed",
    },
  ];
}

export async function handleEdgeResolveCatalog(url, env, jsonResp) {
  const id = (url.searchParams.get("id") || "").trim();
  const tmdbId = (url.searchParams.get("tmdbId") || "").trim();
  const mtype = (url.searchParams.get("type") || url.searchParams.get("mediaType") || "movie").trim().toLowerCase() === "tv" ? "tv" : "movie";
  const s = Number(url.searchParams.get("season") || url.searchParams.get("s") || 1) || 1;
  const e = Number(url.searchParams.get("episode") || url.searchParams.get("e") || 1) || 1;
  const offUrl = (url.searchParams.get("officialUrl") || url.searchParams.get("url") || "").trim();
  const reqTitle = (url.searchParams.get("title") || url.searchParams.get("displayTitle") || "").trim();
  const reqOrigTitle = (url.searchParams.get("originalTitle") || "").trim();
  const reqPoster = (url.searchParams.get("poster") || "").trim();
  const reqYear = (url.searchParams.get("year") || "").trim();

  const lookupKeys = [];
  if (id) {
    if (mtype === "tv") lookupKeys.push(`id:${id}:s${s}e${e}`);
    lookupKeys.push(`id:${id}`);
  }
  if (tmdbId) {
    lookupKeys.push(`id:${tmdbId}`);
    if (mtype === "tv") {
      lookupKeys.push(
        `tmdb:tv:${tmdbId}:s${s}e${e}`,
        `tmdb:tv:${tmdbId}:${s}:${e}`,
        `tv:${tmdbId}:s${s}e${e}`,
        `tv:${tmdbId}:${s}:${e}`,
        `tmdb:${tmdbId}:s${s}e${e}`,
        `tmdb:${tmdbId}:${s}:${e}`,
        `tmdb:tv:${tmdbId}`,
        `tv:${tmdbId}`
      );
    } else {
      lookupKeys.push(
        `tmdb:movie:${tmdbId}:1:1`,
        `tmdb:movie:${tmdbId}`,
        `movie:${tmdbId}:1:1`,
        `movie:${tmdbId}`,
        `tmdb:${tmdbId}:1:1`
      );
    }
    lookupKeys.push(`tmdb:${tmdbId}`);
  }
  if (offUrl) lookupKeys.push(`url:${offUrl}`);

async function resolveAnimecixLive(id, mtype, s, e, env) {
  const m = String(id || "").match(/^ac-(\d+)$/);
  if (!m) return null;
  const acId = m[1];
  const hdrs = {
    "User-Agent": UA_CHROME,
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://animecix.tv/",
  };
  try {
    let vids = null;
    if (mtype === "tv") {
      const r = await fetch(`https://animecix.tv/secure/episode-videos?titleId=${acId}&episode=${e}&season=${s}`, { headers: hdrs, signal: AbortSignal.timeout(4500) });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (Array.isArray(d) && d.length) vids = d;
      }
    } else {
      const r = await fetch(`https://animecix.tv/secure/videos?titleId=${acId}`, { headers: hdrs, signal: AbortSignal.timeout(4500) });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const list = d?.pagination?.data;
        if (Array.isArray(list) && list.length) {
          vids = list.filter((v) => !["teaser", "trailer", "clip", "opening", "ending"].includes(String(v?.category || "").toLowerCase()));
        }
      }
    }
    if (!Array.isArray(vids) || !vids.length) return null;
    for (const v of vids) {
      const tm = String(v?.url || "").match(/tau-video\.xyz\/embed\/([a-zA-Z0-9_-]+)/);
      if (!tm) continue;
      const tauId = tm[1];
      const tr = await fetch(`https://tau-video.xyz/api/video/${tauId}`, {
        headers: { "User-Agent": UA_CHROME, "Referer": `https://tau-video.xyz/embed/${tauId}` },
        signal: AbortSignal.timeout(4500),
      });
      if (!tr.ok) continue;
      const tj = await tr.json().catch(() => null);
      const urls = (tj?.urls || []).filter((x) => String(x?.url || "").startsWith("https://"));
      urls.sort((a, b) => {
        const ra = /1080|fhd/i.test(a.label || "") ? 0 : (/720/i.test(a.label || "") ? 1 : 2);
        const rb = /1080|fhd/i.test(b.label || "") ? 0 : (/720/i.test(b.label || "") ? 1 : 2);
        return ra - rb;
      });
      if (urls.length) {
        const mp4 = urls[0].url;
        const proxied = await buildSignedProxyPath(mp4, "https://tau-video.xyz/", ".mp4", env);
        return { url: proxied, streamType: "mp4" };
      }
    }
  } catch {}
  return null;
}

  const hit = await lookupVaultStream(lookupKeys, env);
  if (!hit) {
    const liveAc = id.startsWith("ac-") ? await resolveAnimecixLive(id, mtype, s, e, env) : null;
    if (liveAc) {
      return jsonResp({
        id: tmdbId || id,
        provider: "netflix",
        catalogProvider: "anime",
        tmdbId,
        mediaType: mtype,
        season: mtype === "tv" ? s : 0,
        episode: mtype === "tv" ? e : 0,
        title: reqTitle,
        seriesTitle: reqTitle,
        originalTitle: reqOrigTitle || reqTitle,
        year: reqYear,
        poster: reqPoster,
        thumbnail: reqPoster,
        backdrop: reqPoster,
        streamType: liveAc.streamType,
        url: liveAc.url,
        embedUrl: "",
        altUrls: [],
        servers: [{ id: "srv-1", label: "📡 Sunucu 1 · Cloudflare 7/24 (MP4 HD)", url: liveAc.url, streamType: liveAc.streamType }],
        subtitleTracks: [],
      });
    }
    const embedServers = buildEmbedServers(tmdbId, mtype, s, e);
    const primaryEmbed = embedServers[0]?.url || "";
    return jsonResp({
      id: tmdbId || id,
      provider: "embed",
      catalogProvider: "cinema",
      tmdbId,
      mediaType: mtype,
      season: mtype === "tv" ? s : 0,
      episode: mtype === "tv" ? e : 0,
      title: reqTitle,
      seriesTitle: reqTitle,
      originalTitle: reqOrigTitle || reqTitle,
      year: reqYear,
      poster: reqPoster,
      thumbnail: reqPoster,
      backdrop: reqPoster,
      streamType: "embed",
      url: primaryEmbed,
      embedUrl: primaryEmbed,
      altUrls: embedServers.slice(1).map((x) => x.url),
      servers: embedServers,
      subtitleTracks: [],
    });
  }

  const urls = [];
  const servers = [];
  for (let i = 0; i < hit.streams.length; i++) {
    const pair = hit.streams[i];
    const rawU = Array.isArray(pair) ? pair[0] : pair?.url;
    const kind = String(Array.isArray(pair) ? pair[1] || "" : pair?.kind || "").toLowerCase();
    if (!rawU) continue;
    const isYt = kind === "yt" || /youtube\.com\/|youtu\.be\//i.test(rawU);
    const isEmbed = kind.includes("embed") || rawU.includes("/embed/");
    if (isYt) {
      const mYt = rawU.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
      const vid = mYt ? mYt[1] : "";
      const embU = vid ? `https://www.youtube.com/embed/${vid}?autoplay=1&enablejsapi=1` : rawU;
      urls.push({ url: embU, streamType: "embed", label: `▶ Sunucu ${i + 1} · YouTube HD` });
      servers.push({ id: `srv-${i + 1}`, label: `▶ Sunucu ${i + 1} · YouTube HD`, url: embU, streamType: "embed" });
      continue;
    }
    if (isEmbed) {
      urls.push({ url: rawU, streamType: "embed", label: `🌐 Sunucu ${i + 1} · Embed HD` });
      servers.push({ id: `srv-${i + 1}`, label: `🌐 Sunucu ${i + 1} · Embed HD`, url: rawU, streamType: "embed" });
      continue;
    }
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

  const primary = urls[0] || buildEmbedServers(tmdbId || hit.tmdbId, mtype, s, e)[0] || { url: "", streamType: "embed" };
  const resolvedTitle = reqTitle || hit.title || "";
  return jsonResp({
    id: tmdbId || id,
    provider: primary.streamType === "embed" ? "embed" : "netflix",
    catalogProvider: "netflix",
    tmdbId: tmdbId || hit.tmdbId || "",
    mediaType: hit.mediaType || mtype,
    season: mtype === "tv" ? s : 0,
    episode: mtype === "tv" ? e : 0,
    title: resolvedTitle,
    seriesTitle: hit.title || resolvedTitle,
    originalTitle: hit.originalTitle || reqOrigTitle || resolvedTitle,
    year: hit.year || reqYear || "",
    poster: reqPoster,
    thumbnail: reqPoster,
    backdrop: reqPoster,
    streamType: primary.streamType,
    url: primary.url,
    embedUrl: primary.streamType === "embed" ? primary.url : "",
    altUrls: [],
    servers: servers.slice(0, 1),
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
  if (!text.trimStart().startsWith("#EXTM3U")) {
    const loc = await buildSignedProxyPath(finalBase, ref, ".mp4", env);
    return new Response(null, { status: 302, headers: { Location: loc, "Cache-Control": "no-store" } });
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

export async function handleEdgeStreamProxy(request, url) {
  const target = (url.searchParams.get("url") || url.searchParams.get("u") || "").trim();
  if (!target.startsWith("http")) return new Response("Missing stream URL", { status: 400 });
  const ref = (url.searchParams.get("referer") || url.searchParams.get("ref") || inferStreamReferer(target)).trim();
  const hdrs = new Headers({ "User-Agent": UA_CHROME, Accept: "*/*" });
  if (ref) {
    hdrs.set("Referer", ref);
    try { hdrs.set("Origin", new URL(ref).origin); } catch {}
  }
  const rangeHdr = request.headers.get("Range");
  if (rangeHdr) hdrs.set("Range", rangeHdr);
  try {
    const up = await fetch(target, { headers: hdrs, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const outHdrs = new Headers();
    for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
      const v = up.headers.get(k);
      if (v) outHdrs.set(k, v);
    }
    if (!outHdrs.has("Content-Type")) {
      outHdrs.set("Content-Type", target.includes(".mp4") ? "video/mp4" : "video/mp2t");
    }
    outHdrs.set("Access-Control-Allow-Origin", "*");
    outHdrs.set("Cache-Control", "public, max-age=300");
    return new Response(up.body, { status: up.status, headers: outHdrs });
  } catch {
    return new Response("Stream proxy upstream timeout", { status: 502 });
  }
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

export async function handleEdgePoster(url, env) {
  const target = (url.searchParams.get("u") || url.searchParams.get("url") || "").trim();
  if (target.startsWith("http://") || target.startsWith("https://")) {
    try {
      const ref = inferStreamReferer(target);
      const hdrs = { "User-Agent": UA_CHROME, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" };
      if (ref) hdrs.Referer = ref;
      const r = await fetch(target, { headers: hdrs, cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        return new Response(r.body, {
          status: r.status,
          headers: {
            "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    } catch {}
  }

  // Fallback: resolve poster via TMDB ID or Title
  const tid = (url.searchParams.get("tid") || url.searchParams.get("tmdbId") || "").trim();
  const title = (url.searchParams.get("t") || url.searchParams.get("ot") || "").trim();
  const mt = (url.searchParams.get("mt") || "movie").trim().toLowerCase() === "tv" ? "tv" : "movie";
  const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
  try {
    let posterPath = "";
    if (/^\d+$/.test(tid)) {
      const dr = await fetch(`https://api.themoviedb.org/3/${mt}/${tid}?api_key=${encodeURIComponent(apiKey)}&language=tr-TR`, { signal: AbortSignal.timeout(3500) });
      if (dr.ok) {
        const dj = await dr.json();
        posterPath = dj.poster_path || "";
      }
    }
    if (!posterPath && title) {
      const sr = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(apiKey)}&language=tr-TR&query=${encodeURIComponent(title)}&page=1`, { signal: AbortSignal.timeout(3500) });
      if (sr.ok) {
        const sj = await sr.json();
        const hit = (sj.results || []).find((x) => x.poster_path);
        if (hit) posterPath = hit.poster_path;
      }
    }
    if (posterPath) {
      const imgResp = await fetch(`https://image.tmdb.org/t/p/w500${posterPath}`, { cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(5000) });
      if (imgResp.ok) {
        return new Response(imgResp.body, {
          status: 200,
          headers: { "Content-Type": imgResp.headers.get("Content-Type") || "image/jpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" },
        });
      }
    }
  } catch {}

  if (env?.ASSETS) {
    const fallback = await env.ASSETS.fetch(new Request("https://assets.local/static/watchlivo-poster.svg"));
    if (fallback.ok) {
      return new Response(fallback.body, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
      });
    }
  }
  return new Response("Poster unavailable", { status: 404 });
}
