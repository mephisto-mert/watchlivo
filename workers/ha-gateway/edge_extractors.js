/**
 * Edge Direct Turkish & Embed Stream Extractors + Ad/Betting Blocklist (Cloudflare Workers Safe, Zero eval())
 * Replaces popup-ad iframe fallbacks (vidlink.pro -> 1xbet redirects) with direct ad-free HLS/MP4 resolution.
 */

const UA_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCKED_AD_BETTING_RE =
  /(?:^|\.)(?:1xbet|onebahis|melbet|mostbet|pinup|betwinner|casibom|grandpashabet|stake|meritking|jojobet|betway|bets10|mobilbahis|bahis|casino|popads|adsterra|propellerads|exoclick|juicyads|hilltopads|trafficjunky|onclickalgo|doubleclick|acscdn|vidlink|vidsrc|2embed|multiembed|autoembed|smashystream|flixer|vidfast|vidora|rivestream|pstream|cinejoy|vidbinge|superembed|streamtape|uqload|sendvid|dood|filemoon)\b|(?:^|\.)(?:embed\.su|vidy\.st|nexa\.mov|moviesapi\.club|nontongo\.win|voe\.sx)$/i;

const AD_SEGMENT_OR_URL_RE =
  /(?:preroll|midroll|\/ads?\/|reklam|promo|sponsor|bumper|1xbet|onebahis|melbet|mostbet|pinup|betwinner|casibom|grandpashabet|meritking|jojobet|betway)/i;

export function isBlockedAdHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (BLOCKED_AD_BETTING_RE.test(h)) return true;
  return /(?:1xbet|onebahis|melbet|mostbet|casibom|grandpashabet|meritking|jojobet|vidlink\.pro)/.test(h);
}

export function isAdSegmentOrPlaylistUrl(rawUrl) {
  return AD_SEGMENT_OR_URL_RE.test(String(rawUrl || ""));
}

export function isDirectEmbedPageUrl(rawUrl) {
  const s = String(rawUrl || "").trim().toLowerCase();
  if (!s.startsWith("http")) return false;
  if (/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+.*(?:\/embed-|\/w\/)/i.test(s)) return true;
  if (s.includes("hdfilmcehennemi.mobi/video/embed/")) return true;
  if (/hdfilmcehennemi\.[a-z]+\/rplayer\//i.test(s)) return true;
  if (/rapidvid\.[a-z]+\/(?:vx|e)\//i.test(s)) return true;
  if (/(?:filemoon|byse)\.[a-z0-9-]+\/(?:e|d)\/[a-z0-9_-]+/i.test(s)) return true;
  return false;
}

export function filterM3u8AdDiscontinuities(playlistText) {
  const text = String(playlistText || "");
  if (!text.includes("#EXTM3U") || !text.includes("#EXT-X-DISCONTINUITY")) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  let inAdBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("#EXT-X-DISCONTINUITY")) {
      // Peek ahead up to next discontinuity to see if any URI inside this segment slice matches known ad/betting markers.
      let sliceHasAd = false;
      for (let j = i + 1; j < lines.length; j++) {
        const probe = lines[j];
        if (probe.startsWith("#EXT-X-DISCONTINUITY") || probe.startsWith("#EXT-X-ENDLIST")) break;
        if (probe && !probe.startsWith("#") && AD_SEGMENT_OR_URL_RE.test(probe)) {
          sliceHasAd = true;
          break;
        }
      }
      if (sliceHasAd) {
        inAdBlock = true;
        continue;
      }
      if (inAdBlock) {
        inAdBlock = false;
        continue;
      }
    }
    if (!inAdBlock) out.push(ln);
  }
  return out.join("\n");
}

function encodeBaseA(n, radix) {
  let num = n;
  const alpha = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (radix <= 36) {
    let s = "";
    do {
      s = alpha[num % radix] + s;
      num = Math.floor(num / radix);
    } while (num > 0);
    return s;
  }
  let s = "";
  do {
    const rem = num % radix;
    num = Math.floor(num / radix);
    s = (rem > 35 ? String.fromCharCode(rem + 29) : alpha[rem]) + s;
  } while (num > 0);
  return s;
}

export function unpackDeanEdwards(src) {
  const text = String(src || "");
  const m = text.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:\\.|[^'])*)',(\d+),(\d+),'((?:\\.|[^'])*)'\.split\('\|'\)/
  );
  if (!m) return "";
  const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const a = parseInt(m[2], 10);
  const c = parseInt(m[3], 10);
  const k = m[4].split("|");
  if (!Number.isFinite(a) || !Number.isFinite(c) || c > 20000) return "";
  const dict = Object.create(null);
  for (let i = c - 1; i >= 0; i--) {
    const key = encodeBaseA(i, a);
    dict[key] = (i < k.length && k[i]) ? k[i] : key;
  }
  return p.replace(/\b\w+\b/g, (w) => (Object.prototype.hasOwnProperty.call(dict, w) ? dict[w] : w));
}

function decodeHdfcBlock(srcHtml, callMatch, appendMobiDomain = false) {
  try {
    const fnName = callMatch[2];
    const arr = callMatch[3]
      ? JSON.parse(callMatch[3])
      : callMatch[4].split(callMatch[5]);
    if (!Array.isArray(arr) || arr.length < 3) return "";
    let fnIdx = srcHtml.indexOf(`var ${fnName} = function`);
    if (fnIdx < 0) fnIdx = srcHtml.indexOf(`var ${fnName}=function`);
    if (fnIdx < 0) fnIdx = srcHtml.indexOf(`function ${fnName}`);
    if (fnIdx < 0 || fnIdx >= callMatch.index) return "";
    const fnBody = srcHtml.slice(fnIdx, callMatch.index);

    const mSp = fnBody.match(/%\s*(\d+)\s*,\s*[a-zA-Z0-9_]+\s*=\s*(\d+)\s*\+\s*\([a-zA-Z0-9_]+\s*%\s*(\d+)\)/);
    const mod1 = mSp ? parseInt(mSp[1], 10) : 7;
    const off2 = mSp ? parseInt(mSp[2], 10) : 8;
    const mod2 = mSp ? parseInt(mSp[3], 10) : 5;
    const cf4 = arr.length - 2;
    const idx1 = mod2 ? off2 + (cf4 % mod2) : off2;
    if (idx1 < 0 || idx1 >= arr.length) return "";
    const jve5 = arr.splice(idx1, 1)[0];
    const idx2 = mod1 ? (cf4 % mod1) : 0;
    if (idx2 < 0 || idx2 >= arr.length) return "";
    const rawSeed = arr.splice(idx2, 1)[0];
    const d46 = (appendMobiDomain || fnBody.includes("hdfilmcehennemi.mobi"))
      ? `${rawSeed}hdfilmcehennemi.mobi`
      : rawSeed;
    let z81u = arr.join("");

    const mH1 = fnBody.match(/\*\s*(\d+)\s*\+\s*[a-zA-Z0-9_]+\)\s*%\s*(\d+)/);
    const hMul = mH1 ? parseInt(mH1[1], 10) : 37;
    const hMod = mH1 ? parseInt(mH1[2], 10) : 241;
    const isShiftAdd = fnBody.split("charAt")[0].includes("<<");
    let p8l = 0;
    let s51k1 = 0;
    for (let i = 0; i < d46.length; i++) {
      const c = d46.charCodeAt(i);
      p8l = (p8l * hMul + c) % hMod;
      s51k1 = isShiftAdd ? ((s51k1 + ((c << 1) ^ i)) & 255) : ((s51k1 ^ (c + i)) & 255);
    }

    const mK = fnBody.match(
      /=\s*\([a-zA-Z0-9_]+(?:\s*\*\s*(\d+))?\s*\+\s*[a-zA-Z0-9_]+\)\s*%\s*256\s*,\s*[a-zA-Z0-9_]+\s*=\s*\(([a-zA-Z0-9_]+)\s*%\s*(\d+)\)\s*\+\s*(\d+)\s*,\s*[a-zA-Z0-9_]+\s*=\s*\(\(([a-zA-Z0-9_]+)\s*\*\s*(\d+)\s*\+\s*[a-zA-Z0-9_]+\)\s*%\s*(\d+)\)\s*\+\s*1/
    );
    const kMul = mK && mK[1] ? parseInt(mK[1], 10) : 3;
    const vMod = mK ? parseInt(mK[3], 10) : 11;
    const vAdd = mK ? parseInt(mK[4], 10) : 5;
    const sMul = mK ? parseInt(mK[6], 10) : 251;
    const sMod = mK ? parseInt(mK[7], 10) : 65519;

    const mHvars = fnBody.match(/var\s+([a-zA-Z0-9_]+)\s*=\s*0\s*,\s*([a-zA-Z0-9_]+)\s*=\s*0/);
    const p8lName = mHvars ? mHvars[1] : "";
    const vVarVal = mK && mK[2] === p8lName ? p8l : s51k1;
    const sVar1Val = mK && mK[5] === p8lName ? p8l : s51k1;
    const sVar2Val = sVar1Val === p8l ? s51k1 : p8l;

    const g84k = (p8l * kMul + s51k1) % 256;
    const v9nc = (vVarVal % vMod) + vAdd;
    let sv3 = ((sVar1Val * sMul + sVar2Val) % sMod) + 1;

    const mChars = fnBody.match(
      /===\s*'([^']+)'\)\s*\{\s*[a-zA-Z0-9_]+\s*=\s*atob[\s\S]*?===\s*'([^']+)'\)\s*\{\s*[a-zA-Z0-9_]+\s*=\s*[a-zA-Z0-9_]+\.split\(''\)\.reverse[\s\S]*?charCodeAt\(0\)\s*-\s*(\d+)\)/
    );
    const chB64 = mChars ? mChars[1] : "7";
    const chRev = mChars ? mChars[2] : "3";
    const caesarSub = mChars ? parseInt(mChars[3], 10) : 96;

    for (let idx = jve5.length - 1; idx >= 0; idx--) {
      const op = jve5[idx];
      if (op === chB64) {
        z81u = atob(z81u);
      } else if (op === chRev) {
        z81u = z81u.split("").reverse().join("");
      } else {
        const shift = (26 - ((op.charCodeAt(0) - caesarSub) % 26)) % 26;
        z81u = z81u.replace(/[a-zA-Z]/g, (ch) => {
          const code = ch.charCodeAt(0);
          const base = code <= 90 ? 65 : 97;
          return String.fromCharCode(((code - base + shift) % 26) + base);
        });
      }
    }

    const mPrng = fnBody.match(/=\s*\([a-zA-Z0-9_]+\s*\*\s*(\d+)\s*\+\s*(\d+)\)\s*%\s*(\d+)\s*;/);
    const pMul = mPrng ? parseInt(mPrng[1], 10) : 97;
    const pAdd = mPrng ? parseInt(mPrng[2], 10) : 41;
    const pMod = mPrng ? parseInt(mPrng[3], 10) : 65519;

    const nLen = z81u.length;
    const swaps = new Int32Array(nLen);
    for (let i = nLen - 1; i >= 1; i--) {
      sv3 = (sv3 * pMul + pAdd) % pMod;
      swaps[i] = sv3 % (i + 1);
    }
    const arrChars = z81u.split("");
    for (let i = 1; i < nLen; i++) {
      const j = swaps[i];
      const tmp = arrChars[i];
      arrChars[i] = arrChars[j];
      arrChars[j] = tmp;
    }
    z81u = arrChars.join("");

    const afterJoin = fnBody.split("join('')").pop() || "";
    const mXmul = afterJoin.match(/\*\s*(\d+)\s*\+/);
    const xMul = mXmul ? parseInt(mXmul[1], 10) : 1;

    let q6h = g84k;
    const resBytes = new Uint8Array(z81u.length);
    for (let i = 0; i < z81u.length; i++) {
      const c = z81u.charCodeAt(i);
      q6h = (q6h * xMul + v9nc) % 256;
      resBytes[i] = (c ^ q6h) & 255;
      q6h = (q6h + c) % 256;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(resBytes).trim();
    if (decoded.startsWith("https://")) {
      const uObj = new URL(decoded);
      if (!isBlockedAdHost(uObj.hostname)) return decoded;
    }
  } catch {}
  return "";
}

