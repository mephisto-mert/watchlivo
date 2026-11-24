// Rave VideoPlayerControlsFC Subtitle (selectTextTrack / VTTCue) & Studio Multi-Audio HLS (audioTracks) Engine.
import { applyElementVolume, isIosWebKit, releaseMediaBoost } from './audio-gain.js?v=20261124_v240';

const DEFAULT_PREFS = {
  color: 'white',       // 'white' | 'yellow' | 'cyan' | 'green' | 'pink'
  font: 'sans-serif',   // 'sans-serif' | 'serif' | 'monospace' | 'cursive'
  size: 1.0,            // 0.75 | 0.85 | 1.0 | 1.25 | 1.5
  bgOpacity: 0.65,      // 0 | 0.4 | 0.65 | 0.92
  bottomOffset: 0,      // 0 | 24 | 48
  edgeStyle: 'drop',    // 'outline' | 'drop' | 'none'
  shadow: true,
};

export function getSubPrefs() {
  try {
    const raw = localStorage.getItem('vortex_sub_prefs');
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch (e) {
    return { ...DEFAULT_PREFS };
  }
}

export function setSubPrefs(patch) {
  const next = { ...getSubPrefs(), ...patch };
  try { localStorage.setItem('vortex_sub_prefs', JSON.stringify(next)); } catch (e) { /* ignore */ }
  return next;
}

function parseTimeSec(h, m, s, ms) {
  return (Number(h || 0) * 3600) + (Number(m || 0) * 60) + Number(s || 0) + (Number(ms || 0) / 1000);
}

export function parseVtt(vttText, opts = {}) {
  if (!vttText || typeof vttText !== 'string') return [];
  const lines = vttText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let tsMap = null;
  for (let hi = 0; hi < Math.min(lines.length, 8); hi += 1) {
    const hm = lines[hi].match(/^X-TIMESTAMP-MAP\s*=\s*(.+)$/i);
    if (hm) {
      const mpegM = hm[1].match(/MPEGTS\s*:\s*(\d+)/i);
      const localM = hm[1].match(/LOCAL\s*:\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})/i);
      if (mpegM || localM) {
        const localSec = localM ? parseTimeSec(localM[1], localM[2], localM[3], String(localM[4] || '0').padEnd(3, '0')) : 0;
        tsMap = { mpegts: mpegM ? Number(mpegM[1]) : 0, localSec };
      }
      break;
    }
  }
  const normSubLine = (s) => String(s || '').toLocaleLowerCase('tr').replace(/\u0307/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const subSpamRe = /(?:opensubtitles|osdb\.link|advertise your product|do you want subtitles for any video|çevrimiçi filmleri ve dizileri ücretsiz izleyin|subscene\.com|turkcealtyazi\.org|altyazi\.org|yutukluklar|çeviri\s*:|senkron\s*:|iyi seyirler dileriz|para\s+yat[ıi]rma\s+bonusu|forumiptv\.org|\b1xbet\b|ho[şs]geldin\s+bonusu|canl[ıi]\s+bahis)/i;
  const sdhNoiseRe = /^(?:müzik|şarkı|music|song|alkış|applause|gülüşmeler|kahkaha|laughter|sessizlik|silence|iç çeker|sighs|inler|groans|nefes alır|gasps)$/i;
  const rawCues = [];
  if (vttText.includes('[Events]') || /^Dialogue:\s*\d+,/m.test(vttText)) {
    const assRe = /^Dialogue:\s*[^,]*,(\d+:\d{2}:\d{2}[.,]\d{2,3}),(\d+:\d{2}:\d{2}[.,]\d{2,3}),([^,]*),(?:[^,]*,){5}(.+)$/;
    const parseAssSec = (ts) => {
      const p = ts.replace(',', '.').split(':');
      const sp = (p[2] || '0').split('.');
      const ms = (sp[1] || '0').padEnd(3, '0').slice(0, 3);
      return parseTimeSec(p[0], p[1], sp[0], ms);
    };
    for (const rawLn of lines) {
      const mAss = assRe.exec(rawLn.trim());
      if (mAss) {
        const style = String(mAss[3] || '');
        const rawAssText = String(mAss[4] || '');
        if (/\\p[1-9]\b/i.test(rawAssText) || /(?:^|[_\s-])(?:sign|signs|drawing|rune|fx|karaoke|shape|logo)(?:$|[_\s-]|\d)/i.test(style)) continue;
        const start = parseAssSec(mAss[1]);
        const end = Math.min(parseAssSec(mAss[2]), start + 22.0);
        const body = rawAssText
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/\\[nN]/g, '\n')
          .replace(/\\h/g, ' ')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;|&#x27;/gi, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]*>/g, '')
          .replace(/[<>]/g, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        if (body && end > start) rawCues.push({ start, end, text: body, norm: String(body).toLowerCase().replace(/[^a-z0-9çğıöşüа-яё]+/gi, ' ').trim() });
      }
    }
  } else if (!/-->/.test(vttText) && /^\s*\{\d+\}\{\d+\}/m.test(vttText)) {
    let fps = (Number(opts?.fps) >= 10 && Number(opts?.fps) <= 120) ? Number(opts.fps) : 23.976;
    const microRe = /^\s*\{(\d+)\}\{(\d+)\}(.*)$/;
    for (const rawLn of lines) {
      const mm = microRe.exec(rawLn.trim());
      if (!mm) continue;
      const startFrame = Number(mm[1]);
      const endFrame = Number(mm[2]);
      const bodyRaw = String(mm[3] || '');
      if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) continue;
      if (startFrame <= 1 && endFrame <= 1) {
        const fpsM = bodyRaw.match(/^\s*(\d{2}(?:[.,]\d{1,4})?)\s*$/);
        if (fpsM) {
          const candFps = Number(fpsM[1].replace(',', '.'));
          if (Number.isFinite(candFps) && candFps >= 10 && candFps <= 120) fps = candFps;
          continue;
        }
      }
      if (endFrame <= startFrame) continue;
      const start = startFrame / fps;
      const end = Math.min(endFrame / fps, start + 22.0);
      const joinedBlock = bodyRaw.replace(/\|/g, '\n').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      const rawLines = joinedBlock.split('\n')
        .map((l) => l
          .replace(/\{[a-zA-Z]:[^}]*\}/g, '')
          .replace(/\{[ibuIBU]\}/g, '')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;|&#x27;/gi, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]*>/g, '')
          .replace(/[<>]/g, '')
          .replace(/[♪♫♬♩]+/g, ' ')
          .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/g, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim())
        .filter((l) => l && !sdhNoiseRe.test(l));
      const dedupLines = [];
      const seenLineNorms = new Set();
      for (const rl of rawLines) {
        const nl = normSubLine(rl) || rl.trim();
        if (!nl || seenLineNorms.has(nl)) continue;
        seenLineNorms.add(nl);
        dedupLines.push(rl);
      }
      const clean = dedupLines.join('\n').trim();
      if (clean && end > start && !subSpamRe.test(clean)) {
        rawCues.push({ start, end, text: clean, norm: normSubLine(clean) || clean });
      }
    }
  } else {
  const timeRe = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})/;
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i].trim();
    const m = timeRe.exec(ln);
    if (m) {
      const start = parseTimeSec(m[1], m[2], m[3], String(m[4] || '0').padEnd(3, '0'));
      const rawEnd = parseTimeSec(m[5], m[6], m[7], String(m[8] || '0').padEnd(3, '0'));
      const end = Math.min(rawEnd, start + 22.0);
      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i += 1;
      }
      const joinedBlock = textLines.join('\n').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      const rawLines = joinedBlock.split('\n')
        .filter((l) => !/\\p[1-9]\b/i.test(l))
        .map((l) => l
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;|&#x27;/gi, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]*>/g, '')
          .replace(/[<>]/g, '')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/[♪♫♬♩]+/g, ' ')
          .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/g, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim())
        .filter((l) => l && !sdhNoiseRe.test(l));
      const dedupLines = [];
      const seenLineNorms = new Set();
      for (const rl of rawLines) {
        const nl = normSubLine(rl) || rl.trim();
        if (!nl || seenLineNorms.has(nl)) continue;
        seenLineNorms.add(nl);
        dedupLines.push(rl);
      }
      const clean = dedupLines.join('\n').trim();
      if (clean && end > start && !subSpamRe.test(clean)) {
        rawCues.push({ start, end, text: clean, norm: normSubLine(clean) || clean });
      }
    } else {
      i += 1;
    }
  }
  }
  if (tsMap && tsMap.localSec > 0.2 && rawCues.length && rawCues[0].start >= tsMap.localSec - 0.5) {
    for (const rc of rawCues) {
      rc.start = Math.max(0, rc.start - tsMap.localSec);
      rc.end = Math.max(rc.start + 0.1, rc.end - tsMap.localSec);
    }
  }
  rawCues.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const cues = [];
  let runningMaxEnd = 0;
  for (let k = 0; k < rawCues.length; k += 1) {
    const c = rawCues[k];
    let merged = false;
    for (let j = cues.length - 1; j >= Math.max(0, cues.length - 6); j -= 1) {
      const prev = cues[j];
      if ((Math.abs(prev.start - c.start) < 0.6 || c.start <= prev.end + 0.35) && (prev.norm === c.norm || prev.text === c.text)) {
        prev.end = Math.max(prev.end, c.end);
        runningMaxEnd = Math.max(runningMaxEnd, prev.end);
        prev.maxEnd = runningMaxEnd;
        merged = true;
        break;
      }
    }
    if (merged) continue;
    runningMaxEnd = Math.max(runningMaxEnd, c.end);
    cues.push({ idx: cues.length, start: c.start, end: c.end, maxEnd: runningMaxEnd, text: c.text, norm: c.norm });
  }
  if (tsMap) cues._tsMap = tsMap;
  return cues;
}

const CLIENT_SUB_LANG_MAP = {
  tr: 'tr', tur: 'tr', turkish: 'tr', turkce: 'tr', 'türkçe': 'tr', 'tr-tr': 'tr',
  en: 'en', eng: 'en', english: 'en', ingilizce: 'en', 'en-us': 'en', 'en-gb': 'en',
  de: 'de', deu: 'de', ger: 'de', german: 'de', almanca: 'de',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', 'fransızca': 'fr',
  es: 'es', spa: 'es', spanish: 'es', ispanyolca: 'es',
  pt: 'pt', por: 'pt', pob: 'pt', 'pt-br': 'pt', portuguese: 'pt', portekizce: 'pt',
  it: 'it', ita: 'it', italian: 'it', italyanca: 'it',
  ru: 'ru', rus: 'ru', russian: 'ru', 'rusça': 'ru',
  ar: 'ar', ara: 'ar', arabic: 'ar', 'arapça': 'ar',
  nl: 'nl', nld: 'nl', dut: 'nl', dutch: 'nl', 'felemenkçe': 'nl',
  pl: 'pl', pol: 'pl', polish: 'pl', 'lehçe': 'pl',
  ja: 'ja', jpn: 'ja', japanese: 'ja', japonca: 'ja',
  ko: 'ko', kor: 'ko', korean: 'ko', korece: 'ko',
  zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh', 'çince': 'zh',
  az: 'az', aze: 'az', azerice: 'az',
  sv: 'sv', swe: 'sv', no: 'no', nor: 'no', da: 'da', dan: 'da', fi: 'fi', fin: 'fi',
  el: 'el', ell: 'el', gre: 'el', cs: 'cs', cze: 'cs', ro: 'ro', ron: 'ro', hu: 'hu', hun: 'hu',
  bg: 'bg', bul: 'bg', hr: 'hr', hrv: 'hr', sr: 'sr', srp: 'sr', uk: 'uk', ukr: 'uk',
  fa: 'fa', per: 'fa', hi: 'hi', hin: 'hi', he: 'he', heb: 'he', id: 'id', ind: 'id', vi: 'vi', vie: 'vi',
};

const CLIENT_SUB_LABELS = {
  tr: '🇹🇷 Türkçe', en: '🇬🇧 İngilizce', de: '🇩🇪 Almanca', fr: '🇫🇷 Fransızca',
  es: '🇪🇸 İspanyolca', pt: '🇵🇹 Portekizce', it: '🇮🇹 İtalyanca', ru: '🇷🇺 Rusça',
  ar: '🇸🇦 Arapça', nl: '🇳🇱 Felemenkçe', pl: '🇵🇱 Lehçe', ja: '🇯🇵 Japonca',
  ko: '🇰🇷 Korece', zh: '🇨🇳 Çince', az: '🇦🇿 Azerice', sv: '🇸🇪 İsveççe',
  no: '🇳🇴 Norveççe', da: '🇩🇰 Danca', fi: '🇫🇮 Fince', el: '🇬🇷 Yunanca',
  cs: '🇨🇿 Çekçe', ro: '🇷🇴 Rumence', hu: '🇭🇺 Macarca', bg: '🇧🇬 Bulgarca',
  hr: '🇭🇷 Hırvatça', sr: '🇷🇸 Sırpça', uk: '🇺🇦 Ukraynaca', fa: '🇮🇷 Farsça',
  hi: '🇮🇳 Hintçe', he: '🇮🇱 İbranice', id: '🇮🇩 Endonezce', vi: '🇻🇳 Vietnamca',
};

const STREAM_SUB_SOURCES = new Set(['stream', 'fansub', 'dl_embed', 'sinemacc', 'fhd_embed', 'hfnl_embed', 'diziyou_net', 'diziyou_love', 'dylove', 'filmmodu', 'ddizimag', 'hls_filemoon']);

export function normalizeClientSubLang(rawLang, rawLabel = '') {
  const clean = (v) => String(v || '').replace(/İ/g, 'i').replace(/I/g, 'i').trim().toLowerCase();
  const l = clean(rawLang);
  const lbl = clean(rawLabel);
  if (CLIENT_SUB_LANG_MAP[l]) return CLIENT_SUB_LANG_MAP[l];
  const base = l.split(/[-_\s]/)[0];
  if (CLIENT_SUB_LANG_MAP[base]) return CLIENT_SUB_LANG_MAP[base];
  if (/(?:türk|turk)/i.test(lbl)) return 'tr';
  if (/(?:ingiliz|english|\beng\b)/i.test(lbl)) return 'en';
  return base ? base.slice(0, 6) : 'tr';
}

function isStreamSyncedSub(t) {
  return Boolean(t && (t.synced || STREAM_SUB_SOURCES.has(t.source) || String(t.id || '').startsWith('stream-') || String(t.id || '').includes('-hls')));
}

