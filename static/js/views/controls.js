// Player overlay (Rave VideoPlayerControlsFC + MeshVideoPlayer pre-message/error states).
import { h, icons, fmtTime, fill, popup, toast } from '../ui.js?v=20261114_v210';
import { state, isLeader, canControlPlayback, isHostOnly, canSelectVideo, setView, saveWatchProgress, isRoomMediaPlaying } from '../store.js?v=20261114_v210';
import { resumeSharedAudioContext, ensureIosPlaybackAudioSession } from '../players/audio-gain.js?v=20261114_v210';
import { getProvider } from '../providers.js?v=20261114_v210';
import { expectedPosition } from '../sync.js?v=20261114_v210';
import { thumbFor } from './lobby.js?v=20261114_v210';
import { renderSeriesPicker, launchProviderWindow } from '../accounts.js?v=20261114_v210';
import { resolveCatalogItem } from './selection-kinds.js?v=20261114_v210';
import { getSubPrefs, setSubPrefs } from '../players/subtitles.js?v=20261114_v210';
import { avatar } from '../profile.js?v=20261114_v210';

const VIDEO_FILTERS = {
  normal: { label: '🎬 Standart (Orijinal)', css: 'none' },
  hdr:    { label: '✨ Sinema HDR (Canlı Kontrast)', css: 'contrast(1.14) saturate(1.22) brightness(1.03)' },
  vivid:  { label: '💎 IMAX Canlı & Keskin', css: 'contrast(1.18) saturate(1.3) brightness(1.05)' },
  night:  { label: '🌙 Gece Modu (Göz Koruma)', css: 'sepia(0.18) brightness(0.88) contrast(0.96)' },
  vhs:    { label: '📼 Retro VHS / 90lar', css: 'contrast(1.15) saturate(0.82) sepia(0.22) hue-rotate(-6deg)' },
};

const SN_ICONS = {
  fit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h3M7 9v3M17 15h-3M17 15v-3"/></svg>',
};

