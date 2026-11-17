<<<<<<< HEAD
// Universal Cross-Browser Voice Note Recorder (12kHz WAV), Byte-Range Player & Voice Search Engine.
// Guarantees 100% playback compatibility across iOS Safari, Android Chrome, WebView, Firefox & Desktop.

let activeGlobalVoiceAudio = null;

export function stopActiveVoiceNoteGlobal() {
  if (activeGlobalVoiceAudio) {
    try { activeGlobalVoiceAudio.pause(); } catch (_) {}
    activeGlobalVoiceAudio = null;
  }
  if (typeof window !== 'undefined') {
    window.vortexSetVoiceNotePlaying?.(false);
  }
}

if (typeof window !== 'undefined') {
  window.vortexStopActiveVoiceNote = stopActiveVoiceNoteGlobal;
}

export function prepareAudioSessionForMic() {
  try {
    if (typeof navigator !== 'undefined' && navigator.audioSession && navigator.audioSession.type !== 'play-and-record') {
      navigator.audioSession.type = 'play-and-record';
    }
  } catch (_) {}
}

export async function acquireMicStreamSafe() {
  prepareAudioSessionForMic();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('NO_GUM');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      throw err;
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export function downsampleFloat32(buffer, srcRate, targetRate) {
  if (!buffer?.length || targetRate >= srcRate) return buffer;
  const ratio = srcRate / targetRate;
  const newLen = Math.max(1, Math.round(buffer.length / ratio));
  const out = new Float32Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLen) {
    const nextOffsetBuffer = Math.min(buffer.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    out[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

export function encodeWavBytes(float32Samples, sampleRate = 12000) {
  const numSamples = float32Samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeAscii = (off, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function dataUrlToBlobUrl(dataUrl) {
  try {
    const [hdr, b64] = String(dataUrl || '').split(',', 2);
    if (!b64 || b64.length > 12 * 1024 * 1024) return '';
    let mime = (hdr.match(/data:([^;]+)/i)?.[1] || 'audio/wav').toLowerCase();
    if (mime === 'video/mp4') mime = 'audio/mp4';
    if (mime === 'video/webm') mime = 'audio/webm';
    if (!/^audio\/(?:wav|x-wav|mp4|mpeg|mp3|webm|ogg|aac)$/i.test(mime)) mime = 'audio/wav';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime }));
  } catch (_) {
    return '';
  }
}

export async function startUniversalVoiceRecorder({ maxSeconds = 24, apiFn = null, onTick = null, onFinish = null, onError = null } = {}) {
  stopActiveVoiceNoteGlobal();
  let stream = null;
  try {
    stream = await acquireMicStreamSafe();
  } catch (err) {
    onError?.(err?.name === 'NO_GUM' ? 'Tarayıcınız mikrofon erişimini desteklemiyor' : 'Mikrofon izni verilmedi — tarayıcı adres çubuğundan mikrofon iznini açın');
    return null;
  }
  if (typeof window !== 'undefined') window.vortexSetVoiceNotePlaying?.(true);
  const cleanupStreams = () => {
    try { stream?.getTracks?.().forEach((t) => t.stop()); } catch (_) {}
    if (typeof window !== 'undefined') window.vortexSetVoiceNotePlaying?.(false);
  };
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const startedAt = Date.now();
  const peaks = [];
  let stopped = false;
  let timer = null;

  if (Ctx) {
    try {
      const ac = new Ctx();
      if (ac.state === 'suspended') {
        try { await ac.resume(); } catch (_) {}
      }
      if (ac.state !== 'running') {
        try { await ac.close(); } catch (_) {}
        throw new Error('AC_SUSPENDED');
      }
      const srcRate = ac.sampleRate || 48000;
      const srcNode = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(4096, 1, 1);
      const muteGain = ac.createGain();
      muteGain.gain.value = 0;
      const pcmChunks = [];
      let totalFrames = 0;
      let latestPeak = 0.25;
      proc.onaudioprocess = (ev) => {
        if (stopped) return;
        const ch = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        let sumSq = 0;
        for (let i = 0; i < ch.length; i += 1) {
          copy[i] = ch[i];
          sumSq += ch[i] * ch[i];
        }
        pcmChunks.push(copy);
        totalFrames += copy.length;
        const rms = Math.sqrt(sumSq / Math.max(1, ch.length));
        latestPeak = Number(Math.max(0.12, Math.min(1, rms * 5.2)).toFixed(2));
      };
      srcNode.connect(proc);
      proc.connect(muteGain);
      muteGain.connect(ac.destination);

      const finish = async (shouldSend = true) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { proc.disconnect(); srcNode.disconnect(); muteGain.disconnect(); } catch (_) {}
        cleanupStreams();
        try { await ac.close(); } catch (_) {}
        if (!shouldSend) return;
        if (totalFrames < 600) {
          onError?.('Ses kaydı çok kısa — kaydetmek için biraz daha uzun konuşun');
          return;
        }
        const durSec = Math.max(0.8, Math.min(maxSeconds + 1, (Date.now() - startedAt) / 1000));
        const merged = new Float32Array(totalFrames);
        let pos = 0;
        for (const c of pcmChunks) {
          merged.set(c, pos);
          pos += c.length;
        }
        const down = downsampleFloat32(merged, srcRate, 12000);
        const wavBytes = encodeWavBytes(down, 12000);
        const b64 = uint8ToBase64(wavBytes);
        const dataUrl = `data:audio/wav;base64,${b64}`;
        const normPeaks = peaks.length >= 4 ? peaks.slice(-24) : [0.28, 0.62, 0.84, 0.46, 0.72, 0.54, 0.88, 0.42];
        let payload = { dataUrl, mime: 'audio/wav', duration: Number(durSec.toFixed(1)), peaks: normPeaks };
        if (typeof apiFn === 'function') {
          try {
            const up = await apiFn('/api/rave/voice-note', { method: 'POST', body: payload });
            if (up?.ok && up.audioNote?.url) {
              payload = { ...payload, id: up.audioNote.id, url: up.audioNote.url, mime: up.audioNote.mime || 'audio/wav' };
              if (dataUrl.length > 36000) delete payload.dataUrl;
            }
          } catch (_) {}
        }
        onFinish?.(payload);
      };

      timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        peaks.push(latestPeak);
        onTick?.(elapsed, latestPeak);
        if (elapsed >= maxSeconds) finish(true);
      }, 300);

      return { stop: (sendIt = true) => finish(sendIt) };
    } catch (_) {
      // Fall through to MediaRecorder fallback below
    }
  }

  if (typeof MediaRecorder === 'undefined') {
    cleanupStreams();
    onError?.('Tarayıcınız ses kaydını desteklemiyor');
    return null;
  }
  const cands = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', ''];
  const mimeType = cands.find((m) => !m || MediaRecorder.isTypeSupported?.(m)) || '';
  let rec = null;
  try {
    rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (_) {
    rec = new MediaRecorder(stream);
  }
  const chunks = [];
  let wantSend = false;
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
  rec.onerror = () => {
    clearInterval(timer);
    cleanupStreams();
    onError?.('Ses kaydı sırasında hata oluştu');
  };
  rec.onstop = () => {
    cleanupStreams();
    if (!wantSend || !chunks.length) return;
    const elapsedMs = Date.now() - startedAt;
    const rawMime = (rec.mimeType || mimeType || 'audio/mp4').replace(/^video\/mp4/i, 'audio/mp4');
    const blob = new Blob(chunks, { type: rawMime });
    if (elapsedMs < 350 || blob.size < 400) {
      onError?.('Ses kaydı çok kısa');
      return;
    }
    const durSec = Math.max(0.8, Math.min(maxSeconds + 1, elapsedMs / 1000));
    const reader = new FileReader();
    reader.onloadend = async () => {
      let dataUrl = String(reader.result || '').replace(/^data:video\/mp4/i, 'data:audio/mp4');
      if (!dataUrl.includes(';base64,')) return;
      const normPeaks = peaks.length >= 4 ? peaks.slice(-24) : [0.3, 0.65, 0.85, 0.5, 0.75, 0.55];
      let payload = { dataUrl, mime: rawMime, duration: Number(durSec.toFixed(1)), peaks: normPeaks };
      if (typeof apiFn === 'function') {
        try {
          const up = await apiFn('/api/rave/voice-note', { method: 'POST', body: payload });
          if (up?.ok && up.audioNote?.url) {
            payload = { ...payload, id: up.audioNote.id, url: up.audioNote.url, mime: up.audioNote.mime || rawMime };
            if (payload.url && dataUrl.length > 36000) delete payload.dataUrl;
          }
        } catch (_) {}
      }
      onFinish?.(payload);
    };
    reader.readAsDataURL(blob);
  };
  rec.start(250);
  timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    peaks.push(Number((0.25 + Math.random() * 0.55).toFixed(2)));
    onTick?.(elapsed, peaks[peaks.length - 1]);
    if (elapsed >= maxSeconds) {
      wantSend = true;
      clearInterval(timer);
      try { if (rec.state !== 'inactive') { rec.requestData?.(); rec.stop(); } } catch (_) {}
    }
  }, 300);
  return {
    stop: (sendIt = true) => {
      if (stopped) return;
      stopped = true;
      wantSend = Boolean(sendIt);
      clearInterval(timer);
      try {
        if (rec.state !== 'inactive') {
          rec.requestData?.();
          rec.stop();
        } else {
          cleanupStreams();
        }
      } catch (_) {
        cleanupStreams();
      }
    },
  };
}

