// Port of Rave's VideoPlayerSync (common.deobf.js @587800/@730900), adapter-agnostic.
// Mesh state is authoritative: {meshStateStatus, meshStatePosition, meshStateTime, meshStatePlaybackSpeed}.
import { isRoomMediaPlaying } from './store.js?v=20261104_v105';

const CYCLE_MS = 1000;
const JUMP_DELTA = 3.5;
const IN_SYNC = 3.5;
const STARVE_CEILING = 55.0;  // Max behind before forcing jump
const DEFER_MAX_MS = 35000;   // Max defer window while buffer builds
const SEEK_SETTLE_MS = 12000;

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
  const status = isRoomMediaPlaying(media) ? 'PLAYING' : 'PAUSED';
  const pos = Number(media.meshStatePosition ?? media.currentTime ?? 0);
  const rawT0 = Number(media.meshStateTime ?? media.updatedAt ?? clock.now());
  const t0 = rawT0 > 1e11 ? rawT0 / 1000 : rawT0;
  const speed = Number(media.meshStatePlaybackSpeed ?? media.rate ?? 1);
  if (status !== 'PLAYING') return Math.max(0, pos);
  return Math.max(0, pos + Math.max(0, clock.now() - t0) * speed);
}

export class SyncEngine {
  constructor({ getMedia, getAdapter, isLeader, isSolo, onLeaderSync, onStatus }) {
    this.getMedia = getMedia;
    this.getAdapter = getAdapter;
    this.isLeader = isLeader || (() => false);
    this.isSolo = isSolo || (() => false);
    this.onLeaderSync = onLeaderSync || (() => {});
    this.onStatus = onStatus || (() => {});
    this.timer = null;
    this.lastDelta = 0; this.inSyncCount = 0; this.flipCount = 0;
    this.seekUntil = 0;
    this.deferStartedAt = 0;
    this.lastLeaderBroadcast = 0;
    this.didAnchorPlay = false;
    this.isRateNudging = false;
    this.mode = 'idle';
    this.enabled = true;
  }

  start() { this.stop(); this.loop(); }
  stop() { clearTimeout(this.timer); this.timer = null; }
  tickFromMedia() {
    const now = performance.now();
    if (!this.enabled || now - (this._lastBgTick || 0) < 850) return;
    this._lastBgTick = now;
    try { this.step(); } catch (e) { /* ignore */ }
  }
  kick(resetCooldown = false) {
    if (resetCooldown) {
      this.inSyncCount = 0;
      this.flipCount = 0;
      this.seekUntil = 0;
      this.deferStartedAt = 0;
    }
    this.start();
  }

  // Rave buffer-starvation guard: never slow down or speed up playback rate; only jump when buffered or far behind.
  decideBehindAction(ad, curr, expected, delta) {
    if (delta <= 0) return 'jump';
    const bufEnd = Number(ad.getBuffered?.() || 0);
    if (!Number.isFinite(bufEnd) || bufEnd <= 0) {
      return delta > STARVE_CEILING ? 'jump' : 'defer';
    }
    if (expected <= bufEnd) {
      return (ad.isBuffered ? ad.isBuffered(expected) : true) ? 'jump' : 'defer';
    }
    if (delta > STARVE_CEILING) return 'jump';
    return 'defer';
  }

