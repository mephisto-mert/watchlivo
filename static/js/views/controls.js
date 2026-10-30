// Player overlay (Rave VideoPlayerControlsFC + MeshVideoPlayer pre-message/error states).
import { h, icons, fmtTime, fill, popup, toast } from '../ui.js?v=20261030_v31';
import { state, isLeader, isHostOnly, canSelectVideo, setView } from '../store.js?v=20261030_v31';
import { getProvider } from '../providers.js?v=20261030_v31';
import { expectedPosition } from '../sync.js?v=20261030_v31';
import { thumbFor } from './lobby.js?v=20261030_v31';
import { renderSeriesPicker, launchProviderWindow } from '../accounts.js?v=20261030_v31';
import { resolveCatalogItem } from './selection-kinds.js?v=20261030_v31';
import { getSubPrefs, setSubPrefs } from '../players/subtitles.js?v=20261030_v31';
import { avatar } from '../profile.js?v=20261030_v31';

const VIDEO_FILTERS = {
  normal: { label: '🎬 Standart (Orijinal)', css: 'none' },
  hdr:    { label: '✨ Sinema HDR (Canlı Kontrast)', css: 'contrast(1.14) saturate(1.22) brightness(1.03)' },
  vivid:  { label: '💎 IMAX Canlı & Keskin', css: 'contrast(1.18) saturate(1.3) brightness(1.05)' },
  night:  { label: '🌙 Gece Modu (Göz Koruma)', css: 'sepia(0.18) brightness(0.88) contrast(0.96)' },
  vhs:    { label: '📼 Retro VHS / 90lar', css: 'contrast(1.15) saturate(0.82) sepia(0.22) hue-rotate(-6deg)' },
};

const PLAYER_THEMES = [
  { id: '#E50914', label: 'Netflix Red' },
  { id: '#3B82F6', label: 'Electric Blue' },
  { id: '#6366f1', label: 'Emerald Green' },
  { id: '#F59E0B', label: 'Amber Gold' },
];

const SN_ICONS = {
  back: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>',
  server: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>',
  nextEp: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line></svg>',
  captions: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>',
  customize: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
  download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  embed: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
  playTriangle: '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>',
};

