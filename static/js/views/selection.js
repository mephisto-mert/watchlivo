// Rave Selection parity: provider grid + SuperSearch → provider selection view → onPick(media).
import { h, icons, popup, toast, fill } from '../ui.js?v=20261030_v20';
import { PROVIDERS, PROVIDER_CATEGORIES, getProvider, parseVideoUrl, providerUsable } from '../providers.js?v=20261030_v20';
import { api, qs } from '../api.js?v=20261030_v20';
import { renderSearchKind, renderLinkKind, renderUploadKind, renderDesktopKind, renderCatalogKind, resolveCatalogItem, renderMusicKind, resolveMusicItem } from './selection-kinds.js?v=20261030_v20';
import { fetchAccounts, getAccount, openProviderLoginModal, renderSeriesPicker } from '../accounts.js?v=20261030_v20';
import { getWatchHistory, clearWatchHistory, getFavorites, isFavoriteMedia, toggleFavoriteMedia } from '../store.js?v=20261030_v20';

export const parseDuration = (s) => {
  if (typeof s === 'number') return s;
  const p = String(s || '').split(':').map(Number);
  if (p.some(Number.isNaN) || !p.length) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
};

export const ytToMedia = (it) => ({
  provider: 'youtube', videoId: it.videoId, url: it.url || `https://www.youtube.com/watch?v=${it.videoId}`,
  title: it.title, thumbnail: it.thumbnail || `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`,
  channel: it.channel || 'YouTube', duration: parseDuration(it.duration), live: !!it.live,
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

export function providerTile(p, onClick) {
  const isHero = p.id === 'cinema';
  const badgeEl = isHero
    ? h('span', { class: 'p-badge-live' }, '4K • AÇIK')
    : h('span', { class: 'p-badge-portal' }, '4K VİTRİN');

  const card = h('div', {
    class: `platform-card provider-tile ${isHero ? 'featured-glow hero-provider-tile' : ''}`,
    role: 'button',
    tabindex: '0',
    'data-provider': p.id,
    'data-brand': p.id,
    'data-category': p.cat || 'global',
    style: { '--tile-bg': p.bg || '#10121a', '--tile-accent': p.accent || '#6366f1' },
    onclick: () => onClick(p),
    onkeydown: (e) => { if (e.key === 'Enter') onClick(p); },
  },
    h('div', { class: 'platform-top' },
      h('div', { class: 'platform-top-brand' },
        p.logo
          ? h('img', { src: p.logo, alt: p.name, onerror: (e) => { e.target.remove(); } })
          : (p.glyph ? h('span', { class: 'p-icon', style: { background: p.accent || '#6366f1' }, html: icons[p.glyph] }) : null)),
      badgeEl),
    h('div', { class: 'p-title ptitle' }, p.name),
    p.badge ? h('div', { class: 'p-desc psub' }, p.badge) : null);

  return attachTilt(card);
}

export function videoCard(media, onPick) {
  const prov = getProvider(media.provider);
  const card = h('div', { class: 'vcard', role: 'button', tabindex: '0' },
    h('div', { class: 'vcard-thumb' },
      media.thumbnail ? h('img', { src: media.thumbnail, alt: '' }) : null,
      prov?.logo ? h('img', { class: 'vcard-prov', src: prov.logo, alt: '' }) : null,
      media.duration ? h('span', { class: 'vcard-dur' }, fmtDur(media.duration)) : null),
    h('div', { class: 'vcard-info' }, h('div', { class: 'vcard-title' }, media.title), h('div', { class: 'vcard-sub' }, media.channel || prov?.name || '')));
  const go = async () => {
    if (card.querySelector('.loading')) return;
    const l = h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
    card.append(l);
    try { await onPick(media); } finally { l.remove(); }
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
    h('button', { class: 'btn', onclick: () => popup({ title: 'Watchlivo Masaüstü', message: 'Masaüstü uygulaması Windows için hazırlanıyor. Kurulum dosyası yayınlandığında bu ekrandan indirebileceksin.', options: [{ label: 'Tamam' }] }) }, h('span', { html: icons.desktop }), 'Masaüstü Uygulaması'));
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

export function createSelection({ onPick, compact = false, initialProvider = null } = {}) {
  const root = h('div', { class: 'selection fade-in' });
  let provider = initialProvider ? getProvider(initialProvider) : null;
  let superQuery = '';
  let catFilter = 'all';
  let showAllProviders = false;
  let showTrending = false;
  let trendingItems = shuffleArray(HERO_DEFAULT_POOL);
  let trendingFetched = false;
  let trendingLoading = false;
  let heroIndex = 0;
  fetchAccounts().then(() => { if (!provider && root.isConnected && !superQuery) renderGrid(); });

  const pickSafe = async (media) => {
    const p = getProvider(media.provider);
    if (p && !providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
    await onPick(media);
  };

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
      toast('🎲 40.000+ Arşivden yeni vitrin önerileri getirildi!');
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
    'cinema',
    'netflix', 'disney', 'prime', 'max', 'apple', 'exxen', 'blutv', 'gain',
    'tod', 'tabii', 'tvplus', 'puhutv', 'mubi', 'crunchyroll', 'hulu', 'paramount', 'peacock',
  ];

  function renderGrid() {
    const input = h('input', { placeholder: 'Film, dizi, anime veya doğrudan video bağlantısı ara...', value: superQuery, 'aria-label': 'Ara' });
    const results = h('div', { class: 'super-results' });
    const run = () => { superQuery = input.value.trim(); if (superQuery) runSuperSearch(superQuery, results); else results.replaceChildren(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    const filteredProviders = catFilter === 'all' ? PROVIDERS : PROVIDERS.filter((p) => p.cat === catFilter);
    const orderedAll = catFilter === 'all'
      ? [
          ...RAVE_TOP_IDS.map((id) => filteredProviders.find((p) => p.id === id)).filter(Boolean),
          ...filteredProviders.filter((p) => !RAVE_TOP_IDS.includes(p.id)),
        ]
      : filteredProviders;
    const defaultCap = 30;
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
      }, '🎲 Rastgele Film') : null,
      !compact && catFilter === 'all' && showAllProviders ? h('button', {
        type: 'button',
        id: 'provider-expand-btn',
        class: 'provider-cat-pill expand-toggle active',
        onclick: () => { showAllProviders = false; renderGrid(); },
      }, '▲ Daralt') : null);

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
        h('span', { class: 'trending-strip-title' }, '🔥 40.000+ Arşivden Karışık Öneriler (Tek Tıkla Odaya Aç)'),
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
            h('img', { src: item.poster || item.backdrop || '/static/watchlivo-poster.svg', alt: item.title, loading: 'lazy' }),
            h('div', { class: 'trending-mini-info' },
              h('div', { class: 't-title' }, item.title),
              h('div', { class: 't-sub' }, `${item.year || '2025'} · ⭐ ${item.rating || '8.4'} · 🇹🇷 TR`)));
        }))) : null;

    const historyList = !compact ? getWatchHistory().slice(0, 4) : [];
    const historyRail = historyList.length ? h('div', { class: 'continue-strip' },
      h('span', { class: 'continue-strip-label' }, '🕘 Son Açılanlar:'),
      ...historyList.map((item) => {
        const prov = getProvider(item.catalogProvider || item.provider || 'netflix');
        const resumeSec = Number(item.currentTime) > 5 ? Math.floor(Number(item.currentTime)) : 0;
        return h('button', {
          type: 'button',
          class: 'continue-chip',
          onclick: async () => {
            if (item.tmdbId) {
              const resolved = await resolveCatalogItem({ tmdbId: item.tmdbId, imdbId: item.imdbId, mediaType: item.mediaType, title: item.title.split(' — ')[0], backdrop: item.thumbnail }, prov || { id: 'netflix', name: 'Netflix' }, item.season || 1, item.episode || 1);
              if (resolved) { resolved.currentTime = resumeSec; await pickSafe(resolved); return; }
            }
            await pickSafe({ ...item, currentTime: resumeSec });
          },
        },
          prov?.logo ? h('img', { src: prov.logo, alt: '' }) : null,
          h('span', { class: 'c-title' }, item.title),
          h('span', { class: 'c-pct' }, resumeSec > 0 ? fmtDur(resumeSec) : '0:00'));
      }),
      h('button', {
        type: 'button',
        class: 'btn sm ghost continue-clear-btn',
        title: 'İzleme geçmişini temizle',
        style: { marginLeft: 'auto', fontSize: '.74rem', opacity: '.78' },
        onclick: () => {
          clearWatchHistory();
          renderGrid();
          toast('🧹 Son açılanlar geçmişi temizlendi');
        },
      }, 'Temizle ×')) : null;

    const searchEl = h('div', { class: compact ? 'sel-search' : 'home-search' },
      h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }),
      input,
      h('button', { class: 'btn primary', onclick: run }, 'Ara'));

    const topBar = compact
      ? h('div', {}, searchEl, catBar)
      : h('div', { class: 'rave-top-bar' }, searchEl, catBar);

    const moreTile = isCollapsedGrid ? h('div', {
      class: 'provider-tile extend-tile',
      role: 'button',
      tabindex: '0',
      title: 'Tüm platformları göster',
      onclick: () => { showAllProviders = true; renderGrid(); },
      onkeydown: (e) => { if (e.key === 'Enter') { showAllProviders = true; renderGrid(); } },
    },
      h('div', { class: 'extend-plus' }, `+${hiddenCount}`),
      h('div', { class: 'provider-meta' },
        h('span', { class: 'ptitle' }, 'Tüm Platformlar'),
        h('span', { class: 'psub' }, `${PROVIDERS.length} Platform`))) : null;

    const heroPool = trendingItems.length ? trendingItems : HERO_DEFAULT_POOL;
    const safeHeroIdx = ((heroIndex % heroPool.length) + heroPool.length) % heroPool.length;
    const heroItem = heroPool[safeHeroIdx] || HERO_DEFAULT_POOL[0];
    if (!trendingFetched && !trendingLoading && !compact) {
      ensureTrending().then(() => { if (!provider && root.isConnected && !superQuery) renderGrid(); });
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
            renderGrid();
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              heroIndex = idx;
              renderGrid();
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

    const heroBanner = (!compact && !superQuery) ? h('div', { class: 'gazestream-hero hero-with-rail' },
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
                if (heroItem.mediaType === 'tv') {
                  openTvSeriesModal(heroItem, defProv);
                  return;
                }
                const btn = e.currentTarget;
                btn.disabled = true;
                toast(`🎬 ${heroItem.title} odası hazırlanıyor...`);
                try {
                  const media = await resolveCatalogItem(heroItem, defProv, 1, 1);
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
            }, '🎬 40.000+ Kataloğu Aç'),
            h('button', {
              type: 'button',
              id: 'btn-shuffle-hero',
              class: 'btn-download-glass hero-shuffle-btn',
              title: '40.000+ içerikten vitrini rastgele karıştır',
              onclick: (e) => shuffleShowcaseUI(e.currentTarget),
            }, '🎲 Vitrini Karıştır'),
            h('button', {
              type: 'button',
              class: 'btn-download-glass hero-nav-btn',
              title: 'Önceki',
              onclick: () => {
                heroIndex = (safeHeroIdx - 1 + heroPool.length) % heroPool.length;
                renderGrid();
                setTimeout(() => root.querySelector('.hero-mini-card.active')?.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' }), 20);
              },
            }, '‹ Önceki'),
            h('button', {
              type: 'button',
              class: 'btn-download-glass hero-nav-btn',
              title: 'Sonraki',
              onclick: () => {
                heroIndex = (safeHeroIdx + 1) % heroPool.length;
                renderGrid();
                setTimeout(() => root.querySelector('.hero-mini-card.active')?.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' }), 20);
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
          h('span', { class: 'hero-showcase-title' }, `🎬 40.000+ Vitrin Önerileri (${heroPool.length} Karışık Film, Dizi & Anime)`),
          h('div', { class: 'hero-showcase-arrows' },
            h('button', {
              type: 'button',
              id: 'btn-shuffle-showcase',
              class: 'btn sm primary',
              title: '40.000+ arşivden yeni rastgele vitrin önerileri getir',
              onclick: (e) => shuffleShowcaseUI(e.currentTarget),
            }, '🎲 Karıştır'),
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { heroStripRow.scrollBy({ left: -420, behavior: 'smooth' }); } }, '◀'),
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { heroStripRow.scrollBy({ left: 420, behavior: 'smooth' }); } }, '▶'),
            h('button', { type: 'button', class: 'btn sm', onclick: () => { provider = getProvider('cinema'); render(); } }, 'Tümünü Gör →'))),
        heroStripRow)) : null;

    const gridSection = h('div', { class: 'section-row' },
      !compact ? h('div', { class: 'section-heading' },
        h('h2', {}, 'Streaming Ağ Geçitleri & Platformlar'),
        h('span', { class: 'section-sub' }, `${PROVIDERS.length} Doğrulanmış Canlı Platform & Katalog Entegrasyonu`)) : null,
      h('div', { class: compact ? 'provider-grid compact' : 'platform-glass-grid' },
        ...visibleProviders.map((p) => providerTile(p, (pp) => { provider = pp; render(); }, () => renderGrid())),
        ...(moreTile ? [moreTile] : [])));

    root.replaceChildren(
      topBar,
      results,
      ...(heroBanner ? [heroBanner] : []),
      ...(trendingRail ? [trendingRail] : []),
      ...(historyRail ? [historyRail] : []),
      gridSection);
    if (superQuery) runSuperSearch(superQuery, results);
  }

  async function runSuperSearch(q, box) {
    box.replaceChildren(h('div', { style: { display: 'flex', justifyContent: 'center', padding: '1em' } }, h('div', { class: 'spinner' })));
    const pasted = parseVideoUrl(q);
    if (pasted) { box.replaceChildren(); await pickFromUrl(q); return; }
    let data = {};
    try { data = await api(`/api/rave/supersearch?${qs({ q })}`, { timeout: 15000 }); } catch (e) { box.replaceChildren(h('div', { class: 'lobby-empty' }, 'Arama başarısız oldu, tekrar dene.')); return; }
    const tmdb = (data.tmdb || []).slice(0, 12);
    const titles = tmdb.length ? [] : (data.justwatch || []).filter((t) => t.title).slice(0, 12);
    const yt = (data.youtube || []).slice(0, 12).map(ytToMedia);
    fill(box,
      tmdb.length || titles.length ? h('div', { class: 'section-head' }, h('h2', {}, 'Film ve Diziler'), h('span', { class: 'dim' }, 'Sezon / Bölüm veya Tam Film seç')) : null,
      tmdb.length || titles.length ? h('div', { class: 'poster-grid' }, [...tmdb.map((t) => posterCard({ ...t, tmdbId: String(t.id || ''), offers: [] }, box)), ...titles.map((t) => posterCard(t, box))]) : null,
      yt.length ? h('div', { class: 'section-head' }, h('h2', {}, 'YouTube'), h('span', { class: 'dim' }, `${yt.length} video`)) : null,
      yt.length ? h('div', { class: 'card-grid' }, yt.map((m) => videoCard(m, pickSafe))) : h('div', { class: 'lobby-empty' }, 'Video bulunamadı.'));
  }

  function posterCard(t, box) {
    const offers = t.offers || [];
    const provs = [...new Set(offers.map((o) => offerProvider(o.provider)).filter(Boolean))];
    const defProv = getProvider(t.provider || provs[0] || 'cinema') || getProvider('cinema');
    const isTv = t.mediaType === 'tv' || t.type === 'SHOW';
    const card = h('div', { class: 'poster catalog-card', role: 'button', tabindex: '0' },
      h('div', { class: 'poster-thumb-wrap' },
        h('img', { src: t.poster || '/static/watchlivo-poster.svg', alt: '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
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
    if (!providerUsable(p)) { body.append(desktopOnlyCard(p)); return; }
    if (p.kind === 'search') renderSearchKind(p, body, presetQuery, pickSafe);
    else if (p.kind === 'music') renderMusicKind(p, body, presetQuery, pickSafe);
    else if (p.kind === 'link') renderLinkKind(p, body, pickFromUrl);
    else if (p.kind === 'upload') renderUploadKind(body, pickSafe);
    else if (p.kind === 'catalog') renderCatalogKind(p, body, presetQuery, pickSafe, pickFromUrl);
    else if (p.kind === 'desktop') renderDesktopKind(p, body, pickSafe);
  }

  root.render = render;
  root.setProvider = (id) => { provider = id ? getProvider(id) : null; render(); };
  root.openFavorites = () => {
    provider = getProvider('cinema');
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
  if (provider === 'drive') return { provider, videoId: id, url, title: fallbackTitle || 'Google Drive videosu', channel: 'Google Drive', thumbnail: `https://drive.google.com/thumbnail?id=${id}&sz=w640` };
  if (provider === 'dropbox') {
    const directUrl = String(url || '').replace(/^https?:\/\/(www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/').replace(/[?&]dl=[01]/g, '');
    return { provider: 'direct', videoId: id, url: directUrl, streamType: 'mp4', title: fallbackTitle || 'Dropbox Videosu', channel: 'Dropbox' };
  }
  if (CATALOG_IDS.has(provider)) {
    const p = getProvider(provider);
    if (window.vortexDesktop) return { provider, videoId: id, url, title: fallbackTitle || p?.name || provider, channel: p?.name || provider };
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