function buildCleanSubLabel(t, idxInLang, totalInLang) {
  if (t.source === 'local' || t.source === 'youtube-native' || /Şarkı Sözleri/i.test(String(t.label || ''))) {
    return t.label || 'Altyazı';
  }
  const code = normalizeClientSubLang(t.lang, t.label);
  const base = CLIENT_SUB_LABELS[code] || `🌐 ${code.toUpperCase()}`;
  const rawLbl = String(t.label || '').trim();
  const parenM = rawLbl.match(/\(([^)]+)\)\s*$/);
  const existingNote = parenM ? parenM[1].trim() : '';
  const isCleanNote = existingNote && !/^(?:eng|tur|pob|por|fre|spa|ger|ita|rus|ara|nor|swe|cze|hun|hrv|ron|fin|dan|ell|nld|pol)$/i.test(existingNote);
  if (isCleanNote) {
    return `${base} (${existingNote})`;
  }
  if (totalInLang > 1) {
    const tag = isStreamSyncedSub(t) ? `Kaynak ${idxInLang}` : `Seçenek ${idxInLang}`;
    return `${base} (${tag})`;
  }
  if (isStreamSyncedSub(t)) return base;
  return (code === 'tr' || code === 'en') ? `${base} (OpenSubtitles)` : base;
}

const _CL_TR_WORDS = new Set([
  'bir', 'bu', 've', 'de', 'da', 'ne', 'ben', 'sen', 'biz', 'ama', 'için', 'değil', 'var', 'yok',
  'evet', 'hayır', 'gibi', 'daha', 'çok', 'neden', 'burada', 'şimdi', 'tamam', 'şey', 'beni',
  'seni', 'onu', 'bana', 'sana', 'olan', 'olarak', 'nasıl', 'kadar', 'sonra', 'önce', 'bunu',
  'onun', 'benim', 'senin', 'bizim', 'lütfen', 'hadi', 'sadece', 'her', 'hiç', 'bile', 'öyle',
]);
const _CL_EN_WORDS = new Set([
  'the', 'and', 'you', 'that', 'this', 'with', 'what', 'have', 'they', 'from', 'are', 'was',
  'for', 'not', 'but', 'your', 'just', 'know', 'here', 'there', 'she', 'him', 'her', 'about',
  'don', 'can', 'will', 'all', 'one', 'out', 'get', 'who', 'how', 'why', 'now', 'come', 'back',
  'been', 'were', 'would', 'could', 'should', 'their', 'them', 'into', 'then', 'when', 'where',
]);

