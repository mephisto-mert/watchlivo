// Rave Selection parity: provider grid + YouTube search → provider selection view → onPick(media).
// Subscription platforms (kind 'account') always use each participant's own account in the app.
import { h, icons, popup, toast, fill } from '../ui.js?v=20261118_v216';
import { PROVIDERS, PROVIDER_CATEGORIES, getProvider, parseVideoUrl, providerUsable, isNativeShell, ACCOUNT_PROVIDER_IDS } from '../providers.js?v=20261118_v216';
import { api, qs } from '../api.js?v=20261118_v216';
import { renderSearchKind, renderLinkKind, renderUploadKind, renderDesktopKind, renderAccountKind, openAccountPlatformModal, renderMusicKind, resolveMusicItem, renderDriveKind, renderRaveDjKind, renderTitleCatalogKind } from './selection-kinds.js?v=20261118_v216';
import { fetchAccounts } from '../accounts.js?v=20261118_v216';
import { profileSetup, syncGoogleYoutubeOAuth } from '../profile.js?v=20261118_v216';
import { createVoiceSearchButton } from '../voice-note.js?v=20261118_v216';
import {
  state, subscribe, isCloudAuthenticated, syncCloudUserMedia,
  getWatchHistory, getContinueWatching, clearWatchHistory, removeWatchProgress, saveWatchProgress,
  getFavorites, isFavoriteMedia, toggleFavoriteMedia,
  getMusicHistory, clearMusicHistory, getAccountStorageScope,
  getYtPrefs, isYtChannelFollowed, toggleYtChannelFollow, isYtVideoLiked, toggleYtVideoLike,
  dismissYtVideo, undoDismissYtVideo, blockYtChannel, fetchPersonalizedYtFeed, invalidateYtFeedCache,
} from '../store.js?v=20261118_v216';

// Account platforms (Netflix, Disney+ …) can only be opened inside the Watchlivo app, where each
// participant signs in with their own account. On the plain web site show the download explainer.
function accountGate(providerId) {
  if (!ACCOUNT_PROVIDER_IDS.has(providerId) || isNativeShell()) return true;
  openAccountPlatformModal(getProvider(providerId));
  return false;
}

// Re-open a history / watch-list entry. Only sources that still exist in the Rave model are
// replayed (YouTube, Drive, uploads, links, music, own-account platforms); old catalog entries
// that pointed at removed endpoints are skipped.
async function replayHistoryItem(item, resumeSec, pickFn) {
  if (!item || !pickFn) return;
  if (item.provider === 'youtube' || (item.videoId && !item.tmdbId && !item.url)) {
    const ytVid = item.videoId || item.id;
    await pickFn({
      provider: 'youtube',
      videoId: ytVid,
      url: item.url || ('https://www.youtube.com/watch?v=' + ytVid),
      title: item.title,
      thumbnail: item.poster || item.thumbnail,
      duration: item.duration || 0,
      currentTime: resumeSec,
      meshStatePosition: resumeSec,
    });
    return;
  }
  const url = String(item.url || '');
  if (!url || url.startsWith('/api/rave/')) {
    toast('Bu kayıt artık açılamıyor. Kaynağı yeniden seçerek odada başlatabilirsin.');
    return;
  }
  if (!accountGate(item.provider)) return;
  await pickFn({ ...item, url, currentTime: resumeSec, meshStatePosition: resumeSec });
}

let _activeHomePick = null;

export const parseDuration = (s) => {
  if (typeof s === 'number') return s;
  const p = String(s || '').split(':').map(Number);
  if (p.some(Number.isNaN) || !p.length) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
};

export const ytToMedia = (it) => ({
  provider: 'youtube',
  videoId: it.videoId || '',
  url: it.url || `https://www.youtube.com/watch?v=${it.videoId}`,
  title: it.title || 'YouTube Videosu',
  thumbnail: it.thumbnail || `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`,
  channel: it.channel || 'YouTube',
  channelId: it.channelId || '',
  channelAvatar: it.channelAvatar || '',
  views: it.views || '',
  published: it.published || '',
  reason: it.reason || '',
  durationText: typeof it.duration === 'string' ? it.duration : '',
  duration: parseDuration(it.duration),
  watchedPercent: Number(it.watchedPercent || 0),
  isLiked: Boolean(it.isLiked),
  isFollowedChannel: Boolean(it.isFollowedChannel),
  live: !!it.live,
});

export function attachTilt(card) {
  return card;
}

const PROVIDER_SUBTITLES = {
  youtube: 'Ara & oynat · Herkes için senkron',
  ravedj: 'AI Mashup & Ortak DJ Mix',
  drive: 'Kendi Drive dosyaların',
  music: 'Spotify · YouTube Music · Deezer',
  upload: 'Kendi video dosyan',
};

const PROVIDER_CORNER_TAGS = {
  youtube: 'DOĞRUDAN',
  ravedj: 'AI MASHUP',
  drive: 'DOĞRUDAN',
  music: 'MÜZİK',
  upload: 'DOSYA',
};

export function providerTile(p, onClick) {
  const isHero = false;
  const shortName = p.id === 'ravedj' ? 'Watchlivo DJ' : p.name;
  const subText = PROVIDER_SUBTITLES[p.id] || p.badge || 'Senkron izle';
  const cornerTag = PROVIDER_CORNER_TAGS[p.id] || (p.kind === 'account' ? 'KENDİ HESABIN' : 'SENKRON');
  let cachedRect = null;
  let rafId = 0;
  let lastX = 0;
  let lastY = 0;
  const card = h('div', {
    class: `provider-tile rave-icon-tile ${isHero ? 'hero-provider-tile' : ''}`,
    role: 'button',
    tabindex: '0',
    'data-provider': p.id,
    'data-brand': p.id,
    'data-category': p.cat || 'global',
    title: `${p.name} — ${subText}`,
    style: { '--tile-bg': p.bg || '#10121a', '--tile-accent': p.accent || '#27DCC8', '--brand': p.accent || '#27DCC8', '--spot-alpha': '0' },
    onmouseenter: (e) => {
      cachedRect = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty('--spot-alpha', '1');
    },
    onmousemove: (e) => {
      const el = e.currentTarget;
      if (!cachedRect) cachedRect = el.getBoundingClientRect();
      lastX = Math.round(e.clientX - cachedRect.left);
      lastY = Math.round(e.clientY - cachedRect.top);
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          el.style.setProperty('--mx', `${lastX}px`);
          el.style.setProperty('--my', `${lastY}px`);
        });
      }
    },
    onmouseleave: (e) => {
      cachedRect = null;
      e.currentTarget.style.setProperty('--spot-alpha', '0');
    },
    onclick: () => onClick(p),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(p); } },
  },
    h('span', { class: 'provider-corner-tag' }, cornerTag),
    h('div', { class: 'provider-logo-wrap' },
      p.logo
        ? h('img', { src: p.logo, alt: p.name, onerror: (e) => { e.target.remove(); } })
        : (p.glyph ? h('span', { class: 'p-icon', style: { background: p.accent || '#27DCC8' }, html: icons[p.glyph] }) : h('span', { style: { fontWeight: '800', fontSize: '.95rem' } }, shortName.slice(0, 2)))),
    h('div', { class: 'provider-meta' },
      h('span', { class: 'ptitle' }, shortName),
      h('span', { class: 'psub' }, subText)));

  return card;
}

