// Port of Rave's VideoPlayerSync (common.deobf.js @587800/@730900), adapter-agnostic.
// Mesh state is authoritative: {meshStateStatus, meshStatePosition, meshStateTime, meshStatePlaybackSpeed}.
const CYCLE_MS = 450;
const JUMP_DELTA = 2.4;
const IN_SYNC = 0.12;
const COARSE = 1.60;          // Coarse speedSync threshold
const FLIP = 2.40;            // Hysteresis threshold
const COARSE_MOD = 0.045;     // Smooth ±4.5% rate nudge for HTML5 video
const FINE_MOD = 0.022;       // Smooth ±2.2% fine rate nudge
const RUNWAY_SEC = 2.5;       // Buffered runway required to speed up when behind
const STARVE_CEILING = 45.0;  // Max behind before forcing jump
const DEFER_MAX_MS = 30000;   // Max defer window while buffer builds
const SEEK_SETTLE_MS = 3200;

export const clock = {
  offset: 0, bestRtt: Infinity, samples: 0,
  now() { return Date.now() / 1000 + this.offset; },
  sample(t0, serverTime, t1 = Date.now() / 1000) {
    if (!Number.isFinite(t0) || !Number.isFinite(serverTime) || t0 <= 0 || serverTime <= 0) return;
    const rtt = Math.max(0, t1 - t0);
    const est = serverTime + rtt / 2 - t1;
    if (this.samples > 6 && Number.isFinite(this.bestRtt)) {
      this.bestRtt = this.bestRtt * 1.04;
    }
    if (this.samples === 0 || rtt <= this.bestRtt * 1.65) {
      this.offset = this.samples === 0 ? est : this.offset * 0.65 + est * 0.35;
      this.bestRtt = Math.min(this.bestRtt, Math.max(0.015, rtt));
    }
    this.samples += 1;
  },
};

export function expectedPosition(media) {
  if (!media) return 0;
  const status = media.meshStateStatus || (media.playing ? 'PLAYING' : 'PAUSED');
  const pos = Number(media.meshStatePosition ?? media.currentTime ?? 0);
  const t0 = Number(media.meshStateTime ?? media.updatedAt ?? clock.now());
  const speed = Number(media.meshStatePlaybackSpeed ?? media.rate ?? 1);
  if (status !== 'PLAYING') return Math.max(0, pos);
  return Math.max(0, pos + Math.max(0, clock.now() - t0) * speed);
}

export class SyncEngine {
  constructor({ getMedia, getAdapter, isLeader, onLeaderSync, onStatus }) {
    this.getMedia = getMedia;
    this.getAdapter = getAdapter;
    this.isLeader = isLeader || (() => false);
    this.onLeaderSync = onLeaderSync || (() => {});
    this.onStatus = onStatus || (() => {});
    this.timer = null;
    this.lastDelta = 0; this.inSyncCount = 0; this.flipCount = 0;
    this.seekUntil = 0;
    this.deferStartedAt = 0;
    this.lastLeaderBroadcast = 0;
    this.mode = 'idle';
    this.enabled = true;
  }

  start() { this.stop(); this.loop(); }
  stop() { clearTimeout(this.timer); this.timer = null; }
  kick(resetCooldown = false) {
    if (resetCooldown) {
      this.inSyncCount = 0;
      this.flipCount = 0;
      this.seekUntil = 0;
      this.deferStartedAt = 0;
      this.start();
      return;
    }
    if (!this.timer) {
      this.start();
    }
  }

  // Port of Rave's dm(curr, expected, delta) buffer-starvation guard (common.deobf.js)
  decideBehindAction(ad, curr, expected, delta) {
    if (delta <= 0) return 'jump';
    const bufEnd = Number(ad.getBuffered?.() || 0);
    if (!Number.isFinite(bufEnd) || bufEnd <= 0) {
      return delta > STARVE_CEILING ? 'jump' : 'defer';
    }
    const runway = bufEnd - curr;
    if (expected <= bufEnd) {
      if (delta <= 5.5 && ad.caps?.rate && runway >= 0.8) return 'speed';
      return (ad.isBuffered ? ad.isBuffered(expected) : true) ? 'jump' : 'defer';
    }
    if (delta > STARVE_CEILING) return 'jump';
    if (runway >= 1.2 && ad.caps?.rate) return 'speed';
    return 'defer';
  }