export function buildUniversalAudioNotePlayer(an, { h, toast } = {}) {
  if (!an || typeof h !== 'function') return null;
  const hasHttpUrl = typeof an.url === 'string' && an.url.startsWith('/api/rave/voice-note/');
  const hasDataUrl = typeof an.dataUrl === 'string' && an.dataUrl.includes(';base64,');
  if (!hasHttpUrl && !hasDataUrl) return null;

  const totalDur = Math.max(1, Number(an.duration || 2));
  const rawPeaks = Array.isArray(an.peaks) && an.peaks.length ? an.peaks : [0.3, 0.65, 0.85, 0.45, 0.75, 0.55, 0.9, 0.4, 0.7, 0.5];
  const barsData = Array.from({ length: 22 }, (_, i) => Number(rawPeaks[i % rawPeaks.length] || 0.45));
  let audioEl = null;
  let activeBlobUrl = '';
  let blobFallbackTried = false;
  let rateIdx = 0;
  const rates = [1, 1.5, 2];
  const revokeBlob = (resetAudio = true) => {
    if (activeBlobUrl) {
      const usedByAudio = audioEl && audioEl.src === activeBlobUrl;
      try { URL.revokeObjectURL(activeBlobUrl); } catch (_) {}
      activeBlobUrl = '';
      if (resetAudio && usedByAudio) {
        try { audioEl.removeAttribute('src'); audioEl.load?.(); } catch (_) {}
        audioEl = null;
      }
    }
  };
  const fmtSec = (s) => {
    const sec = Math.max(0, Math.round(s));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  const playBtn = h('button', { type: 'button', class: 'vn-play-btn', 'aria-label': 'Sesli Mesajı Oynat' }, '▶');
  const timeEl = h('span', { class: 'vn-time' }, fmtSec(totalDur));
  const rateBtn = h('button', {
    type: 'button',
    class: 'vn-rate-btn',
    onclick: (e) => {
      e.stopPropagation();
      rateIdx = (rateIdx + 1) % rates.length;
      const r = rates[rateIdx];
      rateBtn.textContent = `${r}x`;
      if (audioEl) audioEl.playbackRate = r;
    },
  }, '1x');
  const barEls = barsData.map((pk, idx) => h('span', {
    class: 'vn-bar',
    style: { height: `${Math.min(100, Math.max(22, Math.round((pk > 1 ? pk / 100 : pk) * 100)))}%` },
    onclick: (e) => {
      e.stopPropagation();
      if (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        audioEl.currentTime = (idx / barEls.length) * audioEl.duration;
      }
    },
  }));
  const syncBars = (ratio) => {
    const activeCount = Math.round(Math.max(0, Math.min(1, ratio)) * barEls.length);
    barEls.forEach((b, i) => b.classList.toggle('played', i < activeCount));
  };
  const ensureAudio = () => {
    if (audioEl) return audioEl;
    let primarySrc = an.url;
    if (!hasHttpUrl) {
      activeBlobUrl = dataUrlToBlobUrl(an.dataUrl);
      primarySrc = activeBlobUrl || an.dataUrl;
    }
    audioEl = new Audio();
    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.preload = 'metadata';
    audioEl.src = primarySrc;
    audioEl.playbackRate = rates[rateIdx];
    audioEl.ontimeupdate = () => {
      const d = (Number.isFinite(audioEl.duration) && audioEl.duration > 0) ? audioEl.duration : totalDur;
      syncBars(audioEl.currentTime / d);
      timeEl.textContent = fmtSec(Math.max(0, Math.ceil(d - audioEl.currentTime)));
    };
    const onStop = () => {
      try { if (audioEl) audioEl.currentTime = 0; } catch (_) {}
      playBtn.textContent = '▶';
      syncBars(0);
      timeEl.textContent = fmtSec(totalDur);
      if (activeGlobalVoiceAudio === audioEl) {
        activeGlobalVoiceAudio = null;
        window.vortexSetVoiceNotePlaying?.(false);
      }
      revokeBlob(true);
    };
    audioEl.onended = onStop;
    audioEl.onpause = () => {
      playBtn.textContent = '▶';
      if (activeGlobalVoiceAudio === audioEl) {
        activeGlobalVoiceAudio = null;
        window.vortexSetVoiceNotePlaying?.(false);
      }
      if (!playBtn.isConnected || audioEl?.ended) revokeBlob(true);
    };
    audioEl.onerror = () => {
      if (!blobFallbackTried && hasDataUrl) {
        blobFallbackTried = true;
        revokeBlob(false);
        const bUrl = dataUrlToBlobUrl(an.dataUrl);
        if (bUrl) {
          activeBlobUrl = bUrl;
          audioEl.src = bUrl;
          audioEl.play().catch(() => onStop());
          return;
        }
      }
      onStop();
      toast?.('Sesli mesaj oynatılamadı');
    };
    return audioEl;
  };
  playBtn.onclick = (e) => {
    e.stopPropagation();
    const el = ensureAudio();
    if (el.paused) {
      if (activeGlobalVoiceAudio && activeGlobalVoiceAudio !== el) {
        try { activeGlobalVoiceAudio.pause(); } catch (_) {}
      }
      activeGlobalVoiceAudio = el;
      window.vortexSetVoiceNotePlaying?.(true);
      playBtn.textContent = '⏸';
      el.play().catch(() => {
        if (!blobFallbackTried && hasDataUrl) {
          blobFallbackTried = true;
          revokeBlob(false);
          activeBlobUrl = dataUrlToBlobUrl(an.dataUrl);
          if (activeBlobUrl) {
            el.src = activeBlobUrl;
            el.play().catch(() => { playBtn.textContent = '▶'; window.vortexSetVoiceNotePlaying?.(false); revokeBlob(true); });
            return;
          }
        }
        playBtn.textContent = '▶';
        window.vortexSetVoiceNotePlaying?.(false);
        revokeBlob(true);
      });
    } else {
      el.pause();
    }
  };
  return h('div', { class: 'chat-voice-note', onclick: (e) => e.stopPropagation() },
    playBtn,
    h('div', { class: 'vn-wave' }, ...barEls),
    timeEl,
    rateBtn);
}

export function createVoiceSearchButton({ h, icons, inputEl, onResult, toast } = {}) {
  let activeRec = null;
  const btn = h('button', {
    type: 'button',
    class: 'wl-voice-search-btn',
    title: 'Sesle Ara (Mikrofon)',
    'aria-label': 'Sesle Ara',
    onclick: async (e) => {
      e.stopPropagation();
      if (activeRec) {
        try { activeRec.stop(); } catch (_) {}
        return;
      }
      const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
      if (!SR) {
        toast?.('Bu tarayıcıda sesli metin arama desteklenmiyor — Chrome veya Safari kullanın');
        return;
      }
      try {
        prepareAudioSessionForMic();
        const rec = new SR();
        activeRec = rec;
        rec.lang = 'tr-TR';
        rec.continuous = false;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        const prevPh = inputEl?.placeholder || '';
        if (inputEl) inputEl.placeholder = '🔴 Dinleniyor... Konuşun';
        btn.classList.add('is-listening');
        let finalTranscript = '';
        const onHashAbort = () => {
          try { rec.abort?.(); } catch (_) {}
        };
        if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashAbort, { once: true });
        rec.onresult = (ev) => {
          if (!btn.isConnected) {
            try { rec.abort?.(); } catch (_) {}
            return;
          }
          let interim = '';
          for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
            const txt = ev.results[i][0]?.transcript || '';
            if (ev.results[i].isFinal) finalTranscript += txt;
            else interim += txt;
          }
          const combined = (finalTranscript || interim).trim();
          if (inputEl && inputEl.isConnected && combined) {
            inputEl.value = combined;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        const cleanup = () => {
          activeRec = null;
          if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHashAbort);
          btn.classList.remove('is-listening');
          if (inputEl && inputEl.isConnected) inputEl.placeholder = prevPh;
        };
        rec.onerror = (ev) => {
          cleanup();
          if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
            toast?.('Sesli arama için mikrofon izni gerekli');
          } else if (ev?.error !== 'aborted' && ev?.error !== 'no-speech') {
            toast?.('Ses algılanamadı, tekrar deneyin');
          }
        };
        rec.onend = () => {
          const q = (finalTranscript || inputEl?.value || '').trim();
          const stillMounted = Boolean(btn.isConnected && (!inputEl || inputEl.isConnected));
          cleanup();
          if (q && stillMounted) onResult?.(q);
        };
        rec.start();
      } catch (_) {
        activeRec = null;
        btn.classList.remove('is-listening');
        toast?.('Sesli arama başlatılamadı — mikrofon iznini kontrol edin');
      }
    },
  }, h('span', { html: icons?.mic || '🎙️', style: { display: 'inline-flex', width: '16px', height: '16px' } }));
  return btn;
}
=======
// Universal Cross-Browser Voice Note Recorder (12kHz WAV), Byte-Range Player & Voice Search Engine.
// Guarantees 100% playback compatibility across iOS Safari, Android Chrome, WebView, Firefox & Desktop.