  speedSync(curr, expected, base) {
    return { rate: base, timeout: CYCLE_MS };
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
    const status = isRoomMediaPlaying(media) ? 'PLAYING' : 'PAUSED';
    const base = Number(media.meshStatePlaybackSpeed ?? media.rate ?? 1);
    const expected = expectedPosition(media);
    if (!ad.caps.seek) { this.mode = ad.caps.live ? 'live' : 'embed'; this.onStatus({ mode: this.mode }); return CYCLE_MS; }
    if (ad.isEnded?.() || ad.video?.ended) {
      this.mode = 'ended';
      return CYCLE_MS;
    }
    const now = performance.now();
    const activeVideo = ad._activeMediaEl ? ad._activeMediaEl() : ad.video;
    if (activeVideo && activeVideo.readyState < 1 && !(typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive)) {
      this.lastStepAt = now;
      this.lastExpected = expected;
      this.mode = 'buffering';
      this.onStatus({ mode: 'buffering', delta: 0, curr: expected, expected, rate: 1 });
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
    const leader = Boolean(this.isLeader());
    const rawTitleCandidate = String(media.seriesTitle || media.originalTitle || media.title || '').split(' — ')[0].trim().toLowerCase();
    const rawTitleSig = ['video', 'medya', 'stream', 'canlı yayın', 'medya yükleniyor…', 'medya seçilmedi'].includes(rawTitleCandidate)
      ? ''
      : rawTitleCandidate;
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
    const isUnresolvedUrl = String(media.url || '').startsWith('/api/rave/resolve-catalog');
    const justResolvedUrl = Boolean(this.wasUnresolvedUrl && !isUnresolvedUrl);
    this.wasUnresolvedUrl = isUnresolvedUrl;
    if (mediaIdSig !== this.mediaIdSig || justResolvedUrl) {
      this.mediaIdSig = mediaIdSig;
      this.loadedAt = now;
      this.seekUntil = now + (leader ? 1800 : 2000);
      this.lastSeekTarget = expected;
      this.lastSeekWallAt = now;
      this.lastStatus = status;
      this.lastExpected = expected;
      this.lastStepAt = now;
      this.didInitialSeek = false;
      this.didAnchorPlay = false;
      this.isRateNudging = false;
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
      const elapsedSinceSeek = this.lastSeekWallAt ? Math.max(0, (now - this.lastSeekWallAt) / 1000) * base : 0;
      const driftedTarget = Number.isFinite(this.lastSeekTarget) ? this.lastSeekTarget + elapsedSinceSeek : -999;
      if (!leader && (statusChanged || (expectedJump && Math.abs(expected - driftedTarget) > JUMP_DELTA + 2.0))) {
        this.seekUntil = 0;
        this.deferStartedAt = 0;
      }
    }
    let timeout = CYCLE_MS;

    if (status !== 'PLAYING') {
      if (!ad.isPaused()) ad.pause();
      if (!leader && !ad.isBuffering() && !ad.video?.seeking && abs > 0.08 && now > this.seekUntil) {
        this.lastSeekTarget = expected;
        this.lastSeekWallAt = now;
        ad.seek(expected);
        this.seekUntil = now + 1800;
      }
      this.isRateNudging = false;
      if (Math.abs(ad.getRate() - base) >= 0.005) ad.setRate(base);
      this.mode = 'paused';
      this.onStatus({ mode: this.mode, delta: 0, curr, expected: curr, rate: ad.getRate() });
      return timeout;
    }

    if (leader && Math.abs(ad.getRate() - base) >= 0.005) ad.setRate(base);

    if (ad.isPaused()) {
      if (leader && ad.wantPlaying === false) {
        this.mode = 'paused';
        this.onStatus({ mode: 'paused', delta: 0, curr, expected: curr, rate: ad.getRate() });
        return timeout;
      }
      const hiddenNonPip = typeof document !== 'undefined' && document.visibilityState === 'hidden' && !ad.isPiP?.() && !(typeof window !== 'undefined' && window.__kinoxHost?._nativeIosPipActive) && !ad.isMusic;
      if (hiddenNonPip || ad.autoplayHardBlocked) {
        return timeout;
      }
      if (!ad.video?.seeking && !ad.isBuffering?.() && now - (this.lastPlayAttempt || 0) > 1200) {
        this.lastPlayAttempt = now;
        ad.play();
      }
      this.mode = 'inSync';
      this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return 600;
    }

    const buffered = (t) => (ad.isBuffered ? ad.isBuffered(t) : true);
    const safeBuffered = (t, minAhead = 2.8) => buffered(t) && (!ad.getBuffered || (Number(ad.getBuffered() || 0) - t) >= minAhead);
    if (this.wasBuffering && !ad.isBuffering()) {
      this.wasBuffering = false;
      this.deferStartedAt = 0;
      if (abs > 0.35 && safeBuffered(expected, 2.8) && now > this.seekUntil) {
        this.lastSeekTarget = expected;
        this.lastSeekWallAt = now;
        ad.seek(expected);
        this.seekUntil = now + 2400;
      } else {
        this.seekUntil = Math.max(this.seekUntil, now + 1100);
      }
    }
    if (ad.isBuffering()) {
      this.wasBuffering = true;
      this.mode = 'buffering';
      this.onStatus({ mode: 'buffering', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return 500;
    }

    if (leader) {
      const startTarget = Number(media.meshStatePosition ?? media.currentTime ?? 0);
      if (!this.didInitialSeek && startTarget >= 3 && curr < 2 && now - (this.loadedAt || 0) < 25000) {
        this.didInitialSeek = true;
        this.lastSeekTarget = startTarget;
        this.lastSeekWallAt = now;
        ad.seek(startTarget);
        this.seekUntil = now + 2200;
        this.mode = 'inSync';
        this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
        return CYCLE_MS;
      }
      if (this.isSolo()) {
        if (!(ad.initialSeekPending > 3) && now > this.seekUntil && curr > 0.2 && !ad.video?.seeking && !ad.isBuffering?.() && abs > 1.5 && now - this.lastLeaderBroadcast > 4000) {
          this.lastLeaderBroadcast = now;
          this.onLeaderSync(curr);
        }
        this.isRateNudging = false;
        if (Math.abs(ad.getRate() - base) >= 0.005) ad.setRate(base);
        this.mode = 'inSync';
        this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: base });
        return CYCLE_MS;
      }
      if (!(ad.initialSeekPending > 3) && now > this.seekUntil && curr > 0.2 && !ad.video?.seeking && !ad.isBuffering?.() && !buffered(expected) && abs > JUMP_DELTA && now - this.lastLeaderBroadcast > 8000) {
        this.lastLeaderBroadcast = now;
        this.onLeaderSync(curr);
        this.mode = 'inSync';
        this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
        return CYCLE_MS;
      }
      this.mode = 'inSync';
      this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return CYCLE_MS;
    }

    const seekWallElapsed = this.lastSeekWallAt ? Math.max(0, (now - this.lastSeekWallAt) / 1000) * base : 0;
    const expectedSinceLastSeek = Number.isFinite(this.lastSeekTarget) ? this.lastSeekTarget + seekWallElapsed : -999;
    const activelySeekingToTarget = Boolean(
      (ad.video?.seeking || (ad.video && ad.video.readyState < 3))
      && Math.abs(expected - expectedSinceLastSeek) < 12.0
      && this.lastSeekWallAt
      && (now - this.lastSeekWallAt < 18000)
    );
    if (activelySeekingToTarget || now < this.seekUntil || (curr < 0.1 && now - (this.loadedAt || 0) < 4000 && expected < 5)) {
      this.mode = 'inSync';
      this.onStatus({ mode: 'inSync', delta: 0, curr, expected: curr, rate: ad.getRate() });
      return 600;
    }

    if (this.pendingSeekAt && !ad.isPaused()) {
      const lat = (now - this.pendingSeekAt) / 1000;
      this.bufferLatency = Math.min(5, Math.max(0.2, (this.bufferLatency || 0.4) * 0.5 + lat * 0.5));
      this.pendingSeekAt = 0;
    }
    if ((stateChanged && abs > 2.5 && now > this.seekUntil) || abs > JUMP_DELTA) {
      const inBuf = buffered(expected);
      const behindAct = (delta > 0 && delta < STARVE_CEILING && !stateChanged)
        ? this.decideBehindAction(ad, curr, expected, delta)
        : 'jump';
      if (behindAct === 'defer' && (!this.deferStartedAt || now - this.deferStartedAt < Math.min(DEFER_MAX_MS, 14000))) {
        if (!this.deferStartedAt) this.deferStartedAt = now;
        const showBuf = abs > 3.5;
        this.mode = showBuf ? 'buffering' : 'inSync';
        this.onStatus({
          mode: this.mode,
          delta: showBuf ? delta : 0,
          curr,
          expected: showBuf ? expected : curr,
          rate: base,
        });
        return 1000;
      }
      this.deferStartedAt = 0;
      this.isRateNudging = false;
      if (Math.abs(ad.getRate() - base) >= 0.005) ad.setRate(base);
      const targetPos = expected;
      this.lastSeekTarget = targetPos;
      this.lastSeekWallAt = now;
      ad.seek(targetPos);
      this.pendingSeekAt = inBuf ? 0 : now;
      this.seekUntil = now + (inBuf ? 4200 : SEEK_SETTLE_MS);
      this.lastJumpAt = now; this.reJumps = 0;
      this.inSyncCount = 0;
      this.mode = 'jumpSync';
    } else if (abs > 0.75 && safeBuffered(expected, 2.8) && now > this.seekUntil) {
      this.deferStartedAt = 0;
      this.isRateNudging = false;
      if (Math.abs(ad.getRate() - base) >= 0.005) ad.setRate(base);
      this.lastSeekTarget = expected;
      this.lastSeekWallAt = now;
      ad.seek(expected);
      this.seekUntil = now + 2600;
      this.inSyncCount = 0;
      this.mode = 'inSync';
    } else {
      this.deferStartedAt = 0;
      const fwdBuf = (Number(ad.getBuffered?.() || 0)) - curr;
      const shouldNudge = (abs > 0.085 || (this.isRateNudging && abs > 0.04))
        && abs <= JUMP_DELTA
        && buffered(expected)
        && fwdBuf > 1.2
        && ad.caps?.rate !== false;
      if (shouldNudge) {
        this.isRateNudging = true;
        const maxNudge = abs > 0.35 ? 0.14 : 0.08;
        const nudge = Math.sign(delta) * Math.min(maxNudge, Math.max(0.025, abs * 0.28));
        const targetRate = Number((base + nudge).toFixed(3));
        if (Math.abs(ad.getRate() - targetRate) >= 0.01) {
          ad.setRate(targetRate);
        }
        timeout = 380;
      } else {
        this.isRateNudging = false;
        if (Math.abs(ad.getRate() - base) >= 0.005) {
          ad.setRate(base);
        }
      }
      this.inSyncCount += 1;
      if (this.inSyncCount >= 4) this.flipCount = 0;
      this.mode = 'inSync';
    }
    this.onStatus({ mode: this.mode, delta, curr, expected, rate: ad.getRate() });
    return timeout;
  }
}
