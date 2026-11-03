// Rave Selection parity: provider grid + SuperSearch → provider selection view → onPick(media).
import { h, icons, popup, toast, fill } from '../ui.js?v=20261103_v92';
import { PROVIDERS, PROVIDER_CATEGORIES, getProvider, parseVideoUrl, providerUsable } from '../providers.js?v=20261103_v92';
import { api, qs } from '../api.js?v=20261103_v92';
import { renderSearchKind, renderLinkKind, renderUploadKind, renderDesktopKind, renderCatalogKind, resolveCatalogItem, renderMusicKind, resolveMusicItem, renderDriveKind, renderRaveDjKind } from './selection-kinds.js?v=20261103_v92';
import { fetchAccounts, getAccount, openProviderLoginModal, renderSeriesPicker } from '../accounts.js?v=20261103_v92';
import { profileSetup, syncGoogleYoutubeOAuth } from '../profile.js?v=20261103_v92';
import {
  state, subscribe, isCloudAuthenticated, syncCloudUserMedia,
  getWatchHistory, getContinueWatching, clearWatchHistory, removeWatchProgress, saveWatchProgress,
  getFavorites, isFavoriteMedia, toggleFavoriteMedia,
  getMusicHistory, clearMusicHistory, getAccountStorageScope,
  getYtPrefs, isYtChannelFollowed, toggleYtChannelFollow, isYtVideoLiked, toggleYtVideoLike,
  dismissYtVideo, undoDismissYtVideo, blockYtChannel, fetchPersonalizedYtFeed, invalidateYtFeedCache,
} from '../store.js?v=20261103_v92';

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

// JustWatch package names → registry ids (Rave SuperSearch offerUrls → videoProvider)
const OFFER_MAP = [
  [/netflix/i, 'netflix'], [/disney/i, 'disney'], [/amazon|prime/i, 'prime'], [/\bmax\b|hbo/i, 'max'],
  [/apple/i, 'apple'], [/mubi/i, 'mubi'], [/hulu/i, 'hulu'], [/paramount/i, 'paramount'], [/peacock/i, 'peacock'],
  [/plex/i, 'plex'], [/pluto/i, 'pluto'], [/exxen/i, 'exxen'], [/blutv/i, 'blutv'], [/gain/i, 'gain'],
  [/\btod\b|bein/i, 'tod'], [/tabii|trt/i, 'tabii'], [/tv\+|tvplus|turkcell/i, 'tvplus'], [/puhu/i, 'puhutv'],
  [/crunchyroll/i, 'crunchyroll'], [/youtube/i, 'youtube'], [/tubi/i, 'tubi'], [/vimeo/i, 'vimeo'],
];
const offerProvider = (name) => (OFFER_MAP.find(([re]) => re.test(name)) || [])[1] || null;

export function attachTilt(card) {
  return card;
}

const PROVIDER_SUBTITLES = {
  cinema: 'Film · Dizi · Anime · 4K HDR',
  youtube: 'Video, Müzik & Canlı Yayın',
  ravedj: 'AI Mashup & Ortak DJ Mix',
  drive: 'Bulut 1080p MKV & MP4',
  netflix: '4K HDR · TR Dublaj & Altyazı',
  disney: 'Star Wars · Marvel · Pixar 4K',
  prime: 'Amazon Originals · 4K UHD',
  max: 'HBO · Harry Potter · LOTR 4K',
  apple: 'Apple Originals · 4K Dolby',
  exxen: 'Gibi · Konuşanlar · Yerli Şov',
  blutv: 'Behzat Ç. · İlk ve Son · HBO',
  gain: 'Ayak İşleri · 10 Bin Adım',
  tod: 'beIN Originals · Yerli & Global',
  tabii: 'Gassal · TRT Orijinal Yapımlar',
  tvplus: 'Yerli Sinema & Vizyon 4K',
  puhutv: 'Şahsiyet · Yeşilçam Klasikleri',
  mubi: 'Festival & Bağımsız Sinema',
  crunchyroll: '4K Anime · Fansub & Dublaj',
  hulu: 'FX Originals & Yabancı Dizi',
  paramount: 'Showtime & Gişe Filmleri',
  peacock: 'NBC Universal & Sitcom 4K',
  vk: 'HD Sinema & Dizi Akışı',
  rutube: 'HD Video & Sinema',
  pluto: 'Ücretsiz Sinema & TV',
  tubi: 'Ücretsiz Gişe & Klasikler',
};

const PROVIDER_CORNER_TAGS = {
  cinema: '4K ARŞİV',
  youtube: 'CANLI & 4K',
  ravedj: 'AI MASHUP',
  drive: 'DIRECT HD',
  netflix: '4K DUBLAJ',
  disney: '4K IMAX',
  prime: '4K UHD',
  max: 'HBO 4K',
  apple: '4K HDR',
  exxen: 'YERLİ HD',
  blutv: 'YERLİ 4K',
  gain: 'ORİJİNAL',
  tod: 'YERLİ & FİLM',
  tabii: 'TRT ORİJİNAL',
  tvplus: 'VİZYON HD',
  puhutv: 'YEŞİLÇAM & DİZİ',
  mubi: 'KÜLT SİNEMA',
  crunchyroll: 'ANİME 4K',
  hulu: 'FX & DİZİ',
  paramount: 'SİNEMA 4K',
  peacock: 'STÜDYO HD',
  vk: 'HD AKIŞ',
  pluto: '7/24 FİLM',
  tubi: 'ÜCRETSİZ',
};