const YT_CH_COLORS = ['#ef4444', '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];
function _chanColor(name) {
  let hash = 0;
  const s = String(name || 'YT');
  for (let i = 0; i < s.length; i += 1) hash = ((hash << 5) - hash) + s.charCodeAt(i);
  return YT_CH_COLORS[Math.abs(hash) % YT_CH_COLORS.length];
}

export function videoCard(media, onPick, opts = {}) {
  const prov = getProvider(media.provider);
  const isYt = media.provider === 'youtube' || Boolean(media.videoId);
  const inRoom = Boolean(window.vortexActions?.queueMusic && location.hash.startsWith('#/mesh/'));
  const durBadge = media.live ? '🔴 CANLI' : (media.durationText || (media.duration ? fmtDur(media.duration) : ''));
  const chName = media.channel || prov?.name || 'YouTube';
  const chInitials = chName.replace(/^@/, '').trim().slice(0, 2).toUpperCase() || 'YT';
  let liked = isYt ? isYtVideoLiked(media.videoId) : false;
  let followed = isYt ? isYtChannelFollowed(media.channelId, chName) : false;

  const followBtn = isYt && chName !== 'YouTube' ? h('button', {
    type: 'button',
    class: `yt-card-follow-btn ${followed ? 'active' : ''}`,
    title: followed ? 'Takipten çıkar' : `${chName} kanalını takip et`,
    onclick: (e) => {
      e.stopPropagation();
      followed = toggleYtChannelFollow({ channelId: media.channelId, name: chName, avatar: media.channelAvatar });
      followBtn.classList.toggle('active', followed);
      followBtn.textContent = followed ? '✓ Takipte' : '+ Takip';
      toast(followed ? `🔔 ${chName} takip edilen kanallarına eklendi` : `${chName} takipten çıkarıldı`);
      opts.onFollowChange?.(followed, media);
    },
  }, followed ? '✓ Takipte' : '+ Takip') : null;

  const likeBtn = isYt && media.videoId ? h('button', {
    type: 'button',
    class: `yt-card-act-btn ${liked ? 'liked' : ''}`,
    title: liked ? 'Beğenilenlerden çıkar' : 'Beğen (Önerilerini güçlendirir)',
    onclick: (e) => {
      e.stopPropagation();
      liked = toggleYtVideoLike(media);
      toggleFavoriteMedia({ ...media, provider: 'youtube' });
      likeBtn.classList.toggle('liked', liked);
      likeBtn.textContent = liked ? '❤️' : '🤍';
      toast(liked ? '❤️ Beğenilen videolara eklendi — önerilerin güncellenecek' : 'Beğeni kaldırıldı');
      opts.onLikeChange?.(liked, media);
    },
  }, liked ? '❤️' : '🤍') : null;

  const card = h('div', { class: `vcard ${isYt ? 'yt-rich-card' : ''}`, role: 'button', tabindex: '0', 'data-channel': chName.toLowerCase() },
    h('div', { class: 'vcard-thumb' },
      media.thumbnail ? h('img', { src: media.thumbnail, alt: media.title || '', loading: 'lazy', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }) : null,
      media.reason ? h('span', { class: 'yt-reason-pill' }, media.reason) : (prov?.logo && !isYt ? h('img', { class: 'vcard-prov', src: prov.logo, alt: '' }) : null),
      durBadge ? h('span', { class: `vcard-dur ${media.live ? 'is-live' : ''}` }, durBadge) : null,
      Number(media.watchedPercent || 0) > 2 ? h('div', { class: 'yt-watched-bar' }, h('div', { class: 'yt-watched-fill', style: { width: `${Math.min(100, Math.max(5, Math.round(media.watchedPercent)))}%` } })) : null,
      opts.allowDismiss && media.videoId ? h('button', {
        type: 'button',
        class: 'yt-dismiss-btn',
        title: 'İlgilenmiyorum (Akıştan gizle)',
        onclick: (e) => {
          e.stopPropagation();
          dismissYtVideo(media.videoId);
          card.style.opacity = '0';
          card.style.transform = 'scale(0.94)';
          setTimeout(() => card.remove(), 180);
          toast('✕ Video akışından gizlendi ("İlgilenmiyorum")');
          opts.onDismiss?.(media);
        },
      }, '✕') : null,
      inRoom ? h('button', {
        type: 'button',
        class: 'vcard-queue-btn',
        title: 'Oda sırasına ekle (Watch2Gether Playlist)',
        onclick: (e) => {
          e.stopPropagation();
          window.vortexActions?.queueMusic?.(media);
        },
      }, '+ Sıraya Ekle') : null),
    isYt ? h('div', { class: 'vcard-info yt-card-meta-row' },
      h('div', {
        class: 'yt-chan-avatar',
        style: { background: _chanColor(chName) },
        title: `${chName} videolarını gör`,
        onclick: opts.onChannelFilter ? (e) => { e.stopPropagation(); opts.onChannelFilter(media); } : null,
      }, media.channelAvatar ? h('img', {
        src: media.channelAvatar,
        alt: chName,
        loading: 'lazy',
        onerror: (e) => { e.currentTarget.replaceWith(document.createTextNode(chInitials)); },
      }) : chInitials),
      h('div', { class: 'yt-card-text-col' },
        h('div', { class: 'vcard-title', title: media.title }, media.title),
        h('div', { class: 'yt-card-channel-line' },
          h('span', {
            class: 'yt-card-channel-name',
            onclick: opts.onChannelFilter ? (e) => { e.stopPropagation(); opts.onChannelFilter(media); } : null,
          }, chName),
          followBtn),
        (media.views || media.published) ? h('div', { class: 'yt-card-stats-line' },
          `${media.views || ''}${media.views && media.published ? ' • ' : ''}${media.published || ''}`) : null),
      h('div', { class: 'yt-card-actions' },
        likeBtn,
        opts.allowDismiss && chName !== 'YouTube' ? h('button', {
          type: 'button',
          class: 'yt-card-act-btn mute-ch',
          title: `${chName} kanalını bir daha önerme`,
          onclick: (e) => {
            e.stopPropagation();
            blockYtChannel(media.channelId || chName);
            const gridParent = card.parentElement;
            if (gridParent) {
              gridParent.querySelectorAll(`[data-channel="${CSS.escape(chName.toLowerCase())}"]`).forEach((el) => el.remove());
            } else {
              card.remove();
            }
            toast(`🚫 ${chName} kanalı önerilerden çıkarıldı`);
          },
        }, '🚫') : null))
      : h('div', { class: 'vcard-info' }, h('div', { class: 'vcard-title' }, media.title), h('div', { class: 'vcard-sub' }, chName)));
  const go = async () => {
    if (card.querySelector('.loading')) return;
    const l = h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
    card.append(l);
    try {
      if (isYt) {
        try { saveWatchProgress({ ...media, provider: 'youtube' }, 0, media.duration || 0); } catch (e) { /* ignore */ }
      }
      await onPick(media);
    } finally { l.remove(); }
  };
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      go();
    }
  });
  return card;
}

