// Rave VideoPlayerControlsFC Subtitle (selectTextTrack / VTTCue) & Studio Multi-Audio HLS (audioTracks) Engine.

const DEFAULT_PREFS = {
  color: 'white',       // 'white' | 'yellow' | 'cyan'
  font: 'sans-serif',   // 'sans-serif' | 'serif' | 'monospace' | 'cursive'
  size: 1.0,            // 0.8 | 1.0 | 1.25 | 1.5
  bgOpacity: 0.65,      // 0..1
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
        if (body && end > start) rawCues.push({ start, end, text: body });
      }
    }
  }
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
          .replace(/<[^>]+>/g, '')
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/[♪♫♬♩]+/g, ' ')
          .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\))\s*$/g, '')
          .trim())
        .filter((l) => l && !/^(?:müzik|şarkı|music|song|alkış|applause|gülüşmeler|kahkaha|laughter|sessizlik|silence|iç çeker|sighs|inler|groans|nefes alır|gasps)$/i.test(l));
      const dedupLines = [];
      for (const rl of rawLines) {
        if (!dedupLines.length || dedupLines[dedupLines.length - 1] !== rl) {
          dedupLines.push(rl);
        }
      }
      if (dedupLines.length === 4 && dedupLines[0] === dedupLines[2] && dedupLines[1] === dedupLines[3]) {
        dedupLines.splice(2, 2);
      }
      const clean = dedupLines.join('\n').trim();
      if (clean && end > start && !/(?:opensubtitles|osdb\.link|advertise your product|do you want subtitles for any video|çevrimiçi filmleri ve dizileri ücretsiz izleyin|subscene\.com|turkcealtyazi\.org|altyazi\.org|yutukluklar|çeviri\s*:|senkron\s*:|iyi seyirler dileriz)/i.test(clean)) {
        rawCues.push({ start, end, text: clean });
      }
    } else {
      i += 1;
    }
  }
  rawCues.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const cues = [];
  let runningMaxEnd = 0;
  for (let k = 0; k < rawCues.length; k += 1) {
    const c = rawCues[k];
    const prev = cues.length ? cues[cues.length - 1] : null;
    if (prev && (Math.abs(prev.start - c.start) < 0.35 || c.start < prev.end) && prev.text === c.text) {
      prev.end = Math.max(prev.end, c.end);
      runningMaxEnd = Math.max(runningMaxEnd, prev.end);
      prev.maxEnd = runningMaxEnd;
      continue;
    }
    runningMaxEnd = Math.max(runningMaxEnd, c.end);
    cues.push({ idx: cues.length, start: c.start, end: c.end, maxEnd: runningMaxEnd, text: c.text });
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
    const savedAud = localStorage.getItem('vortex_audio_lang') || 'orig';
    this.selectedAudioId = /^src-\d+$/.test(savedAud) ? 'orig' : savedAud;
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
      window.__kinoxSyncDuckVolume = () => this.syncVideoVolume();
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

  _detectIntroFromCues(cues, media) {
    if (!Array.isArray(cues) || cues.length < 15) return null;
    const isTv = (media?.mediaType || '').toLowerCase() === 'tv';
    if (!isTv) return null;
    const creditRe = /(çeviri|altyazı|subtitle|opensubtitles|synced|iyi seyirler|www\.|http)/i;
    const sdhRe = /^(?:\[[^\]]+\]|\([^)]+\)|♪.*♪)$/;
    const spoken = cues.filter((c) => !creditRe.test(c.text || '') && !sdhRe.test((c.text || '').trim()));
    const credits = cues.filter((c) => creditRe.test(c.text || '') && c.start >= 15 && c.start <= 210);
    if (!spoken.length) return null;
    const firstSt = spoken[0].start;
    if (credits.length) {
      const c0 = credits[0];
      const prevS = spoken.filter((x) => x.end <= c0.start + 2);
      const nextS = spoken.filter((x) => x.start >= c0.end - 1);
      const gStart = prevS.length ? prevS[prevS.length - 1].end + 1.0 : 2.0;
      const gEnd = nextS.length ? nextS[0].start - 1.0 : c0.end + 5.0;
      if (gStart <= 210 && gEnd - gStart >= 18 && gEnd - gStart <= 95) {
        return { start: Math.round(Math.max(2, gStart) * 10) / 10, end: Math.round(Math.min(gStart + 90, gEnd) * 10) / 10, label: '⏩ İntroyu Atla' };
      }
    }
    if (firstSt >= 18 && firstSt <= 85) {
      return { start: 2, end: Math.round((firstSt - 1.0) * 10) / 10, label: '⏩ İntroyu Atla' };
    }
    for (let i = 0; i < spoken.length - 1; i += 1) {
      if (spoken[i].end > 210) break;
      const gap = spoken[i + 1].start - spoken[i].end;
      if (gap >= 24 && gap <= 90) {
        return { start: Math.round((spoken[i].end + 1.0) * 10) / 10, end: Math.round((spoken[i + 1].start - 1.0) * 10) / 10, label: '⏩ İntroyu Atla' };
      }
    }
    return null;
  }

  _rebuildNativeTrackCues() {
    try {
      const v = this.adapter?.video;
      const trEl = v?.querySelector?.('track');
      const tt = trEl?.track;
      const CueCls = window.VTTCue || window.TextTrackCue;
      if (!tt || !CueCls || !this.subCues.length) return;
      while (tt.cues && tt.cues.length > 0) {
        tt.removeCue(tt.cues[0]);
      }
      const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
      const off = this.offsetSec || 0;
      for (const c of this.subCues) {
        try { tt.addCue(new CueCls(Math.max(0, (c.start + off) / scale), Math.max(0.1, (c.end + off) / scale), c.text)); } catch (_) {}
      }
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
    this.intro = media?.intro || null;
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
    if (media.tmdbId || media.imdbId || media.videoId || media.provider === 'youtube' || !this.subtitleTracks.length || !hasTrSub) {
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
            this.audioTracks = data.audioTracks.filter(Boolean);
            if (this.media) this.media.audioTracks = this.audioTracks;
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
    const isTurkishSpeechActive = Boolean(
      initAudTrack && (
        initAudTrack.id === 'tr-orig'
        || initAudTrack.id === 'tr-dub'
        || initAudTrack.audioLang === 'tr'
        || initAudTrack.lang === 'tr'
        || (media?.origLang === 'tr' && (!this.selectedAudioId || this.selectedAudioId === 'orig'))
        || (Array.isArray(media?.platformAudioLangs) && media.platformAudioLangs.length === 1 && media.platformAudioLangs[0] === 'tr')
      )
    );
    if (isTurkishSpeechActive && String(this.selectedSubId || '').startsWith('tr')) {
      this._prevSubBeforeDub = this.selectedSubId;
      this.selectedSubId = 'off';
    }
    await this.setSubtitleTrack(this.selectedSubId, true);
    await this.setAudioTrack(this.selectedAudioId, true);
    this.adapter.events.onTracksChanged?.();
    if (!this.intro && this.subtitleTracks.length) {
      (async () => {
        for (const st of this.subtitleTracks.slice(0, 2)) {
          const cues = await this._loadCuesForTrack(st);
          const det = this._detectIntroFromCues(cues, media);
          if (det) {
            this.intro = det;
            break;
          }
        }
      })().catch(() => {});
    }
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

  _disableAllNativeTextTracks() {
    const v = this.adapter?.video;
    if (!v || !v.textTracks) return;
    const nativeVideoFs = Boolean(
      v.webkitDisplayingFullscreen ||
      document.fullscreenElement === v ||
      document.webkitFullscreenElement === v ||
      document.pictureInPictureElement === v
    );
    if (nativeVideoFs) return;
    for (let i = 0; i < v.textTracks.length; i += 1) {
      try {
        if (v.textTracks[i].mode !== 'disabled') v.textTracks[i].mode = 'disabled';
      } catch (e) { /* ignore */ }
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
    if (v.textTracks) {
      for (let i = 0; i < v.textTracks.length; i += 1) {
        const tt = v.textTracks[i];
        try {
          tt.mode = 'disabled';
          while (tt.cues && tt.cues.length > 0) {
            tt.removeCue(tt.cues[0]);
          }
        } catch (e) { /* ignore */ }
      }
    }
    v.querySelectorAll('track').forEach((t) => t.remove());
    this._disableAllNativeTextTracks();
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
      document.removeEventListener('webkitfullscreenchange', this._fsHandler);
      this._fsHandler = null;
    }
    if (!track?.url || !this.subCues.length) return;
    try {
      const vttBlobUrl = this._buildSyncedVttBlob();
      const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const trEl = document.createElement('track');
      trEl.kind = 'subtitles';
      trEl.label = track.label || 'Altyazı';
      trEl.srclang = track.lang || 'tr';
      trEl.src = isAppleMobile ? (track.url || vttBlobUrl) : (vttBlobUrl || track.url);
      v.appendChild(trEl);
      try {
        if (trEl.track) {
          const isFsOrPip = Boolean(v.webkitDisplayingFullscreen || document.fullscreenElement === v || document.webkitFullscreenElement === v || document.pictureInPictureElement === v);
          trEl.track.mode = isFsOrPip ? 'showing' : 'hidden';
        }
      } catch (e) { /* ignore */ }
      let srcSettled = false;
      const dedupTrackCues = (tt) => {
        if (!tt || !tt.cues || tt.cues.length < 1) return;
        const seen = new Set();
        const toRemove = [];
        for (let i = 0; i < tt.cues.length; i += 1) {
          const c = tt.cues[i];
          const rawTxt = String(c.text || '').trim();
          const lines = rawTxt.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length === 4 && lines[0] === lines[2] && lines[1] === lines[3]) {
            try { c.text = `${lines[0]}\n${lines[1]}`; } catch (e) { /* ignore */ }
          } else if (lines.length === 2 && lines[0] === lines[1]) {
            try { c.text = lines[0]; } catch (e) { /* ignore */ }
          }
          const key = `${Math.round((c.startTime || 0) * 4)}|${(c.text || '').trim()}`;
          if (seen.has(key)) toRemove.push(c);
          else seen.add(key);
        }
        for (const c of toRemove) {
          try { tt.removeCue(c); } catch (e) { /* ignore */ }
        }
      };
      const ensureNativeCues = () => {
        const tt = trEl.track;
        if (!tt) return;
        dedupTrackCues(tt);
        if (tt.cues && tt.cues.length > 0) return;
        if (!srcSettled && trEl.readyState < 2) return;
        const CueCls = window.VTTCue || window.TextTrackCue;
        if (CueCls && (!tt.cues || tt.cues.length === 0)) {
          try { trEl.removeAttribute('src'); } catch (e) { /* ignore */ }
          const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
          const off = this.offsetSec || 0;
          for (const c of this.subCues) {
            try { tt.addCue(new CueCls(Math.max(0, (c.start + off) / scale), Math.max(0.1, (c.end + off) / scale), c.text)); } catch (e) { /* ignore */ }
          }
        }
      };
      const setMode = () => {
        const nativeVideoFs = Boolean(
          v.webkitDisplayingFullscreen ||
          document.fullscreenElement === v ||
          document.webkitFullscreenElement === v
        );
        if (v.textTracks) {
          for (let i = 0; i < v.textTracks.length; i += 1) {
            const tt = v.textTracks[i];
            if (tt !== trEl.track && tt.mode !== 'disabled') tt.mode = 'disabled';
          }
        }
        if (trEl.track) {
          ensureNativeCues();
          dedupTrackCues(trEl.track);
          trEl.track.mode = nativeVideoFs ? 'showing' : 'hidden';
        }
        this.onTimeUpdate(this.adapter.getTime(), true);
      };
      trEl.addEventListener('load', () => { srcSettled = true; dedupTrackCues(trEl.track); setMode(); }, { once: true });
      trEl.addEventListener('error', () => { srcSettled = true; setMode(); }, { once: true });
      setTimeout(() => { srcSettled = true; setMode(); }, 650);
      v.addEventListener('webkitbeginfullscreen', setMode);
      v.addEventListener('webkitendfullscreen', setMode);
      this._fsHandler = setMode;
      document.addEventListener('fullscreenchange', setMode);
      document.addEventListener('webkitfullscreenchange', setMode);
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
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('windows-1254').decode(buf); } catch (_) {}
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
      try { localStorage.setItem('vortex_audio_lang', cleanId); } catch (e) { /* ignore */ }
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
      if (this._prevSubBeforeDub && (!this.selectedSubId || this.selectedSubId === 'off')) {
        const restoreId = this._prevSubBeforeDub;
        this._prevSubBeforeDub = null;
        await this.setSubtitleTrack(restoreId, true);
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
    if (typeof track.hlsIndex === 'number' && hlsHasMulti) {
      this._applyHlsAudioSelection();
    } else if (track.url && this.adapter.currentUrl && cleanUrl(track.url) !== cleanUrl(this.adapter.currentUrl)) {
      this.adapter.switchStreamSource(track.url);
    } else {
      this._applyHlsAudioSelection();
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
    if (active.length === 1) return active[0];
    active.reverse();
    const uniqueLines = [...new Set(active.map((x) => x.text.trim()).filter(Boolean))];
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
    const nativeVideoFs = Boolean(
      v && (v.webkitDisplayingFullscreen || document.fullscreenElement === v || document.webkitFullscreenElement === v || document.pictureInPictureElement === v)
    );
    const scale = Number.isFinite(this.fpsScale) && this.fpsScale > 0.8 ? this.fpsScale : 1.0;
    const adjT = (t * scale) - (this.offsetSec || 0);
    if (!this._loadingSubTrack && !this.subCues.length && this.selectedSubId !== 'off' && this.subtitleTracks.length) {
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
    const voiceDuck = (duckOn && typeof window !== 'undefined' && typeof window.__kinoxVoiceDuckFactor === 'number')
      ? window.__kinoxVoiceDuckFactor
      : 1.0;
    const ttsDuck = (this.ttsDubActive && this._ttsSpeaking) ? 0.22 : 1.0;
    const duckFactor = Math.min(voiceDuck, ttsDuck);
    const v = this.adapter?.video;
    if (v) {
      v.volume = Math.min(1, Math.max(0, ((this.adapter.baseVolume ?? 80) / 100) * duckFactor));
    }
    if (this.adapter?.player?.setVolume) {
      try {
        this.adapter.player.setVolume(Math.round((this.adapter.baseVolume ?? 80) * duckFactor));
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
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
      document.removeEventListener('webkitfullscreenchange', this._fsHandler);
      this._fsHandler = null;
    }
    if (this.blobUrl) {
      try { URL.revokeObjectURL(this.blobUrl); } catch (e) { /* ignore */ }
      this.blobUrl = null;
    }
  }
}
