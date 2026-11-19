import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AdaptiveQualityController,
  buildHlsAbrConfig,
  withEdgeAbrParams,
} from '../static/js/players/abr.js';
import { adaptMasterM3u8Variants } from '../workers/ha-gateway/edge_streams.js';
import { SyncEngine } from '../static/js/sync.js';

const MOCK_LEVELS = [
  { width: 640, height: 360, bitrate: 800_000 },
  { width: 854, height: 480, bitrate: 1_400_000 },
  { width: 1280, height: 720, bitrate: 2_800_000 },
  { width: 1920, height: 1080, bitrate: 5_200_000 },
];

test('buildHlsAbrConfig adapts startLevel, timeouts, and EWMA conservatively on slow mountain mobile networks', () => {
  const slowCfg = buildHlsAbrConfig({
    isMobileScreen: true,
    netSnap: { effectiveType: '2g', downlinkMbps: 0.6, rttMs: 750, saveData: false, lowBwPref: false, rememberedBps: 0, isVerySlow: true, isSlow: true, isFast: false },
  });
  assert.equal(slowCfg.startLevel, 0);
  assert.ok(slowCfg.abrEwmaDefaultEstimate <= 550_000);
  assert.equal(slowCfg.fragLoadingTimeOut, 12000);
  assert.ok(slowCfg.abrBandWidthUpFactor <= 0.55);

  const fastCfg = buildHlsAbrConfig({
    isMobileScreen: false,
    netSnap: { effectiveType: '4g', downlinkMbps: 25, rttMs: 40, saveData: false, lowBwPref: false, rememberedBps: 0, isVerySlow: false, isSlow: false, isFast: true },
  });
  assert.equal(fastCfg.startLevel, -1);
  assert.ok(fastCfg.abrEwmaDefaultEstimate >= 2_000_000);
});

test('AdaptiveQualityController downshifts immediately on stall/timeout and smoothly recovers back to HD when speed returns', () => {
  let t = 1_000_000;
  const abr = new AdaptiveQualityController({
    isMobileScreen: false,
    netSnap: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, saveData: false, lowBwPref: false, rememberedBps: 0, isVerySlow: false, isSlow: false, isFast: true },
  });
  const initCap = abr.setLevels(MOCK_LEVELS, { now: t, netSnap: { isVerySlow: false, isSlow: false, isFast: true, saveData: false } });
  assert.equal(initCap, 3); // 1080p allowed initially on fast link

  // Signal suddenly collapses in the mountains -> severe stall with near-empty buffer
  t += 5000;
  const down1 = abr.handleStall({ reason: 'timeout', bufAheadSec: 0.4, currentHlsLevel: 3, now: t });
  assert.equal(down1.changed, true);
  assert.equal(down1.direction, 'down');
  assert.equal(down1.targetHlsIndex, 1); // dropped 2 tiers (1080p -> 480p)
  assert.equal(down1.abortCurrent, true);

  // Another stall quickly -> drops all the way to 360p (lowest)
  t += 4000;
  const down2 = abr.handleStall({ reason: 'stall', bufAheadSec: 0.5, currentHlsLevel: 1, now: t });
  assert.equal(down2.changed, true);
  assert.equal(down2.targetHlsIndex, 0); // 360p

  // During cooldown, even a fast burst does NOT yo-yo back up
  t += 5000;
  for (let i = 0; i < 4; i += 1) {
    abr.recordFragmentLoad({ bytes: 1_500_000, durationMs: 1000, now: t + i * 500 }); // 12 Mbps
  }
  const blockedUp = abr.evaluateTick({ now: t + 3000, playing: true, bufAheadSec: 18, currentHlsLevel: 0, hlsBwEstimate: 10_000_000 });
  assert.equal(blockedUp.changed, false);

  // After cooldown + sustained smooth playback + full buffer + strong throughput -> climbs smoothly 360p -> 480p -> 720p -> 1080p
  t += 35_000;
  for (let i = 0; i < 6; i += 1) {
    abr.recordFragmentLoad({ bytes: 2_000_000, durationMs: 1200, now: t + i * 1000 }); // ~13.3 Mbps
  }
  const up1 = abr.evaluateTick({ now: t + 6000, playing: true, bufAheadSec: 18, currentHlsLevel: 0, hlsBwEstimate: 12_000_000 });
  assert.equal(up1.changed, true);
  assert.equal(up1.direction, 'up');
  assert.equal(up1.targetHlsIndex, 1); // 480p

  const up2 = abr.evaluateTick({ now: t + 16_000, playing: true, bufAheadSec: 20, currentHlsLevel: 1, hlsBwEstimate: 12_000_000 });
  assert.equal(up2.changed, true);
  assert.equal(up2.targetHlsIndex, 2); // 720p

  const up3 = abr.evaluateTick({ now: t + 26_000, playing: true, bufAheadSec: 20, currentHlsLevel: 2, hlsBwEstimate: 12_000_000 });
  assert.equal(up3.changed, true);
  assert.equal(up3.targetHlsIndex, 3); // 1080p restored!
});