export function buildControls(frame, ctx) {
  const { actions, host } = ctx;
  const ico = (n) => h('span', { html: icons[n], style: { display: 'contents' } });
  const empty = h('div', { class: 'stage-empty hidden' },
    h('h2', {}, 'Henüz bir şey oynatılmıyor'),
    h('p', {}, 'Video Ara ile bir sağlayıcı seç. Seçtiğin video odadaki herkes için aynı anda başlar.'),
    h('button', { class: 'btn primary', onclick: () => { setView('left', 'Search'); ctx.layout.update(); } }, ico('searchVideo'), 'Video Ara'));
  const loading = h('div', { class: 'stage-empty hidden', style: { background: 'rgba(0,0,0,.35)', pointerEvents: 'none' } }, h('div', { class: 'spinner' }));
  const errorBox = h('div', { class: 'stage-error hidden' });
  const dualCue = h('div', { class: 'rave-subtitle-dual hidden', id: 'rave-sub-dual' });
  const subCue = h('div', { class: 'rave-subtitle-cue', id: 'rave-sub-primary' });
  const subOverlay = h('div', { class: 'rave-subtitle-overlay hidden', id: 'rave-sub-overlay' }, dualCue, subCue);

  function applySubPrefsStyle() {
    const p = getSubPrefs();
    const colorMap = {
      white: '#ffffff',
      yellow: '#ffe600',
      cyan: '#00f0ff',
      green: '#4ade80',
      pink: '#f472b6',
    };
    const fontMap = {
      'sans-serif': 'Inter, system-ui, -apple-system, sans-serif',
      serif: 'Georgia, Cambria, serif',
      monospace: 'ui-monospace, Consolas, monospace',
      cursive: '"Comic Sans MS", cursive, sans-serif',
    };
    const fs = frame.classList.contains('fullscreen') || Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    const isMob = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 960px)').matches;
    subCue.style.color = colorMap[p.color] || '#ffffff';
    subCue.style.fontFamily = fontMap[p.font] || fontMap['sans-serif'];
    subCue.style.fontSize = fs
      ? `calc(clamp(16px, 2.2vmin, 48px) * ${Number(p.size || 1)})`
      : isMob
        ? `calc(clamp(11px, 3.0vw, 15px) * ${Number(p.size || 1)})`
        : `calc(clamp(14px, 1.95vmin, 42px) * ${Number(p.size || 1)})`;
    subCue.style.padding = (isMob && !fs) ? '.15em .48em' : '.24em .68em';
    subCue.style.background = `rgba(8, 8, 14, ${Number(p.bgOpacity ?? 0.65)})`;
    const edge = p.edgeStyle || (p.shadow === false ? 'none' : 'drop');
    if (edge === 'outline') {
      subCue.style.textShadow = '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 2px 6px rgba(0,0,0,.9)';
    } else if (edge === 'none') {
      subCue.style.textShadow = 'none';
    } else {
      subCue.style.textShadow = '0 2px 6px rgba(0,0,0,.95), 0 0 2px #000';
    }
    const lift = Number(p.bottomOffset || 0);
    subOverlay.style.transform = lift > 0 ? `translate(-50%, -${lift}px)` : '';
  }
  applySubPrefsStyle();

  let uiTimer = null;
  let lastUiRevealAt = 0;
  let lastMouseX = -1;
  let lastMouseY = -1;
  let lastLayoutShiftAt = 0;
  let lastRevealedMediaKey = '';
  let lastPlayToggleAt = 0;
  let lastAnyTouchAt = 0;
  let localPauseSince = 0;
  const onGlobalTouchStamp = (ev) => {
    lastAnyTouchAt = Date.now();
    if (ev?.type === 'touchstart') resumeSharedAudioContext();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('touchstart', onGlobalTouchStamp, { capture: true, passive: true });
    window.addEventListener('touchend', onGlobalTouchStamp, { capture: true, passive: true });
  }
  const hideControlsNow = () => {
    clearTimeout(uiTimer);
    controls.classList.remove('ui-active');
    frame.classList.add('idle-cursor');
  };
  const revealControls = (ms) => {
    const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    const durationMs = ms || (isTouch ? 4500 : 3000);
    const wasVisible = (controls.classList.contains('ui-active') || controls.classList.contains('show')) && !frame.classList.contains('idle-cursor');
    if (!wasVisible) {
      lastUiRevealAt = Date.now();
    }
    frame.classList.remove('idle-cursor');
    controls.classList.add('ui-active');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      const v = host.adapter?.video;
      const activelyPlaying = Boolean(
        host.adapter
        && !host.loading
        && !host.autoplayBlocked
        && !host.adapter.isPaused?.()
        && (!v || (!v.paused && !v.ended && v.readyState >= 2))
      );
      if (!activelyPlaying || !menu.classList.contains('hidden') || frame.classList.contains('scrubbing')) return;
      controls.classList.remove('ui-active');
      frame.classList.add('idle-cursor');
    }, durationMs);
  };
  const syncUnlockAudioOnly = () => {
    resumeSharedAudioContext();
    host.userUnlocked = true;
    host.autoplayBlocked = false;
    host.unlockAudio();
    unmute.classList.add('hidden');
  };
  const doUnlockAudio = (e) => {
    if (e) { e.stopPropagation(); }
    syncUnlockAudioOnly();
    revealControls();
    update();
  };
  const tapProps = (fn, opts = {}) => {
    let lastFire = 0;
    let lastTouchAt = 0;
    let startX = 0;
    let startY = 0;
    const run = (e) => {
      if (e) e.stopPropagation();
      const now = Date.now();
      if (now - lastFire < 320) return;
      lastFire = now;
      if (!opts.noAutoReveal) revealControls(3600);
      fn(e);
    };
    return {
      onpointerdown: (e) => {
        e.stopPropagation();
        if (e.pointerType === 'touch' || e.pointerType === 'pen') lastAnyTouchAt = Date.now();
        resumeSharedAudioContext();
        startX = e.clientX || 0;
        startY = e.clientY || 0;
        if (!opts.noAutoReveal) revealControls(3600);
      },
      ontouchstart: (e) => {
        e.stopPropagation();
        lastAnyTouchAt = Date.now();
        resumeSharedAudioContext();
        const t = e.touches?.[0];
        if (t) { startX = t.clientX; startY = t.clientY; }
        if (!opts.noAutoReveal) revealControls(3600);
      },
      ontouchend: (e) => {
        e.stopPropagation();
        lastTouchAt = Date.now();
        lastAnyTouchAt = Date.now();
        const t = e.changedTouches?.[0];
        if (t && (Math.abs(t.clientX - startX) > 24 || Math.abs(t.clientY - startY) > 24)) return;
        if (e.cancelable) e.preventDefault();
        run(e);
      },
      onclick: (e) => {
        if (Date.now() - lastTouchAt < 950) {
          e.preventDefault?.();
          e.stopPropagation();
          return;
        }
        run(e);
      },
    };
  };
  const unmute = h('button', {
    class: 'btn primary unmute-pill hidden',
    id: 'ctl-unmute',
    ...tapProps(doUnlockAudio),
  }, ico('volume'), 'Sesi Aç');
  const overlayMsg = h('div', { class: 'stage-overlay-msg hidden' });

  const updateUnmuteVisibility = () => {
    if (!host.adapter || host.loading || host.userMuted) {
      unmute.classList.add('hidden');
      return;
    }
    const needUnmute = Boolean(host.autoplayBlocked || (isActuallyMuted() && Number(host.volume) > 0));
    unmute.classList.toggle('hidden', !needUnmute);
  };

  const stageBackdrop = h('div', { class: 'stage-ambient-poster', id: 'stage-ambient-poster' });
  const kickerBadge = h('div', { class: 'ctl-kicker-badge' }, h('span', { class: 'ctl-kicker-dot' }), 'ŞİMDİ OYNATILIYOR');
  const thumb = h('img', { class: 'ctl-thumb', alt: '' });
  const title = h('div', { class: 'ctl-title' });
  const artist = h('div', { class: 'ctl-artist' });
  const provLogo = h('img', { class: 'ctl-prov', id: 'video-provider-logo', alt: '' });
  const qualityBadge = h('span', {
    class: 'ctl-quality-badge',
    id: 'ctl-quality-badge',
    title: 'Görüntü Kalitesini Seç (1080p / 4K)',
    style: { cursor: 'pointer' },
    ...tapProps(() => toggleMenu('quality')),
  }, '1080p HD');
  const prevEpTopBtn = h('button', { type: 'button', class: 'btn ctl-pill hidden', id: 'ctl-prev-ep-top', title: 'Önceki Bölüm', ...tapProps(() => triggerPrevEpisode(true)) }, '⏮️ Önceki Bölüm');
  const epBtn = h('button', { type: 'button', class: 'btn ctl-pill hidden', id: 'ctl-ep-btn', ...tapProps(() => openEpisodeModal()) }, '📺 S1:B1');
  const nextEpTopBtn = h('button', { type: 'button', class: 'btn ctl-pill hidden', id: 'ctl-next-ep-top', title: 'Sonraki Bölüm', ...tapProps(() => triggerNextEpisode(true)) }, '⏭️ Sonraki Bölüm');
  const breakTopBtn = h('button', {
    type: 'button',
    class: 'btn ctl-pill ctl-break-pill',
    id: 'ctl-break-btn',
    title: 'Mola (duraklatma) isteği gönder veya odayı duraklat',
    ...tapProps(() => {
      if (state.mesh?.curated) {
        toast('7/24 canlı TV yayını duraklatılamaz');
        return;
      }
      if (canControlPlayback()) {
        actions.pause?.();
        toast('☕ Mola verildi — video duraklatıldı');
        showOverlay('☕ Mola Zamanı — Video duraklatıldı', 3000);
        return;
      }
      actions.requestBreak?.();
    }),
  }, '☕ Mola Zamanı');
  let breakBannerTimer = null;
  const breakBannerText = h('div', { class: 'break-banner-text', id: 'ctl-break-banner-text' }, '☕ Mola Zamanı — Duraklatma isteği geldi!');
  const breakAcceptBtn = h('button', {
    type: 'button',
    class: 'btn primary break-banner-accept',
    id: 'ctl-break-accept',
    ...tapProps(() => {
      breakBanner.classList.add('hidden');
      clearTimeout(breakBannerTimer);
      actions.pause?.();
      toast('⏸ Mola verildi — video duraklatıldı');
      showOverlay('☕ Mola Zamanı — Video duraklatıldı', 3000);
    }),
  }, '⏸ Şimdi Duraklat');
  const breakDismissBtn = h('button', {
    type: 'button',
    class: 'btn break-banner-dismiss',
    id: 'ctl-break-dismiss',
    'aria-label': 'Kapat',
    ...tapProps(() => {
      breakBanner.classList.add('hidden');
      clearTimeout(breakBannerTimer);
    }),
  }, '✕');
  const breakBanner = h('div', { class: 'break-request-banner hidden', id: 'ctl-break-banner' },
    h('span', { class: 'break-banner-ico' }, '☕'),
    breakBannerText,
    h('div', { class: 'break-banner-actions' }, breakAcceptBtn, breakDismissBtn));
  const subPillBtn = h('button', { type: 'button', class: 'btn ctl-pill hidden', id: 'ctl-sub-pill', ...tapProps(() => toggleMenu('subtitle')) }, '💬 Altyazı & Dublaj');
  const origBtn = h('button', { type: 'button', class: 'btn ctl-pill hidden', id: 'ctl-orig-btn', ...tapProps(() => openOfficialPlatform()) }, '🔐 Orijinal Platformda Aç');
  const isActuallyMuted = () => Boolean(host.isMuted?.() || host.adapter?.isMuted?.());
  const syncDot = h('span', { class: 'sync-dot', title: 'Senkron' });
  const syncText = h('span', { class: 'ctl-time', style: { opacity: .7 } });
  const canSeekNow = () => Boolean(canControlPlayback() && !state.mesh?.curated && !timeline.classList.contains('locked') && (!host.adapter || host.adapter.caps?.seek));
  const seekStep = (delta) => {
    if (state.mesh?.curated) { toast('7/24 canlı yayın akışı ileri/geri sarılamaz'); return; }
    if (!canSeekNow()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
    const base = (ctx.lastSeekAt && Date.now() - ctx.lastSeekAt < 1600 && Number.isFinite(ctx.lastSeekTarget))
      ? ctx.lastSeekTarget
      : position();
    const d = duration();
    const target = d > 0 ? Math.max(0, Math.min(d - 0.5, base + delta)) : Math.max(0, base + delta);
    actions.seek(target);
    subCue.textContent = '';
    subOverlay.classList.add('hidden');
    host.adapter?.subs?.clearActiveCue?.();
    showOverlay(`${delta > 0 ? '⏩ +' : '⏪ '}${delta} sn (${fmtTime(target)})`, 1200);
    revealControls();
  };
  const togglePlayPause = () => {
    const now = Date.now();
    if (now - lastPlayToggleAt < 260) return;
    lastPlayToggleAt = now;
    const roomPlaying = isRoomMediaPlaying(state.mesh?.media);
    const adapterPaused = host.adapter ? Boolean(host.adapter.isPaused?.()) : !roomPlaying;
    if (!canControlPlayback()) {
      if (roomPlaying && adapterPaused) {
        if (isActuallyMuted() && !host.userMuted) doUnlockAudio();
        host.adapter?.play?.();
        ctx.sync?.kick();
        revealControls(2400);
        update();
        return;
      }
      showOverlay('⏸ Yalnızca oda başkanı duraklatabilir · ☕ Mola Zamanı isteyebilirsiniz', 2800);
      toast('Videoyu yalnızca oda başkanı duraklatabilir veya başlatabilir');
      revealControls(3200);
      return;
    }
    const shouldPause = host.adapter ? (!adapterPaused && roomPlaying) : (roomPlaying && !ctx.userPaused);
    if (shouldPause) {
      actions.pause();
      host.adapter?.pause?.();
      revealControls(3600);
    } else {
      if (isActuallyMuted() && !host.userMuted) doUnlockAudio();
      host.adapter?.play?.();
      actions.play();
      revealControls(2200);
    }
    update();
  };
  const playBtn = h('button', { type: 'button', class: 'ctl-action', 'aria-label': 'Oynat/Duraklat', id: 'ctl-play', ...tapProps(togglePlayPause, { noAutoReveal: true }) });
  const back10Btn = h('button', {
    class: 'ctl-action',
    'data-tip': '10 sn geri',
    'aria-label': '10 saniye geri',
    id: 'ctl-back10',
    ...tapProps(() => {
      if (!canControlPlayback()) {
        toast('Videoyu yalnızca oda başkanı sarabilir');
        return;
      }
      seekStep(-10);
    }),
  }, ico('rewind10'));
  const fwd10Btn = h('button', {
    class: 'ctl-action',
    'data-tip': '10 sn ileri',
    'aria-label': '10 saniye ileri',
    id: 'ctl-fwd10',
    ...tapProps(() => {
      if (!canControlPlayback()) {
        toast('Videoyu yalnızca oda başkanı sarabilir');
        return;
      }
      seekStep(10);
    }),
  }, ico('forward10'));
  const cur = h('div', { class: 'cur' }), buf = h('div', { class: 'buf' }), knob = h('div', { class: 'knob' });
  const seekPreviewChapter = h('div', { class: 'seek-preview-chapter hidden' }, '');
  const seekPreviewSub = h('div', { class: 'seek-preview-sub' }, '');
  const seekPreviewTime = h('div', { class: 'seek-preview-time' }, '0:00');
  const seekPreview = h('div', { class: 'seek-preview-card hidden', id: 'ctl-seek-preview' }, seekPreviewChapter, seekPreviewSub, seekPreviewTime);
  const timeline = h('div', {
    class: 'timeline',
    id: 'ctl-timeline',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Video zaman çizelgesi',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
    onkeydown: (e) => {
      if (e.key === 'Home' && canSeekNow()) {
        e.preventDefault();
        e.stopPropagation();
        actions.seek(0);
      } else if (e.key === 'End' && canSeekNow() && duration() > 1) {
        e.preventDefault();
        e.stopPropagation();
        actions.seek(Math.max(0, duration() - 1));
      }
    },
  }, seekPreview, h('div', { class: 'track' }, buf, cur, knob));
  const time = h('span', { class: 'ctl-time' }, '0:00 / 0:00');
  const isIosDevice = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const isIosFixedVol = Boolean(isIosDevice && !host.canControlVolume?.());
  const volRange = h('input', { type: 'range', min: '0', max: '200', step: '1', value: String(Math.min(200, Math.max(0, Number(host.volume ?? 80)))), 'aria-label': 'Ses', oninput: (e) => { setRealVolume(e.target.value, { showHud: true }); } });
  const volBtn = h('button', { class: 'ctl-action', id: 'ctl-vol', 'aria-label': 'Sessiz', ...tapProps(() => { if (isActuallyMuted()) doUnlockAudio(); else { host.setMuted(true, true); update(); } }) });
  const skipBtn = h('button', { class: 'ctl-action', id: 'ctl-skip', 'data-tip': 'Atla oyu', 'aria-label': 'Atla', ...tapProps(() => actions.skip()) }, ico('skip'));
  const speedBtn = h('button', { class: 'ctl-action ctl-speed-btn', id: 'ctl-speed-btn', 'data-tip': 'Oynatma Hızı', 'aria-label': 'Oynatma Hızı', ...tapProps(() => toggleMenu('speed')) }, h('span', { style: { fontSize: '.72em', fontWeight: '800' } }, '1x'));
  const subBtn = h('button', { class: 'ctl-action ctl-labeled-pill', id: 'ctl-sub-btn', 'data-tip': 'Altyazı & Dublaj', 'aria-label': 'Altyazı ve Dublaj', ...tapProps(() => toggleMenu('subtitle')) }, ico('subtitles'), h('span', { class: 'ctl-btn-lbl' }, 'Altyazı & Ses'));
  const snapBtn = h('button', { class: 'ctl-action', id: 'ctl-snap', 'data-tip': 'Anlık Kare Yakala (PNG)', 'aria-label': 'Ekran Görüntüsü', ...tapProps(() => takeVideoSnapshot()) }, ico('snapshot'));
  const gearBtn = h('button', { class: 'ctl-action', id: 'ctl-gear', 'data-tip': 'Oynatıcı Ayarları', 'aria-label': 'Ayarlar', ...tapProps(() => toggleMenu('list')) }, ico('settings'));
  const trustedTapProps = (fn) => {
    let lastRun = 0;
    return {
      onpointerdown: (e) => { e.stopPropagation(); revealControls(3600); },
      ontouchstart: (e) => { e.stopPropagation(); lastAnyTouchAt = Date.now(); resumeSharedAudioContext(); revealControls(3600); },
      onclick: (e) => {
        e.stopPropagation();
        const now = Date.now();
        if (now - lastRun < 320) return;
        lastRun = now;
        revealControls(3600);
        fn(e);
      },
    };
  };
  const togglePiP = async () => {
    closeMenu();
    if (typeof document !== 'undefined' && document.body.classList.contains('mesh-minimized')) {
      window.vortexRestoreRoom?.();
      update();
      return;
    }
    const ok = await host.togglePiP?.();
    if (ok === 'loading') {
      toast('⏳ Video hazırlanıyor — 1 saniye sonra tekrar PiP simgesine dokunun');
      return;
    }
    if ((ok === 'entered' || ok === 'exited' || ok === true) && host.adapter?.video) {
      const entered = ok === 'entered' || (ok === true && Boolean(host.isPiP?.()));
      update();
      showOverlay(entered ? '⧉ Mini Pencere (PiP) Açık — Ana ekrana veya diğer uygulamalara geçebilirsiniz' : '⧉ PiP Kapatıldı', 2400);
      return;
    }
    if (ok === 'entered' || ok === 'exited' || ok === true) {
      const entered = ok === 'entered' || (ok === true && Boolean(host.isPiP?.()));
      update();
      showOverlay(entered ? '⧉ Mini Pencere (PiP) Açık' : '⧉ PiP Kapatıldı', 2400);
      return;
    }
    if (isIosDevice || (typeof window !== 'undefined' && window.Android)) {
      const v = host.adapter?.video;
      if (v && v.readyState < 1) {
        try { v.load(); v.play?.().catch?.(() => {}); } catch (_) {}
        toast('⏳ Video akışı hazırlanıyor — 1 saniye sonra tekrar PiP simgesine dokunun');
        return;
      }
      toast('⧉ Bu yayın kaynağı için sistem PiP penceresi şu an hazır değil');
      return;
    }
    if (typeof window !== 'undefined' && typeof window.vortexMinimizeRoom === 'function') {
      window.vortexMinimizeRoom();
      update();
      return;
    }
    if (typeof navigator !== 'undefined' && /Firefox\//i.test(navigator.userAgent || '')) {
      toast('⧉ Firefox üzerinde videonun sağ kenarındaki yerleşik PiP simgesini kullanabilirsin');
    }
  };
  const triggerCast = async () => {
    closeMenu();
    const res = await host.promptCast?.();
    if (res === 'airplay' || res === 'cast') {
      showOverlay("📺 TV'ye Yansıtma Seçicisi Açıldı", 2200);
      return;
    }
    if (res === 'not-found') {
      toast('Aynı Wi-Fi ağında uyumlu bir Smart TV / Chromecast / AirPlay cihazı bulunamadı.');
      return;
    }
    toast('Tarayıcı menüsünden "Yansıt / Cast" veya AirPlay seçeneğini kullanabilirsiniz.');
  };
  const toggleFitMode = () => {
    const nextFit = frame.dataset.fit === 'cover' ? 'contain' : 'cover';
    frame.dataset.fit = nextFit;
    fitBtn.classList.toggle('on', nextFit === 'cover');
    syncVideoStageBounds(true);
    showOverlay(nextFit === 'cover' ? '▭ Ekranı Doldur (Tam Çerçeve)' : '▭ Ekrana Sığdır (Orijinal Oran)', 1600);
  };
  const castBtn = h('button', { class: 'ctl-action hidden', id: 'ctl-cast', 'data-tip': "TV'ye Yansıt (AirPlay / Cast)", 'aria-label': "TV'ye Yansıt", ...trustedTapProps(() => triggerCast()) }, ico('cast'));
  const fitBtn = h('button', { type: 'button', class: 'ctl-action', id: 'ctl-fit', 'data-tip': 'Ekran Oranı: Sığdır / Doldur', 'aria-label': 'Ekran Oranı', ...tapProps(() => toggleFitMode()) }, h('span', { html: SN_ICONS.fit, style: { display: 'contents' } }));
  const pipBtn = h('button', { class: 'ctl-action', id: 'ctl-pip', 'data-tip': 'Pencere İçinde Pencere / PiP (P)', 'aria-label': 'Pencere İçinde Pencere', ...trustedTapProps(() => togglePiP()) }, ico('pip'));
  const theaterBtn = h('button', { class: 'ctl-action ctl-labeled-pill', id: 'ctl-theater', 'data-tip': 'Sinema Modu (T)', 'aria-label': 'Sinema Modu', ...tapProps(() => ctx.toggleTheaterMode?.()) }, ico('theater'), h('span', { class: 'ctl-btn-lbl' }, 'Sinema'));
  const fsBtn = h('button', { class: 'ctl-action', id: 'ctl-fs', 'data-tip': 'Tam Ekran (F)', 'aria-label': 'Tam ekran', ...trustedTapProps(() => { if (isActuallyMuted() && !host.userMuted) doUnlockAudio(); toggleFullscreen(); }) }, ico('fullscreen'));
  const menuBackdrop = h('div', { class: 'ctl-menu-backdrop hidden', 'aria-hidden': 'true' });
  const menu = h('div', { class: 'ctl-menu acrylic hidden' });
  const dismissViaBackdrop = (e) => {
    e.stopPropagation();
    const pt = e.changedTouches?.[0] || e;
    const cx = typeof pt?.clientX === 'number' ? pt.clientX : -1;
    const cy = typeof pt?.clientY === 'number' ? pt.clientY : -1;
    closeMenu();
    if (cx >= 0 && cy >= 0 && typeof document !== 'undefined') {
      const under = document.elementFromPoint(cx, cy);
      const chatInp = under?.closest?.('#chat-input, .chatbar input[type="text"], .chatbar input:not([type])');
      if (chatInp && typeof chatInp.focus === 'function') {
        try { chatInp.focus(); } catch (err) { /* ignore */ }
        return;
      }
    }
    if (e.cancelable && e.type === 'touchend') e.preventDefault();
  };
  menuBackdrop.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  menuBackdrop.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
  menuBackdrop.addEventListener('touchend', dismissViaBackdrop, { passive: false });
  menuBackdrop.addEventListener('click', dismissViaBackdrop);
  let menuTouchStartX = 0;
  let menuTouchStartY = 0;
  let menuTouchStartAt = 0;
  let lastMenuTouchClickAt = 0;
  menu.addEventListener('pointerdown', (e) => { e.stopPropagation(); revealControls(8000); });
  menu.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    const t = e.touches?.[0];
    if (t) {
      menuTouchStartX = t.clientX;
      menuTouchStartY = t.clientY;
      menuTouchStartAt = Date.now();
    }
    revealControls(8000);
  }, { passive: true });
  menu.addEventListener('touchend', (e) => {
    e.stopPropagation();
    const t = e.changedTouches?.[0];
    if (!t) return;
    if (Math.abs(t.clientX - menuTouchStartX) > 16 || Math.abs(t.clientY - menuTouchStartY) > 16) return;
    if (Date.now() - menuTouchStartAt > 750) return;
    const actEl = e.target?.closest?.('.opt, .sub-pill-btn, .ctl-pref-pill, .ctl-menu-back, .ctl-menu-close, .ctl-menu-subbtn, button, [role="button"]');
    if (actEl && menu.contains(actEl) && actEl.tagName !== 'INPUT') {
      if (actEl.dataset?.nativeGesture === '1') return;
      if (e.cancelable) e.preventDefault();
      lastMenuTouchClickAt = Date.now();
      actEl.click();
    }
  }, { passive: false });
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() - lastMenuTouchClickAt < 320 && e.isTrusted) {
      e.preventDefault();
    }
  });
  const getActiveIntro = () => {
    const m = state.mesh?.media;
    if (!m || (m.mediaType !== 'tv' && !host.adapter?.subs?.intro && !m?.intro)) return null;
    const raw = host.adapter?.subs?.intro || m?.intro || null;
    if (!raw || !(Number(raw.end) > Number(raw.start))) return null;
    if (Number(raw.start) > 240 || (Number(raw.end) - Number(raw.start)) > 110) return null;
    return raw;
  };
  const skipIntroBtn = h('button', {
    class: 'btn primary skip-intro-pill hidden',
    id: 'ctl-skip-intro',
    ...tapProps(() => {
      if (!isLeader()) { toast('İntroyu yalnızca oda lideri atlayabilir'); return; }
      const intro = getActiveIntro();
      const target = intro && Number(intro.end) > 0 ? Number(intro.end) : (position() + 85);
      actions.seek(target);
      skipIntroBtn.classList.add('hidden');
      showOverlay(`⏩ İntro atlandı (${fmtTime(target)})`, 2200);
    }),
  }, '⏩ İntroyu Atla');
  const nextEpBanner = h('div', { class: 'next-ep-banner acrylic hidden', id: 'ctl-next-ep' });
  const cinemaSeatsBar = h('div', { class: 'cinema-seats-bar', id: 'cinema-seats-bar' });
  const danmakuLayer = h('div', { class: 'danmaku-layer', id: 'danmaku-layer' });
  const ambilightCanvas = h('canvas', { class: 'ambilight-canvas', width: '32', height: '18' });
  const brightnessVeil = h('div', { class: 'wl-brightness-veil', id: 'wl-brightness-veil', 'aria-hidden': 'true' });
  const rawSavedBrightStr = localStorage.getItem('vortex_brightness');
  const savedBrightRaw = (rawSavedBrightStr !== null && rawSavedBrightStr !== '') ? Number(rawSavedBrightStr) : NaN;
  let currentBrightness = Number.isFinite(savedBrightRaw) && savedBrightRaw > 0 && savedBrightRaw <= 100 ? Math.round(savedBrightRaw) : 100;
  let curFilter = localStorage.getItem('vortex_video_filter') || 'normal';
  let danmakuEnabled = localStorage.getItem('vortex_danmaku') !== 'off';
  let ambilightEnabled = localStorage.getItem('vortex_ambilight') === 'on';
  let autoAdvancingKey = '';
  let cancelledNextEpKey = '';
  const seatReactions = new Map();

  function applyVideoFilter() {
    const rawB = Number(currentBrightness);
    const b = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawB) ? rawB : 100)));
    currentBrightness = b;
    frame.style.setProperty('--video-brightness', `${b}%`);
    frame.dataset.brightness = String(b);
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    const spec = VIDEO_FILTERS[curFilter] || VIDEO_FILTERS.normal;
    const useVeilOnlyDim = Boolean(isIosFixedVol || (host.adapter && !host.adapter.caps?.overlayClicks));
    const fVal = (b === 100 || useVeilOnlyDim)
      ? spec.css
      : (spec.css === 'none'
        ? 'brightness(var(--video-brightness, 100%))'
        : `${spec.css} brightness(var(--video-brightness, 100%))`);
    frame.style.setProperty('--wl-composed-filter', fVal);
    if (v) {
      if (fVal === 'none') {
        v.style.filter = '';
        v.style.webkitFilter = '';
      } else {
        v.style.filter = fVal;
        v.style.webkitFilter = fVal;
      }
    }
    brightnessVeil.classList.remove('is-boost');
    if (b >= 100) {
      brightnessVeil.style.opacity = '0';
    } else {
      const maxDim = useVeilOnlyDim ? 0.94 : 0.28;
      const op = Math.max(0, Math.min(0.95, ((100 - b) / 100) * maxDim));
      brightnessVeil.style.opacity = op.toFixed(3);
    }
  }

  function setBrightness(nextPct, { showHud = false, persist = true } = {}) {
    const rawB = Number(nextPct);
    const b = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawB) ? rawB : 100)));
    currentBrightness = b;
    if (persist) {
      try { localStorage.setItem('vortex_brightness', String(b)); } catch (e) { /* ignore */ }
    }
    applyVideoFilter();
    try { window.Android?.setScreenBrightness?.(Number((b / 100).toFixed(2))); } catch (e) { /* ignore */ }
    if (showHud) {
      const bars = Math.round((b / 100) * 10);
      const meter = '━'.repeat(Math.max(0, bars)) + '─'.repeat(Math.max(0, 10 - bars));
      showOverlay(`☀️ Parlaklık: %${b}  ${meter}`, 950);
    }
  }

  function setRealVolume(nextPct, { showHud = false } = {}) {
    resumeSharedAudioContext();
    const rawV = Number(nextPct);
    const nv = Math.max(0, Math.min(200, Math.round(Number.isFinite(rawV) ? rawV : 0)));
    host.setVolume(nv);
    if (nv > 0) {
      host.userUnlocked = true;
      host.autoplayBlocked = false;
      unmute.classList.add('hidden');
    }
    if (showHud) {
      const bars = Math.round((nv / 100) * 10);
      const meter = '━'.repeat(Math.max(0, bars)) + '─'.repeat(Math.max(0, 10 - bars));
      const icoTxt = nv === 0 ? '🔇' : nv < 45 ? '🔉' : '🔊';
      showOverlay(`${icoTxt} Ses: %${nv}  ${meter}`, 950);
    }
    update();
  }
  applyVideoFilter();

  function takeVideoSnapshot(opts = {}) {
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    if (!v || !v.videoWidth) { toast('Yalnızca aktif video oynatılırken kare yakalanabilir.'); return null; }
    try {
      const flash = h('div', { class: 'snap-flash' });
      frame.append(flash);
      setTimeout(() => flash.remove(), 450);
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const c2d = c.getContext('2d');
      c2d.drawImage(v, 0, 0, c.width, c.height);
      if (subCue.textContent) {
        const fontSize = Math.round(c.height * 0.04);
        c2d.font = `bold ${fontSize}px Inter, sans-serif`;
        c2d.fillStyle = '#ffffff';
        c2d.textAlign = 'center';
        c2d.shadowColor = '#000';
        c2d.shadowBlur = 8;
        const subLines = subCue.textContent.split('\n').map((l) => l.trim()).filter(Boolean);
        const lineStep = Math.round(fontSize * 1.25);
        const baseY = c.height - Math.round(c.height * 0.07) - (subLines.length - 1) * lineStep;
        subLines.forEach((line, idx) => {
          c2d.fillText(line, c.width / 2, baseY + idx * lineStep);
        });
      }
      const cSmall = document.createElement('canvas');
      cSmall.width = 360;
      cSmall.height = Math.max(160, Math.round((v.videoHeight / v.videoWidth) * 360));
      cSmall.getContext('2d').drawImage(c, 0, 0, cSmall.width, cSmall.height);
      const chatJpegUrl = cSmall.toDataURL('image/jpeg', 0.62);
      const curSec = Math.max(0, Math.round(position()));
      window.__lastSnapshotChatJpeg = chatJpegUrl;
      window.__lastSnapshotVideoTime = curSec;

      if (opts.shareToChat) {
        const caption = String(opts.caption || '').trim() || `📸 ${fmtTime(curSec)} sahnesi`;
        actions.sendChat?.(caption, { snapshot: chatJpegUrl, videoTime: curSec });
        showOverlay(`📸 Sahne sohbette paylaşıldı (${fmtTime(curSec)})`, 2000);
        toast('📸 Anlık sahne odadaki sohbette paylaşıldı!');
        return { snapshot: chatJpegUrl, videoTime: curSec };
      }

      const dataUrl = c.toDataURL('image/png');
      window.__lastSnapshotDataUrl = dataUrl;
      const a = document.createElement('a');
      a.href = dataUrl;
      const stamp = fmtTime(curSec).replace(':', 'm') + 's';
      a.download = `watchlivo-sahne-${stamp}.png`;
      a.click();
      showOverlay(`📸 Sahne yakalandı (${fmtTime(curSec)})`, 2200);
      toast('📸 Sahne (PNG) indirildi ve sohbette paylaşıldı!');
      actions.sendChat?.(`📸 ${fmtTime(curSec)} sahnesi`, { snapshot: chatJpegUrl, videoTime: curSec });
      return { snapshot: chatJpegUrl, videoTime: curSec };
    } catch (e) {
      toast('Bu video kaynağından güvenlik nedeniyle kare alınamadı.');
      return null;
    }
  }
  window.vortexCaptureSceneToChat = (caption = '') => takeVideoSnapshot({ shareToChat: true, caption });
  window.vortexGetVideoPosition = () => Math.max(0, Math.round(position()));
  window.vortexSeekToTimestamp = (sec) => {
    const target = Math.max(0, Number(sec) || 0);
    if (!canControlPlayback()) {
      toast(`⏱️ ${fmtTime(target)} sahnesi (Videoyu yalnızca oda başkanı sarabilir)`);
      return;
    }
    actions.seek(target);
    showOverlay(`⏱️ ${fmtTime(target)} sahnesine gidildi`, 1800);
    revealControls(2600);
  };

  const seasonMetaCache = new Map();
  const seasonMetaInflight = new Set();
  const ensureSeasonMeta = (m, cleanSeries, sNum) => {
    const seriesIdKey = m?.tmdbId || m?.id || cleanSeries || '';
    if (!seriesIdKey || !sNum) return null;
    const cacheKey = `${seriesIdKey}:${sNum}`;
    if (seasonMetaCache.has(cacheKey)) return seasonMetaCache.get(cacheKey);
    if (seasonMetaInflight.has(cacheKey)) return null;
    seasonMetaInflight.add(cacheKey);
    fetch(`/api/rave/seasons?tmdbId=${encodeURIComponent(m?.tmdbId || '')}&title=${encodeURIComponent(cleanSeries || '')}&mediaType=tv&season=${sNum}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((sData) => {
        if (!sData) return;
        const eps = Array.isArray(sData.episodes) ? sData.episodes : [];
        const seasons = Array.isArray(sData.seasons) ? sData.seasons : [];
        const hasNextSeason = seasons.some((s) => Number(s.season) === Number(sNum) + 1);
        seasonMetaCache.set(cacheKey, { epCount: eps.length, hasNextSeason, episodes: eps });
        update();
      })
      .catch(() => {})
      .finally(() => { seasonMetaInflight.delete(cacheKey); });
    return null;
  };
  const computePrevEpSpec = (m, sNum, eNum) => {
    const cleanSeries = String(m?.seriesTitle || m?.title || 'Dizi').split(' — ')[0].trim() || 'Dizi';
    if (eNum > 1) {
      return { season: sNum, episode: eNum - 1, shortSig: `B${eNum - 1}`, fullLabel: `S${sNum}:B${eNum - 1}`, cleanSeries, isPremiere: false };
    }
    if (sNum > 1) {
      const prevMeta = ensureSeasonMeta(m, cleanSeries, sNum - 1);
      const prevEpCount = Number(prevMeta?.epCount || 0) || Number((m?.seasonsMeta || []).find((sx) => Number(sx.season) === sNum - 1)?.episodeCount || 0);
      const targetEp = prevEpCount > 0 ? prevEpCount : 1;
      const sig = prevEpCount > 0 ? `S${sNum - 1}:B${targetEp}` : `S${sNum - 1}`;
      return { season: sNum - 1, episode: targetEp, shortSig: sig, fullLabel: sig, cleanSeries, isPremiere: false };
    }
    return { season: 1, episode: 1, shortSig: '', fullLabel: '', cleanSeries, isPremiere: true };
  };
  const computeNextEpSpec = (m, sNum, eNum) => {
    const cleanSeries = String(m?.seriesTitle || m?.title || 'Dizi').split(' — ')[0].trim() || 'Dizi';
    const meta = ensureSeasonMeta(m, cleanSeries, sNum);
    if (meta && meta.epCount > 0 && eNum === meta.epCount) {
      if (meta.hasNextSeason) {
        return { season: sNum + 1, episode: 1, shortSig: `S${sNum + 1}:B1`, fullLabel: `S${sNum + 1}:B1`, cleanSeries, isFinale: false };
      }
      return { season: sNum, episode: eNum, shortSig: '', fullLabel: '', cleanSeries, isFinale: true };
    }
    return { season: sNum, episode: eNum + 1, shortSig: `B${eNum + 1}`, fullLabel: `S${sNum}:B${eNum + 1}`, cleanSeries, isFinale: false };
  };

  let nextEpBusy = false;
  async function triggerPrevEpisode(manual = false) {
    const m = state.mesh?.media;
    if (!m) return;
    const parsedEp = String(m.title || '').match(/S(\d+)\s*:\s*B(\d+)|(\d+)\.\s*Sezon\s*(\d+)\.\s*Bölüm/i);
    const curS = Number(m.season || parsedEp?.[1] || parsedEp?.[3] || 1);
    const curE = Number(m.episode || parsedEp?.[2] || parsedEp?.[4] || 1);
    const isMovie = m.mediaType === 'movie' || /Tam Film/i.test(String(m.channel || ''));
    const isSeries = !isMovie && Boolean(m.mediaType === 'tv' || parsedEp);
    if (!isSeries) return;
    if (!isLeader() && !canSelectVideo()) {
      if (manual) toast('Bölümü yalnızca oda başkanı değiştirebilir');
      return;
    }
    if (curS <= 1 && curE <= 1) {
      if (manual) toast('🏁 Dizinin ilk bölümündesiniz');
      return;
    }
    if (nextEpBusy) return;
    const cleanTitle = String(m.seriesTitle || m.title || 'Dizi').replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim() || 'Dizi';
    nextEpBusy = true;
    nextEpBanner.classList.add('hidden');
    let targetSeason = curE > 1 ? curS : Math.max(1, curS - 1);
    let targetEp = curE > 1 ? curE - 1 : 1;
    let epName = '';
    try {
      try {
        const sig1 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6500) : undefined;
        const r = await fetch(`/api/rave/seasons?tmdbId=${encodeURIComponent(m.tmdbId || '')}&title=${encodeURIComponent(cleanTitle)}&mediaType=tv&season=${targetSeason}`, sig1 ? { signal: sig1 } : {});
        if (r.ok) {
          const sData = await r.json();
          const eps = Array.isArray(sData.episodes) ? sData.episodes : [];
          if (curE <= 1 && eps.length > 0) {
            targetEp = Number(eps[eps.length - 1]?.episode || eps.length);
          }
          const foundEp = eps.find((x) => Number(x.episode) === targetEp);
          if (foundEp) {
            const rawName = String(foundEp.name || '').trim();
            const isRedundant = new RegExp(`^(?:${targetEp}\\.\\s*bölüm|bölüm\\s*${targetEp}|episode\\s*${targetEp})(?:\\s*\\([^)]*\\))?$`, 'i').test(rawName);
            epName = isRedundant ? '' : rawName;
          }
        }
      } catch (e) { /* ignore */ }
      showOverlay(`⏮️ S${targetSeason}:B${targetEp} hazırlanıyor…`, 4000);
      if (manual) toast(`⏮️ S${targetSeason}:B${targetEp} bölümüne geçiliyor…`);
      const rawProvId = String(m.catalogProvider || m.provider || 'cinema').toLowerCase();
      const safeProvId = ['youtube', 'web', 'hls', 'mp4', 'direct', 'web-direct', 'embed'].includes(rawProvId) ? 'cinema' : rawProvId;
      const prov = getProvider(safeProvId) || { id: 'cinema', name: 'Sinema & Dizi' };
      const rawSrcUrl = String(m.sourceUrl || '').trim();
      const safeSrcUrl = (/youtube\.com|youtu\.be|\/search\?|[-/]bolum|episode-|sezon-\d+/i.test(rawSrcUrl)) ? '' : rawSrcUrl;
      const cleanOrigTitle = String(m.originalTitle || cleanTitle).replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim() || cleanTitle;
      const prevMedia = await resolveCatalogItem(
        { id: m.id || '', tmdbId: /^\d+$/.test(String(m.tmdbId || '')) ? String(m.tmdbId) : '', imdbId: m.imdbId || '', title: cleanTitle, seriesTitle: cleanTitle, originalTitle: cleanOrigTitle, year: m.year || '', mediaType: 'tv', sourceUrl: safeSrcUrl, backdrop: m.thumbnail, poster: m.thumbnail },
        prov,
        targetSeason,
        targetEp,
        epName,
        { applySavedResume: false },
      );
      if (prevMedia) {
        actions.pickMedia({
          ...prevMedia,
          id: prevMedia.id || m.id || '',
          tmdbId: prevMedia.tmdbId || m.tmdbId || '',
          imdbId: prevMedia.imdbId || m.imdbId || '',
          catalogProvider: (prevMedia.catalogProvider && prevMedia.catalogProvider !== 'youtube') ? prevMedia.catalogProvider : safeProvId,
          mediaType: 'tv',
          season: targetSeason,
          episode: targetEp,
          seriesTitle: cleanTitle,
          originalTitle: prevMedia.originalTitle || cleanOrigTitle,
          sourceUrl: prevMedia.sourceUrl || safeSrcUrl || '',
        });
      } else {
        toast('⚠️ Önceki bölüm kaynağı bulunamadı');
      }
    } finally {
      nextEpBusy = false;
    }
  }
  async function triggerNextEpisode(manual = false) {
    const m = state.mesh?.media;
    if (!m) return;
    const parsedEp = String(m.title || '').match(/S(\d+)\s*:\s*B(\d+)|(\d+)\.\s*Sezon\s*(\d+)\.\s*Bölüm/i);
    const curS = Number(m.season || parsedEp?.[1] || parsedEp?.[3] || 0);
    const curE = Number(m.episode || parsedEp?.[2] || parsedEp?.[4] || 0);
    const isMovie = m.mediaType === 'movie' || /Tam Film/i.test(String(m.channel || ''));
    const isSeries = !isMovie && Boolean(m.mediaType === 'tv' || parsedEp);
    if (!isSeries) return;
    if (!isLeader() && !canSelectVideo()) {
      if (manual) toast('Bölümü yalnızca oda başkanı değiştirebilir');
      return;
    }
    if (!manual && (state.mesh?.queue || []).length > 0) return;
    if (nextEpBusy) return;
    const cleanTitle = String(m.seriesTitle || m.title || 'Dizi').replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim() || 'Dizi';
    const seriesIdKey = m.tmdbId || m.id || cleanTitle;
    if (!seriesIdKey) return;
    const curKey = `${seriesIdKey}:${curS || 1}:${curE || 1}`;
    if (!manual && autoAdvancingKey === curKey) return;
    autoAdvancingKey = curKey;
    nextEpBusy = true;
    nextEpBanner.classList.add('hidden');
    let targetSeason = curS || 1;
    let targetEp = (curE || 1) + 1;
    let epName = '';
    try {
      showOverlay(`⏭️ S${targetSeason}:B${targetEp} hazırlanıyor…`, 4500);
      if (manual) toast(`⏭️ S${targetSeason}:B${targetEp} bölümüne geçiliyor…`);
      try {
        const sig1 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6500) : undefined;
        const r = await fetch(`/api/rave/seasons?tmdbId=${encodeURIComponent(m.tmdbId || '')}&title=${encodeURIComponent(cleanTitle)}&mediaType=tv&season=${targetSeason}`, sig1 ? { signal: sig1 } : {});
        if (r.ok) {
          const sData = await r.json();
          const eps = Array.isArray(sData.episodes) ? sData.episodes : [];
          const seasons = Array.isArray(sData.seasons) ? sData.seasons : [];
          const foundEp = eps.find((x) => Number(x.episode) === targetEp);
          if (foundEp) {
            const rawName = String(foundEp.name || '').trim();
            const isRedundant = new RegExp(`^(?:${targetEp}\\.\\s*bölüm|bölüm\\s*${targetEp}|episode\\s*${targetEp})(?:\\s*\\([^)]*\\))?$`, 'i').test(rawName);
            epName = isRedundant ? '' : rawName;
          } else if (eps.length > 0 && targetEp === eps.length + 1) {
            const hasNextSeason = seasons.some((s) => Number(s.season) === targetSeason + 1);
            if (hasNextSeason) {
              targetSeason += 1;
              targetEp = 1;
              const sig2 = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6500) : undefined;
              const r2 = await fetch(`/api/rave/seasons?tmdbId=${encodeURIComponent(m.tmdbId || '')}&title=${encodeURIComponent(cleanTitle)}&mediaType=tv&season=${targetSeason}`, sig2 ? { signal: sig2 } : {});
              if (r2.ok) {
                const s2 = await r2.json();
                const ep1 = (s2.episodes || []).find((x) => Number(x.episode) === 1);
                if (ep1?.name && !/^(?:1\.\s*bölüm|bölüm\s*1|episode\s*1)(?:\s*\([^)]*\))?$/i.test(ep1.name.trim())) {
                  epName = ep1.name.trim();
                }
              }
            } else {
              toast('🏁 Dizinin son bölümüne ulaşıldı');
              autoAdvancingKey = '';
              return;
            }
          }
        }
      } catch (e) { /* fallback to +1 */ }
      const rawProvId = String(m.catalogProvider || m.provider || 'cinema').toLowerCase();
      const safeProvId = ['youtube', 'web', 'hls', 'mp4', 'direct', 'web-direct', 'embed'].includes(rawProvId) ? 'cinema' : rawProvId;
      const prov = getProvider(safeProvId) || { id: 'cinema', name: 'Sinema & Dizi' };
      const rawSrcUrl = String(m.sourceUrl || '').trim();
      const safeSrcUrl = (/youtube\.com|youtu\.be|\/search\?|[-/]bolum|episode-|sezon-\d+/i.test(rawSrcUrl)) ? '' : rawSrcUrl;
      const cleanOrigTitle = String(m.originalTitle || cleanTitle).replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim() || cleanTitle;
      showOverlay(`⏭️ ${targetSeason}. Sezon ${targetEp}. Bölüm yükleniyor…`, 4000);
      const nextMedia = await resolveCatalogItem(
        { id: m.id || '', tmdbId: /^\d+$/.test(String(m.tmdbId || '')) ? String(m.tmdbId) : '', imdbId: m.imdbId || '', title: cleanTitle, seriesTitle: cleanTitle, originalTitle: cleanOrigTitle, year: m.year || '', mediaType: 'tv', sourceUrl: safeSrcUrl, backdrop: m.thumbnail, poster: m.thumbnail },
        prov,
        targetSeason,
        targetEp,
        epName,
        { applySavedResume: false },
      );
      if (nextMedia) {
        actions.pickMedia({
          ...nextMedia,
          id: nextMedia.id || m.id || '',
          tmdbId: nextMedia.tmdbId || m.tmdbId || '',
          imdbId: nextMedia.imdbId || m.imdbId || '',
          catalogProvider: (nextMedia.catalogProvider && nextMedia.catalogProvider !== 'youtube') ? nextMedia.catalogProvider : safeProvId,
          mediaType: 'tv',
          season: targetSeason,
          episode: targetEp,
          seriesTitle: cleanTitle,
          originalTitle: nextMedia.originalTitle || cleanOrigTitle,
          sourceUrl: nextMedia.sourceUrl || safeSrcUrl || '',
        });
      } else {
        autoAdvancingKey = '';
        toast('⚠️ Sonraki bölüm kaynağı bulunamadı');
      }
    } finally {
      nextEpBusy = false;
      setTimeout(() => { if (autoAdvancingKey === curKey) autoAdvancingKey = ''; }, 3000);
    }
  }
  const closeMenu = () => {
    currentMenuView = '';
    delete menu.dataset.view;
    delete frame.dataset.menuView;
    if (subCue.dataset.previewSample === '1') {
      delete subCue.dataset.previewSample;
      subCue.textContent = '';
      host.adapter?.subs?.onTimeUpdate?.(position(), true);
      if (!subCue.textContent) subOverlay.classList.add('hidden');
    }
    menu.classList.add('hidden');
    menuBackdrop.classList.add('hidden');
    frame.classList.remove('menu-open');
    if (typeof document !== 'undefined') document.body?.classList.remove('ctl-menu-open');
  };
  const onDocMenuOutside = (e) => {
    if (menu.classList.contains('hidden')) return;
    const t = e.target;
    if (t && (menu.contains(t) || menuBackdrop.contains(t) || t.closest?.('#ctl-sub-btn, #ctl-gear, #ctl-speed-btn, #ctl-quality-badge, #ctl-sub-pill'))) {
      return;
    }
    closeMenu();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onDocMenuOutside, { passive: true });
    document.addEventListener('focusin', onDocMenuOutside, { passive: true });
  }

  const rippleLeft = h('div', { class: 'ctl-seek-ripple left hidden' },
    h('div', { class: 'seek-ripple-body' },
      h('span', { class: 'seek-ripple-icon' }, '⏪'),
      h('span', { class: 'seek-ripple-text' }, '10 sn'),
    ),
  );
  const rippleRight = h('div', { class: 'ctl-seek-ripple right hidden' },
    h('div', { class: 'seek-ripple-body' },
      h('span', { class: 'seek-ripple-icon' }, '⏩'),
      h('span', { class: 'seek-ripple-text' }, '10 sn'),
    ),
  );

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isSwiping = false;
  let swipeMode = null;
  let startVolume = 80;
  let startBrightness = currentBrightness;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let tapTimer = null;
  let accumulatedSeek = 0;
  let rippleTimer = null;

  const triggerSeekRipple = (dir, totalSec) => {
    const el = dir === 'left' ? rippleLeft : rippleRight;
    const other = dir === 'left' ? rippleRight : rippleLeft;
    other.classList.add('hidden');
    el.querySelector('.seek-ripple-text').textContent = `${Math.abs(totalSec)} sn`;
    el.classList.remove('hidden');
    el.classList.remove('animate');
    void el.offsetWidth;
    el.classList.add('animate');
    clearTimeout(rippleTimer);
    rippleTimer = setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('animate');
      accumulatedSeek = 0;
    }, 800);
  };

  const centerBack10Btn = h('button', {
    type: 'button',
    class: 'ctl-center-side',
    id: 'ctl-center-back10',
    'aria-label': '10 saniye geri',
    title: '10 saniye geri',
    ...tapProps(() => {
      if (!canControlPlayback()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
      seekStep(-10);
    }),
  }, ico('rewind10'));
  const centerPlayBtn = h('button', {
    type: 'button',
    class: 'ctl-center-play',
    id: 'ctl-center-play',
    'aria-label': 'Oynat / Duraklat',
    ...tapProps(() => {
      const isTouchDev = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
      if (isTouchDev && Date.now() - lastUiRevealAt < 240) return;
      togglePlayPause();
    }, { noAutoReveal: true }),
  }, ico('play'));
  const centerFwd10Btn = h('button', {
    type: 'button',
    class: 'ctl-center-side',
    id: 'ctl-center-fwd10',
    'aria-label': '10 saniye ileri',
    title: '10 saniye ileri',
    ...tapProps(() => {
      if (!canControlPlayback()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
      seekStep(10);
    }),
  }, ico('forward10'));
  const centerHud = h('div', { class: 'ctl-center-hud', id: 'ctl-center-hud' }, centerBack10Btn, centerPlayBtn, centerFwd10Btn);
  const mid = h('div', { class: 'ctl-mid' }, centerHud);

  mid.addEventListener('touchstart', (e) => {
    touchStartTime = Date.now();
    if (!e.touches || e.touches.length !== 1) return;
    if (e.target?.closest?.('button, input')) return;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    isSwiping = false;
    swipeMode = null;
    const rawHostVol = Number(host.volume);
    startVolume = isActuallyMuted() ? 0 : (Number.isFinite(rawHostVol) ? Math.max(0, Math.min(200, rawHostVol)) : 80);
    startBrightness = currentBrightness;
  }, { passive: true });

  mid.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    if (e.target?.closest?.('button, input')) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const rect = frame.getBoundingClientRect();
    if (!isSwiping && Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 1.3) {
      isSwiping = true;
      clearTimeout(tapTimer);
      const relX = touchStartX - rect.left;
      swipeMode = relX < rect.width * 0.5 ? 'brightness' : 'volume';
    }
    if (isSwiping) {
      if (e.cancelable) e.preventDefault();
      const deltaPct = -(dy / (rect.height * 0.75)) * 100;
      if (swipeMode === 'brightness') {
        setBrightness(startBrightness + deltaPct, { showHud: true });
      } else if (swipeMode === 'volume') {
        setRealVolume(startVolume + deltaPct, { showHud: true });
      }
    }
  }, { passive: false });

  mid.addEventListener('touchend', (e) => {
    touchStartTime = Date.now();
    if (e.target?.closest?.('button, input')) {
      revealControls(4500);
      return;
    }
    if (isSwiping) {
      isSwiping = false;
      swipeMode = null;
      return;
    }
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dx = Math.abs(t.clientX - touchStartX);
    const dy = Math.abs(t.clientY - touchStartY);
    if (dx > 25 || dy > 25) return;

    const now = Date.now();
    const rect = frame.getBoundingClientRect();
    const tapX = t.clientX - rect.left;
    const ratio = tapX / rect.width;

    if ((host.autoplayBlocked || (isActuallyMuted() && !host.userMuted && Number(host.volume) > 0)) && menu.classList.contains('hidden')) {
      syncUnlockAudioOnly();
      revealControls(4200);
      update();
      return;
    }
    if (now - lastTapTime < 300 && Math.abs(t.clientX - lastTapX) < 70 && Math.abs(t.clientY - lastTapY) < 70) {
      clearTimeout(tapTimer);
      lastTapTime = 0;
      if (ratio < 0.38) {
        if (!canControlPlayback()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
        accumulatedSeek = (accumulatedSeek <= 0 ? accumulatedSeek : 0) - 10;
        seekStep(-10);
        triggerSeekRipple('left', accumulatedSeek);
        revealControls(4500);
      } else if (ratio > 0.62) {
        if (!canControlPlayback()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
        accumulatedSeek = (accumulatedSeek >= 0 ? accumulatedSeek : 0) + 10;
        seekStep(10);
        triggerSeekRipple('right', accumulatedSeek);
        revealControls(4500);
      } else {
        toggleFullscreen();
      }
    } else {
      lastTapTime = now;
      lastTapX = t.clientX;
      lastTapY = t.clientY;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        if (!menu.classList.contains('hidden')) { closeMenu(); return; }
        if (controls.classList.contains('ui-active') && Date.now() - lastUiRevealAt > 320) {
          hideControlsNow();
        } else {
          revealControls(4500);
        }
      }, 220);
    }
  }, { passive: true });

  let desktopClickTimer = null;
  mid.addEventListener('click', (e) => {
    if (e.target?.closest?.('button, input')) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen' || Date.now() - Math.max(touchStartTime, lastAnyTouchAt) < 2200 || window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches) return;
    if (!menu.classList.contains('hidden')) { closeMenu(); return; }
    if ((isActuallyMuted() && !host.userMuted) || !unmute.classList.contains('hidden')) { doUnlockAudio(); return; }
    clearTimeout(desktopClickTimer);
    desktopClickTimer = setTimeout(() => {
      togglePlayPause();
    }, 200);
  });
  mid.addEventListener('dblclick', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen' || Date.now() - Math.max(touchStartTime, lastAnyTouchAt) < 2200 || window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches) return;
    clearTimeout(desktopClickTimer);
    toggleFullscreen();
  });
  const miniTitle = h('span', { class: 'mini-player-title' }, 'Canlı Oda');
  const miniMicBtn = h('button', {
    type: 'button',
    class: 'mini-player-btn mic hidden',
    title: 'Mikrofonu Aç / Kapat',
    'aria-label': 'Mikrofonu Aç / Kapat',
    onclick: (e) => {
      e.stopPropagation();
      if (!ctx.voice?.micOn) {
        const vMode = state.mesh?.voipMode || 'all';
        if (vMode === 'off') {
          toast('Bu odada sesli sohbet kapalı');
          return;
        }
        if (vMode === 'leader' && !isLeader()) {
          toast('Bu odada yalnızca oda lideri konuşabilir');
          return;
        }
        if (vMode === 'stage' && !isLeader()) {
          const meP = (state.mesh?.participants || []).find((x) => x && x.id === state.clientId);
          if (!meP?.isHost && !meP?.isCoHost && !meP?.isStageSpeaker) {
            toast("🎤 Sahne Modu açık — konuşmak için '✋ Söz İste' butonunu kullanın");
            return;
          }
        }
      }
      ctx.voice?.toggleMic?.().then?.(() => update()).catch?.(() => {});
    },
  }, '🎙️');
  const miniBar = h('div', {
    class: 'mini-player-bar',
    onclick: (e) => {
      e.stopPropagation();
      window.vortexRestoreRoom?.();
    },
  },
    h('div', { class: 'mini-player-meta' },
      h('span', { class: 'mini-player-dot' }),
      miniTitle),
    h('div', { class: 'mini-player-actions' },
      miniMicBtn,
      h('button', {
        type: 'button',
        class: 'mini-player-btn expand',
        title: 'Odaya Dön',
        onclick: (e) => { e.stopPropagation(); window.vortexRestoreRoom?.(); },
      }, '⤢ Odaya Dön'),
      h('button', {
        type: 'button',
        class: 'mini-player-btn close',
        title: 'Odadan Çık',
        onclick: (e) => { e.stopPropagation(); window.vortexCloseMinimizedRoom?.(); },
      }, '✕')));

  const syncPill = h('div', { class: 'ctl-sync-pill', id: 'ctl-sync-pill', title: 'Canlı oda senkronizasyon durumu' }, syncDot, syncText);
  const embedTouchHudBtn = h('button', {
    type: 'button',
    class: 'btn embed-touch-hud-btn hidden',
    id: 'ctl-embed-hud-btn',
    'aria-label': 'Kontroller',
    title: 'Oynatıcı Kontrolleri ve Ayarlar',
    ...tapProps(() => toggleMenu('list')),
  }, ico('settings'), h('span', { class: 'embed-hud-lbl' }, 'Kontroller'));
  const fsReactions = h('div', { class: 'ctl-fs-reactions', 'aria-label': 'Tam Ekran Tepkiler' },
    ...['❤️', '😂', '🔥', '👏', '😮'].map((em) => h('button', {
      type: 'button',
      class: 'react-emoji-btn ctl-fs-react-btn',
      title: `Tepki: ${em}`,
      'aria-label': `Tepki ${em}`,
      ...tapProps(() => actions.reaction(em)),
    }, em)));
  const barRow = h('div', { class: 'ctl-bar-row' },
    h('div', { class: 'ctl-cluster-left' }, playBtn, back10Btn, fwd10Btn, h('div', { class: `vol-wrap ${isIosFixedVol ? 'is-fixed-vol' : ''}`.trim() }, volBtn, volRange), time),
    h('div', { class: 'ctl-spacer' }),
    h('div', { class: 'ctl-cluster-right' }, fsReactions, skipBtn, speedBtn, subBtn, snapBtn, gearBtn, castBtn, fitBtn, pipBtn, theaterBtn, fsBtn));
  const controls = h('div', { class: 'controls' },
    h('div', { class: 'ctl-top' },
      h('div', { class: 'ctl-top-left' }, thumb, h('div', { class: 'ctl-info' }, kickerBadge, title, artist)),
      h('div', { class: 'ctl-top-right' }, syncPill, qualityBadge, subPillBtn, breakTopBtn, prevEpTopBtn, epBtn, nextEpTopBtn, origBtn, provLogo)),
    mid,
    h('div', { class: 'ctl-bottom' }, timeline, barRow),
    menu);
  frame.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    revealControls(2600);
  }, { passive: true });
  frame.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen' || Date.now() - Math.max(touchStartTime, lastAnyTouchAt) < 2200 || Date.now() - lastLayoutShiftAt < 700) return;
    if (window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches) return;
    if (lastMouseX < 0) {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      revealControls(2600);
      return;
    }
    if (Math.hypot(e.clientX - lastMouseX, e.clientY - lastMouseY) < 8) return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    revealControls(2600);
  }, { passive: true });
  frame.addEventListener('pointerleave', () => {
    lastMouseX = -1;
    lastMouseY = -1;
  }, { passive: true });
  controls.addEventListener('pointerdown', (e) => {
    if (e.target?.closest?.('.ctl-top, .ctl-bottom, .ctl-menu, .ctl-center-play, .ctl-center-side')) {
      revealControls(4500);
    }
  }, { passive: true });
  frame.addEventListener('touchend', () => {
    if (host.adapter && !host.adapter.caps?.overlayClicks) return;
    if (!controls.classList.contains('ui-active') && !controls.classList.contains('show')) {
      revealControls(4500);
    }
  }, { passive: true });
  frame.addEventListener('click', () => {
    if (host.adapter && !host.adapter.caps?.overlayClicks) return;
    if (!controls.classList.contains('ui-active') && !controls.classList.contains('show')) {
      revealControls(4500);
    }
  }, { passive: true });
  frame.prepend(stageBackdrop, ambilightCanvas);
  frame.append(brightnessVeil, empty, loading, danmakuLayer, cinemaSeatsBar, subOverlay, rippleLeft, rippleRight, skipIntroBtn, nextEpBanner, breakBanner, embedTouchHudBtn, controls, miniBar, errorBox, unmute, overlayMsg);

  const onKeyDown = (e) => {
    if (document.body.classList.contains('mesh-minimized')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable || document.querySelector('.popup-backdrop')) return;
    if (e.key === 'Escape') {
      if (!menu.classList.contains('hidden')) { e.preventDefault(); closeMenu(); return; }
      const toolsPop = document.getElementById('chat-tools-popover');
      if (toolsPop && !toolsPop.classList.contains('hidden')) { e.preventDefault(); toolsPop.classList.add('hidden'); document.getElementById('btn-chat-tools')?.classList.remove('active'); return; }
      const gifPop = document.querySelector('#mesh-root .gif-panel:not(.hidden)');
      if (gifPop) { e.preventDefault(); gifPop.classList.add('hidden'); return; }
      const qZone = document.getElementById('chat-access-zone');
      if (qZone && !qZone.classList.contains('hidden')) { e.preventDefault(); qZone.classList.add('hidden'); document.getElementById('btn-discord-share-toggle')?.classList.remove('on'); return; }
      if (state.view?.left && state.view.left !== 'Collapsed') { e.preventDefault(); setView('left', 'Collapsed'); ctx.layout?.update?.(); return; }
      if (state.view?.right && state.view.right !== 'Collapsed') { e.preventDefault(); setView('right', 'Collapsed'); ctx.layout?.update?.(); return; }
      if (isFullscreenActive()) { e.preventDefault(); toggleFullscreen(); return; }
      return;
    }
    if (e.key === ' ' && (tag === 'button' || tag === 'select' || tag === 'a')) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      if (!canControlPlayback()) {
        const roomPlaying = isRoomMediaPlaying(state.mesh?.media);
        if (roomPlaying && host.adapter?.isPaused?.()) {
          host.adapter.play();
          ctx.sync?.kick();
        } else {
          toast('Videoyu yalnızca oda başkanı duraklatabilir veya başlatabilir');
        }
      } else {
        actions.toggle();
      }
      revealControls();
    }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (canControlPlayback()) seekStep(-10);
      else toast('Videoyu yalnızca oda başkanı sarabilir');
    }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (canControlPlayback()) seekStep(10);
      else toast('Videoyu yalnızca oda başkanı sarabilir');
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.shiftKey) setBrightness(currentBrightness + 10, { showHud: true });
      else setRealVolume((isActuallyMuted() ? 0 : Number(host.volume ?? 80)) + 5, { showHud: true });
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.shiftKey) setBrightness(currentBrightness - 10, { showHud: true });
      else setRealVolume((isActuallyMuted() ? 0 : Number(host.volume ?? 80)) - 5, { showHud: true });
    }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePiP(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); ctx.toggleTheaterMode?.(); }
    else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); if (isActuallyMuted()) doUnlockAudio(); else { host.setMuted(true, true); update(); } }
    else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); miniMicBtn.click(); }
    else if (e.key === '[' || e.key === '{' || e.key === 'z' || e.key === 'Z' || e.key === ',') {
      e.preventDefault();
      const isFast = e.key === '{' || (e.key === '[' && e.shiftKey);
      const step = isFast ? -5.0 : (e.key === ',' ? -0.2 : -0.5);
      const off = host.adapter?.subs?.setSubtitleOffset?.(step);
      if (typeof off === 'number') {
        showOverlay(`⏱️ Altyazı Senkronu: ${off >= 0 ? '+' : ''}${off} sn (Kısayol: [ / ] ${isFast ? '· İleri Kademe' : ''})`, 1500);
      }
      revealControls();
    }
    else if (e.key === ']' || e.key === '}' || e.key === 'x' || e.key === 'X' || e.key === '.') {
      e.preventDefault();
      const isFast = e.key === '}' || (e.key === ']' && e.shiftKey);
      const step = isFast ? 5.0 : (e.key === '.' ? 0.2 : 0.5);
      const off = host.adapter?.subs?.setSubtitleOffset?.(step);
      if (typeof off === 'number') {
        showOverlay(`⏱️ Altyazı Senkronu: ${off >= 0 ? '+' : ''}${off} sn (Kısayol: [ / ] ${isFast ? '· İleri Kademe' : ''})`, 1500);
      }
      revealControls();
    }
    else if (e.key === '\\' || e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      host.adapter?.subs?.setSubtitleOffset?.(0, true);
      host.adapter?.subs?.setSubtitleFpsScale?.(1.0);
      showOverlay('⏱️ Altyazı Senkronu Sıfırlandı (0.0 sn)', 1500);
      revealControls();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Timeline seek & drag scrubbing (leader only — Rave timeline-container-non-leader hides the knob).
  let scrubbing = false;
  const seekFromEvent = (e, commit = true) => {
    const d = duration();
    if (!d || !canSeekNow()) return;
    const r = timeline.getBoundingClientRect();
    const isRotated = r.height > r.width;
    const ratio = isRotated
      ? Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)))
      : Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    const target = ratio * d;
    cur.style.width = `${ratio * 100}%`;
    knob.style.left = `${ratio * 100}%`;
    time.textContent = `${fmtTime(target)} / ${fmtTime(d)}`;
    if (commit) actions.seek(target);
  };
  timeline.addEventListener('pointerdown', (e) => {
    if (!canSeekNow()) {
      e.stopPropagation();
      toast(state.mesh?.curated ? '7/24 canlı yayın akışı ileri/geri sarılamaz' : 'Videoyu yalnızca oda başkanı sarabilir');
      return;
    }
    if (!duration()) return;
    e.stopPropagation();
    scrubbing = true;
    try { timeline.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    seekFromEvent(e, false);
  });
  const updateSeekPreview = (e) => {
    const d = duration();
    if (!d) { seekPreview.classList.add('hidden'); return; }
    const r = timeline.getBoundingClientRect();
    const isRotated = r.height > r.width;
    const ratio = isRotated
      ? Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)))
      : Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    const target = ratio * d;
    seekPreview.classList.remove('hidden');
    seekPreview.style.left = `${Math.max(8, Math.min(92, ratio * 100))}%`;
    const realChapters = Array.isArray(state.mesh?.media?.chapters) ? state.mesh.media.chapters : [];
    const hitChap = realChapters.find((ch) => Number.isFinite(ch?.start) && target >= ch.start && (!ch.end || target < ch.end));
    seekPreviewChapter.textContent = hitChap?.title || '';
    seekPreviewChapter.classList.toggle('hidden', !hitChap?.title);
    seekPreviewTime.textContent = `${fmtTime(target)} / ${fmtTime(d)}`;
    const subsObj = host.adapter?.subs;
    const adjTarget = subsObj ? ((target * (subsObj.fpsScale || 1.0)) - (subsObj.offsetSec || 0)) : target;
    const cueAt = subsObj?.findCueAt?.(subsObj.subCues || [], adjTarget);
    seekPreviewSub.textContent = cueAt?.text ? `"${cueAt.text.slice(0, 48)}"` : '';
  };
  timeline.addEventListener('pointermove', (e) => {
    updateSeekPreview(e);
    if (!scrubbing) return;
    seekFromEvent(e, false);
  });
  timeline.addEventListener('pointerleave', () => {
    if (!scrubbing) seekPreview.classList.add('hidden');
  });
  let lastScrubEndedAt = 0;
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    lastScrubEndedAt = Date.now();
    try { timeline.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    seekPreview.classList.add('hidden');
    seekFromEvent(e, true);
  };
  const cancelScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    lastScrubEndedAt = Date.now();
    try { timeline.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    seekPreview.classList.add('hidden');
    update();
  };
  timeline.addEventListener('pointerup', endScrub);
  timeline.addEventListener('pointercancel', cancelScrub);
  timeline.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!canSeekNow()) {
      toast(state.mesh?.curated ? '7/24 canlı yayın akışı ileri/geri sarılamaz' : 'Videoyu yalnızca oda başkanı sarabilir');
      return;
    }
    if (Date.now() - lastScrubEndedAt < 380) return;
    seekFromEvent(e, true);
  });

  const duration = () => Number(host.adapter?.getDuration?.() || state.mesh?.media?.duration || 0);
  const position = () => (host.adapter ? host.adapter.getTime() : 0);

  let lastCinemaSeatsSig = '';
  function renderCinemaSeats() {
    const parts = Array.isArray(state.mesh?.participants) ? state.mesh.participants : [];
    const hasMedia = Boolean(state.mesh?.media && (state.mesh.media.url || state.mesh.media.videoId));
    const now = Date.now();
    const activeParts = parts.filter((p) => {
      const uName = String(p.name || 'Misafir');
      const reactObj = seatReactions.get(uName);
      const hasEmoji = Boolean(reactObj && now - reactObj.at < 2600);
      const isSpk = Boolean(p.speaking || (p.id === state.clientId && ctx.voice?.selfSpeaking));
      return hasEmoji || isSpk;
    });
    if (!hasMedia || !activeParts.length) {
      if (lastCinemaSeatsSig !== '') {
        lastCinemaSeatsSig = '';
        cinemaSeatsBar.classList.add('hidden');
      } else if (!cinemaSeatsBar.classList.contains('hidden')) {
        cinemaSeatsBar.classList.add('hidden');
      }
      return;
    }
    cinemaSeatsBar.classList.remove('hidden');
    const visibleParts = activeParts.slice(0, 6);
    const nextSig = visibleParts.map((p) => {
      const uName = String(p.name || 'Misafir');
      const reactObj = seatReactions.get(uName);
      const activeEmoji = (reactObj && now - reactObj.at < 2600) ? reactObj.emoji : '';
      const isSpeaking = Boolean(p.speaking || (p.id === state.clientId && ctx.voice?.selfSpeaking));
      const isRoomHost = Boolean(p.isHost || p.id === state.mesh?.hostId || p.id === state.mesh?.leaderId);
      return `${p.id || uName}:${isSpeaking ? 1 : 0}:${isRoomHost ? 1 : 0}:${activeEmoji}`;
    }).join('|');
    if (nextSig === lastCinemaSeatsSig) return;
    lastCinemaSeatsSig = nextSig;
    fill(
      cinemaSeatsBar,
      ...visibleParts.map((p) => {
        const uName = String(p.name || 'Misafir');
        const reactObj = seatReactions.get(uName);
        const activeEmoji = (reactObj && now - reactObj.at < 2600) ? reactObj.emoji : '';
        const isSpeaking = Boolean(p.speaking || (p.id === state.clientId && ctx.voice?.selfSpeaking));
        const isRoomHost = Boolean(p.isHost || p.id === state.mesh?.hostId || p.id === state.mesh?.leaderId);
        return h(
          'div',
          {
            class: `cinema-seat ${isSpeaking ? 'is-speaking' : ''} ${isRoomHost ? 'is-host' : ''}`,
            'data-seat-user': uName,
            title: `${uName}${isRoomHost ? ' (Oda Başkanı)' : ''}${isSpeaking ? ' · Konuşuyor' : ''}`,
          },
          activeEmoji ? h('div', { class: 'seat-emoji-pop' }, activeEmoji) : null,
          h('div', { class: 'seat-avatar-wrap' },
            avatar(p, 24),
            isRoomHost ? h('span', { class: 'seat-crown' }, '👑') : null,
          ),
          h('span', { class: 'seat-name' }, uName.slice(0, 10)),
        );
      }),
    );
  }

  let smoothPos = 0;
  let smoothMediaSig = '';
  let lastProgressSavedAt = 0;

  function tick() {
    const d = duration();
    const rawPos = Math.min(position(), d || Infinity);
    const vAct = host.adapter?.video;
    const mSig = `${state.mesh?.media?.tmdbId || state.mesh?.media?.id || state.mesh?.media?.url || ''}:${state.mesh?.media?.season || 0}:${state.mesh?.media?.episode || 0}`;
    if (mSig !== smoothMediaSig) {
      smoothMediaSig = mSig;
      smoothPos = rawPos;
    }
    const isStalledOrSeeking = Boolean(host.loading || vAct?.seeking || host.adapter?.isBuffering?.() || (vAct && vAct.readyState < 3 && !vAct.paused));
    let p = rawPos;
    if (!scrubbing && isStalledOrSeeking && rawPos < smoothPos && (smoothPos - rawPos) < 25) {
      p = smoothPos;
    } else {
      smoothPos = rawPos;
    }
    if (vAct && !vAct.seeking && vAct.readyState >= 3 && !host.loading) {
      loading.classList.add('hidden');
    }
    stageBackdrop.classList.toggle('is-hero-cover', false);
    if (!scrubbing) {
      const pct = d ? (p / d) * 100 : 0;
      cur.style.width = `${pct}%`;
      knob.style.left = `${pct}%`;
      const timeLabel = host.adapter?.caps.live ? 'CANLI' : `${fmtTime(p)} / ${fmtTime(d)}`;
      time.textContent = timeLabel;
      timeline.setAttribute('aria-valuenow', String(Math.round(pct)));
      timeline.setAttribute('aria-valuetext', timeLabel);
    }
    buf.style.width = d ? `${Math.min(100, ((host.adapter?.getBuffered?.() || 0) / d) * 100)}%` : '0%';
    updateUnmuteVisibility();
    renderCinemaSeats();
    const m = state.mesh?.media;
    if (m && !state.mesh?.curated && !m.isMusic && !m.live && !host.adapter?.caps?.live && !(host.adapter?.initialSeekPending > 3) && p > 12 && d > 45 && Date.now() - lastProgressSavedAt > 15000) {
      lastProgressSavedAt = Date.now();
      saveWatchProgress({ ...m, poster: m.poster || thumbFor(m) || m.thumbnail || '' }, p, d);
    }
    const activeIntro = getActiveIntro();
    skipIntroBtn.classList.toggle('hidden', !(activeIntro && p >= Number(activeIntro.start || 0) && p <= Number(activeIntro.end || 0) - 2));
    const rem = d > 300 ? d - p : 9999;
    const curEpKey = m ? `${m.tmdbId || m.id || m.title}_${m.season || 1}_${m.episode || 1}` : '';
    const nextSpecBanner = (m?.mediaType === 'tv' && m?.tmdbId) ? computeNextEpSpec(m, Number(m.season || 1), Number(m.episode || 1)) : null;
    if (nextSpecBanner && !nextSpecBanner.isFinale && rem <= 35 && rem > 0 && cancelledNextEpKey !== curEpKey) {
      const nextEp = nextSpecBanner.episode;
      const curSeason = nextSpecBanner.season;
      const cleanSeries = nextSpecBanner.cleanSeries;
      const pctCountdown = Math.max(0, Math.min(100, ((35 - rem) / 35) * 100));
      const posterSrc = thumbFor(m) || '/static/watchlivo-logo.svg';
      const bannerKey = `${curEpKey}:${curSeason}:${nextEp}:${isLeader() ? 1 : 0}`;
      nextEpBanner.classList.remove('hidden');
      if (nextEpBanner.dataset.bannerKey !== bannerKey) {
        nextEpBanner.dataset.bannerKey = bannerKey;
        fill(
          nextEpBanner,
          h('div', { class: 'next-ep-card' },
            h('img', { class: 'next-ep-thumb', src: posterSrc, alt: cleanSeries }),
            h('div', { class: 'next-ep-info' },
              h('div', { class: 'next-ep-kicker' }, `SIRADAKİ BÖLÜM · ${Math.ceil(rem)} SN`),
              h('div', { class: 'next-ep-title' }, `${cleanSeries} · S${curSeason}:B${nextEp}`),
              h('div', { class: 'next-ep-progress' },
                h('div', { class: 'next-ep-progress-bar', style: { width: `${pctCountdown.toFixed(1)}%` } }),
              ),
              h('div', { class: 'next-ep-actions' },
                (isLeader() || canSelectVideo())
                  ? h('button', {
                      class: 'btn primary next-ep-go',
                      ...tapProps(() => triggerNextEpisode(true)),
                    }, '▶ Hemen Geç')
                  : h('span', { class: 'dim', style: { fontSize: '.74em' } }, 'Oda başkanı bekleniyor…'),
                h('button', {
                  class: 'btn next-ep-cancel',
                  ...tapProps(() => {
                    cancelledNextEpKey = curEpKey;
                    nextEpBanner.classList.add('hidden');
                  }),
                }, '✕ İptal'),
              ),
            ),
          ),
        );
      } else {
        const kickerEl = nextEpBanner.querySelector('.next-ep-kicker');
        if (kickerEl) kickerEl.textContent = `SIRADAKİ BÖLÜM · ${Math.ceil(rem)} SN`;
        const progEl = nextEpBanner.querySelector('.next-ep-progress-bar');
        if (progEl) progEl.style.width = `${pctCountdown.toFixed(1)}%`;
      }
      if (rem <= 1.2 && isLeader()) triggerNextEpisode();
    } else {
      nextEpBanner.classList.add('hidden');
    }
    if (ambilightEnabled) {
      ambilightCanvas.classList.add('on');
      const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
      if (v && v.videoWidth > 0 && !v.paused) {
        try {
          const c2d = ambilightCanvas.getContext('2d');
          c2d.drawImage(v, 0, 0, 32, 18);
          ambilightCanvas.style.opacity = '0.55';
        } catch (e) { ambilightCanvas.style.opacity = '0'; }
      }
    } else {
      ambilightCanvas.style.opacity = '0';
      ambilightCanvas.classList.remove('on');
    }
    if (!host.adapter?.video || (host.adapter.video.readyState >= 2 && (host.adapter.video.videoWidth > 0 || host.adapter.isMusic))) {
      host.adapter?.subs?.onTimeUpdate?.(p);
    } else {
      host.adapter?.subs?.clearActiveCue?.();
    }
    if (m && d > 0 && Date.now() - lastMediaPosSyncAt > 2500 && typeof navigator !== 'undefined' && navigator.mediaSession?.setPositionState) {
      try {
        lastMediaPosSyncAt = Date.now();
        const r = Number(m.meshStatePlaybackSpeed || host.adapter?.getRate?.() || 1);
        navigator.mediaSession.setPositionState({ duration: d, playbackRate: r > 0 ? r : 1, position: Math.max(0, Math.min(d, p)) });
      } catch (e) { /* ignore */ }
    }
    const inSubPreview = (currentMenuView === 'subtitlePreferences' || currentMenuView === 'subtitle') && subCue.dataset.previewSample === '1';
    const curSub = host.adapter?.getSelectedSubtitleId?.() || 'off';
    if (inSubPreview) {
      subOverlay.classList.remove('hidden');
    } else if (curSub === 'off' || !subCue.textContent) {
      if (curSub === 'off') {
        subCue.textContent = '';
        dualCue.textContent = '';
      }
      subOverlay.classList.add('hidden');
    } else {
      subOverlay.classList.remove('hidden');
    }
  }
  const tickTimer = setInterval(tick, 500);

  function formatOpenInProvider(name) {
    const n = String(name || 'Orijinal').trim();
    const map = {
      'Netflix': "Netflix'te Aç",
      'Disney+': "Disney+'ta Aç",
      'Prime Video': "Prime Video'da Aç",
      'Max': "Max'te Aç",
      'Apple TV+': "Apple TV+'ta Aç",
      'Exxen': "Exxen'de Aç",
      'BluTV': "BluTV'de Aç",
      'GAİN': "GAİN'de Aç",
      'TOD': "TOD'da Aç",
      'tabii': "tabii'de Aç",
      'TV+': "TV+'ta Aç",
      'puhutv': "puhutv'de Aç",
      'MUBI': "MUBI'de Aç",
      'Crunchyroll': "Crunchyroll'da Aç",
      'YouTube': "YouTube'da Aç",
      'Twitch': "Twitch'te Aç",
      'Kick': "Kick'te Aç",
    };
    if (map[n]) return map[n];
    if (/[eiöü]$/i.test(n)) return `${n}'de Aç`;
    return `${n}'da Aç`;
  }

  function openOfficialPlatform() {
    const m = state.mesh?.media;
    const extUrl = m?.officialUrl || m?.providerUrl || '';
    if (extUrl && /^https?:\/\//i.test(extUrl)) {
      try {
        window.open(extUrl, '_blank', 'noopener,noreferrer');
        return;
      } catch (e) { /* fallback */ }
    }
    setView('left', 'Search');
    ctx.layout?.update?.();
  }

  function openEpisodeModal() {
    if (!canSelectVideo()) {
      toast("Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider bölüm değiştirebilir.");
      return;
    }
    const m = state.mesh?.media;
    if (!m) return;
    const parsedEp = String(m.title || '').match(/S(\d+)\s*:\s*B(\d+)|(\d+)\.\s*Sezon\s*(\d+)\.\s*Bölüm/i);
    const curS = Number(m.season || parsedEp?.[1] || parsedEp?.[3] || 0);
    const curE = Number(m.episode || parsedEp?.[2] || parsedEp?.[4] || 0);
    const isMovie = m.mediaType === 'movie' || /Tam Film/i.test(String(m.channel || ''));
    if (isMovie || (m.mediaType !== 'tv' && !parsedEp)) return;
    const rawProvId = String(m.catalogProvider || m.provider || 'cinema').toLowerCase();
    const safeProvId = ['youtube', 'web', 'hls', 'mp4', 'direct', 'web-direct', 'embed'].includes(rawProvId) ? 'cinema' : rawProvId;
    const prov = getProvider(safeProvId) || getProvider('cinema') || getProvider('netflix');
    const cleanTitle = String(m.seriesTitle || m.title || 'Dizi').replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim() || 'Dizi';
    const cleanOrigTitle = String(m.originalTitle || cleanTitle).replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim() || cleanTitle;
    const rawSrcUrl = String(m.sourceUrl || '').trim();
    const safeSrcUrl = (/youtube\.com|youtu\.be|\/search\?|[-/]bolum|episode-|sezon-\d+/i.test(rawSrcUrl)) ? '' : rawSrcUrl;
    const box = h('div', { style: { minHeight: '280px' } });
    const epModal = popup({ title: `📺 ${cleanTitle} — Sezon & Bölüm Seç`, content: box, options: [{ label: 'Kapat' }] });
    renderSeriesPicker(
      {
        id: m.id || '',
        tmdbId: /^\d+$/.test(String(m.tmdbId || '')) ? String(m.tmdbId) : '',
        imdbId: m.imdbId || '',
        title: cleanTitle,
        seriesTitle: cleanTitle,
        originalTitle: cleanOrigTitle,
        year: m.year || '',
        season: curS || 1,
        episode: curE || 1,
        mediaType: 'tv',
        sourceUrl: safeSrcUrl,
        poster: m.thumbnail,
      },
      prov,
      box,
      () => epModal.close(),
      async (nextMedia) => {
        epModal.close();
        const pickFn = actions?.pickMedia || ctx.actions?.pickMedia || ctx.pickMedia;
        if (typeof pickFn === 'function') {
          await pickFn({
            ...nextMedia,
            id: nextMedia.id || m.id || '',
            tmdbId: nextMedia.tmdbId || m.tmdbId || '',
            imdbId: nextMedia.imdbId || m.imdbId || '',
            catalogProvider: (nextMedia.catalogProvider && nextMedia.catalogProvider !== 'youtube') ? nextMedia.catalogProvider : safeProvId,
            mediaType: 'tv',
            seriesTitle: cleanTitle,
            originalTitle: nextMedia.originalTitle || cleanOrigTitle,
            sourceUrl: nextMedia.sourceUrl || safeSrcUrl || '',
          });
        }
      },
      (it, pr, sNum, eNum, epTitle) => resolveCatalogItem(it, pr, sNum, eNum, epTitle, { applySavedResume: false }),
    );
  }

  let currentMenuView = 'list';
  const shouldPortalMenuToBody = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && fsEl !== document.documentElement && fsEl !== document.body) {
      return false;
    }
    if (frame.classList.contains('fullscreen') || document.body.classList.contains('vortex-fs')) {
      return true;
    }
    return window.innerWidth <= 960 || window.innerHeight <= 560 || frame.clientHeight < 460 || frame.clientWidth < 400;
  };
  const syncMenuPortal = () => {
    if (typeof document === 'undefined') return;
    const isOpen = !menu.classList.contains('hidden');
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && fsEl !== document.documentElement && fsEl !== document.body) {
      menu.classList.remove('is-body-portal');
      menu.classList.add('is-fs-portal');
      menuBackdrop.classList.remove('is-body-portal');
      menuBackdrop.classList.add('is-fs-portal');
      if (menuBackdrop.parentElement !== fsEl) fsEl.appendChild(menuBackdrop);
      if (menu.parentElement !== fsEl) fsEl.appendChild(menu);
      menuBackdrop.classList.toggle('hidden', !isOpen);
      return;
    }
    menu.classList.remove('is-fs-portal');
    menuBackdrop.classList.remove('is-fs-portal');
    if (shouldPortalMenuToBody()) {
      menu.classList.add('is-body-portal');
      menuBackdrop.classList.add('is-body-portal');
      if (menuBackdrop.parentElement !== document.body) document.body.appendChild(menuBackdrop);
      if (menu.parentElement !== document.body) document.body.appendChild(menu);
      menuBackdrop.classList.toggle('hidden', !isOpen);
    } else {
      menu.classList.remove('is-body-portal');
      menuBackdrop.classList.remove('is-body-portal');
      menuBackdrop.classList.add('hidden');
      if (menuBackdrop.parentElement) menuBackdrop.remove();
      if (menu.parentElement !== controls) controls.appendChild(menu);
    }
  };
  function toggleMenu(view = 'list') {
    if (!menu.classList.contains('hidden') && currentMenuView === view) {
      closeMenu();
      return;
    }
    renderMenuView(view);
    menu.classList.remove('hidden');
    frame.classList.add('menu-open');
    if (typeof document !== 'undefined') document.body?.classList.add('ctl-menu-open');
    syncMenuPortal();
  }

  const cleanSrvUrl = (u) => String(u || '').replace(/&aud=[^&]+/g, '').replace(/&proxy_segs=1/g, '').trim();

  async function refreshCurrentStreamSources() {
    const m = state.mesh?.media;
    if (!m || (!m.tmdbId && !m.imdbId && !m.title && !m.url && !m.videoId)) return;
    closeMenu();
    errorBox.classList.add('hidden');
    loading.classList.remove('hidden');
    showOverlay('🔄 Yayın kaynakları canlı yenileniyor…', 3500);
    const curPos = position();
    const cleanSeriesTitle = String(m.seriesTitle || m.title || '').replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim();
    const cleanOrigTitle = String(m.originalTitle || cleanSeriesTitle || m.title || '').replace(/\s*(?:[—–\-·|]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon(?:\s*\d+\.\s*Bölüm)?|\d+\.\s*Bölüm|Episode\s*\d+).*$/i, '').trim();
    const rawRefreshProv = String(m.catalogProvider || m.provider || 'cinema').toLowerCase();
    const safeRefreshProv = ['youtube', 'web', 'hls', 'mp4', 'direct', 'web-direct', 'embed'].includes(rawRefreshProv) ? 'cinema' : rawRefreshProv;
    try {
      const qs = new URLSearchParams({
        provider: safeRefreshProv,
        title: cleanOrigTitle || cleanSeriesTitle,
        displayTitle: cleanSeriesTitle,
        year: String(m.year || ''),
        tmdbId: String(m.tmdbId || ''),
        imdbId: String(m.imdbId || ''),
        mediaType: String(m.mediaType || 'movie'),
        season: String(m.season || 1),
        episode: String(m.episode || 1),
        refresh: '1',
      });
      const r = await fetch(`/api/rave/resolve-catalog?${qs.toString()}`);
      if (r.ok) {
        const fresh = await r.json();
        if (fresh && fresh.url) {
          m.url = fresh.url;
          if (Array.isArray(fresh.altUrls)) m.altUrls = fresh.altUrls;
          if (Array.isArray(fresh.servers)) m.servers = fresh.servers;
          if (Array.isArray(fresh.audioTracks) && fresh.audioTracks.length) m.audioTracks = fresh.audioTracks;
          host.key = '';
          host.loadedUrl = '';
          await host.setMedia(m, curPos, true);
          ctx.conn?.send('resolve_media', { ...m, currentTime: curPos });
          loading.classList.add('hidden');
          showOverlay('✅ Yayın kaynağı yenilendi', 2200);
          update();
          return;
        }
      }
    } catch (e) { /* ignore */ }
    if (m.url || m.videoId) {
      host.key = '';
      host.loadedUrl = '';
      await host.setMedia(m, curPos, true);
      loading.classList.add('hidden');
      showOverlay('✅ Yayın kaynağı yeniden başlatıldı', 2200);
      update();
      return;
    }
    loading.classList.add('hidden');
    errorBox.classList.remove('hidden');
    toast('Alternatif yayın kaynağı bulunamadı.');
  }

  function renderMenuView(view) {
    currentMenuView = view;
    menu.dataset.view = view;
    frame.dataset.menuView = view;
    if (view !== 'subtitlePreferences' && view !== 'subtitle' && subCue.dataset.previewSample === '1') {
      delete subCue.dataset.previewSample;
      subCue.textContent = '';
      host.adapter?.subs?.onTimeUpdate?.(position(), true);
      if (!subCue.textContent) subOverlay.classList.add('hidden');
    }
    const m = state.mesh?.media || {};
    const rate = Number(m.meshStatePlaybackSpeed || 1);
    const subTracks = host.adapter?.getSubtitleTracks?.() || m.subtitleTracks || [];
    const curSubId = host.adapter?.getSelectedSubtitleId?.() || 'off';
    const curSubObj = subTracks.find((t) => t.id === curSubId);
    const rawAudioTracks = host.adapter?.getAudioTracks?.() || m.audioTracks || [];
    const isAnimeMedia = (cm) => Boolean(cm && (cm.provider === 'anime' || cm.origLang === 'ja' || cm.type === 'anime' || cm.catalogProvider === 'anime' || /anime/i.test(String(cm.category || cm.genre || ''))));
    const audioTracks = rawAudioTracks.length
      ? rawAudioTracks
      : (m.isMusic || m.isLive || !isAnimeMedia(m)
          ? [{ id: 'orig', label: '🎬 Orijinal Ses (HD)' }]
          : [
              { id: 'orig', label: '🎬 Orijinal Ses' },
              { id: 'tr-ai-dub', label: '🇹🇷 Türkçe Dublaj (Akıllı Seslendirme)', mode: 'tts' },
            ]);
    const curAudioId = host.adapter?.getSelectedAudioId?.() || 'orig';
    const curAudioObj = audioTracks.find((t) => t.id === curAudioId) || audioTracks[0];
    const rawServers = Array.isArray(m.servers) && m.servers.length
      ? m.servers.map((s, idx) => (typeof s === 'string'
          ? { id: `srv-${idx + 1}`, label: `📡 Sunucu ${idx + 1}`, url: s }
          : s)).filter((s) => s && s.url)
      : Array.from(new Set([m.url, ...(m.altUrls || [])].map((u) => cleanSrvUrl(u)).filter(Boolean))).map((u, idx) => ({
          id: `srv-${idx + 1}`,
          label: `📡 Sunucu ${idx + 1} · ${u.includes('ref=fhd') ? 'FullHD (1080p)' : u.includes('ref=pv') ? 'Pilavyer (HD)' : u.includes('ref=ve') ? 'VidFast (1080p)' : u.includes('ref=dl') ? 'DiziLife (1080p)' : 'Alternatif Yayın (HD)'}`,
          url: u,
        }));
    const curStreamClean = cleanSrvUrl(host.adapter?.currentUrl || m.url || '');
    const curSrvObj = rawServers.find((s) => cleanSrvUrl(s.url) === curStreamClean) || rawServers[0] || null;

    const closeBtn = () => h('button', {
      class: 'ctl-menu-close',
      'aria-label': 'Menüyü Kapat',
      onclick: (e) => { e.stopPropagation(); closeMenu(); },
    }, '✕');

    const backHeader = (titleText, targetView = 'list', rightEl = null) => h(
      'div',
      { class: 'ctl-menu-head' },
      h('button', { class: 'ctl-menu-back', onclick: (e) => { e.stopPropagation(); renderMenuView(targetView); } }, '‹ ', titleText),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, rightEl, closeBtn()),
    );

    if (view === 'subtitle') {
      if (!subCue.textContent && curSubId !== 'off') {
        subCue.dataset.previewSample = '1';
        subCue.textContent = 'Altyazı Görünümü Önizleme';
      }
      applySubPrefsStyle();
      if (curSubId !== 'off') subOverlay.classList.remove('hidden');
      const prefBtn = h('button', { class: 'ctl-menu-subbtn', onclick: (e) => { e.stopPropagation(); renderMenuView('subtitlePreferences'); } }, '🎨 Gelişmiş');
      const prefs = getSubPrefs();
      const curMedia = state.mesh?.media || host.adapter?.media || host.media || {};
      const isAnimeContent = curMedia.provider === 'anime' || curMedia.origLang === 'ja' || curMedia.type === 'anime' || isAnimeMedia(curMedia);
      const visibleAudioTracks = audioTracks.filter((t) => isAnimeContent || (t.id !== 'tr-ai-dub' && t.id !== 'en-ai-dub' && t.mode !== 'tts'));
      const audioSection = [
        h('div', { class: 'dim', style: { fontSize: '.74em', fontWeight: '700', padding: '.25em .7em .15em', color: '#a5b4fc' } }, '🎙️ Ses & Dublaj Seçimi'),
        ...visibleAudioTracks.map((t) => h('div', {
          class: `opt ${curAudioId === t.id ? 'on' : ''}`,
          onclick: async (e) => {
            e.stopPropagation();
            if (host.autoplayBlocked || (isActuallyMuted() && !host.userMuted)) doUnlockAudio();
            const prevAudUrl = host.adapter?.currentUrl || '';
            await host.adapter?.setAudioTrack?.(t.id);
            const afterAudUrl = host.adapter?.currentUrl || '';
            if (afterAudUrl && afterAudUrl !== prevAudUrl && state.mesh?.media) {
              state.mesh.media.url = afterAudUrl;
              if (ctx?.conn?.lastRoom?.media) ctx.conn.lastRoom.media.url = afterAudUrl;
              if (isLeader()) ctx.conn?.send('resolve_media', { ...state.mesh.media, url: afterAudUrl, currentTime: position() });
            }
            ctx.sync?.kick();
            showOverlay(`🎙️ Ses: ${t.label}`, 2000);
            closeMenu();
            update();
          },
        }, h('span', {}, t.label), curAudioId === t.id ? h('span', {}, '✓') : null)),
        h('div', { class: 'dim', style: { fontSize: '.74em', fontWeight: '700', padding: '.45em .7em .15em', borderTop: '1px solid rgba(255,255,255,.1)', marginTop: '.25em', color: '#a5b4fc' } }, `💬 Altyazı Seçimi (${subTracks.length} Dil)`),
      ];
      const rows = [
        ...audioSection,
        h('div', {
          class: `opt ${curSubId === 'off' ? 'on' : ''}`,
          onclick: async (e) => {
            e.stopPropagation();
            subCue.textContent = '';
            dualCue.textContent = '';
            subOverlay.classList.add('hidden');
            await host.adapter?.setSubtitleTrack?.('off');
            ctx.sync?.kick();
            showOverlay('💬 Altyazı: Kapalı', 1800);
            closeMenu();
            update();
          },
        }, h('span', {}, '🚫 Kapalı (Off)'), curSubId === 'off' ? h('span', {}, '✓') : null),
        ...subTracks.map((t) => h('div', {
          class: `opt ${curSubId === t.id ? 'on' : ''}`,
          onclick: async (e) => {
            e.stopPropagation();
            await host.adapter?.setSubtitleTrack?.(t.id);
            ctx.sync?.kick();
            showOverlay(`💬 Altyazı: ${t.label}`, 1800);
            closeMenu();
            update();
          },
        }, h('span', {}, t.label), curSubId === t.id ? h('span', {}, '✓') : null)),
        h('div', {
          class: 'opt',
          onclick: (e) => {
            e.stopPropagation();
            const fIn = document.createElement('input');
            fIn.type = 'file';
            fIn.accept = '.srt,.vtt,.ass,.ssa,.sub';
            fIn.onchange = async () => {
              const f = fIn.files?.[0];
              if (!f) return;
              const trk = await host.adapter?.subs?.loadLocalSubtitleFile?.(f);
              if (trk) {
                showOverlay(`📁 Altyazı yüklendi: ${f.name}`, 2000);
                closeMenu();
                update();
              } else {
                toast('Altyazı dosyası okunamadı (.srt, .vtt veya .ass seçin)');
              }
            };
            fIn.click();
          },
        }, h('span', {}, '📁 Bilgisayardan Altyazı Seç (.srt, .vtt, .ass)')),
      ];
      const quickStyleRow = h('div', { class: 'ctl-pref-group', style: { borderTop: '1px solid rgba(255,255,255,.1)', marginTop: '.3em' } },
        h('div', { class: 'dim', style: { fontSize: '.74em', marginBottom: '4px' } }, '🔤 Altyazı Boyutu, Rengi & Konumu'),
        h('div', { class: 'ctl-pref-pills', style: { marginBottom: '6px' } },
          ...[[0.75, '%75'], [0.85, '%85'], [1.0, '%100'], [1.25, '%125'], [1.5, '%150']].map(([val, txt]) => h('button', {
            class: `ctl-pref-pill ${Number(prefs.size) === Number(val) ? 'on' : ''}`,
            onclick: (e) => { e.stopPropagation(); setSubPrefs({ size: val }); applySubPrefsStyle(); renderMenuView('subtitle'); },
          }, txt))),
        h('div', { class: 'ctl-pref-pills', style: { marginBottom: '6px' } },
          ...[['white', '⚪ Beyaz'], ['yellow', '🟡 Sarı'], ['cyan', '🔵 Turkuaz'], ['green', '🟢 Yeşil'], ['pink', '🩷 Pembe']].map(([val, txt]) => h('button', {
            class: `ctl-pref-pill ${prefs.color === val ? 'on' : ''}`,
            onclick: (e) => { e.stopPropagation(); setSubPrefs({ color: val }); applySubPrefsStyle(); renderMenuView('subtitle'); },
          }, txt))),
        h('div', { class: 'ctl-pref-pills' },
          ...[[0, '⬇️ Alt'], [24, '↕️ Orta-Alt'], [48, '⬆️ Yukarı']].map(([val, txt]) => h('button', {
            class: `ctl-pref-pill ${Number(prefs.bottomOffset || 0) === Number(val) ? 'on' : ''}`,
            onclick: (e) => { e.stopPropagation(); setSubPrefs({ bottomOffset: val }); applySubPrefsStyle(); renderMenuView('subtitle'); },
          }, txt))));
      const curOff = host.adapter?.subs?.offsetSec || 0;
      const curFps = Number(host.adapter?.subs?.fpsScale || 1.0);
      const offsetRow = h('div', { class: 'ctl-pref-group', style: { borderTop: '1px solid rgba(255,255,255,.1)', marginTop: '.2em' } },
        h('div', { class: 'dim', style: { fontSize: '.74em', marginBottom: '4px' } }, `⏱️ Altyazı Senkron Kaydırma [ / ] (${curOff >= 0 ? '+' : ''}${curOff} sn)`),
        h('div', { class: 'ctl-pref-pills', style: { marginBottom: '6px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(36px, 1fr))', gap: '4px' } },
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-5.0); renderMenuView('subtitle'); } }, '-5s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-2.0); renderMenuView('subtitle'); } }, '-2s'),
          h('button', { class: 'ctl-pref-pill', title: 'Kısayol: [ veya z (-0.5s)', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-0.5); renderMenuView('subtitle'); } }, '-0.5s'),
          h('button', { class: 'ctl-pref-pill', title: 'Kısayol: \\ veya c (Sıfırla)', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(0, true); host.adapter?.subs?.setSubtitleFpsScale?.(1.0); renderMenuView('subtitle'); } }, 'Sıfırla'),
          h('button', { class: 'ctl-pref-pill', title: 'Kısayol: ] veya x (+0.5s)', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(0.5); renderMenuView('subtitle'); } }, '+0.5s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(2.0); renderMenuView('subtitle'); } }, '+2s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(5.0); renderMenuView('subtitle'); } }, '+5s')),
        h('div', { class: 'ctl-pref-pills', style: { marginBottom: '6px', display: 'flex', gap: '4px' } },
          h('button', { class: 'ctl-pref-pill', style: { flex: '1', color: '#38bdf8', fontWeight: 'bold' }, onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(45.0, true); renderMenuView('subtitle'); } }, '⚡ +45s Film İntro Eşitle'),
          h('button', { class: 'ctl-pref-pill', style: { flex: '1', color: '#38bdf8', fontWeight: 'bold' }, onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-45.0, true); renderMenuView('subtitle'); } }, '⚡ -45s Film İntro Eşitle')),
        h('div', { class: 'dim', style: { fontSize: '.72em', marginBottom: '4px' } }, '🎞️ İleri Sahne FPS Hız Uyumu'),
        h('div', { class: 'ctl-pref-pills' },
          ...[[1.0, 'Normal (1:1)'], [1.042709, 'NTSC→PAL (23.976→25)'], [0.95904, 'PAL→NTSC (25→23.976)']].map(([sc, lbl]) => h('button', {
            class: `ctl-pref-pill ${Math.abs(curFps - Number(sc)) < 0.005 ? 'on' : ''}`,
            onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleFpsScale?.(sc); renderMenuView('subtitle'); },
          }, lbl))));
      const prevMenuScroll = menu.querySelector('.ctl-menu-scroll')?.scrollTop || 0;
      const scrollBox = h('div', { class: 'ctl-menu-scroll' }, ...rows, quickStyleRow, offsetRow);
      menu.replaceChildren(backHeader('Altyazı & Dublaj', 'list', prefBtn), scrollBox);
      if (prevMenuScroll > 0) scrollBox.scrollTop = prevMenuScroll;
      return;
    }

    if (view === 'audio') {
      const curMedia = state.mesh?.media || host.adapter?.media || host.media || {};
      const isAnimeContent = curMedia.provider === 'anime' || curMedia.origLang === 'ja' || curMedia.type === 'anime' || isAnimeMedia(curMedia);
      const visibleAudioTracks = audioTracks.filter((t) => isAnimeContent || (t.id !== 'tr-ai-dub' && t.id !== 'en-ai-dub' && t.mode !== 'tts'));
      const rows = visibleAudioTracks.map((t) => h('div', {
        class: `opt ${curAudioId === t.id ? 'on' : ''}`,
        onclick: async (e) => {
          e.stopPropagation();
          if (host.autoplayBlocked || (isActuallyMuted() && !host.userMuted)) doUnlockAudio();
          const prevAudUrl = host.adapter?.currentUrl || '';
          await host.adapter?.setAudioTrack?.(t.id);
          const afterAudUrl = host.adapter?.currentUrl || '';
          if (afterAudUrl && afterAudUrl !== prevAudUrl && state.mesh?.media) {
            state.mesh.media.url = afterAudUrl;
            if (ctx?.conn?.lastRoom?.media) ctx.conn.lastRoom.media.url = afterAudUrl;
            if (isLeader()) ctx.conn?.send('resolve_media', { ...state.mesh.media, url: afterAudUrl, currentTime: position() });
          }
          ctx.sync?.kick();
          showOverlay(`🎙️ Ses: ${t.label}`, 2000);
          closeMenu();
          update();
        },
      }, h('span', {}, t.label), curAudioId === t.id ? h('span', {}, '✓') : null));
      const subJump = h('div', {
        class: 'opt ctl-menu-switch-tab',
        onclick: (e) => { e.stopPropagation(); renderMenuView('subtitle'); },
      }, h('span', {}, '💬 Altyazı Seçimine Geç'), h('span', {}, '›'));
      menu.replaceChildren(backHeader('Ses & Dublaj (Audio)', 'list'), h('div', { class: 'ctl-menu-scroll' }, ...rows), subJump);
      return;
    }

    if (view === 'subtitlePreferences') {
      if (!subCue.textContent) {
        subCue.dataset.previewSample = '1';
        subCue.textContent = 'Altyazı Görünümü Önizleme';
      }
      applySubPrefsStyle();
      subOverlay.classList.remove('hidden');
      const prefs = getSubPrefs();
      const segRow = (label, options, curVal, onPick) => h('div', { class: 'ctl-pref-group' },
        h('div', { class: 'dim', style: { fontSize: '.74em', marginBottom: '4px' } }, label),
        h('div', { class: 'ctl-pref-pills' }, ...options.map(([val, txt]) => h('button', {
          class: `ctl-pref-pill ${String(curVal) === String(val) ? 'on' : ''}`,
          onclick: (e) => { e.stopPropagation(); onPick(val); applySubPrefsStyle(); renderMenuView('subtitlePreferences'); },
        }, txt))),
      );
      const scrollBox = h('div', { class: 'ctl-menu-scroll' },
        segRow('Yazı Rengi', [['white', '⚪ Beyaz'], ['yellow', '🟡 Sarı'], ['cyan', '🔵 Turkuaz'], ['green', '🟢 Yeşil'], ['pink', '🩷 Pembe']], prefs.color, (v) => setSubPrefs({ color: v })),
        segRow('Yazı Boyutu', [[0.75, '%75'], [0.85, '%85'], [1.0, '%100'], [1.25, '%125'], [1.5, '%150']], prefs.size, (v) => setSubPrefs({ size: v })),
        segRow('Yazı Tipi', [['sans-serif', 'Sans'], ['serif', 'Serif'], ['monospace', 'Mono'], ['cursive', 'El Yazısı']], prefs.font, (v) => setSubPrefs({ font: v })),
        segRow('Arka Plan Saydamlığı', [[0, 'Yok (%0)'], [0.4, 'Hafif (%40)'], [0.65, 'Yarı (%65)'], [0.92, 'Koyu (%92)']], prefs.bgOpacity, (v) => setSubPrefs({ bgOpacity: v })),
        segRow('Dikey Konum (Yükseklik)', [[0, '⬇️ Alt'], [24, '↕️ Orta-Alt'], [48, '⬆️ Yukarı']], Number(prefs.bottomOffset || 0), (v) => setSubPrefs({ bottomOffset: v })),
        segRow('Kenarlık & Gölge', [['outline', 'Keskin Kontur'], ['drop', 'Yumuşak Gölge'], ['none', 'Yok']], prefs.edgeStyle || 'drop', (v) => setSubPrefs({ edgeStyle: v, shadow: v !== 'none' })),
      );
      menu.replaceChildren(
        backHeader('Altyazı Görünümü', 'subtitle'),
        scrollBox,
      );
      return;
    }

    if (view === 'speed') {
      menu.replaceChildren(
        backHeader('Oynatma Hızı', 'list'),
        h('div', { class: 'dim', style: { fontSize: '.75em', padding: '.3em .7em' } }, canControlPlayback() ? 'Oynatma hızı' : 'Oynatma hızını yalnızca lider değiştirebilir'),
        ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => h('div', { class: `opt ${r === rate ? 'on' : ''}`, onclick: () => { if (!canControlPlayback()) { toast('Oynatma hızını yalnızca oda lideri değiştirebilir'); return; } closeMenu(); actions.setRate(r); } }, h('span', {}, `${r}x`), r === rate ? h('span', {}, '✓') : null)),
      );
      return;
    }

    if (view === 'servers') {
      const srvRows = rawServers.map((srv) => {
        const isOn = curSrvObj ? curSrvObj.id === srv.id : cleanSrvUrl(srv.url) === curStreamClean;
        return h('div', {
          class: `opt ${isOn ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            if (host.autoplayBlocked || (isActuallyMuted() && !host.userMuted)) doUnlockAudio();
            let nextSrvUrl = srv.url;
            const stickyPref = host.adapter?.subs?.userAudioPref || localStorage.getItem('vortex_audio_proxy_pref') || localStorage.getItem('watchlivo_audio_pref') || 'tr';
            const wantTrAud = curAudioId === 'tr-dub'
              || String(curAudioId || '').startsWith('tr-dub-')
              || stickyPref === 'tr-dub'
              || stickyPref === 'tr'
              || String(stickyPref).startsWith('tr-dub-')
              || (!stickyPref && m?.origLang && m.origLang !== 'tr');
            if (wantTrAud && nextSrvUrl.includes('/api/rave/stream?') && !/[?&]aud=/.test(nextSrvUrl) && /dual|tr dublaj|türkçe dublaj|fullhd|ref=fhd/i.test(`${srv.label || ''} ${nextSrvUrl}`)) {
              nextSrvUrl = nextSrvUrl.includes('&ext=.m3u8')
                ? nextSrvUrl.replace('&ext=.m3u8', '&aud=tr&ext=.m3u8')
                : `${nextSrvUrl}&aud=tr`;
            }
            m.url = nextSrvUrl;
            if (host.loadedUrl) host.loadedUrl = nextSrvUrl;
            if (ctx?.conn?.lastRoom?.media) ctx.conn.lastRoom.media.url = nextSrvUrl;
            host.adapter?.switchStreamSource?.(nextSrvUrl);
            host.adapter?.subs?.onStreamFallbackUrl?.(nextSrvUrl);
            if (canControlPlayback() || canSelectVideo()) {
              ctx.conn?.send('resolve_media', { ...m, url: nextSrvUrl, currentTime: position() });
            }
            showOverlay(srv.label, 2200);
            closeMenu();
            update();
          },
        }, h('span', {}, srv.label), isOn ? h('span', {}, '✓') : null);
      });
      const refreshRow = h('div', {
        class: 'opt ctl-menu-switch-tab',
        onclick: (e) => { e.stopPropagation(); refreshCurrentStreamSources(); },
      }, h('span', {}, '🔄 Kaynakları Canlı Yenile (Önbelleği Temizle)'), h('span', {}, '↻'));
      menu.replaceChildren(
        backHeader('Yayın Sunucusu Seçimi', 'list'),
        h('div', { class: 'ctl-menu-scroll' }, ...srvRows),
        refreshRow,
      );
      return;
    }

    if (view === 'quality') {
      const qLevels = host.adapter?.getQualityLevels?.() || [{ id: 0, label: '✨ Otomatik Akış', active: true }];
      menu.replaceChildren(
        backHeader('Görüntü Kalitesi', 'list'),
        ...qLevels.map((q) => h('div', {
          class: `opt ${q.active ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            host.adapter?.setQualityLevel?.(q.id);
            showOverlay(`🎞️ Kalite: ${q.label}`, 1800);
            closeMenu();
            update();
          },
        }, h('span', {}, q.label), q.active ? h('span', {}, '✓') : null)),
      );
      return;
    }

    const buildSlidersPanel = () => {
      const rawHostV = Number(host.volume);
      const curVol = isActuallyMuted() ? 0 : Math.max(0, Math.min(200, Math.round(Number.isFinite(rawHostV) ? rawHostV : 80)));
      const volValEl = h('span', { class: 'ctl-slider-val', id: 'ctl-menu-vol-val' }, `%${curVol}`);
      const brValEl = h('span', { class: 'ctl-slider-val', id: 'ctl-menu-bright-val' }, `%${currentBrightness}`);
      const stopEv = (ev) => { ev.stopPropagation(); revealControls(8000); };
      const volInp = h('input', {
        type: 'range',
        class: 'ctl-menu-range',
        id: 'ctl-menu-vol-range',
        min: '0',
        max: '200',
        step: '1',
        value: String(curVol),
        'aria-label': 'Ses Seviyesi',
        onpointerdown: stopEv,
        ontouchstart: stopEv,
        ontouchmove: stopEv,
        ontouchend: stopEv,
        onclick: (ev) => ev.stopPropagation(),
        oninput: (ev) => {
          ev.stopPropagation();
          const rawIn = Number(ev.target.value);
          const vNum = Math.max(0, Math.min(200, Math.round(Number.isFinite(rawIn) ? rawIn : 0)));
          volValEl.textContent = `%${vNum}`;
          setRealVolume(vNum, { showHud: true });
        },
      });
      const brInp = h('input', {
        type: 'range',
        class: 'ctl-menu-range is-bright',
        id: 'ctl-menu-bright-range',
        min: '0',
        max: '100',
        step: '1',
        value: String(currentBrightness),
        'aria-label': 'Ekran Parlaklığı',
        onpointerdown: stopEv,
        ontouchstart: stopEv,
        ontouchmove: stopEv,
        ontouchend: stopEv,
        onclick: (ev) => ev.stopPropagation(),
        oninput: (ev) => {
          ev.stopPropagation();
          const rawIn = Number(ev.target.value);
          const bNum = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawIn) ? rawIn : 100)));
          brValEl.textContent = `%${bNum}`;
          setBrightness(bNum, { showHud: true });
        },
      });
      const volToggleBtn = h('button', {
        type: 'button',
        class: 'ctl-slider-reset',
        onclick: (ev) => {
          ev.stopPropagation();
          const mutedNow = isActuallyMuted() || Number(host.volume) === 0;
          if (!mutedNow) {
            setRealVolume(0, { showHud: true });
            volInp.value = '0';
            volValEl.textContent = '%0';
            volToggleBtn.textContent = 'Sesi Aç';
          } else {
            const restoreV = Math.max(10, Math.min(100, Math.round(Number(host._lastNonZeroVol) || 50)));
            volInp.value = String(restoreV);
            volValEl.textContent = `%${restoreV}`;
            volToggleBtn.textContent = 'Sessiz';
            setRealVolume(restoreV, { showHud: true });
          }
        },
      }, curVol === 0 ? 'Sesi Aç' : 'Sessiz');
      return h('div', { class: 'ctl-sliders-card', id: 'ctl-sliders-card', onclick: (ev) => ev.stopPropagation() },
        h('div', { class: 'ctl-slider-row' },
          h('div', { class: 'ctl-slider-head' },
            h('span', { class: 'ctl-slider-lbl' }, '🔊 Ses Seviyesi'),
            h('div', { class: 'ctl-slider-actions' },
              volValEl,
              volToggleBtn)),
          volInp),
        h('div', { class: 'ctl-slider-row' },
          h('div', { class: 'ctl-slider-head' },
            h('span', { class: 'ctl-slider-lbl' }, '☀️ Parlaklık'),
            h('div', { class: 'ctl-slider-actions' },
              brValEl,
              h('button', {
                type: 'button',
                class: 'ctl-slider-reset',
                onclick: (ev) => {
                  ev.stopPropagation();
                  brInp.value = '100';
                  brValEl.textContent = '%100';
                  setBrightness(100, { showHud: true });
                },
              }, '%100'))),
          brInp),
      );
    };

    if (view === 'effects') {
      const duckOn = !['off', '0', 'false'].includes(String(localStorage.getItem('vortex_voice_duck') || '').toLowerCase());
      menu.replaceChildren(
        backHeader('Sinema Efektleri & Araçlar', 'list'),
        buildSlidersPanel(),
        ...Object.entries(VIDEO_FILTERS).map(([k, spec]) => h('div', {
          class: `opt ${curFilter === k ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            curFilter = k;
            try { localStorage.setItem('vortex_video_filter', k); } catch (err) { /* ignore */ }
            applyVideoFilter();
            showOverlay(spec.label, 1800);
            renderMenuView('effects');
          },
        }, h('span', {}, spec.label), curFilter === k ? h('span', {}, '✓') : null)),
        h('div', {
          class: `opt ${ambilightEnabled ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            ambilightEnabled = !ambilightEnabled;
            try { localStorage.setItem('vortex_ambilight', ambilightEnabled ? 'on' : 'off'); } catch (err) { /* ignore */ }
            renderMenuView('effects');
          },
        }, h('span', {}, '🌈 Ambilight Sahne Işığı'), h('span', {}, ambilightEnabled ? 'Açık' : 'Kapalı')),
        h('div', {
          class: `opt ${danmakuEnabled ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            danmakuEnabled = !danmakuEnabled;
            try { localStorage.setItem('vortex_danmaku', danmakuEnabled ? 'on' : 'off'); } catch (err) { /* ignore */ }
            renderMenuView('effects');
          },
        }, h('span', {}, '💬 Akan Sohbet (Danmaku)'), h('span', {}, danmakuEnabled ? 'Açık' : 'Kapalı')),
        h('div', {
          class: `opt ${duckOn ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            const next = !duckOn;
            if (typeof host.setAutoDuckEnabled === 'function') host.setAutoDuckEnabled(next);
            else { try { localStorage.setItem('vortex_voice_duck', next ? 'on' : 'off'); } catch (_) {} }
            renderMenuView('effects');
          },
        }, h('span', {}, '🎙️ Konuşurken Film Sesini Kıs'), h('span', {}, duckOn ? 'Açık' : 'Kapalı')),
        h('div', {
          class: `opt ${frame.dataset.fit === 'cover' ? 'on' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            toggleFitMode();
            renderMenuView('effects');
          },
        }, h('span', {}, '▭ Ekran Oranı (Sığdır / Doldur)'), h('span', {}, frame.dataset.fit === 'cover' ? 'Doldur' : 'Sığdır')),
        h('div', {
          class: 'opt',
          'data-native-gesture': '1',
          onclick: (e) => {
            e.stopPropagation();
            togglePiP();
          },
        }, h('span', {}, '🖼️ Pencere İçinde Pencere (PiP)')),
        ...(typeof window !== 'undefined' && (window.isWatchlivoDesktop || window.pywebview?.api) ? [
          h('div', {
            class: 'opt',
            onclick: async (e) => {
              e.stopPropagation();
              closeMenu();
              const res = await window.pywebview?.api?.toggle_always_on_top?.();
              showOverlay(res?.onTop ? '📌 Pencere Üstte Tut: Açık (F9)' : '📌 Pencere Üstte Tut: Kapalı', 2000);
            },
          }, h('span', {}, '📌 Pencereyi Üstte Tut (F9)')),
          h('div', {
            class: 'opt',
            onclick: async (e) => {
              e.stopPropagation();
              closeMenu();
              const res = await window.pywebview?.api?.toggle_mini_window?.();
              showOverlay(res?.mini ? '🗗 Masaüstü Mini Pencere: Açık (F10)' : '🗖 Standart Pencere Boyutu', 2000);
            },
          }, h('span', {}, '🗗 Masaüstü Mini Pencere Modu (F10)')),
        ] : []),
      );
      return;
    }

    const optIconLbl = (icName, txt) => h('span', { class: 'opt-lbl' }, ico(icName), txt);
    const listHead = h(
      'div',
      { class: 'ctl-menu-head' },
      h('span', { class: 'opt-lbl', style: { fontSize: '.86em', fontWeight: '800', color: '#fff', paddingLeft: '.2em' } }, ico('settings'), 'Oynatıcı Ayarları'),
      closeBtn(),
    );
    const scrollItems = [buildSlidersPanel()];
    const items = scrollItems;
    items.push(h('div', {
      class: 'opt',
      id: 'ctl-opt-pip',
      'data-native-gesture': '1',
      onclick: (e) => { e.stopPropagation(); togglePiP(); },
    },
      optIconLbl('pip', 'Pencere İçinde Pencere (PiP)'),
      h('span', { class: 'dim', style: { fontSize: '.85em' } }, (host.isPiP?.() || document.body.classList.contains('mesh-minimized')) ? 'Açık' : 'Aç ›')));
    const vMenuEl = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    const iosAvFs = vMenuEl && (vMenuEl.webkitEnterFullscreen || vMenuEl.webkitEnterFullScreen);
    if (typeof iosAvFs === 'function') {
      items.push(h('div', {
        class: 'opt',
        id: 'ctl-opt-ios-avfs',
        'data-native-gesture': '1',
        onclick: (e) => {
          e.stopPropagation();
          closeMenu();
          try {
            host.adapter?.subs?.syncNativeTrackToElement?.(vMenuEl, true);
            vMenuEl.addEventListener('webkitendfullscreen', onNativeFsChange, { once: true });
            iosAvFs.call(vMenuEl);
          } catch (_) {
            toast('Yerel tam ekran için videonun yüklenmesini bekleyin');
          }
        },
      },
        optIconLbl('fullscreen', '📱 iOS Yerel Tam Ekran (AVPlayer)'),
        h('span', { class: 'dim', style: { fontSize: '.85em' } }, 'Aç ›')));
    }
    if (host.adapter?.caps.subtitles || subTracks.length) {
      items.push(h('div', { class: 'opt', onclick: (e) => { e.stopPropagation(); renderMenuView('subtitle'); } },
        optIconLbl('subtitles', 'Altyazı (Subtitles)'),
        h('span', { class: 'dim', style: { fontSize: '.85em' } }, `${curSubObj ? curSubObj.label : 'Kapalı'} ›`)));
    }
    if (host.adapter?.caps.audioTracks || audioTracks.length) {
      items.push(h('div', { class: 'opt', onclick: (e) => { e.stopPropagation(); renderMenuView('audio'); } },
        optIconLbl('audioWave', 'Ses & Dublaj (Audio)'),
        h('span', { class: 'dim', style: { fontSize: '.85em' } }, `${curAudioObj ? curAudioObj.label.replace(/^[^\s]+\s/, '') : 'Orijinal'} ›`)));
    }
    if (!m.isMusic && !m.isLive && (rawServers.length > 0 || m.tmdbId)) {
      const srvIdx = curSrvObj ? (rawServers.indexOf(curSrvObj) + 1) : 1;
      items.push(h('div', { class: 'opt', onclick: (e) => { e.stopPropagation(); renderMenuView('servers'); } },
        optIconLbl('globe', 'Yayın Sunucusu (Kaynak)'),
        h('span', { class: 'dim', style: { fontSize: '.85em' } }, `Sunucu ${srvIdx} (${rawServers.length}) ›`)));
    }
    if (host.adapter?.caps.rate) {
      items.push(h('div', { class: 'opt', onclick: (e) => { e.stopPropagation(); renderMenuView('speed'); } },
        optIconLbl('speed', 'Oynatma Hızı'),
        h('span', { class: 'dim', style: { fontSize: '.85em' } }, `${rate}x ›`)));
    }
    items.push(h('div', { class: 'opt', onclick: (e) => { e.stopPropagation(); renderMenuView('quality'); } },
      optIconLbl('sparkle', 'Görüntü Kalitesi'),
      h('span', { class: 'dim', style: { fontSize: '.85em' } }, `${qualityBadge.textContent || '1080p'} ›`)));
    items.push(h('div', { class: 'opt', onclick: (e) => { e.stopPropagation(); renderMenuView('effects'); } },
      optIconLbl('sparkle', 'Sinema Efektleri & Araçlar'),
      h('span', { class: 'dim', style: { fontSize: '.85em' } }, `${(VIDEO_FILTERS[curFilter] || VIDEO_FILTERS.normal).label.replace(/^[^\s]+\s/, '').split(' ')[0]} ›`)));
    const bgAudioOn = localStorage.getItem('vortex_bg_audio') !== 'off';
    items.push(h('div', {
      class: `opt ${bgAudioOn ? 'on' : ''}`,
      id: 'ctl-opt-bgaudio',
      onclick: (e) => {
        e.stopPropagation();
        const nextBg = !bgAudioOn;
        try { localStorage.setItem('vortex_bg_audio', nextBg ? 'on' : 'off'); } catch (_) {}
        showOverlay(nextBg ? '📱 Kilit Ekranı & Arka Plan Oynatma: Açık' : '📱 Kilit Ekranı & Arka Plan Oynatma: Kapalı', 2000);
        renderMenuView('list');
      },
    },
      optIconLbl('volume', '📱 Kilit Ekranı & Arka Plan Oynatma'),
      h('span', { class: 'dim', style: { fontSize: '.85em' } }, bgAudioOn ? 'Açık ✓' : 'Kapalı')));
    const autoDuckOn = localStorage.getItem('vortex_voice_duck') !== 'off';
    items.push(h('div', {
      class: `opt ${autoDuckOn ? 'on' : ''}`,
      id: 'ctl-opt-autoduck',
      onclick: (e) => {
        e.stopPropagation();
        const nextDuck = !autoDuckOn;
        if (typeof host.setAutoDuckEnabled === 'function') host.setAutoDuckEnabled(nextDuck);
        else { try { localStorage.setItem('vortex_voice_duck', nextDuck ? 'on' : 'off'); } catch (_) {} }
        showOverlay(nextDuck ? '🔉 Akıllı Ses Kısma: Açık' : '🔉 Akıllı Ses Kısma: Kapalı', 1800);
        renderMenuView('list');
      },
    },
      optIconLbl('volume', 'Akıllı Ses Kısma (Konuşmada)'),
      h('span', { class: 'dim', style: { fontSize: '.85em' } }, autoDuckOn ? 'Açık ✓' : 'Kapalı')));
    if (isIosDevice && !host.canControlVolume?.()) {
      const mutedNow = isActuallyMuted();
      items.push(h('div', {
        class: `opt ${!mutedNow ? 'on' : ''}`,
        id: 'ctl-opt-ios-mute',
        onclick: (e) => {
          e.stopPropagation();
          if (mutedNow) doUnlockAudio();
          else { host.setMuted(true, true); update(); }
          renderMenuView('list');
        },
      },
        optIconLbl(mutedNow ? 'mute' : 'volume', mutedNow ? 'Sesi Aç (iOS Ses Kontrolü)' : 'Sesi Kapat / Sessize Al'),
        h('span', { class: 'dim', style: { fontSize: '.85em' } }, mutedNow ? 'Sessiz' : 'Açık ✓')));
    }
    items.push(h('div', {
      class: 'opt',
      id: 'ctl-opt-cast',
      'data-native-gesture': '1',
      onclick: (e) => { e.stopPropagation(); triggerCast(); },
    },
      optIconLbl('cast', "TV'ye Yansıt (AirPlay / Cast)"),
      h('span', { class: 'dim', style: { fontSize: '.85em' } }, host.canCast?.() ? 'Hazır ›' : 'Seç ›')));
    if (m.tmdbId) {
      const s = m.season || 1, e = m.episode || 1, isTv = m.mediaType === 'tv';
      if (isTv) {
        items.push(h('div', { class: 'opt', onclick: () => { closeMenu(); openEpisodeModal(); } }, optIconLbl('episodes', `Sezon / Bölüm Değiştir (S${s}:B${e})`)));
      }
      const prov = getProvider(m.catalogProvider || m.provider);
      if (prov?.homeUrl) {
        items.push(h('div', { class: 'opt', onclick: () => { closeMenu(); launchProviderWindow(prov.homeUrl, prov.name); } }, optIconLbl('externalLink', `${prov.name} Hesabım`)));
      }
    }
    menu.replaceChildren(listHead, h('div', { class: 'ctl-menu-scroll' }, ...scrollItems));
  }

  function isFullscreenActive() {
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      v?.webkitDisplayingFullscreen ||
      frame.classList.contains('fullscreen') ||
      document.body.classList.contains('vortex-fs')
    );
  }

  function syncVideoStageBounds(_forceReflow = false) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const ae = document.activeElement;
    const isInputFocused = Boolean(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    if (!isInputFocused) {
      document.body.classList.remove('kb-open', 'kb-chat-focus', 'kb-portrait');
      document.documentElement.style.setProperty('--vvh', '100%');
      document.documentElement.style.setProperty('--vv-top', '0px');
    }
    if (host.container) {
      host.container.style.width = '100%';
      host.container.style.height = '100%';
      host.container.style.maxHeight = '100%';
    }
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    if (v) {
      v.style.width = '100%';
      v.style.height = '100%';
      v.style.maxHeight = '100%';
      v.style.top = '0px';
      v.style.left = '0px';
      v.style.objectFit = frame.dataset.fit === 'cover' ? 'cover' : 'contain';
      v.style.objectPosition = 'center center';
      v.removeAttribute('width');
      v.removeAttribute('height');
    }
  }

  function onViewportChange() {
    lastLayoutShiftAt = Date.now();
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    const isInputFocused = Boolean(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    if (!isInputFocused && (isFullscreenActive() || window.scrollY > 2 || document.documentElement.scrollTop > 2)) {
      try {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      } catch (e) { /* ignore */ }
    }
    syncMenuPortal();
    syncVideoStageBounds(true);
    applySubPrefsStyle();
    host.adapter?.subs?.onTimeUpdate?.(position(), true);
    viewportTimers.forEach(clearTimeout);
    viewportTimers.clear();
    [50, 160, 420, 950].forEach((ms) => {
      const tid = setTimeout(() => {
        viewportTimers.delete(tid);
        syncVideoStageBounds(ms <= 200);
        applySubPrefsStyle();
        host.adapter?.subs?.onTimeUpdate?.(position(), true);
        const inPrev = (currentMenuView === 'subtitlePreferences' || currentMenuView === 'subtitle') && subCue.dataset.previewSample === '1';
        const curSub = host.adapter?.getSelectedSubtitleId?.() || 'off';
        if (inPrev || (curSub !== 'off' && subCue.textContent)) subOverlay.classList.remove('hidden');
        else subOverlay.classList.add('hidden');
      }, ms);
      viewportTimers.add(tid);
    });
  }

  const viewportTimers = new Set();
  let stageResizeObs = null;
  if (typeof ResizeObserver !== 'undefined') {
    stageResizeObs = new ResizeObserver(() => {
      syncVideoStageBounds(false);
    });
    stageResizeObs.observe(frame);
    setTimeout(() => {
      if (frame.parentElement && stageResizeObs) stageResizeObs.observe(frame.parentElement);
      syncVideoStageBounds(true);
    }, 0);
  }

  function onNativeFsChange() {
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    const nativeFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement || v?.webkitDisplayingFullscreen);
    if (!nativeFs && frame.dataset.fsMode === 'native') {
      frame.classList.remove('fullscreen');
      document.body.classList.remove('vortex-fs');
      frame.dataset.fsMode = '';
      frame.querySelector('.fs-chat-stack')?.remove();
      try { screen.orientation?.unlock?.(); } catch (_) {}
    }
    onViewportChange();
  }
  document.addEventListener('fullscreenchange', onNativeFsChange);
  document.addEventListener('webkitfullscreenchange', onNativeFsChange);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  function toggleFullscreen() {
    closeMenu();
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video):not(.wl-ios-pip-standby)');
    if (isFullscreenActive() || v?.webkitDisplayingFullscreen) {
      frame.classList.remove('fullscreen');
      document.body.classList.remove('vortex-fs');
      frame.dataset.fsMode = '';
      frame.querySelector('.fs-chat-stack')?.remove();
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
      if (v?.webkitDisplayingFullscreen) {
        try { (v.webkitExitFullscreen || v.webkitExitFullScreen)?.call(v); } catch (e) { /* ignore */ }
      }
      try { screen.orientation?.unlock?.(); } catch (e) { /* ignore */ }
      onViewportChange();
      revealControls(3200);
      return;
    }
    const reqFrameFs = frame.requestFullscreen || frame.webkitRequestFullscreen;
    const reqDocFs = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    const reqFs = reqFrameFs || reqDocFs;
    if (reqFs) {
      frame.classList.add('fullscreen');
      document.body.classList.add('vortex-fs');
      frame.dataset.fsMode = 'native';
      onViewportChange();
      revealControls(3200);
      const fsTarget = reqFrameFs ? frame : document.documentElement;
      Promise.resolve(reqFs.call(fsTarget)).then(() => {
        try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch (e) { /* ignore */ }
        onViewportChange();
      }).catch(() => {
        frame.dataset.fsMode = 'css';
        onViewportChange();
      });
      return;
    }
    const iosNativeFs = v && (v.webkitEnterFullscreen || v.webkitEnterFullScreen);
    if (typeof iosNativeFs === 'function' && v.readyState >= 1 && v.videoWidth > 0) {
      try {
        host.adapter?.subs?.syncNativeTrackToElement?.(v, true);
        frame.dataset.fsMode = 'native';
        v.addEventListener('webkitendfullscreen', onNativeFsChange, { once: true });
        iosNativeFs.call(v);
        return;
      } catch (e) { /* fallback to CSS fullscreen */ }
    }
    frame.classList.add('fullscreen');
    document.body.classList.add('vortex-fs');
    frame.dataset.fsMode = 'css';
    try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch (e) { /* ignore */ }
    onViewportChange();
    revealControls(3200);
  }

  let lastMediaSessionKey = '';
  let lastMediaPosSyncAt = 0;
  let lastDesktopRpcAt = 0;
  let lastDesktopRpcKey = '';

  function syncDesktopPresence(m, prov, playing) {
    if (typeof window === 'undefined' || !window.pywebview?.api?.update_presence) return;
    const now = Date.now();
    const pCount = Array.isArray(state.mesh?.participants) ? state.mesh.participants.length : 1;
    const roomName = state.mesh?.name || 'Sinema Odası';
    const titleStr = m?.title
      ? `${m.mediaType === 'tv' ? '📺' : m.isMusic ? '🎵' : '🎬'} ${m.title}`
      : 'Watchlivo — Birlikte İzle';
    const stateStr = m?.title
      ? `${playing ? '▶ İzliyor' : '⏸ Duraklatıldı'} · 👥 ${pCount} Kişi (${roomName})`
      : `Lobide · 👥 ${pCount} Kişi (${roomName})`;
    const rpcKey = `${titleStr}|${stateStr}|${playing}`;
    if (rpcKey === lastDesktopRpcKey && now - lastDesktopRpcAt < 12000) return;
    lastDesktopRpcKey = rpcKey;
    lastDesktopRpcAt = now;
    const d = duration();
    const p = position();
    const nowSec = Math.floor(now / 1000);
    const startTs = (playing && p >= 0) ? Math.max(0, nowSec - Math.floor(p)) : null;
    const endTs = (playing && d > 0 && d > p) ? (nowSec + Math.floor(d - p)) : null;
    try {
      window.pywebview.api.update_presence({
        details: titleStr,
        state: stateStr,
        startTs,
        endTs,
      });
    } catch (e) { /* ignore */ }
  }

  function updateMediaSessionPositionImmediate(posOverride = null, rateOverride = null) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof navigator.mediaSession?.setPositionState !== 'function') return;
    try {
      const d = duration();
      const p = Number.isFinite(posOverride) ? Number(posOverride) : position();
      const r = Number(rateOverride || state.mesh?.media?.meshStatePlaybackSpeed || host.adapter?.getRate?.() || 1);
      if (d > 0 && Number.isFinite(d) && Number.isFinite(p)) {
        lastMediaPosSyncAt = Date.now();
        navigator.mediaSession.setPositionState({
          duration: d,
          playbackRate: r > 0 ? r : 1,
          position: Math.max(0, Math.min(d, p)),
        });
      }
    } catch (e) { /* ignore */ }
  }

  let mediaSessionHandlersBound = false;
  function bindMediaSessionHandlers() {
    if (mediaSessionHandlersBound || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    mediaSessionHandlersBound = true;
    const ms = navigator.mediaSession;
    const safeHandler = (act, fn) => { try { ms.setActionHandler(act, fn); } catch (e) { /* ignore */ } };
    safeHandler('play', () => {
      ensureIosPlaybackAudioSession();
      resumeSharedAudioContext();
      if (host.adapter) host.adapter._userPausedViaMediaSession = false;
      if (isLeader()) {
        if (actions.play) actions.play();
        else actions.toggle?.();
      } else {
        const exp = expectedPosition(state.mesh?.media);
        if (Number.isFinite(exp) && exp > 0.5 && Math.abs((position() || 0) - exp) > 2.2) {
          host.adapter?.seek?.(exp);
        }
        host.adapter?.play?.();
      }
      ms.playbackState = 'playing';
      updateMediaSessionPositionImmediate();
    });
    safeHandler('pause', () => {
      if (host.adapter) host.adapter._userPausedViaMediaSession = true;
      if (isLeader()) {
        if (actions.pause) actions.pause();
        else actions.toggle?.();
      } else {
        host.adapter?.pause?.();
      }
      ms.playbackState = 'paused';
      updateMediaSessionPositionImmediate();
    });
    safeHandler('stop', () => {
      if (host.adapter) host.adapter._userPausedViaMediaSession = true;
      if (isLeader() && actions.pause) actions.pause();
      else host.adapter?.pause?.();
      ms.playbackState = 'paused';
    });
    safeHandler('seekbackward', (details) => {
      const off = Math.max(1, Number(details?.seekOffset || 10));
      const target = Math.max(0, position() - off);
      if (isLeader()) seekStep(-off);
      else host.adapter?.seek?.(target);
      updateMediaSessionPositionImmediate(target);
    });
    safeHandler('seekforward', (details) => {
      const off = Math.max(1, Number(details?.seekOffset || 10));
      const d = duration();
      const target = d > 0 ? Math.min(d, position() + off) : (position() + off);
      if (isLeader()) seekStep(off);
      else host.adapter?.seek?.(target);
      updateMediaSessionPositionImmediate(target);
    });
    safeHandler('seekto', (details) => {
      if (!Number.isFinite(details?.seekTime)) return;
      const target = Math.max(0, Number(details.seekTime));
      if (isLeader()) actions.seek(target);
      else host.adapter?.seek?.(target);
      updateMediaSessionPositionImmediate(target);
    });
    safeHandler('previoustrack', () => {
      const curM = state.mesh?.media;
      if (position() > 15) {
        if (isLeader()) actions.seek(0);
        else host.adapter?.seek?.(0);
        updateMediaSessionPositionImmediate(0);
        return;
      }
      if ((isLeader() || canSelectVideo()) && curM?.mediaType === 'tv') {
        triggerPrevEpisode(true);
      }
    });
    safeHandler('nexttrack', () => {
      const curM = state.mesh?.media;
      if ((isLeader() || canSelectVideo()) && curM?.mediaType === 'tv') {
        triggerNextEpisode(true);
      } else if (isLeader() && (state.mesh?.queue || []).length) {
        actions.skip();
      } else if (isLeader()) {
        seekStep(10);
      }
    });
    safeHandler('enterpictureinpicture', async () => {
      try {
        if (host.enterPiP) await host.enterPiP();
        else if (!host.isPiP?.()) await host.togglePiP?.();
        update();
      } catch (e) { /* ignore */ }
    });
  }

  const controlsBgTickListener = () => {
    const mBg = state.mesh?.media;
    if (!mBg) return;
    updateMediaSessionPositionImmediate();
    const curP = position();
    const curD = duration();
    if (!state.mesh?.curated && !mBg.isMusic && !mBg.live && curP > 12 && Date.now() - lastProgressSavedAt > 12000) {
      lastProgressSavedAt = Date.now();
      saveWatchProgress({ ...mBg, poster: mBg.poster || thumbFor(mBg) || mBg.thumbnail || '' }, curP, curD);
    }
  };
  if (typeof window !== 'undefined') {
    if (!(window.__watchlivoBgTickListeners instanceof Set)) {
      window.__watchlivoBgTickListeners = new Set();
    }
    window.__watchlivoBgTickListeners.add(controlsBgTickListener);
    window.__watchlivoBgSyncTick = () => {
      for (const fn of Array.from(window.__watchlivoBgTickListeners || [])) {
        try { fn(); } catch (_) {}
      }
    };
  }

  function syncMediaSession(m, prov, thumbUrl, playing, curRate) {
    syncDesktopPresence(m, prov, playing);
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      bindMediaSessionHandlers();
      const ms = navigator.mediaSession;
      const rawPoster = String(m?.poster || thumbUrl || m?.thumbnail || '').trim();
      const pCount = Array.isArray(state.mesh?.participants) ? state.mesh.participants.length : 1;
      const roomLabel = state.mesh?.name || 'Sinema Odası';
      const sNum = Number(m?.season || 0);
      const eNum = Number(m?.episode || 0);
      const baseTitle = String(m?.title || 'Watchlivo').trim();
      const displayTitle = (m?.mediaType === 'tv' && sNum >= 1 && eNum >= 1 && !/Sezon|S\d+:B\d+/i.test(baseTitle))
        ? `${baseTitle} · ${sNum}. Sezon ${eNum}. Bölüm`
        : baseTitle;
      const displayArtist = `${prov?.name || m?.channel || 'Watchlivo'}${roomLabel ? ` · 🍿 ${roomLabel}` : ''}`;
      const displayAlbum = `Watchlivo · Birlikte İzle (${pCount} Kişi)`;
      const metaKey = `${displayTitle}|${displayArtist}|${displayAlbum}|${rawPoster}`;
      if (metaKey !== lastMediaSessionKey) {
        lastMediaSessionKey = metaKey;
        const artworkList = [];
        if (rawPoster && !rawPoster.startsWith('data:')) {
          const proxiedPoster = /^https?:\/\//i.test(rawPoster) && !rawPoster.startsWith(window.location.origin)
            ? `${window.location.origin}/api/rave/poster?url=${encodeURIComponent(rawPoster)}`
            : new URL(rawPoster, window.location.origin).href;
          artworkList.push(
            { src: proxiedPoster, sizes: '96x96' },
            { src: proxiedPoster, sizes: '192x192' },
            { src: proxiedPoster, sizes: '256x256' },
            { src: proxiedPoster, sizes: '384x384' },
            { src: proxiedPoster, sizes: '512x512' },
          );
        }
        artworkList.push(
          { src: `${window.location.origin}/static/watchlivo-icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${window.location.origin}/static/watchlivo-icon-512.png`, sizes: '512x512', type: 'image/png' },
        );
        ms.metadata = new MediaMetadata({
          title: displayTitle,
          artist: displayArtist,
          album: displayAlbum,
          artwork: artworkList,
        });
      }
      ms.playbackState = playing ? 'playing' : 'paused';
      const now = Date.now();
      if (now - lastMediaPosSyncAt > 1800) {
        updateMediaSessionPositionImmediate(null, curRate);
      }
    } catch (e) { /* ignore */ }
  }

  let lastStatus = '';
  function update() {
    const m = state.mesh?.media;
    const has = !!(m && (m.url || m.videoId));
    miniTitle.textContent = m?.title || state.mesh?.name || 'Canlı Oda';
    if (!state.mesh) {
      empty.classList.add('hidden');
      loading.classList.remove('hidden');
      controls.classList.add('hidden');
      return;
    }
    empty.classList.toggle('hidden', has);
    controls.classList.toggle('hidden', !has);
    if (!has) {
      loading.classList.add('hidden');
      errorBox.classList.add('hidden');
      unmute.classList.add('hidden');
      subOverlay.classList.add('hidden');
      castBtn.classList.add('hidden');
      castBtn.style.display = 'none';
      return;
    }
    updateUnmuteVisibility();
    const prov = getProvider(m.catalogProvider || m.provider);
    const t = thumbFor(m);
    if (thumb.getAttribute('src') !== t) thumb.src = t || '/static/watchlivo-logo.svg';
    const backdropImg = m.backdrop || m.backdropUrl || t;
    const bgUrl = backdropImg ? `url("${backdropImg}")` : 'none';
    if (stageBackdrop.style.backgroundImage !== bgUrl) stageBackdrop.style.backgroundImage = bgUrl;
    stageBackdrop.classList.toggle('is-hero-cover', false);
    if (!syncText.textContent) syncText.textContent = '0ms · Senkron';
    title.textContent = m.title || 'Video';
    artist.textContent = m.channel || prov?.name || '';
    provLogo.src = prov?.logo || ''; provLogo.style.display = prov?.logo ? '' : 'none';
    const parsedTitleEp = String(m.title || '').match(/S(\d+)\s*:\s*B(\d+)|(\d+)\.\s*Sezon\s*(\d+)\.\s*Bölüm/i);
    const curSeasonNum = Number(m.season || parsedTitleEp?.[1] || parsedTitleEp?.[3] || 0);
    const curEpNum = Number(m.episode || parsedTitleEp?.[2] || parsedTitleEp?.[4] || 0);
    const isMovie = m.mediaType === 'movie' || /Tam Film/i.test(String(m.channel || ''));
    const isSeries = !isMovie && Boolean(m.mediaType === 'tv' || parsedTitleEp);
    breakTopBtn.classList.toggle('hidden', !has);
    epBtn.classList.toggle('hidden', !isSeries);
    const sNum = curSeasonNum || 1;
    const eNum = curEpNum || 1;
    if (isSeries && !m.episodeCount && !(Array.isArray(m.seasonsMeta) && m.seasonsMeta.length) && (m.tmdbId || m.seriesTitle || m.title)) {
      const hydKey = `${m.tmdbId || m.seriesTitle || m.title}:${sNum}`;
      if (typeof window !== 'undefined') {
        window.__wlSeasonsHydrated = window.__wlSeasonsHydrated || {};
        const cachedHyd = window.__wlSeasonsHydrated[hydKey];
        if (cachedHyd && cachedHyd !== 'pending') {
          m.episodeCount = cachedHyd.episodeCount || 0;
          m.totalSeasons = cachedHyd.totalSeasons || 0;
          m.seasonsMeta = cachedHyd.seasonsMeta || [];
        } else if (!cachedHyd) {
          window.__wlSeasonsHydrated[hydKey] = 'pending';
          const q = new URLSearchParams({
            tmdbId: /^\d+$/.test(String(m.tmdbId || '')) ? String(m.tmdbId) : '',
            title: String(m.seriesTitle || m.originalTitle || m.title || '').replace(/\s*[—–-]\s*\d+\.\s*Sezon.*$/i, '').trim(),
            mediaType: 'tv',
            season: String(sNum),
            v: '20261114_v210',
          });
          fetch(`/api/rave/seasons?${q.toString()}`, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((inf) => {
              if (inf && (Array.isArray(inf.episodes) || Array.isArray(inf.seasons))) {
                const payload = {
                  episodeCount: Array.isArray(inf.episodes) ? inf.episodes.length : 0,
                  totalSeasons: Array.isArray(inf.seasons) ? inf.seasons.length : 0,
                  seasonsMeta: Array.isArray(inf.seasons)
                    ? inf.seasons.map((sx) => ({ season: Number(sx.season || sx.season_number || 0), episodeCount: Number(sx.count || sx.episodeCount || sx.episode_count || 0) }))
                    : [],
                };
                window.__wlSeasonsHydrated[hydKey] = payload;
                if (state.mesh?.media) {
                  state.mesh.media.episodeCount = payload.episodeCount || state.mesh.media.episodeCount || 0;
                  state.mesh.media.totalSeasons = payload.totalSeasons || state.mesh.media.totalSeasons || 0;
                  state.mesh.media.seasonsMeta = payload.seasonsMeta.length ? payload.seasonsMeta : (state.mesh.media.seasonsMeta || []);
                  update();
                }
              } else {
                delete window.__wlSeasonsHydrated[hydKey];
              }
            })
            .catch(() => {
              delete window.__wlSeasonsHydrated[hydKey];
            });
        }
      }
    }
    const prevSpecTop = isSeries ? computePrevEpSpec(m, sNum, eNum) : null;
    const nextSpecTop = isSeries ? computeNextEpSpec(m, sNum, eNum) : null;
    prevEpTopBtn.classList.toggle('hidden', !isSeries || Boolean(prevSpecTop?.isPremiere) || (!isLeader() && !canSelectVideo()));
    nextEpTopBtn.classList.toggle('hidden', !isSeries || Boolean(nextSpecTop?.isFinale) || (!isLeader() && !canSelectVideo()));
    if (isSeries) {
      const prevSig = prevSpecTop?.shortSig || (eNum > 1 ? `B${eNum - 1}` : `S${Math.max(1, sNum - 1)}`);
      if (prevEpTopBtn.dataset.sig !== prevSig) {
        prevEpTopBtn.dataset.sig = prevSig;
        prevEpTopBtn.replaceChildren('⏮ ', prevSig);
      }
      const epSig = `S${sNum}:B${eNum}`;
      if (epBtn.dataset.sig !== epSig) {
        epBtn.dataset.sig = epSig;
        epBtn.replaceChildren(ico('episodes'), epSig);
      }
      const nextSig = nextSpecTop?.shortSig || `B${eNum + 1}`;
      if (nextEpTopBtn.dataset.sig !== nextSig) {
        nextEpTopBtn.dataset.sig = nextSig;
        nextEpTopBtn.replaceChildren(ico('skip'), nextSig);
      }
    }
    const vEl = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
    const vw = vEl?.videoWidth || 0;
    const vh = vEl?.videoHeight || 0;
    const effW = Math.max(vw, Math.round(vh * 16 / 9));
    const lockedQ = String(host.adapter?._lockedQuality || localStorage.getItem('watchlivo_quality_lock') || '').toLowerCase();
    const availRes = host.adapter?._knownAvailableResolutions;
    if (vw > 0 && vh > 0) {
      // Honest ground-truth badge: always reflect actual decoded video frame pixels
      qualityBadge.textContent = effW >= 3200 ? '4K' : effW >= 2400 ? '2K' : effW >= 1700 ? '1080p' : effW >= 1100 ? '720p' : effW >= 750 ? '480p' : `${vh}p`;
    } else if (lockedQ && lockedQ !== 'auto') {
      if ((lockedQ === '2160' || lockedQ === '4k') && (!availRes || !availRes.has('2160'))) {
        qualityBadge.textContent = '1080p';
      } else if ((lockedQ === '1440' || lockedQ === '2k') && (!availRes || !availRes.has('1440'))) {
        qualityBadge.textContent = '1080p';
      } else {
        qualityBadge.textContent = (lockedQ === '2160' || lockedQ === '4k') ? '4K' : ((lockedQ === '1440' || lockedQ === '2k') ? '2K' : `${lockedQ}p`);
      }
    } else {
      qualityBadge.textContent = '1080p';
    }
    if (qualityBadge.textContent === '4K') {
      artist.textContent = artist.textContent.replace(/(?:4K Ultra HD|4K UHD|1080p HD|720p HD)/, '4K Ultra HD');
    } else if (qualityBadge.textContent === '1080p') {
      artist.textContent = artist.textContent.replace(/(?:4K Ultra HD|4K UHD|720p HD)/, '1080p HD');
    } else if (qualityBadge.textContent === '720p' && artist.textContent.includes('1080p HD')) {
      artist.textContent = artist.textContent.replace('1080p HD', '720p HD');
    }
    const curRate = Number(m.meshStatePlaybackSpeed || host.adapter?.getRate?.() || 1);
    speedBtn.querySelector('span').textContent = `${curRate}x`;
    const availSubs = host.adapter?.getSubtitleTracks?.() || m.subtitleTracks || [];
    const hasSubsOrDub = !!(
      !m.isMusic && (
        host.adapter?.caps?.subtitles ||
        m.tmdbId ||
        m.imdbId ||
        m.id ||
        m.title ||
        m.videoId ||
        m.provider === 'youtube' ||
        availSubs.length
      )
    );
    subPillBtn.classList.toggle('hidden', !hasSubsOrDub);
    subBtn.style.display = hasSubsOrDub ? '' : 'none';
    if (hasSubsOrDub) {
      const rawSId = host.adapter?.getSelectedSubtitleId?.() || 'off';
      const sId = availSubs.length ? rawSId : 'off';
      const aId = host.adapter?.getSelectedAudioId?.() || 'orig';
      const subTag = !availSubs.length ? 'Altyazı' : (sId !== 'off' ? sId.toUpperCase().replace(/^YT-/, '').split('-')[0] : 'Kapalı');
      let subSig = 'Altyazı & Ses';
      const curAudTrack = host.adapter?.getAudioTracks?.()?.find?.((t) => t.id === aId);
      const isTrDubId = aId === 'tr' || aId === 'tr-dub' || String(aId || '').startsWith('tr-dub') || aId === 'tr-orig'
        || (curAudTrack && (curAudTrack.targetLang === 'tr' || curAudTrack.audioLang === 'tr' || curAudTrack.lang === 'tr'));
      if (isTrDubId) {
        subSig = (sId && sId !== 'off') ? `🇹🇷 TR Dublaj · ${sId.toUpperCase().slice(0, 2)} Alt` : '🇹🇷 TR Dublaj';
      } else if (aId === 'orig' || String(aId || '').startsWith('orig') || aId === 'en' || aId === 'en-orig') {
        subSig = (sId && sId !== 'off') ? `🎬 Orijinal · ${sId.toUpperCase().slice(0, 2)} Alt` : '🎬 Orijinal Ses';
      } else {
        const dubTag = (aId === 'tr-ai-dub' || aId === 'ai-tr') ? '🤖 AI Ses' : (aId === 'en-dub' ? 'EN Dublaj' : ((aId === 'en-ai-dub' || aId === 'ai-en') ? '🤖 EN AI' : 'Orijinal'));
        subSig = `${subTag} · ${dubTag}`;
      }
      if (subPillBtn.dataset.sig !== subSig) {
        subPillBtn.dataset.sig = subSig;
        subPillBtn.replaceChildren(ico('subtitles'), subSig);
      }
      subBtn.classList.toggle('active-sub', sId !== 'off' || aId !== 'orig');
    }
    const hasOrig = !!(m.officialUrl || m.catalogProvider);
    origBtn.classList.toggle('hidden', !hasOrig);
    if (hasOrig) {
      const origSig = formatOpenInProvider(prov?.name || 'Orijinal');
      if (origBtn.dataset.sig !== origSig) {
        origBtn.dataset.sig = origSig;
        origBtn.replaceChildren(ico('externalLink'), origSig);
      }
    }
    const roomPlaying = isRoomMediaPlaying(m);
    const startupGrace = Boolean(host.adapter?.loadedAtMs && Date.now() - host.adapter.loadedAtMs < 3600 && !ctx.userPaused && !host.autoplayBlocked);
    const rawLocalPaused = Boolean(
      host.adapter
      && !host.loading
      && !startupGrace
      && host.adapter.isPaused?.()
      && !host.adapter.isBuffering?.()
      && !host.adapter.video?.seeking
      && (host.adapter.video ? host.adapter.video.readyState >= 2 : true)
    );
    if (!rawLocalPaused || !roomPlaying) {
      localPauseSince = 0;
    } else if (!localPauseSince) {
      localPauseSince = Date.now();
    }
    const localPaused = Boolean(
      (host.adapter && (host.autoplayBlocked || host.adapter.autoplayHardBlocked) && host.adapter.isPaused?.())
      || (
        rawLocalPaused
        && !host.adapter?.wantPlaying
        && (!roomPlaying || host.autoplayBlocked || (localPauseSince > 0 && Date.now() - localPauseSince >= 550))
      )
    );
    const playing = roomPlaying && !localPaused;
    const embedOnly = host.adapter && !host.adapter.caps.overlayClicks;
    const keepControlsShown = (!playing || Boolean(host.loading) || Boolean(host.adapter?.video?.paused)) && !embedOnly;
    controls.classList.toggle('show', keepControlsShown);
    const playIconName = playing ? 'pause' : 'play';
    if (playBtn.dataset.sig !== playIconName) {
      playBtn.dataset.sig = playIconName;
      playBtn.replaceChildren(ico(playIconName));
    }
    if (centerPlayBtn.dataset.sig !== playIconName) {
      centerPlayBtn.dataset.sig = playIconName;
      centerPlayBtn.replaceChildren(ico(playIconName));
    }
    const showCenterHud = !playing;
    centerPlayBtn.classList.toggle('is-paused', showCenterHud);
    centerHud.classList.toggle('is-paused', showCenterHud);
    centerHud.classList.toggle('viewer-playing-hidden', Boolean(!isLeader() && playing));
    theaterBtn.classList.toggle('on', Boolean(ctx.isTheaterMode?.()));
    const canShowPip = Boolean(has);
    const canShowCast = Boolean(host.adapter && host.canCast?.());
    castBtn.classList.toggle('hidden', !canShowCast);
    castBtn.style.display = canShowCast ? '' : 'none';
    pipBtn.classList.toggle('on', Boolean(host.isPiP?.() || document.body.classList.contains('mesh-minimized')));
    pipBtn.classList.toggle('hidden', !canShowPip);
    pipBtn.style.display = canShowPip ? '' : 'none';
    const volIconName = isActuallyMuted() ? 'mute' : 'volume';
    if (volBtn.dataset.sig !== volIconName) {
      volBtn.dataset.sig = volIconName;
      volBtn.replaceChildren(ico(volIconName));
    }
    volRange.value = String(isActuallyMuted() ? 0 : Math.max(0, Math.min(200, Number(host.volume ?? 80))));
    const voiceActiveNow = Boolean(ctx.voice?.inCall || ctx.voice?.micOn || ctx.voice?.camOn || ctx.voice?.screenOn);
    miniMicBtn.classList.toggle('hidden', !voiceActiveNow);
    if (voiceActiveNow) {
      miniMicBtn.textContent = ctx.voice?.micOn ? '🎙️' : '🔇';
      miniMicBtn.classList.toggle('on', Boolean(ctx.voice?.micOn));
    }
    const canSeek = !host.adapter || !!host.adapter.caps.seek;
    const leader = isLeader();
    back10Btn.classList.toggle('locked', !leader);
    back10Btn.classList.toggle('disabled-control', !leader);
    fwd10Btn.classList.toggle('locked', !leader);
    fwd10Btn.classList.toggle('disabled-control', !leader);
    centerBack10Btn.classList.toggle('locked', !leader);
    centerBack10Btn.classList.toggle('disabled-control', !leader);
    centerFwd10Btn.classList.toggle('locked', !leader);
    centerFwd10Btn.classList.toggle('disabled-control', !leader);
    if (!leader) {
      back10Btn.setAttribute('data-tip', 'Videoyu yalnızca oda başkanı sarabilir');
      fwd10Btn.setAttribute('data-tip', 'Videoyu yalnızca oda başkanı sarabilir');
    } else {
      back10Btn.setAttribute('data-tip', '10 sn geri');
      fwd10Btn.setAttribute('data-tip', '10 sn ileri');
    }
    playBtn.style.display = canSeek ? '' : 'none';
    timeline.style.visibility = canSeek ? 'visible' : 'hidden';
    timeline.classList.toggle('locked', !leader || !canSeek);
    mid.style.pointerEvents = embedOnly ? 'none' : 'auto';
    controls.classList.toggle('passthrough-mid', !!embedOnly);
    const hudVisibleNow = controls.classList.contains('show') || controls.classList.contains('ui-active');
    embedTouchHudBtn.classList.toggle('hidden', !(embedOnly && has && !hudVisibleNow));
    const status = `${m.meshStateStatus}|${m.lastActionBy || ''}`;
    if (status !== lastStatus) {
      lastStatus = status;
      if (!playing && m.lastActionBy) showOverlay(`${m.lastActionBy} tarafından duraklatıldı`, 2800);
      else hideOverlay();
    }
    skipBtn.style.display = (state.mesh?.queue || []).length ? '' : 'none';
    gearBtn.style.display = has ? '' : 'none';
    renderCinemaSeats();
    syncMediaSession(m, prov, t, playing, curRate);
  }

  let overlayTimer = null;
  function showOverlay(text, ms = 2500) {
    overlayMsg.textContent = text; overlayMsg.classList.remove('hidden');
    clearTimeout(overlayTimer);
    if (ms) overlayTimer = setTimeout(hideOverlay, ms);
  }
  function hideOverlay() { overlayMsg.classList.add('hidden'); }

  return {
    update,
    showBreakSentOverlay: () => {
      showOverlay('☕ Mola Zamanı — Duraklatma isteği oda kurucusuna gönderildi', 3200);
    },
    showBreakRequestBanner: (userName) => {
      const sender = String(userName || 'Bir izleyici').trim();
      breakBannerText.textContent = `☕ ${sender} Mola Zamanı (duraklatma isteği) gönderdi!`;
      breakBanner.classList.remove('hidden');
      clearTimeout(breakBannerTimer);
      breakBannerTimer = setTimeout(() => {
        breakBanner.classList.add('hidden');
      }, 12000);
    },
    destroy: () => {
      if (state.mesh?.media && !state.mesh?.curated && !state.mesh.media.isMusic && !state.mesh.media.live && !(host.adapter?.initialSeekPending > 3) && smoothPos > 12) {
        saveWatchProgress({ ...state.mesh.media, poster: state.mesh.media.poster || thumbFor(state.mesh.media) || state.mesh.media.thumbnail || '' }, smoothPos, duration(), { forceCloud: true });
      }
      clearInterval(tickTimer);
      clearTimeout(uiTimer);
      clearTimeout(breakBannerTimer);
      clearTimeout(overlayTimer);
      clearTimeout(tapTimer);
      clearTimeout(rippleTimer);
      clearTimeout(desktopClickTimer);
      for (const tid of viewportTimers) clearTimeout(tid);
      viewportTimers.clear();
      closeMenu();
      if (typeof window !== 'undefined' && window.__watchlivoBgTickListeners instanceof Set) {
        window.__watchlivoBgTickListeners.delete(controlsBgTickListener);
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        for (const act of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'enterpictureinpicture']) {
          try { ms.setActionHandler(act, null); } catch (_) {}
        }
        try { ms.playbackState = 'none'; ms.metadata = null; } catch (_) {}
      }
      if (typeof document !== 'undefined') {
        if (document.fullscreenElement) {
          try { document.exitFullscreen?.().catch?.(() => {}); } catch (_) {}
        } else if (document.webkitFullscreenElement) {
          try { document.webkitExitFullscreen?.(); } catch (_) {}
        }
      }
      try { screen.orientation?.unlock?.(); } catch (_) {}
      try { stageResizeObs?.disconnect?.(); } catch (e) { /* ignore */ }
      if (typeof document !== 'undefined') {
        document.removeEventListener('pointerdown', onDocMenuOutside);
        document.removeEventListener('focusin', onDocMenuOutside);
      }
      menuBackdrop.remove();
      menu.remove();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('touchstart', onGlobalTouchStamp, { capture: true });
      window.removeEventListener('touchend', onGlobalTouchStamp, { capture: true });
      document.removeEventListener('fullscreenchange', onNativeFsChange);
      document.removeEventListener('webkitfullscreenchange', onNativeFsChange);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      document.body.classList.remove('vortex-fs');
      if (typeof window !== 'undefined') window.__wlSyncViewport?.();
    },
    danmaku: (msg) => {
      if (!msg || msg.system || (!msg.text && !msg.gif)) return;
      const inFs = isFullscreenActive();
      if (inFs) {
        let fsStack = frame.querySelector('.fs-chat-stack');
        if (!fsStack) {
          fsStack = h('div', { class: 'fs-chat-stack' });
          frame.append(fsStack);
        }
        while (fsStack.childElementCount >= 4) {
          fsStack.firstElementChild?.remove();
        }
        const pill = h('div', { class: 'fs-chat-pill' },
          h('b', { style: { color: msg.color || '#27DCC8' } }, `${msg.user || 'İzleyici'}: `),
          h('span', {}, msg.text || 'GIF Gönderdi'));
        fsStack.append(pill);
        setTimeout(() => pill.remove(), 5500);
      }
      if (!danmakuEnabled) return;
      if (!msg.text) return;
      while (danmakuLayer.childElementCount >= 20) {
        danmakuLayer.firstElementChild?.remove();
      }
      const item = h('div', {
        class: 'danmaku-item',
        style: { top: `${8 + Math.floor(Math.random() * 58)}%`, color: '#ffffff' },
      }, `${msg.user ? msg.user + ': ' : ''}${msg.text}`);
      danmakuLayer.append(item);
      setTimeout(() => item.remove(), 12000);
    },
    syncStatus: (s) => {
      const ms = Math.round((s.delta || 0) * 1000);
      syncDot.style.background = s.mode === 'inSync' || s.mode === 'paused' || s.mode === 'live' || s.mode === 'embed'
        ? '#27DCC8'
        : s.mode === 'buffering' || Math.abs(ms) < 400
          ? '#f59e0b'
          : '#ff3b5c';
      syncText.textContent = s.mode === 'idle' || s.mode === 'live' || s.mode === 'embed'
        ? 'Senkron'
        : s.mode === 'buffering'
          ? `${ms >= 0 ? '+' : ''}${Math.round(ms / 1000)}sn · Önbellek`
          : `${ms >= 0 ? '+' : ''}${ms}ms · Senkron`;
      frame.dataset.syncMode = s.mode;
      frame.dataset.syncDelta = String(ms);
    },
    playerEvent: (ev, arg) => {
      if (ev === 'subtitle-cue') {
        const curSub = host.adapter?.getSelectedSubtitleId?.() || 'off';
        const primaryTxt = curSub === 'off' ? '' : (typeof arg === 'object' ? (arg?.primary || '') : (arg || ''));
        subCue.textContent = primaryTxt;
        dualCue.textContent = '';
        dualCue.classList.add('hidden');
        subOverlay.classList.toggle('hidden', !primaryTxt || curSub === 'off');
        return;
      }
      if (ev === 'pip-change') {
        pipBtn.classList.toggle('on', Boolean(arg));
        return;
      }
      if (ev === 'tracks-changed') {
        if (!menu.classList.contains('hidden')) renderMenuView(currentMenuView);
        update();
        return;
      }
      const mCur = state.mesh?.media;
      const mRevealKey = mCur ? `${mCur.tmdbId || mCur.id || mCur.videoId || mCur.title || ''}:${mCur.season || 0}:${mCur.episode || 0}` : '';
      if (ev === 'loading' || (ev === 'buffering' && arg)) {
        loading.classList.remove('hidden');
        if (ev === 'loading' && mRevealKey && mRevealKey !== lastRevealedMediaKey) {
          lastRevealedMediaKey = mRevealKey;
          revealControls(3200);
        }
      } else if (ev === 'ready' || ev === 'play' || (ev === 'buffering' && !arg) || ev === 'loaded') {
        loading.classList.add('hidden');
        errorBox.classList.add('hidden');
        applyVideoFilter();
        syncVideoStageBounds(true);
        host.adapter?.subs?.onTimeUpdate?.(position(), true);
        if ((ev === 'ready' || ev === 'loaded') && mRevealKey && mRevealKey !== lastRevealedMediaKey) {
          lastRevealedMediaKey = mRevealKey;
          revealControls(3000);
        }
      }
      if (ev === 'ended' && state.mesh?.media?.mediaType === 'tv' && isLeader()) {
        const m = state.mesh.media;
        const curS = Number(m.season || 1);
        const curE = Number(m.episode || 1);
        if (cancelledNextEpKey !== `${m.tmdbId || m.id || m.title}_${curS}_${curE}`) {
          triggerNextEpisode();
        }
      }
      if (ev === 'unmuted') unmute.classList.add('hidden');
      if (ev === 'autoplay-blocked') unmute.classList.remove('hidden');
      if (ev === 'error') {
        const mErr = state.mesh?.media;
        const canRefresh = Boolean(mErr && !mErr.isMusic && !mErr.live && (mErr.tmdbId || mErr.imdbId || mErr.title));
        fill(
          errorBox,
          h('b', {}, 'Oynatıcı hatası'),
          h('div', { class: 'dim' }, arg || ''),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '6px' } },
            canRefresh ? h('button', { class: 'btn primary', onclick: () => refreshCurrentStreamSources() }, '🔄 Yayını Yenile') : null,
            canSelectVideo() ? h('button', { class: 'btn', onclick: () => { setView('left', 'Search'); ctx.layout.update(); } }, 'Başka video seç') : null,
          ),
        );
        errorBox.classList.remove('hidden');
      }
      if (ev === 'loading' || ev === 'empty') { errorBox.classList.add('hidden'); unmute.classList.add('hidden'); subOverlay.classList.add('hidden'); }
      update();
    },
    showUnmute: (b) => {
      if (!b) host.userUnlocked = true;
      updateUnmuteVisibility();
    },
    floatEmoji: (emoji, senderName) => {
      if (senderName) {
        seatReactions.set(String(senderName), { emoji, at: Date.now() });
        renderCinemaSeats();
      }
      const existing = frame.querySelectorAll('.float-emoji');
      if (existing.length >= 16) existing[0].remove();
      const el = h('div', { class: 'float-emoji', style: { left: `${10 + Math.random() * 80}%` } }, emoji);
      frame.append(el); setTimeout(() => el.remove(), 2500);
    },
  };
}