export function buildControls(frame, ctx) {
  const { actions, host } = ctx;
  const ico = (n) => h('span', { html: icons[n], style: { display: 'contents' } });
  const empty = h('div', { class: 'stage-empty hidden' },
    h('h2', {}, 'Henüz bir şey oynatılmıyor'),
    h('p', {}, 'Video Ara ile bir sağlayıcı seç. Seçtiğin video odadaki herkes için aynı anda başlar.'),
    h('button', { class: 'btn primary', onclick: () => { setView('left', 'Search'); ctx.layout.update(); } }, ico('searchVideo'), 'Video Ara'));
  const loading = h('div', { class: 'stage-empty hidden', style: { background: 'rgba(0,0,0,.35)' } }, h('div', { class: 'spinner' }));
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
      ? `calc(clamp(16px, 2.3vmax, 28px) * ${Number(p.size || 1)})`
      : isMob
        ? `calc(clamp(11px, 3.0vw, 14px) * ${Number(p.size || 1)})`
        : `calc(clamp(14px, 2.0vmax, 22px) * ${Number(p.size || 1)})`;
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
    subOverlay.style.transform = lift > 0 ? `translateY(-${lift}px)` : '';
  }
  applySubPrefsStyle();

  let uiTimer = null;
  let lastUiRevealAt = 0;
  const revealControls = (ms) => {
    const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    const durationMs = ms || (isTouch ? 5200 : 3500);
    if (!controls.classList.contains('ui-active')) {
      lastUiRevealAt = Date.now();
    }
    controls.classList.add('ui-active');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      if (!menu.classList.contains('hidden')) return;
      controls.classList.remove('ui-active');
    }, durationMs);
  };
  const doUnlockAudio = (e) => {
    if (e) { e.stopPropagation(); }
    host.userUnlocked = true;
    host.autoplayBlocked = false;
    host.unlockAudio();
    unmute.classList.add('hidden');
    revealControls();
    update();
  };
  const tapProps = (fn) => {
    let lastFire = 0;
    let startX = 0;
    let startY = 0;
    const run = (e) => {
      if (e) e.stopPropagation();
      const now = Date.now();
      if (now - lastFire < 320) return;
      lastFire = now;
      revealControls(6500);
      fn(e);
    };
    return {
      onpointerdown: (e) => {
        e.stopPropagation();
        startX = e.clientX || 0;
        startY = e.clientY || 0;
        revealControls(6500);
      },
      ontouchstart: (e) => {
        e.stopPropagation();
        const t = e.touches?.[0];
        if (t) { startX = t.clientX; startY = t.clientY; }
        revealControls(6500);
      },
      ontouchend: (e) => {
        e.stopPropagation();
        const t = e.changedTouches?.[0];
        if (t && (Math.abs(t.clientX - startX) > 24 || Math.abs(t.clientY - startY) > 24)) return;
        if (e.cancelable) e.preventDefault();
        run(e);
      },
      onclick: (e) => run(e),
    };
  };
  const unmute = h('button', {
    class: 'btn primary unmute-pill hidden',
    id: 'ctl-unmute',
    ...tapProps(doUnlockAudio),
  }, ico('volume'), 'Sesi Aç');
  const overlayMsg = h('div', { class: 'stage-overlay-msg hidden' });

  const updateUnmuteVisibility = () => {
    if (!host.adapter || host.loading || host.userUnlocked || host.userMuted) {
      unmute.classList.add('hidden');
      return;
    }
    const needUnmute = Boolean(host.autoplayBlocked || isActuallyMuted());
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
  const epBtn = h('button', { class: 'btn ctl-pill hidden', id: 'ctl-ep-btn', ...tapProps(() => openEpisodeModal()) }, '📺 S1:B1');
  const nextEpTopBtn = h('button', { class: 'btn ctl-pill hidden', id: 'ctl-next-ep-top', ...tapProps(() => triggerNextEpisode()) }, '⏭️ Sonraki Bölüm');
  const subPillBtn = h('button', { class: 'btn ctl-pill hidden', id: 'ctl-sub-pill', ...tapProps(() => toggleMenu('subtitle')) }, '💬 Altyazı & Dublaj');
  const origBtn = h('button', { class: 'btn ctl-pill hidden', id: 'ctl-orig-btn', ...tapProps(() => openOfficialPlatform()) }, '🔐 Orijinal Platformda Aç');
  const isActuallyMuted = () => Boolean(host.isMuted?.() || host.adapter?.isMuted?.());
  const syncDot = h('span', { class: 'sync-dot', title: 'Senkron' });
  const syncText = h('span', { class: 'ctl-time', style: { opacity: .7 } });
  const seekStep = (delta) => {
    if (!isLeader()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
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
  const playBtn = h('button', { class: 'ctl-action', 'aria-label': 'Oynat/Duraklat', id: 'ctl-play', ...tapProps(() => {
    if (isActuallyMuted() && !host.userMuted) doUnlockAudio();
    const roomPlaying = (state.mesh?.media?.meshStateStatus || (state.mesh?.media?.playing ? 'PLAYING' : 'PAUSED')) === 'PLAYING';
    const adapterPaused = host.adapter ? Boolean(host.adapter.isPaused?.()) : !roomPlaying;
    if (!isLeader()) {
      if (roomPlaying && adapterPaused) {
        host.adapter?.play?.();
        ctx.sync?.kick();
        revealControls(5200);
        update();
        return;
      }
      toast('Videoyu yalnızca oda başkanı duraklatabilir veya başlatabilir');
      return;
    }
    if (!adapterPaused) {
      actions.pause();
    } else if (!roomPlaying || ctx.userPaused) {
      actions.play();
    } else {
      host.adapter?.play?.();
      actions.play();
    }
    revealControls(5200);
    update();
  }) });
  const back10Btn = h('button', {
    class: 'ctl-action',
    'data-tip': '10 sn geri',
    'aria-label': '10 saniye geri',
    id: 'ctl-back10',
    ...tapProps(() => {
      if (!isLeader()) {
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
      if (!isLeader()) {
        toast('Videoyu yalnızca oda başkanı sarabilir');
        return;
      }
      seekStep(10);
    }),
  }, ico('forward10'));
  const cur = h('div', { class: 'cur' }), buf = h('div', { class: 'buf' }), knob = h('div', { class: 'knob' });
  const seekPreviewCanvas = h('canvas', { class: 'seek-preview-canvas', width: '128', height: '72' });
  const seekPreviewChapter = h('div', { class: 'seek-preview-chapter' }, 'Sahne Önizleme');
  const seekPreviewSub = h('div', { class: 'seek-preview-sub' }, '');
  const seekPreviewTime = h('div', { class: 'seek-preview-time' }, '0:00');
  const seekPreview = h('div', { class: 'seek-preview-card hidden', id: 'ctl-seek-preview' }, seekPreviewCanvas, seekPreviewChapter, seekPreviewSub, seekPreviewTime);
  const trackTicks = h('div', { class: 'track-ticks', 'aria-hidden': 'true' },
    h('span', { style: { left: '25%' } }),
    h('span', { style: { left: '50%' } }),
    h('span', { style: { left: '75%' } }));
  const timeline = h('div', { class: 'timeline', id: 'ctl-timeline' }, seekPreview, h('div', { class: 'track' }, trackTicks, buf, cur, knob));
  const time = h('span', { class: 'ctl-time' }, '0:00 / 0:00');
  const volRange = h('input', { type: 'range', min: '0', max: '100', value: String(host.volume), 'aria-label': 'Ses', oninput: (e) => { host.setVolume(e.target.value); unmute.classList.add('hidden'); update(); } });
  const volBtn = h('button', { class: 'ctl-action', id: 'ctl-vol', 'aria-label': 'Sessiz', ...tapProps(() => { if (isActuallyMuted()) doUnlockAudio(); else { host.setMuted(true, true); update(); } }) });
  const skipBtn = h('button', { class: 'ctl-action', 'data-tip': 'Atla oyu', 'aria-label': 'Atla', ...tapProps(() => actions.skip()) }, ico('skip'));
  const speedBtn = h('button', { class: 'ctl-action ctl-speed-btn', id: 'ctl-speed-btn', 'data-tip': 'Oynatma Hızı', 'aria-label': 'Oynatma Hızı', ...tapProps(() => toggleMenu('speed')) }, h('span', { style: { fontSize: '.72em', fontWeight: '800' } }, '1x'));
  const subBtn = h('button', { class: 'ctl-action ctl-labeled-pill', id: 'ctl-sub-btn', 'data-tip': 'Altyazı & Dublaj', 'aria-label': 'Altyazı ve Dublaj', ...tapProps(() => toggleMenu('subtitle')) }, ico('subtitles'), h('span', { class: 'ctl-btn-lbl' }, 'Altyazı & Ses'));
  const snapBtn = h('button', { class: 'ctl-action', id: 'ctl-snap', 'data-tip': 'Anlık Kare Yakala (PNG)', 'aria-label': 'Ekran Görüntüsü', ...tapProps(() => takeVideoSnapshot()) }, ico('snapshot'));
  const gearBtn = h('button', { class: 'ctl-action', id: 'ctl-gear', 'data-tip': 'Oynatıcı Ayarları', 'aria-label': 'Ayarlar', ...tapProps(() => toggleMenu('list')) }, ico('settings'));
  const theaterBtn = h('button', { class: 'ctl-action ctl-labeled-pill', id: 'ctl-theater', 'data-tip': 'Sinema Modu (T)', 'aria-label': 'Sinema Modu', ...tapProps(() => ctx.toggleTheaterMode?.()) }, ico('theater'), h('span', { class: 'ctl-btn-lbl' }, 'Sinema'));
  const fsBtn = h('button', { class: 'ctl-action', id: 'ctl-fs', 'data-tip': 'Tam Ekran (F)', 'aria-label': 'Tam ekran', ...tapProps(() => { if (isActuallyMuted() && !host.userMuted) doUnlockAudio(); toggleFullscreen(); }) }, ico('fullscreen'));
  const menu = h('div', { class: 'ctl-menu acrylic hidden' });
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
    if (!m || m.mediaType !== 'tv') return null;
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
  let curFilter = localStorage.getItem('vortex_video_filter') || 'normal';
  let danmakuEnabled = localStorage.getItem('vortex_danmaku') !== 'off';
  let ambilightEnabled = false;
  let autoAdvancingKey = '';
  let cancelledNextEpKey = '';
  const seatReactions = new Map();

  function applyVideoFilter() {
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
    const spec = VIDEO_FILTERS[curFilter] || VIDEO_FILTERS.normal;
    if (v) v.style.filter = spec.css;
  }

  function takeVideoSnapshot(opts = {}) {
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
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
        c2d.font = `bold ${Math.round(c.height * 0.04)}px Inter, sans-serif`;
        c2d.fillStyle = '#ffffff';
        c2d.textAlign = 'center';
        c2d.shadowColor = '#000';
        c2d.shadowBlur = 8;
        c2d.fillText(subCue.textContent, c.width / 2, c.height - Math.round(c.height * 0.07));
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
    if (!isLeader()) {
      toast(`⏱️ ${fmtTime(target)} sahnesi (Videoyu yalnızca oda başkanı sarabilir)`);
      return;
    }
    actions.seek(target);
    showOverlay(`⏱️ ${fmtTime(target)} sahnesine gidildi`, 1800);
    revealControls(2600);
  };

  async function triggerNextEpisode() {
    const m = state.mesh?.media;
    if (!m || m.mediaType !== 'tv' || !isLeader()) return;
    if ((state.mesh?.queue || []).length > 0) return;
    const cleanTitle = (m.seriesTitle || (m.title || 'Dizi').split(' — ')[0]).trim();
    const seriesIdKey = m.tmdbId || m.id || cleanTitle;
    if (!seriesIdKey) return;
    const curKey = `${seriesIdKey}:${m.season || 1}:${m.episode || 1}`;
    if (autoAdvancingKey === curKey) return;
    autoAdvancingKey = curKey;
    nextEpBanner.classList.add('hidden');
    let targetSeason = Number(m.season || 1) || 1;
    let targetEp = (Number(m.episode || 1) || 1) + 1;
    let epName = '';
    try {
      const r = await fetch(`/api/rave/seasons?tmdbId=${encodeURIComponent(m.tmdbId || '')}&title=${encodeURIComponent(cleanTitle)}&mediaType=tv&season=${targetSeason}`);
      if (r.ok) {
        const sData = await r.json();
        const eps = Array.isArray(sData.episodes) ? sData.episodes : [];
        const seasons = Array.isArray(sData.seasons) ? sData.seasons : [];
        const foundEp = eps.find((x) => Number(x.episode) === targetEp);
        if (foundEp) {
          const rawName = String(foundEp.name || '').trim();
          const isRedundant = new RegExp(`^(?:${targetEp}\\.\\s*bölüm|bölüm\\s*${targetEp}|episode\\s*${targetEp})(?:\\s*\\([^)]*\\))?$`, 'i').test(rawName);
          epName = isRedundant ? '' : rawName;
        } else if (eps.length > 0 && targetEp > eps.length) {
          const hasNextSeason = seasons.some((s) => Number(s.season) === targetSeason + 1);
          if (hasNextSeason) {
            targetSeason += 1;
            targetEp = 1;
            const r2 = await fetch(`/api/rave/seasons?tmdbId=${encodeURIComponent(m.tmdbId || '')}&title=${encodeURIComponent(cleanTitle)}&mediaType=tv&season=${targetSeason}`);
            if (r2.ok) {
              const s2 = await r2.json();
              const ep1 = (s2.episodes || []).find((x) => Number(x.episode) === 1);
              if (ep1?.name && !/^(?:1\.\s*bölüm|bölüm\s*1|episode\s*1)(?:\s*\([^)]*\))?$/i.test(ep1.name.trim())) {
                epName = ep1.name.trim();
              }
            }
          } else {
            toast('🏁 Dizinin son bölümüne ulaşıldı');
            return;
          }
        }
      }
    } catch (e) { /* fallback to +1 */ }
    const prov = getProvider(m.catalogProvider || m.provider) || { id: 'cinema', name: 'Sinema & Dizi' };
    showOverlay(`⏭️ ${targetSeason}. Sezon ${targetEp}. Bölüm yükleniyor…`, 4000);
    const nextMedia = await resolveCatalogItem(
      { tmdbId: m.tmdbId || '', imdbId: m.imdbId || '', title: cleanTitle, originalTitle: m.originalTitle || cleanTitle, year: m.year || '', mediaType: 'tv', backdrop: m.thumbnail },
      prov,
      targetSeason,
      targetEp,
      epName,
    );
    if (nextMedia) {
      actions.pickMedia(nextMedia);
    } else {
      autoAdvancingKey = '';
    }
  }
  const closeMenu = () => {
    menu.classList.add('hidden');
    frame.classList.remove('menu-open');
  };

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
  let startBrightness = 100;
  let currentBrightness = 100;
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
    ...tapProps(() => back10Btn.click()),
  }, ico('rewind10'));
  const centerPlayBtn = h('button', {
    type: 'button',
    class: 'ctl-center-play',
    id: 'ctl-center-play',
    'aria-label': 'Oynat / Duraklat',
    ...tapProps(() => playBtn.click()),
  }, ico('play'));
  const centerFwd10Btn = h('button', {
    type: 'button',
    class: 'ctl-center-side',
    id: 'ctl-center-fwd10',
    'aria-label': '10 saniye ileri',
    title: '10 saniye ileri',
    ...tapProps(() => fwd10Btn.click()),
  }, ico('forward10'));
  const centerHud = h('div', { class: 'ctl-center-hud', id: 'ctl-center-hud' }, centerBack10Btn, centerPlayBtn, centerFwd10Btn);
  const mid = h('div', { class: 'ctl-mid' }, centerHud);

  mid.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    if (e.target?.closest?.('button, input, .ctl-center-hud')) return;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();
    isSwiping = false;
    swipeMode = null;
    startVolume = Number(host.volume || 80);
    startBrightness = currentBrightness;
  }, { passive: true });

  mid.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    if (e.target?.closest?.('button, input, .ctl-center-hud')) return;
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
        currentBrightness = Math.max(30, Math.min(150, Math.round(startBrightness + deltaPct)));
        frame.style.setProperty('--video-brightness', `${currentBrightness}%`);
        showOverlay(`☀️ Parlaklık: %${currentBrightness}`, 900);
      } else if (swipeMode === 'volume') {
        const nv = Math.max(0, Math.min(100, Math.round(startVolume + deltaPct)));
        host.setVolume(nv);
        if (isActuallyMuted() && nv > 0) doUnlockAudio();
        showOverlay(`🔊 Ses: %${nv}`, 900);
        update();
      }
    }
  }, { passive: false });

  mid.addEventListener('touchend', (e) => {
    if (e.target?.closest?.('button, input, .ctl-center-hud')) {
      revealControls(5200);
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

    if (now - lastTapTime < 320 && Math.abs(t.clientX - lastTapX) < 70 && Math.abs(t.clientY - lastTapY) < 70) {
      clearTimeout(tapTimer);
      lastTapTime = 0;
      if (ratio < 0.38) {
        if (!isLeader()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
        accumulatedSeek = (accumulatedSeek <= 0 ? accumulatedSeek : 0) - 10;
        seekStep(-10);
        triggerSeekRipple('left', accumulatedSeek);
        revealControls(4500);
      } else if (ratio > 0.62) {
        if (!isLeader()) { toast('Videoyu yalnızca oda başkanı sarabilir'); return; }
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
        if ((isActuallyMuted() && !host.userMuted) || !unmute.classList.contains('hidden')) { doUnlockAudio(); return; }
        if (controls.classList.contains('ui-active') && Date.now() - lastUiRevealAt > 450) {
          clearTimeout(uiTimer);
          controls.classList.remove('ui-active');
        } else {
          revealControls(5200);
        }
      }, 240);
    }
  }, { passive: true });

  mid.addEventListener('click', (e) => {
    if (e.target?.closest?.('button, input, .ctl-center-hud')) return;
    if (e.pointerType === 'touch' || ('ontouchstart' in window && Date.now() - touchStartTime < 650)) return;
    if (!menu.classList.contains('hidden')) { closeMenu(); return; }
    if ((isActuallyMuted() && !host.userMuted) || !unmute.classList.contains('hidden')) { doUnlockAudio(); return; }
    if (controls.classList.contains('ui-active') && Date.now() - lastUiRevealAt > 350) {
      clearTimeout(uiTimer);
      controls.classList.remove('ui-active');
    } else {
      revealControls(4000);
    }
  });
  mid.addEventListener('dblclick', (e) => {
    if (e.pointerType === 'touch') return;
    toggleFullscreen();
  });
  const miniTitle = h('span', { class: 'mini-player-title' }, 'Canlı Oda');
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
  const barRow = h('div', { class: 'ctl-bar-row' },
    h('div', { class: 'ctl-cluster-left' }, playBtn, back10Btn, fwd10Btn, h('div', { class: 'vol-wrap' }, volBtn, volRange), time),
    h('div', { class: 'ctl-spacer' }),
    h('div', { class: 'ctl-cluster-right' }, skipBtn, speedBtn, subBtn, snapBtn, gearBtn, theaterBtn, fsBtn));
  const controls = h('div', { class: 'controls' },
    h('div', { class: 'ctl-top' },
      h('div', { class: 'ctl-top-left' }, thumb, h('div', { class: 'ctl-info' }, kickerBadge, title, artist)),
      h('div', { class: 'ctl-top-right' }, epBtn, nextEpTopBtn, origBtn, provLogo)),
    mid,
    h('div', { class: 'ctl-bottom' }, timeline, barRow),
    menu);
  frame.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    revealControls(3200);
  }, { passive: true });
  controls.addEventListener('pointerdown', (e) => {
    if (e.target?.closest?.('.ctl-top, .ctl-bottom, .ctl-center-hud, .ctl-menu')) {
      revealControls(5200);
    }
  }, { passive: true });
  frame.prepend(stageBackdrop, ambilightCanvas);
  frame.append(empty, loading, danmakuLayer, cinemaSeatsBar, subOverlay, rippleLeft, rippleRight, skipIntroBtn, nextEpBanner, controls, miniBar, errorBox, unmute, overlayMsg);

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable || document.querySelector('.popup-backdrop')) return;
    if (e.key === 'Escape') {
      if (!menu.classList.contains('hidden')) { e.preventDefault(); closeMenu(); }
      return;
    }
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      if (!isLeader()) {
        const roomPlaying = (state.mesh?.media?.meshStateStatus || (state.mesh?.media?.playing ? 'PLAYING' : 'PAUSED')) === 'PLAYING';
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
      if (isLeader()) seekStep(-10);
      else toast('Videoyu yalnızca oda başkanı sarabilir');
    }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (isLeader()) seekStep(10);
      else toast('Videoyu yalnızca oda başkanı sarabilir');
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nv = Math.min(100, Number(host.volume || 80) + 5);
      host.setVolume(nv);
      if (isActuallyMuted()) doUnlockAudio();
      showOverlay(`🔊 Ses: %${nv}`, 1000);
      update();
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nv = Math.max(0, Number(host.volume || 80) - 5);
      host.setVolume(nv);
      showOverlay(`🔉 Ses: %${nv}`, 1000);
      update();
    }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); ctx.toggleTheaterMode?.(); }
    else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); if (isActuallyMuted()) doUnlockAudio(); else { host.setMuted(true, true); update(); } }
    else if (e.key === '[' || e.key === 'z' || e.key === 'Z' || e.key === ',') {
      e.preventDefault();
      const step = e.key === ',' ? -0.2 : -0.5;
      const off = host.adapter?.subs?.setSubtitleOffset?.(step);
      showOverlay(`⏱️ Altyazı: ${off >= 0 ? '+' : ''}${off} sn`, 1200);
      revealControls();
    }
    else if (e.key === ']' || e.key === 'x' || e.key === 'X' || e.key === '.') {
      e.preventDefault();
      const step = e.key === '.' ? 0.2 : 0.5;
      const off = host.adapter?.subs?.setSubtitleOffset?.(step);
      showOverlay(`⏱️ Altyazı: ${off >= 0 ? '+' : ''}${off} sn`, 1200);
      revealControls();
    }
    else if (e.key === '\\' || e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      host.adapter?.subs?.setSubtitleOffset?.(0, true);
      host.adapter?.subs?.setSubtitleFpsScale?.(1.0);
      showOverlay('⏱️ Altyazı Senkronu Sıfırlandı', 1200);
      revealControls();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Timeline seek & drag scrubbing (leader only — Rave timeline-container-non-leader hides the knob).
  let scrubbing = false;
  const seekFromEvent = (e, commit = true) => {
    const d = duration();
    if (!d || !isLeader()) return;
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
    if (!isLeader()) {
      e.stopPropagation();
      toast('Videoyu yalnızca oda başkanı sarabilir');
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
    const chLabel = target < 90 ? '🎬 Giriş / İntro'
      : ratio < 0.25 ? 'Bölüm 1 · Başlangıç'
      : ratio < 0.55 ? 'Bölüm 2 · Gelişme'
      : ratio < 0.85 ? 'Bölüm 3 · Doruk Noktası'
      : 'Bölüm 4 · Final';
    seekPreviewChapter.textContent = chLabel;
    seekPreviewTime.textContent = `${fmtTime(target)} / ${fmtTime(d)}`;
    const subsObj = host.adapter?.subs;
    const adjTarget = subsObj ? ((target * (subsObj.fpsScale || 1.0)) - (subsObj.offsetSec || 0)) : target;
    const cueAt = subsObj?.findCueAt?.(subsObj.subCues || [], adjTarget);
    seekPreviewSub.textContent = cueAt?.text ? `"${cueAt.text.slice(0, 48)}"` : '';
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
    if (v && v.videoWidth > 0) {
      try {
        const ctx2d = seekPreviewCanvas.getContext('2d');
        ctx2d.drawImage(v, 0, 0, 128, 72);
      } catch (err) { /* ignore */ }
    }
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
    seekFromEvent(e, true);
  };
  timeline.addEventListener('pointerup', endScrub);
  timeline.addEventListener('pointercancel', endScrub);
  timeline.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isLeader()) {
      toast('Videoyu yalnızca oda başkanı sarabilir');
      return;
    }
    if (Date.now() - lastScrubEndedAt < 380) return;
    seekFromEvent(e, true);
  });

  const duration = () => Number(host.adapter?.getDuration?.() || state.mesh?.media?.duration || 0);
  const position = () => (host.adapter ? host.adapter.getTime() : 0);

  function renderCinemaSeats() {
    const parts = Array.isArray(state.mesh?.participants) ? state.mesh.participants : [];
    const hasMedia = Boolean(state.mesh?.media && (state.mesh.media.url || state.mesh.media.videoId));
    const now = Date.now();
    const activeParts = parts.filter((p) => {
      const uName = String(p.name || 'Misafir');
      const reactObj = seatReactions.get(uName);
      const hasEmoji = Boolean(reactObj && now - reactObj.at < 2600);
      const isSpk = Boolean(p.speaking || (p.id === state.self?.id && state.voice?.speaking));
      return hasEmoji || isSpk;
    });
    if (!hasMedia || !activeParts.length) {
      cinemaSeatsBar.classList.add('hidden');
      return;
    }
    cinemaSeatsBar.classList.remove('hidden');
    const visibleParts = activeParts.slice(0, 6);
    fill(
      cinemaSeatsBar,
      ...visibleParts.map((p) => {
        const uName = String(p.name || 'Misafir');
        const reactObj = seatReactions.get(uName);
        const activeEmoji = (reactObj && now - reactObj.at < 2600) ? reactObj.emoji : '';
        const isSpeaking = Boolean(p.speaking || (p.id === state.self?.id && state.voice?.speaking));
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

  function tick() {
    const d = duration(), p = Math.min(position(), d || Infinity);
    const vAct = host.adapter?.video;
    if (vAct && !vAct.paused && !vAct.seeking && vAct.readyState >= 2 && !host.loading) {
      loading.classList.add('hidden');
    }
    stageBackdrop.classList.toggle('is-hero-cover', p < 2.2);
    if (!scrubbing) {
      const pct = d ? (p / d) * 100 : 0;
      cur.style.width = `${pct}%`;
      knob.style.left = `${pct}%`;
      time.textContent = host.adapter?.caps.live ? 'CANLI' : `${fmtTime(p)} / ${fmtTime(d)}`;
    }
    buf.style.width = d ? `${Math.min(100, ((host.adapter?.getBuffered?.() || 0) / d) * 100)}%` : '0%';
    updateUnmuteVisibility();
    renderCinemaSeats();
    const m = state.mesh?.media;
    const intro = getActiveIntro();
    const canSkipIntro = Boolean(isLeader() && intro && Number(intro.end) > Number(intro.start) && p >= Number(intro.start) && p < Number(intro.end) - 1.5);
    if (canSkipIntro) {
      skipIntroBtn.textContent = `${intro.label || '⏩ İntroyu Atla'} (${fmtTime(intro.end)})`;
    }
    skipIntroBtn.classList.toggle('hidden', !canSkipIntro);
    const rem = d > 300 ? d - p : 9999;
    const curEpKey = m ? `${m.tmdbId || m.id || m.title}:${m.season || 1}:${m.episode || 1}` : '';
    if (m?.mediaType === 'tv' && m?.tmdbId && rem <= 35 && rem > 0 && cancelledNextEpKey !== curEpKey) {
      const nextEp = Number(m.episode || 1) + 1;
      const curSeason = Number(m.season || 1);
      const cleanSeries = (m.seriesTitle || (m.title || 'Dizi').split(' — ')[0]).trim();
      const pctCountdown = Math.max(0, Math.min(100, ((35 - rem) / 35) * 100));
      const posterSrc = thumbFor(m) || '/static/watchlivo-logo.svg';
      nextEpBanner.classList.remove('hidden');
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
              isLeader()
                ? h('button', {
                    class: 'btn primary next-ep-go',
                    ...tapProps(() => triggerNextEpisode()),
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
      if (rem <= 1.2 && isHostOnly()) triggerNextEpisode();
    } else {
      nextEpBanner.classList.add('hidden');
    }
    if (ambilightEnabled) {
      ambilightCanvas.classList.add('on');
      const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
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
    const curSub = host.adapter?.getSelectedSubtitleId?.() || 'off';
    if (curSub === 'off' || !subCue.textContent) {
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
    const m = state.mesh?.media;
    if (!m || m.mediaType !== 'tv') return;
    const prov = getProvider(m.catalogProvider || m.provider) || getProvider('cinema') || getProvider('netflix');
    const cleanTitle = (m.seriesTitle || (m.title || 'Dizi').split(' — ')[0]).trim();
    const box = h('div', { style: { minHeight: '280px' } });
    popup({ title: `📺 ${cleanTitle} — Sezon & Bölüm Seç`, content: box, options: [{ label: 'Kapat' }] });
    renderSeriesPicker(
      {
        id: m.id || '',
        tmdbId: m.tmdbId || '',
        imdbId: m.imdbId || '',
        title: cleanTitle,
        originalTitle: m.originalTitle || cleanTitle,
        year: m.year || '',
        season: Number(m.season || 1) || 1,
        episode: Number(m.episode || 1) || 1,
        mediaType: m.mediaType || 'tv',
        poster: m.thumbnail,
      },
      prov,
      box,
      () => document.querySelector('.popup-backdrop')?.remove(),
      async (nextMedia) => {
        document.querySelector('.popup-backdrop')?.remove();
        const pickFn = actions?.pickMedia || ctx.actions?.pickMedia || ctx.pickMedia;
        if (typeof pickFn === 'function') await pickFn(nextMedia);
      },
      resolveCatalogItem,
    );
  }

  let currentMenuView = 'list';
  function toggleMenu(view = 'list') {
    if (!menu.classList.contains('hidden') && currentMenuView === view) {
      closeMenu();
      return;
    }
    renderMenuView(view);
    menu.classList.remove('hidden');
    frame.classList.add('menu-open');
  }

  const cleanSrvUrl = (u) => String(u || '').replace(/&aud=[^&]+/g, '').replace(/&proxy_segs=1/g, '').trim();

  async function refreshCurrentStreamSources() {
    const m = state.mesh?.media;
    if (!m || (!m.tmdbId && !m.imdbId && !m.title)) return;
    closeMenu();
    errorBox.classList.add('hidden');
    loading.classList.remove('hidden');
    showOverlay('🔄 Yayın kaynakları canlı yenileniyor…', 3500);
    try {
      const qs = new URLSearchParams({
        provider: String(m.catalogProvider || m.provider || 'cinema'),
        title: String(m.originalTitle || m.seriesTitle || m.title || ''),
        displayTitle: String(m.seriesTitle || m.title || ''),
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
          if (host.adapter?.switchStreamSource) {
            host.adapter.switchStreamSource(fresh.url);
          } else {
            await host.setMedia(m, position(), true);
          }
          loading.classList.add('hidden');
          showOverlay('✅ Yayın kaynağı yenilendi', 2200);
          update();
          return;
        }
      }
    } catch (e) { /* ignore */ }
    loading.classList.add('hidden');
    toast('Alternatif yayın kaynağı bulunamadı.');
  }

  function renderMenuView(view) {
    currentMenuView = view;
    const m = state.mesh?.media || {};
    const rate = Number(m.meshStatePlaybackSpeed || 1);
    const subTracks = host.adapter?.getSubtitleTracks?.() || m.subtitleTracks || [];
    const curSubId = host.adapter?.getSelectedSubtitleId?.() || 'off';
    const curSubObj = subTracks.find((t) => t.id === curSubId);
    const rawAudioTracks = host.adapter?.getAudioTracks?.() || m.audioTracks || [];
    const audioTracks = rawAudioTracks.length
      ? rawAudioTracks
      : (m.isMusic || m.isLive
          ? [{ id: 'orig', label: '🎬 Orijinal Ses (HD)' }]
          : [
              { id: 'orig', label: '🎬 Orijinal Ses (1080p HD)' },
              { id: 'tr-ai-dub', label: '🇹🇷 Türkçe Dublaj (Akıllı Seslendirme)', mode: 'tts' },
            ]);
    const curAudioId = host.adapter?.getSelectedAudioId?.() || 'orig';
    const curAudioObj = audioTracks.find((t) => t.id === curAudioId) || audioTracks[0];
    const rawServers = Array.isArray(m.servers) && m.servers.length
      ? m.servers
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
      const prefBtn = h('button', { class: 'ctl-menu-subbtn', onclick: (e) => { e.stopPropagation(); renderMenuView('subtitlePreferences'); } }, '🎨 Gelişmiş');
      const prefs = getSubPrefs();
      const audioSection = [
        h('div', { class: 'dim', style: { fontSize: '.74em', fontWeight: '700', padding: '.25em .7em .15em', color: '#a5b4fc' } }, '🎙️ Ses & Dublaj Seçimi'),
        ...audioTracks.map((t) => h('div', {
          class: `opt ${curAudioId === t.id ? 'on' : ''}`,
          onclick: async (e) => {
            e.stopPropagation();
            if (host.autoplayBlocked || host.muted) doUnlockAudio();
            await host.adapter?.setAudioTrack?.(t.id);
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
        h('div', { class: 'dim', style: { fontSize: '.74em', marginBottom: '4px' } }, `⏱️ Altyazı Senkron Kaydırma (${curOff >= 0 ? '+' : ''}${curOff} sn)`),
        h('div', { class: 'ctl-pref-pills', style: { marginBottom: '6px', display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' } },
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-2.0); renderMenuView('subtitle'); } }, '-2s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-0.5); renderMenuView('subtitle'); } }, '-0.5s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(-0.2); renderMenuView('subtitle'); } }, '-0.2s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(0, true); host.adapter?.subs?.setSubtitleFpsScale?.(1.0); renderMenuView('subtitle'); } }, 'Sıfırla'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(0.2); renderMenuView('subtitle'); } }, '+0.2s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(0.5); renderMenuView('subtitle'); } }, '+0.5s'),
          h('button', { class: 'ctl-pref-pill', onclick: (e) => { e.stopPropagation(); host.adapter?.subs?.setSubtitleOffset?.(2.0); renderMenuView('subtitle'); } }, '+2s')),
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
      const rows = audioTracks.map((t) => h('div', {
        class: `opt ${curAudioId === t.id ? 'on' : ''}`,
        onclick: async (e) => {
          e.stopPropagation();
          if (host.autoplayBlocked || host.muted) doUnlockAudio();
          await host.adapter?.setAudioTrack?.(t.id);
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
        h('div', { class: 'dim', style: { fontSize: '.75em', padding: '.3em .7em' } }, isLeader() ? 'Oynatma hızı' : 'Oynatma hızını yalnızca lider değiştirebilir'),
        ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => h('div', { class: `opt ${r === rate ? 'on' : ''}`, onclick: () => { closeMenu(); actions.setRate(r); } }, h('span', {}, `${r}x`), r === rate ? h('span', {}, '✓') : null)),
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
            if (host.autoplayBlocked || host.muted) doUnlockAudio();
            m.url = srv.url;
            host.adapter?.switchStreamSource?.(srv.url);
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
      const qLevels = host.adapter?.getQualityLevels?.() || [{ id: 0, label: '✨ 1080p Full HD (Doğrudan Akış)', active: true }];
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

    if (view === 'effects') {
      const duckOn = localStorage.getItem('vortex_voice_duck') !== 'off';
      menu.replaceChildren(
        backHeader('Sinema Efektleri & Araçlar', 'list'),
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
            try { localStorage.setItem('vortex_voice_duck', next ? 'on' : 'off'); } catch (err) { /* ignore */ }
            renderMenuView('effects');
          },
        }, h('span', {}, '🎙️ Konuşurken Film Sesini Kıs'), h('span', {}, duckOn ? 'Açık' : 'Kapalı')),
        h('div', {
          class: 'opt',
          onclick: (e) => {
            e.stopPropagation();
            closeMenu();
            const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
            if (v?.requestPictureInPicture) {
              if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
              else v.requestPictureInPicture().catch(() => toast('PiP bu videoda desteklenmiyor.'));
            }
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
    const items = [listHead];
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
    menu.replaceChildren(...items);
  }

  function isFullscreenActive() {
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      v?.webkitDisplayingFullscreen ||
      frame.classList.contains('fullscreen') ||
      document.body.classList.contains('vortex-fs')
    );
  }

  let lastMobileLandscape = typeof window !== 'undefined' && window.innerWidth > window.innerHeight * 1.15;

  function onViewportChange() {
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    const isInputFocused = Boolean(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    if (!isInputFocused) {
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }
    if (typeof window !== 'undefined' && !isInputFocused) {
      const isTouchPhone = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && Math.min(window.innerWidth, window.innerHeight) <= 540;
      const isLandscape = window.innerWidth > window.innerHeight * 1.15;
      const hasMedia = Boolean(state.mesh?.media && (state.mesh.media.url || state.mesh.media.videoId));
      const isMinimized = document.body.classList.contains('mesh-minimized');
      if (isTouchPhone && hasMedia && !isMinimized) {
        if (!lastMobileLandscape && isLandscape && !isFullscreenActive()) {
          frame.classList.add('fullscreen');
          document.body.classList.add('vortex-fs');
          frame.dataset.fsMode = 'auto-rotate';
          revealControls(2500);
        } else if (lastMobileLandscape && !isLandscape && isFullscreenActive()) {
          frame.classList.remove('fullscreen');
          document.body.classList.remove('vortex-fs');
          frame.dataset.fsMode = '';
          if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
          if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
        }
      }
      lastMobileLandscape = isLandscape;
    }
    applySubPrefsStyle();
    host.adapter?.subs?.onTimeUpdate?.(position(), true);
    [120, 450, 1100].forEach((ms) => setTimeout(() => {
      applySubPrefsStyle();
      host.adapter?.subs?.onTimeUpdate?.(position(), true);
      const curSub = host.adapter?.getSelectedSubtitleId?.() || 'off';
      if (curSub !== 'off' && subCue.textContent) subOverlay.classList.remove('hidden');
      else subOverlay.classList.add('hidden');
    }, ms));
  }

  function onNativeFsChange() {
    const nativeFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (!nativeFs && frame.dataset.fsMode === 'native') {
      frame.classList.remove('fullscreen');
      document.body.classList.remove('vortex-fs');
      frame.dataset.fsMode = '';
    }
    onViewportChange();
  }
  document.addEventListener('fullscreenchange', onNativeFsChange);
  document.addEventListener('webkitfullscreenchange', onNativeFsChange);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  function toggleFullscreen() {
    closeMenu();
    const v = host.adapter?.video || frame.querySelector('video:not(.cam-bubble video)');
    if (isFullscreenActive()) {
      frame.classList.remove('fullscreen');
      document.body.classList.remove('vortex-fs');
      frame.dataset.fsMode = '';
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
    const iosVideoFs = v && (v.webkitEnterFullscreen || v.webkitEnterFullScreen);
    if (!reqFrameFs && !reqDocFs && typeof iosVideoFs === 'function') {
      try {
        const subs = host.adapter?.subs;
        if (subs && subs.selectedSubId && subs.selectedSubId !== 'off') {
          const curTrk = subs.subtitleTracks?.find((t) => t.id === subs.selectedSubId);
          if (curTrk) subs._attachNativeTrack(curTrk);
        }
        frame.dataset.fsMode = 'ios-native';
        iosVideoFs.call(v);
        return;
      } catch (e) { /* fallback to CSS fullscreen below */ }
    }
    frame.classList.add('fullscreen');
    document.body.classList.add('vortex-fs');
    onViewportChange();
    revealControls(3200);
    const fsTarget = reqFrameFs ? frame : document.documentElement;
    const reqFs = reqFrameFs || reqDocFs;
    if (reqFs) {
      frame.dataset.fsMode = 'native';
      Promise.resolve(reqFs.call(fsTarget)).then(() => {
        try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch (e) { /* ignore */ }
        onViewportChange();
      }).catch(() => {
        if (typeof iosVideoFs === 'function') {
          try {
            frame.classList.remove('fullscreen');
            document.body.classList.remove('vortex-fs');
            frame.dataset.fsMode = 'ios-native';
            iosVideoFs.call(v);
            return;
          } catch (err) { /* ignore */ }
        }
        frame.dataset.fsMode = 'css';
      });
    } else {
      frame.dataset.fsMode = 'css';
      try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch (e) { /* ignore */ }
    }
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

  function syncMediaSession(m, prov, thumbUrl, playing, curRate) {
    syncDesktopPresence(m, prov, playing);
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      const ms = navigator.mediaSession;
      const metaKey = `${m?.title || ''}|${m?.channel || prov?.name || ''}|${thumbUrl || ''}`;
      if (metaKey !== lastMediaSessionKey) {
        lastMediaSessionKey = metaKey;
        const absThumb = thumbUrl && !thumbUrl.startsWith('data:')
          ? new URL(thumbUrl, window.location.origin).href
          : `${window.location.origin}/static/watchlivo-icon-512.png`;
        ms.metadata = new MediaMetadata({
          title: m?.title || 'Watchlivo',
          artist: m?.channel || prov?.name || 'Birlikte İzle',
          album: state.mesh?.name ? `Watchlivo · ${state.mesh.name}` : 'Watchlivo Sinema',
          artwork: [
            { src: absThumb, sizes: '512x512', type: 'image/png' },
          ],
        });
        const safeHandler = (act, fn) => { try { ms.setActionHandler(act, fn); } catch (e) { /* ignore */ } };
        safeHandler('play', () => {
          if (isLeader()) actions.play?.() || actions.toggle?.();
          else host.adapter?.play?.();
        });
        safeHandler('pause', () => {
          if (isLeader()) actions.pause?.() || actions.toggle?.();
        });
        safeHandler('seekbackward', (details) => {
          if (isLeader()) seekStep(-(details?.seekOffset || 10));
        });
        safeHandler('seekforward', (details) => {
          if (isLeader()) seekStep(details?.seekOffset || 10);
        });
        safeHandler('seekto', (details) => {
          if (isLeader() && Number.isFinite(details?.seekTime)) actions.seek(details.seekTime);
        });
        safeHandler('nexttrack', () => {
          if (!isLeader()) return;
          if (m?.mediaType === 'tv') triggerNextEpisode();
          else if ((state.mesh?.queue || []).length) actions.skip();
        });
      }
      ms.playbackState = playing ? 'playing' : 'paused';
      const now = Date.now();
      if (now - lastMediaPosSyncAt > 2000 && typeof ms.setPositionState === 'function') {
        const d = duration();
        const p = position();
        if (d > 0 && Number.isFinite(d) && Number.isFinite(p)) {
          lastMediaPosSyncAt = now;
          ms.setPositionState({
            duration: d,
            playbackRate: Number(curRate || 1) > 0 ? Number(curRate || 1) : 1,
            position: Math.max(0, Math.min(d, p)),
          });
        }
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
      return;
    }
    updateUnmuteVisibility();
    const prov = getProvider(m.catalogProvider || m.provider);
    const t = thumbFor(m);
    if (thumb.getAttribute('src') !== t) thumb.src = t || '/static/watchlivo-logo.svg';
    const backdropImg = m.backdrop || m.backdropUrl || t;
    const bgUrl = backdropImg ? `url("${backdropImg}")` : 'none';
    if (stageBackdrop.style.backgroundImage !== bgUrl) stageBackdrop.style.backgroundImage = bgUrl;
    stageBackdrop.classList.toggle('is-hero-cover', position() < 2.2);
    if (!syncText.textContent) syncText.textContent = '0ms · Senkron';
    title.textContent = m.title || 'Video';
    artist.textContent = m.channel || prov?.name || '';
    provLogo.src = prov?.logo || ''; provLogo.style.display = prov?.logo ? '' : 'none';
    const isSeries = !!(m.mediaType === 'tv');
    epBtn.classList.toggle('hidden', !isSeries);
    nextEpTopBtn.classList.toggle('hidden', !isSeries || !isLeader());
    if (isSeries) {
      epBtn.replaceChildren(ico('episodes'), `S${m.season || 1}:B${m.episode || 1}`);
      nextEpTopBtn.replaceChildren(ico('skip'), `B${Number(m.episode || 1) + 1}`);
    }
    const vEl = host.adapter?.video || frame.querySelector('video');
    const vw = vEl?.videoWidth || 0;
    const vh = vEl?.videoHeight || 0;
    const effW = Math.max(vw, Math.round(vh * 16 / 9));
    qualityBadge.textContent = effW >= 3200 ? '4K' : effW >= 1800 ? '1080p' : effW >= 1200 ? '720p' : '1080p';
    if (artist.textContent.includes('1080p HD') && qualityBadge.textContent === '720p') {
      artist.textContent = artist.textContent.replace('1080p HD', '720p HD');
    } else if (artist.textContent.includes('1080p HD') && qualityBadge.textContent === '4K') {
      artist.textContent = artist.textContent.replace('1080p HD', '4K UHD');
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
      const dubTag = (aId === 'tr-dub' || aId === 'tr-ai-dub') ? 'TR Dublaj' : (aId === 'en-dub' || aId === 'en-ai-dub') ? 'EN Dublaj' : 'Orijinal';
      subPillBtn.replaceChildren(ico('subtitles'), `${subTag} · ${dubTag}`);
      subBtn.classList.toggle('active-sub', sId !== 'off' || aId !== 'orig');
    }
    const hasOrig = !!(m.officialUrl || m.catalogProvider);
    origBtn.classList.toggle('hidden', !hasOrig);
    if (hasOrig) origBtn.replaceChildren(ico('externalLink'), formatOpenInProvider(prov?.name || 'Orijinal'));
    const roomPlaying = (m.meshStateStatus || (m.playing ? 'PLAYING' : 'PAUSED')) === 'PLAYING';
    const localPaused = Boolean(
      host.adapter
      && !host.loading
      && host.adapter.isPaused?.()
      && !host.adapter.isBuffering?.()
      && !host.adapter.video?.seeking
      && !host.adapter.wantPlaying
    );
    const playing = roomPlaying && !localPaused;
    const embedOnly = host.adapter && !host.adapter.caps.overlayClicks;
    controls.classList.toggle('show', !playing && !embedOnly);
    playBtn.replaceChildren(ico(playing ? 'pause' : 'play'));
    centerPlayBtn.replaceChildren(ico(playing ? 'pause' : 'play'));
    const showCenterHud = !playing || position() < 1.5;
    centerPlayBtn.classList.toggle('is-paused', showCenterHud);
    centerHud.classList.toggle('is-paused', showCenterHud);
    theaterBtn.classList.toggle('on', Boolean(ctx.isTheaterMode?.()));
    volBtn.replaceChildren(ico(isActuallyMuted() ? 'mute' : 'volume'));
    volRange.value = String(host.volume);
    const canSeek = !host.adapter || !!host.adapter.caps.seek;
    const leader = isLeader();
    back10Btn.classList.toggle('locked', !leader);
    back10Btn.classList.toggle('disabled-control', !leader);
    fwd10Btn.classList.toggle('locked', !leader);
    fwd10Btn.classList.toggle('disabled-control', !leader);
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
    destroy: () => {
      clearInterval(tickTimer);
      clearTimeout(uiTimer);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onNativeFsChange);
      document.removeEventListener('webkitfullscreenchange', onNativeFsChange);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      document.body.classList.remove('vortex-fs');
    },
    danmaku: (msg) => {
      if (!danmakuEnabled || !msg || msg.system || !msg.text) return;
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
      syncDot.style.background = s.mode === 'inSync' || s.mode === 'paused' || s.mode === 'live' || s.mode === 'embed' ? '#27DCC8' : Math.abs(ms) < 400 ? '#f59e0b' : '#ff3b5c';
      syncText.textContent = s.mode === 'idle' || s.mode === 'live' || s.mode === 'embed' ? 'Senkron' : `${ms >= 0 ? '+' : ''}${ms}ms · Senkron`;
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
      if (ev === 'tracks-changed') {
        if (!menu.classList.contains('hidden')) renderMenuView(currentMenuView);
        update();
        return;
      }
      const vReady = (host.adapter?.video?.readyState ?? 4) >= 2;
      if (ev === 'loading' || (ev === 'buffering' && arg)) {
        loading.classList.remove('hidden');
      } else if (ev === 'ready' || ev === 'play' || (ev === 'buffering' && !arg) || (ev === 'loaded' && vReady)) {
        loading.classList.add('hidden');
        errorBox.classList.add('hidden');
        applyVideoFilter();
        host.adapter?.subs?.onTimeUpdate?.(position(), true);
      }
      if (ev === 'ended' && state.mesh?.media?.mediaType === 'tv' && isHostOnly()) {
        triggerNextEpisode();
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