export function decodeHdfcEmbedHtml(rawHtml) {
  const candidates = [];
  const unpacked = unpackDeanEdwards(rawHtml);
  if (unpacked) candidates.push(unpacked);
  if (rawHtml) candidates.push(String(rawHtml));

  for (const srcHtml of candidates) {
    const calls = [
      ...srcHtml.matchAll(
        /var\s+([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\((?:(\[[^\]]+\])|"([^"]+)"\.split\("([^"]+)"\))\);/g
      ),
    ];
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      const decoded = decodeHdfcBlock(srcHtml, call, srcHtml.includes("hdfilmcehennemi.mobi"));
      if (decoded) return decoded;
    }
    const directM3u8 = srcHtml.match(/https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*/i);
    if (directM3u8) {
      try {
        const uObj = new URL(directM3u8[0]);
        if (!isBlockedAdHost(uObj.hostname)) return directM3u8[0];
      } catch {}
    }
  }
  return "";
}

function parseEmbedVttTracks(rhtml, sourceTag = "fhd_embed") {
  const subs = [];
  const seen = new Set();
  const cleanH = String(rhtml || "").replace(/\\\//g, "/");
  for (const m of cleanH.matchAll(/\{[^{}]*"file"\s*:\s*"(https?:\/\/[^"]+\.vtt[^"]*)"[^{}]*\}/gi)) {
    const blk = m[0];
    const u = m[1].trim();
    if (!u || seen.has(u) || /forced/i.test(u)) continue;
    const lm = blk.match(/"label"\s*:\s*"([^"]+)"/i);
    const lbl = (lm ? lm[1] : "").replace(/İ/g, "i").replace(/I/g, "i").toLowerCase();
    if (lbl.includes("forced")) continue;
    let lang = "";
    if (lbl.includes("turk") || lbl.includes("türk") || /\.tur\./i.test(u) || /\/1\.vtt/i.test(u)) lang = "tr";
    else if (lbl.includes("ing") || lbl.includes("eng") || /\.eng\./i.test(u) || /\/2\.vtt/i.test(u)) lang = "en";
    else if (lbl.length >= 2) lang = lbl.slice(0, 2);
    if (lang) {
      seen.add(u);
      subs.push({ url: u, lang, source: sourceTag });
    }
  }
  return subs;
}

function decodeRapidvidToken(enc) {
  const t = atob(String(enc || "").split("").reverse().join(""));
  const key = "K9L";
  let o = "";
  for (let i = 0; i < t.length; i++) {
    o += String.fromCharCode(t.charCodeAt(i) - ((key.charCodeAt(i % 3) % 5) + 1));
  }
  const raw = atob(o);
  const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
}