test('AdaptiveQualityController proactively downshifts on draining buffer, respects manual lock, and handles bogus identical bitrates', () => {
  let t = 2_000_000;
  const bogusLevels = [
    { width: 1920, height: 1080, bitrate: 2_000_000 },
    { width: 854, height: 480, bitrate: 2_000_000 },
    { width: 1280, height: 720, bitrate: 2_000_000 },
  ];
  const abr = new AdaptiveQualityController({ isMobileScreen: false });
  abr.setLevels(bogusLevels, { now: t, netSnap: { isVerySlow: false, isSlow: false, isFast: true, saveData: false } });
  // Ladder must sort 480p (idx 1) < 720p (idx 2) < 1080p (idx 0)
  assert.deepEqual(abr.ladder.map((l) => l.height), [480, 720, 1080]);

  // Feed slow 1.1 Mbps fragments while playing 1080p with draining buffer (3.1s) -> proactive downshift BEFORE freeze
  t += 6000;
  for (let i = 0; i < 4; i += 1) {
    abr.recordFragmentLoad({ bytes: 140_000, durationMs: 1000, now: t + i * 200 });
  }
  const proactive = abr.evaluateTick({ now: t + 1000, playing: true, bufAheadSec: 3.1, currentHlsLevel: 0, hlsBwEstimate: 1_100_000 });
  assert.equal(proactive.changed, true);
  assert.equal(proactive.direction, 'down');
  assert.equal(proactive.targetHlsIndex, 2); // 720p

  // Manual user lock freezes ABR completely until Auto is re-selected
  abr.setManualLevel(0);
  const locked = abr.handleStall({ reason: 'timeout', bufAheadSec: 0.2, currentHlsLevel: 0, now: t + 3000 });
  assert.equal(locked.changed, false);

  abr.setAutoMode(t + 4000);
  const unlocked = abr.handleStall({ reason: 'timeout', bufAheadSec: 0.2, currentHlsLevel: 0, now: t + 5000 });
  assert.equal(unlocked.changed, true);
  assert.equal(unlocked.direction, 'down');
});

test('edge_streams adaptMasterM3u8Variants filters maxHeight, orders lowStart first for iOS AVPlayer, and preserves #EXT-X-MEDIA', () => {
  const sampleMaster = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",URI="/api/rave/stream?sid=aud_tr"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,AUDIO="aud"',
    '/api/rave/stream?sid=1080',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,AUDIO="aud"',
    '/api/rave/stream?sid=720',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,AUDIO="aud"',
    '/api/rave/stream?sid=480',
    '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,AUDIO="aud"',
    '/api/rave/stream?sid=360',
  ];

  // 1. lowStart=true keeps ALL 4 variants (so Apple AVPlayer can ramp up to 1080p) but puts 360p FIRST!
  const lowOrdered = adaptMasterM3u8Variants(sampleMaster, { maxHeight: 0, lowStart: true });
  assert.deepEqual(lowOrdered.heights, [360, 480, 720, 1080]);
  assert.ok(lowOrdered.body.includes('#EXT-X-MEDIA:TYPE=AUDIO'));
  const idx360 = lowOrdered.body.indexOf('sid=360');
  const idx1080 = lowOrdered.body.indexOf('sid=1080');
  assert.ok(idx360 > 0 && idx1080 > idx360);

  // 2. maxHeight=480 filters out 720p/1080p while keeping 360p and 480p
  const capped = adaptMasterM3u8Variants(sampleMaster, { maxHeight: 480, lowStart: true });
  assert.ok(capped.body.includes('sid=360'));
  assert.ok(capped.body.includes('sid=480'));
  assert.ok(!capped.body.includes('sid=720'));
  assert.ok(!capped.body.includes('sid=1080'));

  // 3. Requesting maxHeight=240 never returns an empty playlist (keeps 360p lowest fallback)
  const fallback = adaptMasterM3u8Variants(sampleMaster, { maxHeight: 240, lowStart: true });
  assert.ok(fallback.body.includes('sid=360'));

  // 4. URL helper cleanly adds/removes params on edge stream URLs and leaves external URLs untouched
  assert.equal(
    withEdgeAbrParams('/api/rave/stream?sid=abc&ext=.m3u8', { maxHeight: 480, lowStart: true }),
    '/api/rave/stream?sid=abc&ext=.m3u8&max_h=480&abr_low=1',
  );
  assert.equal(
    withEdgeAbrParams('https://cdn.example.com/master.m3u8', { maxHeight: 480, lowStart: true }),
    'https://cdn.example.com/master.m3u8',
  );
});

test('SyncEngine defers aggressive guest hard-seek during active ABR quality-downshift grace window', () => {
  let seeks = 0;
  const nowPerf = performance.now();
  const mockAdapter = {
    caps: { seek: true, rate: true },
    abrGraceUntil: nowPerf + 8000,
    video: { readyState: 4, seeking: false, ended: false },
    getTime: () => 100.0,
    getDuration: () => 3600,
    getRate: () => 1.0,
    setRate: () => {},
    isPaused: () => false,
    isBuffering: () => false,
    isBuffered: () => false,
    getBuffered: () => 104,
    seek: () => { seeks += 1; },
  };
  const mockMedia = {
    provider: 'hls',
    url: '/api/rave/stream?sid=test',
    meshStateStatus: 'PLAYING',
    meshStatePosition: 108.5, // 8.5s ahead (> JUMP_DELTA 5.5s, < 14s ABR grace threshold)
    meshStateUpdatedAt: Date.now() / 1000,
    meshStatePlaybackSpeed: 1,
  };
  const engine = new SyncEngine({
    getMedia: () => mockMedia,
    getAdapter: () => mockAdapter,
    isLeader: () => false,
    onStatus: () => {},
  });
  engine.enabled = true;
  engine.didInitialSync = true;
  engine.mediaIdSig = 'hls||/api/rave/stream?sid=test|1|1';
  engine.lastStatus = 'PLAYING';
  engine.lastExpected = 108.5;
  engine.lastStepAt = nowPerf - 500;
  engine.step();
  assert.equal(seeks, 0, 'SyncEngine must not hard-seek and wipe freshly downshifted guest buffer during ABR grace window');
});