export function detectCuesLang(cues) {
  if (!Array.isArray(cues) || cues.length < 6) return '';
  const sample = cues.slice(0, 140).map((c) => c.text || '').join(' ').slice(0, 6500);
  const words = sample.toLowerCase().match(/[a-zçğıöşü]+/gi) || [];
  if (words.length < 18) return '';
  let trW = 0;
  let enW = 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i].toLowerCase();
    if (_CL_TR_WORDS.has(w)) trW += 1;
    if (_CL_EN_WORDS.has(w)) enW += 1;
  }
  const trChars = (sample.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length;
  const nonTrExt = (sample.match(/[ñáéíóúãõäëïßàèìòùčřžšěůłńśźżåæø]/gi) || []).length;
  const cyrOrAra = (sample.match(/[\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  if (cyrOrAra > 20 || nonTrExt > trChars * 1.5 + 12) return '';
  if (trW >= 8 && trChars >= 10 && trW >= enW * 2) return 'tr';
  if (enW >= 14 && trChars <= 3 && enW >= trW * 2.5) return 'en';
  return '';
}

function decodeSubtitleArrayBuffer(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sampleLen = Math.min(u8.length, 64);
  let oddZero = 0;
  let evenZero = 0;
  for (let bi = 0; bi + 1 < sampleLen; bi += 2) {
    if (u8[bi] === 0) evenZero += 1;
    if (u8[bi + 1] === 0) oddZero += 1;
  }
  const pairCount = Math.floor(sampleLen / 2);
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  if (pairCount >= 4 && oddZero >= Math.ceil(pairCount * 0.5) && evenZero === 0) return new TextDecoder('utf-16le').decode(u8);
  if (pairCount >= 4 && evenZero >= Math.ceil(pairCount * 0.5) && oddZero === 0) return new TextDecoder('utf-16be').decode(u8);
  const utf8Str = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  const replCount = (utf8Str.match(/\uFFFD/g) || []).length;
  if (replCount === 0) return utf8Str;
  let winStr = utf8Str;
  try { winStr = new TextDecoder('windows-1254', { fatal: false }).decode(u8); } catch (_) {}
  const utf8TrChars = (utf8Str.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length;
  const winMojibake = (winStr.match(/Ä±|Ä°|ÄŸ|Äž|Ã§|Ã‡|Ã¶|Ã–|Ã¼|Ãœ|ÅŸ|Åž/g) || []).length;
  if (utf8TrChars >= 6 && winMojibake >= Math.max(4, replCount * 2)) {
    return utf8Str.replace(/\uFFFD/g, '');
  }
  return winStr;
}

export class SubtitleDubController {
  constructor(adapter) {
    this.adapter = adapter;
    this.media = null;
    this.intro = null;
    this.subtitleTracks = [];
    this.audioTracks = [];
    let savedSub = '';
    let savedAud = '';
    try {
      if (typeof localStorage !== 'undefined') {
        savedSub = localStorage.getItem('vortex_sub_lang') || '';
        savedAud = localStorage.getItem('vortex_audio_lang') || localStorage.getItem('vortex_audio_proxy_pref') || '';
      }
    } catch (e) {}
    this.selectedSubId = savedSub || 'tr';
    this.userAudioPref = /^src-\d+$/.test(savedAud) ? '' : savedAud;
    this.selectedAudioId = this.userAudioPref || 'tr-dub';
    this.offsetSec = 0;
    this.fpsScale = 1.0;
    this.dualSubEnabled = false;
    this.subCues = [];
    this.dubCues = [];
    this.secondaryCues = [];
    this.cuesCache = new Map();
    this.activeCueText = '';
    this.activeSecondaryCueText = '';
    this.blobUrl = null;
    this._autoHealedLang = '';
    this._healingInFlight = false;
    this._emptyReloadCount = 0;
    this._mediaSeq = 0;
    this._loadingSubTrack = false;
    this.ttsDubActive = false;
    this.ttsLang = 'tr';
    try {
      if (localStorage.getItem('vortex_audio_lang') === 'tr-ai-dub') localStorage.removeItem('vortex_audio_lang');
      if (localStorage.getItem('vortex_audio_proxy_pref') === 'tr-ai-dub') localStorage.removeItem('vortex_audio_proxy_pref');
    } catch (e) {}
    this._ttsSpeaking = false;
    this._lastTtsText = '';
    this._ttsAudio = null;
    if (typeof window !== 'undefined') {
      window.__activeSubsController = this;
      try { localStorage.removeItem('vortex_dual_sub'); } catch (e) { /* ignore */ }
      window.__kinoxSyncDuckVolume = () => {
        window.__kinoxHost?._syncDuckRamp?.();
        this.syncVideoVolume();
      };
    }
  }

  _isTrSubId(subId) {
    const raw = String(subId || '').trim().toLowerCase();
    if (!raw || raw === 'off') return false;
    if (raw.startsWith('tr') || /^(?:stream|os|yt|local)-tr\b/.test(raw)) return true;
    const trk = (this.subtitleTracks || []).find((t) => t && t.id === subId);
    return Boolean(trk && normalizeClientSubLang(trk.lang, trk.label) === 'tr');
  }

  _syncStorageKey(media = this.media, trackId = this.selectedSubId) {
    if (!media) return 'vortex_sub_sync:default';
    const idPart = media.tmdbId || media.imdbId || (media.title || 'media').slice(0, 32);
    const trkPart = String(trackId || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 28) || 'default';
    return `vortex_sub_sync:${idPart}:${media.season || 1}:${media.episode || 1}:${trkPart}`;
  }

  _loadMediaSyncPrefs(media, trackId = this.selectedSubId) {
    this.offsetSec = 0;
    this.fpsScale = 1.0;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(this._syncStorageKey(media, trackId)) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(Number(parsed.offsetSec))) {
          const off = Number(parsed.offsetSec);
          if (Number.isFinite(off) && Math.abs(off) <= 120.0) {
            this.offsetSec = off;
          } else {
            this.offsetSec = 0;
            this._saveMediaSyncPrefs(trackId);
          }
        }
        if (Number.isFinite(Number(parsed.fpsScale)) && parsed.fpsScale > 0.85 && parsed.fpsScale < 1.15) {
          this.fpsScale = Number(parsed.fpsScale);
        }
      }
    } catch (e) { /* ignore */ }
  }

  _saveMediaSyncPrefs(trackId = this.selectedSubId) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this._syncStorageKey(this.media, trackId), JSON.stringify({
          offsetSec: this.offsetSec,
          fpsScale: this.fpsScale,
        }));
      }
    } catch (e) { /* ignore */ }
  }

  _detectIntroFromCues(cues = this.subCues) {
    if (!Array.isArray(cues) || !cues.length) return null;
    for (const c of cues) {
      if (c.start > 120) break;
      if (/\[(?:intro|opening|jenerik|açılış)\]/i.test(String(c.text || '')) && c.end > c.start + 15 && c.end <= 150) {
        return { start: Math.max(0, c.start), end: c.end };
      }
    }
    const isNoiseIntro = (txt) => /(?:subtitle|çeviri|senkron|rip|sub|by\b|explosiveskull)/i.test(String(txt || ''));
    const firstDia = cues.find((c) => !isNoiseIntro(c.text)) || cues[0];
    if (cues.length >= 5 && firstDia && firstDia.start >= 30 && firstDia.start <= 65) {
      return { start: 0, end: Math.floor(firstDia.start) };
    }
    return null;
  }

  _rebuildNativeTrackCues() {
    try {
      const v = this.adapter?.video;
      const trEl = this._activeTrackEl || v?.querySelector?.('track[data-watchlivo-pip="1"]') || v?.querySelector?.('track');
      const tt = trEl?.track;
      const CueCls = typeof window !== 'undefined' ? (window.VTTCue || window.TextTrackCue) : null;
      if (!tt || !CueCls) return;
      const prevMode = tt.mode;
      if (tt.mode === 'disabled') tt.mode = 'hidden';
      while (tt.cues && tt.cues.length > 0) {
        tt.removeCue(tt.cues[0]);
      }
      if (!this.subCues.length || this.selectedSubId === 'off') {
        tt.mode = 'hidden';
        return;
      }
      const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
      const off = this.offsetSec || 0;
      for (const c of this.subCues) {
        try {
          if ((c.end + off) <= 0) continue;
          const st = Math.max(0, (c.start + off) / scale);
          const en = Math.max(st + 0.15, (c.end + off) / scale);
          const cue = new CueCls(st, en, c.text);
          if ('line' in cue) { cue.line = -2; cue.snapToLines = true; }
          tt.addCue(cue);
        } catch (_) {}
      }
      tt.mode = this._isNativeSubView(v) ? 'showing' : (prevMode === 'showing' ? 'showing' : 'hidden');
    } catch (_) {}
  }

  setSubtitleOffset(deltaOrVal, absolute = false) {
    const next = absolute ? Number(deltaOrVal || 0) : (this.offsetSec + Number(deltaOrVal || 0));
    this.offsetSec = Math.round(Math.max(-120, Math.min(120, next)) * 10) / 10;
    this._lastFastCueStart = 0;
    this._lastFastCueEnd = 0;
    this._saveMediaSyncPrefs();
    this._rebuildNativeTrackCues();
    this.onTimeUpdate(this.adapter.getTime(), true);
    return this.offsetSec;
  }

  setSubtitleFpsScale(scale = 1.0) {
    const val = Number(scale) || 1.0;
    this.fpsScale = (val > 0.85 && val < 1.15) ? Math.round(val * 1000000) / 1000000 : 1.0;
    this._lastFastCueStart = 0;
    this._lastFastCueEnd = 0;
    this._saveMediaSyncPrefs();
    this._rebuildNativeTrackCues();
    this.onTimeUpdate(this.adapter.getTime(), true);
    return this.fpsScale;
  }

  _getActiveStreamSource(urlOverride = '') {
    const targetUrl = String(urlOverride || this.adapter?.currentUrl || this.media?.url || '').trim();
    const normCmp = (s) => {
      const str = String(s || '').trim();
      if (!str) return '';
      try {
        const uo = new URL(str, typeof location !== 'undefined' ? location.origin : 'https://watchlivo.online');
        uo.searchParams.delete('aud');
        uo.searchParams.delete('proxy_segs');
        uo.searchParams.delete('max_h');
        uo.searchParams.delete('abr_low');
        return `${uo.pathname}${uo.search}`;
      } catch (_) {
        return str.replace(/([?&])(aud|proxy_segs|max_h|abr_low)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
      }
    };
    const inferFromMeta = (obj, fallbackUrl = '') => {
      const explicit = String(obj?.source || '').trim().toLowerCase();
      if (explicit) return explicit;
      const txt = `${obj?.label || ''} ${fallbackUrl || obj?.url || ''}`.toLowerCase();
      if (txt.includes('dizilife') || txt.includes('makesomthingup') || txt.includes('centralodsseyproud')) return 'dl_embed';
      if (txt.includes('diziyounet') || txt.includes('ksdpictures') || txt.includes('yabancidizim')) return 'diziyou_net';
      if (/diziyou\s*·/.test(txt) || txt.includes('diziyou.love')) return 'diziyou_love';
      if (txt.includes('sinemacc') || txt.includes('filmizle.in')) return 'sinemacc';
      if (txt.includes('fullhd') || txt.includes('rapidvid')) return 'fhd_embed';
      if (txt.includes('hdfc') || txt.includes('hdfilmcehennemi')) return 'hfnl_embed';
      if (txt.includes('filmmodu')) return 'filmmodu';
      if (txt.includes('dizimag') || txt.includes('ddizimag')) return 'ddizimag';
      if (txt.includes('webteizle') || txt.includes('filemoon')) return 'hls_filemoon';
      return '';
    };
    const targetNorm = normCmp(targetUrl);
    const srvs = Array.isArray(this.media?.servers) ? this.media.servers : [];
    if (targetNorm) {
      const matchedSrv = srvs.find((s) => s?.url && normCmp(s.url) === targetNorm);
      if (matchedSrv) {
        const src = inferFromMeta(matchedSrv, targetUrl);
        if (src) return src;
      }
      const matchedAud = (Array.isArray(this.audioTracks) ? this.audioTracks : []).find((a) => a?.url && normCmp(a.url) === targetNorm);
      if (matchedAud) {
        const src = inferFromMeta(matchedAud, targetUrl);
        if (src) return src;
      }
    }
    const direct = inferFromMeta(null, targetUrl);
    if (direct) return direct;
    if (srvs.length) return inferFromMeta(srvs[0], srvs[0].url);
    return '';
  }

  resolveInitialAudioTrack(media) {
    const rawFromMedia = Array.isArray(media?.audioTracks) ? media.audioTracks.filter(Boolean) : [];
    const rawAudio = rawFromMedia.length
      ? rawFromMedia
      : (typeof this._deriveAudioTracksFromServers === 'function' ? this._deriveAudioTracksFromServers(media, media?.url || '') : []);
    if (!rawAudio.length) return null;
    let pref = '';
    try {
      pref = localStorage.getItem('vortex_audio_lang') || localStorage.getItem('vortex_audio_proxy_pref') || this.userAudioPref || '';
    } catch (e) { pref = this.userAudioPref || ''; }
    if (/^src-\d+$/.test(pref)) pref = '';
    this.userAudioPref = pref;
    const isTrStudio = (t) => t && t.mode !== 'tts' && t.id !== 'tr-ai-dub' && (
      t.id === 'tr-dub' || String(t.id || '').startsWith('tr-dub-') || t.id === 'tr-orig'
      || t.audioLang === 'tr' || t.lang === 'tr' || t.targetLang === 'tr'
    );
    const studioTr = rawAudio.find((t) => isTrStudio(t) && (t.url || typeof t.hlsIndex === 'number' || typeof t.nativeIndex === 'number'));
    if (!pref || pref === 'tr-dub' || pref === 'tr' || String(pref).startsWith('tr-dub-')) {
      if (studioTr) {
        this.selectedAudioId = studioTr.id;
        return studioTr;
      }
      const origFallback = rawAudio.find((t) => t.mode === 'stream' && (t.id === 'orig' || t.lang === 'orig')) || rawAudio.find((t) => t.mode === 'stream') || rawAudio[0];
      this.selectedAudioId = origFallback?.id || 'orig';
      return origFallback || null;
    }
    if (pref === 'tr-ai-dub') {
      const isAnime = this.media?.provider === 'anime' || this.media?.origLang === 'ja' || this.media?.type === 'anime';
      if (!isAnime || studioTr) {
        pref = '';
        try { localStorage.removeItem('vortex_audio_lang'); } catch (e) {}
      } else {
        const aiTrack = rawAudio.find((t) => t.id === 'tr-ai-dub' || t.mode === 'tts');
        if (aiTrack) {
          this.selectedAudioId = aiTrack.id;
          return rawAudio.find((t) => t.mode === 'stream') || aiTrack;
        }
      }
    }
    const exact = rawAudio.find((t) => t.id === pref || t.targetLang === pref || t.lang === pref || t.audioLang === pref);
    if (exact) {
      this.selectedAudioId = exact.id;
      return exact.mode === 'stream' ? exact : (rawAudio.find((t) => t.mode === 'stream') || exact);
    }
    const fallback = studioTr || rawAudio.find((t) => t.mode === 'stream') || rawAudio[0];
    this.selectedAudioId = fallback?.id || 'orig';
    return fallback || null;
  }

  onStreamFallbackUrl(nextUrl) {
    const u = String(nextUrl || '');
    if (!u) return;
    const prevSource = this._activeStreamSource || '';
    const nextSource = this._getActiveStreamSource(u);
    this._activeStreamSource = nextSource;
    if (nextSource && nextSource !== prevSource && Array.isArray(this.subtitleTracks) && this.subtitleTracks.length) {
      const curSub = this.subtitleTracks.find((t) => t.id === this.selectedSubId) || null;
      const curLang = curSub ? normalizeClientSubLang(curSub.lang, curSub.label) : '';
      this.subtitleTracks = this._dedupeSubtitleTrackIds(this.subtitleTracks);
      if (this.media) this.media.subtitleTracks = this.subtitleTracks;
      if (curSub && curSub.source !== 'local' && curSub.source !== 'youtube-native' && this.selectedSubId !== 'off' && curSub.source !== nextSource) {
        const matchedNextSub = this.subtitleTracks.find((t) => t.source === nextSource && normalizeClientSubLang(t.lang, t.label) === curLang);
        if (matchedNextSub && matchedNextSub.id !== this.selectedSubId) {
          this.setSubtitleTrack(matchedNextSub.id, true).catch(() => {});
        }
      }
    }
    if (!Array.isArray(this.audioTracks) || !this.audioTracks.length) return;
    const norm = (s) => {
      const str = String(s || '').trim();
      if (!str) return '';
      try {
        const uo = new URL(str, typeof location !== 'undefined' ? location.origin : 'https://watchlivo.online');
        uo.searchParams.delete('proxy_segs');
        uo.searchParams.delete('max_h');
        uo.searchParams.delete('abr_low');
        return `${uo.pathname}${uo.search}`;
      } catch (_) {
        return str.replace(/([?&])(proxy_segs|max_h|abr_low)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
      }
    };
    const uClean = norm(u);
    const nextAudParam = (uClean.match(/[?&]aud=([^&]+)/i)?.[1] || '').toLowerCase();
    const curTrack = this.audioTracks.find((t) => t.id === this.selectedAudioId);
    const wasTrStudio = Boolean(curTrack && curTrack.mode !== 'tts' && (curTrack.id === 'tr-dub' || String(curTrack.id || '').startsWith('tr-dub-') || curTrack.audioLang === 'tr' || curTrack.lang === 'tr'));
    const cleanAud = (s) => norm(s).replace(/([?&])aud=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
    const matchedTrack = this.audioTracks.find((t) => t.mode === 'stream' && t.url && norm(t.url) === uClean)
      || this.audioTracks.find((t) => {
        if (t.mode !== 'stream' || !t.url || cleanAud(t.url) !== cleanAud(uClean)) return false;
        const tAud = (norm(t.url).match(/[?&]aud=([^&]+)/i)?.[1] || '').toLowerCase();
        if (nextAudParam && tAud && tAud !== nextAudParam) return false;
        if (nextAudParam === 'tr') return t.id === 'tr-dub' || String(t.id || '').startsWith('tr-dub-') || t.audioLang === 'tr' || t.lang === 'tr';
        if (nextAudParam === 'orig') return t.id === 'orig' || String(t.id || '').startsWith('orig-') || (t.audioLang && t.audioLang !== 'tr');
        return true;
      });
    if (matchedTrack && matchedTrack.id !== this.selectedAudioId && this.selectedAudioId !== 'tr-ai-dub') {
      if (wasTrStudio && (matchedTrack.id === 'orig' || String(matchedTrack.id || '').startsWith('orig-'))) {
        const studioTr = this.audioTracks.find((t) => (t.id === 'tr-dub' || String(t.id || '').startsWith('tr-dub-') || t.audioLang === 'tr') && (typeof t.hlsIndex === 'number' || typeof t.nativeIndex === 'number'));
        if (studioTr) {
          this.selectedAudioId = studioTr.id;
          this._applyHlsAudioSelection();
          this.adapter?.events?.onTracksChanged?.();
          return;
        }
      }
      this.selectedAudioId = matchedTrack.id;
      const nowOrig = matchedTrack.id === 'orig' || String(matchedTrack.id || '').startsWith('orig-') || (matchedTrack.audioLang && matchedTrack.audioLang !== 'tr');
      let savedSub = '';
      try { savedSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (_) {}
      if (wasTrStudio && nowOrig && savedSub !== 'off' && this.media?.origLang !== 'tr' && (!this.selectedSubId || this.selectedSubId === 'off')) {
        const trSub = this.subtitleTracks.find((t) => normalizeClientSubLang(t.lang, t.label) === 'tr' || String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
        if (trSub) this.setSubtitleTrack(trSub.id, true).catch(() => {});
      }
      this.adapter?.events?.onTracksChanged?.();
      return;
    }
    if (!wasTrStudio && /[?&]aud=tr\b/i.test(uClean) && this.selectedAudioId !== 'tr-ai-dub') {
      const trT = this.audioTracks.find((t) => t.id === 'tr-dub' || String(t.id || '').startsWith('tr-dub-') || (t.mode === 'stream' && (t.audioLang === 'tr' || t.lang === 'tr')));
      if (trT) {
        this.selectedAudioId = trT.id;
        let savedSub = '';
        try { savedSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (_) {}
        if ((!savedSub || savedSub === 'tr') && this._isTrSubId(this.selectedSubId)) {
          if (!savedSub) this._prevSubBeforeDub = this.selectedSubId;
          this.setSubtitleTrack('off', true).catch(() => {});
        }
        this.adapter?.events?.onTracksChanged?.();
        return;
      }
    }
    if (wasTrStudio && !/[?&]aud=tr\b/i.test(uClean) && (/[?&]aud=orig\b/i.test(uClean) || /hakunaymatata\.com|dragonballzfans\.xyz|vidy\.st|lightspeed\.st/i.test(uClean))) {
      const origT = this.audioTracks.find((t) => t.id === 'orig' || String(t.id || '').startsWith('orig-'));
      if (origT) this.selectedAudioId = origT.id;
      let savedSub = '';
      try { savedSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (_) {}
      if (savedSub !== 'off' && this.media?.origLang !== 'tr' && (!this.selectedSubId || this.selectedSubId === 'off')) {
        const trSub = this.subtitleTracks.find((t) => normalizeClientSubLang(t.lang, t.label) === 'tr' || String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
        if (trSub) this.setSubtitleTrack(trSub.id, true).catch(() => {});
      }
      this.adapter?.events?.onTracksChanged?.();
    }
  }

  _dedupeSubtitleTrackIds(tracks) {
    const seenUrls = new Set();
    const normalized = [];
    const normSubUrlKey = (u) => {
      const s = String(u || '').trim();
      if (!s) return '';
      if (s.includes('/api/rave/subtitle.vtt')) {
        try {
          const uo = new URL(s, typeof location !== 'undefined' ? location.origin : 'https://watchlivo.online');
          const inner = uo.searchParams.get('url');
          if (inner) return inner.trim();
        } catch (_) {}
      }
      return s;
    };
    for (const raw of (Array.isArray(tracks) ? tracks : [])) {
      if (!raw || (!raw.url && raw.source !== 'youtube-native')) continue;
      const uk = normSubUrlKey(raw.url);
      if (uk && seenUrls.has(uk)) continue;
      if (uk) seenUrls.add(uk);
      const lang = raw.source === 'local' ? (raw.lang || 'tr') : normalizeClientSubLang(raw.lang, raw.label);
      normalized.push({ ...raw, lang });
    }
    const activeSrc = this._getActiveStreamSource?.() || '';
    const rankTrack = (t) => {
      if (t.source === 'local') return 0;
      const syncedRank = (activeSrc && t.source === activeSrc) ? 0 : (isStreamSyncedSub(t) ? 1 : 2);
      if (t.lang === 'tr') return 10 + syncedRank;
      if (t.lang === 'en') return 20 + syncedRank;
      return 30 + syncedRank;
    };
    normalized.sort((a, b) => rankTrack(a) - rankTrack(b));

    const capped = [];
    const langUsed = {};
    let otherLangs = 0;
    for (const t of normalized) {
      if (t.source === 'local' || t.source === 'youtube-native') {
        capped.push(t);
        continue;
      }
      const cap = t.lang === 'tr' ? 5 : (t.lang === 'en' ? 3 : 1);
      const cur = langUsed[t.lang] || 0;
      if (cur >= cap) continue;
      if (t.lang !== 'tr' && t.lang !== 'en') {
        if (otherLangs >= 6) continue;
        otherLangs += 1;
      }
      langUsed[t.lang] = cur + 1;
      capped.push(t);
    }

    const totalByLang = {};
    for (const t of capped) {
      if (t.source !== 'local') totalByLang[t.lang] = (totalByLang[t.lang] || 0) + 1;
    }
    const idxByLang = {};
    const seenIds = new Set();
    const seenLabels = new Map();
    const out = [];
    for (const t of capped) {
      const idxInLang = t.source === 'local' ? 1 : ((idxByLang[t.lang] = (idxByLang[t.lang] || 0) + 1));
      const totalInLang = totalByLang[t.lang] || 1;
      const baseId = String(t.id || t.lang || 'sub').trim() || 'sub';
      let nextId = baseId;
      let suffixN = 2;
      while (seenIds.has(nextId)) {
        nextId = `${baseId}-${suffixN}`;
        suffixN += 1;
      }
      seenIds.add(nextId);
      let label = buildCleanSubLabel(t, idxInLang, totalInLang);
      const lblCount = (seenLabels.get(label) || 0) + 1;
      seenLabels.set(label, lblCount);
      if (lblCount > 1) label = `${label} #${lblCount}`;
      out.push({ ...t, id: nextId, label });
    }
    return out;
  }

  _deriveAudioTracksFromServers(media, baseUrl) {
    const srvs = Array.isArray(media?.servers) ? media.servers.filter((s) => s && s.url) : [];
    const origCode = String(media?.origLang || 'orig').trim().toLowerCase() || 'orig';
    const isDual = (s) => {
      const langs = Array.isArray(s.audioLangs) ? s.audioLangs : [];
      return (langs.includes('tr') && langs.some((l) => l && l !== 'tr')) || /dublaj\s*\+\s*orijinal|çoklu\s*ses/i.test(String(s.label || ''));
    };
    const isTrOnly = (s) => {
      const langs = Array.isArray(s.audioLangs) ? s.audioLangs : [];
      if (langs.length) return langs.includes('tr') && !langs.some((l) => l !== 'tr');
      return /türkçe\s*dublaj|tr\s*dublaj/i.test(String(s.label || '')) && !/orijinal|altyaz/i.test(String(s.label || ''));
    };
    const isOrigOnly = (s) => {
      const langs = Array.isArray(s.audioLangs) ? s.audioLangs : [];
      if (langs.length) return !langs.includes('tr') && langs.some(Boolean);
      return /altyaz|orijinal/i.test(String(s.label || '')) && !/dublaj/i.test(String(s.label || ''));
    };
    const withAud = (u, aud) => {
      const str = String(u || '');
      if (!str.includes('/api/rave/stream')) return str;
      const cleaned = str.replace(/([?&])aud=[^&]*/gi, (_, sep) => (sep === '?' ? '?' : '')).replace(/\?&/, '?').replace(/[?&]$/, '');
      return cleaned.includes('&ext=.m3u8') ? cleaned.replace('&ext=.m3u8', `&aud=${aud}&ext=.m3u8`) : `${cleaned}${cleaned.includes('?') ? '&' : '?'}aud=${aud}`;
    };
    const dual = srvs.find(isDual);
    if (dual) {
      return [
        { id: 'tr-dub', lang: 'tr', targetLang: 'tr', audioLang: 'tr', label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)', mode: 'stream', url: withAud(dual.url, 'tr') },
        { id: 'orig', lang: 'orig', targetLang: 'orig', audioLang: origCode, label: origCode === 'en' ? '🇬🇧 İngilizce (Orijinal Ses · 1080p)' : '🎬 Orijinal Ses (1080p HD)', mode: 'stream', url: withAud(dual.url, 'orig') },
      ];
    }
    const trSrv = srvs.find(isTrOnly);
    const origSrv = srvs.find(isOrigOnly);
    if (trSrv && origSrv) {
      return [
        { id: 'tr-dub', lang: 'tr', targetLang: 'tr', audioLang: 'tr', label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)', mode: 'stream', url: trSrv.url },
        { id: 'orig', lang: 'orig', targetLang: 'orig', audioLang: origCode, label: origCode === 'en' ? '🇬🇧 İngilizce (Orijinal Ses · 1080p)' : '🎬 Orijinal Ses (1080p HD)', mode: 'stream', url: origSrv.url },
      ];
    }
    if (trSrv && !origSrv) {
      return [{ id: 'tr-dub', lang: 'tr', targetLang: 'tr', audioLang: 'tr', label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)', mode: 'stream', url: trSrv.url }];
    }
    return [{ id: 'orig', lang: 'orig', targetLang: 'orig', audioLang: origCode, label: origCode === 'en' ? '🇬🇧 İngilizce (Orijinal Ses · 1080p)' : '🎬 Orijinal Ses (1080p HD)', mode: 'stream', url: baseUrl || origSrv?.url || '' }];
  }

  resetStreamAudioBindings() {
    this._clearAudioSwitchWatch?.();
    if (!Array.isArray(this.audioTracks)) return;
    this.audioTracks = this.audioTracks
      .filter((t) => t && t.mode !== 'hls' && t.mode !== 'native')
      .map((t) => {
        const copy = { ...t };
        delete copy.hlsIndex;
        delete copy.nativeIndex;
        return copy;
      });
  }

  async initForMedia(media, opts = {}) {
    this._clearAudioSwitchWatch?.();
    const seq = (this._mediaSeq = (this._mediaSeq || 0) + 1);
    this._skipInitStreamSwitch = Boolean(opts?.skipInitialStreamSwitch);
    this._userPickedAudioForMedia = false;
    const prevKey = this.media ? `${this.media.tmdbId || ''}|${this.media.imdbId || ''}|${this.media.videoId || ''}|${this.media.season || 0}|${this.media.episode || 0}` : '';
    const nextKey = media ? `${media.tmdbId || ''}|${media.imdbId || ''}|${media.videoId || ''}|${media.season || 0}|${media.episode || 0}` : '';
    const preservedLocals = (prevKey && prevKey === nextKey && Array.isArray(this.subtitleTracks))
      ? this.subtitleTracks.filter((t) => t?.source === 'local')
      : [];
    this.media = media;
    this.intro = null;
    this.subCues = [];
    this.dubCues = [];
    this.secondaryCues = [];
    this.activeCueText = '';
    this.activeSecondaryCueText = '';
    this._autoHealedLang = '';
    this._healingInFlight = false;
    this._emptyReloadCount = 0;
    this._userPickedSubForMedia = false;
    this._durationValidatedForMedia = false;
    this._activeStreamSource = this._getActiveStreamSource(media?.url || '');
    this._loadMediaSyncPrefs(media);
    const rawSubs = Array.isArray(media.subtitleTracks) ? [...preservedLocals, ...media.subtitleTracks] : [...preservedLocals];
    this.subtitleTracks = this._dedupeSubtitleTrackIds(rawSubs);
    if (this.media) this.media.subtitleTracks = this.subtitleTracks;
    const baseUrl = media.url || '';
    const rawAudio = Array.isArray(media.audioTracks) ? media.audioTracks.filter(Boolean) : [];
    this.audioTracks = rawAudio.length
      ? [...rawAudio]
      : this._deriveAudioTracksFromServers(media, baseUrl);
    if (this.media && !rawAudio.length && this.audioTracks.length) {
      this.media.audioTracks = this.audioTracks;
    }
    const trSubCount = this.subtitleTracks.filter((t) => t.lang === 'tr').length;
    const hasEnSub = this.subtitleTracks.some((t) => t.lang === 'en');
    const hasInitialAudio = this.audioTracks.length > 1;
    const rawTidExtracted = /^\d+$/.test(String(media.tmdbId || '').trim())
      ? String(media.tmdbId).trim()
      : (String(media.id || '').match(/^(?:tmdb-(?:tv|movie)-)?(\d+)$/i)?.[1] || '');
    const titleEpM = String(media.title || '').match(/S(\d+)\s*:\s*B(\d+)|(\d+)\.\s*Sezon\s*(\d+)\.\s*Bölüm/i);
    const effSeason = Number(media.season || titleEpM?.[1] || titleEpM?.[3] || 1) || 1;
    const effEpisode = Number(media.episode || titleEpM?.[2] || titleEpM?.[4] || 1) || 1;
    const effMediaType = (media.mediaType === 'tv' || titleEpM || /^tmdb-tv-/i.test(String(media.id || ''))) ? 'tv' : (media.mediaType || 'movie');
    const needsSubFetch = (trSubCount < 2 || !hasEnSub || !hasInitialAudio) && Boolean(rawTidExtracted || media.imdbId || media.videoId || media.provider === 'youtube' || media.title);
    if (needsSubFetch) {
      const queryParams = {
        tmdbId: rawTidExtracted,
        imdbId: media.imdbId || '',
        videoId: media.videoId || '',
        mediaType: effMediaType,
        provider: media.catalogProvider || media.provider || 'netflix',
        title: String(media.seriesTitle || media.title || '').split(' — ')[0].trim(),
        season: String(effSeason),
        episode: String(effEpisode),
        duration: String(Math.round(Number(this.adapter?.getDuration?.() || media.duration || 0)) || ''),
        _v: '20261124v240',
      };
      if (!rawTidExtracted && baseUrl) queryParams.url = baseUrl;
      const qs = new URLSearchParams(queryParams);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const ctrl = new AbortController();
          const tId = setTimeout(() => ctrl.abort(), attempt === 0 ? 6500 : 5500);
          const r = await fetch(`/api/rave/subtitles?${qs}${attempt === 1 ? '&refresh=1' : ''}`, { signal: ctrl.signal });
          clearTimeout(tId);
          if (this._destroyed || this._mediaSeq !== seq) return;
          if (r.ok) {
            const data = await r.json();
            if (this._destroyed || this._mediaSeq !== seq) return;
            if (Array.isArray(data.subtitleTracks) && data.subtitleTracks.length) {
              const existing = Array.isArray(this.subtitleTracks) ? this.subtitleTracks : [];
              this.subtitleTracks = this._dedupeSubtitleTrackIds([...existing, ...data.subtitleTracks]);
              if (this.media) this.media.subtitleTracks = this.subtitleTracks;
            }
            if (Array.isArray(data.audioTracks) && data.audioTracks.length && !hasInitialAudio) {
              const seenAudIds = new Set();
              this.audioTracks = data.audioTracks.filter((at) => {
                if (!at || !at.id || seenAudIds.has(at.id)) return false;
                seenAudIds.add(at.id);
                return true;
              });
              if (this.media) this.media.audioTracks = this.audioTracks;
              if (this.adapter?.hls?.audioTracks?.length > 1) {
                this.mergeHlsAudioTracks(this.adapter.hls.audioTracks);
              } else if (this.adapter?.video?.audioTracks?.length > 1) {
                this.mergeNativeAudioTracks(this.adapter.video.audioTracks);
              }
            }
            if (data.intro && !this.intro) {
              this.intro = data.intro;
            }
            if (this.subtitleTracks.length > 0) break;
          }
        } catch (e) { /* retry once on timeout/network hiccup */ }
      }
    }
    if (!this.subtitleTracks.length) {
      this.selectedSubId = 'off';
    }
    this.resolveInitialAudioTrack({ ...(media || {}), audioTracks: this.audioTracks });
    const initAudTrack = this.audioTracks.find((t) => t.id === this.selectedAudioId)
      || this.audioTracks.find((t) => (t.targetLang || t.lang) === this.selectedAudioId)
      || this.audioTracks[0];
    const cleanU = (u) => String(u || '').replace(/&proxy_segs=1/g, '').replace(/[?&](?:max_h|abr_low)=[^&]*/g, '');
    const initUrlMatchesActive = !initAudTrack?.url || !this.adapter?.currentUrl || cleanU(initAudTrack.url) === cleanU(this.adapter.currentUrl);
    const hasVerifiedTrStream = Boolean(
      initAudTrack && (
        initAudTrack.id === 'tr-orig'
        || ((initAudTrack.id === 'tr-dub' || initAudTrack.audioLang === 'tr' || initAudTrack.lang === 'tr')
            && (typeof initAudTrack.hlsIndex === 'number' || typeof initAudTrack.nativeIndex === 'number' || (initAudTrack.url && (!this._skipInitStreamSwitch || initUrlMatchesActive))))
        || (media?.origLang === 'tr' && (!this.selectedAudioId || this.selectedAudioId === 'orig'))
        || (Array.isArray(media?.platformAudioLangs) && media.platformAudioLangs.length === 1 && media.platformAudioLangs[0] === 'tr')
      )
    );
    let savedExplicitSub = '';
    try { savedExplicitSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (e) { /* ignore */ }
    if (savedExplicitSub === 'off') {
      this.selectedSubId = 'off';
    } else if (hasVerifiedTrStream && (!savedExplicitSub || savedExplicitSub === 'tr') && this._isTrSubId(this.selectedSubId)) {
      if (!savedExplicitSub) this._prevSubBeforeDub = this.selectedSubId;
      this.selectedSubId = 'off';
    } else if (!hasVerifiedTrStream && savedExplicitSub !== 'off' && media?.origLang !== 'tr' && (!this.selectedSubId || this.selectedSubId === 'off')) {
      const autoTrSub = this.subtitleTracks.find((t) => normalizeClientSubLang(t.lang, t.label) === 'tr' || String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
      if (autoTrSub) this.selectedSubId = autoTrSub.id;
    }
    await this.setSubtitleTrack(this.selectedSubId, true);
    if (this._destroyed || this._mediaSeq !== seq) return;
    await this.setAudioTrack(this.selectedAudioId, true);
    if (this._destroyed || this._mediaSeq !== seq) return;
    this.adapter.events.onTracksChanged?.();
  }

  mergeHlsAudioTracks(hlsTracks) {
    if (!Array.isArray(hlsTracks) || hlsTracks.length <= 1) return;
    const hls = this.adapter?.hls;
    const lvlIdx = (hls && Array.isArray(hls.levels) && hls.levels.length)
      ? (hls.currentLevel >= 0 ? hls.currentLevel : (hls.loadLevel >= 0 ? hls.loadLevel : (hls.nextLevel >= 0 ? hls.nextLevel : 0)))
      : -1;
    const curLevelObj = (hls && Array.isArray(hls.levels) && lvlIdx >= 0) ? hls.levels[lvlIdx] : null;
    const activeGroupId = curLevelObj?.audioGroupId || hlsTracks[0]?.groupId || '';
    const normAudKey = (rawLang, rawName) => {
      const info = `${rawLang || ''} ${rawName || ''}`.replace(/İ/g, 'i').replace(/I/g, 'i').trim().toLowerCase();
      if (/(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe|dublaj)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'tr';
      if (/(?:^|[^\p{L}\p{N}])(en|eng|english|ingilizce)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'en';
      if (/(?:^|[^\p{L}\p{N}])(de|deu|ger|german|almanca)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'de';
      if (/(?:^|[^\p{L}\p{N}])(fr|fra|fre|french|fransızca)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'fr';
      if (/(?:^|[^\p{L}\p{N}])(es|spa|spanish|ispanyolca)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'es';
      if (/(?:^|[^\p{L}\p{N}])(it|ita|italian|italyanca)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'it';
      if (/(?:^|[^\p{L}\p{N}])(ja|jpn|japanese|japonca)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'ja';
      if (/(?:^|[^\p{L}\p{N}])(ko|kor|korean|korece)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'ko';
      const base = String(rawLang || '').replace(/İ/g, 'i').replace(/I/g, 'i').trim().toLowerCase().split(/[-_]/)[0];
      return (base && base !== 'und') ? base : 'orig';
    };
    const AUD_LABELS = {
      en: '🇬🇧 İngilizce (Orijinal Ses · 1080p)',
      de: '🇩🇪 Almanca (Orijinal Ses)',
      fr: '🇫🇷 Fransızca (Orijinal Ses)',
      es: '🇪🇸 İspanyolca (Orijinal Ses)',
      it: '🇮🇹 İtalyanca',
      ja: '🇯🇵 Japonca (Orijinal Ses)',
      ko: '🇰🇷 Korece (Orijinal Ses)',
      ru: '🇷🇺 Rusça',
    };

    // Deduplicate across multi-group HLS manifests (e.g. Game of Thrones 'audio' + 'audio-lo')
    const pickedByLang = new Map();
    hlsTracks.forEach((ht, idx) => {
      const code = normAudKey(ht?.lang, ht?.name);
      const inActiveGroup = Boolean(activeGroupId && ht?.groupId === activeGroupId);
      const existing = pickedByLang.get(code);
      if (!existing || (inActiveGroup && !existing.inActiveGroup)) {
        pickedByLang.set(code, { ht, idx, code, inActiveGroup });
      }
    });

    const preferredOrigCode = String(this.media?.origLang || '').trim().toLowerCase();
    const nonTrEntries = [...pickedByLang.values()].filter((e) => e.code !== 'tr');
    nonTrEntries.sort((a, b) => {
      const aPref = (preferredOrigCode && a.code === preferredOrigCode) ? 0 : (a.code === 'en' ? 1 : (a.code === 'orig' ? 2 : 3));
      const bPref = (preferredOrigCode && b.code === preferredOrigCode) ? 0 : (b.code === 'en' ? 1 : (b.code === 'orig' ? 2 : 3));
      return aPref - bPref;
    });

    const trEntry = pickedByLang.get('tr');
    let addedNewTr = false;
    if (trEntry) {
      const exTr = this.audioTracks.find((t) => t.id === 'tr-dub' || (t.audioLang || t.targetLang || t.lang) === 'tr');
      if (exTr) {
        exTr.hlsIndex = trEntry.idx;
      } else {
        addedNewTr = true;
        this.audioTracks.unshift({
          id: 'tr-dub',
          hlsIndex: trEntry.idx,
          lang: 'tr',
          targetLang: 'tr',
          audioLang: 'tr',
          label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)',
          mode: 'hls',
        });
      }
    }

    nonTrEntries.forEach((entry, nIdx) => {
      const { ht, idx, code } = entry;
      const rawName = String(ht?.name || '').trim();
      const niceLabel = AUD_LABELS[code] || (rawName ? `🎬 ${rawName} (Orijinal Ses)` : '🎬 Orijinal Ses (1080p HD)');
      if (nIdx === 0) {
        const exOrig = this.audioTracks.find((t) => t.id === 'orig');
        if (exOrig) {
          exOrig.hlsIndex = idx;
          exOrig.audioLang = code;
          if (AUD_LABELS[code]) exOrig.label = niceLabel;
        } else {
          this.audioTracks.push({
            id: 'orig',
            hlsIndex: idx,
            lang: 'orig',
            targetLang: 'orig',
            audioLang: code,
            label: niceLabel,
            mode: 'hls',
          });
        }
      } else {
        const extraId = `orig-${code}`;
        const exExtra = this.audioTracks.find((t) => t.id === extraId || t.audioLang === code);
        if (exExtra) {
          exExtra.hlsIndex = idx;
        } else {
          this.audioTracks.push({
            id: extraId,
            hlsIndex: idx,
            lang: code,
            targetLang: code,
            audioLang: code,
            label: AUD_LABELS[code] || `🌐 ${rawName || code.toUpperCase()}`,
            mode: 'hls',
          });
        }
      }
    });

    if (!this._userPickedAudioForMedia && (addedNewTr || trEntry)) {
      const prevAud = this.selectedAudioId;
      this.resolveInitialAudioTrack({ ...(this.media || {}), audioTracks: this.audioTracks });
      if (prevAud !== this.selectedAudioId && this.selectedAudioId === 'tr-dub') {
        let savedSub = '';
        try { savedSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (_) {}
        if ((!savedSub || savedSub === 'tr') && this._isTrSubId(this.selectedSubId)) {
          if (!savedSub) this._prevSubBeforeDub = this.selectedSubId;
          this.setSubtitleTrack('off', true).catch(() => {});
        }
      }
    }
    this._applyHlsAudioSelection(false);
    this.adapter.events.onTracksChanged?.();
  }

  mergeNativeAudioTracks(nativeTracks) {
    if (!nativeTracks || nativeTracks.length <= 1) return;
    const normAudKey = (rawLang, rawName) => {
      const info = `${rawLang || ''} ${rawName || ''}`.replace(/İ/g, 'i').replace(/I/g, 'i').trim().toLowerCase();
      if (/(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe|dublaj)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'tr';
      if (/(?:^|[^\p{L}\p{N}])(en|eng|english|ingilizce)(?=$|[^\p{L}\p{N}])/iu.test(info)) return 'en';
      const base = String(rawLang || '').replace(/İ/g, 'i').replace(/I/g, 'i').trim().toLowerCase().split(/[-_]/)[0];
      return (base && base !== 'und') ? base : 'orig';
    };
    const seenCodes = new Set();
    let addedNewTr = false;
    for (let idx = 0; idx < nativeTracks.length; idx += 1) {
      const nt = nativeTracks[idx];
      const rawLang = String(nt?.language || '').trim();
      const rawName = String(nt?.label || '').trim();
      const code = normAudKey(rawLang, rawName);
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);
      if (code === 'tr') {
        const exTr = this.audioTracks.find((t) => t.id === 'tr-dub' || (t.audioLang || t.targetLang || t.lang) === 'tr');
        if (exTr) exTr.nativeIndex = idx;
        else {
          addedNewTr = true;
          this.audioTracks.unshift({
            id: 'tr-dub', nativeIndex: idx, lang: 'tr', targetLang: 'tr', audioLang: 'tr',
            label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)', mode: 'native',
          });
        }
      } else {
        const exOrig = this.audioTracks.find((t) => t.id === 'orig' && typeof t.nativeIndex !== 'number');
        const label = code === 'en' ? '🇬🇧 İngilizce (Orijinal Ses · 1080p)' : `🎬 ${rawName || rawLang || 'Orijinal Ses'} (Orijinal Ses)`;
        if (exOrig) {
          exOrig.nativeIndex = idx;
          exOrig.audioLang = code;
          if (code === 'en') exOrig.label = label;
        } else if (!this.audioTracks.some((t) => t.id === 'orig')) {
          this.audioTracks.push({
            id: 'orig', nativeIndex: idx, lang: 'orig', targetLang: 'orig', audioLang: code, label, mode: 'native',
          });
        } else {
          const extraId = `orig-${code}`;
          if (!this.audioTracks.some((t) => t.id === extraId || t.audioLang === code)) {
            this.audioTracks.push({
              id: extraId, nativeIndex: idx, lang: code, targetLang: code, audioLang: code,
              label: `🌐 ${rawName || code.toUpperCase()}`, mode: 'native',
            });
          }
        }
      }
    }
    if (!this._userPickedAudioForMedia && addedNewTr) {
      this.resolveInitialAudioTrack({ ...(this.media || {}), audioTracks: this.audioTracks });
    }
    this._applyNativeAudioSelection();
    this.adapter.events.onTracksChanged?.();
  }

  _applyNativeAudioSelection() {
    const nativeTracks = this.adapter?.video?.audioTracks;
    if (!nativeTracks || nativeTracks.length <= 1) return;
    const track = this.audioTracks.find((t) => t.id === this.selectedAudioId) || this.audioTracks[0];
    let targetIdx = typeof track?.nativeIndex === 'number' ? track.nativeIndex : -1;
    if (targetIdx < 0) {
      const wantTr = (track?.targetLang || track?.audioLang || track?.lang) === 'tr' || track?.id === 'tr-dub';
      for (let i = 0; i < nativeTracks.length; i += 1) {
        const isTr = /(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe)(?=$|[^\p{L}\p{N}])/iu.test(`${nativeTracks[i]?.language || ''} ${nativeTracks[i]?.label || ''}`);
        if (wantTr === isTr) { targetIdx = i; break; }
      }
    }
    if (targetIdx >= 0 && targetIdx < nativeTracks.length) {
      for (let i = 0; i < nativeTracks.length; i += 1) {
        try { nativeTracks[i].enabled = (i === targetIdx); } catch (e) { /* ignore */ }
      }
    }
  }

  _clearAudioSwitchWatch() {
    if (this._audSwitchWatchTimer) {
      clearTimeout(this._audSwitchWatchTimer);
      this._audSwitchWatchTimer = null;
    }
    if (this._audSwitchCleanup) {
      try { this._audSwitchCleanup(); } catch (_) {}
      this._audSwitchCleanup = null;
    }
  }

  _buildAudioReloadUrl(track) {
    if (track?.url) return String(track.url);
    const curUrl = String(this.adapter?.currentUrl || '');
    if (!curUrl || !curUrl.includes('/api/rave/stream')) return '';
    const wantTr = Boolean(
      track && (
        track.id === 'tr-dub'
        || String(track.id || '').startsWith('tr-dub-')
        || (track.audioLang || track.targetLang || track.lang) === 'tr'
      )
    );
    const audVal = wantTr ? 'tr' : 'orig';
    const cleaned = curUrl
      .replace(/([?&])aud=[^&]*/gi, (_, sep) => (sep === '?' ? '?' : ''))
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
    return cleaned.includes('&ext=.m3u8')
      ? cleaned.replace('&ext=.m3u8', `&aud=${audVal}&ext=.m3u8`)
      : `${cleaned}${cleaned.includes('?') ? '&' : '?'}aud=${audVal}`;
  }

  _watchHlsAudioSwitchHealth(track, targetIdx) {
    this._clearAudioSwitchWatch();
    const hls = this.adapter?.hls;
    const v = this.adapter?.video;
    const reloadUrl = this._buildAudioReloadUrl(track);
    if (!hls || !v || !reloadUrl || typeof this.adapter?.switchStreamSource !== 'function') return;

    const seq = this._mediaSeq;
    const wantedAudioId = this.selectedAudioId;
    const hasDecodedMetric = typeof v.webkitAudioDecodedByteCount === 'number';
    let baselineTime = Number(v.currentTime || 0);
    let baselineAudioBytes = hasDecodedMetric ? Number(v.webkitAudioDecodedByteCount || 0) : -1;
    let triggered = false;
    let rechecks = 0;

    const triggerCleanReload = () => {
      if (triggered || this._destroyed || this._mediaSeq !== seq || this.selectedAudioId !== wantedAudioId || this.adapter?.hls !== hls) {
        this._clearAudioSwitchWatch();
        return;
      }
      const reloadKey = `${seq}:${wantedAudioId}`;
      const now = Date.now();
      if (this._lastAudReloadKey === reloadKey && now - (this._lastAudReloadAt || 0) < 12000) {
        this._clearAudioSwitchWatch();
        return;
      }
      triggered = true;
      this._lastAudReloadKey = reloadKey;
      this._lastAudReloadAt = now;
      this._clearAudioSwitchWatch();
      this.adapter.switchStreamSource(reloadUrl);
    };

    const errEvt = typeof window !== 'undefined' ? window.Hls?.Events?.ERROR : null;
    const onHlsError = (_e, data) => {
      if (triggered || this._destroyed || this._mediaSeq !== seq || this.selectedAudioId !== wantedAudioId || this.adapter?.hls !== hls) {
        this._clearAudioSwitchWatch();
        return;
      }
      const d = String(data?.details || '');
      const isAudioErr = data?.frag?.type === 'audio'
        || d === 'audioTrackLoadError'
        || d === 'audioTrackLoadTimeOut'
        || d === 'audioTrackLoadTimeout'
        || d === 'bufferAppendError'
        || d === 'bufferIncompatibleCodecsError'
        || d === 'fragParsingError';
      if (isAudioErr) {
        triggerCleanReload();
      }
    };
    if (errEvt && typeof hls.on === 'function') {
      hls.on(errEvt, onHlsError);
      this._audSwitchCleanup = () => {
        try { hls.off?.(errEvt, onHlsError); } catch (_) {}
      };
    }

    const verifyHealth = () => {
      this._audSwitchWatchTimer = null;
      if (triggered || this._destroyed || this._mediaSeq !== seq || this.selectedAudioId !== wantedAudioId || this.adapter?.hls !== hls) {
        this._clearAudioSwitchWatch();
        return;
      }
      if (hls.audioTrack !== targetIdx) {
        triggerCleanReload();
        return;
      }
      const curTime = Number(v.currentTime || 0);
      const advanced = curTime - baselineTime;
      if (v.paused || v.seeking || v.readyState < 2 || advanced < 1.0) {
        if (rechecks < 1) {
          rechecks += 1;
          baselineTime = curTime;
          if (hasDecodedMetric) baselineAudioBytes = Number(v.webkitAudioDecodedByteCount || 0);
          this._audSwitchWatchTimer = setTimeout(verifyHealth, 2200);
          return;
        }
        this._clearAudioSwitchWatch();
        return;
      }
      if (hasDecodedMetric) {
        const deltaBytes = Number(v.webkitAudioDecodedByteCount || 0) - baselineAudioBytes;
        if (deltaBytes < 1024) {
          // Audio decoder stalled/silent (e.g. 44.1 kHz <-> 48 kHz MSE sample rate change): clean MSE reload on target track.
          triggerCleanReload();
          return;
        }
      }
      this._clearAudioSwitchWatch();
    };
    this._audSwitchWatchTimer = setTimeout(verifyHealth, 2600);
  }

  _applyHlsAudioSelection(userInitiated = false) {
    this._clearAudioSwitchWatch();
    const hls = this.adapter?.hls;
    const hlsTracks = hls?.audioTracks;
    if (!hls || !Array.isArray(hlsTracks) || hlsTracks.length <= 1) return;
    const track = this.audioTracks.find((t) => t.id === this.selectedAudioId) || this.audioTracks[0];
    if (!track) return;

    const lvlIdx = (Array.isArray(hls.levels) && hls.levels.length)
      ? (hls.currentLevel >= 0 ? hls.currentLevel : (hls.loadLevel >= 0 ? hls.loadLevel : (hls.nextLevel >= 0 ? hls.nextLevel : 0)))
      : -1;
    const activeGroupId = (Array.isArray(hls.levels) && lvlIdx >= 0 && hls.levels[lvlIdx]?.audioGroupId) || '';
    const hasActiveGroupTracks = Boolean(activeGroupId && hlsTracks.some((ht) => ht?.groupId === activeGroupId));

    const want = String(track.targetLang || track.lang || 'orig').toLowerCase();
    const wantCode = String(track.audioLang || '').toLowerCase();
    const wantTr = track.id === 'tr-dub' || String(track.id || '').startsWith('tr-dub-') || want === 'tr' || wantCode === 'tr';
    const LANG_ALIASES = {
      tr: ['tr', 'tur', 'türk', 'turkish', 'türkçe', 'dublaj'], en: ['en', 'eng', 'english', 'ingilizce'],
      ja: ['ja', 'jpn', 'japanese', 'japonca'], ko: ['ko', 'kor', 'korean', 'korece'],
      de: ['de', 'deu', 'ger', 'german', 'almanca'], fr: ['fr', 'fra', 'fre', 'french'],
      es: ['es', 'spa', 'spanish', 'español'], it: ['it', 'ita', 'italian'], ru: ['ru', 'rus', 'russian'],
      ar: ['ar', 'ara', 'arabic'], pt: ['pt', 'por', 'portuguese'], zh: ['zh', 'zho', 'chi', 'chinese'],
      nl: ['nl', 'nld', 'dut', 'nederlands', 'dutch'],
    };
    const isTrTrack = (ht) => /(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe|dublaj)(?=$|[^\p{L}\p{N}])/iu.test(`${ht?.lang || ''} ${ht?.name || ''}`);
    const matchesCode = (ht, code) => {
      const words = `${ht?.lang || ''} ${ht?.name || ''}`.replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().split(/[^a-zçğıöşüñ]+/i);
      return (LANG_ALIASES[code] || [code]).some((a) => words.includes(a));
    };
    const findTrackIdx = (pred) => {
      if (hasActiveGroupTracks) {
        const inGrp = hlsTracks.findIndex((ht) => ht?.groupId === activeGroupId && pred(ht));
        if (inGrp >= 0) return inGrp;
      }
      return hlsTracks.findIndex((ht) => pred(ht));
    };

    let targetIdx = -1;
    if (typeof track.hlsIndex === 'number' && track.hlsIndex >= 0 && track.hlsIndex < hlsTracks.length) {
      const curHt = hlsTracks[track.hlsIndex];
      const groupOk = !hasActiveGroupTracks || !curHt?.groupId || curHt.groupId === activeGroupId;
      const langOk = wantTr ? isTrTrack(curHt) : (wantCode && wantCode !== 'orig' ? matchesCode(curHt, wantCode) : !isTrTrack(curHt));
      if (groupOk && langOk) {
        targetIdx = track.hlsIndex;
      }
    }
    if (targetIdx < 0) {
      if (wantTr) {
        targetIdx = findTrackIdx((ht) => isTrTrack(ht));
      } else if (wantCode && wantCode !== 'orig') {
        targetIdx = findTrackIdx((ht) => matchesCode(ht, wantCode));
        if (targetIdx < 0) targetIdx = findTrackIdx((ht) => !isTrTrack(ht));
      } else {
        targetIdx = findTrackIdx((ht) => !isTrTrack(ht));
      }
    }
    if (targetIdx >= 0) {
      track.hlsIndex = targetIdx;
      if (hls.audioTrack !== targetIdx) {
        // Never trigger manual BUFFER_FLUSHING here: HLS.js coordinates AUDIO_TRACK_SWITCHING internally.
        hls.audioTrack = targetIdx;
        if (userInitiated || (this.adapter?.video?.readyState || 0) >= 2) {
          this._watchHlsAudioSwitchHealth(track, targetIdx);
        }
      }
    }
  }

  async _loadCuesForTrack(track, forceRetry = false) {
    if (!track?.url && !track?.rawUrl) return [];
    const cacheKey = track.url || track.rawUrl;
    if (this.cuesCache.has(cacheKey)) {
      const hit = this.cuesCache.get(cacheKey);
      if (!hit.failedAt || (!forceRetry && Date.now() - hit.failedAt < 30000)) return hit.cues;
      this.cuesCache.delete(cacheKey);
    }

    // Direct residential browser fetch ONLY for CORS-friendly subtitle hosts (skip referer-locked CDNs to avoid 500/CORS spam)
    const url = String(track.url || '');
    let directUrl = track.rawUrl || '';
    if (!directUrl && url && url.includes('/api/rave/subtitle.vtt')) {
      try {
        const uObj = new URL(url, location.origin);
        directUrl = uObj.searchParams.get('url') || '';
      } catch (_) {}
    }

    const isDirectCorsAllowed = Boolean(
      directUrl
      && /^https?:\/\//i.test(directUrl)
      && !/[?&]translate=/i.test(url)
      && /(?:subs5\.strem\.io|hdfilmcehennemi\.mobi|opensubtitles\.org)/i.test(directUrl)
    );
    if (isDirectCorsAllowed) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3500);
        const dResp = await fetch(directUrl, { mode: 'cors', signal: ctrl.signal });
        clearTimeout(tid);
        if (dResp.ok) {
          const buf = await dResp.arrayBuffer();
          const dText = decodeSubtitleArrayBuffer(buf);
          const dCues = parseVtt(dText);
          if (Array.isArray(dCues) && dCues.length >= 10) {
            this._verifyTrackLangFromCues(track, dCues, '');
            this.cuesCache.set(cacheKey, { vtt: dText, cues: dCues, failedAt: 0 });
            return dCues;
          }
        }
      } catch (_) {
        // Direct fetch failed (CORS, network error, or timeout) - proceed to proxy fallback below
      }
    }

    // Fallback: Backend proxy fetch (/api/rave/subtitle.vtt)
    if (track.url) {
      try {
        const r = await fetch(track.url);
        if (!r.ok) {
          this.cuesCache.set(cacheKey, { vtt: '', cues: [], failedAt: Date.now() });
          return [];
        }
        const headerLang = String(r.headers?.get?.('X-Watchlivo-Sub-Lang') || '').trim().toLowerCase();
        const vtt = await r.text();
        const cues = parseVtt(vtt);
        if (cues.length) this._verifyTrackLangFromCues(track, cues, headerLang);
        this.cuesCache.set(cacheKey, { vtt, cues, failedAt: cues.length ? 0 : Date.now() });
        return cues;
      } catch (e) {
        this.cuesCache.set(cacheKey, { vtt: '', cues: [], failedAt: Date.now() });
        return [];
      }
    }
    return [];
  }

  _verifyTrackLangFromCues(track, cues, serverHint = '') {
    if (!track || track.source === 'local' || track.source === 'youtube-native') return;
    const detected = (serverHint === 'tr' || serverHint === 'en') ? serverHint : detectCuesLang(cues);
    if (!detected) return;
    track._detectedLang = detected;
    const claimed = normalizeClientSubLang(track.lang, track.label);
    if (detected !== claimed) {
      track.lang = detected;
      const base = CLIENT_SUB_LABELS[detected] || `🌐 ${detected.toUpperCase()}`;
      track.label = `${base} (Doğrulandı)`;
      this.adapter?.events?.onTracksChanged?.();
    }
  }

  _isNativeSubView(v) {
    return Boolean(
      v && (
        v.webkitDisplayingFullscreen ||
        v.webkitPresentationMode === 'picture-in-picture' ||
        Boolean(v && v.ownerDocument && v.ownerDocument !== document) ||
        document.fullscreenElement === v ||
        document.webkitFullscreenElement === v ||
        document.pictureInPictureElement === v
      )
    );
  }

  _disableAllNativeTextTracks() {
    const v = this.adapter?.video;
    if (!v || !v.textTracks) return;
    const inNativeView = this._isNativeSubView(v);
    for (let i = 0; i < v.textTracks.length; i += 1) {
      const tt = v.textTracks[i];
      try {
        if (this._activeTrackEl?.track === tt) {
          const want = (inNativeView && this.selectedSubId !== 'off' && this.subCues.length) ? 'showing' : 'hidden';
          if (tt.mode !== want) tt.mode = want;
        } else if (tt.mode !== 'disabled') {
          tt.mode = 'disabled';
        }
      } catch (e) { /* ignore */ }
    }
  }

  syncNativeTrackToElement(targetVideo, forceShowing = false) {
    if (!targetVideo) return;
    const isPrimary = targetVideo === this.adapter?.video;
    if (isPrimary && this._activeTrackEl?.track) {
      try {
        if ((!this._activeTrackEl.track.cues || this._activeTrackEl.track.cues.length === 0) && this.subCues?.length) {
          this._rebuildNativeTrackCues();
        }
        const showNow = (forceShowing || this._isNativeSubView(targetVideo)) && this.selectedSubId !== 'off' && Boolean(this.subCues?.length);
        this._activeTrackEl.track.mode = showNow ? 'showing' : 'hidden';
      } catch (e) { /* ignore */ }
      return;
    }
    targetVideo.querySelectorAll('track').forEach((t) => t.remove());
    if (!this.subCues?.length || this.selectedSubId === 'off') return;
    const CueCtor = (typeof window !== 'undefined') ? (window.VTTCue || window.TextTrackCue) : null;
    if (!CueCtor) return;
    const trEl = document.createElement('track');
    trEl.kind = 'subtitles';
    trEl.label = 'Altyazı';
    trEl.srclang = 'tr';
    trEl.dataset.watchlivoPip = '1';
    targetVideo.appendChild(trEl);
    const tt = trEl.track;
    if (!tt) return;
    tt.mode = forceShowing ? 'showing' : 'hidden';
    const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
    const off = this.offsetSec || 0;
    for (const c of this.subCues) {
      const st = Math.max(0, (c.start + off) / scale);
      const en = (c.end + off) / scale;
      if (en > st) {
        try { tt.addCue(new CueCtor(st, en, c.text)); } catch (e) { /* ignore */ }
      }
    }
  }

  _attachNativeTrack(track) {
    const v = this.adapter.video;
    if (!v) return;
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
      document.removeEventListener('webkitfullscreenchange', this._fsHandler);
      v.removeEventListener('webkitbeginfullscreen', this._fsHandler);
      v.removeEventListener('webkitendfullscreen', this._fsHandler);
      v.removeEventListener('webkitpresentationmodechanged', this._fsHandler);
      v.removeEventListener('enterpictureinpicture', this._fsHandler);
      v.removeEventListener('leavepictureinpicture', this._fsHandler);
      v.removeEventListener('loadedmetadata', this._fsHandler);
      this._fsHandler = null;
    }
    v.querySelectorAll('track:not([data-watchlivo-pip="1"])').forEach((t) => t.remove());
    let trEl = v.querySelector('track[data-watchlivo-pip="1"]');
    if (!this.subCues.length || this.selectedSubId === 'off') {
      if (trEl?.track) {
        try {
          while (trEl.track.cues && trEl.track.cues.length > 0) trEl.track.removeCue(trEl.track.cues[0]);
          trEl.track.mode = 'hidden';
        } catch (e) { /* ignore */ }
      }
      this._activeTrackEl = trEl || null;
      this._disableAllNativeTextTracks();
      return;
    }
    try {
      if (!trEl) {
        trEl = document.createElement('track');
        trEl.kind = 'subtitles';
        trEl.dataset.watchlivoPip = '1';
        v.appendChild(trEl);
      }
      trEl.label = track?.label || 'Türkçe';
      trEl.srclang = track?.lang || 'tr';
      trEl.removeAttribute('src');
      this._activeTrackEl = trEl;
      this._rebuildNativeTrackCues();
      const syncNativeMode = () => {
        this._disableAllNativeTextTracks();
        if (trEl.track && (!trEl.track.cues || trEl.track.cues.length === 0) && this.subCues.length) {
          this._rebuildNativeTrackCues();
        }
        if (trEl.track) {
          trEl.track.mode = (this._isNativeSubView(v) && this.selectedSubId !== 'off' && this.subCues.length) ? 'showing' : 'hidden';
        }
        this.onTimeUpdate(this.adapter.getTime(), true);
      };
      syncNativeMode();
      v.addEventListener('webkitbeginfullscreen', syncNativeMode);
      v.addEventListener('webkitendfullscreen', syncNativeMode);
      v.addEventListener('webkitpresentationmodechanged', syncNativeMode);
      v.addEventListener('enterpictureinpicture', syncNativeMode);
      v.addEventListener('leavepictureinpicture', syncNativeMode);
      v.addEventListener('loadedmetadata', syncNativeMode);
      this._fsHandler = syncNativeMode;
      document.addEventListener('fullscreenchange', syncNativeMode);
      document.addEventListener('webkitfullscreenchange', syncNativeMode);
    } catch (e) { /* ignore */ }
  }
  async setSubtitleTrack(id, isInit = false) {
    const cleanId = id || 'off';
    const myTrackSeq = (this._subTrackSeq = (this._subTrackSeq || 0) + 1);
    if (!isInit) this._userPickedSubForMedia = true;
    this._lastFastCueStart = 0;
    this._lastFastCueEnd = 0;
    this.selectedSubId = cleanId;
    if (!isInit && cleanId === 'off') {
      this._prevSubBeforeDub = null;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('vortex_sub_lang', 'off'); } catch (e) { /* ignore */ }
    }
    if (cleanId === 'off' || !this.subtitleTracks.length) {
      this.subCues = [];
      this.secondaryCues = [];
      this.activeCueText = '';
      this.activeSecondaryCueText = '';
      this._attachNativeTrack(null);
      this._disableAllNativeTextTracks();
      this.adapter?._syncYtNativeCaptions?.();
      this.adapter.events.onSubtitleCue?.('', '');
      this.adapter.events.onTracksChanged?.();
      return null;
    }
    const exactIdTrack = this.subtitleTracks.find((t) => t.id === cleanId);
    const streamTrack = this.subtitleTracks.find((t) => (t.id === cleanId || t.lang === cleanId || (cleanId === 'tr' && String(t.lang || '').startsWith('tr'))) && isStreamSyncedSub(t));
    const desiredLang = isInit
      ? normalizeClientSubLang(exactIdTrack ? exactIdTrack.lang : cleanId, exactIdTrack?.label || '')
      : '';
    let track = (!isInit && exactIdTrack)
      || (cleanId !== 'off' && streamTrack)
      || exactIdTrack
      || this.subtitleTracks.find((t) => t.lang === cleanId)
      || this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith(cleanId))
      || this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith('tr'))
      || (isInit ? null : this.subtitleTracks[0]);
    if (!track) {
      this.selectedSubId = 'off';
      this.subCues = [];
      this.secondaryCues = [];
      this.activeCueText = '';
      this.activeSecondaryCueText = '';
      this._attachNativeTrack(null);
      this._disableAllNativeTextTracks();
      this.adapter?._syncYtNativeCaptions?.();
      this.adapter.events.onSubtitleCue?.('', '');
      this.adapter.events.onTracksChanged?.();
      return null;
    }
    const requestedLangBeforeLoad = normalizeClientSubLang(desiredLang || track.lang || '', track.label || '');
    const targetLangForFallback = requestedLangBeforeLoad;
    const seq = this._mediaSeq;
    this._loadingSubTrack = true;
    try {
      let cues = await this._loadCuesForTrack(track, !isInit);
      if (this._destroyed || this._mediaSeq !== seq || this._subTrackSeq !== myTrackSeq) return null;
      const dur = Number(this.adapter?.getDuration?.() || this.media?.duration || 0);
      const minEnd = dur > 600 ? (dur * 0.5) : 900;
      const getSpan = (arr) => (arr && arr.length ? arr[arr.length - 1].end : 0);
      if (track.source === 'youtube-native') {
        this.selectedSubId = track.id;
        this.subCues = [];
        this.secondaryCues = [];
        this.adapter?._syncYtNativeCaptions?.();
        this.adapter.events.onSubtitleCue?.('', '');
        this.adapter.events.onTracksChanged?.();
        return track;
      }
      const isStreamEmbeddedFansub = isStreamSyncedSub(track);
      const activeSrcNow = this._getActiveStreamSource?.() || '';
      const matchesActiveServer = Boolean(activeSrcNow && track.source === activeSrcNow);
      const wrongAutoLang = Boolean(isInit && targetLangForFallback && track._detectedLang && track._detectedLang !== targetLangForFallback);
      const curSpanInit = getSpan(cues);
      const hasDurationMismatch = Boolean(
        isInit
        && track.source !== 'local'
        && !matchesActiveServer
        && dur > 900
        && curSpanInit > 60
        && (
          curSpanInit > dur * 1.025
          || curSpanInit < dur * 0.86
          || (dur > 2400 && curSpanInit < dur * 0.945)
        )
      );
      const effMovieDur = dur >= 3600 ? dur : (this.media?.mediaType === 'movie' && curSpanInit >= 3600 ? curSpanInit : 0);
      const isMovieForcedSub = Boolean(effMovieDur >= 3600 && cues.length > 0 && cues.length < 180 && (cues.length / (effMovieDur / 60)) < 1.8);
      const isForcedOrTruncated = track.source === 'local'
        ? false
        : (isInit
          ? (isMovieForcedSub || (isStreamEmbeddedFansub
            ? (cues.length < 20)
            : (cues.length < 35 || (cues.length < 45 && curSpanInit < minEnd))))
          : false);
      if (wrongAutoLang || isForcedOrTruncated || hasDurationMismatch || cues.length === 0) {
        const alts = this.subtitleTracks.filter((t) => t.id !== track.id && normalizeClientSubLang(t.lang, t.label) === targetLangForFallback);
        const durFitScore = (arr) => {
          const sp = getSpan(arr);
          if (!arr?.length || dur <= 900) return arr?.length || 0;
          const r = sp / dur;
          if (r > 1.025) return -50 - (r - 1.025) * 100;
          if (r < 0.85) return -40 - (0.85 - r) * 100;
          return 100 - Math.abs(r - 0.97) * 120;
        };
        let bestFit = durFitScore(cues);
        for (const alt of alts) {
          const altCues = await this._loadCuesForTrack(alt, !isInit);
          if (this._destroyed || this._mediaSeq !== seq || this._subTrackSeq !== myTrackSeq) return null;
          if (isInit && alt._detectedLang && targetLangForFallback && alt._detectedLang !== targetLangForFallback) continue;
          const curSpan = getSpan(cues);
          const altSpan = getSpan(altCues);
          if (isMovieForcedSub) {
            if (altCues.length >= Math.max(250, cues.length * 3) && (dur <= 900 || altSpan >= dur * 0.72)) {
              track = alt;
              cues = altCues;
              break;
            }
            continue;
          }
          if (wrongAutoLang && altCues.length >= 20) {
            track = alt;
            cues = altCues;
            break;
          }
          if (hasDurationMismatch && dur > 900 && altCues.length >= 40) {
            const altFit = durFitScore(altCues);
            if (altFit > bestFit + 6) {
              track = alt;
              cues = altCues;
              bestFit = altFit;
              if (bestFit >= 94) break;
            }
            continue;
          }
          if ((altCues.length >= 60 && altSpan >= minEnd) || (altCues.length > cues.length && altSpan > curSpan) || (cues.length === 0 && altCues.length > 0)) {
            track = alt;
            cues = altCues;
            if (cues.length >= 60 && altSpan >= minEnd) break;
          }
        }
      }
      if (!isInit) {
        const persistLang = requestedLangBeforeLoad || normalizeClientSubLang(track.lang, track.label) || 'tr';
        try { localStorage.setItem('vortex_sub_lang', persistLang); } catch (e) { /* ignore */ }
      }
      if (this._destroyed || this._mediaSeq !== seq || this._subTrackSeq !== myTrackSeq) return null;
      this.selectedSubId = track.id;
      this._loadMediaSyncPrefs(this.media, track.id);
      this.subCues = cues;
      this._lastFastCueStart = 0;
      this._lastFastCueEnd = 0;
      if (!this.intro) this.intro = this._detectIntroFromCues(cues);
      this.secondaryCues = [];
      this._attachNativeTrack(track);
      this.adapter?._syncYtNativeCaptions?.();
      this.onTimeUpdate(this.adapter.getTime(), true);
      this.adapter.events.onTracksChanged?.();
      return track;
    } finally {
      if (this._subTrackSeq === myTrackSeq) this._loadingSubTrack = false;
    }
  }

  onVideoDurationKnown(durSec) {
    const dur = Number(durSec || 0);
    if (!Number.isFinite(dur) || dur <= 900 || this._destroyed || this._loadingSubTrack) return;
    if (this._userPickedSubForMedia || this._durationValidatedForMedia) return;
    if (!this.selectedSubId || this.selectedSubId === 'off' || !this.subCues.length) return;
    const curTrack = this.subtitleTracks.find((t) => t.id === this.selectedSubId);
    if (!curTrack || curTrack.source === 'local' || curTrack.source === 'youtube-native') return;
    const activeSrc = this._getActiveStreamSource?.() || '';
    if (activeSrc && curTrack.source === activeSrc) {
      this._durationValidatedForMedia = true;
      return;
    }
    const lastEnd = this.subCues[this.subCues.length - 1]?.end || 0;
    const ratio = lastEnd / dur;
    const suspicious = ratio > 1.025 || ratio < 0.86 || (dur > 2400 && ratio < 0.945);
    this._durationValidatedForMedia = true;
    if (!suspicious) return;
    const curLang = normalizeClientSubLang(curTrack.lang, curTrack.label);
    const hasAlts = this.subtitleTracks.some((t) => t.id !== curTrack.id && normalizeClientSubLang(t.lang, t.label) === curLang);
    if (hasAlts) {
      this.setSubtitleTrack(curTrack.id, true).catch(() => {});
    }
  }

  async loadLocalSubtitleFile(file) {
    if (!file) return null;
    try {
      const buf = await file.arrayBuffer();
      const text = decodeSubtitleArrayBuffer(buf);
      const cues = parseVtt(text);
      if (!cues.length) return null;
      const detLocalLang = detectCuesLang(cues) || 'tr';
      const customUrl = `local://sub/${Date.now()}-${encodeURIComponent(file.name)}`;
      const vttLines = ['WEBVTT', ''];
      cues.forEach((c, idx) => {
        const fmt = (sec) => {
          const s = Math.max(0, Number(sec) || 0);
          const hh = String(Math.floor(s / 3600)).padStart(2, '0');
          const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
          const ss = (s % 60).toFixed(3).padStart(6, '0');
          return `${hh}:${mm}:${ss}`;
        };
        vttLines.push(`${idx + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`);
      });
      const vttStr = vttLines.join('\n\n') + '\n';
      this.cuesCache.set(customUrl, { vtt: vttStr, cues });
      const customTrack = {
        id: `local-${Date.now()}`,
        lang: detLocalLang,
        label: `📁 ${file.name.slice(0, 28)}`,
        url: customUrl,
        source: 'local',
      };
      this.subtitleTracks = [customTrack, ...this.subtitleTracks];
      if (this.media) this.media.subtitleTracks = this.subtitleTracks;
      await this.setSubtitleTrack(customTrack.id, false);
      return customTrack;
    } catch (e) {
      return null;
    }
  }

  async _syncSecondaryDualTrack() {
    if (!this.dualSubEnabled || !this.selectedSubId || this.selectedSubId === 'off') {
      this.secondaryCues = [];
      return;
    }
    const primary = this.subtitleTracks.find((t) => t && t.id === this.selectedSubId);
    const primLang = String(primary?.lang || '').toLowerCase();
    const wantLang = primLang === 'tr' ? 'en' : 'tr';
    const secTrack = this.subtitleTracks.find((t) => t && t.id !== this.selectedSubId && t.url && String(t.lang || '').toLowerCase() === wantLang)
      || this.subtitleTracks.find((t) => t && t.id !== this.selectedSubId && t.url && String(t.lang || '').toLowerCase() !== primLang);
    if (!secTrack?.url) {
      this.secondaryCues = [];
      return;
    }
    try {
      const r = await fetch(secTrack.url);
      if (!r.ok) { this.secondaryCues = []; return; }
      const txt = await r.text();
      this.secondaryCues = parseVtt(txt) || [];
    } catch (_) {
      this.secondaryCues = [];
    }
  }

  async setDualSubtitle(enabled = !this.dualSubEnabled) {
    this.dualSubEnabled = Boolean(enabled);
    if (this.dualSubEnabled) {
      await this._syncSecondaryDualTrack();
      if (!this.secondaryCues.length) this.dualSubEnabled = false;
    } else {
      this.secondaryCues = [];
    }
    this.onTimeUpdate(this.adapter.getTime(), true);
    this.adapter.events.onTracksChanged?.();
    return this.dualSubEnabled;
  }

  async setAudioTrack(id, isInit = false) {
    const normId = (id === 'tr' || id === 'tur' || id === 'turkish') ? 'tr-dub' : (id || 'orig');
    const cleanId = normId;
    this.selectedAudioId = cleanId;
    if (!isInit) this._userPickedAudioForMedia = true;
    if (!isInit && !/^src-\d+$/.test(cleanId)) {
      const hasStudioTrDub = this.audioTracks.some((t) => t && t.mode !== 'tts' && t.id !== 'tr-ai-dub' && (
        t.id === 'tr-dub' || String(t.id || '').startsWith('tr-dub-') || t.id === 'tr-orig'
        || t.audioLang === 'tr' || t.lang === 'tr' || t.targetLang === 'tr'
      ) && (t.url || typeof t.hlsIndex === 'number' || typeof t.nativeIndex === 'number'));
      const isOrigChoice = cleanId === 'orig' || cleanId.startsWith('orig-');
      if (isOrigChoice && !hasStudioTrDub) {
        this.userAudioPref = '';
        try {
          localStorage.removeItem('vortex_audio_proxy_pref');
          localStorage.removeItem('vortex_audio_lang');
        } catch (e) { /* ignore */ }
      } else {
        this.userAudioPref = cleanId;
        try {
          localStorage.setItem('vortex_audio_proxy_pref', cleanId);
          localStorage.setItem('vortex_audio_lang', cleanId);
        } catch (e) { /* ignore */ }
      }
    }
    const track = this.audioTracks.find((t) => t.id === cleanId)
      || this.audioTracks.find((t) => (t.targetLang || t.lang) === cleanId)
      || this.audioTracks.find((t) => t.audioLang === cleanId)
      || this.audioTracks[0];
    if (!track) return null;
    this.selectedAudioId = track.id;
    this.ttsDubActive = false;
    this.stopDubAudio();

    if (!isInit && (track.id === 'tr-dub' || ((track.lang || track.audioLang) === 'tr' && track.mode !== 'tts' && /dublaj/i.test(track.label || '')))) {
      let savedSub = '';
      try { savedSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (_) {}
      if (savedSub !== 'off' && this.selectedSubId && this.selectedSubId !== 'off' && this._isTrSubId(this.selectedSubId)) {
        this._prevSubBeforeDub = this.selectedSubId;
        await this.setSubtitleTrack('off', true);
      }
    } else if (!isInit && this.media?.origLang !== 'tr' && (track.id === 'orig' || (track.lang !== 'tr' && track.audioLang !== 'tr'))) {
      let savedSub = '';
      try { savedSub = typeof localStorage !== 'undefined' ? (localStorage.getItem('vortex_sub_lang') || '') : ''; } catch (_) {}
      if (savedSub !== 'off' && (!this.selectedSubId || this.selectedSubId === 'off')) {
        const trFallback = this.subtitleTracks.find((t) => normalizeClientSubLang(t.lang, t.label) === 'tr' || String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
        const restoreId = this._prevSubBeforeDub || trFallback?.id || '';
        this._prevSubBeforeDub = null;
        if (restoreId) await this.setSubtitleTrack(restoreId, true);
      }
    }

    if (track.mode === 'tts' || track.id === 'tr-ai-dub' || track.id === 'en-ai-dub') {
      const isAnime = this.media?.provider === 'anime' || this.media?.origLang === 'ja' || this.media?.type === 'anime';
      if (!isAnime) {
        this.ttsDubActive = false;
        this.stopDubAudio();
        return track;
      }
      this.ttsDubActive = true;
      this._lastTtsText = '';
      this.ttsLang = (track.audioLang || track.targetLang || track.lang || 'tr').toLowerCase();
      const dubSub = this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith(this.ttsLang))
        || this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith('tr'))
        || this.subtitleTracks[0];
      if (dubSub) {
        let cuesForDub = await this._loadCuesForTrack(dubSub);
        const subLangLow = String(dubSub.lang || '').toLowerCase();
        if (this.ttsLang === 'tr' && !subLangLow.startsWith('tr') && String(dubSub.url || '').includes('/api/rave/subtitle.vtt') && !String(dubSub.url || '').includes('translate=tr')) {
          const trUrl = `${dubSub.url}${dubSub.url.includes('?') ? '&' : '?'}translate=tr`;
          const trCues = await this._loadCuesForTrack({ ...dubSub, url: trUrl });
          if (trCues && trCues.length) cuesForDub = trCues;
        }
        this.dubCues = cuesForDub;
        if (!this.selectedSubId || this.selectedSubId === 'off') {
          await this.setSubtitleTrack(dubSub.id, true);
        }
      }
      this.syncVideoVolume();
      if (!isInit) this.onTimeUpdate(this.adapter.getTime(), true);
      this.adapter.events.onTracksChanged?.();
      return track;
    }

    const cleanUrl = (u) => {
      const s = String(u || '').trim();
      if (!s) return '';
      try {
        const uo = new URL(s, typeof location !== 'undefined' ? location.origin : 'https://watchlivo.online');
        uo.searchParams.delete('proxy_segs');
        uo.searchParams.delete('max_h');
        uo.searchParams.delete('abr_low');
        return `${uo.pathname}${uo.search}`;
      } catch (_) {
        return s.replace(/([?&])(proxy_segs|max_h|abr_low)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
      }
    };
    const hlsHasMulti = Array.isArray(this.adapter?.hls?.audioTracks) && this.adapter.hls.audioTracks.length > 1;
    const nativeHasMulti = Boolean(this.adapter?.video?.audioTracks && this.adapter.video.audioTracks.length > 1);
    const urlsDiffer = Boolean(track.url && this.adapter.currentUrl && cleanUrl(track.url) !== cleanUrl(this.adapter.currentUrl));
    if (typeof track.hlsIndex === 'number' && hlsHasMulti) {
      this._applyHlsAudioSelection(!isInit);
    } else if (typeof track.nativeIndex === 'number' && nativeHasMulti) {
      this._applyNativeAudioSelection();
    } else if (!(isInit && this._skipInitStreamSwitch) && track.mode === 'stream' && track.url && urlsDiffer) {
      await this.adapter.switchStreamSource(track.url);
    } else {
      if (isInit && this._skipInitStreamSwitch && track.mode === 'stream' && track.url && urlsDiffer) {
        this.adapter?._pushFallbackAlt?.(track.url);
        const activeClean = cleanUrl(this.adapter.currentUrl);
        const loadedTrack = this.audioTracks.find((t) => t.mode === 'stream' && t.url && cleanUrl(t.url) === activeClean);
        if (loadedTrack && loadedTrack.id !== this.selectedAudioId) {
          this.selectedAudioId = loadedTrack.id;
        }
      }
      this._applyHlsAudioSelection(!isInit);
      this._applyNativeAudioSelection();
    }
    this.syncVideoVolume();
    this.adapter.events.onTracksChanged?.();
    return track;
  }

  findCueStateAt(cues, t) {
    if (!cues || !cues.length || !Number.isFinite(t)) {
      return { cue: null, validFrom: -Infinity, validUntil: Infinity };
    }
    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const nextStart = (idx + 1 < cues.length) ? cues[idx + 1].start : Infinity;
    if (idx < 0) {
      return { cue: null, validFrom: -Infinity, validUntil: cues[0].start };
    }
    const active = [];
    let latestPriorEnd = -Infinity;
    for (let i = idx; i >= 0; i -= 1) {
      const c = cues[i];
      if ((c.maxEnd ?? c.end) < t) {
        if ((c.maxEnd ?? c.end) > latestPriorEnd) latestPriorEnd = c.maxEnd ?? c.end;
        break;
      }
      if (t >= c.start && t <= c.end) {
        active.push(c);
        if (active.length >= 2) break;
      } else if (c.end <= t && c.end > latestPriorEnd) {
        latestPriorEnd = c.end;
      }
    }
    if (!active.length) {
      return { cue: null, validFrom: Math.max(latestPriorEnd, cues[idx].start), validUntil: nextStart };
    }
    active.reverse();
    const uniqueLines = [];
    const seenNorm = new Set();
    let maxActiveStart = -Infinity;
    let minActiveEnd = Infinity;
    for (const item of active) {
      if (item.start > maxActiveStart) maxActiveStart = item.start;
      if (item.end < minActiveEnd) minActiveEnd = item.end;
      const parts = String(item.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const ln of parts) {
        const normKey = ln.toLocaleLowerCase('tr').replace(/\u0307/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || ln.trim();
        if (!normKey || seenNorm.has(normKey)) continue;
        seenNorm.add(normKey);
        uniqueLines.push(ln);
      }
    }
    const validFrom = Math.max(maxActiveStart, latestPriorEnd);
    const validUntil = Math.min(minActiveEnd, nextStart);
    return {
      cue: { start: active[0].start, end: active[active.length - 1].end, nextBoundary: validUntil, text: uniqueLines.join('\n') },
      validFrom,
      validUntil,
    };
  }

  findCueAt(cues, t) {
    return this.findCueStateAt(cues, t).cue;
  }

  clearActiveCue() {
    this.activeCueText = '';
    this.activeSecondaryCueText = '';
    this._lastFastCueStart = 0;
    this._lastFastCueEnd = 0;
    this.adapter?.events?.onSubtitleCue?.('', '');
  }

  async _tryHealTruncatedTrack(adjT) {
    if (this._healingInFlight || this._destroyed) return;
    const curTrack = this.subtitleTracks.find((t) => t.id === this.selectedSubId);
    if (!curTrack) return;
    const bucketKey = `${curTrack.id}:${Math.floor(adjT / 300)}`;
    if (this._autoHealedLang === bucketKey) return;
    this._autoHealedLang = bucketKey;
    this._healingInFlight = true;
    const seq = this._mediaSeq;
    try {
      const alts = this.subtitleTracks.filter((t) => t.id !== curTrack.id && t.lang === curTrack.lang);
      for (const alt of alts) {
        const altCues = await this._loadCuesForTrack(alt);
        if (this._destroyed || this._mediaSeq !== seq) return;
        const lastEnd = altCues.length ? altCues[altCues.length - 1].end : 0;
        if (lastEnd >= adjT + 30 && altCues.length >= 40) {
          this.selectedSubId = alt.id;
          this.subCues = altCues;
          this._attachNativeTrack(alt);
          this.onTimeUpdate(this.adapter.getTime(), true);
          this.adapter.events.onTracksChanged?.();
          return;
        }
      }
    } finally {
      this._healingInFlight = false;
    }
  }

  onTimeUpdate(t, forceEmit = false) {
    if (!Number.isFinite(t) || this._destroyed) return;
    const v = this.adapter?.video;
    if (v?.textTracks?.length) {
      for (let i = 0; i < v.textTracks.length; i += 1) {
        if (v.textTracks[i].mode === 'showing') {
          this._disableAllNativeTextTracks();
          break;
        }
      }
    }
    const nativeVideoFs = this._isNativeSubView(v);
    const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
    const adjT = (t * scale) - (this.offsetSec || 0);
    if (
      !forceEmit && !nativeVideoFs && !this.dualSubEnabled && !this.ttsDubActive
      && this.subCues.length && this.selectedSubId !== 'off'
      && this._lastFastTrackId === this.selectedSubId
      && this._lastFastCueEnd > this._lastFastCueStart
      && adjT >= this._lastFastCueStart && adjT < this._lastFastCueEnd
    ) {
      return;
    }
    const curSubObj = this.subtitleTracks.find((tr) => tr.id === this.selectedSubId);
    if (!this._loadingSubTrack && !this.subCues.length && this.selectedSubId !== 'off' && curSubObj?.source !== 'youtube-native' && this.subtitleTracks.length && (this._emptyReloadCount || 0) < 2) {
      const nowMs = Date.now();
      if (!this._lastEmptyReload || nowMs - this._lastEmptyReload > 8000) {
        this._lastEmptyReload = nowMs;
        this._emptyReloadCount = (this._emptyReloadCount || 0) + 1;
        for (const k of [...this.cuesCache.keys()]) {
          if (!String(k).startsWith('local://')) this.cuesCache.delete(k);
        }
        this.setSubtitleTrack(this.selectedSubId, true).catch(() => {});
      }
    }
    if (!this._loadingSubTrack && !this.subCues.length && this.selectedSubId !== 'off' && curSubObj?.source !== 'youtube-native' && curSubObj?.source !== 'local' && this.subtitleTracks.length > 1) {
      this._tryHealTruncatedTrack(0);
    }
    if (nativeVideoFs) {
      if (forceEmit || this.activeCueText || this.activeSecondaryCueText) {
        this.activeCueText = '';
        this.activeSecondaryCueText = '';
        this.adapter.events.onSubtitleCue?.('', '');
      }
    } else if (this.subCues.length && this.selectedSubId !== 'off') {
      const lastEnd = this.subCues[this.subCues.length - 1]?.end || 0;
      if (adjT > 420 && lastEnd > 0 && adjT > lastEnd + 45) {
        this._tryHealTruncatedTrack(adjT);
      }
      const state = this.findCueStateAt(this.subCues, adjT);
      const cue = state.cue;
      const txt = cue ? cue.text : '';
      this._lastFastTrackId = this.selectedSubId;
      this._lastFastCueStart = Number.isFinite(state.validFrom) ? state.validFrom : -1;
      this._lastFastCueEnd = Number.isFinite(state.validUntil) ? state.validUntil : Infinity;
      const secCue = (this.dualSubEnabled && this.secondaryCues.length) ? this.findCueAt(this.secondaryCues, adjT) : null;
      const secTxt = secCue ? secCue.text : '';
      if (forceEmit || txt !== this.activeCueText || secTxt !== this.activeSecondaryCueText) {
        this.activeCueText = txt;
        this.activeSecondaryCueText = secTxt;
        this.adapter.events.onSubtitleCue?.(txt, secTxt);
      }
    } else if (forceEmit || this.activeCueText || this.activeSecondaryCueText) {
      this.activeCueText = '';
      this.activeSecondaryCueText = '';
      this.adapter.events.onSubtitleCue?.('', '');
    }
    if (this.ttsDubActive) {
      if (!this._canPlayTtsNow()) {
        if (this._ttsSpeaking || (this._ttsAudio && !this._ttsAudio.paused)) {
          this.stopDubAudio();
        }
        return;
      }
      const dubList = (this.dubCues && this.dubCues.length) ? this.dubCues : this.subCues;
      if (!dubList || !dubList.length) return;
      const dCue = this.findCueAt(dubList, adjT);
      const dTxt = dCue ? String(dCue.text || '').replace(/\s+/g, ' ').trim() : '';
      if (dTxt && dTxt !== this._lastTtsText) {
        this._lastTtsText = dTxt;
        this._speakTtsCue(dTxt);
      }
    }
  }

  _canPlayTtsNow() {
    if (this._destroyed || !this.ttsDubActive) return false;
    const isAnime = this.media?.provider === 'anime' || this.media?.origLang === 'ja' || this.media?.type === 'anime';
    if (!isAnime) return false;
    if (typeof document !== 'undefined' && document.body?.classList?.contains('mesh-minimized')) return false;
    const v = this.adapter?.video;
    if (this.adapter?.isPaused?.() || v?.paused || v?.ended) return false;
    const basePct = Number.isFinite(Number(this.adapter?.baseVolume)) ? Number(this.adapter.baseVolume) : 80;
    if (v?.muted || this.adapter?.userExplicitMuted || basePct <= 0) return false;
    return true;
  }

  _speakTtsCue(text) {
    if (!text || !this._canPlayTtsNow()) return;
    try {
      if (!this._ttsAudio) {
        this._ttsAudio = new Audio();
        this._ttsAudio.crossOrigin = 'anonymous';
        this._ttsAudio.addEventListener('ended', () => {
          this._ttsSpeaking = false;
          this.syncVideoVolume();
        });
        this._ttsAudio.addEventListener('error', () => {
          this._ttsSpeaking = false;
          this.syncVideoVolume();
        });
      }
      this._ttsSpeaking = true;
      this.syncVideoVolume();
      this._ttsAudio.src = `/api/rave/tts?lang=${encodeURIComponent(this.ttsLang || 'tr')}&q=${encodeURIComponent(text.slice(0, 220))}`;
      this._ttsAudio.playbackRate = Math.min(1.45, Math.max(1.05, Number(this.adapter?.getRate?.() || 1.0) * 1.12));
      this._ttsAudio.play().catch(() => {
        this._ttsSpeaking = false;
        this.syncVideoVolume();
      });
    } catch (e) {
      this._ttsSpeaking = false;
      this.syncVideoVolume();
    }
  }

  syncVideoVolume() {
    let duckOn = true;
    try {
      const rawDuck = String((typeof localStorage !== 'undefined' ? localStorage.getItem('vortex_voice_duck') : '') || '').trim().toLowerCase();
      duckOn = rawDuck !== 'off' && rawDuck !== '0' && rawDuck !== 'false';
    } catch (_) {}
    const hostManagesDuck = typeof window !== 'undefined' && Boolean(window.__kinoxHost);
    const voiceDuck = (!hostManagesDuck && duckOn && typeof window !== 'undefined' && typeof window.__kinoxVoiceDuckFactor === 'number')
      ? window.__kinoxVoiceDuckFactor
      : 1.0;
    const ttsDuck = (this.ttsDubActive && this._ttsSpeaking) ? 0.22 : 1.0;
    const duckFactor = Math.min(voiceDuck, ttsDuck);
    const defaultPct = isIosWebKit() ? 100 : 80;
    const basePct = Number.isFinite(Number(this.adapter?.baseVolume)) ? Number(this.adapter.baseVolume) : defaultPct;
    const v = this.adapter?.video;
    if (v) {
      applyElementVolume(v, basePct * duckFactor, Boolean(v.muted || this.adapter?.userExplicitMuted), {
        useNativeHls: Boolean(this.adapter?.useNativeHls),
        retriedNoCors: Boolean(v._retriedNoCors),
        inPip: Boolean(this.adapter?.isPiP?.()),
      });
    }
    if (this.adapter?.iosPipVideo) {
      this.adapter.iosPipVideo.muted = this.adapter._iosPipActive
        ? Boolean(v?.muted || this.adapter?.userExplicitMuted || basePct <= 0)
        : true;
    }
    if (this._ttsAudio) {
      const isMuted = Boolean(v?.muted || this.adapter?.userExplicitMuted || basePct <= 0);
      applyElementVolume(this._ttsAudio, basePct * voiceDuck, isMuted);
    }
    if (this.adapter?.player?.setVolume) {
      try {
        this.adapter.player.setVolume(Math.min(100, Math.max(0, Math.round(basePct * duckFactor))));
      } catch (e) { /* ignore */ }
    }
  }

  stopDubAudio() {
    this._ttsSpeaking = false;
    this._lastTtsText = '';
    if (this._ttsAudio) {
      try {
        this._ttsAudio.pause();
        this._ttsAudio.removeAttribute('src');
        this._ttsAudio.load();
      } catch (e) { /* ignore */ }
    }
    this.syncVideoVolume();
  }
  unlockDubAudio() {
    this.syncVideoVolume();
  }

  destroy() {
    this._destroyed = true;
    this._clearAudioSwitchWatch?.();
    this.stopDubAudio();
    if (this._ttsAudio) {
      try { releaseMediaBoost(this._ttsAudio); } catch (e) { /* ignore */ }
      this._ttsAudio = null;
    }
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
      document.removeEventListener('webkitfullscreenchange', this._fsHandler);
      const v = this.adapter?.video;
      if (v) {
        v.removeEventListener('webkitbeginfullscreen', this._fsHandler);
        v.removeEventListener('webkitendfullscreen', this._fsHandler);
        v.removeEventListener('webkitpresentationmodechanged', this._fsHandler);
        v.removeEventListener('enterpictureinpicture', this._fsHandler);
        v.removeEventListener('leavepictureinpicture', this._fsHandler);
        v.removeEventListener('loadedmetadata', this._fsHandler);
      }
      this._fsHandler = null;
    }
      if (this.blobUrl) {
        try { URL.revokeObjectURL(this.blobUrl); } catch (e) { /* ignore */ }
        this.blobUrl = null;
      }
      if (typeof window !== 'undefined' && window.__activeSubsController === this) {
        window.__activeSubsController = null;
        if (window.__kinoxHost) {
          window.__kinoxSyncDuckVolume = () => window.__kinoxHost?._syncDuckRamp?.();
        }
      }
  }
}
