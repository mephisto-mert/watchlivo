// YouTube-style Adaptive Bitrate (ABR) & Network-Aware Quality Controller for Watchlivo.
// Automatically downshifts quality immediately on weak/stalling networks (e.g. rural/mountain mobile)
// and smoothly ramps quality back up once sustained throughput & buffer health recover.

const LOW_BW_STORAGE_KEY = 'vortex_low_bw_mode';
const BW_MEM_STORAGE_KEY = 'wl_abr_bw_bps_v1';
const BW_MEM_TTL_MS = 15 * 60 * 1000;

export function isLowBandwidthMode() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LOW_BW_STORAGE_KEY) === 'on';
  } catch (_) {
    return false;
  }
}

export function setLowBandwidthMode(enabled) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOW_BW_STORAGE_KEY, enabled ? 'on' : 'off');
    }
  } catch (_) {}
  return Boolean(enabled);
}

export function readRememberedBandwidthBps(now = Date.now()) {
  try {
    if (typeof sessionStorage === 'undefined') return 0;
    const raw = sessionStorage.getItem(BW_MEM_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const bps = Number(parsed?.bps || 0);
    const ts = Number(parsed?.ts || 0);
    if (bps > 80_000 && ts > 0 && now - ts < BW_MEM_TTL_MS) return bps;
  } catch (_) {}
  return 0;
}

export function saveRememberedBandwidthBps(bps, now = Date.now()) {
  const n = Number(bps || 0);
  if (!Number.isFinite(n) || n < 80_000) return;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(BW_MEM_STORAGE_KEY, JSON.stringify({ bps: Math.round(n), ts: now }));
    }
  } catch (_) {}
}

export function getNetworkSnapshot(connOverride = null) {
  const conn = connOverride || (typeof navigator !== 'undefined'
    ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection || null)
    : null);
  const effectiveType = String(conn?.effectiveType || '').toLowerCase();
  const downlinkMbps = Number(conn?.downlink || 0);
  const rttMs = Number(conn?.rtt || 0);
  const saveData = Boolean(conn?.saveData);
  const lowBwPref = isLowBandwidthMode();
  const rememberedBps = readRememberedBandwidthBps();

  const isVerySlow = Boolean(
    saveData ||
    effectiveType === 'slow-2g' ||
    effectiveType === '2g' ||
    (downlinkMbps > 0 && downlinkMbps < 1.2) ||
    (rttMs >= 650) ||
    (rememberedBps > 0 && rememberedBps < 1_100_000)
  );
  const isSlow = Boolean(
    isVerySlow ||
    lowBwPref ||
    effectiveType === '3g' ||
    (downlinkMbps > 0 && downlinkMbps < 3.0) ||
    (rttMs >= 320) ||
    (rememberedBps > 0 && rememberedBps < 2_200_000)
  );
  const isFast = Boolean(
    !isSlow &&
    !lowBwPref &&
    ((downlinkMbps >= 6.0 && (rttMs === 0 || rttMs < 180)) || (rememberedBps >= 5_500_000))
  );

  return {
    effectiveType: effectiveType || 'unknown',
    downlinkMbps,
    rttMs,
    saveData,
    lowBwPref,
    rememberedBps,
    isVerySlow,
    isSlow,
    isFast,
  };
}

export function estimateBitrateForHeight(height, width = 0) {
  const h = Number(height || 0) || (width > 0 ? Math.round(width * 9 / 16) : 0);
  if (h <= 0) return 1_800_000;
  if (h <= 280) return 450_000;
  if (h <= 400) return 850_000;
  if (h <= 540) return 1_400_000;
  if (h <= 820) return 2_800_000;
  if (h <= 1200) return 5_200_000;
  return 11_500_000;
}

export function formatHeightTag(height, width = 0) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  const effW = Math.max(w, Math.round(h * 16 / 9));
  if (effW >= 3200 || h >= 2000) return '4K';
  if (effW >= 1800 || h >= 1000) return '1080p';
  if (effW >= 1200 || h >= 680) return '720p';
  if (h >= 440) return '480p';
  if (h >= 320) return '360p';
  if (h > 0) return `${h}p`;
  return 'HD';
}