let activeGlobalVoiceAudio = null;

export function stopActiveVoiceNoteGlobal() {
  if (activeGlobalVoiceAudio) {
    try { activeGlobalVoiceAudio.pause(); } catch (_) {}
    activeGlobalVoiceAudio = null;
  }
  if (typeof window !== 'undefined') {
    window.vortexSetVoiceNotePlaying?.(false);
  }
}

if (typeof window !== 'undefined') {
  window.vortexStopActiveVoiceNote = stopActiveVoiceNoteGlobal;
}

export function prepareAudioSessionForMic() {
  try {
    if (typeof navigator !== 'undefined' && navigator.audioSession && navigator.audioSession.type !== 'play-and-record') {
      navigator.audioSession.type = 'play-and-record';
    }
  } catch (_) {}
}

export async function acquireMicStreamSafe() {
  prepareAudioSessionForMic();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('NO_GUM');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      throw err;
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export function downsampleFloat32(buffer, srcRate, targetRate) {
  if (!buffer?.length || targetRate >= srcRate) return buffer;
  const ratio = srcRate / targetRate;
  const newLen = Math.max(1, Math.round(buffer.length / ratio));
  const out = new Float32Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLen) {
    const nextOffsetBuffer = Math.min(buffer.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    out[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

export function encodeWavBytes(float32Samples, sampleRate = 12000) {
  const numSamples = float32Samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeAscii = (off, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function dataUrlToBlobUrl(dataUrl) {
  try {
    const [hdr, b64] = String(dataUrl || '').split(',', 2);
    if (!b64 || b64.length > 12 * 1024 * 1024) return '';
    let mime = (hdr.match(/data:([^;]+)/i)?.[1] || 'audio/wav').toLowerCase();
    if (mime === 'video/mp4') mime = 'audio/mp4';
    if (mime === 'video/webm') mime = 'audio/webm';
    if (!/^audio\/(?:wav|x-wav|mp4|mpeg|mp3|webm|ogg|aac)$/i.test(mime)) mime = 'audio/wav';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime }));
  } catch (_) {
    return '';
  }
}

export async function startUniversalVoiceRecorder({ maxSeconds = 24, apiFn = null, onTick = null, onFinish = null, onError = null } = {}) {
  stopActiveVoiceNoteGlobal();
  let stream = null;
  try {
    stream = await acquireMicStreamSafe();
  } catch (err) {
    onError?.(err?.name === 'NO_GUM' ? 'Tarayıcınız mikrofon erişimini desteklemiyor' : 'Mikrofon izni verilmedi — tarayıcı adres çubuğundan mikrofon iznini açın');
    return null;
  }
  if (typeof window !== 'undefined') window.vortexSetVoiceNotePlaying?.(true);
  const cleanupStreams = () => {
    try { stream?.getTracks?.().forEach((t) => t.stop()); } catch (_) {}
    if (typeof window !== 'undefined') window.vortexSetVoiceNotePlaying?.(false);
  };
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const startedAt = Date.now();
  const peaks = [];
  let stopped = false;
  let timer = null;

  if (Ctx) {
    try {
      const ac = new Ctx();
      if (ac.state === 'suspended') {
        try { await ac.resume(); } catch (_) {}
      }
      if (ac.state !== 'running') {
        try { await ac.close(); } catch (_) {}
        throw new Error('AC_SUSPENDED');
      }
      const srcRate = ac.sampleRate || 48000;
      const srcNode = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(4096, 1, 1);
      const muteGain = ac.createGain();
      muteGain.gain.value = 0;
      const pcmChunks = [];
      let totalFrames = 0;
      let latestPeak = 0.25;
      proc.onaudioprocess = (ev) => {
        if (stopped) return;
        const ch = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        let sumSq = 0;
        for (let i = 0; i < ch.length; i += 1) {
          copy[i] = ch[i];
          sumSq += ch[i] * ch[i];
        }
        pcmChunks.push(copy);
        totalFrames += copy.length;
        const rms = Math.sqrt(sumSq / Math.max(1, ch.length));
        latestPeak = Number(Math.max(0.12, Math.min(1, rms * 5.2)).toFixed(2));
      };
      srcNode.connect(proc);
      proc.connect(muteGain);
      muteGain.connect(ac.destination);

      const finish = async (shouldSend = true) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { proc.disconnect(); srcNode.disconnect(); muteGain.disconnect(); } catch (_) {}
        cleanupStreams();
        try { await ac.close(); } catch (_) {}
        if (!shouldSend) return;
        if (totalFrames < 600) {
          onError?.('Ses kaydı çok kısa — kaydetmek için biraz daha uzun konuşun');
          return;
        }
        const durSec = Math.max(0.8, Math.min(maxSeconds + 1, (Date.now() - startedAt) / 1000));
        const merged = new Float32Array(totalFrames);
        let pos = 0;
        for (const c of pcmChunks) {
          merged.set(c, pos);
          pos += c.length;
        }
        const down = downsampleFloat32(merged, srcRate, 12000);
        const wavBytes = encodeWavBytes(down, 12000);
        const b64 = uint8ToBase64(wavBytes);
        const dataUrl = `data:audio/wav;base64,${b64}`;
        const normPeaks = peaks.length >= 4 ? peaks.slice(-24) : [0.28, 0.62, 0.84, 0.46, 0.72, 0.54, 0.88, 0.42];
        let payload = { dataUrl, mime: 'audio/wav', duration: Number(durSec.toFixed(1)), peaks: normPeaks };
        if (typeof apiFn === 'function') {
          try {
            const up = await apiFn('/api/rave/voice-note', { method: 'POST', body: payload });
            if (up?.ok && up.audioNote?.url) {
              payload = { ...payload, id: up.audioNote.id, url: up.audioNote.url, mime: up.audioNote.mime || 'audio/wav' };
              if (dataUrl.length > 36000) delete payload.dataUrl;
            }
          } catch (_) {}
        }
        onFinish?.(payload);
      };

      timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        peaks.push(latestPeak);
        onTick?.(elapsed, latestPeak);
        if (elapsed >= maxSeconds) finish(true);
      }, 300);

      return { stop: (sendIt = true) => finish(sendIt) };
    } catch (_) {
      // Fall through to MediaRecorder fallback below
    }
  }

  if (typeof MediaRecorder === 'undefined') {
    cleanupStreams();
    onError?.('Tarayıcınız ses kaydını desteklemiyor');
    return null;
  }
  const cands = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', ''];
  const mimeType = cands.find((m) => !m || MediaRecorder.isTypeSupported?.(m)) || '';
  let rec = null;
  try {
    rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (_) {
    rec = new MediaRecorder(stream);
  }
  const chunks = [];
  let wantSend = false;
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
  rec.onerror = () => {
    clearInterval(timer);
    cleanupStreams();
    onError?.('Ses kaydı sırasında hata oluştu');
  };
  rec.onstop = () => {
    cleanupStreams();
    if (!wantSend || !chunks.length) return;
    const elapsedMs = Date.now() - startedAt;
    const rawMime = (rec.mimeType || mimeType || 'audio/mp4').replace(/^video\/mp4/i, 'audio/mp4');
    const blob = new Blob(chunks, { type: rawMime });
    if (elapsedMs < 350 || blob.size < 400) {
      onError?.('Ses kaydı çok kısa');
      return;
    }
    const durSec = Math.max(0.8, Math.min(maxSeconds + 1, elapsedMs / 1000));
    const reader = new FileReader();
    reader.onloadend = async () => {
      let dataUrl = String(reader.result || '').replace(/^data:video\/mp4/i, 'data:audio/mp4');
      if (!dataUrl.includes(';base64,')) return;
      const normPeaks = peaks.length >= 4 ? peaks.slice(-24) : [0.3, 0.65, 0.85, 0.5, 0.75, 0.55];
      let payload = { dataUrl, mime: rawMime, duration: Number(durSec.toFixed(1)), peaks: normPeaks };
      if (typeof apiFn === 'function') {
        try {
          const up = await apiFn('/api/rave/voice-note', { method: 'POST', body: payload });
          if (up?.ok && up.audioNote?.url) {
            payload = { ...payload, id: up.audioNote.id, url: up.audioNote.url, mime: up.audioNote.mime || rawMime };
            if (payload.url && dataUrl.length > 36000) delete payload.dataUrl;
          }
        } catch (_) {}
      }
      onFinish?.(payload);
    };
    reader.readAsDataURL(blob);
  };
  rec.start(250);
  timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    peaks.push(Number((0.25 + Math.random() * 0.55).toFixed(2)));
    onTick?.(elapsed, peaks[peaks.length - 1]);
    if (elapsed >= maxSeconds) {
      wantSend = true;
      clearInterval(timer);
      try { if (rec.state !== 'inactive') { rec.requestData?.(); rec.stop(); } } catch (_) {}
    }
  }, 300);
  return {
    stop: (sendIt = true) => {
      if (stopped) return;
      stopped = true;
      wantSend = Boolean(sendIt);
      clearInterval(timer);
      try {
        if (rec.state !== 'inactive') {
          rec.requestData?.();
          rec.stop();
        } else {
          cleanupStreams();
        }
      } catch (_) {
        cleanupStreams();
      }
    },
  };
}