export function providerTile(p, onClick) {
  const isHero = p.id === 'cinema';
  const shortName = p.id === 'cinema' ? 'Sinema+' : (p.id === 'ravedj' ? 'Watchlivo DJ' : p.name);
  const subText = PROVIDER_SUBTITLES[p.id] || p.badge || '4K Senkron İzle';
  const cornerTag = PROVIDER_CORNER_TAGS[p.id] || (p.cat === 'tr' ? 'YERLİ' : '4K HD');
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
    style: { '--tile-bg': p.bg || '#10121a', '--tile-accent': p.id === 'cinema' ? '#f59e0b' : (p.accent || '#27DCC8'), '--brand': p.id === 'cinema' ? '#f59e0b' : (p.accent || '#27DCC8'), '--spot-alpha': '0' },
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
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
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

const HERO_DEFAULT_POOL = [
  { id: '27205', tmdbId: '27205', mediaType: 'movie', title: 'Başlangıç', originalTitle: 'Inception', year: '2010', rating: '8.4', overview: 'Hedeflerinin bilinçaltına sızarak kurumsal casusluk yapan yetenekli bir hırsız olan Cobb\'a, imkansız olduğu düşünülen bir görev karşılığında eski hayatını geri kazanma şansı sunulur.', backdrop: 'https://image.tmdb.org/t/p/w780/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg', poster: 'https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg' },
  { id: '550', tmdbId: '550', mediaType: 'movie', title: 'Dövüş Kulübü', originalTitle: 'Fight Club', year: '1999', rating: '8.4', overview: 'Uykusuzluk çeken bir ofis çalışanı ile umursamaz bir sabun satıcısı, yeraltında gizli bir dövüş kulübü kurar.', backdrop: 'https://image.tmdb.org/t/p/w780/hZkgoQYus5vegHoetLkCJzb17zJ.jpg', poster: 'https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg' },
  { id: '438631', tmdbId: '438631', mediaType: 'movie', title: 'Dune: Çöl Gezegeni', originalTitle: 'Dune', year: '2021', rating: '8.0', overview: 'Uzak bir gelecekte ailesi çöl gezegeni Arrakis\'in yönetimini devralan Paul Atreides, galaksinin en değerli kaynağını korumak için destansı bir mücadeleye girer.', backdrop: 'https://image.tmdb.org/t/p/w780/jYEW5xZkZk2WTrdbMGAPFuBqbDc.jpg', poster: 'https://image.tmdb.org/t/p/w500/d5NXSklXo0qyIYkgV94XAgMIckC.jpg' },
  { id: '157336', tmdbId: '157336', mediaType: 'movie', title: 'Yıldızlararası', originalTitle: 'Interstellar', year: '2014', rating: '8.4', overview: 'İnsanlığın geleceğini kurtarmak için bir solucan deliğinden geçerek yıldızlararası yolculuğa çıkan kaşiflerin hikayesi.', backdrop: 'https://image.tmdb.org/t/p/w780/xJHokMbljvjADYdit5fK5VQsXEG.jpg', poster: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg' },
  { id: '155', tmdbId: '155', mediaType: 'movie', title: 'Kara Şövalye', originalTitle: 'The Dark Knight', year: '2008', rating: '8.5', overview: 'Batman, Teğmen Gordon ve Savcı Harvey Dent, Gotham sokaklarını kaosa sürükleyen Joker\'e karşı amansız bir mücadeleye girişir.', backdrop: 'https://image.tmdb.org/t/p/w780/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg', poster: 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg' },
  { id: '872585', tmdbId: '872585', mediaType: 'movie', title: 'Oppenheimer', originalTitle: 'Oppenheimer', year: '2023', rating: '8.1', overview: 'Amerikalı bilim insanı J. Robert Oppenheimer\'ın Manhattan Projesi ve atom bombasının geliştirilmesindeki rolünü konu alır.', backdrop: 'https://image.tmdb.org/t/p/w780/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg', poster: 'https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg' },
  { id: '68718', tmdbId: '68718', mediaType: 'movie', title: 'Zincirsiz', originalTitle: 'Django Unchained', year: '2012', rating: '8.2', overview: 'Alman bir ödül avcısının yardımıyla özgürlüğüne kavuşan Django, eşini acımasız bir çiftlik sahibinden kurtarmak için yola çıkar.', backdrop: 'https://image.tmdb.org/t/p/w780/2oZklIzUbvZXXzIFzv7Hi68d6xf.jpg', poster: 'https://image.tmdb.org/t/p/w500/7oWY8VDWW7thTzWh3OKYRkWUlD5.jpg' },
  { id: '475557', tmdbId: '475557', mediaType: 'movie', title: 'Joker', originalTitle: 'Joker', year: '2019', rating: '8.1', overview: 'Toplum tarafından dışlanan başarısız komedyen Arthur Fleck, Gotham şehrinde adım adım suç ve kaosun sembolüne dönüşür.', backdrop: 'https://image.tmdb.org/t/p/w780/n6bUvigpRFqSwmPp1m2YADdbRBc.jpg', poster: 'https://image.tmdb.org/t/p/w500/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg' },
  { id: '634649', tmdbId: '634649', mediaType: 'movie', title: 'Örümcek-Adam: Eve Dönüş Yok', originalTitle: 'Spider-Man: No Way Home', year: '2021', rating: '8.0', overview: 'Kimliği açığa çıkan Peter Parker, Doktor Strange\'den yardım ister ancak büyü ters gidince çoklu evrenden düşmanlar ortaya çıkar.', backdrop: 'https://image.tmdb.org/t/p/w780/14QbnygCuTO0vl7CAFmPf1fgZfV.jpg', poster: 'https://image.tmdb.org/t/p/w500/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg' },
  { id: '66732', tmdbId: '66732', mediaType: 'tv', title: 'Stranger Things', originalTitle: 'Stranger Things', year: '2016', rating: '8.6', overview: 'Küçük bir kasabada küçük bir çocuğun gizemli şekilde kaybolması, doğaüstü güçleri ve gizli deneyleri gün yüzüne çıkarır.', backdrop: 'https://image.tmdb.org/t/p/w780/56v2KjBlU4XaOv9rVYEQypROD7P.jpg', poster: 'https://image.tmdb.org/t/p/w500/uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg' },
];

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}


const QUICK_TR_CHANNELS = [
  'Barış Özcan', 'Evrim Ağacı', 'Socrates Dergi',
  'netd müzik', 'Filmler ve Filimler', 'Ruhi Çenet',
];

export function openYtPersonalizeModal(onUpdated) {
  if (!state.self || state.self.isGuest) {
    profileSetup({
      current: state.self,
      initialTab: 'login',
      onDone: () => { invalidateYtFeedCache(); onUpdated?.(); },
    });
    return;
  }
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
    title: '🔴 Kişiselleştirilmiş YouTube Akışı & Kanal Eşitleme',
    content: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { class: 'yt-oauth-banner' },
        h('div', { style: { fontSize: '.82rem', lineHeight: '1.45', color: '#e2e8f0' } },
          `Hesabın (@${state.self.handle || state.self.name}) ile izlediğin videolar, beğenilerin, aramaların ve takip ettiğin kanallar otomatik olarak bulutta saklanır ve akışını şekillendirir.`),
        h('button', {
          type: 'button',
          class: 'btn primary',
          style: { width: '100%', justifyContent: 'center', marginTop: '8px', background: '#ff0033', borderColor: '#ff0033', color: '#fff' },
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = '⏳ Google YouTube Hesabın Eşitleniyor...';
            try {
              const res = await syncGoogleYoutubeOAuth();
              toast(`🔴 Google YouTube eşitlendi! (${res.importedSubs} abonelik, ${res.importedLikes} beğeni aktarıldı)`);
              renderSubsList();
              onUpdated?.();
              modalRef?.close?.();
            } catch (err) {
              toast('Google penceresi kapatıldı veya izin verilmedi — aşağıdan dilediğin kanalı tek tıkla ekleyebilirsin.');
            } finally {
              btn.disabled = false;
              btn.textContent = '🔴 Google Hesabından YouTube Abonelik & Beğenileri Eşitle';
            }
          },
        }, '🔴 Google Hesabından YouTube Abonelik & Beğenileri Eşitle')),
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
  let superQuery = '';
  let catFilter = 'all';
  let showAllProviders = true;
  let showTrending = false;
  let trendingItems = shuffleArray(HERO_DEFAULT_POOL);
  let trendingFetched = false;
  let trendingLoading = false;
  let heroIndex = 0;
  let autoRotateEnabled = true;
  let heroHovered = false;
  let autoRotateTicks = 0;
  let autoRotateTimer = null;
  let superSearchSeq = 0;
  let ytHomeChip = 'all';
  let ytHomeExpanded = false;
  let ytHomeData = null;
  let ytHomeSeq = 0;
  let ytLastScope = '';
  const ytHomeMount = h('div', { id: 'wl-yt-home-mount' });

  function renderYtHomeDOM(loading = false) {
    if (compact || state.mesh) { ytHomeMount.replaceChildren(); return; }
    const signedIn = Boolean(state.self && !state.self.isGuest);
    if (!signedIn) {
      ytHomeMount.replaceChildren(
        h('section', { class: 'wl-yt-guest-cta' },
          h('div', { class: 'wl-yt-guest-left' },
            h('span', { class: 'wl-yt-play-pill' }, '▶'),
            h('div', {},
              h('div', { class: 'wl-yt-guest-title' }, 'Senin İçin Kişiselleştirilmiş YouTube Akışı'),
              h('div', { class: 'wl-yt-guest-sub' }, 'Hesabınla giriş yaptığında aynı YouTube gibi izleme geçmişine, beğenilerine ve takip ettiğin kanallara özel videolar burada otomatik açılır.'))),
          h('button', {
            type: 'button',
            class: 'btn primary sm',
            onclick: () => profileSetup({ current: state.self, initialTab: 'login', onDone: () => refreshYtHomeSection(true) }),
          }, '🔑 Giriş Yap & Aç'))
      );
      return;
    }
    const uHandle = state.self.handle ? `@${state.self.handle}` : (state.self.name || 'Hesabın');
    const chips = ytHomeData?.chips?.length ? ytHomeData.chips : [
      { id: 'all', label: 'Tümü' },
      { id: 'for_you', label: '✨ Sana Özel' },
      { id: 'subscriptions', label: '🔔 Takip Edilenler' },
      { id: 'recent', label: '🆕 Yeni Yüklenenler' },
      { id: 'music', label: '🎵 Müzik' },
      { id: 'cinema', label: '🎬 Sinema & Fragman' },
      { id: 'gaming', label: '🎮 Oyun' },
    ];
    const allItems = (ytHomeData?.items || []).map(ytToMedia);
    const visibleItems = ytHomeExpanded ? allItems.slice(0, 24) : allItems.slice(0, 8);
    ytHomeMount.replaceChildren(
      h('section', { class: 'wl-yt-home-section', id: 'wl-yt-home-section' },
        h('div', { class: 'wl-yt-home-head' },
          h('div', { class: 'wl-yt-home-title-wrap' },
            h('span', { class: 'wl-yt-play-pill' }, '▶'),
            h('div', {},
              h('div', { class: 'wl-yt-home-heading' },
                h('span', {}, 'Senin İçin Önerilenler'),
                h('span', { class: 'wl-yt-user-badge' }, uHandle),
                h('span', { class: 'wl-yt-adfree-badge' }, '🛡️ Reklamsız 1080p')),
              h('div', { class: 'wl-yt-home-sub' },
                ytHomeData?.personalized
                  ? 'İzleme geçmişin, beğenilerin ve takip ettiğin kanallara göre canlı güncellenir'
                  : 'İzledikçe, beğendikçe ve kanal takip ettikçe akışın tamamen sana özel şekillenir'))),
          h('div', { class: 'wl-yt-home-actions' },
            h('button', {
              type: 'button',
              class: 'btn sm ghost',
              onclick: () => openYtPersonalizeModal(() => refreshYtHomeSection(true)),
            }, '🔗 Kanal & Google Eşitle'),
            h('button', {
              type: 'button',
              class: 'btn sm ghost',
              title: 'Önerileri yenile',
              onclick: () => refreshYtHomeSection(true),
            }, '🔄 Yenile'),
            h('button', {
              type: 'button',
              class: 'btn sm primary',
              onclick: () => { provider = getProvider('youtube'); render(); },
            }, 'Tüm YouTube →'))),
        h('div', { class: 'yt-chip-bar' },
          ...chips.map((ch) => h('button', {
            type: 'button',
            class: `yt-filter-chip ${ytHomeChip === ch.id ? 'active' : ''}`,
            onclick: () => {
              ytHomeChip = ch.id;
              refreshYtHomeSection(false, true);
            },
          }, ch.label))),
        loading && !visibleItems.length
          ? buildShimmerGrid(4)
          : (visibleItems.length
              ? h('div', { class: 'card-grid yt-feed-grid' },
                  ...visibleItems.map((m) => videoCard(m, pickSafe, {
                    allowDismiss: true,
                    onChannelFilter: (med) => {
                      ytHomeChip = `ch:${med.channelId || ''}:${med.channel || ''}`;
                      refreshYtHomeSection(false, true);
                    },
                  })))
              : h('div', { class: 'lobby-empty' }, 'Bu filtrede henüz video bulunamadı — başka bir kategori seçebilir veya kanal ekleyebilirsin.')),
        allItems.length > 8 ? h('div', { class: 'wl-yt-more-row' },
          h('button', {
            type: 'button',
            class: 'btn sm ghost',
            onclick: () => { ytHomeExpanded = !ytHomeExpanded; renderYtHomeDOM(false); },
          }, ytHomeExpanded ? '▲ Daha Az Göster' : `▼ Daha Fazla Sana Özel Video Göster (${Math.min(24, allItems.length)})`)) : null)
    );
  }

  async function refreshYtHomeSection(force = false, chipChanged = false) {
    if (compact || state.mesh) { ytHomeMount.replaceChildren(); return; }
    const signedIn = Boolean(state.self && !state.self.isGuest);
    if (!signedIn) {
      ytHomeData = null;
      ytLastScope = '';
      renderYtHomeDOM(false);
      return;
    }
    const curScope = `${getAccountStorageScope()}|${ytHomeChip}`;
    if (!force && !chipChanged && ytHomeData && ytLastScope === curScope) {
      renderYtHomeDOM(false);
      return;
    }
    const seqId = ++ytHomeSeq;
    if (chipChanged) ytHomeData = { ...(ytHomeData || {}), items: [] };
    renderYtHomeDOM(true);
    try {
      const data = await fetchPersonalizedYtFeed(ytHomeChip, force);
      if (seqId !== ytHomeSeq) return;
      ytHomeData = data;
      ytLastScope = curScope;
      renderYtHomeDOM(false);
    } catch (e) {
      if (seqId === ytHomeSeq) renderYtHomeDOM(false);
    }
  }

  let _lastAuthWatchSig = `${Boolean(state.self && !state.self.isGuest)}|${getAccountStorageScope()}|${state.cloudSyncedAt || 0}`;
  const _unsubHomeYt = subscribe((st) => {
    if (!root.isConnected) { _unsubHomeYt(); return; }
    const nextSig = `${Boolean(st.self && !st.self.isGuest)}|${getAccountStorageScope()}|${st.cloudSyncedAt || 0}`;
    if (nextSig !== _lastAuthWatchSig) {
      _lastAuthWatchSig = nextSig;
      if (!provider && !superQuery && !compact) refreshYtHomeSection(true);
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

  function updateHeroBannerInPlace() {
    const heroEl = root.querySelector('.gazestream-hero');
    if (!heroEl) return;
    const heroPool = trendingItems.length ? trendingItems : HERO_DEFAULT_POOL;
    if (!heroPool.length) return;
    const safeHeroIdx = ((heroIndex % heroPool.length) + heroPool.length) % heroPool.length;
    const heroItem = heroPool[safeHeroIdx] || HERO_DEFAULT_POOL[0];
    const trendTag = heroEl.querySelector('.hero-trending-tag span:last-child');
    if (trendTag) trendTag.textContent = `Şimdi Trend (${safeHeroIdx + 1}/${heroPool.length}) — 4K Senkron Sinema Vitrini`;
    const catTags = heroEl.querySelectorAll('.hero-category-tags .tag-badge');
    if (catTags[0]) catTags[0].textContent = heroItem.mediaType === 'tv' ? '📺 Popüler Dizi' : '🎬 Sinema Filmi';
    if (catTags[1]) catTags[1].textContent = `⭐ IMDb ${heroItem.rating || '8.3'}`;
    const mainTitle = heroEl.querySelector('.hero-main-title');
    if (mainTitle) {
      mainTitle.textContent = `${heroItem.title}${heroItem.year && !String(heroItem.title).includes(heroItem.year) ? ` (${heroItem.year})` : ''}`;
    }
    const synopsis = heroEl.querySelector('.hero-synopsis');
    if (synopsis) {
      synopsis.textContent = heroItem.overview || 'Arkadaşlarınızla aynı anda, tek kare gecikmesiz 1080p/4K film, dizi ve anime izleyin.';
    }
    const watchBtnSpans = heroEl.querySelectorAll('.btn-watch-cyan span');
    if (watchBtnSpans[0]) watchBtnSpans[0].textContent = heroItem.mediaType === 'tv' ? '📺' : '▶';
    if (watchBtnSpans[1]) watchBtnSpans[1].textContent = heroItem.mediaType === 'tv' ? 'Sezon & Bölüm Seç' : 'Odaya Katıl & Şimdi İzle';
    const artImg = heroEl.querySelector('.hero-main-img');
    if (artImg) {
      const nextSrc = heroItem.backdrop || heroItem.poster || 'https://images.unsplash.com/photo-1534447677768-be436bb09401?q=80&w=1000&auto=format&fit=crop';
      if (artImg.src !== nextSrc) {
        artImg.style.opacity = '0.35';
        artImg.src = nextSrc;
        artImg.alt = heroItem.title;
        setTimeout(() => { artImg.style.opacity = '1'; }, 120);
      }
    }
    const rowEl = heroEl.querySelector('.hero-showcase-row');
    const cards = heroEl.querySelectorAll('.hero-mini-card');
    cards.forEach((c, idx) => {
      const isAct = idx === safeHeroIdx;
      c.classList.toggle('active', isAct);
      if (isAct && rowEl) {
        const targetLeft = Math.max(0, c.offsetLeft - (rowEl.clientWidth / 2) + (c.clientWidth / 2));
        rowEl.scrollTo({ left: targetLeft, behavior: 'smooth' });
      }
    });
  }

  function startShowcaseAutoRotation() {
    if (autoRotateTimer || compact) return;
    autoRotateTimer = setInterval(async () => {
      if (!root.isConnected) {
        clearInterval(autoRotateTimer);
        autoRotateTimer = null;
        return;
      }
      if (compact || provider || superQuery || heroHovered || !autoRotateEnabled) return;
      const heroPool = trendingItems.length ? trendingItems : HERO_DEFAULT_POOL;
      if (!heroPool.length) return;
      heroIndex = (heroIndex + 1) % heroPool.length;
      autoRotateTicks += 1;
      if (autoRotateTicks % 10 === 0 && !trendingLoading) {
        await ensureTrending(false);
        if (!provider && !superQuery && root.isConnected) renderGrid();
        return;
      }
      updateHeroBannerInPlace();
    }, 5500);
  }
  if (!compact) startShowcaseAutoRotation();

  const pickSafe = async (media) => {
    const p = getProvider(media.provider);
    if (p && !providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
    await onPick(media);
  };
  if (!compact) {
    _activeHomePick = pickSafe;
    let lastSyncedStamp = state.cloudMediaSynced || 0;
    subscribe((s) => {
      if (!root.isConnected) return;
      if ((s.cloudMediaSynced || 0) !== lastSyncedStamp) {
        lastSyncedStamp = s.cloudMediaSynced || 0;
        const activeInp = root.querySelector('input');
        if (!provider && !superQuery && !(activeInp && document.activeElement === activeInp)) {
          renderGrid();
        }
      }
    });
  }

  async function ensureTrending(forceShuffle = false) {
    if (trendingLoading) return trendingItems;
    trendingLoading = true;
    try {
      const res = await api(`/api/rave/catalog?provider=cinema&shuffle=1&limit=36&_t=${Date.now()}`, { timeout: 10000 });
      const fetched = (res.items || []).filter((x) => x && x.title && (x.poster || x.backdrop));
      if (fetched.length) {
        const seenIds = new Set(fetched.map((x) => String(x.tmdbId || x.id || x.title)));
        const merged = [
          ...shuffleArray(fetched),
          ...shuffleArray(HERO_DEFAULT_POOL).filter((d) => !seenIds.has(String(d.tmdbId || d.id || d.title))),
        ];
        trendingItems = merged.slice(0, 36);
        trendingFetched = true;
        if (forceShuffle) heroIndex = 0;
      } else if (forceShuffle) {
        trendingItems = shuffleArray(trendingItems.length ? trendingItems : HERO_DEFAULT_POOL);
        heroIndex = 0;
      }
    } catch (e) {
      trendingItems = shuffleArray(trendingItems.length ? trendingItems : HERO_DEFAULT_POOL);
      trendingFetched = true;
      if (forceShuffle) heroIndex = 0;
    } finally {
      trendingLoading = false;
    }
    return trendingItems;
  }

  async function shuffleShowcaseUI(btnEl) {
    const prevTxt = btnEl ? btnEl.textContent : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '🎲 Karıştırılıyor...';
    }
    try {
      await ensureTrending(true);
      if (!provider && root.isConnected) renderGrid();
      toast('🎲 Arşivden yeni vitrin önerileri getirildi!');
    } finally {
      if (btnEl && btnEl.isConnected) {
        btnEl.disabled = false;
        btnEl.textContent = prevTxt || '🎲 Vitrini Karıştır';
      }
    }
  }

  async function pickRandomMovie(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '🎲 Seçiliyor...'; }
    try {
      let items = [];
      try {
        const provId = (provider && provider.kind === 'catalog') ? provider.id : 'cinema';
        const res = await api(`/api/rave/catalog?${qs({ provider: provId, shuffle: 1, limit: 36, _t: Date.now() })}`, { timeout: 10000 });
        items = res.items || [];
      } catch (e) { /* fallback to trending */ }
      if (!items.length) items = await ensureTrending(true);
      const movies = items.filter((it) => it.mediaType !== 'tv');
      const pool = movies.length ? movies : items;
      if (!pool.length) { toast('Katalog yüklenemedi, lütfen tekrar dene'); return; }
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      toast(`🎲 Rastgele Seçim: ${chosen.title} hazırlanıyor...`);
      const defProv = provider || getProvider(chosen.provider || 'cinema') || { id: 'cinema', name: 'Sinema, Dizi & Anime+' };
      const media = await resolveCatalogItem(chosen, defProv, 1, 1);
      if (media) await pickSafe(media);
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🎲 Rastgele Film'; }
    }
  }

  const RAVE_TOP_IDS = [
    'cinema', 'youtube', 'ravedj', 'drive',
    'netflix', 'disney', 'prime', 'max', 'apple', 'exxen', 'blutv', 'gain',
    'tod', 'tabii', 'tvplus', 'puhutv', 'mubi', 'crunchyroll', 'hulu', 'paramount', 'peacock', 'ytmusic',
    'vk', 'rutube', 'pluto', 'tubi',
  ];

  function buildShimmerGrid(cnt = 6) {
    return h('div', { class: 'wl-shimmer-grid' },
      ...Array.from({ length: cnt }, () => h('div', { class: 'wl-shimmer-card' },
        h('div', { class: 'wl-shimmer-thumb' }),
        h('div', { class: 'wl-shimmer-line lg' }),
        h('div', { class: 'wl-shimmer-line sm' }))));
  }

  function openMoviePreviewModal(t, defProv, onAction) {
    const isTv = t.mediaType === 'tv' || t.type === 'SHOW';
    const banner = t.backdrop || t.poster || '/static/watchlivo-poster.svg';
    const poster = t.poster || t.backdrop || '/static/watchlivo-poster.svg';
    let modalRef = null;
    const body = h('div', { class: 'wl-preview-modal' },
      h('div', { class: 'wl-preview-backdrop', style: { backgroundImage: `url("${banner}")` } },
        h('div', { class: 'wl-preview-blur-mask' })),
      h('div', { class: 'wl-preview-content' },
        h('img', { class: 'wl-preview-poster', src: poster, alt: t.title, onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
        h('div', { class: 'wl-preview-info' },
          h('div', { class: 'wl-preview-badges' },
            h('span', { class: 'wl-preview-tag type' }, isTv ? '📺 DİZİ / ANİME' : '🎬 SİNEMA FİLMİ'),
            t.year ? h('span', { class: 'wl-preview-tag' }, String(t.year)) : null,
            h('span', { class: 'wl-preview-tag rating' }, `⭐ IMDb ${t.rating || '8.2'}`),
            h('span', { class: 'wl-preview-tag tr' }, '🇹🇷 Dublaj & Altyazı')),
          h('h3', { class: 'wl-preview-title' }, t.title),
          h('p', { class: 'wl-preview-desc' }, t.overview || 'Watchlivo arşivinde 1080p/4K kalitesinde Türkçe dublaj ve altyazı seçenekleriyle arkadaşlarınla senkronize izle.'),
          h('div', { class: 'wl-preview-actions' },
            h('button', {
              type: 'button',
              class: 'btn primary wl-preview-play-btn',
              onclick: async () => {
                modalRef?.close?.();
                if (onAction) await onAction();
              },
            }, isTv ? '📺 Sezon & Bölüm Seç' : '▶ Şimdi Odada Başlat'),
            h('button', {
              type: 'button',
              class: `btn wl-preview-fav-btn ${isFavoriteMedia(t) ? 'primary' : 'ghost'}`,
              onclick: (ev) => {
                const added = toggleFavoriteMedia({ ...t, provider: defProv?.id || t.provider || 'cinema' });
                ev.currentTarget.className = `btn wl-preview-fav-btn ${added ? 'primary' : 'ghost'}`;
                ev.currentTarget.textContent = added ? '✓ İzleme Listemde' : '🔖 Listeme Ekle';
                const pillCnt = root.querySelector('#btn-watchlist-pill .cat-count');
                if (pillCnt) pillCnt.textContent = String(getFavorites().length);
                toast(added ? `🔖 ${t.title} İzleme Listene eklendi` : `${t.title} listeden çıkarıldı`);
              },
            }, isFavoriteMedia(t) ? '✓ İzleme Listemde' : '🔖 Listeme Ekle'),
            h('button', {
              type: 'button',
              class: 'btn ghost',
              onclick: () => modalRef?.close?.(),
            }, 'Kapat')))));
    modalRef = popup({ title: '', content: body, options: [] });
  }

  function renderGrid() {
    const input = h('input', { placeholder: 'Film, dizi, anime veya doğrudan video bağlantısı ara...', value: superQuery, 'aria-label': 'Ara' });
    const results = h('div', { class: 'super-results' });
    const cmdkDropdown = h('div', { class: 'wl-cmdk-dropdown', id: 'wl-cmdk-dropdown', style: { display: 'none' } });
    let cmdkTimer = null;
    let cmdkSeq = 0;
    let cmdkSelectedIdx = -1;
    let cmdkTriggers = [];
    const hideCmdk = () => { cmdkDropdown.style.display = 'none'; cmdkSelectedIdx = -1; cmdkTriggers = []; };
    const syncCmdkSelection = () => {
      const rows = cmdkDropdown.querySelectorAll('.wl-cmdk-item');
      rows.forEach((r, idx) => r.classList.toggle('is-selected', idx === cmdkSelectedIdx));
      if (cmdkSelectedIdx >= 0 && rows[cmdkSelectedIdx]) {
        rows[cmdkSelectedIdx].scrollIntoView({ block: 'nearest' });
      }
    };
    const run = () => { hideCmdk(); superQuery = input.value.trim(); if (superQuery) runSuperSearch(superQuery, results); else results.replaceChildren(); };
    input.addEventListener('keydown', (e) => {
      if (cmdkDropdown.style.display !== 'none' && cmdkTriggers.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          cmdkSelectedIdx = (cmdkSelectedIdx + 1) % cmdkTriggers.length;
          syncCmdkSelection();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          cmdkSelectedIdx = (cmdkSelectedIdx - 1 + cmdkTriggers.length) % cmdkTriggers.length;
          syncCmdkSelection();
          return;
        }
        if (e.key === 'Enter' && cmdkSelectedIdx >= 0 && cmdkTriggers[cmdkSelectedIdx]) {
          e.preventDefault();
          cmdkTriggers[cmdkSelectedIdx]();
          return;
        }
      }
      if (e.key === 'Enter') run();
      else if (e.key === 'Escape') hideCmdk();
    });
    input.addEventListener('input', () => {
      clearTimeout(cmdkTimer);
      const q = input.value.trim();
      if (compact || q.length < 2 || parseVideoUrl(q)) {
        hideCmdk();
        return;
      }
      const myCmdk = ++cmdkSeq;
      cmdkDropdown.style.display = 'block';
      cmdkDropdown.replaceChildren(
        h('div', { class: 'wl-cmdk-head' }, h('span', {}, `⚡ "${q}" aranıyor...`), h('span', { class: 'wl-cmdk-esc', onclick: hideCmdk }, 'ESC ×')),
        h('div', { class: 'wl-cmdk-skeleton-list' },
          ...Array.from({ length: 4 }, () => h('div', { class: 'wl-cmdk-skel-row' },
            h('div', { class: 'wl-cmdk-skel-poster' }),
            h('div', { class: 'wl-cmdk-skel-lines' }, h('span', {}), h('span', {})))))
      );
      cmdkTimer = setTimeout(async () => {
        try {
          const data = await api(`/api/rave/supersearch?${qs({ q })}`, { timeout: 10000 });
          if (myCmdk !== cmdkSeq || input.value.trim() !== q) return;
          const items = [...(data.tmdb || []), ...(data.justwatch || [])].filter((x) => x && x.title).slice(0, 7);
          if (!items.length) {
            cmdkDropdown.replaceChildren(
              h('div', { class: 'wl-cmdk-head' }, h('span', {}, `Sonuç bulunamadı: "${q}"`), h('span', { class: 'wl-cmdk-esc', onclick: hideCmdk }, 'ESC ×'))
            );
            return;
          }
          cmdkSelectedIdx = -1;
          cmdkTriggers = [];
          cmdkDropdown.replaceChildren(
            h('div', { class: 'wl-cmdk-head' },
              h('span', {}, `⚡ Hızlı Sonuçlar (${items.length}) · ↑↓ Seç`),
              h('button', { type: 'button', class: 'wl-cmdk-all-btn', onclick: run }, 'Tüm Sonuçları Gör →'),
              h('span', { class: 'wl-cmdk-esc', onclick: hideCmdk }, 'ESC ×')),
            h('div', { class: 'wl-cmdk-list' },
              ...items.map((it, rowIdx) => {
                const isTv = it.mediaType === 'tv' || it.type === 'SHOW';
                const defProv = getProvider(it.provider || 'cinema') || getProvider('cinema');
                const normalized = { ...it, tmdbId: String(it.tmdbId || it.id || '') };
                const triggerPlay = async () => {
                  hideCmdk();
                  if (isTv) {
                    openTvSeriesModal(normalized, defProv);
                  } else {
                    toast(`🎬 ${it.title} hazırlanıyor...`);
                    const media = await resolveCatalogItem(normalized, defProv, 1, 1);
                    if (media) await pickSafe(media);
                  }
                };
                cmdkTriggers.push(triggerPlay);
                return h('div', {
                  class: 'wl-cmdk-item',
                  onmouseenter: () => { cmdkSelectedIdx = rowIdx; syncCmdkSelection(); },
                  onclick: triggerPlay,
                },
                  h('img', { class: 'wl-cmdk-poster', src: it.poster || '/static/watchlivo-poster.svg', alt: it.title, onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
                  h('div', { class: 'wl-cmdk-meta wl-cmdk-info' },
                    h('div', { class: 'wl-cmdk-title' }, it.title),
                    h('div', { class: 'wl-cmdk-sub' }, `${it.year || '2025'} · ${isTv ? '📺 Dizi / Anime' : '🎬 Sinema Filmi'} · 🇹🇷 TR Dublaj & Altyazı`)),
                  h('button', {
                    type: 'button',
                    class: 'wl-cmdk-preview-btn',
                    title: 'Sinematik Önizleme',
                    onclick: (ev) => { ev.stopPropagation(); hideCmdk(); openMoviePreviewModal(normalized, defProv, triggerPlay); },
                  }, '✨ Detay'),
                  h('span', { class: 'wl-cmdk-action' }, isTv ? '📺 Bölüm Seç' : '▶ Başlat'));
              }))
          );
        } catch (err) {
          hideCmdk();
        }
      }, 240);
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
        onclick: () => root.openFavorites(),
      }, h('span', {}, '🔖 İzleme Listem'), h('span', { class: 'cat-count' }, String(getFavorites().length))) : null,
      !compact ? h('button', {
        type: 'button',
        id: 'btn-trending-toggle',
        class: `provider-cat-pill trend-pill ${showTrending ? 'active' : ''}`,
        onclick: async () => {
          showTrending = !showTrending;
          if (showTrending && !trendingItems.length) await ensureTrending();
          renderGrid();
        },
      }, '🔥 Ne İzlesek?') : null,
      !compact ? h('button', {
        type: 'button',
        id: 'btn-random-movie',
        class: 'provider-cat-pill random-pill',
        onclick: (e) => pickRandomMovie(e.currentTarget),
      }, '🎲 Rastgele Film') : null);

    const openTvSeriesModal = (tvItem, tvProv) => {
      const box = h('div', { style: { minHeight: '340px' } });
      const modalRef = popup({
        title: `📺 ${tvItem.title} — Sezon & Bölüm Seç`,
        content: box,
        wide: true,
        options: [{ label: 'Kapat' }],
      });
      renderSeriesPicker(
        tvItem,
        tvProv || getProvider('cinema') || { id: 'cinema', name: 'Sinema, Dizi & Anime+' },
        box,
        () => modalRef?.close?.(),
        async (media) => { modalRef?.close?.(); await pickSafe(media); },
        resolveCatalogItem
      );
    };

    const trendingRail = !compact && showTrending && trendingItems.length ? h('div', { class: 'trending-strip' },
      h('div', { class: 'trending-strip-head' },
        h('span', { class: 'trending-strip-title' }, '🔥 Arşivden Karışık Öneriler (Tek Tıkla Odaya Aç)'),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('button', { type: 'button', class: 'btn sm', onclick: (e) => shuffleShowcaseUI(e.currentTarget) }, '🎲 Yenile & Karıştır'),
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { showTrending = false; renderGrid(); } }, 'Kapat ×'))),
      h('div', { class: 'trending-strip-row' },
        ...trendingItems.map((item) => {
          const prov = getProvider(item.provider || 'netflix') || { id: 'netflix', name: 'Netflix' };
          return h('div', {
            class: 'trending-mini-card',
            role: 'button',
            tabindex: '0',
            onclick: async (e) => {
              if (item.mediaType === 'tv') {
                openTvSeriesModal(item, prov);
                return;
              }
              const cardEl = e.currentTarget;
              if (cardEl.classList.contains('busy')) return;
              cardEl.classList.add('busy');
              toast(`🎬 ${item.title} hazırlanıyor...`);
              try {
                const media = await resolveCatalogItem(item, prov, 1, 1);
                if (media) await pickSafe(media);
              } finally {
                cardEl.classList.remove('busy');
              }
            },
          },
            h('img', { src: item.poster || item.backdrop || '/static/watchlivo-poster.svg', alt: item.title, loading: 'lazy', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
            h('div', { class: 'trending-mini-info' },
              h('div', { class: 't-title' }, item.title),
              h('div', { class: 't-sub' }, `${item.year || '2025'} · ⭐ ${item.rating || '8.4'} · 🇹🇷 TR`)));
        }))) : null;

    const fullHistory = (!compact && !state.mesh) ? getWatchHistory() : [];
    const continueOnly = (!compact && !state.mesh) ? getContinueWatching() : [];
    const historyList = (continueOnly.length ? continueOnly : fullHistory).slice(0, 8);
    const historyRail = historyList.length ? h('section', { class: 'wl-continue-section', id: 'wl-continue-section' },
      h('div', { class: 'wl-continue-head' },
        h('div', { class: 'wl-continue-title-group' },
          h('span', { class: 'wl-continue-heading' }, continueOnly.length ? '▶ Kaldığın Yerden Devam Et' : '🕒 Son İzlediklerim'),
          h('span', { class: 'wl-continue-cloud-pill' }, isCloudAuthenticated() ? '🔒 Hesabına Özel Bulut Senkron' : '📱 Bu Cihaza Özel')),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            class: 'btn sm ghost',
            onclick: () => openWatchHistoryModal('all', pickSafe),
          }, `🕒 Tüm Geçmişim (${fullHistory.length})`),
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
          const prov = getProvider(item.catalogProvider || item.provider || 'cinema');
          const rawSavedSec = Number(item.currentTime ?? item.position ?? 0);
          const resumeSec = Number.isFinite(rawSavedSec) && rawSavedSec > 3 ? Math.floor(rawSavedSec) : 0;
          const durSec = Math.max(0, Math.floor(Number(item.duration || 0)));
          const pct = durSec > 30 ? Math.max(4, Math.min(99, Math.round((resumeSec / durSec) * 100))) : Math.max(6, Math.min(95, Math.round(Number(item.percent || 8))));
          const remMin = durSec > resumeSec + 60 ? Math.ceil((durSec - resumeSec) / 60) : 0;
          const epTag = item.mediaType === 'tv' ? `S${item.season || 1}:B${item.episode || 1} · ` : '';
          const subTxt = `${epTag}${resumeSec > 0 ? fmtDur(resumeSec) : '0:00'}${remMin > 0 ? ` · ${remMin} dk kaldı` : ''}`;
          const itemKey = item.historyId || item.key || item.tmdbId || item.title;
          return h('div', {
            class: 'wl-continue-card',
            role: 'button',
            tabindex: '0',
            onclick: async (ev) => {
              const cardEl = ev.currentTarget;
              if (cardEl.classList.contains('busy')) return;
              cardEl.classList.add('busy');
              if (resumeSec > 3) toast(`⏩ ${item.title || 'Yapım'} · ${fmtDur(resumeSec)} anından devam ediliyor...`);
              try {
                if (item.tmdbId) {
                  const resolved = await resolveCatalogItem({ tmdbId: item.tmdbId, imdbId: item.imdbId, mediaType: item.mediaType, title: String(item.title || '').split(' — ')[0], backdrop: item.backdrop || item.thumbnail, poster: item.poster || item.thumbnail, year: item.year || '' }, prov || { id: 'cinema', name: 'Sinema+' }, item.season || 1, item.episode || 1);
                  if (resolved) {
                    resolved.currentTime = resumeSec;
                    resolved.meshStatePosition = resumeSec;
                    await pickSafe(resolved);
                    return;
                  }
                }
                await pickSafe({ ...item, currentTime: resumeSec, meshStatePosition: resumeSec });
              } finally {
                cardEl.classList.remove('busy');
              }
            },
          },
            h('div', { class: 'wl-continue-thumb' },
              h('img', { src: item.poster || item.thumbnail || item.backdrop || '/static/watchlivo-poster.svg', alt: item.title || '', loading: 'lazy', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
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
              h('div', { class: 'wl-continue-title' }, item.title || 'Sinema'),
              h('div', { class: 'wl-continue-sub' }, subTxt),
              h('div', { class: 'wl-continue-prog' },
                h('div', { class: 'wl-continue-prog-fill', style: { width: `${pct}%` } }))));
        }))) : null;

    const searchEl = h('div', { class: compact ? 'sel-search' : 'home-search wl-cmdk-host' },
      h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }),
      input,
      !compact ? h('kbd', { class: 'wl-search-kbd', title: 'Hızlı Arama (Ctrl+K)', onclick: () => input.focus() }, '⌘K') : null,
      h('button', { class: 'btn primary', onclick: run }, 'Ara'),
      !compact ? cmdkDropdown : null);

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
        h('span', { class: 'psub' }, `${orderedAll.length} Stüdyo & Arşiv`))) : null;

    const heroPool = trendingItems.length ? trendingItems : HERO_DEFAULT_POOL;
    const safeHeroIdx = ((heroIndex % heroPool.length) + heroPool.length) % heroPool.length;
    const heroItem = heroPool[safeHeroIdx] || HERO_DEFAULT_POOL[0];
    if (!trendingFetched && !trendingLoading && !compact) {
      ensureTrending().then(() => {
        if (!provider && root.isConnected && !superQuery) {
          const activeInp = root.querySelector('input');
          if (activeInp && (document.activeElement === activeInp || activeInp.value.trim())) {
            updateHeroBannerInPlace();
            return;
          }
          renderGrid();
        }
      });
    }

    const heroStripRow = h('div', { class: 'hero-showcase-row' },
      ...heroPool.map((item, idx) => {
        const isActive = idx === safeHeroIdx;
        const isTvItem = item.mediaType === 'tv';
        const prov = getProvider(item.provider || 'cinema') || { id: 'cinema', name: 'Sinema, Dizi & Anime+' };
        const ctaLabel = isTvItem ? '📺 Bölüm Seç' : '▶ Odada Başlat';
        return h('div', {
          class: `hero-mini-card ${isActive ? 'active' : ''}`,
          role: 'button',
          tabindex: '0',
          onclick: () => {
            heroIndex = idx;
            updateHeroBannerInPlace();
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              heroIndex = idx;
              updateHeroBannerInPlace();
            }
          },
        },
          h('img', {
            src: item.poster || item.backdrop || '/static/watchlivo-poster.svg',
            alt: item.title,
            loading: 'lazy',
            onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; },
          }),
          h('div', { class: 'hero-mini-body' },
            h('div', { class: 'hero-mini-title' }, item.title),
            h('div', { class: 'hero-mini-meta' }, `${item.year || '2024'} · ⭐ ${item.rating || '8.2'}`),
            h('button', {
              type: 'button',
              class: 'hero-mini-play',
              onclick: async (e) => {
                e.stopPropagation();
                if (isTvItem) {
                  openTvSeriesModal(item, prov);
                  return;
                }
                const btnEl = e.currentTarget;
                if (btnEl.disabled) return;
                btnEl.disabled = true;
                btnEl.textContent = '⏳ Açılıyor...';
                toast(`🎬 ${item.title} odası hazırlanıyor...`);
                try {
                  const media = await resolveCatalogItem(item, prov, 1, 1);
                  if (media) await pickSafe(media);
                } finally {
                  btnEl.disabled = false;
                  btnEl.textContent = ctaLabel;
                }
              },
            }, ctaLabel)));
      }));

    const heroBanner = (!compact && !superQuery && showTrending) ? h('div', {
      class: 'gazestream-hero hero-with-rail',
      onmouseenter: () => { heroHovered = true; },
      onmouseleave: () => { heroHovered = false; },
    },
      h('div', { class: 'hero-stage-top' },
        h('div', { class: 'hero-left-info' },
          h('div', { class: 'hero-trending-tag' },
            h('span', {}, '🔥'),
            h('span', {}, `Şimdi Trend (${safeHeroIdx + 1}/${heroPool.length}) — 4K Senkron Sinema Vitrini`)),
          h('div', { class: 'hero-category-tags' },
            h('span', { class: 'tag-badge' }, heroItem.mediaType === 'tv' ? '📺 Popüler Dizi' : '🎬 Sinema Filmi'),
            h('span', { class: 'tag-badge' }, `⭐ IMDb ${heroItem.rating || '8.3'}`),
            h('span', { class: 'tag-badge' }, '4K HDR'),
            h('span', { class: 'tag-badge' }, '🇹🇷 Türkçe Dublaj & Altyazı')),
          h('h1', { class: 'hero-main-title' }, `${heroItem.title}${heroItem.year && !String(heroItem.title).includes(heroItem.year) ? ` (${heroItem.year})` : ''}`),
          h('p', { class: 'hero-synopsis' }, heroItem.overview || 'Arkadaşlarınızla aynı anda, tek kare gecikmesiz 1080p/4K film, dizi ve anime izleyin.'),
          h('div', { class: 'hero-btn-row' },
            h('button', {
              type: 'button',
              class: 'btn-watch-cyan',
              onclick: async (e) => {
                const defProv = getProvider('cinema') || { id: 'cinema', name: 'Sinema, Dizi & Anime+' };
                const curPool = trendingItems.length ? trendingItems : HERO_DEFAULT_POOL;
                const curIdx = ((heroIndex % curPool.length) + curPool.length) % curPool.length;
                const activeHero = curPool[curIdx] || heroItem;
                if (activeHero.mediaType === 'tv') {
                  openTvSeriesModal(activeHero, defProv);
                  return;
                }
                const btn = e.currentTarget;
                btn.disabled = true;
                toast(`🎬 ${activeHero.title} odası hazırlanıyor...`);
                try {
                  const media = await resolveCatalogItem(activeHero, defProv, 1, 1);
                  if (media) await pickSafe(media);
                } finally {
                  btn.disabled = false;
                }
              },
            },
              h('span', {}, heroItem.mediaType === 'tv' ? '📺' : '▶'),
              h('span', {}, heroItem.mediaType === 'tv' ? 'Sezon & Bölüm Seç' : 'Odaya Katıl & Şimdi İzle')),
            h('button', {
              type: 'button',
              class: 'btn-download-glass',
              onclick: () => {
                provider = getProvider('cinema');
                render();
              },
            }, '🎬 Sinema+ Kataloğu Aç'),
            h('button', {
              type: 'button',
              id: 'btn-shuffle-hero',
              class: 'btn-download-glass hero-shuffle-btn',
              title: 'Arşivden vitrini rastgele karıştır',
              onclick: (e) => shuffleShowcaseUI(e.currentTarget),
            }, '🎲 Vitrini Karıştır'),
            h('button', {
              type: 'button',
              class: 'btn-download-glass hero-nav-btn',
              title: 'Önceki',
              onclick: () => {
                heroIndex = (heroIndex - 1 + heroPool.length) % heroPool.length;
                updateHeroBannerInPlace();
                setTimeout(() => {
                  const row = root.querySelector('.hero-showcase-row');
                  const card = root.querySelector('.hero-mini-card.active');
                  if (row && card) row.scrollTo({ left: card.offsetLeft - row.clientWidth / 2 + card.clientWidth / 2, behavior: 'smooth' });
                }, 20);
              },
            }, '‹ Önceki'),
            h('button', {
              type: 'button',
              class: 'btn-download-glass hero-nav-btn',
              title: 'Sonraki',
              onclick: () => {
                heroIndex = (heroIndex + 1) % heroPool.length;
                updateHeroBannerInPlace();
                setTimeout(() => {
                  const row = root.querySelector('.hero-showcase-row');
                  const card = root.querySelector('.hero-mini-card.active');
                  if (row && card) row.scrollTo({ left: card.offsetLeft - row.clientWidth / 2 + card.clientWidth / 2, behavior: 'smooth' });
                }, 20);
              },
            }, 'Sonraki ›'))),
        h('div', { class: 'hero-art-stage' },
          h('img', {
            class: 'hero-main-img',
            src: heroItem.backdrop || heroItem.poster || 'https://images.unsplash.com/photo-1534447677768-be436bb09401?q=80&w=1000&auto=format&fit=crop',
            alt: heroItem.title,
            onerror: (e) => { e.target.src = 'https://images.unsplash.com/photo-1534447677768-be436bb09401?q=80&w=1000&auto=format&fit=crop'; },
          }))),
      h('div', { class: 'hero-showcase-strip' },
        h('div', { class: 'hero-showcase-head' },
          h('span', { class: 'hero-showcase-title' }, `🎬 Vitrin Önerileri (${heroPool.length} Karışık Film, Dizi & Anime)`),
          h('div', { class: 'hero-showcase-arrows' },
            h('button', {
              type: 'button',
              id: 'btn-auto-showcase',
              class: `btn sm ${autoRotateEnabled ? 'primary' : 'ghost'}`,
              title: 'Vitrini otomatik döndür / duraklat',
              onclick: (e) => {
                autoRotateEnabled = !autoRotateEnabled;
                e.currentTarget.className = `btn sm ${autoRotateEnabled ? 'primary' : 'ghost'}`;
                e.currentTarget.textContent = autoRotateEnabled ? '⏱ Otomatik: Açık' : '⏸ Otomatik: Durdu';
              },
            }, autoRotateEnabled ? '⏱ Otomatik: Açık' : '⏸ Otomatik: Durdu'),
            h('button', {
              type: 'button',
              id: 'btn-shuffle-showcase',
              class: 'btn sm primary',
              title: 'Arşivden yeni rastgele vitrin önerileri getir',
              onclick: (e) => shuffleShowcaseUI(e.currentTarget),
            }, '🎲 Karıştır'),
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { heroStripRow.scrollBy({ left: -420, behavior: 'smooth' }); } }, '◀'),
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { heroStripRow.scrollBy({ left: 420, behavior: 'smooth' }); } }, '▶'),
            h('button', { type: 'button', class: 'btn sm', onclick: () => { provider = getProvider('cinema'); render(); } }, 'Tümünü Gör →'))),
        heroStripRow)) : null;

    const gridSection = h('div', { class: 'section-row rave-providers-section' },
      !compact ? h('div', { class: 'rave-providers-head' },
        h('div', { class: 'rave-providers-title-group' },
          h('span', { class: 'rave-providers-title' }, '🎬 Yayın Platformları & Stüdyolar'),
          h('span', { class: 'rave-providers-badge' }, `${PROVIDERS.length} Platform · Film, Dizi & Anime`)),
        h('div', { class: 'rave-providers-actions' },
          h('button', {
            type: 'button',
            class: 'provider-head-btn primary',
            onclick: () => { provider = getProvider('cinema'); render(); },
          }, '🍿 Sinema+ Ana Arşivi Aç'),
          catFilter === 'all' ? h('button', {
            type: 'button',
            id: 'provider-expand-btn',
            class: 'provider-head-btn',
            onclick: () => { showAllProviders = !showAllProviders; renderGrid(); },
          }, showAllProviders ? '▲ Kompakt Görünüm (12)' : `▼ Tüm Platformları Göster (${orderedAll.length})`) : null)) : null,
      h('div', { class: compact ? 'provider-grid compact' : 'provider-grid rave-home-provider-grid' },
        ...visibleProviders.map((p) => providerTile(p, (pp) => { provider = pp; render(); }, () => renderGrid())),
        ...(moreTile ? [moreTile] : [])));

    const showYtHome = !compact && !state.mesh && !superQuery && (catFilter === 'all' || catFilter === 'social');
    root.replaceChildren(
      topBar,
      results,
      ...(heroBanner ? [heroBanner] : []),
      ...(trendingRail ? [trendingRail] : []),
      ...(historyRail ? [historyRail] : []),
      ...(showYtHome ? [ytHomeMount] : []),
      gridSection);
    if (showYtHome) refreshYtHomeSection(false);
    if (superQuery) runSuperSearch(superQuery, results);
  }

  async function runSuperSearch(q, box) {
    const mySearch = ++superSearchSeq;
    box.replaceChildren(buildShimmerGrid(6));
    const pasted = parseVideoUrl(q);
    if (pasted) { box.replaceChildren(); await pickFromUrl(q); return; }
    let data = {};
    try { data = await api(`/api/rave/supersearch?${qs({ q })}`, { timeout: 15000 }); } catch (e) { if (mySearch === superSearchSeq) box.replaceChildren(h('div', { class: 'lobby-empty' }, 'Arama başarısız oldu, tekrar dene.')); return; }
    if (mySearch !== superSearchSeq) return;
    const tmdb = (data.tmdb || []).slice(0, 40);
    const titles = tmdb.length ? [] : (data.justwatch || []).filter((t) => t.title).slice(0, 24);
    const yt = (data.youtube || []).slice(0, 12).map(ytToMedia);
    const hasAny = Boolean(tmdb.length || titles.length || yt.length);
    fill(box,
      tmdb.length || titles.length ? h('div', { class: 'section-head' }, h('h2', {}, 'Film ve Diziler'), h('span', { class: 'dim' }, 'Sezon / Bölüm veya Tam Film seç')) : null,
      tmdb.length || titles.length ? h('div', { class: 'poster-grid' }, [...tmdb.map((t) => posterCard({ ...t, tmdbId: String(t.id || ''), offers: [] }, box)), ...titles.map((t) => posterCard(t, box))]) : null,
      yt.length ? h('div', { class: 'section-head' }, h('h2', {}, 'YouTube'), h('span', { class: 'dim' }, `${yt.length} video`)) : null,
      yt.length ? h('div', { class: 'card-grid' }, yt.map((m) => videoCard(m, pickSafe))) : (!hasAny ? h('div', { class: 'lobby-empty' }, 'Aramanızla eşleşen içerik bulunamadı.') : null));
  }

  function posterCard(t, box) {
    const offers = t.offers || [];
    const provs = [...new Set(offers.map((o) => offerProvider(o.provider)).filter(Boolean))];
    const defProv = getProvider(t.provider || provs[0] || 'cinema') || getProvider('cinema');
    const isTv = t.mediaType === 'tv' || t.type === 'SHOW';
    const card = h('div', { class: 'poster catalog-card', role: 'button', tabindex: '0' },
      h('div', { class: 'poster-thumb-wrap' },
        h('img', {
          src: t.poster || (t.title ? `/api/rave/poster?${qs({ t: t.title || '', ot: t.originalTitle || '', y: t.year || '', mt: isTv ? 'tv' : 'movie' })}` : '/static/watchlivo-poster.svg'),
          alt: t.title || '',
          loading: 'lazy',
          onerror: (e) => {
            const el = e.currentTarget || e.target;
            if (!el.dataset.healed && t.title) {
              el.dataset.healed = '1';
              el.src = `/api/rave/poster?${qs({ t: t.title || '', ot: t.originalTitle || '', y: t.year || '', mt: isTv ? 'tv' : 'movie' })}`;
            } else {
              el.src = '/static/watchlivo-poster.svg';
            }
          },
        }),
        defProv?.logo ? h('span', { class: 'poster-prov-badge' }, h('img', { src: defProv.logo, alt: defProv.name })) : null),
      h('div', { class: 'pt' }, `${t.title}${t.year ? ` (${t.year})` : ''}`),
      h('div', { class: 'offers' },
        h('span', {}, isTv ? '📺 DİZİ' : '🎬 FİLM'),
        ...(provs.length ? provs.slice(0, 2) : [defProv?.id || 'cinema']).map((id) => h('span', {}, getProvider(id)?.name || id))),
      h('button', { class: 'btn primary poster-cta' }, isTv ? '📺 Bölüm Seç' : '▶ Tam Film'));
    const go = async () => {
      if (isTv && box) {
        renderSeriesPicker(t, defProv, box, () => runSuperSearch(superQuery, box), pickSafe, resolveCatalogItem);
        return;
      }
      if (card.querySelector('.loading')) return;
      const l = h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
      card.append(l);
      try {
        const media = await resolveCatalogItem(t, defProv, 1, 1);
        if (media) await pickSafe(media);
      } finally { l.remove(); }
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return card;
  }

  async function pickFromUrl(rawUrl, fallbackTitle = '') {
    const clean = String(rawUrl || '').trim();
    const url = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
    const parsed = parseVideoUrl(url);
    if (!parsed) { toast('Bu bağlantı tanınmadı'); return; }
    const p = getProvider(parsed.provider);
    if (p && !providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
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
        p.badge ? h('span', { class: 'sel-provider-tag' }, p.badge) : null),
      !compact ? h('button', {
        type: 'button',
        id: 'btn-random-movie',
        class: 'provider-cat-pill random-pill',
        style: { marginLeft: 'auto' },
        onclick: (e) => pickRandomMovie(e.currentTarget),
      }, '🎲 Rastgele Film') : null);
    const body = h('div', { class: 'sel-body' });
    root.replaceChildren(head, body);
    try { for (const sc of [root.closest('.panel-body'), root.closest('.home'), root.closest('.home-scroll'), document.scrollingElement, document.documentElement, document.body]) { if (sc) sc.scrollTop = 0; } window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    if (!providerUsable(p)) { body.append(desktopOnlyCard(p)); return; }
    if (p.kind === 'search') renderSearchKind(p, body, presetQuery, pickSafe);
    else if (p.kind === 'music') renderMusicKind(p, body, presetQuery, pickSafe);
    else if (p.kind === 'drive') renderDriveKind(p, body, pickSafe);
    else if (p.kind === 'ravedj') renderRaveDjKind(p, body, pickSafe);
    else if (p.kind === 'link') renderLinkKind(p, body, pickFromUrl);
    else if (p.kind === 'upload') renderUploadKind(body, pickSafe);
    else if (p.kind === 'catalog') renderCatalogKind(p, body, presetQuery, pickSafe, pickFromUrl);
    else if (p.kind === 'desktop') renderDesktopKind(p, body, pickSafe);
  }

  root.render = render;
  root.setProvider = (id) => { provider = id ? getProvider(id) : null; render(); };
  root.openFavorites = () => {
    provider = getProvider('cinema');
    if (provider) provider._initialCat = 'favs';
    render();
    setTimeout(() => {
      const favTab = root.querySelector('.cat-tab-pill[data-cat="favs"]');
      if (favTab) favTab.click();
    }, 60);
  };
  return root;
}