export function buildHlsAbrConfig({ isMobileScreen = false, isAndroidWebView = false, startPosition = -1, netSnap = null } = {}) {
  const net = netSnap || getNetworkSnapshot();
  const connBps = net.downlinkMbps > 0 ? Math.round(net.downlinkMbps * 1_000_000 * 0.72) : 0;
  let initialEstimate = isMobileScreen ? 950_000 : 2_200_000;
  if (net.rememberedBps > 0) {
    initialEstimate = Math.max(350_000, Math.min(8_000_000, Math.round(net.rememberedBps * 0.85)));
  } else if (connBps > 0) {
    initialEstimate = Math.max(350_000, Math.min(6_500_000, connBps));
  }
  if (net.isVerySlow) {
    initialEstimate = Math.min(initialEstimate, 550_000);
  } else if (net.isSlow) {
    initialEstimate = Math.min(initialEstimate, 950_000);
  }

  const startLow = Boolean(isMobileScreen || net.isSlow || net.isVerySlow || net.lowBwPref);

  return {
    enableWorker: typeof Worker === 'function' && !isAndroidWebView,
    lowLatencyMode: false,
    subtitleDisplay: false,
    enableWebVTT: false,
    startFragPrefetch: true,
    // Start at lowest tier on slow/mobile networks for instant zero-stall start, then ramp up smoothly.
    startLevel: startLow ? 0 : -1,
    startPosition: startPosition >= 0.5 ? startPosition : -1,
    abrEwmaDefaultEstimate: initialEstimate,
    // Fast drop on signal dip (2.0s half-life), steady conservative rise (7.5s half-life) — YouTube ABR feel.
    abrEwmaFastVoD: net.isSlow ? 2.0 : 3.0,
    abrEwmaSlowVoD: net.isSlow ? 8.0 : 7.0,
    abrEwmaFastLive: 2.0,
    abrEwmaSlowLive: 7.0,
    abrBandWidthFactor: net.isVerySlow ? 0.70 : (net.isSlow || isMobileScreen ? 0.78 : 0.85),
    abrBandWidthUpFactor: net.isVerySlow ? 0.50 : (net.isSlow || isMobileScreen ? 0.58 : 0.66),
    abrMaxWithRealBitrate: true,
    autoLevelCapping: -1,
    maxBufferLength: net.isVerySlow ? 20 : (isMobileScreen ? 26 : 45),
    maxMaxBufferLength: net.isVerySlow ? 42 : (isMobileScreen ? 54 : 100),
    backBufferLength: isMobileScreen ? 12 : 40,
    maxBufferSize: (isMobileScreen ? 28 : 60) * 1000 * 1000,
    maxBufferHole: 0.5,
    maxAudioFramesDrift: 2,
    stretchShortVideoTrack: true,
    forceKeyFrameOnDiscontinuity: true,
    progressive: false,
    highBufferWatchdogPeriod: 2,
    maxFragLookUpTolerance: 0.35,
    nudgeOffset: 0.25,
    nudgeMaxRetry: 10,
    // Shorter fragment timeout on slow links so stuck high-bitrate chunks abort & downgrade in seconds, not 84s.
    fragLoadingTimeOut: net.isVerySlow ? 12000 : (net.isSlow || isMobileScreen ? 15000 : 20000),
    fragLoadingMaxRetry: 2,
    fragLoadingRetryDelay: 300,
    manifestLoadingTimeOut: 8500,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 8500,
    levelLoadingMaxRetry: 2,
  };
}

export function withEdgeAbrParams(rawUrl, { maxHeight = 0, lowStart = false } = {}) {
  const s = String(rawUrl || '').trim();
  if (!s || !/\/api\/rave\/stream(?:\?|_manifest\?)/i.test(s)) return s;
  try {
    const isRel = s.startsWith('/');
    const u = new URL(s, 'https://watchlivo.local');
    if (Number(maxHeight) > 0) u.searchParams.set('max_h', String(Math.round(Number(maxHeight))));
    else u.searchParams.delete('max_h');
    if (lowStart) u.searchParams.set('abr_low', '1');
    else u.searchParams.delete('abr_low');
    return isRel ? `${u.pathname}${u.search}${u.hash}` : u.toString();
  } catch (_) {
    return s;
  }
}