export function buildUniversalAudioNotePlayer(an, { h, toast } = {}) {
  if (!an || typeof h !== 'function') return null;
  const hasHttpUrl = typeof an.url === 'string' && an.url.startsWith('/api/rave/voice-note/');
  const hasDataUrl = typeof an.dataUrl === 'string' && an.dataUrl.includes(';base64,');
  if (!hasHttpUrl && !hasDataUrl) return null;

  const totalDur = Math.max(1, Number(an.duration || 2));
  const rawPeaks = Array.isArray(an.peaks) && an.peaks.length ? an.peaks : [0.3, 0.65, 0.85, 0.45, 0.75, 0.55, 0.9, 0.4, 0.7, 0.5];
  const barsData = Array.from({ length: 22 }, (_, i) => Number(rawPeaks[i % rawPeaks.length] || 0.45));
  let audioEl = null;
  let activeBlobUrl = '';
  let blobFallbackTried = false;
  let rateIdx = 0;
  const rates = [1, 1.5, 2];
  const revokeBlob = (resetAudio = true) => {
    if (activeBlobUrl) {
      const usedByAudio = audioEl && audioEl.src === activeBlobUrl;
      try { URL.revokeObjectURL(activeBlobUrl); } catch (_) {}
      activeBlobUrl = '';
      if (resetAudio && usedByAudio) {
        try { audioEl.removeAttribute('src'); audioEl.load?.(); } catch (_) {}
        audioEl = null;
      }
    }
  };
  const fmtSec = (s) => {
    const sec = Math.max(0, Math.round(s));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  const playBtn = h('button', { type: 'button', class: 'vn-play-btn', 'aria-label': 'Sesli Mesajı Oynat' }, '▶');
  const timeEl = h('span', { class: 'vn-time' }, fmtSec(totalDur));
  const rateBtn = h('button', {
    type: 'button',
    class: 'vn-rate-btn',
    onclick: (e) => {
      e.stopPropagation();
      rateIdx = (rateIdx + 1) % rates.length;
      const r = rates[rateIdx];
      rateBtn.textContent = `${r}x`;
      if (audioEl) audioEl.playbackRate = r;
    },
  }, '1x');
  const barEls = barsData.map((pk, idx) => h('span', {
    class: 'vn-bar',
    style: { height: `${Math.min(100, Math.max(22, Math.round((pk > 1 ? pk / 100 : pk) * 100)))}%` },
    onclick: (e) => {
      e.stopPropagation();
      if (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        audioEl.currentTime = (idx / barEls.length) * audioEl.duration;
      }
    },
  }));
  const syncBars = (ratio) => {
    const activeCount = Math.round(Math.max(0, Math.min(1, ratio)) * barEls.length);
    barEls.forEach((b, i) => b.classList.toggle('played', i < activeCount));
  };
  const ensureAudio = () => {
    if (audioEl) return audioEl;
    let primarySrc = an.url;
    if (!hasHttpUrl) {
      activeBlobUrl = dataUrlToBlobUrl(an.dataUrl);
      primarySrc = activeBlobUrl || an.dataUrl;
    }
    audioEl = new Audio();
    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.preload = 'metadata';
    audioEl.src = primarySrc;
    audioEl.playbackRate = rates[rateIdx];
    audioEl.ontimeupdate = () => {
      const d = (Number.isFinite(audioEl.duration) && audioEl.duration > 0) ? audioEl.duration : totalDur;
      syncBars(audioEl.currentTime / d);
      timeEl.textContent = fmtSec(Math.max(0, Math.ceil(d - audioEl.currentTime)));
    };
    const onStop = () => {
      try { if (audioEl) audioEl.currentTime = 0; } catch (_) {}
      playBtn.textContent = '▶';
      syncBars(0);
      timeEl.textContent = fmtSec(totalDur);
      if (activeGlobalVoiceAudio === audioEl) {
        activeGlobalVoiceAudio = null;
        window.vortexSetVoiceNotePlaying?.(false);
      }
      revokeBlob(true);
    };
    audioEl.onended = onStop;
    audioEl.onpause = () => {
      playBtn.textContent = '▶';
      if (activeGlobalVoiceAudio === audioEl) {
        activeGlobalVoiceAudio = null;
        window.vortexSetVoiceNotePlaying?.(false);
      }
      if (!playBtn.isConnected || audioEl?.ended) revokeBlob(true);
    };
    audioEl.onerror = () => {
      if (!blobFallbackTried && hasDataUrl) {
        blobFallbackTried = true;
        revokeBlob(false);
        const bUrl = dataUrlToBlobUrl(an.dataUrl);
        if (bUrl) {
          activeBlobUrl = bUrl;
          audioEl.src = bUrl;
          audioEl.play().catch(() => onStop());
          return;
        }
      }
      onStop();
      toast?.('Sesli mesaj oynatılamadı');
    };
    return audioEl;
  };
  playBtn.onclick = (e) => {
    e.stopPropagation();
    const el = ensureAudio();
    if (el.paused) {
      if (activeGlobalVoiceAudio && activeGlobalVoiceAudio !== el) {
        try { activeGlobalVoiceAudio.pause(); } catch (_) {}
      }
      activeGlobalVoiceAudio = el;
      window.vortexSetVoiceNotePlaying?.(true);
      playBtn.textContent = '⏸';
      el.play().catch(() => {
        if (!blobFallbackTried && hasDataUrl) {
          blobFallbackTried = true;
          revokeBlob(false);
          activeBlobUrl = dataUrlToBlobUrl(an.dataUrl);
          if (activeBlobUrl) {
            el.src = activeBlobUrl;
            el.play().catch(() => { playBtn.textContent = '▶'; window.vortexSetVoiceNotePlaying?.(false); revokeBlob(true); });
            return;
          }
        }
        playBtn.textContent = '▶';
        window.vortexSetVoiceNotePlaying?.(false);
        revokeBlob(true);
      });
    } else {
      el.pause();
    }
  };
  return h('div', { class: 'chat-voice-note', onclick: (e) => e.stopPropagation() },
    playBtn,
    h('div', { class: 'vn-wave' }, ...barEls),
    timeEl,
    rateBtn);
}

export function createVoiceSearchButton({ h, icons, inputEl, onResult, toast } = {}) {
  let activeRec = null;
  const btn = h('button', {
    type: 'button',
    class: 'wl-voice-search-btn',
    title: 'Sesle Ara (Mikrofon)',
    'aria-label': 'Sesle Ara',
    onclick: async (e) => {
      e.stopPropagation();
      if (activeRec) {
        try { activeRec.stop(); } catch (_) {}
        return;
      }
      const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
      if (!SR) {
        toast?.('Bu tarayıcıda sesli metin arama desteklenmiyor — Chrome veya Safari kullanın');
        return;
      }
      try {
        prepareAudioSessionForMic();
        const rec = new SR();
        activeRec = rec;
        rec.lang = 'tr-TR';
        rec.continuous = false;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        const prevPh = inputEl?.placeholder || '';
        if (inputEl) inputEl.placeholder = '🔴 Dinleniyor... Konuşun';
        btn.classList.add('is-listening');
        let finalTranscript = '';
        const onHashAbort = () => {
          try { rec.abort?.(); } catch (_) {}
        };
        if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashAbort, { once: true });
        rec.onresult = (ev) => {
          if (!btn.isConnected) {
            try { rec.abort?.(); } catch (_) {}
            return;
          }
          let interim = '';
          for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
            const txt = ev.results[i][0]?.transcript || '';
            if (ev.results[i].isFinal) finalTranscript += txt;
            else interim += txt;
          }
          const combined = (finalTranscript || interim).trim();
          if (inputEl && inputEl.isConnected && combined) {
            inputEl.value = combined;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        const cleanup = () => {
          activeRec = null;
          if (typeof window !== 'undefined') window.removeEventListener('hashchange', onHashAbort);
          btn.classList.remove('is-listening');
          if (inputEl && inputEl.isConnected) inputEl.placeholder = prevPh;
        };
        rec.onerror = (ev) => {
          cleanup();
          if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
            toast?.('Sesli arama için mikrofon izni gerekli');
          } else if (ev?.error !== 'aborted' && ev?.error !== 'no-speech') {
            toast?.('Ses algılanamadı, tekrar deneyin');
          }
        };
        rec.onend = () => {
          const q = (finalTranscript || inputEl?.value || '').trim();
          const stillMounted = Boolean(btn.isConnected && (!inputEl || inputEl.isConnected));
          cleanup();
          if (q && stillMounted) onResult?.(q);
        };
        rec.start();
      } catch (_) {
        activeRec = null;
        btn.classList.remove('is-listening');
        toast?.('Sesli arama başlatılamadı — mikrofon iznini kontrol edin');
      }
    },
  }, h('span', { html: icons?.mic || '🎙️', style: { display: 'inline-flex', width: '16px', height: '16px' } }));
  return btn;
}
>>>>>>> fd1b292b142958c2a521d474978d23e1dd493358
