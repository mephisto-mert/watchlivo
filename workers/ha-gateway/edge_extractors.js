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
  const mFile = String(rhtml || "").match(/"file"\s*:\s*av\('([^']+)'\)/);
  if (mFile) {
    try {
      const decU = decodeRapidvidToken(mFile[1]);
      if (decU.startsWith("http")) return { url: decU, subs };
    } catch {}
  }
  return { url: "", subs };
}

async function fetchTextSafe(targetUrl, hdrs, fetchPublicFn, timeoutMs = 4500) {
  const { resp } = await fetchPublicFn(targetUrl, hdrs, 4, timeoutMs);
  if (!resp || !resp.ok) {
    resp?.body?.cancel?.();
    return "";
  }
  return await resp.text();
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

function titlesMatchScore(candRaw, reqTitles, reqYear = "") {
  const candClean = String(candRaw || "").replace(/\s+\d+\.\s*Sezon.*$/i, "").trim();
  const candToks = normTitleTokens(candClean);
  if (!candToks.length) return -1;
  let best = -1;
  for (const rt of reqTitles) {
    const rToks = normTitleTokens(String(rt || "").replace(/\(\d{4}\)/g, ""));
    if (!rToks.length) continue;
    const hits = rToks.filter((t) => candToks.includes(t)).length;
    if (hits === 0) continue;
    const minLen = Math.min(rToks.length, candToks.length);
    if (hits < Math.ceil(minLen * 0.65) || (rToks.length >= 2 && hits < 2 && rToks[0] !== candToks[0])) continue;
    let score = (hits / Math.max(rToks.length, candToks.length)) * 100 - Math.abs(candToks.length - rToks.length) * 4;
    if (/(?:part\s*2|part\s*two|bolum\s*2|\b2\b)/i.test(candClean) && !/(?:part\s*2|part\s*two|bolum\s*2|\b2\b)/i.test(String(rt || ""))) {
      score -= 40;
    }
    const ym = candClean.match(/\((\d{4})\)/);
    if (reqYear && ym) {
      const diff = Math.abs(Number(reqYear) - Number(ym[1]));
      if (diff > 2) continue;
      score += diff === 0 ? 15 : 5;
    }
    if (score > best) best = score;
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
    return await r.text();
  } catch {
    return "";
  }
}

async function extractWebteizleMovie({ title, displayTitle, originalTitle, year }, fetchPublicFn) {
  const fullTitles = [];
  const searchQueries = [];
  for (const qRaw of [displayTitle, title, originalTitle]) {
    const clean = String(qRaw || "").replace(/\(\d{4}\)/g, "").trim();
    if (!clean) continue;
    if (!fullTitles.includes(clean)) fullTitles.push(clean);
    if (!searchQueries.includes(clean)) searchQueries.push(clean);
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
      const sc = titlesMatchScore(`${it?.title || ""} ${it?.description || ""}`, fullTitles, year);
      if (sc > bestScore) {
        bestScore = sc;
        pickedPath = u;
      }
    }
    if (bestScore >= 50) break;
  }
  if (!pickedPath) return null;

  const hakkindaHtml = await fetchTextSafe(
    `https://webteizle.info${pickedPath}`,
    { "User-Agent": UA_EDGE, Referer: "https://webteizle.info/" },
    fetchPublicFn,
    4500
  );
  if (!hakkindaHtml) return null;

  const watchLinks = [];
  for (const m of hakkindaHtml.matchAll(/href="(\/izle\/(?:altyazi|dublaj)\/[a-z0-9-]+)"/gi)) {
    if (!watchLinks.includes(m[1])) watchLinks.push(m[1]);
  }
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
    const vmAlt = alts.find((a) => /vidmoly/i.test(String(a?.baslik || "")));
    if (!vmAlt?.id) continue;
    const embRaw = await postWebteizleForm("/ajax/dataEmbed.asp", `id=${vmAlt.id}`, izUrl);
    const vmId =
      embRaw.match(/vidmoly\(\s*['"]([a-z0-9_-]+)['"]/i)?.[1] ||
      embRaw.match(/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+\/(?:embed-|w\/)([a-z0-9_-]+)/i)?.[1];
    if (!vmId) continue;
    const vmRes = await resolveEmbedHtmlToHls(`https://vidmoly.biz/embed-${vmId}.html`, fetchPublicFn);
    if (vmRes?.url && !resolvedStreams.some((x) => x.url === vmRes.url)) {
      const isDub = wl.includes("/dublaj/");
      resolvedStreams.push({
        url: vmRes.url,
        referer: vmRes.referer || "https://vidmoly.biz/",
        label: isDub ? "📡 Webteizle · Türkçe Dublaj (HLS)" : "📡 Webteizle · Türkçe Altyazılı (HLS)",
      });
      if (!primarySubs.length && vmRes.subs?.length) primarySubs = vmRes.subs;
    }
  }
  if (!resolvedStreams.length) return null;
  return {
    url: resolvedStreams[0].url,
    referer: resolvedStreams[0].referer,
    subs: primarySubs,
    streams: resolvedStreams,
    tag: "hls_wt_vm",
  };
}

async function extractDiziboxEpisode({ title, displayTitle, originalTitle, sourceUrl, year, s, e }, fetchPublicFn) {
  const hdrs = { "User-Agent": UA_EDGE, Referer: "https://www.dizibox.live/", "Accept-Language": "tr-TR,tr;q=0.9" };
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

  for (const sl of slugs.slice(0, 3)) {
    const epUrl = `https://www.dizibox.live/${sl}-${s}-sezon-${e}-bolum-izle/`;
    const html = await fetchTextSafe(epUrl, hdrs, fetchPublicFn, 5000);
    if (!html) continue;
    const tM = html.match(/<title>([^<]+)<\/title>/i);
    if (tM && !String(sourceUrl || "").includes("dizibox.")) {
      if (titlesMatchScore(tM[1], reqTitles, year) < 0) continue;
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
      const vmU = mHtml.match(/https?:\/\/(?:vidmoly|vmbox|vmnow|vmpx|vmget)\.[a-z]+\/(?:embed-|w\/)[a-zA-Z0-9_-]+(?:\.html)?/i)?.[0];
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
      const hasVmpx = streams.some((st) => /(?:vmpx\.|\/hls2\/)/i.test(String(st?.url || "")));
      const sheilaIdx = streams.findIndex((st) => /dbx\.molystream\.org/i.test(String(st?.url || "")));
      if (hasVmpx && sheilaIdx > 0) {
        const [sheila] = streams.splice(sheilaIdx, 1);
        streams.unshift(sheila);
      }
    }
    if (streams.length) {
      return { url: streams[0].url, referer: streams[0].referer, subs: [], streams, tag: "hls_dbx_live" };
    }
  }
  return null;
}

export async function resolveTurkishCatalogStream({ title, displayTitle, originalTitle, sourceUrl, year = "", mtype, s, e, fetchPublicFn }) {
  try {
    const src = String(sourceUrl || "").trim();
    if (/dizibox\./i.test(src) && mtype === "tv") {
      const dbxRes = await extractDiziboxEpisode({ title, displayTitle, originalTitle, sourceUrl: src, year, s, e }, fetchPublicFn);
      if (dbxRes?.url) return dbxRes;
    }
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
      if (wtRes?.url) return wtRes;
    } else if (mtype === "tv") {
      const dbxRes = await extractDiziboxEpisode({ title, displayTitle, originalTitle, sourceUrl: src, year, s, e }, fetchPublicFn);
      if (dbxRes?.url) return dbxRes;
    }
  } catch {}
  return null;
}