  speedSync(curr, expected, base) {
    const delta = expected - curr;
    const dir = Math.sign(delta), lastDir = Math.sign(this.lastDelta);
    if (dir && lastDir && dir !== lastDir) {
      this.flipCount += this.inSyncCount === 0 ? 2 : this.inSyncCount === 1 ? 1 : 0;
      this.inSyncCount = 0;
    }
    if (dir) this.lastDelta = delta;
    const threshold = this.flipCount >= 2 ? FLIP : COARSE;
    const mod = Math.abs(delta) > threshold ? COARSE_MOD : FINE_MOD;
    const rate = Number((base * (1 + (delta > 0 ? mod : -mod))).toFixed(3));
    const diff = Math.abs(rate - base);
    const timeout = diff < 1e-4 ? CYCLE_MS : Math.min(Math.max(120, Math.abs(delta / diff) * 1000), CYCLE_MS);
    return { rate, timeout };
  }

  loop() {
    let next = CYCLE_MS;
    try { next = this.step(); } catch (e) { console.warn('[sync]', e); }
    this.timer = setTimeout(() => this.loop(), next);
  }

  step() {
    const media = this.getMedia();
    const ad = this.getAdapter();
    if (!this.enabled || !media || !ad) { this.mode = 'idle'; this.onStatus({ mode: 'idle' }); return CYCLE_MS; }
    const status = media.meshStateStatus || (media.playing ? 'PLAYING' : 'PAUSED');
    const base = Number(media.meshStatePlaybackSpeed ?? media.rate ?? 1);
    const expected = expectedPosition(media);
    if (!ad.caps.seek) { this.mode = ad.caps.live ? 'live' : 'embed'; this.onStatus({ mode: this.mode }); return CYCLE_MS; }
    if (ad.isEnded?.() || ad.video?.ended) {
      this.mode = 'ended';
      return CYCLE_MS;
    }
    if (ad.video && ad.video.readyState < 1) {
      this.mode = 'buffering';
      this.onStatus({ mode: 'buffering', delta: 0, curr: 0, expected: 0, rate: 1 });
      return CYCLE_MS;
    }
    const curr = ad.getTime();
    const dur = Number(ad.getDuration?.() || media.duration || 0);
    if (dur > 25 && curr >= dur - 0.5 && expected >= dur - 1.5) {
      this.mode = 'inSync';
      return CYCLE_MS;
    }
    const delta = expected - curr;
    const abs = Math.abs(delta);
    const now = performance.now();
    const leader = Boolean(this.isLeader());
    const rawTitleSig = String(media.seriesTitle || media.originalTitle || media.title || '').split(' — ')[0].trim().toLowerCase();
    const mediaIdSig = media.tmdbId
      ? `tmdb|${media.tmdbId}|${media.mediaType || 'movie'}|${media.season || 1}|${media.episode || 1}`
      : media.imdbId
        ? `imdb|${media.imdbId}|${media.mediaType || 'movie'}|${media.season || 1}|${media.episode || 1}`
        : (media.id && /^(fhd|hfnl|dbx|dl|dp|acx|anx|trd|krm|yt|tv|radyo)-/i.test(String(media.id)))
          ? `cat|${media.id}|${media.mediaType || 'movie'}|${media.season || 1}|${media.episode || 1}`
          : media.videoId
            ? `vid|${media.videoId}|${media.season || 1}|${media.episode || 1}`
            : (rawTitleSig && !media.isMusic && media.mediaType !== 'music' && !media.live)
              ? `title|${rawTitleSig}|${media.mediaType || 'movie'}|${media.season || 1}|${media.episode || 1}`
              : `${media.provider}|${media.videoId || ''}|${media.url || ''}|${media.season || ''}|${media.episode || ''}`;
    if (mediaIdSig !== this.mediaIdSig) {
      this.mediaIdSig = mediaIdSig;
      this.loadedAt = now;
      this.seekUntil = now + (leader ? 3000 : 4500);
      this.lastSeekTarget = expected;
      this.lastStatus = status;
      this.lastExpected = expected;
      this.didInitialSeek = false;
    }
    const statusChanged = status !== this.lastStatus;
    this.lastStatus = status;
    const stepDtSec = this.lastStepAt ? Math.max(0, (now - this.lastStepAt) / 1000) : 0;
    this.lastStepAt = now;
    const naturalExpected = Number.isFinite(this.lastExpected)
      ? this.lastExpected + (status === 'PLAYING' && !statusChanged ? stepDtSec * base : 0)
      : expected;
    const expectedJump = Number.isFinite(this.lastExpected) && Math.abs(expected - naturalExpected) > JUMP_DELTA;
    this.lastExpected = expected;
    const stateChanged = statusChanged || expectedJump;
    if (stateChanged) {
      this.lastJumpAt = now;
      this.reJumps = 0;
      if (!leader && (statusChanged || Math.abs(expected - (this.lastSeekTarget ?? -999)) > JUMP_DELTA)) {
        this.seekUntil = 0;
        this.deferStartedAt = 0;
      }
    }
    let timeout = CYCLE_MS;

    if (status !== 'PLAYING') {
      if (!ad.isPaused()) ad.pause();
      if (!leader && !ad.isBuffering() && !ad.video?.seeking && abs > 0.35 && now > this.seekUntil) {
        this.lastSeekTarget = expected;
        ad.seek(expected);
        this.seekUntil = now + 1200;
      }
      ad.setRate(base);
      this.mode = 'paused';
      this.onStatus({ mode: this.mode, delta: 0, curr, expected: curr, rate: ad.getRate() });
      return timeout;
    }

    if (ad.isPaused()) {
      if (!ad.video?.seeking && !ad.isBuffering?.() && now - (this.lastPlayAttempt || 0) > 1200) {
        this.lastPlayAttempt = now;
        ad.play();
      }
      this.mode = 'inSync';
      this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return 600;
    }

    const buffered = (t) => (ad.isBuffered ? ad.isBuffered(t) : true);
    if (this.wasBuffering && !ad.isBuffering()) {
      this.wasBuffering = false;
      this.deferStartedAt = 0;
      if (!leader && abs > 5.5 && buffered(expected) && now > this.seekUntil) {
        this.lastSeekTarget = expected;
        ad.seek(expected);
        this.seekUntil = now + SEEK_SETTLE_MS;
      } else {
        this.seekUntil = Math.max(this.seekUntil, now + 1800);
      }
    }
    if (ad.isBuffering()) {
      this.wasBuffering = true;
      this.mode = 'buffering';
      this.onStatus({ mode: 'buffering', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return 500;
    }

    if (leader) {
      if (Math.abs(ad.getRate() - base) >= 0.02) ad.setRate(base);
      const startTarget = Number(media.meshStatePosition ?? media.currentTime ?? 0);
      if (!this.didInitialSeek && startTarget >= 5 && curr < 2 && now - (this.loadedAt || 0) < 8000) {
        this.didInitialSeek = true;
        this.lastSeekTarget = startTarget;
        ad.seek(startTarget);
        this.seekUntil = now + SEEK_SETTLE_MS;
      } else if (curr > 0.2 && !ad.video?.seeking && ((abs > 1.0 && now - this.lastLeaderBroadcast > 1800) || (now - this.lastLeaderBroadcast > 3000))) {
        this.lastLeaderBroadcast = now;
        this.onLeaderSync(curr);
      }
      this.mode = 'inSync';
      this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return CYCLE_MS;
    }

    const activelySeekingToTarget = Boolean(ad.video?.seeking && Math.abs(expected - (this.lastSeekTarget ?? -999)) < 3.5);
    if (activelySeekingToTarget || now < this.seekUntil || (curr < 0.1 && now - (this.loadedAt || 0) < 2500 && expected < 3)) {
      this.mode = 'inSync';
      this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return 500;
    }

    const quantized = !!ad.caps.rateSteps;
    if (this.pendingSeekAt && !ad.isPaused()) {
      const lat = (now - this.pendingSeekAt) / 1000;
      this.bufferLatency = Math.min(5, Math.max(0.2, (this.bufferLatency || 0.4) * 0.5 + lat * 0.5));
      this.pendingSeekAt = 0;
    }
    const lead = quantized ? 0.30 : 0.05;
    const bufEnd = Number(ad.getBuffered?.() || 0);
    const runway = bufEnd > curr ? (bufEnd - curr) : 0;
    if ((stateChanged && abs > 1.5 && now > this.seekUntil) || abs > JUMP_DELTA) {
      const inBuf = buffered(expected + lead);
      const behindAct = (delta > 0 && delta < 6.0)
        ? this.decideBehindAction(ad, curr, expected, delta)
        : (delta < 0 && delta > -10.0 && !stateChanged && ad.caps?.rate ? 'speed' : 'jump');
      if (behindAct === 'speed') {
        this.deferStartedAt = 0;
        const sp = this.speedSync(curr, expected, base);
        if (Math.abs(ad.getRate() - sp.rate) >= 0.001) ad.setRate(sp.rate);
        timeout = Math.max(450, sp.timeout);
        this.mode = 'speedSync';
      } else if (behindAct === 'defer' && (!this.deferStartedAt || now - this.deferStartedAt < DEFER_MAX_MS)) {
        if (!this.deferStartedAt) this.deferStartedAt = now;
        const catchupRate = (runway >= 0.8 && ad.caps?.rate) ? Math.min(base + 0.035, 1.05) : base;
        if (Math.abs(ad.getRate() - catchupRate) >= 0.01) ad.setRate(catchupRate);
        this.mode = 'inSync';
        this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
        return 700;
      } else {
        this.deferStartedAt = 0;
        const targetPos = inBuf ? expected + lead : expected + Math.min(0.6, this.bufferLatency || 0.15) * base;
        this.lastSeekTarget = targetPos;
        ad.seek(targetPos);
        if (Math.abs(ad.getRate() - base) >= 0.02) ad.setRate(base);
        this.pendingSeekAt = inBuf ? 0 : now;
        this.seekUntil = now + (inBuf ? SEEK_SETTLE_MS : 3600);
        this.lastJumpAt = now; this.reJumps = 0;
        this.inSyncCount = 0;
        this.mode = 'jumpSync';
      }
    } else if (quantized) {
      this.deferStartedAt = 0;
      if (Math.abs(ad.getRate() - base) >= 0.02) ad.setRate(base);
      this.inSyncCount += 1;
      if (this.inSyncCount >= 4) this.flipCount = 0;
      this.mode = 'inSync';
    } else if (abs > IN_SYNC && ad.caps.rate) {
      this.deferStartedAt = 0;
      if (delta > 0 && bufEnd > 0 && runway < 0.8) {
        if (Math.abs(ad.getRate() - base) >= 0.02) ad.setRate(base);
        this.mode = 'inSync';
        timeout = 700;
      } else {
        const sp = this.speedSync(curr, expected, base);
        if (Math.abs(ad.getRate() - sp.rate) >= 0.001) ad.setRate(sp.rate);
        timeout = Math.max(450, sp.timeout);
        this.mode = 'speedSync';
      }
    } else {
      this.deferStartedAt = 0;
      if (Math.abs(ad.getRate() - base) >= 0.001) ad.setRate(base);
      this.inSyncCount += 1;
      if (this.inSyncCount >= 4) this.flipCount = 0;
      this.mode = 'inSync';
    }
    this.onStatus({ mode: this.mode, delta, curr, expected, rate: ad.getRate() });
    return timeout;
  }
}
