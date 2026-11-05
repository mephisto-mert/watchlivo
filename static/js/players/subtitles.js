// Rave VideoPlayerControlsFC Subtitle (selectTextTrack / VTTCue) & Studio Multi-Audio HLS (audioTracks) Engine.
import { applyElementVolume, isIosWebKit } from './audio-gain.js?v=20261105_v110';

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
    const assRe = /^Dialogue:\s*[^,]*,(\d+:\d{2}:\d{2}[.,]\d{2,3}),(\d+:\d{2}:\d{2}[.,]\d{2,3}),(?:[^,]*,){6}(.+)$/;
    const parseAssSec = (ts) => {
      const p = ts.replace(',', '.').split(':');
      const sp = (p[2] || '0').split('.');
      const ms = (sp[1] || '0').padEnd(3, '0').slice(0, 3);
      return parseTimeSec(p[0], p[1], sp[0], ms);
    };
    for (const rawLn of lines) {
      const mAss = assRe.exec(rawLn.trim());
      if (mAss) {
        const start = parseAssSec(mAss[1]);
        const end = Math.min(parseAssSec(mAss[2]), start + 22.0);
        const body = mAss[3]
          .replace(/\\[nN]/g, '\n')
          .replace(/\\h/g, ' ')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (body && end > start) rawCues.push({ start, end, text: body, norm: String(body).toLowerCase().replace(/[^a-z0-9çğıöşüа-яё]+/gi, ' ').trim() });
      }
    }
  } else {
  const timeRe = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/;
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i].trim();
    const m = timeRe.exec(ln);
    if (m) {
      const start = parseTimeSec(m[1], m[2], m[3], m[4]);
      const rawEnd = parseTimeSec(m[5], m[6], m[7], m[8]);
      const end = Math.min(rawEnd, start + 22.0);
      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i += 1;
      }
      const rawLines = textLines
        .map((l) => l
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/<[^>]*>/g, '')
          .replace(/[<>]/g, '')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/[♪♫♬♩]+/g, ' ')
          .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/g, '')
          .trim())
        .filter((l) => l && !/^(?:müzik|şarkı|music|song|alkış|applause|gülüşmeler|kahkaha|laughter|sessizlik|silence|iç çeker|sighs|inler|groans|nefes alır|gasps)$/i.test(l));
      const normSubLine = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9çğıöşüа-яё]+/gi, ' ').trim();
      const dedupLines = [];
      const seenLineNorms = new Set();
      for (const rl of rawLines) {
        const nl = normSubLine(rl);
        if (!nl || seenLineNorms.has(nl)) continue;
        seenLineNorms.add(nl);
        dedupLines.push(rl);
      }
      const clean = dedupLines.join('\n').trim();
      if (clean && end > start && !/(?:opensubtitles|osdb\.link|advertise your product|do you want subtitles for any video|çevrimiçi filmleri ve dizileri ücretsiz izleyin|subscene\.com|turkcealtyazi\.org|altyazi\.org|yutukluklar|çeviri\s*:|senkron\s*:|iyi seyirler dileriz)/i.test(clean)) {
        rawCues.push({ start, end, text: clean, norm: normSubLine(clean) });
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

export class SubtitleDubController {
  constructor(adapter) {
    this.adapter = adapter;
    this.media = null;
    this.intro = null;
    this.subtitleTracks = [];
    this.audioTracks = [];
    this.selectedSubId = localStorage.getItem('vortex_sub_lang') || 'tr';
    const savedAud = localStorage.getItem('vortex_audio_proxy_pref') || 'tr-dub';
    this.selectedAudioId = /^src-\d+$/.test(savedAud) ? 'tr-dub' : savedAud;
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
    this._loadingSubTrack = false;
    this.ttsDubActive = false;
    this.ttsLang = 'tr';
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
        if (Number.isFinite(Number(parsed.offsetSec))) this.offsetSec = Number(parsed.offsetSec);
        if (Number.isFinite(Number(parsed.fpsScale)) && parsed.fpsScale > 0.8 && parsed.fpsScale < 1.2) {
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

  async initForMedia(media) {
    this.media = media;
    this.intro = null;
    this.subCues = [];
    this.dubCues = [];
    this.secondaryCues = [];
    this.activeCueText = '';
    this.activeSecondaryCueText = '';
    this._autoHealedLang = '';
    this._loadMediaSyncPrefs(media);
    this.subtitleTracks = Array.isArray(media.subtitleTracks) ? [...media.subtitleTracks] : [];
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
          _v: '20261029V8',
        };
        if (!media.tmdbId && baseUrl) queryParams.url = baseUrl;
        const qs = new URLSearchParams(queryParams);
        const r = await fetch(`/api/rave/subtitles?${qs}`);
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data.subtitleTracks) && data.subtitleTracks.length) {
            const existing = Array.isArray(this.subtitleTracks) ? this.subtitleTracks : [];
            const seenUrls = new Set(existing.map((t) => t.url));
            const merged = [...existing];
            for (const incoming of data.subtitleTracks) {
              if (!incoming || !incoming.url || seenUrls.has(incoming.url)) continue;
              seenUrls.add(incoming.url);
              const langCnt = merged.filter((x) => x.lang === incoming.lang).length;
              const nextId = langCnt === 0 ? incoming.lang : `${incoming.lang}-${langCnt + 1}`;
              merged.push({ ...incoming, id: nextId });
            }
            this.subtitleTracks = merged;
            if (this.media) this.media.subtitleTracks = merged;
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
    if (this.selectedAudioId === 'tr-ai-dub' || this.selectedAudioId === 'en-ai-dub') {
      this.selectedAudioId = 'orig';
    }
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
    }
    await this.setSubtitleTrack(this.selectedSubId, true);
    await this.setAudioTrack(this.selectedAudioId, true);
    this.adapter.events.onTracksChanged?.();
  }

  mergeHlsAudioTracks(hlsTracks) {
    if (!Array.isArray(hlsTracks) || hlsTracks.length <= 1) return;
    hlsTracks.forEach((ht, idx) => {
      const rawInfo = `${ht.lang || ''} ${ht.name || ''}`.toLowerCase();
      const isTr = /\b(tr|tur|türk|turkish|türkçe)\b/i.test(rawInfo);
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
      const exOrig = this.audioTracks.find((t) => t.id === 'orig' || (t.audioLang && t.audioLang !== 'tr'));
      if (exOrig && typeof exOrig.hlsIndex !== 'number') {
        exOrig.hlsIndex = idx;
      } else if (!exOrig) {
        const lang = (ht.lang || 'orig').toLowerCase();
        const name = ht.name || ht.lang || `Orijinal Ses`;
        this.audioTracks.unshift({
          id: 'orig',
          hlsIndex: idx,
          lang: 'orig',
          targetLang: 'orig',
          audioLang: lang,
          label: `🎬 ${name} (Orijinal Stüdyo Ses)`,
          mode: 'hls',
        });
      }
    });
    this._applyHlsAudioSelection();
    this.adapter.events.onTracksChanged?.();
  }

  mergeNativeAudioTracks(nativeTracks) {
    if (!nativeTracks || nativeTracks.length <= 1) return;
    for (let idx = 0; idx < nativeTracks.length; idx += 1) {
      const nt = nativeTracks[idx];
      const rawInfo = `${nt?.language || ''} ${nt?.label || ''}`.toLowerCase();
      const isTr = /\b(tr|tur|türk|turkish|türkçe)\b/i.test(rawInfo);
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
        const exOrig = this.audioTracks.find((t) => t.id === 'orig' || (t.audioLang && t.audioLang !== 'tr'));
        if (exOrig && typeof exOrig.nativeIndex !== 'number') exOrig.nativeIndex = idx;
        else if (!exOrig) {
          this.audioTracks.unshift({
            id: 'orig', nativeIndex: idx, lang: 'orig', targetLang: 'orig',
            audioLang: (nt?.language || 'orig').toLowerCase(),
            label: `🎬 ${nt?.label || nt?.language || 'Orijinal Ses'} (Orijinal Stüdyo Ses)`, mode: 'native',
          });
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
        const isTr = /\b(tr|tur|türk|turkish|türkçe)\b/i.test(`${nativeTracks[i]?.language || ''} ${nativeTracks[i]?.label || ''}`);
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
      targetIdx = hlsTracks.findIndex((ht) => /\b(tr|tur|türk|turkish|türkçe)\b/i.test(`${ht.lang || ''} ${ht.name || ''}`));
    } else {
      targetIdx = hlsTracks.findIndex((ht) => !/\b(tr|tur|türk|turkish|türkçe)\b/i.test(`${ht.lang || ''} ${ht.name || ''}`));
    }
    if (targetIdx >= 0 && hls.audioTrack !== targetIdx) {
      hls.audioTrack = targetIdx;
    }
  }

  async _loadCuesForTrack(track) {
    if (!track?.url) return [];
    if (this.cuesCache.has(track.url)) return this.cuesCache.get(track.url).cues;
    try {
      const r = await fetch(track.url);
      if (!r.ok) return [];
      const vtt = await r.text();
      const cues = parseVtt(vtt);
      this.cuesCache.set(track.url, { vtt, cues });
      return cues;
    } catch (e) {
      return [];
    }
  }

  _isNativeSubView(v) {
    return Boolean(
      v && (
        v.webkitDisplayingFullscreen ||
        v.webkitPresentationMode === 'picture-in-picture' ||
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

  _buildSyncedVttBlob() {
    if (this.blobUrl) {
      try { URL.revokeObjectURL(this.blobUrl); } catch (e) { /* ignore */ }
      this.blobUrl = null;
    }
    if (!this.subCues || !this.subCues.length) return null;
    const fmt = (sec) => {
      const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
      const ms = totalMs % 1000;
      const totalS = Math.floor(totalMs / 1000);
      const ss = totalS % 60;
      const mm = Math.floor(totalS / 60) % 60;
      const hh = Math.floor(totalS / 3600);
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    };
    const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
    const off = this.offsetSec || 0;
    const lines = ['WEBVTT', ''];
    for (const c of this.subCues) {
      const st = (c.start + off) / scale;
      const en = (c.end + off) / scale;
      if (en > 0 && en > st) {
        lines.push(`${fmt(st)} --> ${fmt(en)}`);
        lines.push(c.text);
        lines.push('');
      }
    }
    try {
      this.blobUrl = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/vtt' }));
      return this.blobUrl;
    } catch (e) {
      return null;
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
    this.selectedSubId = cleanId;
    if (!isInit) {
      try { localStorage.setItem('vortex_sub_lang', cleanId); } catch (e) { /* ignore */ }
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
    let track = this.subtitleTracks.find((t) => t.id === cleanId)
      || this.subtitleTracks.find((t) => t.lang === cleanId)
      || this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith(cleanId))
      || this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith('tr'))
      || this.subtitleTracks[0];
    if (!track) {
      this.subCues = [];
      this.secondaryCues = [];
      this.activeCueText = '';
      this.activeSecondaryCueText = '';
      this.adapter?._syncYtNativeCaptions?.();
      this.adapter.events.onSubtitleCue?.('', '');
      return null;
    }
    this._loadingSubTrack = true;
    try {
      let cues = await this._loadCuesForTrack(track);
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
      const isStreamEmbeddedFansub = track.source === 'fansub' || track.source === 'local';
      const isForcedOrTruncated = isStreamEmbeddedFansub
        ? (cues.length < 20)
        : (cues.length < 35 || (isInit && cues.length < 45 && getSpan(cues) < minEnd));
      if (isForcedOrTruncated) {
        const alts = this.subtitleTracks.filter((t) => t.id !== track.id && t.lang === track.lang);
        for (const alt of alts) {
          const altCues = await this._loadCuesForTrack(alt);
          const curSpan = getSpan(cues);
          const altSpan = getSpan(altCues);
          if ((altCues.length >= 60 && altSpan >= minEnd) || (altCues.length > cues.length && altSpan > curSpan)) {
            track = alt;
            cues = altCues;
            if (cues.length >= 60 && altSpan >= minEnd) break;
          }
        }
      }
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
      this._loadingSubTrack = false;
    }
  }

  async loadLocalSubtitleFile(file) {
    if (!file) return null;
    try {
      const buf = await file.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let text = '';
      if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
        text = new TextDecoder('utf-16le').decode(buf);
      } else if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
        text = new TextDecoder('utf-16be').decode(buf);
      } else {
        text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('\uFFFD')) {
          try { text = new TextDecoder('windows-1254').decode(buf); } catch (_) {}
        }
      }
      const cues = parseVtt(text);
      if (!cues.length) return null;
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
        lang: 'tr',
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
    const cleanId = id || 'orig';
    this.selectedAudioId = cleanId;
    if (!isInit && !/^src-\d+$/.test(cleanId)) {
      try {
        localStorage.setItem('vortex_audio_proxy_pref', cleanId);
        localStorage.setItem('vortex_audio_lang', cleanId);
      } catch (e) { /* ignore */ }
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
    } else if (!isInit && (track.id === 'orig' || (track.lang !== 'tr' && track.audioLang !== 'tr'))) {
      if (!this.selectedSubId || this.selectedSubId === 'off') {
        const trFallback = this.subtitleTracks.find((t) => String(t.lang || t.id || '').toLowerCase().startsWith('tr'));
        const restoreId = this._prevSubBeforeDub || trFallback?.id || '';
        this._prevSubBeforeDub = null;
        if (restoreId) await this.setSubtitleTrack(restoreId, true);
      }
    }

    if (track.mode === 'tts' || track.id === 'tr-ai-dub' || track.id === 'en-ai-dub') {
      this.ttsDubActive = true;
      this.ttsLang = (track.audioLang || track.targetLang || track.lang || 'tr').toLowerCase();
      const dubSub = this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith(this.ttsLang))
        || this.subtitleTracks.find((t) => (t.lang || '').toLowerCase().startsWith('tr'))
        || this.subtitleTracks[0];
      if (dubSub) {
        this.dubCues = await this._loadCuesForTrack(dubSub);
      }
      this.syncVideoVolume();
      this.adapter.events.onTracksChanged?.();
      return track;
    }

    const cleanUrl = (u) => String(u || '').replace(/&proxy_segs=1/g, '');
    const hlsHasMulti = Array.isArray(this.adapter?.hls?.audioTracks) && this.adapter.hls.audioTracks.length > 1;
    if (typeof track.hlsIndex === 'number' && hlsHasMulti && (!track.url || cleanUrl(track.url) === cleanUrl(this.adapter.currentUrl))) {
      this._applyHlsAudioSelection();
    } else if (!isInit && track.url && this.adapter.currentUrl && cleanUrl(track.url) !== cleanUrl(this.adapter.currentUrl)) {
      this.adapter.switchStreamSource(track.url);
    } else {
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
        const normKey = ln.toLowerCase().replace(/[^a-z0-9çğıöşü]+/gi, ' ').trim();
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
    this.adapter?.events?.onSubtitleCue?.('', '');
  }

  async _tryHealTruncatedTrack(adjT) {
    const curTrack = this.subtitleTracks.find((t) => t.id === this.selectedSubId);
    if (!curTrack) return;
    if (this._autoHealedLang === `${curTrack.id}:${Math.floor(adjT / 300)}`) return;
    const alts = this.subtitleTracks.filter((t) => t.id !== curTrack.id && t.lang === curTrack.lang);
    for (const alt of alts) {
      const altCues = await this._loadCuesForTrack(alt);
      const lastEnd = altCues.length ? altCues[altCues.length - 1].end : 0;
      if (lastEnd >= adjT + 30 && altCues.length >= 40) {
        this._autoHealedLang = `${curTrack.id}:${Math.floor(adjT / 300)}`;
        this.selectedSubId = alt.id;
        this.subCues = altCues;
        this._attachNativeTrack(alt);
        this.onTimeUpdate(this.adapter.getTime(), true);
        this.adapter.events.onTracksChanged?.();
        return;
      }
    }
  }

  onTimeUpdate(t, forceEmit = false) {
    if (!Number.isFinite(t)) return;
    this._disableAllNativeTextTracks();
    const v = this.adapter?.video;
    const nativeVideoFs = this._isNativeSubView(v);
    const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
    const adjT = (t * scale) - (this.offsetSec || 0);
    const curSubObj = this.subtitleTracks.find((tr) => tr.id === this.selectedSubId);
    if (!this._loadingSubTrack && !this.subCues.length && this.selectedSubId !== 'off' && curSubObj?.source !== 'youtube-native' && this.subtitleTracks.length) {
      const nowMs = Date.now();
      if (!this._lastEmptyReload || nowMs - this._lastEmptyReload > 8000) {
        this._lastEmptyReload = nowMs;
        this.cuesCache.clear();
        this.setSubtitleTrack(this.selectedSubId, true).catch(() => {});
      }
    }
    if (!this._loadingSubTrack && !this.subCues.length && this.selectedSubId !== 'off' && this.subtitleTracks.length > 1) {
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
      const dubList = (this.dubCues && this.dubCues.length) ? this.dubCues : this.subCues;
      const dCue = this.findCueAt(dubList, adjT);
      const dTxt = dCue ? String(dCue.text || '').replace(/\s+/g, ' ').trim() : '';
      if (dTxt && dTxt !== this._lastTtsText) {
        this._lastTtsText = dTxt;
        this._speakTtsCue(dTxt);
      }
    }
  }

  _speakTtsCue(text) {
    if (!text) return;
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
      } catch (e) { /* ignore */ }
    }
    this.syncVideoVolume();
  }
  unlockDubAudio() {}

  destroy() {
    this._destroyed = true;
    this.stopDubAudio();
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
