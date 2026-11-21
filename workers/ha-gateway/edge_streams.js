import {
  ANIMECIX_KNOWN_TMDB,
  isBlockedAdHost,
  isAdSegmentOrPlaylistUrl,
  isDirectEmbedPageUrl,
  filterM3u8AdDiscontinuities,
  resolveEmbedHtmlToHls,
  resolveTurkishCatalogStream,
} from "./edge_extractors.js";

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
  if (!u || u.includes("hakunaymatata.com") || u.includes("twimg.com")) return "";
  if (u.includes("diziyou.love")) return "https://www.diziyou.love/";
  if (u.includes("ksdpictures.")) return "https://ksdpictures.site/";
  if (u.includes("filmizle.in") || u.includes("monacesfofestom") || /newmoviescenas\d*\.shop/i.test(u)) return "https://player.filmizle.in/";
  if (u.includes("vixsrc.") || u.includes("vix-content.") || u.includes("blackpuma")) return "https://vixsrc.to/";
  if (u.includes("pilavyer")) return "https://pilavyerplay.top/";
  if (/ddizimag\d*\./i.test(u)) return "https://ddizimag2.icu/";
  if (u.includes("imgsapi.pro") || u.includes("ytenconline.xyz") || u.includes("filmmodu.")) return "https://www.filmmodu.one/";
  if (u.includes("dragonballzfans") || u.includes("hexa.su")) return "https://hexa.su/";
  if (u.includes("filmboom")) return "https://filmboom.top/";
  if (u.includes("tau-video") || u.includes("irtau1.") || u.includes("niko-")) return "https://tau-video.xyz/";
  if (u.includes("fastplay.") || u.includes(".cfd/")) {
    return u.includes("ag2m5.cfd") ? "https://x.ag2m5.cfd/" : "https://fastplay.mom/";
  }
  if (u.includes("uk-traffic-") || u.includes("cdn77s.com")) return "https://x.ag2m5.cfd/";
  if (u.includes("molystream") || u.includes("/sheila_")) return "https://dbx.molystream.org/";
  if ((u.includes("cdnimages") && u.includes("/hls/")) || u.includes("playmix.uno") || u.includes("hdfilmcehennemi") || u.includes("rapidrame.")) return "https://www.hdfilmcehennemi.nl/";
  if (u.includes("fullhdfilmizlesene")) return "https://www.fullhdfilmizlesene.now/";
  if (u.includes("dizibox")) return "https://www.dizibox.live/";
  if (u.includes("cdnimg") || u.includes("rapidvid") || /https:\/\/s\d+\.[^/]+\.shop\//.test(u)) return "https://rapidvid.org/";
  if (u.includes("makesomthingup") || u.includes("centralodsseyproud") || u.includes("/r6/")) return "https://one.makesomthingup.click/";
  if (u.includes("daioncdn.net/startv")) return "https://www.startv.com.tr/";
  if (u.includes("daioncdn.net/ntv")) return "https://www.ntv.com.tr/";
  if (u.includes("daioncdn.net/halktv")) return "https://halktv.com.tr/";
  if (u.includes("ercdn.net")) {
    if (u.includes("showtv")) return "https://www.showtv.com.tr/";
    if (u.includes("haberturk")) return "https://www.haberturk.com/";
    if (u.includes("bloomberght")) return "https://www.bloomberght.com/";
    return "https://www.ercdn.net/";
  }
  if (u.includes("sprintcdn") || u.includes("r66nv9ed") || u.includes("owphbf24") || u.includes("filemoon") || u.includes("byse.")) return "https://filemoon.sx/";
  if (u.includes("vmeas.") || u.includes("vidmoly") || u.includes("vmnow") || u.includes("vmpx") || u.includes("vmbox") || u.includes("vmget")) return "https://vidmoly.biz/";
  if (u.includes("tmgrup.com.tr") || u.includes("atv.com.tr")) return "https://www.atv.com.tr/";
  if (u.includes("radyotvonline.")) return "https://www.radyotvonline.com/";
  if (u.includes("trt.com.tr") || u.includes("trtizle.") || u.includes("trthaber")) return "https://www.trtizle.com/";
  if (u.includes("ensonhaber.com")) return "https://www.ensonhaber.com/";
  if (u.includes("powerapp.com.tr")) return "https://www.powerapp.com.tr/";
  if (u.includes("cdnvideo11.") || u.includes("streamingcdn5.") || u.includes("kisskh.")) return "https://kisskh.co/";
  if (["vidmoly.", "vmbox.", "vmnow.", "vmpx.", "vmget."].some((d) => u.includes(d))) return "https://vidmoly.biz/";
  return "";
}

export function isPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || "").trim());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  host = host.replace(/\.+$/, "");
  if (!host || isBlockedAdHost(host)) return false;
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.includes("metadata")
  ) {
    return false;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false;
  if (/^(0\d+|\d+|0x[0-9a-f]+)\./i.test(host) && !/[g-wyz]/i.test(host.replace(/x/gi, ""))) return false;
  if (host.includes(":")) {
    if (host === "::" || host === "::1" || host.startsWith("::ffff:")) return false;
    const firstHex = parseInt(host.split(":")[0] || "0", 16);
    if (!Number.isNaN(firstHex)) {
      if ((firstHex & 0xfe00) === 0xfc00) return false;
      if ((firstHex & 0xffc0) === 0xfe80) return false;
      if ((firstHex & 0xff00) === 0xff00) return false;
    }
    return false;
  }
  if (!host.includes(".")) return false;
  return true;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const _hmacKeyCache = new Map();
async function importEdgeHmacKey(secretStr, usage = "sign") {
  const s = String(secretStr || "").trim();
  if (!s) return null;
  const cacheKey = `${s}:${usage}`;
  if (_hmacKeyCache.has(cacheKey)) return _hmacKeyCache.get(cacheKey);
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(s), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
  if (_hmacKeyCache.size >= 16) _hmacKeyCache.clear();
  _hmacKeyCache.set(cacheKey, k);
  return k;
}

async function deriveEdgeFallbackProxySecret(env) {
  for (const k of ["VORTEX_SECRET", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_URL"]) {
    const cand = String(env?.[k] || "").trim();
    if (cand.length >= 24) {
      const key = await importEdgeHmacKey(cand, "sign");
      if (!key) continue;
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("watchlivo-shared-secret-v4:PROXY_SECRET"));
      return Array.from(new Uint8Array(mac)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  return "";
}

async function getEdgeProxyCryptoKeys(env) {
  const secrets = [];
  const explicit = String(env?.PROXY_SECRET || "").trim();
  if (explicit.length >= 16) secrets.push(explicit);
  const derived = await deriveEdgeFallbackProxySecret(env);
  if (derived && !secrets.includes(derived)) secrets.push(derived);
  const rawFallback = String(env?.PROXY_SECRET || env?.VORTEX_SECRET || "").trim();
  if (rawFallback && !secrets.includes(rawFallback)) secrets.push(rawFallback);
  const keys = [];
  for (const s of secrets) {
    const k = await importEdgeHmacKey(s, "sign");
    if (k) keys.push(k);
  }
  return keys;
}

export async function signProxySig(targetUrl, ref, env) {
  const keys = await getEdgeProxyCryptoKeys(env);
  if (!keys.length) return "";
  const exp = Math.floor(Date.now() / 1000) + 21600;
  const mac = await crypto.subtle.sign("HMAC", keys[0], new TextEncoder().encode(`${targetUrl}|${ref || ""}|${exp}`));
  const hex = Array.from(new Uint8Array(mac)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}.${exp}`;
}

export async function verifyProxySig(targetUrl, ref, sig, env) {
  if (!targetUrl || !sig || typeof sig !== "string") return false;
  const parts = sig.split(".");
  if (parts.length !== 2) return false;
  const [hex, expRaw] = parts;
  if (!/^[a-f0-9]{24}$/.test(hex) || !/^\d{9,12}$/.test(expRaw)) return false;
  if (parseInt(expRaw, 10) < Math.floor(Date.now() / 1000)) return false;
  const keys = await getEdgeProxyCryptoKeys(env);
  if (!keys.length) return false;
  const msg = new TextEncoder().encode(`${targetUrl}|${ref || ""}|${expRaw}`);
  for (const key of keys) {
    const mac = await crypto.subtle.sign("HMAC", key, msg);
    const expectedHex = Array.from(new Uint8Array(mac)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (timingSafeEqualStr(hex, expectedHex)) return true;
  }
  return false;
}

async function fetchPublicWithRedirects(initialUrl, headers, maxHops = 4, timeoutMs = 15000, cfOpts = undefined, headersOnlyTimeout = false, method = "GET") {
  let curUrl = String(initialUrl || "").trim();
  let curHeaders = headers instanceof Headers ? new Headers(headers) : new Headers(headers || {});
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!isPublicHttpUrl(curUrl)) throw new Error("Blocked redirect target");
    let ac = null;
    let timer = null;
    let sig;
    if (headersOnlyTimeout) {
      ac = new AbortController();
      timer = setTimeout(() => ac.abort(new DOMException("Connect timeout", "TimeoutError")), timeoutMs);
      sig = ac.signal;
    } else {
      sig = AbortSignal.timeout(timeoutMs);
    }
    const init = { method: method === "HEAD" ? "HEAD" : "GET", headers: curHeaders, redirect: "manual", signal: sig };
    if (cfOpts) init.cf = cfOpts;
    let resp;
    try {
      resp = await fetch(curUrl, init);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("Location");
      if (!loc) return { resp, finalUrl: curUrl };
      resp.body?.cancel?.();
      const nextUrl = new URL(loc, curUrl).toString();
      try {
        if (new URL(nextUrl).origin !== new URL(curUrl).origin) {
          curHeaders.delete("Origin");
        }
      } catch {}
      curUrl = nextUrl;
      continue;
    }
    return { resp, finalUrl: curUrl };
  }
  throw new Error("Too many redirects");
}

const OFFLOAD_PROXY_ORIGIN = "https://watchlivo-stream-proxy.watchlivo-edge.workers.dev";
const OFFLOAD_BYPASS_HOSTS = [
  "hakunaymatata.com", "vidmoly.", "vmbox.", "vmnow.", "vmpx.", "vmget.", "vmeas.",
  "sprintcdn", "r66nv9ed", "owphbf24", "filemoon.", "byse.",
  "webteizle.", "dizibox.", "sezonlukdizi.", "diziyou.", "ksdpictures.",
  "hdfilmcehennemi.", "fullhdfilmizlesene.", "rapidrame.", "rapidvid.", "cdnimg",
  "filmizle.in", "monacesfofestom", "vixsrc.", "vix-content.", "blackpuma", "twimg.com",
  "ag2m5.cfd", "uk-traffic-", "fastplay.",
  "radyotvonline.com", "radyotvonline.net", "nexa.mov", "dplayer", "playmix.",
  "makesomthingup.", "cdnimages.", "ercdn.net", "daioncdn.net",
  "dragonballzfans", "molystream.org", "irtau1.", "tau-video.", "niko-", "lightspeed.st",
  "pilavyer", "ddizimag.", "imgsapi.pro", "ytenconline.xyz", "filmmodu.",
  "bright67.", "centralodsseyproud", "5d06cffcf9563c", "gamma.",
];

async function buildSignedProxyPath(targetUrl, ref, ext, env) {
  const cleanRef = ref !== undefined ? ref : inferStreamReferer(targetUrl);
  const sig = await signProxySig(targetUrl, cleanRef, env);
  const q = new URLSearchParams({ url: targetUrl, sig, ext: ext || ".ts" });
  if (cleanRef) q.set("referer", cleanRef);
  let targetHost = "";
  try { targetHost = new URL(targetUrl).hostname.toLowerCase(); } catch {}
  const useLocal = (targetHost ? OFFLOAD_BYPASS_HOSTS.some((h) => h.endsWith(".") ? targetHost.includes(h) : (targetHost === h || targetHost.endsWith(`.${h}`) || targetHost.includes(h))) : false)
    || targetUrl.includes("/sheila_")
    || targetUrl.includes("/file/tau-video/")
    || String(cleanRef || "").includes("molystream.org")
    || String(cleanRef || "").includes("tau-video.xyz")
    || String(cleanRef || "").includes("filmmodu.")
    || String(cleanRef || "").includes("filmizle.in")
    || String(cleanRef || "").includes("vixsrc.")
    || String(cleanRef || "").includes("diziyou.")
    || String(cleanRef || "").includes("ksdpictures.")
    || String(cleanRef || "").includes("rapidvid.")
    || /^s\d+\.[a-z0-9-]+\.shop$/i.test(targetHost);
  const base = useLocal ? "" : OFFLOAD_PROXY_ORIGIN;
  return `${base}/api/rave/stream-proxy?${q.toString()}`;
}

async function lookupVaultStream(keys, env, expectedType = "") {
  if (!env?.ASSETS) return null;
  const uniqueKeys = [];
  const seenKeys = new Set();
  const buckets = new Set();
  for (const k of keys) {
    if (!k || seenKeys.has(k)) continue;
    seenKeys.add(k);
    uniqueKeys.push(k);
    buckets.add(fnv1aBucket(k).toString(16).padStart(2, "0"));
  }
  if (!uniqueKeys.length) return null;
  const shardMap = new Map();
  await Promise.all([...buckets].map(async (hex) => {
    try {
      const r = await env.ASSETS.fetch(new Request(`https://assets.local/_edge/streams/b${hex}.json`));
      if (r.ok) shardMap.set(hex, await r.json());
    } catch {}
  }));
  for (const k of uniqueKeys) {
    const hex = fnv1aBucket(k).toString(16).padStart(2, "0");
    const shard = shardMap.get(hex);
    const entry = shard && shard[k];
    if (entry && Array.isArray(entry.streams) && entry.streams.length) {
      if (expectedType && entry.mediaType && entry.mediaType !== expectedType) continue;
      return entry;
    }
  }
  return null;
}