function fmtDur(sec) {
  const s = Math.floor(sec), m = Math.floor(s / 60), hh = Math.floor(m / 60);
  return hh ? `${hh}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function desktopOnlyCard(p) {
  return h('div', { class: 'sel-desktop' },
    p.logo ? h('img', { src: p.logo, alt: p.name }) : h('h3', { style: { margin: 0 } }, p.name),
    h('b', {}, `${p.name} şu anda yalnızca Watchlivo Masaüstü sürümünde kullanılabilir.`),
    h('div', { class: 'dim', style: { fontSize: '.85em', lineHeight: 1.5 } },
      'Masaüstü uygulamasında her katılımcı kendi hesabıyla giriş yapar. Seçilen bölüm herkesin kendi aboneliğinde açılır ve oda zamanına senkronize edilir.'),
    h('a', { class: 'btn primary', href: '/download/windows', download: 'Watchlivo.exe', style: { textDecoration: 'none' } }, h('span', { html: icons.desktop }), 'Windows Masaüstü İndir (.exe)'));
}

const QUICK_TR_CHANNELS = [
  'Barış Özcan', 'Evrim Ağacı', 'Socrates Dergi',
  'netd müzik', 'Filmler ve Filimler', 'Ruhi Çenet',
];

export function openYtPersonalizeModal(onUpdated) {
  const ytEmailInp = h('input', {
    class: 'input',
    type: 'email',
    placeholder: 'Google / YouTube E-posta Adresiniz (opsiyonel, örn. ad@gmail.com)',
    autocomplete: 'email',
    value: getYtPrefs().googleEmail || ((!state.self?.isGuest && state.self?.email) ? state.self.email : ''),
  });
  const ytErrBox = h('div', {
    style: { fontSize: '.78rem', color: '#fb7185', minHeight: '18px', fontWeight: '600' },
  });
  const chInp = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Takip etmek istediğin YouTube kanal adı veya @handle yaz (örn. Barış Özcan)',
  });
  const subsWrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' } });
  const renderSubsList = () => {
    const subs = getYtPrefs().subscriptions;
    subsWrap.replaceChildren(
      ...(subs.length ? subs.map((s) => h('span', {
        class: 'yt-sub-chip',
      },
        h('span', {}, `🔔 ${s.name}`),
        h('button', {
          type: 'button',
          class: 'yt-sub-rm',
          onclick: () => {
            toggleYtChannelFollow(s);
            renderSubsList();
            onUpdated?.();
          },
        }, '×'))) : [h('span', { class: 'dim', style: { fontSize: '.78rem' } }, 'Henüz takip edilen kanal yok — aşağıdan veya kartlardaki + Takip butonuyla ekleyebilirsin.')])
    );
  };
  renderSubsList();

  const addCustomCh = () => {
    const val = chInp.value.trim();
    if (!val) return;
    toggleYtChannelFollow({ channelId: '', name: val.replace(/^@+/, '') });
    chInp.value = '';
    renderSubsList();
    toast(`🔔 ${val} takip edilen kanallara eklendi!`);
    onUpdated?.();
  };
  chInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomCh(); });

  const modalRef = popup({
    title: '🔴 YouTube & Google Hesabı ve Kanal Eşitleme',
    content: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { class: 'yt-oauth-banner', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { fontSize: '.82rem', lineHeight: '1.45', color: '#e2e8f0' } },
          '🔗 Google / YouTube hesabınızı tek tıkla OAuth penceresi üzerinden bağlayarak aboneliklerinizi ve beğenilerinizi eşitleyin:'),
        ytEmailInp,
        ytErrBox,
        h('button', {
          type: 'button',
          class: 'btn primary',
          style: { width: '100%', justifyContent: 'center', marginTop: '2px', background: '#ff0033', borderColor: '#ff0033', color: '#fff' },
          onclick: async (e) => {
            ytErrBox.textContent = '';
            const expectedEmail = ytEmailInp.value.trim();
            if (expectedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(expectedEmail)) {
              ytErrBox.textContent = '⚠️ Lütfen geçerli bir Google / YouTube e-posta adresi girin veya alanı boş bırakın.';
              ytEmailInp.focus();
              return;
            }
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = '⏳ Google OAuth Açılıyor & YouTube Eşitleniyor...';
            try {
              const res = await syncGoogleYoutubeOAuth('', expectedEmail);
              toast(`🔴 Google YouTube hesabı eşitlendi! (${res.importedSubs} abonelik, ${res.importedLikes} beğeni aktarıldı)`);
              renderSubsList();
              onUpdated?.();
              modalRef?.close?.();
            } catch (err) {
              ytErrBox.textContent = err?.message || 'Google / YouTube girişi doğrulanamadı. Lütfen tekrar deneyin.';
            } finally {
              btn.disabled = false;
              btn.textContent = '🔴 Google ile Bağlan & YouTube Hesabını Eşitle';
            }
          },
        }, '🔴 Google ile Bağlan & YouTube Hesabını Eşitle')),
      h('div', { style: { display: 'flex', gap: '8px' } },
        chInp,
        h('button', { type: 'button', class: 'btn primary', onclick: addCustomCh }, '+ Takip Et')),
      h('div', {},
        h('div', { style: { fontSize: '.76rem', fontWeight: '700', color: '#94a3b8', marginBottom: '6px' } }, 'Hızlı Kanal Ekle:'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          ...QUICK_TR_CHANNELS.map((qcName) => h('button', {
            type: 'button',
            class: 'btn sm ghost',
            onclick: () => {
              if (!isYtChannelFollowed('', qcName)) {
                toggleYtChannelFollow({ channelId: '', name: qcName });
                renderSubsList();
                toast(`🔔 ${qcName} eklendi`);
                onUpdated?.();
              }
            },
          }, `+ ${qcName}`)))),
      h('div', {},
        h('div', { style: { fontSize: '.76rem', fontWeight: '700', color: '#94a3b8', marginBottom: '4px' } }, 'Takip Ettiğin Kanallar:'),
        subsWrap)),
    options: [{ label: 'Tamam', primary: true }],
  });
}

export function createSelection({ onPick, compact = false, initialProvider = null } = {}) {
  const root = h('div', { class: 'selection fade-in' });
  let provider = initialProvider ? getProvider(initialProvider) : null;
  let superQuery = (() => {
    if (compact || initialProvider) return '';
    try { return (new URLSearchParams(window.location.search).get('q') || '').trim().slice(0, 120); } catch (_) { return ''; }
  })();
  let catFilter = 'all';
  let showAllProviders = true;
  let searchSeq = 0;

  let _lastAuthWatchSig = `${Boolean(state.self && !state.self.isGuest)}|${getAccountStorageScope()}|${state.cloudSyncedAt || 0}`;
  const _unsubHomeYt = subscribe((st) => {
    if (!root.isConnected) { _unsubHomeYt(); return; }
    const nextSig = `${Boolean(st.self && !st.self.isGuest)}|${getAccountStorageScope()}|${st.cloudSyncedAt || 0}`;
    if (nextSig !== _lastAuthWatchSig) {
      _lastAuthWatchSig = nextSig;
      if (provider?.id === 'youtube') render();
    }
  });
  const _onDocPointerDown = (ev) => {
    if (!root.isConnected) {
      document.removeEventListener('pointerdown', _onDocPointerDown, true);
      return;
    }
    const dd = root.querySelector('#wl-cmdk-dropdown');
    if (dd && dd.style.display !== 'none' && !ev.target.closest?.('.wl-cmdk-host')) {
      dd.style.display = 'none';
    }
  };
  document.addEventListener('pointerdown', _onDocPointerDown, true);
  fetchAccounts().then(() => {
    if (!provider && root.isConnected && !superQuery) {
      const activeInp = root.querySelector('input');
      if (activeInp && (document.activeElement === activeInp || activeInp.value.trim())) return;
      renderGrid();
    }
  });

  const pickSafe = async (media) => {
    const p = getProvider(media.provider);
    if (p && !providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
    if (!accountGate(media.provider)) return;
    await onPick(media);
  };
  let _unsubCloudMedia = null;
  if (!compact) {
    _activeHomePick = pickSafe;
    let lastSyncedStamp = state.cloudMediaSynced || 0;
    _unsubCloudMedia = subscribe((s) => {
      if (!root.isConnected) { _unsubCloudMedia(); return; }
      if ((s.cloudMediaSynced || 0) !== lastSyncedStamp) {
        lastSyncedStamp = s.cloudMediaSynced || 0;
        const activeInp = root.querySelector('input');
        if (!provider && !superQuery && !(activeInp && document.activeElement === activeInp)) {
          renderGrid();
        }
      }
    });
  }

  const RAVE_TOP_IDS = [
    'youtube', 'drive', 'upload', 'music', 'ravedj',
    'netflix', 'disney', 'prime', 'max', 'apple', 'exxen', 'blutv', 'gain',
    'tod', 'tabii', 'tvplus', 'puhutv', 'mubi', 'crunchyroll', 'hulu', 'paramount', 'peacock',
    'pluto', 'tubi', 'plex',
  ];

  function buildShimmerGrid(cnt = 6) {
    return h('div', { class: 'wl-shimmer-grid' },
      ...Array.from({ length: cnt }, () => h('div', { class: 'wl-shimmer-card' },
        h('div', { class: 'wl-shimmer-thumb' }),
        h('div', { class: 'wl-shimmer-line lg' }),
        h('div', { class: 'wl-shimmer-line sm' }))));
  }

  function renderGrid() {
    const prevCatScroll = root.querySelector('.provider-cat-bar')?.scrollLeft || 0;
    const input = h('input', { placeholder: "YouTube'da ara veya video bağlantısı yapıştır...", value: superQuery, 'aria-label': 'Ara' });
    const results = h('div', { class: 'super-results' });
    const run = () => { superQuery = input.value.trim(); if (superQuery) runYoutubeSearch(superQuery, results); else results.replaceChildren(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    input.addEventListener('focus', () => {
      if (window.innerHeight <= 520) {
        setTimeout(() => { try { searchEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {} }, 120);
      }
    });
    input.addEventListener('input', () => {
      if (!input.value.trim() && superQuery) {
        superQuery = '';
        results.replaceChildren();
      }
    });
    const filteredProviders = catFilter === 'all' ? PROVIDERS : PROVIDERS.filter((p) => p.cat === catFilter);
    const orderedAll = catFilter === 'all'
      ? [
          ...RAVE_TOP_IDS.map((id) => filteredProviders.find((p) => p.id === id)).filter(Boolean),
          ...filteredProviders.filter((p) => !RAVE_TOP_IDS.includes(p.id)),
        ]
      : filteredProviders;
    const defaultCap = 11;
    const isCollapsedGrid = !compact && catFilter === 'all' && !showAllProviders && orderedAll.length > defaultCap;
    const visibleProviders = isCollapsedGrid ? orderedAll.slice(0, defaultCap) : orderedAll;
    const hiddenCount = orderedAll.length - visibleProviders.length;

    const catBar = h('div', { class: `provider-cat-bar ${compact ? 'compact' : ''}` },
      ...PROVIDER_CATEGORIES.map((c) => {
        const count = c.id === 'all' ? PROVIDERS.length : PROVIDERS.filter((p) => p.cat === c.id).length;
        return h('button', {
          type: 'button',
          class: `provider-cat-pill ${catFilter === c.id ? 'active' : ''}`,
          'data-cat': c.id,
          onclick: () => { catFilter = c.id; renderGrid(); },
        }, h('span', {}, c.label), h('span', { class: 'cat-count' }, String(count)));
      }),
      !compact ? h('button', {
        type: 'button',
        id: 'btn-watch-history-pill',
        class: 'provider-cat-pill wl-history-pill',
        title: 'Kişiye Özel İzleme Geçmişim & Kaldığım Yerler',
        onclick: () => openWatchHistoryModal('all', pickSafe),
      }, h('span', {}, '🕒 İzleme Geçmişim'), h('span', { class: 'cat-count' }, String(getWatchHistory().length))) : null,
      !compact ? h('button', {
        type: 'button',
        id: 'btn-watchlist-pill',
        class: 'provider-cat-pill wl-watchlist-pill',
        title: 'Bulut Senkron İzleme Listem',
        onclick: () => openWatchHistoryModal('watchlist', pickSafe),
      }, h('span', {}, '🔖 İzleme Listem'), h('span', { class: 'cat-count' }, String(getFavorites().length))) : null,
      null);
    if (!root._catWheelBound) {
      root._catWheelBound = true;
      root.addEventListener('wheel', (e) => {
        const cb = e.target?.closest?.('.provider-cat-bar');
        if (cb && Math.abs(e.deltaY) > Math.abs(e.deltaX) && cb.scrollWidth > cb.clientWidth) {
          e.preventDefault();
          cb.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }

    const fullHistory = (!compact && !state.mesh) ? getWatchHistory() : [];
    const continueOnly = (!compact && !state.mesh) ? getContinueWatching() : [];
    const historyList = (continueOnly.length ? continueOnly : fullHistory).slice(0, 8);
    const historyRail = historyList.length ? h('section', { class: 'wl-continue-section', id: 'wl-continue-section' },
      h('div', { class: 'wl-continue-head' },
        h('div', { class: 'wl-continue-title-group' },
          h('span', { class: 'wl-continue-heading' }, continueOnly.length ? '▶ Kaldığın Yerden Devam Et' : '🕒 Son İzlediklerim'),
          h('span', { class: 'wl-continue-cloud-pill' }, isCloudAuthenticated() ? '🔒 Bulut Senkron' : '📱 Cihaz Senkron')),
        h('div', { class: 'wl-continue-actions', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            class: 'btn sm ghost',
            onclick: () => openWatchHistoryModal('all', pickSafe),
          }, `🕒 Geçmişim (${fullHistory.length})`),
          h('button', {
            type: 'button',
            class: 'btn sm ghost continue-clear-btn',
            title: 'İzleme geçmişini temizle',
            onclick: () => {
              clearWatchHistory();
              renderGrid();
              toast('🧹 Kişisel izleme geçmişin temizlendi');
            },
          }, 'Temizle ×'))),
      h('div', { class: 'wl-continue-strip' },
        ...historyList.map((item) => {
          const prov = getProvider(item.provider);
          const rawSavedSec = Number(item.currentTime ?? item.position ?? 0);
          const resumeSec = Number.isFinite(rawSavedSec) && rawSavedSec > 3 ? Math.floor(rawSavedSec) : 0;
          const durSec = Math.max(0, Math.floor(Number(item.duration || 0)));
          const pct = durSec > 30 ? Math.max(4, Math.min(99, Math.round((resumeSec / durSec) * 100))) : Math.max(6, Math.min(95, Math.round(Number(item.percent || 8))));
          const remMin = durSec > resumeSec + 60 ? Math.ceil((durSec - resumeSec) / 60) : 0;
          const epTag = item.mediaType === 'tv' ? `S${item.season || 1}:B${item.episode || 1} · ` : '';
          const subTxt = `${epTag}${resumeSec > 0 ? fmtDur(resumeSec) : 'Başlangıçta'}${remMin > 0 ? ` · ${remMin} dk kaldı` : ''}`;
          const itemKey = item.historyId || item.key || item.tmdbId || item.title;
          return h('div', {
            class: 'wl-continue-card',
            role: 'button',
            tabindex: '0',
            onkeydown: (ev) => {
              if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
                ev.preventDefault();
                ev.currentTarget.click();
              }
            },
            onclick: async (ev) => {
              const cardEl = ev.currentTarget;
              if (cardEl.classList.contains('busy')) return;
              cardEl.classList.add('busy');
              if (resumeSec > 3) toast(`⏩ ${item.title || 'Yapım'} · ${fmtDur(resumeSec)} anından devam ediliyor...`);
              try {
                await replayHistoryItem(item, resumeSec, pickSafe);
              } finally {
                cardEl.classList.remove('busy');
              }
            },
          },
            h('div', { class: 'wl-continue-thumb' },
              h('img', {
                src: (item.poster && !item.poster.includes('watchlivo-poster.svg') && !item.poster.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))
                  ? item.poster
                  : ((item.thumbnail && !item.thumbnail.includes('watchlivo-poster.svg') && !item.thumbnail.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))
                    ? item.thumbnail
                    : ((item.backdrop && !item.backdrop.includes('watchlivo-poster.svg') && !item.backdrop.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))
                      ? item.backdrop
                      : `/api/rave/poster?${qs({ tid: item.tmdbId || item.id || '', t: String(item.seriesTitle || item.title || '').replace(/\s*(?:[—–-]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon\s*\d+\.\s*Bölüm).*$/i, '').split(' — ')[0].replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '').trim() || item.title, ot: item.originalTitle || '', y: item.year || '', mt: item.mediaType || 'movie' })}`)),
                alt: item.title || '',
                loading: 'lazy',
                onerror: (e) => {
                  const cleanT = String(item.seriesTitle || item.title || '').replace(/\s*(?:[—–-]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon\s*\d+\.\s*Bölüm).*$/i, '').split(' — ')[0].replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '').trim();
                  if (!e.target.src.includes('/api/rave/poster') && cleanT) {
                    e.target.src = `/api/rave/poster?${qs({ tid: item.tmdbId || item.id || '', t: cleanT, ot: item.originalTitle || '', y: item.year || '', mt: item.mediaType || 'movie' })}`;
                  } else {
                    e.target.src = '/static/watchlivo-poster.svg';
                  }
                },
              }),
              prov?.logo ? h('span', { class: 'wl-continue-prov' }, h('img', { src: prov.logo, alt: '' })) : null,
              h('span', { class: 'wl-continue-play-ico' }, '▶'),
              h('button', {
                type: 'button',
                class: 'wl-continue-rm',
                title: 'Listeden kaldır',
                'aria-label': 'Listeden kaldır',
                onclick: (ev) => {
                  ev.stopPropagation();
                  removeWatchProgress(itemKey);
                  renderGrid();
                },
              }, '✕')),
            h('div', { class: 'wl-continue-body' },
              h('div', { class: 'wl-continue-title' }, item.title || 'Video'),
              h('div', { class: 'wl-continue-sub' }, subTxt),
              h('div', { class: 'wl-continue-prog' },
                h('div', { class: 'wl-continue-prog-fill', style: { width: `${pct}%` } }))));
        }))) : null;

    const voiceSearchBtn = createVoiceSearchButton({
      h,
      icons,
      inputEl: input,
      toast,
      onResult: () => run(),
    });
    const searchEl = h('div', { class: compact ? 'sel-search' : 'home-search wl-cmdk-host' },
      h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }),
      input,
      voiceSearchBtn,
      !compact ? h('kbd', { class: 'wl-search-kbd', title: 'Hızlı Arama (Ctrl+K)', onclick: () => input.focus() }, '⌘K') : null,
      h('button', { class: 'btn primary', onclick: run }, 'Ara'));
    if (!compact && !document._cmdkOutsideBound) {
      document._cmdkOutsideBound = true;
      document.addEventListener('pointerdown', (ev) => {
        const dd = document.getElementById('wl-cmdk-dropdown');
        if (!dd || dd.style.display === 'none') return;
        if (ev.target?.closest?.('.home-search, #wl-cmdk-dropdown')) return;
        dd.style.display = 'none';
      }, { passive: true });
    }

    const topBar = compact
      ? h('div', {}, searchEl, catBar)
      : h('div', { class: 'rave-top-bar' }, searchEl, catBar);

    const moreTile = isCollapsedGrid ? h('div', {
      class: 'provider-tile rave-icon-tile extend-tile',
      role: 'button',
      tabindex: '0',
      title: 'Tüm platformları göster',
      onclick: () => { showAllProviders = true; renderGrid(); },
      onkeydown: (e) => { if (e.key === 'Enter') { showAllProviders = true; renderGrid(); } },
    },
      h('div', { class: 'extend-plus' }, `+${hiddenCount}`),
      h('div', { class: 'provider-meta' },
        h('span', { class: 'ptitle' }, 'Tümü'),
        h('span', { class: 'psub' }, `${orderedAll.length} kaynak`))) : null;

    const gridSection = h('div', { class: 'section-row rave-providers-section' },
      !compact ? h('div', { class: 'rave-providers-head' },
        h('div', { class: 'rave-providers-title-group' },
          h('span', { class: 'rave-providers-title' }, '🎬 Birlikte ne izlemek istersin?'),
          h('span', { class: 'rave-providers-badge' }, 'Platformlar kendi hesabınla · YouTube, Drive & müzik doğrudan')),
        h('div', { class: 'rave-providers-actions' },
          catFilter === 'all' ? h('button', {
            type: 'button',
            id: 'provider-expand-btn',
            class: 'provider-head-btn',
            onclick: () => { showAllProviders = !showAllProviders; renderGrid(); },
          }, showAllProviders ? '▲ Kompakt Görünüm (12)' : `▼ Tüm Platformları Göster (${orderedAll.length})`) : null)) : null,
      h('div', { class: compact ? 'provider-grid compact' : 'provider-grid rave-home-provider-grid' },
        ...visibleProviders.map((p) => providerTile(p, (pp) => {
          if (pp.kind === 'account' && !isNativeShell()) { openAccountPlatformModal(pp); return; }
          provider = pp;
          render();
        })),
        ...(moreTile ? [moreTile] : [])));

    root.replaceChildren(
      topBar,
      results,
      ...(historyRail ? [historyRail] : []),
      gridSection);
    if (prevCatScroll > 0) catBar.scrollLeft = prevCatScroll;
    if (superQuery) runYoutubeSearch(superQuery, results);
  }

  async function runYoutubeSearch(q, box) {
    const mySearch = ++searchSeq;
    box.replaceChildren(buildShimmerGrid(6));
    const pasted = parseVideoUrl(q);
    if (pasted) { box.replaceChildren(); await pickFromUrl(q); return; }
    let data = {};
    try { data = await api(`/api/search/youtube?${qs({ q })}`, { timeout: 12000 }); } catch (e) { if (mySearch === searchSeq) box.replaceChildren(h('div', { class: 'lobby-empty' }, 'Arama başarısız oldu, tekrar dene.')); return; }
    if (mySearch !== searchSeq) return;
    const yt = (data.items || []).slice(0, 24).map(ytToMedia);
    fill(box,
      yt.length ? h('div', { class: 'section-head' }, h('h2', {}, 'YouTube'), h('span', { class: 'dim' }, `${yt.length} video`)) : null,
      yt.length ? h('div', { class: 'card-grid' }, yt.map((m) => videoCard(m, pickSafe))) : h('div', { class: 'lobby-empty' }, 'Aramanızla eşleşen video bulunamadı.'));
  }

  async function pickFromUrl(rawUrl, fallbackTitle = '') {
    const clean = String(rawUrl || '').trim();
    const url = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
    const parsed = parseVideoUrl(url);
    if (!parsed) { toast('Bu bağlantı tanınmadı'); return; }
    const p = getProvider(parsed.provider);
    if (p && !providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
    if (!accountGate(parsed.provider)) return;
    const media = await resolveMedia(parsed, fallbackTitle);
    if (media) await onPick(media);
  }

  root.pickFromUrl = pickFromUrl;
  root.resolveMedia = resolveMedia;

  function render(presetQuery) {
    if (!provider) renderGrid();
    else renderProvider(provider, presetQuery);
  }

  function renderProvider(p, presetQuery) {
    const head = h('div', { class: 'panel-head sel-prov-head', style: { '--prov-accent': p.accent || '#6366f1' } },
      h('button', { class: 'panel-close', 'aria-label': 'Geri', html: icons.back, onclick: () => { provider = null; render(); } }),
      h('div', { class: 'sel-provider-badge', style: { '--prov-accent': p.accent || '#6366f1' } },
        p.logo ? h('img', { src: p.logo, alt: p.name }) : null,
        h('h3', {}, p.name),
        p.badge ? h('span', { class: 'sel-provider-tag' }, p.badge) : null));
    const body = h('div', { class: 'sel-body' });
    root.replaceChildren(head, body);
    try { for (const sc of [root.closest('.panel-body'), root.closest('.home'), root.closest('.home-scroll'), document.scrollingElement, document.documentElement, document.body]) { if (sc) sc.scrollTop = 0; } window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    if (!providerUsable(p)) { body.append(desktopOnlyCard(p)); return; }
    if (p.kind === 'search') renderSearchKind(p, body, presetQuery, pickSafe);
    else if (p.kind === 'catalog') renderTitleCatalogKind(body, presetQuery, pickSafe);
    else if (p.kind === 'music') renderMusicKind(p, body, presetQuery, pickSafe);
    else if (p.kind === 'drive') renderDriveKind(p, body, pickSafe);
    else if (p.kind === 'ravedj') renderRaveDjKind(p, body, pickSafe);
    else if (p.kind === 'link') renderLinkKind(p, body, pickFromUrl);
    else if (p.kind === 'upload') renderUploadKind(body, pickSafe);
    else if (p.kind === 'account') renderAccountKind(p, body, pickSafe);
    else if (p.kind === 'desktop') renderDesktopKind(p, body, pickSafe);
  }

  root.render = render;
  root.setProvider = (id) => {
    const cleanId = String(id || '').trim().toLowerCase();
    if (!cleanId) {
      provider = null;
      render();
      return;
    }
    provider = getProvider(cleanId) || getProvider(id) || null;
    render();
  };
  root.openFavorites = () => openWatchHistoryModal('watchlist', pickSafe);
  root.destroy = () => {
    try { _unsubHomeYt?.(); } catch (_) {}
    try { _unsubCloudMedia?.(); } catch (_) {}
    document.removeEventListener('pointerdown', _onDocPointerDown, true);
  };
  return root;
}

const MUSIC_PROV_IDS = new Set(['music', 'ytmusic', 'spotify', 'deezer', 'applemusic', 'soundcloud']);

export async function resolveMedia(parsed, fallbackTitle = '') {
  const { provider, id, url } = parsed;
  if (MUSIC_PROV_IDS.has(provider)) {
    const p = getProvider(provider);
    return resolveMusicItem({ url, videoId: provider === 'ytmusic' ? id : '', title: fallbackTitle || `${p?.name || 'Müzik'} Parçası` }, p);
  }
  if (provider === 'youtube') return { provider, videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: fallbackTitle || 'YouTube videosu', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, channel: 'YouTube' };
  if (provider === 'twitch') return { provider, videoId: id, url: `https://www.twitch.tv/${id.startsWith('v') ? 'videos/' + id.slice(1) : (/^\d+$/.test(id) ? 'videos/' + id : id)}`, embedUrl: id.startsWith('v') ? 'https://player.twitch.tv/?video=' + id.slice(1) + '&parent=' + location.hostname : 'https://player.twitch.tv/?channel=' + id + '&parent=' + location.hostname, title: fallbackTitle || `Twitch · ${id}`, channel: 'Twitch', thumbnail: (id.startsWith('v') || /^\d+$/.test(id)) ? '' : `https://static-cdn.jtvnw.net/previews-ttv/live_user_${id.toLowerCase()}-640x360.jpg` };
  if (provider === 'kick') return { provider, videoId: id, url: `https://kick.com/${id}`, embedUrl: `https://player.kick.com/${encodeURIComponent(id)}?autoplay=true`, title: fallbackTitle || `Kick · ${id}`, channel: 'Kick', live: true };
  if (provider === 'dailymotion') return { provider, videoId: id, url: `https://www.dailymotion.com/video/${id}`, embedUrl: `https://www.dailymotion.com/embed/video/${id}`, title: fallbackTitle || `Dailymotion · ${id}`, thumbnail: `https://www.dailymotion.com/thumbnail/video/${id}`, channel: 'Dailymotion' };
  if (provider === 'tiktok') return { provider, videoId: id, url, embedUrl: `https://www.tiktok.com/embed/v2/${id}`, title: fallbackTitle || `TikTok · #${id}`, channel: 'TikTok' };
  if (provider === 'vk') return { provider: 'vk', videoId: id, url, embedUrl: `https://vk.com/video_ext.php?oid=${String(id).split('_')[0]}&id=${String(id).split('_')[1] || id}&hd=2`, title: fallbackTitle || `VK Video · ${id}`, channel: 'VK Video' };
  if (provider === 'rutube') return { provider: 'rutube', videoId: id, url, embedUrl: `https://rutube.ru/play/embed/${encodeURIComponent(id)}`, title: fallbackTitle || `Rutube · ${id}`, channel: 'Rutube' };
  if (provider === 'drive') return { provider, videoId: id, url, embedUrl: 'https://drive.google.com/file/d/' + id + '/preview', title: fallbackTitle || 'Google Drive videosu', channel: 'Google Drive', thumbnail: `https://drive.google.com/thumbnail?id=${id}&sz=w640` };
  if (provider === 'dropbox') {
    const directUrl = String(url || '').replace(/^https?:\/\/(www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/').replace(/[?&]dl=[01]/g, '');
    return { provider: 'direct', videoId: id, url: directUrl, streamType: 'mp4', title: fallbackTitle || 'Dropbox Videosu', channel: 'Dropbox' };
  }
  if (ACCOUNT_PROVIDER_IDS.has(provider)) {
    // Own-account platform: the room only carries the platform URL; every participant opens it in
    // the Watchlivo app's in-app browser with their own login. Watchlivo never fetches the stream.
    const p = getProvider(provider);
    return { provider, videoId: id, url, title: fallbackTitle || p?.name || provider, channel: `${p?.name || provider} · Kendi hesabınla`, streamType: 'official', ownAccount: true };
  }
  if (provider === 'vimeo') {
    let meta = {};
    try { meta = await api(`/api/rave/oembed?${qs({ url })}`, { timeout: 8000 }); } catch (e) { /* optional */ }
    return { provider, videoId: id, url, title: meta.title || fallbackTitle || 'Vimeo videosu', thumbnail: meta.thumbnail_url || '', channel: meta.author_name || 'Vimeo', duration: meta.duration || 0 };
  }
  if (provider === 'web') {
    // Only direct media files are played; arbitrary pages are not scraped.
    if (/\.m3u8(\?|$)/i.test(url)) return { provider: 'hls', url, streamType: 'hls', title: fallbackTitle || 'Web videosu', channel: (() => { try { return new URL(url).hostname; } catch (_) { return 'Web'; } })() };
    if (/\.(mp4|m4v|webm|mov|ogg|mp3|m4a)(\?|$)/i.test(url)) return { provider: 'direct', url, streamType: 'mp4', title: fallbackTitle || 'Web videosu', channel: (() => { try { return new URL(url).hostname; } catch (_) { return 'Web'; } })() };
    toast('Doğrudan bir .mp4 / .m3u8 video bağlantısı yapıştır (sayfa bağlantıları desteklenmez).');
    return null;
  }
  return null;
}

export function openWatchHistoryModal(initialTab = 'all', customOnPick = null) {
  let activeTab = initialTab || 'all';
  const pickFn = customOnPick || ((state.mesh && !state.mesh.curated && typeof window.vortexActions?.pickMedia === 'function') ? async (media) => { await window.vortexActions.pickMedia(media); window.vortexRestoreRoom?.(); } : null) || _activeHomePick || (async (media) => {
    try {
      let cid = state.clientId || '';
      try {
        if (!cid) {
          cid = sessionStorage.getItem('vortex_cid') || ('h_' + Math.random().toString(36).slice(2, 10));
          sessionStorage.setItem('vortex_cid', cid);
        }
      } catch (_) {}
      const created = await api('/api/rooms/create', {
        method: 'POST',
        body: {
          name: media?.title || 'İzleme Odası',
          privacy: 'friends',
          voipMode: 'all',
          playMode: 'all',
          creator: state.self?.name || 'Misafir',
          creatorId: state.self?.uid || state.self?.id || cid,
          clientId: cid,
          color: state.self?.color || '#27dcc8',
          avatarUrl: state.self?.avatarUrl || '',
          media,
        },
      });
      const targetId = created?.room?.id || created?.id;
      if (targetId) {
        try {
          if (created?.clientToken) sessionStorage.setItem('vortex_ct_' + targetId, created.clientToken);
          if (created?.clientId || cid) sessionStorage.setItem('vortex_creator_' + targetId, created?.clientId || cid);
          if (created?.room?.syncToken) sessionStorage.setItem('vortex_st_' + targetId, created.room.syncToken);
        } catch (_) {}
        if (typeof window.vortexNavigate === 'function') {
          window.vortexNavigate(`/mesh/${encodeURIComponent(targetId)}?new=1&cid=${encodeURIComponent(created?.clientId || cid)}`);
        }
      }
    } catch (_) {}
  });

  const root = h('div', { class: 'HistorySelection wl-history-hub' });
  let modalRef = null;

  const playHistoryItem = async (item) => {
    const isDone = Boolean(item.completed || Number(item.percent || 0) >= 95);
    const rawSavedSec = isDone ? 0 : Number(item.currentTime ?? item.position ?? 0);
    const resumeSec = Number.isFinite(rawSavedSec) && rawSavedSec > 3 ? Math.floor(rawSavedSec) : 0;
    modalRef?.close?.();
    if (resumeSec > 3) toast(`⏩ ${item.title || 'Yapım'} · ${fmtDur(resumeSec)} anından devam ediliyor...`);
    await replayHistoryItem(item, resumeSec, pickFn);
  };

  const renderHub = () => {
    const allHist = getWatchHistory();
    const contHist = getContinueWatching();
    const favList = getFavorites();
    const musicList = getMusicHistory();
    const me = state.self || {};
    const authed = isCloudAuthenticated();

    const tabs = [
      { id: 'all', label: `🕒 Tüm Geçmişim (${allHist.length})` },
      { id: 'continue', label: `▶ Devam Edenler (${contHist.length})` },
      { id: 'watchlist', label: `🔖 İzleme Listem (${favList.length})` },
      { id: 'music', label: `🎵 Müzik Geçmişim (${musicList.length})` },
    ];

    const body = h('div', { class: 'wl-history-body' });

    if (activeTab === 'all' || activeTab === 'continue') {
      const list = activeTab === 'continue' ? contHist : allHist;
      if (!list.length) {
        body.append(h('div', { class: 'wl-dm-empty-placeholder' },
          h('div', { style: { fontSize: '2rem' } }, '🍿'),
          h('strong', {}, activeTab === 'continue' ? 'Yarım kalan film veya dizi yok' : 'Henüz izleme geçmişin boş'),
          h('span', {}, 'Bir odaya girip film, dizi veya video açtığında yalnızca senin hesabına özel olarak buraya kaydedilir.')));
      } else {
        body.append(
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
            h('span', { style: { fontSize: '.76rem', color: 'rgba(255,255,255,0.65)' } }, `${list.length} kişisel kayıt`),
            h('button', {
              type: 'button',
              class: 'btn sm ghost',
              onclick: () => { clearWatchHistory(); renderHub(); toast('🧹 İzleme geçmişin temizlendi'); },
            }, '🧹 Tümünü Temizle')),
          ...list.map((item) => {
            const rawSavedSec = Number(item.currentTime ?? item.position ?? 0);
            const resumeSec = Number.isFinite(rawSavedSec) && rawSavedSec > 3 ? Math.floor(rawSavedSec) : 0;
            const durSec = Math.max(0, Math.floor(Number(item.duration || 0)));
            const isDone = Boolean(item.completed || Number(item.percent || 0) >= 95);
            const pct = isDone ? 100 : (durSec > 30 ? Math.max(4, Math.min(99, Math.round((resumeSec / durSec) * 100))) : Math.max(6, Math.min(94, Math.round(Number(item.percent || 10)))));
            const epTag = item.mediaType === 'tv' ? `S${item.season || 1}:B${item.episode || 1} · ` : '';
            const itemKey = item.historyId || item.key || item.tmdbId || item.title;
            const rowCleanTitle = String(item.seriesTitle || item.title || '').replace(/\s*(?:[—–-]\s*)?(?:S\d+\s*:\s*B\d+|\d+\.\s*Sezon\s*\d+\.\s*Bölüm).*$/i, '').split(' — ')[0].replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '').trim();
            const rowHistYear = item.year || (String(item.title || '').match(/\((19\d{2}|20\d{2})\)/) || [])[1] || '';
            const rowMt = item.mediaType || (/sezon|bölüm|s\d+:b\d+/i.test(String(item.title || '')) ? 'tv' : 'movie');
            const rowPoster = (item.poster && !item.poster.includes('watchlivo-poster.svg') && !item.poster.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))
              ? item.poster
              : ((item.thumbnail && !item.thumbnail.includes('watchlivo-poster.svg') && !item.thumbnail.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))
                ? item.thumbnail
                : ((item.backdrop && !item.backdrop.includes('watchlivo-poster.svg') && !item.backdrop.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))
                  ? item.backdrop
                  : `/api/rave/poster?${qs({ tid: item.tmdbId || item.id || '', t: rowCleanTitle || item.title, ot: item.originalTitle || '', y: rowHistYear, mt: rowMt })}`));
            return h('div', { class: 'wl-history-row' },
              h('img', {
                class: 'wl-history-poster',
                src: rowPoster,
                alt: item.title || '',
                onerror: (e) => {
                  if (!e.target.src.includes('/api/rave/poster') && (rowCleanTitle || item.title)) {
                    e.target.src = `/api/rave/poster?${qs({ tid: item.tmdbId || item.id || '', t: rowCleanTitle || item.title, ot: item.originalTitle || '', y: rowHistYear, mt: rowMt })}`;
                  } else {
                    e.target.src = '/static/watchlivo-poster.svg';
                  }
                },
              }),
              h('div', { class: 'wl-history-meta' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                  h('strong', { class: 'wl-history-title' }, item.title || 'Yapım'),
                  isDone
                    ? h('span', { class: 'wl-history-badge is-done' }, '✅ Tamamlandı')
                    : h('span', { class: 'wl-history-badge' }, `%${pct}`)),
                h('div', { class: 'wl-history-sub' }, `${epTag}${isDone ? 'Baştan izlemeye hazır' : (resumeSec > 0 ? `Kaldığın yer: ${fmtDur(resumeSec)}` : 'Yeni başlatıldı')}${durSec > 0 ? ` / ${fmtDur(durSec)}` : ''}`),
                h('div', { class: 'wl-continue-prog', style: { marginTop: '5px' } },
                  h('div', { class: 'wl-continue-prog-fill', style: { width: `${pct}%` } }))),
              h('div', { class: 'wl-history-actions' },
                h('button', { type: 'button', class: 'btn primary sm', onclick: () => playHistoryItem(item) }, isDone ? '↺ İzle' : '▶ Devam'),
                h('button', {
                  type: 'button',
                  class: 'btn sm ghost',
                  title: 'Geçmişten sil',
                  onclick: () => { removeWatchProgress(itemKey); renderHub(); },
                }, '✕')));
          })
        );
      }
    } else if (activeTab === 'watchlist') {
      if (!favList.length) {
        body.append(h('div', { class: 'wl-dm-empty-placeholder' },
          h('div', { style: { fontSize: '2rem' } }, '🔖'),
          h('strong', {}, 'İzleme listen henüz boş'),
          h('span', {}, 'Beğendiğin videolarda 🔖 butonuna basarak kişisel listene ekleyebilirsin.')));
      } else {
        body.append(...favList.map((fav) => h('div', { class: 'wl-history-row' },
          h('img', { class: 'wl-history-poster', src: fav.poster || fav.backdrop || '/static/watchlivo-poster.svg', alt: fav.title || '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
          h('div', { class: 'wl-history-meta' },
            h('strong', { class: 'wl-history-title' }, fav.title || 'Yapım'),
            h('div', { class: 'wl-history-sub' }, `${fav.year || '2025'} · ${fav.mediaType === 'tv' ? '📺 Dizi' : '🎬 Film'}`)),
          h('div', { class: 'wl-history-actions' },
            h('button', {
              type: 'button',
              class: 'btn primary sm',
              onclick: () => playHistoryItem(fav),
            }, '▶ Başlat'),
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { toggleFavoriteMedia(fav); renderHub(); } }, '✕')))));
      }
    } else {
      if (!musicList.length) {
        body.append(h('div', { class: 'wl-dm-empty-placeholder' }, '🎵 Müzik geçmişin boş.'));
      } else {
        body.append(
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' } },
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { clearMusicHistory(); renderHub(); } }, '🧹 Müzik Geçmişini Temizle')),
          ...musicList.map((m) => h('div', { class: 'wl-history-row' },
            h('img', { class: 'wl-history-poster', src: m.poster || m.thumbnail || '/static/watchlivo-poster.svg', alt: m.title || '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
            h('div', { class: 'wl-history-meta' },
              h('strong', { class: 'wl-history-title' }, m.title || m.songTitle || 'Parça'),
              h('div', { class: 'wl-history-sub' }, `${m.artist || ''} · ${m.genre || 'Müzik'}`)),
            h('div', { class: 'wl-history-actions' },
              h('button', {
                type: 'button',
                class: 'btn primary sm',
                onclick: async () => {
                  modalRef?.close?.();
                  const resolved = await resolveMusicItem(m, getProvider('music'));
                  if (resolved) await pickFn(resolved);
                },
              }, '▶ Dinle'))))
        );
      }
    }

    root.replaceChildren(
      h('div', { class: 'wl-history-isolation-banner' },
        h('span', {}, authed
          ? `🔒 Kişiye Özel Bulut Senkron (@${String(me.handle || me.name || 'hesap').replace(/^@+/, '')}) — Yalnızca sana görünür`
          : '📱 Bu Cihaza Özel Geçmiş — Hesabınla giriş yaparak tüm cihazlarında senkronla'),
        !authed ? h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: () => { modalRef?.close?.(); document.getElementById('nav-account-btn')?.click(); },
        }, '🔑 Giriş Yap') : null),
      h('div', { class: 'wl-history-tabs' },
        ...tabs.map((t) => h('button', {
          type: 'button',
          class: `wl-history-tab ${activeTab === t.id ? 'active' : ''}`,
          onclick: () => { activeTab = t.id; renderHub(); },
        }, t.label))),
      body
    );
  };

  renderHub();
  if (isCloudAuthenticated()) {
    syncCloudUserMedia(true).then(() => { if (root.isConnected) renderHub(); }).catch(() => {});
  }

  modalRef = popup({
    title: '🕒 Kişisel İzleme Geçmişim & Listem',
    content: root,
    dismissable: true,
    wide: true,
    options: [{ label: 'Kapat', class: 'btn' }],
  });
}

if (typeof window !== 'undefined') {
  window.vortexOpenWatchHistory = openWatchHistoryModal;
}
