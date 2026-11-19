// Rave VideoPlayerControlsFC Subtitle (selectTextTrack / VTTCue) & Studio Multi-Audio HLS (audioTracks) Engine.
import { applyElementVolume, isIosWebKit, releaseMediaBoost } from './audio-gain.js?v=20261120_v227';

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

export function parseVtt(vttText) {
  if (!vttText || typeof vttText !== 'string') return [];
  const lines = vttText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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
        .filter((l) => l && !/^(?:müzik|şarkı|music|song|alkış|applause|gülüşmeler|kahkaha|laughter|sessizlik|silence|iç çeker|sighs|inler|groans|nefes alır|gasps)$/i.test(l));
      const normSubLine = (s) => String(s || '').toLocaleLowerCase('tr').replace(/\u0307/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const dedupLines = [];
      const seenLineNorms = new Set();
      for (const rl of rawLines) {
        const nl = normSubLine(rl) || rl.trim();
        if (!nl || seenLineNorms.has(nl)) continue;
        seenLineNorms.add(nl);
        dedupLines.push(rl);
      }
      const clean = dedupLines.join('\n').trim();
      if (clean && end > start && !/(?:opensubtitles|osdb\.link|advertise your product|do you want subtitles for any video|çevrimiçi filmleri ve dizileri ücretsiz izleyin|subscene\.com|turkcealtyazi\.org|altyazi\.org|yutukluklar|çeviri\s*:|senkron\s*:|iyi seyirler dileriz)/i.test(clean)) {
        rawCues.push({ start, end, text: clean, norm: normSubLine(clean) || clean });
      }
    } else {
      i += 1;
    }
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

const STREAM_SUB_SOURCES = new Set(['stream', 'fansub', 'dl_embed', 'sinemacc', 'fhd_embed', 'hfnl_embed', 'diziyou_net', 'dylove', 'filmmodu', 'ddizimag', 'hls_filemoon']);

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
    this.selectedSubId = localStorage.getItem('vortex_sub_lang') || 'tr';
    const savedAud = localStorage.getItem('vortex_audio_lang') || localStorage.getItem('vortex_audio_proxy_pref') || '';
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

  _syncStorageKey(media = this.media) {
    if (!media) return 'vortex_sub_sync:default';
    const idPart = media.tmdbId || media.imdbId || (media.title || 'media').slice(0, 32);
    return `vortex_sub_sync:${idPart}:${media.season || 1}:${media.episode || 1}`;
  }

  _loadMediaSyncPrefs(media) {
    this.offsetSec = 0;
    this.fpsScale = 1.0;
    try {
      const raw = localStorage.getItem(this._syncStorageKey(media));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(Number(parsed.offsetSec))) {
          const off = Number(parsed.offsetSec);
          if (Number.isFinite(off) && Math.abs(off) <= 120.0) {
            this.offsetSec = off;
          } else {
            this.offsetSec = 0;
            this._saveMediaSyncPrefs();
          }
        }
        if (Number.isFinite(Number(parsed.fpsScale)) && parsed.fpsScale > 0.85 && parsed.fpsScale < 1.15) {
          this.fpsScale = Number(parsed.fpsScale);
        }
      }
    } catch (e) { /* ignore */ }
  }

  _saveMediaSyncPrefs() {
    try {
      localStorage.setItem(this._syncStorageKey(), JSON.stringify({
        offsetSec: this.offsetSec,
        fpsScale: this.fpsScale,
      }));
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
    this._saveMediaSyncPrefs();
    this._rebuildNativeTrackCues();
    this.onTimeUpdate(this.adapter.getTime(), true);
    return this.offsetSec;
  }

  setSubtitleFpsScale(scale = 1.0) {
    const val = Number(scale) || 1.0;
    this.fpsScale = (val > 0.85 && val < 1.15) ? Math.round(val * 1000000) / 1000000 : 1.0;
    this._saveMediaSyncPrefs();
    this._rebuildNativeTrackCues();
    this.onTimeUpdate(this.adapter.getTime(), true);
    return this.fpsScale;
  }

  resolveInitialAudioTrack(media) {
    const rawAudio = Array.isArray(media?.audioTracks) ? media.audioTracks.filter(Boolean) : [];
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
    if (!u || !Array.isArray(this.audioTracks) || !this.audioTracks.length) return;
    const norm = (s) => String(s || '').replace(/&proxy_segs=1/g, '');
    const uClean = norm(u);
    const curTrack = this.audioTracks.find((t) => t.id === this.selectedAudioId);
    const wasTrStudio = Boolean(curTrack && curTrack.mode !== 'tts' && (curTrack.id === 'tr-dub' || String(curTrack.id || '').startsWith('tr-dub-') || curTrack.audioLang === 'tr' || curTrack.lang === 'tr'));
    const cleanAud = (s) => norm(s).replace(/[?&]aud=[^&]*/g, '');
    const matchedTrack = this.audioTracks.find((t) => t.mode === 'stream' && t.url && norm(t.url) === uClean)
      || this.audioTracks.find((t) => t.mode === 'stream' && t.url && cleanAud(t.url) === cleanAud(uClean));
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
      if (wasTrStudio && nowOrig && this.media?.origLang !== 'tr' && (!this.selectedSubId || this.selectedSubId === 'off')) {
        const trSub = this.subtitleTracks.find((t) => String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
        if (trSub) this.setSubtitleTrack(trSub.id, true).catch(() => {});
      }
      this.adapter?.events?.onTracksChanged?.();
      return;
    }
    if (!wasTrStudio && /[?&]aud=tr\b/i.test(uClean) && this.selectedAudioId !== 'tr-ai-dub') {
      const trT = this.audioTracks.find((t) => t.id === 'tr-dub' || String(t.id || '').startsWith('tr-dub-') || (t.mode === 'stream' && (t.audioLang === 'tr' || t.lang === 'tr')));
      if (trT) {
        this.selectedAudioId = trT.id;
        if (!localStorage.getItem('vortex_sub_lang') && String(this.selectedSubId || '').toLowerCase().startsWith('tr')) {
          this._prevSubBeforeDub = this.selectedSubId;
          this.setSubtitleTrack('off', true).catch(() => {});
        }
        this.adapter?.events?.onTracksChanged?.();
        return;
      }
    }
    if (wasTrStudio && !/[?&]aud=tr\b/i.test(uClean) && (/[?&]aud=orig\b/i.test(uClean) || /hakunaymatata\.com|dragonballzfans\.xyz|vidy\.st|lightspeed\.st/i.test(uClean))) {
      const origT = this.audioTracks.find((t) => t.id === 'orig' || String(t.id || '').startsWith('orig-'));
      if (origT) this.selectedAudioId = origT.id;
      if (this.media?.origLang !== 'tr' && (!this.selectedSubId || this.selectedSubId === 'off')) {
        const trSub = this.subtitleTracks.find((t) => String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
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
    const rankTrack = (t) => {
      if (t.source === 'local') return 0;
      const synced = isStreamSyncedSub(t) ? 0 : 1;
      if (t.lang === 'tr') return 10 + synced;
      if (t.lang === 'en') return 20 + synced;
      return 30 + synced;
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
      let baseId = String(t.id || t.lang || 'sub').trim() || 'sub';
      if (baseId.startsWith('sub-') && t.lang) baseId = `stream-${t.lang}`;
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

  async initForMedia(media, opts = {}) {
    const seq = (this._mediaSeq = (this._mediaSeq || 0) + 1);
    this._skipInitStreamSwitch = Boolean(opts?.skipInitialStreamSwitch);
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
    this._loadMediaSyncPrefs(media);
    const rawSubs = Array.isArray(media.subtitleTracks) ? [...preservedLocals, ...media.subtitleTracks] : [...preservedLocals];
    this.subtitleTracks = this._dedupeSubtitleTrackIds(rawSubs);
    if (this.media) this.media.subtitleTracks = this.subtitleTracks;
    const baseUrl = media.url || '';
    const rawAudio = Array.isArray(media.audioTracks) ? media.audioTracks.filter(Boolean) : [];
    this.audioTracks = rawAudio.length
      ? [...rawAudio]
      : [
          { id: 'orig', lang: 'orig', targetLang: 'orig', audioLang: 'orig', label: '🎬 Orijinal Ses (1080p HD)', mode: 'stream', url: baseUrl },
        ];
    const hasTrSub = this.subtitleTracks.some((t) => t.lang === 'tr');
    const hasInitialAudio = rawAudio.length > 1;
    const needsSubFetch = !(this.subtitleTracks.length > 0 && hasTrSub && hasInitialAudio) && Boolean(media.tmdbId || media.imdbId || media.videoId || media.provider === 'youtube' || !this.subtitleTracks.length || !hasTrSub);
    if (needsSubFetch) {
      try {
        const queryParams = {
          tmdbId: media.tmdbId || '',
          imdbId: media.imdbId || '',
          videoId: media.videoId || '',
          mediaType: media.mediaType || 'movie',
          provider: media.catalogProvider || media.provider || 'netflix',
          title: (media.title || '').split(' — ')[0],
          season: String(media.season || 1),
          episode: String(media.episode || 1),
          _v: '20261119v227',
        };
        if (!media.tmdbId && baseUrl) queryParams.url = baseUrl;
        const qs = new URLSearchParams(queryParams);
        const r = await fetch(`/api/rave/subtitles?${qs}`);
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
        }
      } catch (e) { /* ignore */ }
    }
    if (!this.subtitleTracks.length) {
      this.selectedSubId = 'off';
    }
    this.resolveInitialAudioTrack({ ...(media || {}), audioTracks: this.audioTracks });
    const initAudTrack = this.audioTracks.find((t) => t.id === this.selectedAudioId)
      || this.audioTracks.find((t) => (t.targetLang || t.lang) === this.selectedAudioId)
      || this.audioTracks[0];
    const hasVerifiedTrStream = Boolean(
      initAudTrack && (
        initAudTrack.id === 'tr-orig'
        || ((initAudTrack.id === 'tr-dub' || initAudTrack.audioLang === 'tr' || initAudTrack.lang === 'tr')
            && (initAudTrack.url || typeof initAudTrack.hlsIndex === 'number' || typeof initAudTrack.nativeIndex === 'number'))
        || (media?.origLang === 'tr' && (!this.selectedAudioId || this.selectedAudioId === 'orig'))
        || (Array.isArray(media?.platformAudioLangs) && media.platformAudioLangs.length === 1 && media.platformAudioLangs[0] === 'tr')
      )
    );
    let savedExplicitSub = '';
    try { savedExplicitSub = localStorage.getItem('vortex_sub_lang') || ''; } catch (e) { /* ignore */ }
    if (hasVerifiedTrStream && !savedExplicitSub && String(this.selectedSubId || '').startsWith('tr')) {
      this._prevSubBeforeDub = this.selectedSubId;
      this.selectedSubId = 'off';
    } else if (!hasVerifiedTrStream && !savedExplicitSub && media?.origLang !== 'tr' && (!this.selectedSubId || this.selectedSubId === 'off')) {
      const autoTrSub = this.subtitleTracks.find((t) => String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
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
    hlsTracks.forEach((ht, idx) => {
      const rawLang = String(ht.lang || '').trim().toLowerCase();
      const rawName = String(ht.name || '').trim();
      const rawInfo = `${rawLang} ${rawName}`.toLowerCase();
      const isTr = /(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe)(?=$|[^\p{L}\p{N}])/iu.test(rawInfo);
      if (isTr) {
        const exTr = this.audioTracks.find((t) => t.id === 'tr-dub' || (t.audioLang || t.targetLang || t.lang) === 'tr');
        if (exTr) {
          exTr.hlsIndex = idx;
        } else {
          this.audioTracks.push({
            id: 'tr-dub',
            hlsIndex: idx,
            lang: 'tr',
            targetLang: 'tr',
            audioLang: 'tr',
            label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)',
            mode: 'hls',
          });
        }
        return;
      }
      if (this.audioTracks.some((t) => t.hlsIndex === idx)) return;
      const lang = rawLang || 'orig';
      const name = rawName || rawLang || 'Orijinal Ses';
      const exOrig = this.audioTracks.find((t) => t.id === 'orig' || (t.audioLang && t.audioLang !== 'tr' && typeof t.hlsIndex !== 'number'));
      if (exOrig && typeof exOrig.hlsIndex !== 'number') {
        exOrig.hlsIndex = idx;
        if (rawLang && (!exOrig.audioLang || exOrig.audioLang === 'orig')) exOrig.audioLang = rawLang;
      } else if (!this.audioTracks.some((t) => t.id === 'orig')) {
        this.audioTracks.push({
          id: 'orig',
          hlsIndex: idx,
          lang: 'orig',
          targetLang: 'orig',
          audioLang: lang,
          label: `🎬 ${name} (Orijinal Stüdyo Ses)`,
          mode: 'hls',
        });
      } else {
        const extraId = `orig-${idx}`;
        if (!this.audioTracks.some((t) => t.id === extraId)) {
          this.audioTracks.push({
            id: extraId,
            hlsIndex: idx,
            lang,
            targetLang: lang,
            audioLang: lang,
            label: `🌐 ${rawName || rawLang.toUpperCase() || 'Orijinal Ses'}`,
            mode: 'hls',
          });
        }
      }
    });
    this._applyHlsAudioSelection();
    this.adapter.events.onTracksChanged?.();
  }

  mergeNativeAudioTracks(nativeTracks) {
    if (!nativeTracks || nativeTracks.length <= 1) return;
    for (let idx = 0; idx < nativeTracks.length; idx += 1) {
      const nt = nativeTracks[idx];
      const rawLang = String(nt?.language || '').trim().toLowerCase();
      const rawName = String(nt?.label || '').trim();
      const rawInfo = `${rawLang} ${rawName}`.toLowerCase();
      const isTr = /(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe)(?=$|[^\p{L}\p{N}])/iu.test(rawInfo);
      if (isTr) {
        const exTr = this.audioTracks.find((t) => t.id === 'tr-dub' || (t.audioLang || t.targetLang || t.lang) === 'tr');
        if (exTr) exTr.nativeIndex = idx;
        else {
          this.audioTracks.push({
            id: 'tr-dub', nativeIndex: idx, lang: 'tr', targetLang: 'tr', audioLang: 'tr',
            label: '🇹🇷 Türkçe (Stüdyo Dublaj · 1080p)', mode: 'native',
          });
        }
      } else {
        if (this.audioTracks.some((t) => t.nativeIndex === idx)) continue;
        const lang = rawLang || 'orig';
        const exOrig = this.audioTracks.find((t) => t.id === 'orig' || (t.audioLang && t.audioLang !== 'tr' && typeof t.nativeIndex !== 'number'));
        if (exOrig && typeof exOrig.nativeIndex !== 'number') {
          exOrig.nativeIndex = idx;
          if (rawLang && (!exOrig.audioLang || exOrig.audioLang === 'orig')) exOrig.audioLang = rawLang;
        } else if (!this.audioTracks.some((t) => t.id === 'orig')) {
          this.audioTracks.push({
            id: 'orig', nativeIndex: idx, lang: 'orig', targetLang: 'orig',
            audioLang: lang,
            label: `🎬 ${rawName || rawLang || 'Orijinal Ses'} (Orijinal Stüdyo Ses)`, mode: 'native',
          });
        } else {
          const extraId = `orig-${idx}`;
          if (!this.audioTracks.some((t) => t.id === extraId)) {
            this.audioTracks.push({
              id: extraId, nativeIndex: idx, lang, targetLang: lang,
              audioLang: lang,
              label: `🌐 ${rawName || rawLang.toUpperCase() || 'Orijinal Ses'}`, mode: 'native',
            });
          }
        }
      }
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

  _applyHlsAudioSelection() {
    const hls = this.adapter.hls;
    const hlsTracks = hls?.audioTracks;
    if (!hls || !Array.isArray(hlsTracks) || hlsTracks.length <= 1) return;
    const track = this.audioTracks.find((t) => t.id === this.selectedAudioId) || this.audioTracks[0];
    if (!track) return;
    if (typeof track.hlsIndex === 'number' && track.hlsIndex >= 0 && track.hlsIndex < hlsTracks.length) {
      if (hls.audioTrack !== track.hlsIndex) hls.audioTrack = track.hlsIndex;
      return;
    }
    const want = (track.targetLang || track.lang || 'orig').toLowerCase();
    const wantCode = String(track.audioLang || '').toLowerCase();
    const LANG_ALIASES = {
      tr: ['tr', 'tur', 'türk', 'turkish', 'türkçe'], en: ['en', 'eng', 'english', 'ingilizce'],
      ja: ['ja', 'jpn', 'japanese', 'japonca'], ko: ['ko', 'kor', 'korean', 'korece'],
      de: ['de', 'deu', 'ger', 'german', 'almanca'], fr: ['fr', 'fra', 'fre', 'french'],
      es: ['es', 'spa', 'spanish', 'español'], it: ['it', 'ita', 'italian'], ru: ['ru', 'rus', 'russian'],
      ar: ['ar', 'ara', 'arabic'], pt: ['pt', 'por', 'portuguese'], zh: ['zh', 'zho', 'chi', 'chinese'],
      nl: ['nl', 'nld', 'dut', 'nederlands', 'dutch'],
    };
    const matchesCode = (ht, code) => {
      const words = `${ht.lang || ''} ${ht.name || ''}`.toLowerCase().split(/[^a-zçğıöşüñ]+/i);
      return (LANG_ALIASES[code] || [code]).some((a) => words.includes(a));
    };
    let targetIdx = -1;
    if (wantCode) {
      targetIdx = hlsTracks.findIndex((ht) => matchesCode(ht, wantCode));
    }
    if (targetIdx >= 0) {
      // exact language match found
    } else if (want === 'tr' || wantCode === 'tr') {
      targetIdx = hlsTracks.findIndex((ht) => /(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe)(?=$|[^\p{L}\p{N}])/iu.test(`${ht.lang || ''} ${ht.name || ''}`));
    } else {
      targetIdx = hlsTracks.findIndex((ht) => !/(?:^|[^\p{L}\p{N}])(tr|tur|türk|turkish|türkçe)(?=$|[^\p{L}\p{N}])/iu.test(`${ht.lang || ''} ${ht.name || ''}`));
    }
    if (targetIdx >= 0 && hls.audioTrack !== targetIdx) {
      hls.audioTrack = targetIdx;
      if (hls.bufferController) {
        try {
          hls.trigger(window.Hls.Events.BUFFER_FLUSHING, { startOffset: this.adapter.getTime(), endOffset: Number.POSITIVE_INFINITY, type: 'audio' });
        } catch (_) {}
      }
    }
  }

  async _loadCuesForTrack(track) {
    if (!track?.url && !track?.rawUrl) return [];
    const cacheKey = track.url || track.rawUrl;
    if (this.cuesCache.has(cacheKey)) {
      const hit = this.cuesCache.get(cacheKey);
      if (!hit.failedAt || Date.now() - hit.failedAt < 30000) return hit.cues;
      this.cuesCache.delete(cacheKey);
    }

    // Direct residential browser fetch: Upstream sources like hdfilmcehennemi.mobi and subs5.strem.io
    // support CORS (Access-Control-Allow-Origin: *) but block datacenter IPs. The browser fetches them
    // directly without 403 blocks!
    const url = String(track.url || '');
    let directUrl = track.rawUrl || '';
    if (!directUrl && url && url.includes('/api/rave/subtitle.vtt')) {
      try {
        const uObj = new URL(url, location.origin);
        directUrl = uObj.searchParams.get('url') || '';
      } catch (_) {}
    }

    if (directUrl && /^https?:\/\//i.test(directUrl) && !/[?&]translate=/i.test(url)) {
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
    this.selectedSubId = cleanId;
    if (!isInit && cleanId === 'off') {
      try { localStorage.setItem('vortex_sub_lang', 'off'); } catch (e) { /* ignore */ }
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
    const desiredLang = isInit ? normalizeClientSubLang(cleanId) : '';
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
    const targetLangForFallback = desiredLang || track.lang;
    const seq = this._mediaSeq;
    this._loadingSubTrack = true;
    try {
      let cues = await this._loadCuesForTrack(track);
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
      const wrongAutoLang = Boolean(isInit && targetLangForFallback && track._detectedLang && track._detectedLang !== targetLangForFallback);
      const isForcedOrTruncated = track.source === 'local'
        ? false
        : (isInit
          ? (isStreamEmbeddedFansub
            ? (cues.length < 20)
            : (cues.length < 35 || (cues.length < 45 && getSpan(cues) < minEnd)))
          : false);
      if (wrongAutoLang || isForcedOrTruncated || cues.length === 0) {
        const alts = this.subtitleTracks.filter((t) => t.id !== track.id && t.lang === targetLangForFallback);
        for (const alt of alts) {
          const altCues = await this._loadCuesForTrack(alt);
          if (this._destroyed || this._mediaSeq !== seq || this._subTrackSeq !== myTrackSeq) return null;
          if (isInit && alt._detectedLang && targetLangForFallback && alt._detectedLang !== targetLangForFallback) continue;
          const curSpan = getSpan(cues);
          const altSpan = getSpan(altCues);
          if (wrongAutoLang && altCues.length >= 20) {
            track = alt;
            cues = altCues;
            break;
          }
          if ((altCues.length >= 60 && altSpan >= minEnd) || (altCues.length > cues.length && altSpan > curSpan) || (cues.length === 0 && altCues.length > 0)) {
            track = alt;
            cues = altCues;
            if (cues.length >= 60 && altSpan >= minEnd) break;
          }
        }
      }
      if (!isInit) {
        const persistLang = String(track.lang || '').toLowerCase().trim() || (cleanId.startsWith('sub-') ? 'tr' : cleanId);
        try { localStorage.setItem('vortex_sub_lang', persistLang); } catch (e) { /* ignore */ }
      }
      if (this._destroyed || this._mediaSeq !== seq || this._subTrackSeq !== myTrackSeq) return null;
      this.selectedSubId = track.id;
      this.subCues = cues;
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
    this.secondaryCues = [];
  }

  async setDualSubtitle() {
    this.dualSubEnabled = false;
    this.secondaryCues = [];
    this.onTimeUpdate(this.adapter.getTime(), true);
    this.adapter.events.onTracksChanged?.();
    return false;
  }

  async setAudioTrack(id, isInit = false) {
    const normId = (id === 'tr' || id === 'tur' || id === 'turkish') ? 'tr-dub' : (id || 'orig');
    const cleanId = normId;
    this.selectedAudioId = cleanId;
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
      if (this.selectedSubId && this.selectedSubId !== 'off' && String(this.selectedSubId).startsWith('tr')) {
        this._prevSubBeforeDub = this.selectedSubId;
        await this.setSubtitleTrack('off', true);
      }
    } else if (!isInit && this.media?.origLang !== 'tr' && (track.id === 'orig' || (track.lang !== 'tr' && track.audioLang !== 'tr'))) {
      if (!this.selectedSubId || this.selectedSubId === 'off') {
        const trFallback = this.subtitleTracks.find((t) => String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
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

    const cleanUrl = (u) => String(u || '').replace(/&proxy_segs=1/g, '');
    const hlsHasMulti = Array.isArray(this.adapter?.hls?.audioTracks) && this.adapter.hls.audioTracks.length > 1;
    if (typeof track.hlsIndex === 'number' && hlsHasMulti) {
      this._applyHlsAudioSelection();
    } else if (!(isInit && this._skipInitStreamSwitch) && track.mode === 'stream' && track.url && this.adapter.currentUrl && cleanUrl(track.url) !== cleanUrl(this.adapter.currentUrl)) {
      await this.adapter.switchStreamSource(track.url);
    } else {
      if (isInit && this._skipInitStreamSwitch && track.mode === 'stream' && track.url) {
        this.adapter?._pushFallbackAlt?.(track.url);
      }
      this._applyHlsAudioSelection();
      this._applyNativeAudioSelection();
    }
    this.syncVideoVolume();
    this.adapter.events.onTracksChanged?.();
    return track;
  }

  findCueAt(cues, t) {
    if (!cues || !cues.length || !Number.isFinite(t)) return null;
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
    if (idx < 0) return null;
    const active = [];
    for (let i = idx; i >= 0; i -= 1) {
      const c = cues[i];
      if ((c.maxEnd ?? c.end) < t) break;
      if (t >= c.start && t <= c.end) {
        active.push(c);
        if (active.length >= 2) break;
      }
    }
    if (!active.length) return null;
    active.reverse();
    const uniqueLines = [];
    const seenNorm = new Set();
    for (const item of active) {
      const parts = String(item.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const ln of parts) {
        const normKey = ln.toLocaleLowerCase('tr').replace(/\u0307/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || ln.trim();
        if (!normKey || seenNorm.has(normKey)) continue;
        seenNorm.add(normKey);
        uniqueLines.push(ln);
      }
    }
    return { start: active[0].start, end: active[active.length - 1].end, text: uniqueLines.join('\n') };
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
      const cue = this.findCueAt(this.subCues, adjT);
      const txt = cue ? cue.text : '';
      this._lastFastTrackId = this.selectedSubId;
      if (cue) {
        this._lastFastCueStart = Number(cue.start) || 0;
        this._lastFastCueEnd = Number(cue.end) || 0;
      } else {
        this._lastFastCueStart = 0;
        this._lastFastCueEnd = 0;
      }
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
    const duckOn = localStorage.getItem('vortex_voice_duck') !== 'off';
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