function buildEmbedServers() {
  // Foreign popup-ad embed fallbacks (vidlink.pro, vidsrc, 2embed) are permanently disabled to prevent betting/popunder redirects.
  return [];
}

function appendStreamAudParam(streamUrl, audCode) {
  const u = String(streamUrl || "").trim();
  const aud = String(audCode || "").trim().toLowerCase();
  if (!u || !aud || !u.includes("/api/rave/stream")) return u;
  const cleaned = u.replace(/([?&])aud=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : "")).replace(/\?&/, "?").replace(/[?&]$/, "");
  if (cleaned.includes("&ext=.m3u8")) {
    return cleaned.replace("&ext=.m3u8", `&aud=${encodeURIComponent(aud)}&ext=.m3u8`);
  }
  return `${cleaned}${cleaned.includes("?") ? "&" : "?"}aud=${encodeURIComponent(aud)}`;
}

export function buildEdgeAudioTracks(servers, primaryUrl = "", reqOrigLang = "") {
  const list = Array.isArray(servers) ? servers.filter((s) => s && s.url) : [];
  if (!list.length) return [];
  const origCode = (String(reqOrigLang || "").trim().toLowerCase() || "orig");
  const isDualSrv = (s) => {
    const langs = Array.isArray(s.audioLangs) ? s.audioLangs : [];
    if (langs.includes("tr") && langs.some((l) => l && l !== "tr")) return true;
    return /dublaj\s*\+\s*orijinal|çoklu\s*ses/i.test(String(s.label || ""));
  };
  const isTrOnlySrv = (s) => {
    const langs = Array.isArray(s.audioLangs) ? s.audioLangs : [];
    if (langs.length) return langs.includes("tr") && !langs.some((l) => l !== "tr");
    return /türkçe\s*dublaj|tr\s*dublaj/i.test(String(s.label || "")) && !/orijinal|altyaz/i.test(String(s.label || ""));
  };
  const isOrigOnlySrv = (s) => {
    const langs = Array.isArray(s.audioLangs) ? s.audioLangs : [];
    if (langs.length) return !langs.includes("tr") && langs.some((l) => Boolean(l));
    return /altyaz|orijinal/i.test(String(s.label || "")) && !/dublaj/i.test(String(s.label || ""));
  };

  const dualSrv = list.find(isDualSrv);
  const trOnlySrv = list.find(isTrOnlySrv);
  const origOnlySrv = list.find(isOrigOnlySrv);

  if (dualSrv) {
    const dualLangs = Array.isArray(dualSrv.audioLangs) ? dualSrv.audioLangs : [];
    const nonTrLang = dualLangs.find((l) => l && l !== "tr") || origCode;
    const origLabel = nonTrLang === "en" ? "🇬🇧 İngilizce (Orijinal Ses · 1080p)" : "🎬 Orijinal Ses (1080p HD)";
    return [
      {
        id: "tr-dub",
        lang: "tr",
        targetLang: "tr",
        audioLang: "tr",
        label: "🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)",
        mode: "stream",
        source: dualSrv.source || "",
        url: appendStreamAudParam(dualSrv.url, "tr"),
      },
      {
        id: "orig",
        lang: "orig",
        targetLang: "orig",
        audioLang: nonTrLang || "orig",
        label: origLabel,
        mode: "stream",
        source: dualSrv.source || "",
        url: appendStreamAudParam(dualSrv.url, "orig"),
      },
    ];
  }

  if (trOnlySrv && origOnlySrv) {
    const nonTrLang = (Array.isArray(origOnlySrv.audioLangs) ? origOnlySrv.audioLangs.find((l) => l && l !== "tr") : "") || origCode;
    const origLabel = nonTrLang === "en" ? "🇬🇧 İngilizce (Orijinal Ses · 1080p)" : "🎬 Orijinal Ses (1080p HD)";
    return [
      {
        id: "tr-dub",
        lang: "tr",
        targetLang: "tr",
        audioLang: "tr",
        label: "🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)",
        mode: "stream",
        source: trOnlySrv.source || "",
        url: trOnlySrv.url,
      },
      {
        id: "orig",
        lang: "orig",
        targetLang: "orig",
        audioLang: nonTrLang || "orig",
        label: origLabel,
        mode: "stream",
        source: origOnlySrv.source || "",
        url: origOnlySrv.url,
      },
    ];
  }

  if (trOnlySrv && !origOnlySrv) {
    const isNativeTr = origCode === "tr";
    return [
      {
        id: isNativeTr ? "tr-orig" : "tr-dub",
        lang: "tr",
        targetLang: "tr",
        audioLang: "tr",
        label: isNativeTr ? "🇹🇷 Türkçe (Orijinal Ses · 1080p)" : "🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)",
        mode: "stream",
        source: trOnlySrv.source || "",
        url: trOnlySrv.url,
      },
    ];
  }

  if (origOnlySrv) {
    const nonTrLang = (Array.isArray(origOnlySrv.audioLangs) ? origOnlySrv.audioLangs.find((l) => l && l !== "tr") : "") || origCode;
    const origLabel = nonTrLang === "en" ? "🇬🇧 İngilizce (Orijinal Ses · 1080p)" : "🎬 Orijinal Ses (1080p HD)";
    return [
      {
        id: "orig",
        lang: "orig",
        targetLang: "orig",
        audioLang: nonTrLang || "orig",
        label: origLabel,
        mode: "stream",
        source: origOnlySrv.source || "",
        url: origOnlySrv.url,
      },
    ];
  }

  const fallbackUrl = primaryUrl || list[0].url;
  return [
    {
      id: "orig",
      lang: "orig",
      targetLang: "orig",
      audioLang: origCode,
      label: origCode === "en" ? "🇬🇧 İngilizce (Orijinal Ses · 1080p)" : "🎬 Orijinal Ses (1080p HD)",
      mode: "stream",
      source: list[0]?.source || "",
      url: fallbackUrl,
    },
  ];
}