export class AdaptiveQualityController {
  constructor({ isMobileScreen = false, netSnap = null, onAutoChange = null } = {}) {
    this.isMobileScreen = Boolean(isMobileScreen);
    this.onAutoChange = typeof onAutoChange === 'function' ? onAutoChange : null;
    this.ladder = []; // sorted lowest -> highest: [{ hlsIndex, width, height, bitrate, effBitrate, tag }]
    this.maxAutoPos = -1; // device hard ceiling in ladder (excludes >1080p in auto mode)
    this.capPos = -1; // current dynamic ABR cap in ladder
    this.manualLocked = false;
    this.manualHlsIndex = -1;
    this.lowBwMode = isLowBandwidthMode();

    const net = netSnap || getNetworkSnapshot();
    const seed = net.rememberedBps || (net.downlinkMbps > 0 ? net.downlinkMbps * 1_000_000 * 0.72 : 0);
    this.fastEwmaBps = seed > 0 ? seed : 0;
    this.slowEwmaBps = seed > 0 ? seed : 0;
    this.sampleCount = 0;

    this.stallTimestamps = [];
    this.cooldownUntil = 0;
    this.lastSwitchAt = 0;
    this.smoothSince = 0;
    this.fastRecoveryHintUntil = 0;
    this.lastBwPersistAt = 0;
  }

  setLevels(hlsLevels = [], { now = Date.now(), netSnap = null } = {}) {
    const list = Array.isArray(hlsLevels) ? hlsLevels : [];
    const seenBitrates = new Set();
    const rawItems = list.map((l, idx) => {
      const w = Number(l?.width || 0);
      const h = Number(l?.height || 0);
      const rawBw = Number(l?.bitrate || 0);
      if (rawBw > 0) seenBitrates.add(rawBw);
      return { hlsIndex: idx, width: w, height: h, bitrate: rawBw };
    });

    // Some upstream manifests put identical/bogus BANDWIDTH across 480p and 1080p.
    // Detect that and fall back to resolution-derived bitrate estimates so ABR ordering is always accurate.
    const distinctHeights = new Set(rawItems.map((x) => x.height).filter((h) => h > 0));
    const hasBogusBitrates = distinctHeights.size > 1 && seenBitrates.size <= 1;

    this.ladder = rawItems
      .map((item) => {
        const estBw = estimateBitrateForHeight(item.height, item.width);
        const effBitrate = (!hasBogusBitrates && item.bitrate > 120_000) ? item.bitrate : estBw;
        const effHeight = item.height || (item.width > 0 ? Math.round(item.width * 9 / 16) : Math.round(effBitrate / 4500));
        return {
          ...item,
          effHeight,
          effBitrate,
          tag: formatHeightTag(item.height || effHeight, item.width),
        };
      })
      .sort((a, b) => (a.effHeight - b.effHeight) || (a.effBitrate - b.effBitrate) || (a.hlsIndex - b.hlsIndex));

    if (!this.ladder.length) {
      this.maxAutoPos = -1;
      this.capPos = -1;
      return -1;
    }

    // Never auto-pick > 1080p (>1200px height or >10.5 Mbps) unless user explicitly picks 4K manually.
    let ceiling = 0;
    for (let i = 0; i < this.ladder.length; i += 1) {
      const it = this.ladder[i];
      const over1080 = it.width > 2650 || it.height > 1200 || it.effBitrate > 10_500_000;
      if (!over1080) ceiling = i;
    }
    this.maxAutoPos = ceiling;

    const net = netSnap || getNetworkSnapshot();
    let initCap = ceiling;
    if (this.lowBwMode || net.saveData || net.isVerySlow) {
      initCap = this._highestPosUpToHeight(480);
    } else if (net.isSlow) {
      initCap = this._highestPosUpToHeight(720);
    } else if (this.isMobileScreen && !net.isFast) {
      initCap = this._highestPosUpToHeight(720);
    }
    this.capPos = Math.max(0, Math.min(this.maxAutoPos, initCap));
    this.smoothSince = now;
    this.lastSwitchAt = now;
    return this.getAutoLevelCapping();
  }