const CATALOG_IDS = new Set([
  'cinema', 'hdfilmcehennemi', 'dizibox', 'dizilife', 'fullhdfilm', 'yabancidizi',
  'netflix', 'disney', 'prime', 'max', 'apple', 'mubi', 'hulu', 'paramount', 'peacock',
  'plex', 'pluto', 'exxen', 'blutv', 'gain', 'tod', 'tabii', 'tvplus', 'puhutv', 'crunchyroll', 'tubi',
]);
const MUSIC_PROV_IDS = new Set(['music', 'ytmusic', 'spotify', 'deezer', 'applemusic', 'soundcloud']);

export async function resolveMedia(parsed, fallbackTitle = '') {
  const { provider, id, url } = parsed;
  if (MUSIC_PROV_IDS.has(provider)) {
    const p = getProvider(provider);
    return resolveMusicItem({ url, videoId: provider === 'ytmusic' ? id : '', title: fallbackTitle || `${p?.name || 'Müzik'} Parçası` }, p);
  }
  if (provider === 'youtube') return { provider, videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: fallbackTitle || 'YouTube videosu', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, channel: 'YouTube' };
  if (provider === 'twitch') return { provider, videoId: id, url: `https://www.twitch.tv/${/^\d+$/.test(id) ? 'videos/' + id : id}`, title: fallbackTitle || `Twitch · ${id}`, channel: 'Twitch', thumbnail: /^\d+$/.test(id) ? '' : `https://static-cdn.jtvnw.net/previews-ttv/live_user_${id.toLowerCase()}-640x360.jpg` };
  if (provider === 'kick') return { provider, videoId: id, url: `https://kick.com/${id}`, embedUrl: `https://player.kick.com/${encodeURIComponent(id)}?autoplay=true`, title: fallbackTitle || `Kick · ${id}`, channel: 'Kick', live: true };
  if (provider === 'dailymotion') return { provider, videoId: id, url: `https://www.dailymotion.com/video/${id}`, embedUrl: `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(id)}&autoplay=1`, title: fallbackTitle || `Dailymotion · ${id}`, thumbnail: `https://www.dailymotion.com/thumbnail/video/${id}`, channel: 'Dailymotion' };
  if (provider === 'tiktok') return { provider, videoId: id, url, embedUrl: `https://www.tiktok.com/player/v1/${encodeURIComponent(id)}?autoplay=1&rel=0`, title: fallbackTitle || `TikTok · #${id}`, channel: 'TikTok' };
  if (provider === 'vk') return { provider: 'vk', videoId: id, url, embedUrl: `https://vk.com/video_ext.php?oid=${String(id).split('_')[0]}&id=${String(id).split('_')[1] || id}&hd=2`, title: fallbackTitle || `VK Video · ${id}`, channel: 'VK Video' };
  if (provider === 'rutube') return { provider: 'rutube', videoId: id, url, embedUrl: `https://rutube.ru/play/embed/${encodeURIComponent(id)}`, title: fallbackTitle || `Rutube · ${id}`, channel: 'Rutube' };
  if (provider === 'drive') return { provider, videoId: id, url, title: fallbackTitle || 'Google Drive videosu', channel: 'Google Drive', thumbnail: `https://drive.google.com/thumbnail?id=${id}&sz=w640` };
  if (provider === 'dropbox') {
    const directUrl = String(url || '').replace(/^https?:\/\/(www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/').replace(/[?&]dl=[01]/g, '');
    return { provider: 'direct', videoId: id, url: directUrl, streamType: 'mp4', title: fallbackTitle || 'Dropbox Videosu', channel: 'Dropbox' };
  }
  if (CATALOG_IDS.has(provider)) {
    const p = getProvider(provider);
    if (window.vortexDesktop?.isElectron) return { provider, videoId: id, url, title: fallbackTitle || p?.name || provider, channel: p?.name || provider };
    try {
      const extracted = await api(`/api/rave/extract-video?${qs({ url, title: fallbackTitle })}`, { timeout: 18000 });
      if (extracted && (extracted.url || extracted.videoId)) return extracted;
    } catch (e) { /* fallback below */ }
    return resolveCatalogItem({ title: fallbackTitle || id || p?.name || provider }, p);
  }
  if (provider === 'vimeo') {
    let meta = {};
    try { meta = await api(`/api/rave/oembed?${qs({ url })}`, { timeout: 8000 }); } catch (e) { /* optional */ }
    return { provider, videoId: id, url, title: meta.title || fallbackTitle || 'Vimeo videosu', thumbnail: meta.thumbnail_url || '', channel: meta.author_name || 'Vimeo', duration: meta.duration || 0 };
  }
  if (provider === 'web') {
    try {
      const r = await api(`/api/rave/extract-video?${qs({ url, title: fallbackTitle })}`, { timeout: 15000 });
      if (r.provider === 'youtube') return { ...r, channel: 'YouTube' };
      if (r.url) return { provider: r.provider === 'hls' ? 'hls' : 'direct', url: r.url, title: r.title || fallbackTitle || 'Web videosu', thumbnail: r.thumbnail || '', channel: new URL(url).hostname };
    } catch (e) {
      toast(e.data?.error || 'Bu sayfada oynatılabilir video bulunamadı');
      return null;
    }
  }
  return null;
}

export function openWatchHistoryModal(initialTab = 'all', customOnPick = null) {
  let activeTab = initialTab || 'all';
  const pickFn = customOnPick || ((state.mesh && !state.mesh.curated && typeof window.vortexActions?.pickMedia === 'function') ? async (media) => { await window.vortexActions.pickMedia(media); window.vortexRestoreRoom?.(); } : null) || _activeHomePick || (async (media) => {
    try {
      const created = await api('/api/rave/meshes', {
        method: 'POST',
        body: { name: media?.title || 'Sinema Odası', visibility: 'friends', voipMode: 'everyone', controlMode: 'all', media },
      });
      if (created?.id && typeof window.vortexNavigate === 'function') {
        window.vortexNavigate(`/mesh/${encodeURIComponent(created.id)}`);
      }
    } catch (_) {}
  });

  const root = h('div', { class: 'HistorySelection wl-history-hub' });
  let modalRef = null;

  const playHistoryItem = async (item) => {
    const prov = getProvider(item.catalogProvider || item.provider || 'cinema') || getProvider('cinema');
    const isDone = Boolean(item.completed || Number(item.percent || 0) >= 95);
    const rawSavedSec = isDone ? 0 : Number(item.currentTime ?? item.position ?? 0);
    const resumeSec = Number.isFinite(rawSavedSec) && rawSavedSec > 3 ? Math.floor(rawSavedSec) : 0;
    modalRef?.close?.();
    if (resumeSec > 3) toast(`⏩ ${item.title || 'Yapım'} · ${fmtDur(resumeSec)} anından devam ediliyor...`);
    else toast(`🎬 ${item.title || 'Yapım'} odada başlatılıyor...`);
    if (item.tmdbId) {
      const resolved = await resolveCatalogItem(
        {
          tmdbId: item.tmdbId,
          imdbId: item.imdbId,
          mediaType: item.mediaType || 'movie',
          title: String(item.title || '').split(' — ')[0],
          backdrop: item.backdrop || item.thumbnail,
          poster: item.poster || item.thumbnail,
          year: item.year || '',
        },
        prov || { id: 'cinema', name: 'Sinema+' },
        item.season || 1,
        item.episode || 1
      );
      if (resolved) {
        resolved.currentTime = resumeSec;
        resolved.meshStatePosition = resumeSec;
        await pickFn(resolved);
        return;
      }
    }
    await pickFn({ ...item, currentTime: resumeSec, meshStatePosition: resumeSec });
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
            return h('div', { class: 'wl-history-row' },
              h('img', {
                class: 'wl-history-poster',
                src: item.poster || item.thumbnail || item.backdrop || '/static/watchlivo-poster.svg',
                alt: item.title || '',
                onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; },
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
          h('span', {}, 'Beğendiğin film ve dizilerde 🔖 butonuna basarak kişisel listene ekleyebilirsin.')));
      } else {
        body.append(...favList.map((fav) => h('div', { class: 'wl-history-row' },
          h('img', { class: 'wl-history-poster', src: fav.poster || fav.backdrop || '/static/watchlivo-poster.svg', alt: fav.title || '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
          h('div', { class: 'wl-history-meta' },
            h('strong', { class: 'wl-history-title' }, fav.title || 'Yapım'),
            h('div', { class: 'wl-history-sub' }, `${fav.year || '2025'} · ${fav.mediaType === 'tv' ? '📺 Dizi' : '🎬 Film'}`)),
          h('div', { class: 'wl-history-actions' },
            h('button', { type: 'button', class: 'btn primary sm', onclick: () => playHistoryItem(fav) }, '▶ Başlat'),
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