export async function handleEdgeResolveCatalog(url, env, jsonResp) {
  const id = (url.searchParams.get("id") || "").trim();
  const rawIdM = id.match(/^tmdb-(?:tv|movie)-(\d+)$/i);
  const tmdbId = (url.searchParams.get("tmdbId") || (rawIdM ? rawIdM[1] : "")).trim();
  const mtype = (url.searchParams.get("type") || url.searchParams.get("mediaType") || "movie").trim().toLowerCase() === "tv" ? "tv" : "movie";
  const s = Number(url.searchParams.get("season") || url.searchParams.get("s") || 1) || 1;
  const e = Number(url.searchParams.get("episode") || url.searchParams.get("e") || 1) || 1;
  const offUrl = (url.searchParams.get("officialUrl") || url.searchParams.get("sourceUrl") || url.searchParams.get("url") || "").trim();
  const reqDisplayTitle = (url.searchParams.get("displayTitle") || url.searchParams.get("title") || "").trim();
  const reqTitle = (url.searchParams.get("title") || reqDisplayTitle).trim();
  const reqOrigTitle = (url.searchParams.get("originalTitle") || url.searchParams.get("origTitle") || "").trim();
  const rawReqPoster = (url.searchParams.get("poster") || "").trim();
  const reqPoster = rawReqPoster || (/^\d+$/.test(tmdbId) ? `/api/rave/poster?tid=${tmdbId}&mt=${mtype}` : "");
  const reqYear = (url.searchParams.get("year") || "").trim();

  const isFirstEp = mtype !== "tv" || (s === 1 && e === 1);
  const bypassCache = url.searchParams.get("refresh") === "1";
  const knownAcForTmdb = /^\d+$/.test(tmdbId) ? ANIMECIX_KNOWN_TMDB[tmdbId] : 0;
  const lookupKeys = [];
  if (id) {
    if (mtype === "tv") lookupKeys.push(`id:${id}:s${s}e${e}`);
    if (isFirstEp && !/^\d+$/.test(id)) lookupKeys.push(`id:${id}`);
  }
  if (knownAcForTmdb && mtype === "tv") {
    lookupKeys.push(`id:ac-${knownAcForTmdb}:s${s}e${e}`);
  }
  if (tmdbId) {
    if (mtype === "tv") {
      lookupKeys.push(
        `tmdb:tv:${tmdbId}:s${s}e${e}`,
        `tmdb:tv:${tmdbId}:${s}:${e}`,
        `tv:${tmdbId}:s${s}e${e}`,
        `tv:${tmdbId}:${s}:${e}`,
        `tmdb:${tmdbId}:s${s}e${e}`,
        `tmdb:${tmdbId}:${s}:${e}`
      );
      if (isFirstEp) {
        lookupKeys.push(`tmdb:tv:${tmdbId}`, `tv:${tmdbId}`);
      }
    } else {
      lookupKeys.push(
        `tmdb:movie:${tmdbId}:1:1`,
        `tmdb:movie:${tmdbId}`,
        `movie:${tmdbId}:1:1`,
        `movie:${tmdbId}`
      );
    }
  }
  if (offUrl && isFirstEp) lookupKeys.push(`url:${offUrl}`);

async function resolveAnimecixLive(id, mtype, s, e, env, reqTitle = "", reqOrigTitle = "", tmdbId = "", bypassCache = false) {
  const m = String(id || "").match(/^ac-(\d+)(?:-\d+)?$/);
  const knownByTmdb = tmdbId && ANIMECIX_KNOWN_TMDB[String(tmdbId).trim()] ? String(ANIMECIX_KNOWN_TMDB[String(tmdbId).trim()]) : "";
  let acId = knownByTmdb || (m ? m[1] : "");
  const hdrs = {
    "User-Agent": UA_CHROME,
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://animecix.tv/",
  };
  try {
    const tidNum = Number(tmdbId || 0);
    if (!acId && tidNum && env?.WATCHLIVO_KV && !bypassCache) {
      const cachedAc = await env.WATCHLIVO_KV.get(`ac_tmdb_v2:${tidNum}`).catch(() => null);
      if (cachedAc) acId = String(cachedAc).trim();
    }
    if (!acId) {
      const isLatin = (str) => Boolean(str && !/[\u3040-\u30ff\u4e00-\u9faf\u0400-\u04ff]/.test(str));
      const queries = [];
      if (isLatin(reqTitle)) queries.push(reqTitle);
      if (isLatin(reqOrigTitle) && reqOrigTitle !== reqTitle) queries.push(reqOrigTitle);
      if (!queries.length && tidNum) {
        const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
        const tr = await fetch(`https://api.themoviedb.org/3/${mtype === "tv" ? "tv" : "movie"}/${tidNum}?api_key=${encodeURIComponent(apiKey)}&language=en-US`, { signal: AbortSignal.timeout(2500) });
        if (tr.ok) {
          const tj = await tr.json().catch(() => null);
          if (tj?.name || tj?.title) queries.push(tj.name || tj.title);
        }
      }
      for (const qRaw of queries) {
        const sr = await fetch(`https://animecix.tv/secure/search/${encodeURIComponent(qRaw)}?limit=20`, { headers: hdrs, signal: AbortSignal.timeout(3500) });
        if (!sr.ok) {
          sr.body?.cancel?.();
          continue;
        }
        const sd = await sr.json().catch(() => null);
        const results = Array.isArray(sd?.results) ? sd.results : [];
        const isAcId = String(id || "").startsWith("ac-");
        const exactTmdb = tidNum ? results.find((x) => Number(x?.tmdb_id) === tidNum && (x?.title_type === "anime" || x?.is_series)) : null;
        const picked = exactTmdb || ((!isAcId && tidNum > 0) ? null : (
          results.find((x) => x?.title_type === "anime" && (mtype !== "tv" || x?.is_series) && (!tidNum || !x?.tmdb_id || Number(x.tmdb_id) === tidNum)) ||
          results.find((x) => x?.title_type === "anime" && (!tidNum || !x?.tmdb_id || Number(x.tmdb_id) === tidNum))
        ));
        if (picked?.id) {
          acId = String(picked.id);
          if (tidNum && env?.WATCHLIVO_KV) {
            await env.WATCHLIVO_KV.put(`ac_tmdb_v2:${tidNum}`, acId, { expirationTtl: 86400 }).catch(() => {});
          }
          break;
        }
      }
    }
    if (!acId) return null;
    if (env?.WATCHLIVO_KV && !bypassCache) {
      const cachedEp = await env.WATCHLIVO_KV.get(`ac_ep:${acId}:${mtype}:${s}:${e}`).catch(() => null);
      if (cachedEp && cachedEp.startsWith("https://")) {
        const proxied = await buildSignedProxyPath(cachedEp, "https://tau-video.xyz/", ".mp4", env);
        return { url: proxied, streamType: "mp4" };
      }
    }
    let vids = null;
    if (mtype === "tv") {
      const seCandidates = [[s, e]];
      if (tidNum === 85937 && s >= 2) {
        seCandidates.push([s + 1, e]);
        if (s === 2 && e > 7) seCandidates.push([3, e - 7]);
        if (s === 3) seCandidates.push([2, e + 7]);
        seCandidates.push([s - 1, e]);
      } else if (s >= 2) {
        seCandidates.push([s - 1, e], [s + 1, e]);
      }
      const seenSe = new Set();
      for (const [cs, ce] of seCandidates) {
        if (cs < 1 || ce < 1) continue;
        const keySe = `${cs}:${ce}`;
        if (seenSe.has(keySe)) continue;
        seenSe.add(keySe);
        const r = await fetch(`https://animecix.tv/secure/episode-videos?titleId=${acId}&episode=${ce}&season=${cs}`, { headers: hdrs, signal: AbortSignal.timeout(4500) });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (Array.isArray(d) && d.length) {
            vids = d;
            break;
          }
        } else {
          r.body?.cancel?.();
        }
      }
    } else {
      const r = await fetch(`https://animecix.tv/secure/videos?titleId=${acId}`, { headers: hdrs, signal: AbortSignal.timeout(4500) });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        const list = d?.pagination?.data;
        if (Array.isArray(list) && list.length) {
          vids = list.filter((v) => !["teaser", "trailer", "clip", "opening", "ending"].includes(String(v?.category || "").toLowerCase()));
        }
      } else {
        r.body?.cancel?.();
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
      if (!tr.ok) {
        tr.body?.cancel?.();
        continue;
      }
      const tj = await tr.json().catch(() => null);
      const urls = (tj?.urls || []).filter((x) => String(x?.url || "").startsWith("https://"));
      urls.sort((a, b) => {
        const ra = /1080|fhd/i.test(a.label || "") ? 0 : (/720/i.test(a.label || "") ? 1 : 2);
        const rb = /1080|fhd/i.test(b.label || "") ? 0 : (/720/i.test(b.label || "") ? 1 : 2);
        return ra - rb;
      });
      if (urls.length) {
        const mp4 = urls[0].url;
        if (env?.WATCHLIVO_KV) {
          await env.WATCHLIVO_KV.put(`ac_ep:${acId}:${mtype}:${s}:${e}`, mp4, { expirationTtl: 14400 }).catch(() => {});
        }
        const proxied = await buildSignedProxyPath(mp4, "https://tau-video.xyz/", ".mp4", env);
        return { url: proxied, streamType: "mp4" };
      }
    }
  } catch {}
  return null;
}

  const hitRaw = bypassCache ? null : await lookupVaultStream(lookupKeys, env, mtype);
  const hitStreams = Array.isArray(hitRaw?.streams) ? hitRaw.streams : [];
  const isDeadShardPair = (pair) => {
    const u = String(Array.isArray(pair) ? pair[0] : pair?.url || "").toLowerCase();
    const k = String(Array.isArray(pair) ? pair[1] || "" : pair?.kind || "").toLowerCase();
    return (
      k === "yt" ||
      u.includes("youtube.com/") ||
      u.includes("youtu.be/") ||
      u.includes("pilavyer") ||
      u.includes("dragonballzfans") ||
      u.includes("dplayer") ||
      u.includes("playmix.uno") ||
      (u.includes("cdnimages") && (u.includes("/hls/") || u.includes("/master.txt"))) ||
      /^https?:\/\/s\d+\.[a-z0-9-]+\.shop\//i.test(u) ||
      u.includes(".shop/mo/") ||
      u.includes(".shop/mj/") ||
      u.includes("hdfilmcehennemi.mobi") ||
      u.includes("lightspeed.st") ||
      u.includes(".asia/") ||
      u.includes("ytconvertor.") ||
      u.includes("canvopics.") ||
      u.includes("ytenconline.xyz") ||
      u.includes("ineedskin.cfd") ||
      (u.includes("vmpx.") && (u.includes("asn=") || u.includes("&i=")))
    );
  };
  const aliveStreams = hitStreams.filter((pair) => !isDeadShardPair(pair));
  const hit = hitRaw && aliveStreams.length ? { ...hitRaw, streams: aliveStreams } : null;
  if (!hit) {
    const buildAnimeResp = (liveAc) => jsonResp({
      id: tmdbId || id,
      provider: "netflix",
      catalogProvider: "anime",
      tmdbId,
      imdbId: (url.searchParams.get("imdbId") || url.searchParams.get("imdb_id") || "").trim(),
      origLang: (url.searchParams.get("origLang") || "ja").trim(),
      mediaType: mtype,
      season: mtype === "tv" ? s : 0,
      episode: mtype === "tv" ? e : 0,
      title: reqDisplayTitle || reqTitle,
      seriesTitle: reqDisplayTitle || reqTitle,
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
      audioTracks: [{ id: "orig", lang: "orig", targetLang: "orig", audioLang: "ja", label: "🎬 Orijinal Ses (Japonca · HD)", mode: "stream", url: liveAc.url }],
      subtitleTracks: [],
    });
    const reqProv = (url.searchParams.get("provider") || "").trim().toLowerCase();
    const reqOrigLang = (url.searchParams.get("origLang") || "").trim().toLowerCase();
    const isAnimeCandidate =
      id.startsWith("ac-") ||
      url.searchParams.get("isAnime") === "1" ||
      url.searchParams.get("catalogProvider") === "anime" ||
      reqProv === "anime" ||
      reqOrigLang === "ja" ||
      hitRaw?.catalogProvider === "anime";
    const liveAc = isAnimeCandidate
      ? await resolveAnimecixLive(id, mtype, s, e, env, reqTitle, reqOrigTitle, tmdbId, bypassCache)
      : null;
    if (liveAc) return buildAnimeResp(liveAc);

    let effectiveSourceUrl = offUrl;
    if (!effectiveSourceUrl && mtype === "movie") {
      if (/^sc-[a-z0-9-]+$/i.test(id)) {
        effectiveSourceUrl = `https://sinemacc.com/film/${id.slice(3)}/`;
      } else if (/^fhd-[a-z0-9-]+$/i.test(id)) {
        effectiveSourceUrl = `https://www.fullhdfilmizlesene.now/film/${id.slice(4)}/`;
      }
    }

    const trLive = await resolveTurkishCatalogStream({
      title: reqTitle,
      displayTitle: url.searchParams.get("displayTitle") || reqTitle,
      originalTitle: reqOrigTitle,
      sourceUrl: effectiveSourceUrl,
      year: reqYear,
      mtype,
      s,
      e,
      tmdbId,
      fetchPublicFn: fetchPublicWithRedirects,
    });
    if (trLive?.url && isPublicHttpUrl(trLive.url)) {
      const rawCandList = Array.isArray(trLive.streams) && trLive.streams.length
        ? trLive.streams
        : [{ url: trLive.url, referer: trLive.referer, label: "" }];
      const isVmpxCand = (u) => /(?:vmpx\.|vidmoly\.|vmbox\.|vmnow\.|vmget\.)/i.test(String(u || ""));
      const isCfVmpxCand = (u) => /vmpx\./i.test(String(u || "")) && /(?:[?&])asn=(?:132892|13335)\b/i.test(String(u || ""));
      const hasNonVmpx = rawCandList.some((c) => c?.url && isPublicHttpUrl(c.url) && !isVmpxCand(c.url));
      const candList = (hasNonVmpx ? rawCandList.filter((c) => !isCfVmpxCand(c?.url)) : [...rawCandList])
        .sort((a, b) => (isVmpxCand(a?.url) ? 1 : 0) - (isVmpxCand(b?.url) ? 1 : 0));
      const trUrls = [];
      const trServers = [];
      for (const cItem of candList) {
        const rawC = String(cItem?.url || "").trim();
        if (!rawC || !isPublicHttpUrl(rawC)) continue;
        const cIsMp4 = /\.mp4(\?|$)/i.test(rawC);
        const cRef = cItem.referer || inferStreamReferer(rawC);
        const cProxied = cIsMp4
          ? await buildSignedProxyPath(rawC, cRef, ".mp4", env)
          : `/api/rave/stream?tmdbId=${encodeURIComponent(tmdbId || id)}&mtype=${encodeURIComponent(mtype)}&sid=${b64UrlEncode(rawC)}${cRef ? `&ref=${b64UrlEncode(cRef)}` : ""}&proxy_segs=1&ext=.m3u8`;
        if (!trUrls.includes(cProxied)) {
          trUrls.push(cProxied);
          trServers.push({
            id: `srv-${trServers.length + 1}`,
            label: cItem.label || `📡 Sunucu ${trServers.length + 1} · Edge Direct (${cIsMp4 ? "MP4 HD" : "1080p HLS"})`,
            url: cProxied,
            streamType: cIsMp4 ? "mp4" : "hls",
            source: cItem.source || "",
            audioLangs: Array.isArray(cItem.audioLangs) ? cItem.audioLangs : [],
          });
        }
      }
      if (trUrls.length) {
        const reqAud = (url.searchParams.get("aud") || "").trim().toLowerCase();
        const trAudioTracks = buildEdgeAudioTracks(trServers, trUrls[0], reqOrigLang);
        let chosenUrl = trUrls[0];
        let chosenStreamType = trServers[0].streamType;
        if (reqAud === "tr" || reqAud === "tr-dub" || reqAud === "dub") {
          const trTrack = trAudioTracks.find((t) => t.id === "tr-dub" && t.url);
          if (trTrack) chosenUrl = trTrack.url;
        } else if (reqAud === "orig" || reqAud === "en" || reqAud === "eng") {
          const origTrack = trAudioTracks.find((t) => t.id === "orig" && t.url);
          if (origTrack) chosenUrl = origTrack.url;
        } else {
          const trTrack = trAudioTracks.find((t) => t.id === "tr-dub" && t.url);
          if (trTrack && trTrack.url.includes("&aud=tr")) chosenUrl = trTrack.url;
        }
        const stripAudQ = (u) => String(u || "").replace(/([?&])aud=[^&]*/gi, "$1").replace(/\?&/, "?").replace(/[?&]$/, "");
        const matchedChosenSrv = trServers.find((sv) => sv.url === chosenUrl || stripAudQ(sv.url) === stripAudQ(chosenUrl));
        if (matchedChosenSrv) chosenStreamType = matchedChosenSrv.streamType;
        const primarySubSource = matchedChosenSrv?.source || trServers[0]?.source || trLive.source || "";
        const trSubs = formatStreamSubTracks(trLive.subs || [], primarySubSource);
        return jsonResp({
          id: tmdbId || id,
          provider: "netflix",
          catalogProvider: "cinema",
          tmdbId,
          imdbId: (url.searchParams.get("imdbId") || url.searchParams.get("imdb_id") || "").trim(),
          origLang: reqOrigLang || "",
          mediaType: mtype,
          season: mtype === "tv" ? s : 0,
          episode: mtype === "tv" ? e : 0,
          title: reqDisplayTitle || reqTitle,
          seriesTitle: reqDisplayTitle || reqTitle,
          originalTitle: reqOrigTitle || reqTitle,
          year: reqYear,
          poster: reqPoster,
          thumbnail: reqPoster,
          backdrop: reqPoster,
          streamType: chosenStreamType,
          url: chosenUrl,
          embedUrl: "",
          altUrls: trUrls.filter((u) => u !== chosenUrl),
          servers: trServers,
          audioTracks: trAudioTracks,
          subtitleTracks: trSubs,
        });
      }
    }
    if (!isAnimeCandidate && /^\d+$/.test(tmdbId)) {
      try {
        const apiKey = String(env?.TMDB_API_KEY || DEFAULT_TMDB_KEY).trim();
        const tmResp = await fetch(`https://api.themoviedb.org/3/${mtype}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(2500) });
        if (tmResp.ok) {
          const tj = await tmResp.json().catch(() => null);
          const isJaOrAnim = tj?.original_language === "ja" || (Array.isArray(tj?.genres) && tj.genres.some((g) => Number(g?.id) === 16));
          if (isJaOrAnim) {
            const fbAc = await resolveAnimecixLive(id, mtype, s, e, env, reqTitle, reqOrigTitle, tmdbId, bypassCache);
            if (fbAc) return buildAnimeResp(fbAc);
          }
        } else {
          tmResp.body?.cancel?.();
        }
      } catch {}
    }
    return jsonResp({ ok: false, error: "Bu içerik için doğrudan akış kaynağı şu an bulunamadı." }, 404);
  }

  const urls = [];
  const servers = [];
  for (let i = 0; i < hit.streams.length; i++) {
    const pair = hit.streams[i];
    const rawU = Array.isArray(pair) ? pair[0] : pair?.url;
    const kind = String(Array.isArray(pair) ? pair[1] || "" : pair?.kind || "").toLowerCase();
    if (!rawU) continue;
    const isYt = kind === "yt" || /youtube\.com\/|youtu\.be\//i.test(rawU);
    const isDirectEmbedPage = isDirectEmbedPageUrl(rawU);
    const isEmbed = !isDirectEmbedPage && (kind.includes("embed") || rawU.includes("/embed/"));
    if (isYt) {
      const mYt = rawU.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
      const vid = mYt ? mYt[1] : "";
      const embU = vid ? `https://www.youtube.com/embed/${vid}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(url.origin)}` : rawU;
      urls.push({ url: embU, streamType: "embed", label: `▶ Sunucu ${i + 1} · YouTube HD` });
      servers.push({ id: `srv-${i + 1}`, label: `▶ Sunucu ${i + 1} · YouTube HD`, url: embU, streamType: "embed" });
      continue;
    }
    if (isEmbed) {
      if (!isPublicHttpUrl(rawU)) continue;
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

  const subs = formatStreamSubTracks(hit.subs || []);

  if (!urls.length) {
    return jsonResp({ ok: false, error: "Bu içerik için güvenli doğrudan akış kaynağı bulunamadı." }, 404);
  }
  const primary = urls[0];
  const resolvedTitle = reqDisplayTitle || reqTitle || hit.title || "";
  const backupAltUrls = urls.slice(1).filter((x) => x.url && x.streamType !== "embed").map((x) => x.url);
  const vaultServers = servers.slice(0, 8);
  const vaultAudioTracks = buildEdgeAudioTracks(vaultServers, primary.url, (url.searchParams.get("origLang") || hit.origLang || "").trim());
  return jsonResp({
    id: tmdbId || id,
    provider: primary.streamType === "embed" ? "embed" : "netflix",
    catalogProvider: "netflix",
    tmdbId: tmdbId || hit.tmdbId || "",
    imdbId: (url.searchParams.get("imdbId") || url.searchParams.get("imdb_id") || hit.imdbId || "").trim(),
    origLang: (url.searchParams.get("origLang") || hit.origLang || "").trim(),
    mediaType: hit.mediaType || mtype,
    season: mtype === "tv" ? s : 0,
    episode: mtype === "tv" ? e : 0,
    title: resolvedTitle,
    seriesTitle: reqDisplayTitle || hit.title || resolvedTitle,
    originalTitle: hit.originalTitle || reqOrigTitle || resolvedTitle,
    year: hit.year || reqYear || "",
    poster: reqPoster,
    thumbnail: reqPoster,
    backdrop: reqPoster,
    streamType: primary.streamType,
    url: primary.url,
    embedUrl: primary.streamType === "embed" ? primary.url : "",
    altUrls: backupAltUrls,
    servers: vaultServers,
    audioTracks: vaultAudioTracks,
    subtitleTracks: subs,
  });
}

export async function handleEdgeHlsManifest(url, env) {
  let target = (url.searchParams.get("url") || url.searchParams.get("u") || "").trim();
  const sid = (url.searchParams.get("sid") || "").trim();
  if (!target && sid) {
    try { target = b64UrlDecode(sid); } catch { return new Response("Invalid sid", { status: 400, headers: { "Cache-Control": "no-store" } }); }
  }
  if (!target) return new Response("Missing stream URL", { status: 400, headers: { "Cache-Control": "no-store" } });
  const isDirectEmbed = isDirectEmbedPageUrl(target);
  if (!isDirectEmbed && !isPublicHttpUrl(target)) {
    return new Response("Blocked target URL", { status: 403, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  let ref = "";
  const rawRefParam = (url.searchParams.get("ref") || "").trim();
  if (rawRefParam) {
    try {
      const decRef = rawRefParam.startsWith("https://") ? rawRefParam : b64UrlDecode(rawRefParam).trim();
      if (decRef.startsWith("https://") && isPublicHttpUrl(decRef)) ref = decRef;
    } catch {}
  }
  if (!ref) ref = inferStreamReferer(target);
  if (isDirectEmbed) {
    const unwrapped = await resolveEmbedHtmlToHls(target, fetchPublicWithRedirects).catch(() => null);
    if (!unwrapped?.url || !isPublicHttpUrl(unwrapped.url)) {
      return new Response("Upstream embed stream unavailable", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    target = unwrapped.url;
    ref = unwrapped.referer || inferStreamReferer(target) || ref;
  }
  const hdrs = { "User-Agent": UA_CHROME, Accept: "*/*" };
  if (ref) { hdrs.Referer = ref; try { hdrs.Origin = new URL(ref).origin; } catch {} }

  let up, finalBase;
  try {
    ({ resp: up, finalUrl: finalBase } = await fetchPublicWithRedirects(target, hdrs, 4, 14000));
  } catch (err) {
    const msg = String(err?.message || "").includes("Blocked") ? "Blocked target URL" : "Upstream HLS fetch failed";
    return new Response(msg, { status: msg.startsWith("Blocked") ? 403 : 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (!up.ok) {
    up.body?.cancel?.();
    return new Response(`Upstream HLS ${up.status}`, { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (!isPublicHttpUrl(finalBase)) {
    up.body?.cancel?.();
    return new Response("Blocked redirect URL", { status: 403, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }

  const ct = (up.headers.get("Content-Type") || "").toLowerCase();
  const cl = Number(up.headers.get("Content-Length") || 0);
  if (ct.includes("svg") || ct.includes("javascript") || ct.includes("ecmascript") || (ct.includes("html") && cl > 2 * 1024 * 1024)) {
    up.body?.cancel?.();
    return new Response("Upstream returned non-playlist document", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (ct.includes("video/") || ct.includes("audio/") || (cl > 4 * 1024 * 1024 && !ct.includes("mpegurl"))) {
    up.body?.cancel?.();
    const loc = await buildSignedProxyPath(finalBase, ref, ct.includes("mp4") ? ".mp4" : ".ts", env);
    return new Response(null, { status: 302, headers: { Location: loc, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }

  const text = await up.text();
  const trimmedHead = text.trimStart();
  if (/^(?:<!doctype|<html|<script|<svg)/i.test(trimmedHead)) {
    return new Response("Upstream returned HTML instead of HLS", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (!trimmedHead.startsWith("#EXTM3U")) {
    if (ct.includes("html")) {
      return new Response("Upstream returned non-playlist document", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    const loc = await buildSignedProxyPath(finalBase, ref, ".mp4", env);
    return new Response(null, { status: 302, headers: { Location: loc, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  const cleanText = filterM3u8AdDiscontinuities(text);
  const isMaster = cleanText.includes("#EXT-X-STREAM-INF");
  const maxHeightParam = Math.max(0, Math.min(2160, Number(url.searchParams.get("max_h") || 0) || 0));
  const abrLowStart = url.searchParams.get("abr_low") === "1";
  const audParam = (url.searchParams.get("aud") || "").trim().toLowerCase();
  const lines = cleanText.split(/\r?\n/);
  const outRaw = await Promise.all(lines.map(async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        return await replaceAsyncUri(line, finalBase, ref, env, trimmed.startsWith("#EXT-X-MEDIA"));
      }
      return line;
    }
    let abs = "";
    try { abs = new URL(trimmed, finalBase).toString(); } catch { return "# blocked-invalid-uri"; }
    if (!isPublicHttpUrl(abs)) return "# blocked-non-public-uri";
    if (isAdSegmentOrPlaylistUrl(abs)) return "# filtered-ad-uri";
    if (isMaster || /\.m3u8(\?|$)/i.test(abs)) {
      return `/api/rave/stream?sid=${b64UrlEncode(abs)}${ref ? `&ref=${b64UrlEncode(ref)}` : ""}&proxy_segs=1&ext=.m3u8`;
    }
    const ext = /\.m4s(\?|$)/i.test(abs)
      ? ".m4s"
      : /\.mp4(\?|$)/i.test(abs)
      ? ".mp4"
      : /\.aac(\?|$)/i.test(abs)
      ? ".aac"
      : /\.m4a(\?|$)/i.test(abs)
      ? ".m4a"
      : /\.mp3(\?|$)/i.test(abs)
      ? ".mp3"
      : /\.vtt(\?|$)/i.test(abs)
      ? ".vtt"
      : ".ts";
    return await buildSignedProxyPath(abs, ref, ext, env);
  }));
  const out = outRaw.filter((ln) => ln !== null);
  let finalBody = out.join("\n");
  let variantHeader = "";
  if (isMaster) {
    const adapted = adaptMasterM3u8Variants(out, { maxHeight: maxHeightParam, lowStart: abrLowStart, aud: audParam });
    finalBody = adapted.body;
    variantHeader = adapted.heights.join(",");
  }
  const respHeaders = {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (variantHeader) {
    respHeaders["X-Watchlivo-Variants"] = variantHeader;
    respHeaders["Access-Control-Expose-Headers"] = "X-Watchlivo-Variants";
  }
  return new Response(finalBody, {
    status: 200,
    headers: respHeaders,
  });
}

function setHlsMediaAttr(line, attr, value) {
  const re = new RegExp(`\\b${attr}=(?:YES|NO)`, "i");
  if (re.test(line)) return line.replace(re, `${attr}=${value}`);
  return `${line},${attr}=${value}`;
}

function isTrAudioMediaLine(line) {
  const langM = line.match(/LANGUAGE=["']([^"']+)["']/i);
  const nameM = line.match(/NAME=["']([^"']+)["']/i);
  const info = `${langM?.[1] || ""} ${nameM?.[1] || ""}`.replace(/İ/g, "i").replace(/I/g, "i").toLowerCase();
  return /(?:^|[^a-zçğıöşü])(?:tr|tur|turk|türk|turkish|türkçe|turkce|dublaj)(?:$|[^a-zçğıöşü])/i.test(info);
}

function isEnAudioMediaLine(line) {
  const langM = line.match(/LANGUAGE=["']([^"']+)["']/i);
  const nameM = line.match(/NAME=["']([^"']+)["']/i);
  const info = `${langM?.[1] || ""} ${nameM?.[1] || ""}`.replace(/İ/g, "i").replace(/I/g, "i").toLowerCase();
  return /(?:^|[^a-zçğıöşü])(?:en|eng|english|ingilizce)(?:$|[^a-zçğıöşü])/i.test(info);
}

export function applyMasterAudioPreference(lines, audParam = "") {
  const aud = String(audParam || "").trim().toLowerCase();
  const wantTr = aud === "tr" || aud === "tr-dub" || aud === "dub" || aud === "tur";
  const wantOrig = aud === "orig" || aud === "en" || aud === "eng" || aud === "original";
  const groups = new Map();
  lines.forEach((ln, idx) => {
    const t = String(ln || "").trim();
    if (!t.startsWith("#EXT-X-MEDIA") || !/TYPE=AUDIO/i.test(t)) return;
    const gm = t.match(/GROUP-ID=["']([^"']+)["']/i);
    const gid = gm?.[1] || "__default__";
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push({ idx, line: ln, isTr: isTrAudioMediaLine(t), isEn: isEnAudioMediaLine(t), isDefault: /\bDEFAULT=YES\b/i.test(t) });
  });
  if (!groups.size) return lines;
  const out = [...lines];
  for (const entries of groups.values()) {
    if (entries.length <= 1) continue;
    let targetEntry = null;
    if (wantTr) {
      targetEntry = entries.find((e) => e.isTr) || null;
    } else if (wantOrig) {
      targetEntry = entries.find((e) => !e.isTr && e.isEn) || entries.find((e) => !e.isTr) || null;
    } else if (!entries.some((e) => e.isDefault)) {
      // Upstream left every audio rendition DEFAULT=NO — set a deterministic default (prefer TR, else EN)
      targetEntry = entries.find((e) => e.isTr) || entries.find((e) => e.isEn) || entries[0];
    }
    if (!targetEntry) continue;
    for (const e of entries) {
      const isWinner = e.idx === targetEntry.idx;
      let nextLn = setHlsMediaAttr(e.line, "DEFAULT", isWinner ? "YES" : "NO");
      nextLn = setHlsMediaAttr(nextLn, "AUTOSELECT", isWinner ? "YES" : "NO");
      out[e.idx] = nextLn;
    }
  }
  return out;
}

export function adaptMasterM3u8Variants(rewrittenLines, { maxHeight = 0, lowStart = false, aud = "" } = {}) {
  const lines = Array.isArray(rewrittenLines) ? rewrittenLines : String(rewrittenLines || "").split(/\r?\n/);
  const prefix = [];
  const variants = [];
  const tail = [];
  let seenFirstVariant = false;

  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    const trimmed = String(ln || "").trim();
    if (trimmed.startsWith("#EXT-X-MEDIA") || trimmed.startsWith("#EXT-X-SESSION-KEY")) {
      prefix.push(ln);
      continue;
    }
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      seenFirstVariant = true;
      const block = [ln];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = String(lines[j] || "").trim();
        if (nxt.startsWith("#EXT-X-MEDIA") || nxt.startsWith("#EXT-X-SESSION-KEY")) {
          prefix.push(lines[j]);
          j += 1;
          continue;
        }
        block.push(lines[j]);
        if (nxt && !nxt.startsWith("#")) {
          break;
        }
        j += 1;
      }
      const resM = trimmed.match(/RESOLUTION=\d+x(\d+)/i);
      const bwM = trimmed.match(/BANDWIDTH=(\d+)/i);
      const height = resM ? Number(resM[1]) : 0;
      const bandwidth = bwM ? Number(bwM[1]) : 0;
      variants.push({ lines: block, height, bandwidth, order: variants.length });
      i = j;
      continue;
    }
    if (!seenFirstVariant) prefix.push(ln);
    else tail.push(ln);
  }

  const heights = [...new Set(variants.map((v) => v.height).filter((h) => h > 0))].sort((a, b) => a - b);

  const sortAsc = (arr) => [...arr].sort((a, b) => {
    const ha = a.height || Math.round(a.bandwidth / 4500);
    const hb = b.height || Math.round(b.bandwidth / 4500);
    return (ha - hb) || (a.bandwidth - b.bandwidth) || (a.order - b.order);
  });

  let selected = variants;
  if (variants.length > 1 && maxHeight > 0) {
    const maxBwFallback = maxHeight <= 360 ? 1_100_000 : maxHeight <= 480 ? 1_900_000 : maxHeight <= 720 ? 3_800_000 : 7_500_000;
    const filtered = variants.filter((v) => (v.height > 0 ? v.height <= maxHeight + 40 : (v.bandwidth > 0 && v.bandwidth <= maxBwFallback)));
    if (filtered.length > 0) {
      selected = filtered;
    } else {
      // Never empty the master playlist: fall back to the single lowest variant available.
      selected = [sortAsc(variants)[0]];
    }
  }

  if (lowStart && selected.length > 1) {
    // Put lowest variant FIRST so Apple AVPlayer (iOS Safari / IPA) starts instantly with zero stall
    // and naturally scales up to higher variants listed right below when bandwidth allows.
    selected = sortAsc(selected);
  }

  // Prune orphaned #EXT-X-MEDIA:TYPE=AUDIO groups when variant filtering removed all variants referencing them
  const usedAudioGroups = new Set();
  for (const v of selected) {
    const inf = String(v.lines?.[0] || "");
    const am = inf.match(/\bAUDIO=["']([^"']+)["']/i);
    if (am?.[1]) usedAudioGroups.add(am[1]);
  }
  const survivingAudioGroups = new Set();
  const filteredPrefix = prefix.filter((ln) => {
    const t = String(ln || "").trim();
    if (t.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/i.test(t)) {
      const gm = t.match(/GROUP-ID=["']([^"']+)["']/i);
      const gid = gm?.[1] || "";
      if (usedAudioGroups.size && gid && !usedAudioGroups.has(gid)) {
        return false;
      }
      if (gid) survivingAudioGroups.add(gid);
    }
    return true;
  });

  // Strip dangling AUDIO="<group>" attribute on variants if all renditions in that group were dropped
  const cleanedSelected = selected.map((v) => {
    if (!v.lines?.length) return v;
    let inf = String(v.lines[0] || "");
    const am = inf.match(/,?\s*AUDIO=["']([^"']+)["']/i);
    if (am && !survivingAudioGroups.has(am[1])) {
      inf = inf.replace(/,?\s*AUDIO=["'][^"']+["']/i, "");
      return { ...v, lines: [inf, ...v.lines.slice(1)] };
    }
    return v;
  });

  const styledPrefix = applyMasterAudioPreference(filteredPrefix, aud);
  const rebuilt = [
    ...styledPrefix,
    ...cleanedSelected.flatMap((v) => v.lines),
    ...tail,
  ];
  return { body: rebuilt.join("\n"), heights };
}

async function replaceAsyncUri(line, base, ref, env, isMediaPlaylist) {
  const m = line.match(/URI="([^"]+)"/);
  if (!m) return line;
  const isMediaTag = line.trim().startsWith("#EXT-X-MEDIA");
  let abs = "";
  try { abs = new URL(m[1], base).toString(); } catch { return isMediaTag ? null : line.replace(m[0], 'URI="#blocked"'); }
  if (!isPublicHttpUrl(abs)) return isMediaTag ? null : line.replace(m[0], 'URI="#blocked"');
  const isDirectSubFile = /\.(?:vtt|srt|ttml|dfxp)(\?|$)/i.test(abs);
  if (isMediaTag && /TYPE=SUBTITLES/i.test(line) && isDirectSubFile) {
    const subRew = `/api/rave/subtitle.vtt?url=${encodeURIComponent(abs)}${ref ? `&ref=${b64UrlEncode(ref)}` : ""}`;
    return line.replace(m[0], `URI="${subRew}"`);
  }
  const isKeyLine = line.includes("#EXT-X-KEY") || line.includes("#EXT-X-SESSION-KEY");
  const rew = (!isKeyLine && (isMediaPlaylist || /\.m3u8(\?|$)/i.test(abs)))
    ? `/api/rave/stream?sid=${b64UrlEncode(abs)}${ref ? `&ref=${b64UrlEncode(ref)}` : ""}&proxy_segs=1&ext=.m3u8`
    : await buildSignedProxyPath(abs, ref, isKeyLine ? ".key" : ".mp4", env);
  return line.replace(m[0], `URI="${rew}"`);
}

function resolveFallbackContentType(extHint, target) {
  const hint = `${String(extHint || "").toLowerCase()} ${String(target || "").toLowerCase()}`;
  if (hint.includes(".mp4")) return "video/mp4";
  if (hint.includes(".m4s")) return "video/iso.segment";
  if (hint.includes(".webm")) return "video/webm";
  if (hint.includes(".mp3")) return "audio/mpeg";
  if (hint.includes(".m4a") || hint.includes(".aac")) return "audio/mp4";
  if (hint.includes(".m3u8")) return "application/vnd.apple.mpegurl";
  if (hint.includes(".vtt")) return "text/vtt; charset=utf-8";
  if (hint.includes(".srt")) return "application/x-subrip; charset=utf-8";
  if (hint.includes(".key")) return "application/octet-stream";
  return "video/mp2t";
}

function detectCloakedMediaMime(buf, extHint = "", hasRange = false) {
  if (!buf || buf.length < 2) return "";
  const sampleLen = Math.min(buf.length, 64);
  let hasBin = false;
  let binCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i];
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b >= 0x7f) {
      hasBin = true;
      binCount++;
    }
  }
  if (buf[0] === 0x47 && ((buf.length >= 189 && buf[188] === 0x47) || hasBin)) return "video/mp2t";
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "video/mp2t";
  if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0 && hasBin) return "audio/aac";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  if (buf.length >= 8) {
    const box = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    if (box === "ftyp" || box === "moof" || box === "styp" || box === "sidx" || box === "mdat") {
      return String(extHint || "").toLowerCase() === ".m4s" ? "video/iso.segment" : "video/mp4";
    }
  }
  // Scan first 1024 bytes for prepended fake image/PNG header before MPEG-TS 0x47 sync bytes
  const scanMax = Math.min(buf.length - 189, 1024);
  for (let i = 1; i <= scanMax; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47) return "video/mp2t";
  }
  // Allow encrypted AES-128 HLS segments/keys or audio/mid-file Range MP4 chunks if clearly binary and NOT HTML/JS/SVG
  const lowExt = String(extHint || "").toLowerCase();
  const headTxt = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, Math.min(buf.length, 96))).trimStart();
  const isMarkupOrJs = /^(?:<!doctype|<html|<script|<svg|function\s|\(function|var\s|const\s|let\s|\{")/i.test(headTxt);
  if (lowExt === ".key" && buf.length >= 8 && buf.length <= 256 && !isMarkupOrJs) {
    return "application/octet-stream";
  }
  if ((lowExt === ".ts" || lowExt === ".m4s" || lowExt === ".mp4" || lowExt === ".aac" || lowExt === ".m4a" || lowExt === ".mp3") && (binCount >= 6 || (hasRange && hasBin)) && !isMarkupOrJs) {
    return resolveFallbackContentType(lowExt, "");
  }
  return "";
}

async function readNonEmptyHeadChunk(reader) {
  for (let i = 0; i < 4; i++) {
    const { done, value } = await reader.read();
    if (value && value.length > 0) return value;
    if (done) return null;
  }
  return null;
}

export async function handleEdgeStreamProxy(request, url, env) {
  if (request?.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  const target = (url.searchParams.get("url") || url.searchParams.get("u") || "").trim();
  if (!target) return new Response("Missing stream URL", { status: 400, headers: { "Cache-Control": "no-store" } });
  if (!isPublicHttpUrl(target)) {
    return new Response("Blocked target URL", { status: 403, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  const explicitRef = (url.searchParams.get("referer") || url.searchParams.get("ref") || "").trim();
  const ref = (explicitRef || inferStreamReferer(target)).trim();
  const sig = (url.searchParams.get("sig") || "").trim();
  const sigOk = (await verifyProxySig(target, explicitRef, sig, env))
    || (!explicitRef && ref ? await verifyProxySig(target, ref, sig, env) : false);
  if (!sigOk) {
    return new Response("Invalid or expired stream signature", { status: 403, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }

  const hdrs = new Headers({ "User-Agent": UA_CHROME, Accept: "*/*" });
  if (ref) {
    hdrs.set("Referer", ref);
    try { hdrs.set("Origin", new URL(ref).origin); } catch {}
  }
  const rangeHdr = request?.headers?.get("Range");
  if (rangeHdr) hdrs.set("Range", rangeHdr);
  try {
    const reqMethod = request?.method === "HEAD" ? "HEAD" : "GET";
    const { resp: up } = await fetchPublicWithRedirects(target, hdrs, 4, 20000, undefined, true, reqMethod);
    const upCt = (up.headers.get("Content-Type") || "").toLowerCase();
    let extHint = (url.searchParams.get("ext") || "").toLowerCase();
    if (!extHint) {
      try {
        const pm = new URL(target).pathname.match(/\.(ts|m4s|mp4|aac|m4a|mp3|key|vtt|srt|m3u8)$/i);
        if (pm) extHint = `.${pm[1].toLowerCase()}`;
      } catch {}
    }
    if (!up.ok && (upCt.includes("html") || upCt.includes("javascript") || upCt.includes("ecmascript") || upCt.includes("xml") || upCt.includes("text/plain"))) {
      up.body?.cancel?.();
      return new Response(`Upstream ${up.status}`, { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    if (upCt.includes("application/xhtml+xml") || upCt.includes("image/svg+xml")) {
      up.body?.cancel?.();
      return new Response("Disallowed upstream content type", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    let outBody = up.body;
    let cloakedMime = "";
    const needsCloakSniff =
      upCt.includes("text/html") ||
      upCt.includes("javascript") ||
      upCt.includes("ecmascript") ||
      upCt.includes("text/plain") ||
      upCt.includes("font/") ||
      (upCt.startsWith("image/") && (extHint === ".ts" || extHint === ".m4s" || extHint === ".mp4"));
    if (needsCloakSniff) {
      if (request?.method === "HEAD") {
        const isAllowedHeadExt = extHint === ".ts" || extHint === ".m4s" || extHint === ".mp4" || extHint === ".aac" || extHint === ".key";
        if (!isAllowedHeadExt) {
          up.body?.cancel?.();
          return new Response("Disallowed upstream content type", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
        }
        cloakedMime = resolveFallbackContentType(extHint, target);
      } else if (up.body) {
        const reader = up.body.getReader();
        const headChunk = await readNonEmptyHeadChunk(reader);
        cloakedMime = detectCloakedMediaMime(headChunk, extHint, Boolean(rangeHdr));
        const headAscii = headChunk
          ? new TextDecoder("utf-8", { fatal: false }).decode(headChunk.subarray(0, Math.min(headChunk.length, 64))).replace(/^\ufeff/, "").trimStart()
          : "";
        const isValidTextMedia = upCt.includes("text/plain") && /^(?:#extm3u|webvtt|\d+\r?\n\d{2}:\d{2})/i.test(headAscii);
        if (!cloakedMime && !isValidTextMedia) {
          try { await reader.cancel(); } catch {}
          return new Response("Disallowed upstream content type", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
        }
        if (isValidTextMedia && !cloakedMime) {
          cloakedMime = resolveFallbackContentType(extHint, target);
        }
        outBody = new ReadableStream({
          start(controller) {
            if (headChunk) controller.enqueue(headChunk);
          },
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) controller.close();
              else controller.enqueue(value);
            } catch (err) {
              try { await reader.cancel(); } catch {}
              controller.error(err);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      }
    }
    const outHdrs = new Headers();
    for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
      const v = up.headers.get(k);
      if (v) outHdrs.set(k, v);
    }
    const rawOutCt = (outHdrs.get("Content-Type") || "").toLowerCase();
    if (cloakedMime) {
      outHdrs.set("Content-Type", cloakedMime);
    } else if (
      !outHdrs.has("Content-Type") ||
      rawOutCt.includes("octet-stream") ||
      rawOutCt.includes("font/") ||
      rawOutCt.includes("javascript") ||
      rawOutCt.includes("ecmascript")
    ) {
      outHdrs.set("Content-Type", resolveFallbackContentType(extHint, target));
    }
    outHdrs.set("Access-Control-Allow-Origin", "*");
    outHdrs.set("Access-Control-Allow-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    outHdrs.set("Vary", "Range");
    outHdrs.set("X-Content-Type-Options", "nosniff");
    outHdrs.set("Content-Security-Policy", "sandbox");
    outHdrs.set("Cache-Control", up.ok ? "public, max-age=300" : "no-store");
    if (reqMethod === "HEAD") {
      up.body?.cancel?.();
      return new Response(null, { status: up.status, headers: outHdrs });
    }
    return new Response(outBody, { status: up.status, headers: outHdrs });
  } catch (err) {
    const blocked = String(err?.message || "").includes("Blocked");
    return new Response(blocked ? "Blocked redirect URL" : "Stream proxy upstream timeout", {
      status: blocked ? 403 : 502,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
  }
}

function assTimeToVtt(t) {
  const m = String(t || "").trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3]}.${m[4]}0`;
}

const SUB_LANG_ALIASES = {
  tr: "tr", tur: "tr", turkish: "tr", turkce: "tr", "türkçe": "tr", "tr-tr": "tr",
  en: "en", eng: "en", english: "en", ingilizce: "en", "en-us": "en", "en-gb": "en",
  de: "de", deu: "de", ger: "de", german: "de", almanca: "de", deutsch: "de",
  fr: "fr", fra: "fr", fre: "fr", french: "fr", "fransızca": "fr", francais: "fr",
  es: "es", spa: "es", spanish: "es", ispanyolca: "es", espanol: "es", "español": "es",
  pt: "pt", por: "pt", pob: "pt", "pt-br": "pt", "pt-pt": "pt", portuguese: "pt", portekizce: "pt",
  it: "it", ita: "it", italian: "it", italyanca: "it", italiano: "it",
  ru: "ru", rus: "ru", russian: "ru", "rusça": "ru", rusca: "ru",
  ar: "ar", ara: "ar", arabic: "ar", "arapça": "ar", arapca: "ar",
  nl: "nl", nld: "nl", dut: "nl", dutch: "nl", "felemenkçe": "nl", nederlands: "nl",
  pl: "pl", pol: "pl", polish: "pl", "lehçe": "pl",
  ja: "ja", jpn: "ja", japanese: "ja", japonca: "ja",
  ko: "ko", kor: "ko", korean: "ko", korece: "ko",
  zh: "zh", zho: "zh", chi: "zh", zht: "zh", zhe: "zh", chinese: "zh", "çince": "zh",
  az: "az", aze: "az", azerbaijani: "az", azerice: "az",
  sv: "sv", swe: "sv", swedish: "sv",
  no: "no", nor: "no", nob: "no", norwegian: "no",
  da: "da", dan: "da", danish: "da",
  fi: "fi", fin: "fi", finnish: "fi",
  el: "el", ell: "el", gre: "el", greek: "el",
  cs: "cs", cze: "cs", ces: "cs", czech: "cs",
  ro: "ro", ron: "ro", rum: "ro", romanian: "ro",
  hu: "hu", hun: "hu", hungarian: "hu",
  bg: "bg", bul: "bg", bulgarian: "bg",
  hr: "hr", hrv: "hr", croatian: "hr",
  sr: "sr", srp: "sr", scc: "sr", serbian: "sr",
  uk: "uk", ukr: "uk", ukrainian: "uk",
  fa: "fa", per: "fa", fas: "fa", persian: "fa",
  hi: "hi", hin: "hi", hindi: "hi",
  he: "he", heb: "he", hebrew: "he",
  id: "id", ind: "id", indonesian: "id",
  vi: "vi", vie: "vi", vietnamese: "vi",
};

const SUB_LANG_DISPLAY = {
  tr: "🇹🇷 Türkçe",
  en: "🇬🇧 İngilizce",
  de: "🇩🇪 Almanca",
  fr: "🇫🇷 Fransızca",
  es: "🇪🇸 İspanyolca",
  pt: "🇵🇹 Portekizce",
  it: "🇮🇹 İtalyanca",
  ru: "🇷🇺 Rusça",
  ar: "🇸🇦 Arapça",
  nl: "🇳🇱 Felemenkçe",
  pl: "🇵🇱 Lehçe",
  ja: "🇯🇵 Japonca",
  ko: "🇰🇷 Korece",
  zh: "🇨🇳 Çince",
  az: "🇦🇿 Azerice",
  sv: "🇸🇪 İsveççe",
  no: "🇳🇴 Norveççe",
  da: "🇩🇰 Danca",
  fi: "🇫🇮 Fince",
  el: "🇬🇷 Yunanca",
  cs: "🇨🇿 Çekçe",
  ro: "🇷🇴 Rumence",
  hu: "🇭🇺 Macarca",
  bg: "🇧🇬 Bulgarca",
  hr: "🇭🇷 Hırvatça",
  sr: "🇷🇸 Sırpça",
  uk: "🇺🇦 Ukraynaca",
  fa: "🇮🇷 Farsça",
  hi: "🇮🇳 Hintçe",
  he: "🇮🇱 İbranice",
  id: "🇮🇩 Endonezce",
  vi: "🇻🇳 Vietnamca",
};

export function normalizeSubLang(rawLang, rawLabel = "", rawUrl = "") {
  const cleanToken = (v) => String(v || "").replace(/İ/g, "i").replace(/I/g, "i").trim().toLowerCase();
  const l = cleanToken(rawLang);
  const lbl = cleanToken(rawLabel);
  const u = cleanToken(rawUrl);

  // Explicit Turkish filename/label override (catches mislabeled OpenSubtitles/player uploads)
  if (/(?:^|[._\s\-[/(])(?:türkçe|turkce|turkish)(?:$|[._\s\-\])])/i.test(lbl) || /(?:sub_turkish|sub_tur|\/tr\.vtt|\/turkish\.vtt|\.tur\.vtt)/i.test(u)) {
    return "tr";
  }
  if (SUB_LANG_ALIASES[l]) return SUB_LANG_ALIASES[l];
  const baseL = l.split(/[-_\s]/)[0];
  if (SUB_LANG_ALIASES[baseL]) return SUB_LANG_ALIASES[baseL];
  if (lbl) {
    if (/(?:türk|turk)/i.test(lbl)) return "tr";
    if (/(?:ingiliz|english|\beng\b)/i.test(lbl)) return "en";
    for (const [k, v] of Object.entries(SUB_LANG_ALIASES)) {
      if (k.length >= 4 && lbl.includes(k)) return v;
    }
  }
  if (/(?:sub_english|sub_eng|\/en\.vtt|\/english\.vtt|\.eng\.vtt)/i.test(u)) return "en";
  return baseL ? baseL.slice(0, 6) : "tr";
}

export function formatSubLabel(lang, suffix = "") {
  const code = normalizeSubLang(lang);
  const base = SUB_LANG_DISPLAY[code] || `🌐 ${code.toUpperCase()}`;
  return suffix ? `${base} (${suffix})` : base;
}

const _SUB_TR_WORDS = new Set([
  "bir", "bu", "ve", "de", "da", "ne", "ben", "sen", "biz", "ama", "için", "değil", "var", "yok",
  "evet", "hayır", "gibi", "daha", "çok", "neden", "burada", "şimdi", "tamam", "şey", "beni",
  "seni", "onu", "bana", "sana", "olan", "olarak", "nasıl", "kadar", "sonra", "önce", "bunu",
  "onun", "benim", "senin", "bizim", "lütfen", "hadi", "sadece", "her", "hiç", "bile", "öyle",
]);
const _SUB_EN_WORDS = new Set([
  "the", "and", "you", "that", "this", "with", "what", "have", "they", "from", "are", "was",
  "for", "not", "but", "your", "just", "know", "here", "there", "she", "him", "her", "about",
  "don", "can", "will", "all", "one", "out", "get", "who", "how", "why", "now", "come", "back",
  "been", "were", "would", "could", "should", "their", "them", "into", "then", "when", "where",
]);

export function detectSubtitleTextLang(vttOrSrt) {
  let body = String(vttOrSrt || "").replace(/^WEBVTT[^\n]*\n/i, "");
  body = body.replace(/(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}[^\n]*/g, " ");
  body = body.replace(/<[^>]+>/g, " ").replace(/\{\\[^}]*\}/g, " ").slice(0, 7000);
  const words = body.toLowerCase().match(/[a-zçğıöşü]+/gi) || [];
  if (words.length < 18) return "";
  let trW = 0;
  let enW = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase();
    if (_SUB_TR_WORDS.has(w)) trW += 1;
    if (_SUB_EN_WORDS.has(w)) enW += 1;
  }
  const trChars = (body.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length;
  const nonTrExtChars = (body.match(/[ñáéíóúãõäëïßàèìòùčřžšěůłńśźżåæø]/gi) || []).length;
  const cyrOrAra = (body.match(/[\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  if (cyrOrAra > 20 || nonTrExtChars > trChars * 1.5 + 12) return "";
  if (trW >= 8 && trChars >= 10 && trW >= enW * 2) return "tr";
  if (enW >= 14 && trChars <= 3 && enW >= trW * 2.5) return "en";
  return "";
}

export function isCorruptOrForeignSubtitleText(vttOrSrt) {
  let body = String(vttOrSrt || "").replace(/^WEBVTT[^\n]*\n/i, "");
  body = body.replace(/(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}[^\n]*/g, " ");
  body = body.replace(/<[^>]+>/g, " ").replace(/\{\\[^}]*\}/g, " ").slice(0, 7000);
  const nonLatin = (body.match(/[\u0370-\u03FF\u0400-\u05FF\u0600-\u06FF\u0900-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  if (nonLatin > 20) return true;
  // Detect UTF-8 multi-byte Tamil/Indic/Arabic/Cyrillic double-decoded as Latin-1 (e.g. "à®¨à¯€à®™à¯")
  const mojiPairs = (body.match(/(?:à[®¯¤¥¦§¨©ª«¬­]|Ã[\x80-\xBF]|Ð[\x80-\xBF]|Ñ[\x80-\xBF]|Ø[\x80-\xBF]|Ù[\x80-\xBF])/g) || []).length;
  if (mojiPairs >= 14) return true;
  // Detect legacy font-encoded Indic/TSCII/mojibake garbage in Latin-1 high bytes (e.g. Joker Tamil "¾¢È¿ÎÉÁ")
  const corruptSym = (body.match(/[¡¢£¤¥¦§¨©ª«¬®¯±²³´µ¶·¸¹º»¼½¾¿×÷ÐÞðþ\uFFFD]/g) || []).length;
  if (corruptSym >= 6) return true;
  const nonTrHigh = (body.match(/[¡-ÿ\uFFFD]/g) || []).filter((ch) => !/[çğıöşüÇĞİÖŞÜ]/.test(ch)).length;
  const textChars = body.replace(/[\s\d.,!?'"():;\/\\\-–—\[\]]+/g, "").length;
  if (nonTrHigh >= 10 && textChars > 0 && (nonTrHigh / textChars) > 0.25) return true;
  return false;
}

export function decodeSubtitleBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(u8);
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(u8);
  }
  const utf8Str = new TextDecoder("utf-8", { fatal: false }).decode(u8);
  const replCount = (utf8Str.match(/\uFFFD/g) || []).length;
  if (replCount === 0) return utf8Str;
  // Valid UTF-8 Turkish files occasionally have 1-2 stray corrupt bytes; don't turn the whole file into Win-1254 mojibake!
  let winStr = "";
  try {
    winStr = new TextDecoder("windows-1254", { fatal: false }).decode(u8);
  } catch {
    const trMap = { 0xd0: "\u011e", 0xdd: "\u0130", 0xde: "\u015e", 0xf0: "\u011f", 0xfd: "\u0131", 0xfe: "\u015f" };
    for (let i = 0; i < u8.length; i++) winStr += trMap[u8[i]] || String.fromCharCode(u8[i]);
  }
  const utf8TrChars = (utf8Str.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length;
  const winMojibake = (winStr.match(/Ä±|Ä°|ÄŸ|Äž|Ã§|Ã‡|Ã¶|Ã–|Ã¼|Ãœ|ÅŸ|Åž/g) || []).length;
  if (utf8TrChars >= 6 && winMojibake >= Math.max(4, replCount * 2)) {
    return utf8Str.replace(/\uFFFD/g, "");
  }
  return winStr;
}

const STREAM_SOURCE_NAMES = {
  dl_embed: "Dizilife",
  sinemacc: "SinemaCC",
  fhd_embed: "FullHD",
  hfnl_embed: "HDFC",
  diziyou_net: "DiziyouNet",
  diziyou_love: "Diziyou",
  dylove: "Diziyou",
  filmmodu: "FilmModu",
  ddizimag: "DiziMag",
  hls_filemoon: "FileMoon",
};

export function formatStreamSubTracks(rawList, primarySource = "") {
  const seen = new Set();
  const norm = [];
  for (const t of (Array.isArray(rawList) ? rawList : [])) {
    const rawU = String(t?.url || "").trim();
    if (!rawU || !isPublicHttpUrl(rawU) || seen.has(rawU)) continue;
    // Strip known dead legacy vault subtitle CDN shards (verified HTTP 502)
    if (/(?:^https?:\/\/)?subs\.rapidvid\.[a-z]+\//i.test(rawU)) continue;
    seen.add(rawU);
    const lang = normalizeSubLang(t.lang, t.label, rawU);
    const src = String(t.source || "stream").trim();
    norm.push({
      lang,
      source: src,
      referer: String(t.referer || "").trim(),
      rawUrl: rawU,
    });
  }
  const rankLang = (l) => (l === "tr" ? 0 : (l === "en" ? 1 : 2));
  const primSrc = String(primarySource || "").trim();
  norm.sort((a, b) => {
    const lDiff = rankLang(a.lang) - rankLang(b.lang);
    if (lDiff !== 0) return lDiff;
    if (primSrc) {
      const pa = a.source === primSrc ? 0 : 1;
      const pb = b.source === primSrc ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    return 0;
  });
  const countsByLang = {};
  for (const item of norm) countsByLang[item.lang] = (countsByLang[item.lang] || 0) + 1;
  const idxByLang = {};
  return norm.map((item) => {
    idxByLang[item.lang] = (idxByLang[item.lang] || 0) + 1;
    const n = idxByLang[item.lang];
    const total = countsByLang[item.lang];
    const srcNice = STREAM_SOURCE_NAMES[item.source] || "";
    const suffix = total > 1 ? (srcNice ? `${srcNice} · ${n}` : `Kaynak ${n}`) : srcNice;
    return {
      id: n === 1 ? `stream-${item.lang}` : `stream-${item.lang}-${n}`,
      lang: item.lang,
      label: formatSubLabel(item.lang, suffix),
      url: `/api/rave/subtitle.vtt?url=${encodeURIComponent(item.rawUrl)}${item.referer ? `&ref=${b64UrlEncode(item.referer)}` : ""}`,
      source: item.source || "stream",
      synced: true,
    };
  });
}

function normalizeSubtitleToVtt(raw) {
  let txt = String(raw || "").replace(/\uFEFF/g, "").trimStart();
  if (!txt) return "WEBVTT\n\n";
  if (/^(?:<!doctype|<html|<script|<svg|<\?xml)/i.test(txt)) return "";
  if (txt.startsWith("WEBVTT")) {
    // Reject stub/error documents with WEBVTT header or no timestamps
    if (!/-->/.test(txt) && txt.length > 20) return "";
    return txt;
  }
  if (/^\[Script Info\]/im.test(txt) || /^Dialogue:/im.test(txt)) {
    const cues = [];
    for (const line of txt.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.slice(9).split(",");
      if (parts.length < 10) continue;
      const start = assTimeToVtt(parts[1]);
      const end = assTimeToVtt(parts[2]);
      const rawBody = parts.slice(9).join(",");
      if (/\{\\[^}]*\\p[1-9]\b/i.test(rawBody)) continue;
      const body = rawBody.replace(/\{\\[^}]*\}/g, "").replace(/\\N/gi, "\n").replace(/\\n/gi, "\n").replace(/\\h/gi, " ").trim();
      if (start && end && body) cues.push(`${start} --> ${end}\n${body}`);
    }
    return cues.length ? ("WEBVTT\n\n" + cues.join("\n\n")) : "";
  }
  const converted = txt.replace(/(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})/g, (_, h, m, s, ms) => {
    return `${h.padStart(2, "0")}:${m}:${s}.${ms.padEnd(3, "0")}`;
  });
  // Reject non-subtitle error strings like "Invalid or unsafe link" or JSON error bodies
  if (!/(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}/.test(converted)) {
    return "";
  }
  return "WEBVTT\n\n" + converted;
}

export async function handleEdgeSubtitle(url, env) {
  const target = (url.searchParams.get("url") || "").trim();
  if (!target) {
    return new Response("WEBVTT\n\n", {
      status: 200,
      headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (!isPublicHttpUrl(target)) {
    return new Response("Invalid subtitle URL", {
      status: 403,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
    });
  }
  let ref = "";
  const rawSubRef = (url.searchParams.get("ref") || "").trim();
  if (rawSubRef) {
    try {
      const decSubRef = rawSubRef.startsWith("https://") ? rawSubRef : b64UrlDecode(rawSubRef).trim();
      if (decSubRef.startsWith("https://") && isPublicHttpUrl(decSubRef)) ref = decSubRef;
    } catch {}
  }
  if (!ref) ref = inferStreamReferer(target);
  const subUa = /opensubtitles\.org/i.test(target) ? "TemporaryUserAgent" : UA_CHROME;
  const hdrs = { "User-Agent": subUa, Accept: "text/vtt,text/plain,*/*" };
  if (ref) hdrs.Referer = ref;
  try {
    let { resp: r } = await fetchPublicWithRedirects(target, hdrs, 4, 10000);
    if (!r.ok && ref) {
      r.body?.cancel?.();
      ({ resp: r } = await fetchPublicWithRedirects(target, { "User-Agent": subUa, Accept: "*/*" }, 4, 8000));
    }
    if (!r.ok) {
      r.body?.cancel?.();
      return new Response("Upstream subtitle error", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    let buf = await r.arrayBuffer();
    const u8Head = new Uint8Array(buf);
    if (u8Head.length >= 2 && u8Head[0] === 0x1f && u8Head[1] === 0x8b && typeof DecompressionStream !== "undefined") {
      try {
        buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      } catch {}
    }
    const raw = decodeSubtitleBytes(buf);
    const vtt = normalizeSubtitleToVtt(raw);
    if (!vtt) {
      return new Response("Invalid subtitle document", { status: 502, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    const detectedLang = detectSubtitleTextLang(vtt);
    const respHdrs = {
      "Content-Type": "text/vtt; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Watchlivo-Sub-Lang",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    };
    if (detectedLang) respHdrs["X-Watchlivo-Sub-Lang"] = detectedLang;
    return new Response(vtt, { status: 200, headers: respHdrs });
  } catch (err) {
    const blocked = String(err?.message || "").includes("Blocked");
    return new Response(blocked ? "Blocked subtitle URL" : "Subtitle fetch timeout", {
      status: blocked ? 403 : 502,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
  }
}

const ALLOWED_POSTER_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/avif"]);
function isSafeRasterImageType(ct) {
  const clean = String(ct || "").split(";")[0].trim().toLowerCase();
  return ALLOWED_POSTER_TYPES.has(clean);
}

export async function handleEdgePoster(url, env) {
  const target = (url.searchParams.get("u") || url.searchParams.get("url") || "").trim();
  if (target && isPublicHttpUrl(target)) {
    try {
      const ref = inferStreamReferer(target);
      const hdrs = { "User-Agent": UA_CHROME, Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" };
      if (ref) hdrs.Referer = ref;
      const { resp: r } = await fetchPublicWithRedirects(target, hdrs, 4, 6000, { cacheTtl: 86400, cacheEverything: true });
      const ct = r.headers.get("Content-Type") || "";
      if (r.ok && isSafeRasterImageType(ct)) {
        return new Response(r.body, {
          status: r.status,
          headers: {
            "Content-Type": ct.split(";")[0].trim(),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
          },
        });
      }
      r.body?.cancel?.();
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
      const ict = imgResp.headers.get("Content-Type") || "";
      if (imgResp.ok && isSafeRasterImageType(ict)) {
        return new Response(imgResp.body, {
          status: 200,
          headers: {
            "Content-Type": ict.split(";")[0].trim(),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
          },
        });
      }
      imgResp.body?.cancel?.();
    }
  } catch {}

  if (env?.ASSETS) {
    const fallback = await env.ASSETS.fetch(new Request("https://assets.local/static/watchlivo-poster.svg"));
    if (fallback.ok) {
      return new Response(fallback.body, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
        },
      });
    }
  }
  return new Response("Poster unavailable", { status: 404, headers: { "Cache-Control": "no-store" } });
}