  _highestPosUpToHeight(maxH) {
    if (!this.ladder.length) return -1;
    let best = 0;
    for (let i = 0; i <= this.maxAutoPos; i += 1) {
      if (this.ladder[i].effHeight <= maxH + 40) best = i;
    }
    return best;
  }

  _effectiveCeilingPos() {
    if (this.maxAutoPos < 0) return -1;
    if (this.lowBwMode) return Math.min(this.maxAutoPos, this._highestPosUpToHeight(480));
    return this.maxAutoPos;
  }

  getAutoLevelCapping() {
    if (this.manualLocked || this.capPos < 0 || !this.ladder[this.capPos]) return -1;
    return this.ladder[this.capPos].hlsIndex;
  }

  getEffectiveBandwidthBps(hlsBwEstimate = 0) {
    const hlsBw = Number(hlsBwEstimate || 0);
    const dual = (this.fastEwmaBps > 0 && this.slowEwmaBps > 0)
      ? Math.min(this.fastEwmaBps, this.slowEwmaBps)
      : (this.fastEwmaBps || this.slowEwmaBps || 0);
    if (dual > 0 && hlsBw > 0) return Math.min(dual, hlsBw);
    return dual || hlsBw || 0;
  }

  recordFragmentLoad({ bytes = 0, durationMs = 0, now = Date.now() } = {}) {
    const b = Number(bytes || 0);
    const ms = Number(durationMs || 0);
    // Ignore tiny init/playlist chunks (< 16KB) or instant cache hits (< 12ms)
    if (b < 16_384 || ms < 12) return this.getEffectiveBandwidthBps();
    const bps = Math.max(80_000, Math.min(80_000_000, (b * 8 * 1000) / ms));
    if (this.sampleCount === 0 || this.fastEwmaBps <= 0) {
      this.fastEwmaBps = bps;
      this.slowEwmaBps = bps;
    } else {
      // Fast EWMA responds immediately to drops; slow EWMA filters transient bursts.
      this.fastEwmaBps = this.fastEwmaBps * 0.55 + bps * 0.45;
      this.slowEwmaBps = this.slowEwmaBps * 0.82 + bps * 0.18;
    }
    this.sampleCount += 1;
    if (now - this.lastBwPersistAt > 8000) {
      this.lastBwPersistAt = now;
      saveRememberedBandwidthBps(this.getEffectiveBandwidthBps(), now);
    }
    return this.getEffectiveBandwidthBps();
  }

  _posForHlsIndex(hlsIdx) {
    if (hlsIdx < 0) return this.capPos;
    const found = this.ladder.findIndex((it) => it.hlsIndex === hlsIdx);
    return found >= 0 ? found : this.capPos;
  }

  handleStall({ reason = 'stall', bufAheadSec = 0, currentHlsLevel = -1, now = Date.now() } = {}) {
    this.smoothSince = now;
    this.stallTimestamps = this.stallTimestamps.filter((t) => now - t < 120_000);
    this.stallTimestamps.push(now);

    if (this.manualLocked || this.ladder.length <= 1) {
      return { changed: false, singleLevel: this.ladder.length <= 1 };
    }

    const recentStalls = this.stallTimestamps.filter((t) => now - t < 45_000).length;
    const curPos = Math.min(
      this.capPos >= 0 ? this.capPos : this.maxAutoPos,
      this._posForHlsIndex(currentHlsLevel),
    );
    const isSevere = reason === 'timeout' || bufAheadSec < 1.2 || recentStalls >= 2;
    const dropSteps = isSevere ? 2 : 1;
    const nextPos = Math.max(0, curPos - dropSteps);

    // Escalating cooldown so erratic mountain signal does not yo-yo back into 1080p stalls.
    const cooldownMs = recentStalls >= 3 ? 45_000 : (recentStalls === 2 ? 30_000 : 18_000);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + cooldownMs);