function parseRapidvidHtml(rhtml) {
  const subs = parseEmbedVttTracks(rhtml, "fhd_embed");
  const mP8 = String(rhtml || "").match(/window\._p8\s*=\s*'([^']+)'/);
  if (mP8) {
    try {
      const decObj = JSON.parse(decodeRapidvidToken(mP8[1]));
      const cmU = String(decObj?.cm || decObj?.tm || "").trim();
      for (const ct of decObj?.ct || []) {
        const su = String(ct?.file || "").trim();
        const sl = String(ct?.label || "").replace(/İ/g, "i").replace(/I/g, "i").toLowerCase();
        if (!su.startsWith("http") || sl.includes("forced")) continue;
        const lang = sl.includes("turk") || sl.includes("türk")
          ? "tr"
          : sl.includes("ing") || sl.includes("eng")
          ? "en"
          : sl.slice(0, 2);
        if (lang && !subs.some((x) => x.url === su)) subs.push({ url: su, lang, source: "fhd_embed" });
      }
      if (cmU.startsWith("http")) return { url: cmU, subs };
    } catch {}
  }
  const mFile = String(rhtml || "").match(/(?:["']?file["']?\s*:\s*)?av\(\s*['"]([^'"]+)['"]\s*\)/);
  if (mFile) {
    try {
      const decU = decodeRapidvidToken(mFile[1]);
      if (decU.startsWith("http")) return { url: decU, subs };
    } catch {}
  }
  return { url: "", subs };
}

async function fetchTextSafe(targetUrl, hdrs, fetchPublicFn, timeoutMs = 4500) {
  try {
    const { resp } = await fetchPublicFn(targetUrl, hdrs, 4, timeoutMs);
    if (!resp || !resp.ok) {
      resp?.body?.cancel?.();
      return "";
    }
    return await resp.text();
  } catch {
    return "";
  }
}

function b64UrlToBytes(str) {
  const norm = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? 0 : 4 - (norm.length % 4);
  const bin = atob(norm + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decrypt FileMoon/Byse AES-256-GCM playback payload using WebCrypto. */
export async function decryptFilemoonPlayback(pb) {
  if (!pb || typeof pb !== "object" || !pb.payload || !pb.iv) return null;
  const parts = Array.isArray(pb.key_parts) ? pb.key_parts : [];
  if (!parts.length) return null;
  const ver = String(pb.version || "").trim();
  const vNum = Number(ver);
  let selected = parts;
  if (Number.isInteger(vNum) && vNum >= 1 && vNum <= 20) {
    const a = vNum;
    const b = 31 - vNum;
    if (a >= 1 && b >= 1 && a <= parts.length && b <= parts.length && parts[a - 1] && parts[b - 1]) {
      selected = [parts[a - 1], parts[b - 1]];
    }
  }
  const keyChunks = selected.filter((p) => typeof p === "string" && p.length > 0).map(b64UrlToBytes);
  const totalLen = keyChunks.reduce((acc, c) => acc + c.length, 0);
  const rawKey = new Uint8Array(totalLen);
  let off = 0;
  for (const c of keyChunks) {
    rawKey.set(c, off);
    off += c.length;
  }
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64UrlToBytes(pb.iv) },
    cryptoKey,
    b64UrlToBytes(pb.payload)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function extractFilemoonStream(embedUrl, u, _fetchPublicFn) {
  const mCode = u.pathname.match(/\/(?:e|d)\/([a-z0-9_-]+)/i);
  if (!mCode || u.protocol !== "https:") return null;
  if (!/^(?:[a-z0-9-]+\.)?(?:filemoon|byse)\.(?:sx|to|in|wf|nl|biz|org)$/i.test(u.hostname)) return null;
  const apiUrl = `${u.origin}/api/videos/${encodeURIComponent(mCode[1])}`;
  let rawJson = "";
  try {
    const resp = await fetch(apiUrl, {
      headers: { "User-Agent": UA_EDGE, Referer: `${u.origin}/e/${mCode[1]}`, Accept: "application/json, text/plain, */*" },
      redirect: "manual",
      signal: AbortSignal.timeout(5500),
    });
    if (resp.ok) rawJson = await resp.text();
    else resp.body?.cancel?.();
  } catch {
    return null;
  }
  if (!rawJson) return null;
  let data;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const decoded = await decryptFilemoonPlayback(data?.playback).catch(() => null);
  const sources = Array.isArray(decoded?.sources) ? decoded.sources : [];
  const hlsSrc = sources.find((s) => /mpegurl|\.m3u8/i.test(String(s?.mime_type || s?.url || ""))) || sources[0];
  if (!hlsSrc?.url) return null;
  try {
    if (isBlockedAdHost(new URL(hlsSrc.url).hostname)) return null;
  } catch {
    return null;
  }
  const subs = (Array.isArray(decoded?.tracks) ? decoded.tracks : Array.isArray(data?.tracks) ? data.tracks : [])
    .filter((t) => t?.url && (!t.kind || t.kind === "captions" || t.kind === "subtitles"))
    .map((t) => ({ lang: String(t.lang || t.language || "tr").slice(0, 2).toLowerCase(), url: t.url }));
  return { url: hlsSrc.url, referer: `${u.origin}/`, subs, tag: "hls_filemoon" };
}

export async function resolveEmbedHtmlToHls(embedUrl, fetchPublicFn) {
  const raw = String(embedUrl || "").trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (/(?:filemoon|byse)\.[a-z0-9-]+/i.test(u.hostname)) {
    return await extractFilemoonStream(raw, u, fetchPublicFn);
  }
  if (isBlockedAdHost(u.hostname)) return null;
  const low = raw.toLowerCase();

  // 1. Vidmoly (.biz / vmbox / vmnow / vmpx / vmget)
  if (/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+/i.test(u.hostname)) {
    const vmUrl = raw.replace(/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+/i, "vidmoly.biz");
    const refHdr = low.includes("webteizle") ? "https://webteizle.info/" : "https://www.dizibox.live/";
    const html = await fetchTextSafe(
      vmUrl,
      { "User-Agent": UA_EDGE, Referer: refHdr, "Accept-Language": "tr-TR,tr;q=0.9" },
      fetchPublicFn,
      4500
    );
    const m = html.match(/https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*/i);
    if (m) {
      try {
        if (!isBlockedAdHost(new URL(m[0]).hostname)) {
          return { url: m[0], referer: "https://vidmoly.biz/", subs: [], tag: "hls" };
        }
      } catch {}
    }
    return null;
  }

  // 2. HDFilmcehennemi rplayer / mobi
  if (low.includes("hdfilmcehennemi.mobi/video/embed/") || /hdfilmcehennemi\.[a-z]+\/rplayer\//i.test(low)) {
    const isMobi = low.includes("hdfilmcehennemi.mobi");
    const html = await fetchTextSafe(
      raw,
      { "User-Agent": UA_EDGE, Referer: "https://www.hdfilmcehennemi.nl/", "Accept-Language": "tr-TR,tr;q=0.9" },
      fetchPublicFn,
      4500
    );
    if (!html) return null;
    const dec = decodeHdfcEmbedHtml(html);
    if (dec) {
      return {
        url: dec,
        referer: isMobi ? "https://hdfilmcehennemi.mobi/" : "https://www.hdfilmcehennemi.nl/",
        subs: parseEmbedVttTracks(html, "hfnl_embed"),
        tag: "hls_hfnl_multi",
      };
    }
    return null;
  }

  // 3. Rapidvid
  if (/rapidvid\.[a-z]+/i.test(u.hostname)) {
    const html = await fetchTextSafe(
      raw,
      { "User-Agent": UA_EDGE, Referer: "https://www.fullhdfilmizlesene.now/", "Accept-Language": "tr-TR,tr;q=0.9" },
      fetchPublicFn,
      4500
    );
    if (!html) return null;
    const parsed = parseRapidvidHtml(html);
    if (parsed.url && !isBlockedAdHost(new URL(parsed.url).hostname)) {
      return { url: parsed.url, referer: "https://rapidvid.org/", subs: parsed.subs, tag: "hls_fhd_multi" };
    }
    return null;
  }

  return null;
}

function normTitleTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function rot13Decode(s) {
  return String(s || "").replace(/[a-zA-Z]/g, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}

async function extractFullhdMoviePage(pageUrl, fetchPublicFn) {
  const html = await fetchTextSafe(
    pageUrl,
    { "User-Agent": UA_EDGE, Referer: "https://www.fullhdfilmizlesene.now/", "Accept-Language": "tr-TR,tr;q=0.9" },
    fetchPublicFn,
    4500
  );
  if (!html) return null;
  const scxM = html.match(/scx\s*=\s*(\{[\s\S]*?\});/);
  if (!scxM) return null;
  let scx;
  try {
    scx = JSON.parse(scxM[1]);
  } catch {
    return null;
  }
  const vodCandidates = [];
  for (const val of Object.values(scx)) {
    const tList = val?.sx?.t;
    if (!Array.isArray(tList)) continue;
    for (const tok of tList) {
      if (typeof tok !== "string" || !tok) continue;
      try {
        let b64 = rot13Decode(tok);
        while (b64.length % 4 !== 0) b64 += "=";
        const u = new TextDecoder("utf-8", { fatal: false })
          .decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
          .trim();
        if (u.startsWith("http") && /rapidvid/i.test(u) && !vodCandidates.includes(u)) {
          vodCandidates.push(u);
        }
      } catch {}
    }
  }
  for (const vodU of vodCandidates.slice(0, 3)) {
    const out = await resolveEmbedHtmlToHls(vodU, fetchPublicFn);
    if (out?.url) return out;
  }
  return null;
}

async function extractHdfcPage(pageUrl, mtype, s, e, fetchPublicFn) {
  let targetUrl = String(pageUrl || "").trim();
  if (!targetUrl.startsWith("http")) return null;
  if (mtype === "tv" && /\/dizi\/[^/]+\/?$/i.test(targetUrl)) {
    targetUrl = `${targetUrl.replace(/\/+$/, "")}/sezon-${s}/bolum-${e}/`;
  }
  const baseHdrs = {
    "User-Agent": UA_EDGE,
    Referer: "https://www.hdfilmcehennemi.nl/",
    "Accept-Language": "tr-TR,tr;q=0.9",
  };
  const html = await fetchTextSafe(targetUrl, baseHdrs, fetchPublicFn, 4500);
  if (!html) return null;

  // 1. Collect AJAX buttons first, ordering Rapidrame before Close because Rapidrame rplayer is actively served.
  const btnMatches = [
    ...html.matchAll(/<button[^>]+class="[^"]*alternative-link[^"]*"[^>]+data-video="(\d+)"[^>]*>([\s\S]*?)<\/button>/gi),
  ];
  btnMatches.sort((a, b) => {
    const la = a[2].toLowerCase().includes("rapidrame") ? 0 : 1;
    const lb = b[2].toLowerCase().includes("rapidrame") ? 0 : 1;
    return la - lb;
  });

  const embedUrls = [];
  for (const bm of btnMatches.slice(0, 3)) {
    const vid = bm[1];
    try {
      const ajJson = await fetchTextSafe(
        `https://www.hdfilmcehennemi.nl/video/${vid}/`,
        {
          "User-Agent": UA_EDGE,
          Referer: targetUrl,
          Origin: "https://www.hdfilmcehennemi.nl",
          Accept: "*/*",
          "X-Requested-With": "fetch",
        },
        fetchPublicFn,
        4000
      );
      if (!ajJson) continue;
      const obj = JSON.parse(ajJson);
      const frag = String(obj?.data?.html || "").replace(/\\\//g, "/");
      const mSrc = frag.match(/(?:data-src|src)=["']([^"']+)["']/i);
      if (mSrc?.[1]?.startsWith("http") && !embedUrls.includes(mSrc[1])) embedUrls.push(mSrc[1]);
    } catch {}
  }

  // 2. Also collect inline iframe src/data-src in page HTML as backup.
  const cleanPage = html.replace(/\\\//g, "/");
  for (const mInl of cleanPage.matchAll(
    /https:\/\/(?:www\.hdfilmcehennemi\.nl\/rplayer\/|hdfilmcehennemi\.mobi\/video\/embed\/)[^\s"'<>]+/gi
  )) {
    if (!embedUrls.includes(mInl[0])) embedUrls.push(mInl[0]);
  }

  for (const eu of embedUrls) {
    const out = await resolveEmbedHtmlToHls(eu, fetchPublicFn);
    if (out?.url) return out;
  }
  return null;
}

const WT_ALLOWED_HOST_RE = /^webteizle\.[a-z]+$/i;

function slugifyAscii(s) {
  return String(s || "")
    .replace(/\(\d{4}\)/g, " ")
    .toLowerCase()
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractSequelTag(str) {
  const s = String(str || "").replace(/\(\d{4}\)/g, "").toLowerCase();
  const m = s.match(/(?:part\s*([2-9]|ii|iii|iv|v|vi)|bolum\s*([2-9])|\b([2-9]|ii|iii|iv|v|vi)\b)/i);
  if (!m) return "";
  const raw = (m[1] || m[2] || m[3] || "").toLowerCase();
  const rom = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6" };
  return rom[raw] || raw;
}

function scoreTitleCandidate(rtNoYear, candToks, candSeq, candYearM, reqYear) {
  const rToks = normTitleTokens(rtNoYear);
  if (!rToks.length) return -1;
  const hits = rToks.filter((t) => candToks.includes(t)).length;
  if (hits === 0) return -1;
  if (reqYear && candYearM) {
    const diff = Math.abs(Number(reqYear) - Number(candYearM[1]));
    if (diff > 2) return -1;
  }
  const rSeq = extractSequelTag(rtNoYear);
  if (candSeq && rSeq && candSeq !== rSeq) return -1;
  if (rToks.length >= 3 && hits < Math.ceil(rToks.length * 0.8)) return -1;
  if (rToks.length === 2 && hits < 2) return -1;
  if (rToks.length === 1 && candToks.length > 2) return -1;
  const missing = rToks.length - hits;
  const extra = Math.max(0, candToks.length - hits);
  let score = (hits / Math.max(rToks.length, candToks.length)) * 100 - missing * 35 - extra * 12;
  if ((candSeq && !rSeq) || (!candSeq && rSeq)) {
    score -= 30;
  }
  if (reqYear && candYearM) {
    const diff = Math.abs(Number(reqYear) - Number(candYearM[1]));
    score += diff === 0 ? 15 : 5;
  }
  return score;
}

function titlesMatchScore(candRaw, reqTitles, reqYear = "") {
  const candClean = String(candRaw || "").replace(/\s+\d+\.\s*Sezon.*$/i, "").trim();
  const candYearM = candClean.match(/\((\d{4})\)/);
  const candNoYear = candClean.replace(/\(\d{4}\)/g, "").trim();
  const candToks = normTitleTokens(candNoYear);
  if (!candToks.length) return -1;
  const candSeq = extractSequelTag(candNoYear);
  let best = -1;
  for (const rt of reqTitles) {
    const rtNoYear = String(rt || "").replace(/\(\d{4}\)/g, "").trim();
    const sc = scoreTitleCandidate(rtNoYear, candToks, candSeq, candYearM, reqYear);
    if (sc > best) best = sc;
    if (rtNoYear.includes(":")) {
      const pre = rtNoYear.split(":")[0].trim();
      const reqYrNum = /^\d{4}/.test(String(reqYear || "").trim()) ? Number(String(reqYear).trim().slice(0, 4)) : 0;
      const yearMismatch = Boolean(reqYrNum && (!candYearM || reqYrNum !== Number(candYearM[1])));
      if (!yearMismatch && normTitleTokens(pre).length >= 2 && extractSequelTag(rtNoYear) === candSeq) {
        const preSc = scoreTitleCandidate(pre, candToks, candSeq, candYearM, reqYear);
        if (preSc >= 0 && preSc - 18 > best) best = preSc - 18;
      }
    }
  }
  return best;
}

async function postWebteizleForm(path, bodyStr, referer, timeoutMs = 4500) {
  const u = new URL(`https://webteizle.info${path}`);
  if (!WT_ALLOWED_HOST_RE.test(u.hostname)) return "";
  try {
    const r = await fetch(u.toString(), {
      method: "POST",
      headers: {
        "User-Agent": UA_EDGE,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: referer,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      r.body?.cancel?.();
      return "";
    }
    const buf = await r.arrayBuffer();
    return decodeTurkishLegacyText(buf);
  } catch {
    return "";
  }
}

const CP1254_HIGH = {
  0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021",
  0x88: "\u02c6", 0x89: "\u2030", 0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152", 0x91: "\u2018", 0x92: "\u2019",
  0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014", 0x98: "\u02dc", 0x99: "\u2122",
  0x9a: "\u0161", 0x9b: "\u203a", 0x9c: "\u0153", 0x9f: "\u0178",
  0xd0: "\u011e", 0xdd: "\u0130", 0xde: "\u015e", 0xf0: "\u011f", 0xfd: "\u0131", 0xfe: "\u015f",
};

export function decodeTurkishLegacyText(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {}
  try {
    return new TextDecoder("windows-1254").decode(buf);
  } catch {}
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 0x80 ? String.fromCharCode(b) : (CP1254_HIGH[b] || String.fromCharCode(b));
  }
  return out;
}

async function extractWebteizleMovie({ title, displayTitle, originalTitle, year }, fetchPublicFn) {
  const fullTitles = [];
  const searchQueries = [];
  for (const qRaw of [originalTitle, title, displayTitle]) {
    const clean = String(qRaw || "").replace(/\(\d{4}\)/g, "").trim();
    if (!clean) continue;
    if (!fullTitles.includes(clean)) fullTitles.push(clean);
    if (!searchQueries.includes(clean)) searchQueries.push(clean);
  }
  for (const clean of [...fullTitles]) {
    const pre = clean.split(/[:\-–—]/)[0].trim();
    if (pre.length >= 4 && !searchQueries.includes(pre)) searchQueries.push(pre);
    const firstWord = clean.split(/\s+/)[0].trim();
    if (firstWord.length >= 4 && !searchQueries.includes(firstWord)) searchQueries.push(firstWord);
  }
  if (!searchQueries.length) return null;

  let pickedPath = "";
  let bestScore = -1;
  for (const q of searchQueries.slice(0, 4)) {
    const raw = await postWebteizleForm("/ajax/arama.asp", `q=${encodeURIComponent(q)}`, "https://webteizle.info/");
    if (!raw) continue;
    let items = [];
    try {
      items = JSON.parse(raw)?.results?.filmler?.results || [];
    } catch {
      continue;
    }
    for (const it of items) {
      const u = String(it?.url || "").trim();
      if (!u.startsWith("/hakkinda/")) continue;
      const itTitle = String(it?.title || "").trim();
      const itDesc = String(it?.description || "").trim();
      const ym = itTitle.match(/\((\d{4})\)/);
      const sc1 = titlesMatchScore(itTitle, fullTitles, year);
      const sc2 = itDesc ? titlesMatchScore(ym ? `${itDesc} (${ym[1]})` : itDesc, fullTitles, year) : -1;
      const sc = Math.max(sc1, sc2);
      if (sc > bestScore) {
        bestScore = sc;
        pickedPath = u;
      }
    }
    if (bestScore >= 95) break;
  }
  if (!pickedPath || bestScore < 40) return null;

  const hakkindaHtml = await fetchTextSafe(
    `https://webteizle.info${pickedPath}`,
    { "User-Agent": UA_EDGE, Referer: "https://webteizle.info/" },
    fetchPublicFn,
    4500
  );
  if (!hakkindaHtml) return null;

  const slug = pickedPath.split("/").pop() || "";
  const allWatchLinks = [];
  for (const m of hakkindaHtml.matchAll(/href="(\/izle\/(?:altyazi|dublaj)\/[a-z0-9-]+)"/gi)) {
    if (!allWatchLinks.includes(m[1])) allWatchLinks.push(m[1]);
  }
  const ownLinks = slug ? allWatchLinks.filter((u) => u.endsWith(`/${slug}`) || u.includes(`/${slug}-`)) : [];
  const watchLinks = ownLinks.length ? ownLinks : allWatchLinks;
  if (!watchLinks.length) return null;

  const resolvedStreams = [];
  let primarySubs = [];
  for (const wl of watchLinks.slice(0, 2)) {
    const izUrl = `https://webteizle.info${wl}`;
    const izHtml = await fetchTextSafe(izUrl, { "User-Agent": UA_EDGE, Referer: "https://webteizle.info/" }, fetchPublicFn, 4500);
    const idM = izHtml.match(/data-id=["'](\d+)["']/i);
    if (!idM) continue;
    const dilM = izHtml.match(/data-dil=["']?(\d+)["']?/i);
    const altRaw = await postWebteizleForm("/ajax/dataAlternatif3.asp", `filmid=${idM[1]}&dil=${dilM ? dilM[1] : "0"}&s=&b=&bot=0`, izUrl);
    let alts = [];
    try {
      alts = JSON.parse(altRaw)?.data || [];
    } catch {
      continue;
    }
    const isDub = wl.includes("/dublaj/");
    const candidates = [
      { alt: alts.find((a) => /filemoon/i.test(String(a?.baslik || ""))), kind: "filemoon" },
      { alt: alts.find((a) => /vidmoly/i.test(String(a?.baslik || ""))), kind: "vidmoly" },
    ].filter((c) => c.alt?.id);
    for (const cand of candidates) {
      const embRaw = await postWebteizleForm("/ajax/dataEmbed.asp", `id=${cand.alt.id}`, izUrl);
      let embedTarget = "";
      if (cand.kind === "vidmoly") {
        const vmId =
          embRaw.match(/vidmoly\(\s*['"]([a-z0-9_-]+)['"]/i)?.[1] ||
          embRaw.match(/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+\/(?:embed-|w\/)([a-z0-9_-]+)/i)?.[1];
        if (vmId) embedTarget = `https://vidmoly.biz/embed-${vmId}.html`;
      } else {
        const fmId =
          embRaw.match(/filemoon\(\s*['"]([a-z0-9_-]+)['"]/i)?.[1] ||
          embRaw.match(/(?:filemoon|byse)\.[a-z0-9-]+\/(?:e|d)\/([a-z0-9_-]+)/i)?.[1];
        if (fmId) embedTarget = `https://filemoon.sx/e/${fmId}`;
      }
      if (!embedTarget) continue;
      const res = await resolveEmbedHtmlToHls(embedTarget, fetchPublicFn);
      if (res?.url && !resolvedStreams.some((x) => x.url === res.url)) {
        const srvTag = cand.kind === "filemoon" ? "FileMoon" : "VidMoly";
        resolvedStreams.push({
          url: res.url,
          referer: res.referer || (cand.kind === "vidmoly" ? "https://vidmoly.biz/" : "https://filemoon.sx/"),
          label: isDub ? `📡 Webteizle · Türkçe Dublaj · ${srvTag}` : `📡 Webteizle · Türkçe Altyazılı · ${srvTag}`,
        });
        if (!primarySubs.length && res.subs?.length) primarySubs = res.subs;
      }
    }
  }
  if (!resolvedStreams.length) return null;
  resolvedStreams.sort((a, b) => {
    const aVm = isVmpxOrVidmolyUrl(a.url) ? 1 : 0;
    const bVm = isVmpxOrVidmolyUrl(b.url) ? 1 : 0;
    return aVm - bVm;
  });
  return {
    url: resolvedStreams[0].url,
    referer: resolvedStreams[0].referer,
    subs: primarySubs,
    streams: resolvedStreams,
    tag: "hls_wt_vm",
  };
}

function isVmpxOrVidmolyUrl(rawUrl) {
  return /(?:vmpx\.|vidmoly\.|vmbox\.|vmnow\.|vmget\.)/i.test(String(rawUrl || ""));
}

function isCfPoisonedVmpxUrl(rawUrl) {
  const s = String(rawUrl || "");
  return /vmpx\./i.test(s) && /(?:[?&])asn=(?:132892|13335)\b/i.test(s);
}

function decodeHtmlEntitiesBasic(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeMolyObfuscation(mHtml) {
  const raw = String(mHtml || "");
  const decodedParts = [];
  for (const obfM of raw.matchAll(/atob\(\s*unescape\(\s*["']([^"']+)["']\s*\)\s*\)/gi)) {
    if (!obfM?.[1]) continue;
    try {
      let esc = obfM[1];
      try {
        esc = decodeURIComponent(esc);
      } catch {
        esc = unescape(esc);
      }
      const bin = atob(esc.replace(/\s+/g, ""));
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      if (decoded) decodedParts.push(decoded);
    } catch {
      // Safe fallback: skip malformed block and continue checking remaining blocks
    }
  }
  return decodedParts.length ? decodedParts.join("\n") : raw;
}

async function extractDiziboxEpisode({ title, displayTitle, originalTitle, sourceUrl, year, s, e }, fetchPublicFn) {
  const hdrs = {
    "User-Agent": UA_EDGE,
    Referer: "https://www.dizibox.live/",
    "Accept-Language": "tr-TR,tr;q=0.9",
    Cookie: `LockUser=true; isTrustedUser=true; dbxu=${Date.now()}`,
  };
  const reqTitles = [originalTitle, title, displayTitle].filter((x) => String(x || "").trim());
  const slugs = [];
  if (sourceUrl && /dizibox\./i.test(sourceUrl)) {
    const sm = sourceUrl.match(/dizibox\.[a-z.]+\/(?:diziler\/)?([a-z0-9-]+?)(?:-\d+-sezon.*)?\/?$/i);
    if (sm?.[1]) slugs.push(sm[1]);
  }
  for (const rt of reqTitles) {
    const sl = slugifyAscii(rt);
    if (sl && !slugs.includes(sl)) slugs.push(sl);
    if (sl && !slugs.includes(`${sl}-izle`)) slugs.push(`${sl}-izle`);
  }

  const extractFromEpUrl = async (epUrl, skipTitleCheck = false) => {
    const html = await fetchTextSafe(epUrl, hdrs, fetchPublicFn, 5000);
    if (!html) return null;
    if (!skipTitleCheck && !String(sourceUrl || "").includes("dizibox.")) {
      const tM = html.match(/<title>([^<]+)<\/title>/i);
      if (tM && titlesMatchScore(tM[1], reqTitles, year) < 0) return null;
    }

    const streams = [];
    let mUrl = html.match(/<iframe[^>]+src=["']((?:https?:)?\/\/www\.dizibox\.live\/player\/moly\/moly\.php\?[^"']+)["']/i)?.[1] || "";
    if (!mUrl) {
      const h2 = await fetchTextSafe(`${epUrl}2/`, { ...hdrs, Referer: epUrl }, fetchPublicFn, 4500);
      mUrl = h2.match(/<iframe[^>]+src=["']((?:https?:)?\/\/www\.dizibox\.live\/player\/moly\/moly\.php\?[^"']+)["']/i)?.[1] || "";
    }
    if (mUrl) {
      const fullM = mUrl.startsWith("//") ? `https:${mUrl}` : mUrl;
      const mHtml = await fetchTextSafe(fullM, { ...hdrs, Referer: epUrl }, fetchPublicFn, 4500);
      const decodedM = decodeMolyObfuscation(mHtml);
      const vmU = decodedM.match(/https?:\/\/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+\/(?:embed-|w\/)[a-zA-Z0-9_-]+(?:\.html)?/i)?.[0];
      if (vmU) {
        const vmRes = await resolveEmbedHtmlToHls(vmU, fetchPublicFn);
        if (vmRes?.url) {
          streams.push({ url: vmRes.url, referer: vmRes.referer || "https://vidmoly.biz/", label: "📡 Sunucu 1 · VidMoly (HD HLS)" });
        }
      }
    }

    const kUrl = html.match(/<iframe[^>]+src=["']((?:https?:)?\/\/www\.dizibox\.live\/player\/king\/king\.php\?v=[^"']+)["']/i)?.[1] || "";
    if (kUrl) {
      const fullK = kUrl.startsWith("//") ? `https:${kUrl}` : kUrl;
      const kHtml = await fetchTextSafe(fullK, { ...hdrs, Referer: epUrl }, fetchPublicFn, 4500);
      const em = kHtml.match(/https?:\/\/dbx\.molystream\.org\/embed\/([a-zA-Z0-9_-]+)/i);
      if (em?.[1]) {
        const sheilaU = `https://dbx.molystream.org/embed/sheila/${em[1]}`;
        streams.push({ url: sheilaU, referer: "https://dbx.molystream.org/", label: "📡 Sunucu 2 · Molystream (1080p HLS)" });
      }
    }
    if (streams.length > 1) {
      const sheilaIdx = streams.findIndex((st) => /dbx\.molystream\.org/i.test(String(st?.url || "")));
      if (sheilaIdx > 0) {
        const [sheila] = streams.splice(sheilaIdx, 1);
        streams.unshift(sheila);
      }
    }
    if (streams.length) {
      return { url: streams[0].url, referer: streams[0].referer, subs: [], streams, tag: "hls_dbx_live" };
    }
    return null;
  };

  const results = await Promise.allSettled(
    slugs.slice(0, 3).map((sl) => extractFromEpUrl(`https://www.dizibox.live/${sl}-${s}-sezon-${e}-bolum-izle/`, false))
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value?.url) return r.value;
  }

  // Search fallback via dizibox.live/?s=... (parse ONLY <article>...</article> blocks)
  const searchQueries = [];
  for (const rt of reqTitles) {
    const clean = String(rt || "").replace(/\(\d{4}\)/g, "").trim();
    if (!clean) continue;
    if (!searchQueries.includes(clean)) searchQueries.push(clean);
    if (clean.includes(":")) {
      const pre = clean.split(":")[0].trim();
      if (pre.length >= 3 && !searchQueries.includes(pre)) searchQueries.push(pre);
    }
  }

  let bestSeriesSlug = "";
  let bestSeriesScore = -1;
  for (const q of searchQueries.slice(0, 2)) {
    const sHtml = await fetchTextSafe(`https://www.dizibox.live/?s=${encodeURIComponent(q)}`, hdrs, fetchPublicFn, 4500);
    if (!sHtml) continue;
    for (const artM of sHtml.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
      const block = artM[1];
      const linkM = block.match(/<a[^>]+href=["'](https?:\/\/www\.dizibox\.live\/diziler\/([a-z0-9-]+)\/?)["']/i);
      if (!linkM?.[2]) continue;
      const slugCand = linkM[2];
      const h3M = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const attrM = block.match(/(?:title|alt)=["']([^"']+)["']/i);
      const yrM =
        block.match(/<i[^>]*icon-globe[^>]*><\/i>[^<]*?\b((?:19|20)\d{2})\b/i) ||
        block.match(/<span[^>]*class=["'][^"']*year[^"']*["'][^>]*>\s*((?:19|20)\d{2})\s*<\/span>/i);
      const baseTitle = decodeHtmlEntitiesBasic(h3M?.[1] || attrM?.[1] || slugCand.replace(/-/g, " "));
      const candTitle = yrM?.[1] && !/\(\d{4}\)/.test(baseTitle) ? `${baseTitle} (${yrM[1]})` : baseTitle;
      const sc = titlesMatchScore(candTitle, reqTitles, year);
      if (sc >= 40 && sc > bestSeriesScore) {
        bestSeriesScore = sc;
        bestSeriesSlug = slugCand;
      }
    }
    if (bestSeriesScore >= 90) break;
  }

  if (bestSeriesSlug) {
    const epSlugs = [];
    const noHd = bestSeriesSlug.replace(/-hd$/i, "");
    if (noHd) epSlugs.push(noHd);
    if (!epSlugs.includes(bestSeriesSlug)) epSlugs.push(bestSeriesSlug);
    for (const epSlug of epSlugs) {
      const hit = await extractFromEpUrl(`https://www.dizibox.live/${epSlug}-${s}-sezon-${e}-bolum-izle/`, true);
      if (hit?.url) return hit;
    }
    const seriesHtml = await fetchTextSafe(`https://www.dizibox.live/diziler/${bestSeriesSlug}/`, hdrs, fetchPublicFn, 4500);
    if (seriesHtml) {
      const epLinkRe = new RegExp(`href=["'](https?:\\/\\/www\\.dizibox\\.live\\/[^"']*?-${s}-sezon-${e}-bolum(?:-[a-z0-9-]*)?\\/)["']`, "i");
      const epLinkM = seriesHtml.match(epLinkRe);
      if (epLinkM?.[1]) {
        const hit = await extractFromEpUrl(epLinkM[1], true);
        if (hit?.url) return hit;
      }
    }
  }
  return null;
}

// Pure-JS RFC 1321 MD5 for OpenSSL EVP_BytesToKey (Node & CF Workers lack crypto.subtle MD5)
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

function md5Bytes(inputBytes) {
  const src = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes || 0);
  const bitLen = src.length * 8;
  const padLen = ((56 - ((src.length + 1) % 64)) + 64) % 64;
  const buf = new Uint8Array(src.length + 1 + padLen + 8);
  buf.set(src, 0);
  buf[src.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, bitLen >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const sum = (A + F + MD5_K[i] + M[g]) >>> 0;
      const s = MD5_SHIFTS[i];
      const rot = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rot) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, a0, true);
  outDv.setUint32(4, b0, true);
  outDv.setUint32(8, c0, true);
  outDv.setUint32(12, d0, true);
  return out;
}

function evpBytesToKeyMd5(pwBytes, saltBytes, totalLen = 48) {
  const out = new Uint8Array(totalLen);
  let off = 0;
  let prev = new Uint8Array(0);
  while (off < totalLen) {
    const inp = new Uint8Array(prev.length + pwBytes.length + saltBytes.length);
    inp.set(prev, 0);
    inp.set(pwBytes, prev.length);
    inp.set(saltBytes, prev.length + pwBytes.length);
    prev = md5Bytes(inp);
    const take = Math.min(prev.length, totalLen - off);
    out.set(prev.subarray(0, take), off);
    off += take;
  }
  return { key: out.slice(0, 32), iv: out.slice(32, 48) };
}

function b64ToUint8(b64Str) {
  const bin = atob(String(b64Str || "").replace(/\s+/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function extractDizilife({ title, displayTitle, originalTitle, sourceUrl, year, mtype, s, e }, fetchPublicFn) {
  const rawCands = [displayTitle, title, originalTitle]
    .map((x) => String(x || "").replace(/\(\d{4}\)/g, "").trim())
    .filter(Boolean);
  const qCands = [];
  const validTitles = [];
  for (const x of rawCands) {
    if (!validTitles.includes(x)) validTitles.push(x);
    if (x.includes(":")) {
      const sp = x.replace(/:/g, " ").replace(/\s+/g, " ").trim();
      if (sp && !validTitles.includes(sp)) validTitles.push(sp);
      const pre = x.split(":")[0].trim();
      if (pre.length >= 3 && !qCands.includes(pre)) qCands.push(pre);
      if (sp && !qCands.includes(sp)) qCands.push(sp);
    }
    if (!qCands.includes(x)) qCands.push(x);
  }
  for (const vt of [displayTitle, title, originalTitle]) {
    const clean = String(vt || "").trim();
    if (clean && !validTitles.includes(clean)) validTitles.push(clean);
  }
  if (!validTitles.length) return null;
  const wantKore = validTitles.some((vt) => /kore|korea/i.test(String(vt || "")));
  const seg = mtype === "tv" ? "dizi" : "film";

  const directDl = sourceUrl && /dizi\d*\.(?:life|plus)\/(?:dizi|film)\//i.test(sourceUrl)
    ? sourceUrl.replace(/https?:\/\/dizi\d*\.(?:life|plus)/i, "https://dizi87.life")
    : "";

  const slugSteps = [];
  for (const x of [originalTitle, title, displayTitle]) {
    const sl = slugifyAscii(x);
    if (sl && sl.length >= 3) {
      const u = `https://dizi87.life/${seg}/${sl}`;
      if (!slugSteps.some((st) => st.val === u)) slugSteps.push({ mode: "SLUG", val: u });
    }
    if (slugSteps.length >= 2) break;
  }

  const steps = [
    ...(directDl ? [{ mode: "DIRECT", val: directDl }] : []),
    ...slugSteps,
    ...qCands.slice(0, 2).map((q) => ({ mode: "SEARCH", val: q })),
  ];

  const fetchHtmlWithBase = async (targetUrl, refUrl, timeoutMs = 4500) => {
    try {
      const { resp, finalUrl } = await fetchPublicFn(
        targetUrl,
        { "User-Agent": UA_EDGE, Referer: refUrl, "Accept-Language": "tr-TR,tr;q=0.9" },
        4,
        timeoutMs
      );
      if (!resp || !resp.ok) {
        const status = resp?.status || 0;
        resp?.body?.cancel?.();
        return status === 429 ? { rateLimited: true } : null;
      }
      const html = await resp.text();
      return { html, baseDom: new URL(finalUrl).origin, finalUrl };
    } catch {
      return null;
    }
  };

  for (const step of steps) {
    let matchedUrl = "";
    let baseDom = "https://dizi87.life";
    if (step.mode === "DIRECT" || step.mode === "SLUG") {
      matchedUrl = step.val;
      try { baseDom = new URL(matchedUrl).origin; } catch {}
    } else {
      let sRes = null;
      for (const dlHost of ["https://dizi87.life", "https://dizi86.life", "https://dizi84.life"]) {
        sRes = await fetchHtmlWithBase(`${dlHost}/ara?q=${encodeURIComponent(step.val)}`, `${dlHost}/`, 3500);
        if (sRes?.rateLimited) return null;
        if (sRes?.html) break;
      }
      if (!sRes?.html) continue;
      baseDom = sRes.baseDom;
      const cardRe = new RegExp(`<a[^>]+href=["']((?:https?:\\/\\/[^"'\\s/]+)?\\/${seg}\\/[a-z0-9-]+)["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
      let bestCardUrl = "";
      let bestCardScore = -1;
      for (const m of sRes.html.matchAll(cardRe)) {
        const href = m[1];
        const inner = m[2];
        const slugPart = href.split("/").pop() || "";
        if (!wantKore && (slugPart.includes("-kore") || slugPart.includes("korea"))) continue;
        const tm = inner.match(/data-fallback-title=["']([^"']+)["']/i) || inner.match(/alt=["']([^"']+)["']/i);
        const slugTitle = slugPart.replace(/-/g, " ");
        const cTitle = decodeHtmlEntitiesBasic(tm?.[1] || slugTitle);
        const ym = inner.match(/<span>\s*((?:19|20)\d{2})\s*<\/span>/i);
        const cYear = ym?.[1] || "";
        const reqYrNum = /^\d{4}/.test(String(year || "")) ? Number(String(year).slice(0, 4)) : 0;
        if (cYear && reqYrNum) {
          const tol = mtype === "movie" ? 1 : 4;
          if (Math.abs(Number(cYear) - reqYrNum) > tol) continue;
        }
        const passYear = cYear && reqYrNum && Math.abs(Number(cYear) - reqYrNum) <= 2 ? String(reqYrNum) : "";
        const titleInput1 = passYear ? `${cTitle} (${cYear})` : cTitle;
        const titleInput2 = passYear ? `${slugTitle} (${cYear})` : slugTitle;
        const sc = Math.max(
          titlesMatchScore(titleInput1, validTitles, passYear),
          titlesMatchScore(titleInput2, validTitles, passYear)
        );
        if (sc >= 50 && sc > bestCardScore) {
          bestCardScore = sc;
          bestCardUrl = href.startsWith("http") ? href : `${baseDom}${href}`;
        }
      }
      matchedUrl = bestCardUrl;
    }

    if (!matchedUrl) continue;
    let epUrl = matchedUrl;
    if (mtype === "tv") {
      if (epUrl.includes("/sezon/")) {
        epUrl = epUrl.replace(/\/+$/, "").replace(/\/sezon\/\d+\/bolum\/\d+.*$/, `/sezon/${s}/bolum/${e}`);
      } else {
        epUrl = `${epUrl.replace(/\/+$/, "")}/sezon/${s}/bolum/${e}`;
      }
    }

    let epRes = await fetchHtmlWithBase(epUrl, `${baseDom}/`, 4500);
    if (epRes?.rateLimited) return null;
    if (!epRes && mtype === "tv" && !matchedUrl.includes("/sezon/") && step.mode !== "SLUG") {
      const sRes = await fetchHtmlWithBase(matchedUrl, `${baseDom}/`, 4000);
      if (sRes?.rateLimited) return null;
      if (sRes?.html) {
        baseDom = sRes.baseDom;
        const altRe = new RegExp(`href=["']((?:https?:\\/\\/[^"'\\s/]+)?\\/${seg}\\/[a-z0-9-]+\\/sezon\\/\\d+\\/bolum\\/${e})["']`, "i");
        const altM = sRes.html.match(altRe);
        if (altM?.[1]) {
          epUrl = altM[1].startsWith("http") ? altM[1] : `${baseDom}${altM[1]}`;
          epRes = await fetchHtmlWithBase(epUrl, `${baseDom}/`, 4500);
          if (epRes?.rateLimited) return null;
        }
      }
    }
    if (!epRes?.html) continue;

    if (step.mode === "SLUG") {
      const pageTitleM = epRes.html.match(/<title>([^<]+)<\/title>/i);
      if (pageTitleM?.[1] && titlesMatchScore(pageTitleM[1], validTitles, mtype === "movie" ? year : "") < 40) {
        continue;
      }
    }

    const ifrM = epRes.html.match(/<iframe[^>]+src=["']((?:https?:)?\/\/[^"']+\/player\/[^"']+)["']/i);
    if (!ifrM?.[1]) continue;
    const pu = ifrM[1].startsWith("//") ? `https:${ifrM[1]}` : ifrM[1];
    const pHtml = await fetchTextSafe(pu, { "User-Agent": UA_EDGE, Referer: epRes.finalUrl || epUrl }, fetchPublicFn, 4200);
    if (!pHtml) continue;

    const fnM = pHtml.match(/var\s+([a-zA-Z0-9_$]+)\s*=\s*function\(s\)\{return atob/);
    if (!fnM?.[1]) continue;
    const escapedFn = fnM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sMatches = [...pHtml.matchAll(new RegExp(`${escapedFn}\\("([^"]+)"\\)`, "g"))].map((m) => m[1]);
    if (sMatches.length < 2) continue;

    try {
      const cB64 = atob(sMatches[0].split("").reverse().join(""));
      const pwBytes = b64ToUint8(sMatches[1].split("").reverse().join(""));
      const raw = b64ToUint8(cB64);
      if (raw.length <= 16 || String.fromCharCode(...raw.subarray(0, 8)) !== "Salted__") continue;
      const salt = raw.subarray(8, 16);
      const ct = raw.subarray(16);
      const { key, iv } = evpBytesToKeyMd5(pwBytes, salt, 48);
      const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
      const ptBuf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, ct);
      const pt = new TextDecoder("utf-8", { fatal: false }).decode(ptBuf);
      const fm = pt.match(/file:\s*"([^"]+)"/);
      if (!fm?.[1]) continue;
      const rawFile = fm[1].trim();
      const cleanMu = rawFile.split("?")[0].trim();
      let workingMu = "";
      let pOrigin = "";
      try { pOrigin = new URL(pu).origin; } catch {}

      for (const candMu of cleanMu === rawFile ? [cleanMu] : [cleanMu, rawFile]) {
        if (!candMu.startsWith("https://")) continue;
        try {
          if (isBlockedAdHost(new URL(candMu).hostname)) continue;
        } catch {
          continue;
        }
        try {
          const refHdr = `${pOrigin}/`;
          const { resp: mResp } = await fetchPublicFn(candMu, { "User-Agent": UA_EDGE, Referer: refHdr }, 4, 3500);
          if (mResp?.ok) {
            const mTxt = await mResp.text();
            if (mTxt.includes("#EXTM3U")) {
              workingMu = candMu;
              break;
            }
          } else {
            mResp?.body?.cancel?.();
          }
        } catch {}
      }
      if (!workingMu) continue;

      const baseM = workingMu.replace(/\/[^/]*$/, "");
      const subRef = pOrigin ? `${pOrigin}/` : "";
      const checkSub = async (lang, subUrl) => {
        try {
          const sr = await fetch(subUrl, {
            method: "HEAD",
            headers: { "User-Agent": UA_EDGE, ...(subRef ? { Referer: subRef } : {}) },
            redirect: "manual",
            signal: AbortSignal.timeout(1500),
          });
          sr.body?.cancel?.();
          return sr.ok ? { lang, url: subUrl, source: "dl_embed" } : null;
        } catch {
          return null;
        }
      };
      const subChecks = await Promise.all([
        checkSub("tr", `${baseM}/sub_turkish/turkish.vtt`),
        checkSub("en", `${baseM}/sub_english/english.vtt`),
      ]);
      const subs = subChecks.filter(Boolean);
      const outRef = /makesomthingup|centralodsseyproud|\/r6\//i.test(workingMu) ? "https://one.makesomthingup.click/" : `${pOrigin}/`;
      return {
        url: workingMu,
        referer: outRef,
        subs,
        streams: [{ url: workingMu, referer: outRef, label: "📡 Sunucu · Dizilife (1080p HLS)" }],
        tag: "hls_dl",
      };
    } catch {
      continue;
    }
  }
  return null;
}

const _HEXA_CAP = { token: "", uses: 0, exp: 0, deadUntil: 0 };

function randomHexBytes(nBytes = 32) {
  const arr = new Uint8Array(nBytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchJsonPostSafe(targetUrl, bodyObj, hdrs, timeoutMs = 4000) {
  try {
    const r = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hdrs },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      r.body?.cancel?.();
      return { status: r.status, data: null };
    }
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch {
    return { status: 0, data: null };
  }
}

async function extractHexa({ tmdbId, mtype, s, e }, fetchPublicFn) {
  const tid = String(tmdbId || "").trim();
  if (!/^\d+$/.test(tid)) return null;
  const now = Date.now();
  if (now < _HEXA_CAP.deadUntil) return null;

  const hxCapHdrs = {
    "User-Agent": UA_EDGE,
    Origin: "https://hexa.su",
    Referer: "https://hexa.su/",
  };

  let tok = _HEXA_CAP.token || "";
  if (!tok || _HEXA_CAP.uses >= 18 || now > _HEXA_CAP.exp) {
    tok = "";
    const chRes = await fetchJsonPostSafe("https://cap.hexa.su/15d2cf0395/challenge", {}, hxCapHdrs, 2500);
    if (chRes.status === 403 || chRes.status === 429 || chRes.status === 503) {
      _HEXA_CAP.deadUntil = now + 180_000;
      return null;
    }
    if (chRes.data?.token) {
      const encRes = await fetchJsonPostSafe("https://enc-dec.app/api/enc-hexa", { challenge_data: chRes.data }, {}, 4000);
      const sol = encRes.data?.result;
      if (sol?.token) {
        const redRes = await fetchJsonPostSafe("https://cap.hexa.su/15d2cf0395/redeem", sol, hxCapHdrs, 3500);
        const redeemedTok = String(redRes.data?.token || "").trim();
        if (redeemedTok) {
          tok = redeemedTok;
          _HEXA_CAP.token = tok;
          _HEXA_CAP.uses = 0;
          _HEXA_CAP.exp = now + 540_000;
        }
      }
    }
  }
  if (!tok) return null;

  _HEXA_CAP.uses += 1;
  const apiKey = randomHexBytes(32);
  const ep = mtype === "tv"
    ? `https://theemoviedb.hexa.su/api/tmdb/tv/${tid}/season/${s}/episode/${e}/images`
    : `https://theemoviedb.hexa.su/api/tmdb/movie/${tid}/images`;
  const encTxt = await fetchTextSafe(
    ep,
    {
      "User-Agent": UA_EDGE,
      Referer: "https://hexa.su/",
      Origin: "https://hexa.su",
      Accept: "text/plain",
      "X-Fingerprint-Lite": "e9136c41504646444",
      "X-Api-Key": apiKey,
      "X-Cap-Token": tok,
    },
    fetchPublicFn,
    4500
  );
  if (!encTxt || encTxt.length <= 20) return null;

  const decRes = await fetchJsonPostSafe("https://enc-dec.app/api/dec-hexa", { text: encTxt, key: apiKey }, {}, 4500);
  const srcs = Array.isArray(decRes.data?.result?.sources) ? [...decRes.data.result.sources] : [];
  if (!srcs.length) return null;

  srcs.sort((a, b) => {
    const aFav = String(a?.url || "").includes("fuckme.dragonballzfans") ? 0 : 1;
    const bFav = String(b?.url || "").includes("fuckme.dragonballzfans") ? 0 : 1;
    return aFav - bFav;
  });

  const candUrls = [];
  for (const src of srcs) {
    const u = String(src?.url || "").trim();
    if (!u.startsWith("https://")) continue;
    if (u.includes("serve.dragonballzfans.xyz") || u.includes("shrek.dragonballzfans.xyz") || u.includes("sun.dragonballzfans.xyz")) continue;
    try {
      if (isBlockedAdHost(new URL(u).hostname)) continue;
    } catch {
      continue;
    }
    if (!candUrls.includes(u)) candUrls.push(u);
  }
  if (!candUrls.length) return null;

  const probeHexa = async (uCand) => {
    if (!uCand.includes("dragonballzfans")) return uCand;
    try {
      const { resp } = await fetchPublicFn(
        uCand,
        { "User-Agent": UA_EDGE, Referer: "https://hexa.su/", Origin: "https://hexa.su" },
        4,
        2500
      );
      if (!resp?.ok) {
        resp?.body?.cancel?.();
        return null;
      }
      const txt = await resp.text();
      return txt.includes("#EXTM3U") ? uCand : null;
    } catch {
      return null;
    }
  };

  const probed = await Promise.all(candUrls.slice(0, 4).map(probeHexa));
  const validUrls = probed.filter(Boolean);
  if (!validUrls.length) return null;

  const streams = validUrls.map((u, idx) => ({
    url: u,
    referer: "https://hexa.su/",
    label: `📡 Hexa · Sunucu ${idx + 1} (1080p HLS)`,
  }));
  return {
    url: streams[0].url,
    referer: "https://hexa.su/",
    subs: [],
    streams,
    tag: "hls_hexa",
  };
}

function mergeResolvedResults(resultList) {
  const rawStreams = [];
  const subs = [];
  const seenUrls = new Set();
  const seenSubs = new Set();
  for (const res of resultList) {
    if (!res) continue;
    const list = Array.isArray(res.streams) && res.streams.length
      ? res.streams
      : (res.url ? [{ url: res.url, referer: res.referer, label: "" }] : []);
    for (const st of list) {
      const u = String(st?.url || "").trim();
      if (!u || seenUrls.has(u)) continue;
      seenUrls.add(u);
      rawStreams.push({ url: u, referer: st.referer || res.referer || "", label: st.label || "" });
    }
    for (const sb of res.subs || []) {
      const su = String(sb?.url || "").trim();
      if (!su || seenSubs.has(su)) continue;
      seenSubs.add(su);
      subs.push(sb);
    }
  }
  if (!rawStreams.length) return null;

  const hasNonVmpx = rawStreams.some((st) => !isVmpxOrVidmolyUrl(st.url));
  const filtered = hasNonVmpx
    ? rawStreams.filter((st) => !isCfPoisonedVmpxUrl(st.url))
    : rawStreams;

  const rankStream = (st) => {
    const u = String(st.url || "").toLowerCase();
    if (/makesomthingup|centralodsseyproud|\/r6\//.test(u)) return 0;
    if (/imgsapi\.pro|pilavyerplay\.top/.test(u)) return 1;
    if (/dbx\.molystream\.org/.test(u)) return 1;
    if (/sprintcdn|r66nv9ed|owphbf24|filemoon|byse/.test(u)) return 2;
    if (/tau-video|irtau1/.test(u)) return 2;
    if (/dragonballzfans/.test(u)) return 3;
    if (!isVmpxOrVidmolyUrl(u)) return 4;
    return isCfPoisonedVmpxUrl(u) ? 6 : 5;
  };
  filtered.sort((a, b) => rankStream(a) - rankStream(b));

  return {
    url: filtered[0].url,
    referer: filtered[0].referer,
    subs,
    streams: filtered,
    tag: resultList.find((r) => r?.tag)?.tag || "hls_edge",
  };
}

async function extractFilmmoduMovie({ title, displayTitle, originalTitle, year }, fetchPublicFn) {
  const FM_ORIGIN = "https://www.filmmodu.one";
  const reqTitles = [originalTitle, title, displayTitle]
    .map((x) => String(x || "").replace(/\(\d{4}\)/g, "").trim())
    .filter(Boolean);
  if (!reqTitles.length) return null;
  const qList = [];
  for (const t of reqTitles) {
    if (!qList.includes(t)) qList.push(t);
    if (t.includes(":")) {
      const pre = t.split(":")[0].trim();
      if (pre.length >= 3 && !qList.includes(pre)) qList.push(pre);
    }
  }

  let pageHtml = "";
  let pageUrl = "";
  for (const q of qList.slice(0, 2)) {
    let resp, finalUrl;
    try {
      ({ resp, finalUrl } = await fetchPublicFn(
        `${FM_ORIGIN}/film-ara?term=${encodeURIComponent(q)}`,
        { "User-Agent": UA_EDGE, Referer: `${FM_ORIGIN}/`, "Accept-Language": "tr-TR,tr;q=0.9" },
        4,
        4000
      ));
    } catch {
      continue;
    }
    if (!resp || !resp.ok) {
      resp?.body?.cancel?.();
      continue;
    }
    const html = await resp.text();
    const isDirectMovie =
      /-film-izle$/i.test(finalUrl) &&
      !/\/(?:turkce-dublaj|turkce-altyazili|film-tur|hd-populer|arsiv)/i.test(finalUrl);
    if (isDirectMovie) {
      const tm = html.match(/<title>([^<]+)<\/title>/i);
      const rawT = tm ? tm[1].replace(/\s*(?:HD\s*)?(?:Türkçe\s*)?(?:Dublaj|Altyazılı|Film\s*İzle|İzle).*$/i, "").trim() : "";
      if (!rawT || titlesMatchScore(rawT, reqTitles, year) >= 0.72) {
        pageHtml = html;
        pageUrl = finalUrl;
        break;
      }
      continue;
    }

    // Parse search result cards (both relative and absolute hrefs ending in -film-izle)
    let bestUrl = "";
    let bestScore = 0;
    const linkRe = /<a[^>]+href=["']((?:https?:\/\/www\.filmmodu\.one)?\/[a-z0-9-]+-film-izle)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1].startsWith("http") ? m[1] : `${FM_ORIGIN}${m[1]}`;
      if (/\/(?:turkce-dublaj|turkce-altyazili|film-tur|4k-film-izle|1080p-film-izle)/i.test(href)) continue;
      const slugTitle = href
        .replace(/^https?:\/\/[^/]+\//i, "")
        .replace(/-(?:hd|4k|turkce-dublaj|turkce-altyazili|altyazili|dublaj)?-?film-izle$/i, "")
        .replace(/-/g, " ")
        .trim();
      const innerText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const sc = Math.max(
        titlesMatchScore(slugTitle, reqTitles, year),
        innerText ? titlesMatchScore(innerText, reqTitles, year) : 0
      );
      if (sc > bestScore) {
        bestScore = sc;
        bestUrl = href;
      }
    }
    if (bestUrl && bestScore >= 0.72) {
      const pHtml = await fetchTextSafe(
        bestUrl,
        { "User-Agent": UA_EDGE, Referer: `${FM_ORIGIN}/`, "Accept-Language": "tr-TR,tr;q=0.9" },
        fetchPublicFn,
        4000
      );
      if (pHtml) {
        pageHtml = pHtml;
        pageUrl = bestUrl;
        break;
      }
    }
  }
  if (!pageHtml) return null;

  // Verify year on page if requested
  if (year && /^\d{4}/.test(String(year))) {
    const reqY = Number(String(year).slice(0, 4));
    const ym = pageHtml.match(/<a[^>]+href="[^"]*\/yil\/(\d{4})"[^>]*>/i) || pageHtml.match(/"datePublished"\s*:\s*"(\d{4})/i);
    if (ym && Math.abs(Number(ym[1]) - reqY) > 1) return null;
  }

  const vidM = pageHtml.match(/var\s+videoId\s*=\s*['"](\d+)['"]/i) || pageHtml.match(/videoId['"]?\s*[:=]\s*['"]?(\d+)/i);
  if (!vidM) return null;
  const vidId = vidM[1];

  const fetchSrc = async (langType) => {
    const raw = await fetchTextSafe(
      `${FM_ORIGIN}/get-source?movie_id=${vidId}&type=${langType}`,
      { "User-Agent": UA_EDGE, Referer: pageUrl || `${FM_ORIGIN}/`, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
      fetchPublicFn,
      4000
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const [trRes, enRes] = await Promise.all([fetchSrc("tr"), fetchSrc("en")]);
  const streams = [];
  const subs = [];
  const pushFromData = (data, tag) => {
    if (!data || typeof data !== "object") return;
    if (typeof data.subtitle === "string" && data.subtitle.trim()) {
      const subU = data.subtitle.startsWith("http") ? data.subtitle : `${FM_ORIGIN}${data.subtitle.startsWith("/") ? "" : "/"}${data.subtitle}`;
      if (!subs.some((x) => x.url === subU)) subs.push({ lang: "tr", url: subU, source: "filmmodu" });
    }
    const srcs = Array.isArray(data.sources) ? [...data.sources] : [];
    srcs.sort((a, b) => Number(b?.res || 0) - Number(a?.res || 0));
    const best = srcs.find((s) => typeof s?.src === "string" && s.src.startsWith("http"));
    if (best && !streams.some((x) => x.url === best.src)) {
      streams.push({ url: best.src, referer: `${FM_ORIGIN}/`, tag });
    }
  };
  pushFromData(trRes, "hls_fm_tr");
  pushFromData(enRes, "hls_fm_en");
  if (!streams.length) return null;
  return { url: streams[0].url, referer: streams[0].referer, subs, streams, tag: streams[0].tag };
}

async function extractDdizimag({ title, displayTitle, originalTitle, sourceUrl, year, mtype, s, e }, fetchPublicFn) {
  const DM_BASE = "https://ddizimag.icu";
  const reqTitles = [originalTitle, title, displayTitle]
    .map((x) => String(x || "").replace(/\(\d{4}\)/g, "").trim())
    .filter(Boolean);
  if (!reqTitles.length) return null;

  const tryEpisodePage = async (epUrl, preVerified = false) => {
    const html = await fetchTextSafe(
      epUrl,
      { "User-Agent": UA_EDGE, Referer: `${DM_BASE}/`, "Accept-Language": "tr-TR,tr;q=0.9" },
      fetchPublicFn,
      4000
    );
    if (!html) return null;
    const pvM = html.match(/data-pv="([^"]+)"/);
    if (!pvM) return null;
    if (!preVerified) {
      const tm = html.match(/<title>([^<]+)<\/title>/i);
      const pt = tm
        ? tm[1]
            .replace(/\s+\d+\.\s*Sezon.*$/i, "")
            .replace(/\s+(?:izle|Full|HD|ddizimag|Dizimag).*$/i, "")
            .trim()
        : "";
      if (pt && titlesMatchScore(pt, reqTitles, year) < 0.72) return null;
    }
    const coreM = html.match(/src="https:\/\/([^/"]+)\/assets\/js\/core\.js"/);
    const pvDom = coreM ? coreM[1] : "pilavyerplay.top";
    const sJs = await fetchTextSafe(
      `https://${pvDom}/assets/js/s.php?s=${encodeURIComponent(pvM[1])}`,
      { "User-Agent": UA_EDGE, Referer: epUrl, Accept: "*/*" },
      fetchPublicFn,
      4200
    );
    if (!sJs) return null;
    const plM = sJs.match(/window\.__PLAYER__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!plM) return null;
    let pl;
    try {
      pl = JSON.parse(plM[1]);
    } catch {
      return null;
    }
    const stUrl = String(pl?.stream || "").trim();
    if (!stUrl.startsWith("https://")) return null;
    if (mtype === "tv") {
      const seM = String(pl?.title || "").match(/S(\d{1,2})\s*E(\d{1,3})/i);
      if (seM && (Number(seM[1]) !== Number(s) || Number(seM[2]) !== Number(e))) return null;
    }
    const subs = [];
    if (Array.isArray(pl?.subs)) {
      for (const sub of pl.subs) {
        if (!sub || typeof sub !== "object") continue;
        const su = String(sub.src || "").trim();
        const sl = String(sub.lang || "").toLowerCase().trim();
        const slbl = String(sub.label || "").toLowerCase();
        if (su.startsWith("https://") && ["tr", "tur", "en", "eng"].includes(sl) && !slbl.includes("forced")) {
          const normL = sl.startsWith("tr") || sl === "tur" ? "tr" : "en";
          if (!subs.some((x) => x.url === su)) subs.push({ lang: normL, url: su, source: "ddizimag" });
        }
      }
    }
    const ref = `https://${pvDom}/`;
    return { url: stUrl, referer: ref, subs, streams: [{ url: stUrl, referer: ref, tag: "hls_pv" }], tag: "hls_pv" };
  };

  // 1. Direct sourceUrl or slug attempt
  const slugCands = [];
  if (sourceUrl && /ddizimag\./i.test(sourceUrl)) {
    const clean = sourceUrl.replace(/^https?:\/\/(?:www\.)?ddizimag\.[a-z]{2,8}/i, DM_BASE).replace(/\/+$/, "");
    slugCands.push({ url: mtype === "tv" && !/\/sezon-\d+/i.test(clean) ? `${clean}/sezon-${s}/bolum-${e}` : clean, pre: true });
  }
  const seg = mtype === "tv" ? "dizi" : "film";
  for (const t of reqTitles.slice(0, 2)) {
    const sl = slugifyAscii(t);
    if (sl && sl.length >= 3) {
      const u = mtype === "tv" ? `${DM_BASE}/${seg}/${sl}/sezon-${s}/bolum-${e}` : `${DM_BASE}/${seg}/${sl}`;
      if (!slugCands.some((c) => c.url === u)) slugCands.push({ url: u, pre: false });
    }
  }
  for (const cand of slugCands.slice(0, 2)) {
    const out = await tryEpisodePage(cand.url, cand.pre);
    if (out?.url) return out;
  }

  // 2. Fallback search via /ara?q=
  const sHtml = await fetchTextSafe(
    `${DM_BASE}/ara?q=${encodeURIComponent(reqTitles[0])}`,
    { "User-Agent": UA_EDGE, Referer: `${DM_BASE}/`, "Accept-Language": "tr-TR,tr;q=0.9" },
    fetchPublicFn,
    3800
  );
  if (!sHtml) return null;
  let bestHref = "";
  let bestScore = 0;
  const hitRe = /href="((?:https?:\/\/(?:www\.)?ddizimag\.[a-z]{2,8})?\/(dizi|film|anime)\/([a-z0-9-]+))"/gi;
  let hm;
  while ((hm = hitRe.exec(sHtml)) !== null) {
    const kind = hm[2].toLowerCase();
    if (mtype === "movie" && kind !== "film") continue;
    if (mtype === "tv" && kind === "film") continue;
    const sc = titlesMatchScore(hm[3].replace(/-/g, " "), reqTitles, year);
    if (sc > bestScore) {
      bestScore = sc;
      bestHref = hm[1].startsWith("http") ? hm[1] : `${DM_BASE}${hm[1]}`;
    }
  }
  if (bestHref && bestScore >= 0.72) {
    const epU = mtype === "tv" ? `${bestHref}/sezon-${s}/bolum-${e}` : bestHref;
    const out = await tryEpisodePage(epU, false);
    if (out?.url) return out;
  }
  return null;
}

async function extractAnimecix({ title, displayTitle, originalTitle, year, mtype, s, e }, fetchPublicFn) {
  const AC_HDRS = {
    "User-Agent": UA_EDGE,
    Referer: "https://animecix.tv/",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  const reqTitles = [originalTitle, title, displayTitle]
    .map((x) => String(x || "").replace(/\(\d{4}\)/g, "").trim())
    .filter(Boolean);
  if (!reqTitles.length) return null;

  let acId = 0;
  for (const q of reqTitles.slice(0, 2)) {
    const raw = await fetchTextSafe(
      `https://animecix.tv/secure/search/${encodeURIComponent(q)}?limit=6`,
      AC_HDRS,
      fetchPublicFn,
      3500
    );
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const results = Array.isArray(obj?.results) ? obj.results : [];
    let bestId = 0;
    let bestScore = 0;
    for (const item of results) {
      if (!item || !item.id) continue;
      if (mtype === "tv" && item.is_series === false) continue;
      if (mtype === "movie" && item.is_series === true) continue;
      const itemYear = String(item.year || "").slice(0, 4);
      const sc = Math.max(
        titlesMatchScore(String(item.name || ""), reqTitles, year || itemYear),
        item.original_title ? titlesMatchScore(String(item.original_title), reqTitles, year || itemYear) : 0,
        item.name_english ? titlesMatchScore(String(item.name_english), reqTitles, year || itemYear) : 0
      );
      if (sc > bestScore) {
        bestScore = sc;
        bestId = Number(item.id);
      }
    }
    if (bestId && bestScore >= 0.72) {
      acId = bestId;
      break;
    }
  }
  if (!acId) return null;

  let vids = [];
  if (mtype === "tv") {
    const rawV = await fetchTextSafe(
      `https://animecix.tv/secure/episode-videos?titleId=${acId}&episode=${e}&season=${s}`,
      AC_HDRS,
      fetchPublicFn,
      3500
    );
    try {
      const parsed = JSON.parse(rawV || "[]");
      if (Array.isArray(parsed)) vids = parsed;
    } catch {}
  } else {
    const rawV = await fetchTextSafe(
      `https://animecix.tv/secure/videos?titleId=${acId}`,
      AC_HDRS,
      fetchPublicFn,
      3500
    );
    try {
      const parsed = JSON.parse(rawV || "{}");
      const arr = parsed?.pagination?.data;
      if (Array.isArray(arr)) {
        vids = arr.filter(
          (v) =>
            v &&
            Number(v.title_id || 0) === acId &&
            !["teaser", "trailer", "clip", "opening", "ending"].includes(String(v.category || "").toLowerCase())
        );
      }
    } catch {}
  }
  if (!vids.length) return null;

  const tauCands = [];
  for (const v of vids) {
    const mTau = String(v?.url || "").match(/tau-video\.xyz\/embed\/([a-zA-Z0-9_-]+)/);
    if (!mTau) continue;
    const isDub = String(v?.extra || "").toLowerCase().includes("dublaj");
    if (!tauCands.some((c) => c.id === mTau[1])) tauCands.push({ id: mTau[1], isDub });
  }
  tauCands.sort((a, b) => (a.isDub === b.isDub ? 0 : a.isDub ? -1 : 1));

  const streams = [];
  for (const cand of tauCands.slice(0, 2)) {
    const tRaw = await fetchTextSafe(
      `https://tau-video.xyz/api/video/${cand.id}`,
      { "User-Agent": UA_EDGE, Referer: `https://tau-video.xyz/embed/${cand.id}`, Accept: "application/json" },
      fetchPublicFn,
      3800
    );
    if (!tRaw) continue;
    let tObj;
    try {
      tObj = JSON.parse(tRaw);
    } catch {
      continue;
    }
    const uList = (Array.isArray(tObj?.urls) ? tObj.urls : []).filter(
      (x) => x && typeof x.url === "string" && x.url.startsWith("https://")
    );
    uList.sort((a, b) => {
      const la = String(a.label || "");
      const lb = String(b.label || "");
      const ra = la.includes("1080") ? 0 : la.includes("720") ? 1 : 2;
      const rb = lb.includes("1080") ? 0 : lb.includes("720") ? 1 : 2;
      return ra - rb;
    });
    if (uList[0]?.url && !streams.some((st) => st.url === uList[0].url)) {
      streams.push({
        url: uList[0].url,
        referer: "https://tau-video.xyz/",
        tag: cand.isDub ? "mp4_ac_dub" : "mp4_ac_sub",
      });
    }
  }
  if (!streams.length) return null;
  return { url: streams[0].url, referer: streams[0].referer, subs: [], streams, tag: streams[0].tag };
}

export async function resolveTurkishCatalogStream({ title, displayTitle, originalTitle, sourceUrl, year = "", mtype, s, e, tmdbId = "", fetchPublicFn }) {
  try {
    const src = String(sourceUrl || "").trim();
    if (/fullhdfilmizlesene\./i.test(src)) {
      const fhdRes = await extractFullhdMoviePage(src, fetchPublicFn);
      if (fhdRes?.url) return fhdRes;
    }
    if (/hdfilmcehennemi\./i.test(src)) {
      const hdfcRes = await extractHdfcPage(src, mtype, s, e, fetchPublicFn);
      if (hdfcRes?.url) return hdfcRes;
    }

    if (mtype === "movie") {
      const wtRes = await extractWebteizleMovie({ title, displayTitle, originalTitle, year }, fetchPublicFn);
      const wtHasNonVmpx = Boolean(wtRes?.streams?.some((st) => !isVmpxOrVidmolyUrl(st?.url)));
      if (wtRes?.url && wtHasNonVmpx) return wtRes;

      const [fmRes, dlRes, hxRes] = await Promise.allSettled([
        extractFilmmoduMovie({ title, displayTitle, originalTitle, year }, fetchPublicFn),
        extractDizilife({ title, displayTitle, originalTitle, sourceUrl: src, year, mtype: "movie", s, e }, fetchPublicFn),
        extractHexa({ tmdbId, mtype: "movie", s, e }, fetchPublicFn),
      ]);
      const firstMerged = mergeResolvedResults([
        wtRes,
        fmRes.status === "fulfilled" ? fmRes.value : null,
        dlRes.status === "fulfilled" ? dlRes.value : null,
        hxRes.status === "fulfilled" ? hxRes.value : null,
      ]);
      const hasCleanStream = Boolean(firstMerged?.streams?.some((st) => !isVmpxOrVidmolyUrl(st?.url)));
      if (firstMerged?.url && hasCleanStream) return firstMerged;

      const [dmRes, acRes] = await Promise.allSettled([
        extractDdizimag({ title, displayTitle, originalTitle, sourceUrl: src, year, mtype: "movie", s, e }, fetchPublicFn),
        extractAnimecix({ title, displayTitle, originalTitle, year, mtype: "movie", s, e }, fetchPublicFn),
      ]);
      const secondMerged = mergeResolvedResults([
        firstMerged,
        dmRes.status === "fulfilled" ? dmRes.value : null,
        acRes.status === "fulfilled" ? acRes.value : null,
      ]);
      if (secondMerged?.url) return secondMerged;
      if (wtRes?.url) return wtRes;
    } else if (mtype === "tv") {
      const [dlRes, dbxRes] = await Promise.allSettled([
        extractDizilife({ title, displayTitle, originalTitle, sourceUrl: src, year, mtype: "tv", s, e }, fetchPublicFn),
        extractDiziboxEpisode({ title, displayTitle, originalTitle, sourceUrl: src, year, s, e }, fetchPublicFn),
      ]);
      const firstMerged = mergeResolvedResults([
        dlRes.status === "fulfilled" ? dlRes.value : null,
        dbxRes.status === "fulfilled" ? dbxRes.value : null,
      ]);
      const hasCleanTv = Boolean(firstMerged?.streams?.some((st) => !isVmpxOrVidmolyUrl(st?.url)));
      if (firstMerged?.url && hasCleanTv) return firstMerged;

      const [dmRes, acRes] = await Promise.allSettled([
        extractDdizimag({ title, displayTitle, originalTitle, sourceUrl: src, year, mtype: "tv", s, e }, fetchPublicFn),
        extractAnimecix({ title, displayTitle, originalTitle, year, mtype: "tv", s, e }, fetchPublicFn),
      ]);
      const secondMerged = mergeResolvedResults([
        firstMerged,
        dmRes.status === "fulfilled" ? dmRes.value : null,
        acRes.status === "fulfilled" ? acRes.value : null,
      ]);
      if (secondMerged?.url) return secondMerged;
    }
  } catch {}
  return null;
}