    // Penalize fast EWMA on stall/timeout so recovery requires genuine fresh high-speed fragments.
    if (this.fastEwmaBps > 0) {
      this.fastEwmaBps = Math.max(250_000, this.fastEwmaBps * (isSevere ? 0.55 : 0.72));
    }

    if (nextPos >= this.capPos && curPos <= 0) {
      return { changed: false, alreadyLowest: true, capHlsIndex: this.ladder[0].hlsIndex };
    }

    this.capPos = Math.min(this.capPos >= 0 ? this.capPos : nextPos, nextPos);
    this.lastSwitchAt = now;
    const target = this.ladder[this.capPos];
    const evt = {
      changed: true,
      direction: 'down',
      reason,
      targetPos: this.capPos,
      targetHlsIndex: target.hlsIndex,
      height: target.effHeight,
      tag: target.tag,
      abortCurrent: Boolean(bufAheadSec < 1.2 || reason === 'timeout'),
    };
    this.onAutoChange?.(evt);
    return evt;
  }

  evaluateTick({ now = Date.now(), playing = true, bufAheadSec = 0, currentHlsLevel = -1, hlsBwEstimate = 0 } = {}) {
    if (!playing || this.manualLocked || this.ladder.length <= 1) {
      return { changed: false };
    }
    if (!this.smoothSince) this.smoothSince = now;

    const estBps = this.getEffectiveBandwidthBps(hlsBwEstimate);
    const curPos = this._posForHlsIndex(currentHlsLevel);
    const curLevel = this.ladder[curPos];

    // 1. Proactive downshift BEFORE hitting empty buffer when buffer is draining & speed < current tier bitrate.
    if (curPos > 0 && bufAheadSec < 4.2 && curLevel && estBps > 0 && estBps < curLevel.effBitrate * 1.05 && now - this.lastSwitchAt > 5000) {
      const nextPos = Math.max(0, curPos - 1);
      this.capPos = Math.min(this.capPos, nextPos);
      this.lastSwitchAt = now;
      this.smoothSince = now;
      this.cooldownUntil = Math.max(this.cooldownUntil, now + 18_000);
      const target = this.ladder[this.capPos];
      const evt = {
        changed: true,
        direction: 'down',
        reason: 'buffer-low',
        targetPos: this.capPos,
        targetHlsIndex: target.hlsIndex,
        height: target.effHeight,
        tag: target.tag,
        abortCurrent: bufAheadSec < 1.0,
      };
      this.onAutoChange?.(evt);
      return evt;
    }

    // 2. Smooth YouTube recovery upshift when sustained clean playback + healthy buffer + strong bandwidth margin!
    const ceiling = this._effectiveCeilingPos();
    if (this.capPos < ceiling && now >= this.cooldownUntil && now - this.lastSwitchAt > 9000) {
      const smoothMs = now - this.smoothSince;
      const inFastRecovery = now < this.fastRecoveryHintUntil;
      const reqSmoothMs = inFastRecovery ? 6_000 : 14_000;
      const reqBufSec = this.isMobileScreen ? 11.0 : 14.0;
      const nextPos = this.capPos + 1;
      const nextLevel = this.ladder[nextPos];
      const marginFactor = inFastRecovery ? 1.30 : 1.45;

      if (nextLevel && smoothMs >= reqSmoothMs && bufAheadSec >= reqBufSec && estBps >= nextLevel.effBitrate * marginFactor) {
        this.capPos = nextPos;
        this.lastSwitchAt = now;
        // Clear old stall backoff once we successfully recover cleanly
        if (smoothMs >= 60_000) this.stallTimestamps = [];
        const evt = {
          changed: true,
          direction: 'up',
          reason: 'recovered',
          targetPos: this.capPos,
          targetHlsIndex: nextLevel.hlsIndex,
          height: nextLevel.effHeight,
          tag: nextLevel.tag,
          abortCurrent: false,
        };
        this.onAutoChange?.(evt);
        return evt;
      }
    }

    return { changed: false };
  }

  handleNetworkChange(netSnap = null, now = Date.now()) {
    const net = netSnap || getNetworkSnapshot();
    if (this.manualLocked || this.ladder.length <= 1) return { changed: false };

    if (net.isVerySlow || net.saveData) {
      const lowPos = this._highestPosUpToHeight(480);
      if (this.capPos > lowPos) {
        this.capPos = lowPos;
        this.lastSwitchAt = now;
        this.smoothSince = now;
        this.cooldownUntil = Math.max(this.cooldownUntil, now + 20_000);
        const target = this.ladder[this.capPos];
        const evt = {
          changed: true,
          direction: 'down',
          reason: 'network-change',
          targetPos: this.capPos,
          targetHlsIndex: target.hlsIndex,
          height: target.effHeight,
          tag: target.tag,
          abortCurrent: false,
        };
        this.onAutoChange?.(evt);
        return evt;
      }
    } else if (net.isFast && this.capPos < this._effectiveCeilingPos()) {
      // Signal just recovered to fast 4G/Wi-Fi: allow fast upshift after 6s of clean playback.
      this.fastRecoveryHintUntil = now + 45_000;
      this.cooldownUntil = Math.min(this.cooldownUntil, now + 4_000);
      if (net.downlinkMbps >= 6) {
        const boostBps = net.downlinkMbps * 1_000_000 * 0.72;
        this.fastEwmaBps = Math.max(this.fastEwmaBps, boostBps);
        this.slowEwmaBps = Math.max(this.slowEwmaBps, boostBps * 0.9);
      }
    }
    return { changed: false };
  }

  setManualLevel(hlsIndex) {
    const idx = Number(hlsIndex);
    if (idx < 0) {
      return this.setAutoMode();
    }
    this.manualLocked = true;
    this.manualHlsIndex = idx;
    return { isAuto: false, hlsIndex: idx };
  }

  setAutoMode(now = Date.now()) {
    this.manualLocked = false;
    this.manualHlsIndex = -1;
    this.capPos = Math.min(this._effectiveCeilingPos(), Math.max(0, this.capPos >= 0 ? this.capPos : this._effectiveCeilingPos()));
    this.smoothSince = now;
    return { isAuto: true, capHlsIndex: this.getAutoLevelCapping() };
  }

  setLowBwMode(enabled, now = Date.now()) {
    this.lowBwMode = setLowBandwidthMode(enabled);
    if (!this.manualLocked && this.ladder.length > 1) {
      if (this.lowBwMode) {
        this.capPos = Math.min(this.capPos, this._highestPosUpToHeight(480));
      } else {
        this.capPos = this.maxAutoPos;
        this.cooldownUntil = now;
        this.fastRecoveryHintUntil = now + 30_000;
      }
      this.lastSwitchAt = now;
    }
    return this.getAutoLevelCapping();
  }

  getStatus(currentHlsLevel = -1, videoHeight = 0, hlsBwEstimate = 0) {
    const curItem = this.ladder.find((l) => l.hlsIndex === currentHlsLevel) || this.ladder[this.capPos] || null;
    const height = curItem?.height || curItem?.effHeight || Number(videoHeight || 0);
    const tag = curItem ? curItem.tag : formatHeightTag(height);
    const estBps = this.getEffectiveBandwidthBps(hlsBwEstimate);
    const estMbps = estBps > 0 ? Number((estBps / 1_000_000).toFixed(1)) : 0;
    const capped = !this.manualLocked && this.capPos >= 0 && this.capPos < this.maxAutoPos;
    return {
      isAuto: !this.manualLocked,
      tag,
      height,
      capped,
      lowBwMode: this.lowBwMode,
      estMbps,
      hasMultipleLevels: this.ladder.length > 1,
    };
  }
}
