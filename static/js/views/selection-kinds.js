// Provider selection views by kind (Rave YouTubeSelection / WebSelection / Catalog / upload).
import { h, icons, toast, openThemeModal, openAiConfigModal, getAiApiConfig } from '../ui.js?v=20261029_v4';
import { api, qs } from '../api.js?v=20261029_v4';
import { parseVideoUrl } from '../providers.js?v=20261029_v4';
import { videoCard, ytToMedia, resolveMedia } from './selection.js?v=20261029_v4';
import { renderAccountBar, renderSeriesPicker, getAccount } from '../accounts.js?v=20261029_v4';
import { getFavorites, isFavoriteMedia, toggleFavoriteMedia, getMusicHistory, saveMusicHistory, state } from '../store.js?v=20261029_v4';

export async function resolveCatalogItem(it, prov, season = 1, episode = 1, epName = '') {
  const mediaType = it.mediaType || (it.type === 'SHOW' ? 'tv' : 'movie');
  const s = Math.max(1, Number(season) || 1);
  const e = Math.max(1, Number(episode) || 1);
  const rawTid = String(it.tmdbId || (/^\d+$/.test(String(it.id || '')) ? it.id : '')).trim();
  const query = qs({
    provider: prov.id,
    title: it.originalTitle || it.title || prov.name,
    originalTitle: it.originalTitle || '',
    displayTitle: it.title || prov.name,
    year: it.year || '',
    tmdbId: rawTid,
    imdbId: it.imdbId || '',
    mediaType,
    poster: it.backdrop || it.poster || '',
    sourceUrl: it.officialUrl || it.sourceUrl || '',
    season: s,
    episode: e,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await api(`/api/rave/resolve-catalog?${query}`, { timeout: 18000 });
      if (res && (res.url || res.videoId)) {
        const disp = it.title || res.title || prov.name;
        if (mediaType === 'tv') {
          res.title = epName ? `${disp} — S${s}:B${e} · ${epName}` : `${disp} — ${s}. Sezon ${e}. Bölüm`;
        }
        return res;
      }
      break;
    } catch (err) {
      if (err?.status === 404 || attempt === 1) {
        toast(err.data?.error || 'Bu bölüm şu an açılamadı, lütfen tekrar dene.');
        break;
      }
    }
  }
  return null;
}

const spinner = () => h('div', { style: { display: 'flex', justifyContent: 'center', padding: '1.2em' } }, h('div', { class: 'spinner' }));

export function renderSearchKind(p, body, presetQuery, pick) {
  const authHolder = h('div', {});
  const refreshAuth = () => authHolder.replaceChildren(renderAccountBar(p, refreshAuth));
  refreshAuth();
  const input = h('input', { placeholder: p.placeholder || 'Ara...', value: presetQuery || '', 'aria-label': `${p.name} içinde ara` });
  const grid = h('div', { class: 'card-grid' });
  let seq = 0;
  const run = async (q) => {
    const mine = ++seq;
    const pasted = parseVideoUrl(q);
    if (pasted && pasted.provider === p.id) {
      grid.replaceChildren(spinner());
      const res = await api(`/api/search/youtube?${qs({ q: pasted.id })}`).catch(() => ({ items: [] }));
      const hit = (res.items || []).find((x) => x.videoId === pasted.id);
      grid.replaceChildren(videoCard(hit ? ytToMedia(hit) : ytToMedia({ videoId: pasted.id, title: 'YouTube videosu' }), pick));
      return;
    }
    grid.replaceChildren(spinner());
    let res;
    try { res = await api(`/api/search/youtube?${qs({ q: q || p.defaultQuery })}`, { timeout: 12000 }); } catch (e) { res = { items: [] }; }
    if (mine !== seq) return;
    const items = (res.items || []).map(ytToMedia);
    grid.replaceChildren(...(items.length ? items.map((m) => videoCard(m, pick)) : [h('div', { class: 'lobby-empty' }, 'Sonuç bulunamadı.')]));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(input.value.trim()); });
  body.append(
    authHolder,
    h('div', { class: 'sel-search' }, h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }), input,
      h('button', { class: 'btn primary', onclick: () => run(input.value.trim()) }, 'Ara')),
    grid);
  run(presetQuery || '');
  setTimeout(() => input.focus(), 30);
}

const LINK_HELP = {
  vimeo: 'Herkese açık ve gömmeye izin veren Vimeo videoları desteklenir.',
  twitch: 'Canlı yayınlar herkes için aynı anda akar. Kanal adını yazman yeterli.',
  kick: 'Kick 60fps canlı yayınları herkes için senkron akar. Kanal adını veya kick.com bağlantısını yaz.',
  tiktok: 'Herkese açık TikTok video bağlantısını yapıştırarak odadaki herkesle izleyebilirsin.',
  dailymotion: 'Dailymotion veya dai.ly video bağlantısını yapıştırarak odada senkron başlatabilirsin.',
  drive: 'Dosya "Bağlantıya sahip olan herkes" olarak paylaşılmalı. Drive oynatıcısı kendi kontrollerini kullanır.',
  dropbox: 'Dropbox paylaşılan video bağlantısı (.mp4 / .mov) doğrudan bulut akışına dönüştürülerek senkron oynatılır.',
  web: 'Sayfadaki .mp4 / .m3u8 videosu veya gömülü YouTube videosu otomatik bulunur.',
};

export function renderLinkKind(p, body, pickFromUrl) {
  const authHolder = h('div', {});
  if (p.id !== 'web') {
    const refreshAuth = () => authHolder.replaceChildren(renderAccountBar(p, refreshAuth));
    refreshAuth();
  }
  const input = h('input', { placeholder: p.placeholder, 'aria-label': `${p.name} bağlantısı` });
  const btn = h('button', { class: 'btn primary' }, 'Oynat');
  const go = async () => {
    let v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (p.id === 'twitch' && /^[a-z0-9_]{3,25}$/i.test(v)) v = `https://www.twitch.tv/${v}`;
    if (p.id === 'kick' && /^[a-z0-9_-]{3,30}$/i.test(v)) v = `https://kick.com/${v}`;
    if (p.id !== 'web' && !/^https?:\/\//i.test(v)) v = `https://${v}`;
    const parsed = parseVideoUrl(v);
    if (!parsed || (p.id !== 'web' && parsed.provider !== p.id)) { toast(`Geçerli bir ${p.name} bağlantısı değil`); return; }
    btn.disabled = true;
    try { await pickFromUrl(v); } finally { btn.disabled = false; }
  };
  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  body.append(
    authHolder,
    h('div', { class: 'sel-search' }, h('span', { html: icons.link, style: { display: 'flex', opacity: .7 } }), input, btn),
    h('div', { class: 'sel-note' }, LINK_HELP[p.id] || ''));
  setTimeout(() => input.focus(), 30);
}

export function renderUploadKind(body, pick) {
  const file = h('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,audio/*', style: { display: 'none' } });
  const status = h('div', { class: 'sel-note' }, 'MP4 / WebM / MOV dosyanı seç. Dosya sunucuya yüklenir ve odadaki herkes aynı anda izler.');
  const drop = h('div', { class: 'sel-desktop', style: { cursor: 'pointer', borderStyle: 'dashed' }, onclick: () => file.click() },
    h('span', { html: icons.upload, style: { display: 'flex', fontSize: '2em' } }), h('b', {}, 'Dosya seç veya buraya bırak'));
  const upload = async (f) => {
    if (!f) return;
    if (f.size > 1024 * 1024 * 1024) { toast('Dosya 1 GB sınırını aşıyor'); return; }
    status.textContent = `Yükleniyor: ${f.name} (${(f.size / 1048576).toFixed(1)} MB)...`;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Yükleme başarısız');
      status.textContent = 'Yüklendi.';
      await pick({ provider: 'upload', url: data.url, title: f.name.replace(/\.[^.]+$/, ''), channel: 'Yüklenen dosya', thumbnail: '' });
    } catch (e) { status.textContent = `Hata: ${e.message}`; }
  };
  file.addEventListener('change', () => upload(file.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); });
  drop.addEventListener('drop', (e) => { e.preventDefault(); upload(e.dataTransfer.files[0]); });
  body.append(drop, file, status);
}

const HOME_URLS = {
  netflix: 'https://www.netflix.com/browse',
  disney: 'https://www.disneyplus.com',
  prime: 'https://www.primevideo.com',
  max: 'https://play.max.com',
  apple: 'https://tv.apple.com',
  mubi: 'https://mubi.com/tr/showing',
  hulu: 'https://www.hulu.com',
  paramount: 'https://www.paramountplus.com',
  peacock: 'https://www.peacocktv.com',
  plex: 'https://watch.plex.tv',
  pluto: 'https://pluto.tv',
  exxen: 'https://www.exxen.com/tr',
  blutv: 'https://www.blutv.com',
  gain: 'https://www.gain.tv',
  tod: 'https://www.todtv.com.tr',
  tabii: 'https://www.tabii.com/tr',
  tvplus: 'https://tvplus.com.tr',
  puhutv: 'https://puhutv.com',
  crunchyroll: 'https://www.crunchyroll.com',
  tubi: 'https://tubitv.com',
};

export function renderDesktopKind(p, body, pick) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', window.vortexDesktop?.partition || 'persist:vortex-drm');
  wv.style.cssText = 'width:100%;height:62vh;border:1px solid var(--border-soft);border-radius:12px;background:#000;';
  wv.src = HOME_URLS[p.id] || 'https://www.netflix.com';
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    const url = wv.getURL ? wv.getURL() : wv.src;
    const title = wv.getTitle ? wv.getTitle() : p.name;
    await pick({ provider: p.id, url, videoId: p.idParser?.(url) || url, title: title || p.name, channel: p.name });
  } }, 'Bu Videoyu Odada Başlat');
  body.append(h('div', { class: 'sel-note' }, `${p.name} hesabınla giriş yap, izlemek istediğin içeriği aç ve "Bu Videoyu Odada Başlat" düğmesine tıkla.`), btn, wv);
}

const CATALOG_CATEGORIES = [
  { id: 'all', label: '✨ Tüm Katalog (40.000+)' },
  { id: 'series', label: '📺 Tüm Diziler' },
  { id: 'movies', label: '🎬 Tüm Filmler' },
  { id: 'anime', label: '⛩️ Anime (Animetrix / Fansub)' },
  { id: 'dublaj', label: '🇹🇷 Türkçe Dublaj 4K' },
  { id: 'trend', label: '🔥 Trend & Top 20' },
  { id: 'action', label: '⚔️ Aksiyon & Macera' },
  { id: 'scifi', label: '🚀 Bilim Kurgu & Fantastik' },
  { id: 'drama', label: '🎭 Dram & Suç' },
  { id: 'comedy', label: '😂 Komedi & Romantik' },
  { id: 'horror', label: '👻 Korku & Gerilim' },
  { id: 'animation', label: '🎨 Animasyon & Aile' },
  { id: 'doc', label: '🌍 Belgesel & Tarih' },
  { id: 'favs', label: '❤️ Favorilerim' },
];

function fmtCount(n) {
  const num = Number(n || 0);
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace('.', ',')}B+`;
  return String(num);
}

function itemMatchesCat(it, catId) {
  if (catId === 'all' || catId === 'dublaj') return true;
  const isTv = it.mediaType === 'tv' || it.type === 'SHOW';
  if (catId === 'series') return isTv;
  if (catId === 'movies') return !isTv;
  const cats = Array.isArray(it.categories) ? it.categories : [];
  if (catId === 'anime') {
    return (
      cats.includes('anime') ||
      it.origLang === 'ja' ||
      String(it.sourceBadge || '').includes('Animetrix') ||
      /Naruto|One Piece|Bleach|Attack on Titan|Shingeki|Jujutsu|Kimetsu|İblis Keser|Solo Leveling|Death Note|Dragon Ball|Fullmetal|Hunter|Tokyo Ghoul|Demon Slayer|Doraemon|One Punch|Haikyuu|Chainsaw|Spy x Family|Boku no Hero|Fairy Tail|Gintama|Black Clover|Steins|Boruto|Frieren|Vinland|Code Geass|Evangelion|Ghibli|Spirited Away|Ruhların Kaçışı|Yürüyen Şato|Prenses Mononoke|Senin Adın|Your Name|Suzume/i.test(`${it.title || ''} ${it.originalTitle || ''}`)
    );
  }
  if (cats.includes(catId)) return true;
  if (catId === 'trend') return Number(it.rating || 0) >= 7.5;
  return false;
}

export function renderCatalogKind(p, body, presetQuery, pick, pickFromUrl) {
  if (window.vortexDesktop) { renderDesktopKind(p, body, pick); return; }
  const authHolder = h('div', {});
  const input = h('input', { id: 'hub-search-q', placeholder: p.placeholder || `${p.name} içinde binlerce dizi veya film ara...`, value: presetQuery || '', 'aria-label': `${p.name} içinde ara` });
  const mainWrap = h('div', { class: 'catalog-main' });
  const detailWrap = h('div', { class: 'catalog-detail hidden' });
  const catBar = h('div', { class: 'cat-tabs-bar', id: 'catalog-cat-bar' });
  const contentArea = h('div', { class: 'catalog-sections-wrap' });
  let seq = 0;
  let catalogLoaded = false;
  let activeCat = 'all';
  let currentItems = [];
  let currentQuery = '';
  let currentPage = 1;
  let hasMorePages = true;
  let loadingMore = false;
  let catalogTotals = p.id === 'cinema' || p.freeNoAuth
    ? { totalAvailable: 42600, totalTv: 18400, totalMovies: 24200 }
    : { totalAvailable: 3500, totalTv: 1400, totalMovies: 2100 };
  let ioObserver = null;

  const mergeUniqueItems = (existing, incoming) => {
    const seen = new Set(existing.map((x) => `${x.mediaType}:${x.tmdbId || x.id}`));
    const out = [...existing];
    for (const it of (incoming || [])) {
      const k = `${it.mediaType}:${it.tmdbId || it.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(it);
      }
    }
    return out;
  };

  const refreshAuth = () => {
    authHolder.replaceChildren(renderAccountBar(p, refreshAuth, pickFromUrl, (it) => openDetail(it)));
    mainWrap.classList.remove('hidden');
    if (!catalogLoaded) {
      catalogLoaded = true;
      run(input.value || presetQuery || '');
    }
    if (window.innerWidth > 960) setTimeout(() => input.focus(), 30);
  };

  const scrollDetailIntoView = () => {
    try {
      const scrollers = [
        detailWrap.closest('.panel-body'),
        detailWrap.closest('.home'),
        detailWrap.closest('.home-scroll'),
        document.scrollingElement,
        document.documentElement,
        document.body,
      ].filter(Boolean);
      for (const s of scrollers) {
        s.scrollTop = 0;
      }
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    } catch (e) {
      window.scrollTo(0, 0);
    }
  };

  const openDetail = (it) => {
    const scroller = detailWrap.closest('.panel-body') || detailWrap.closest('.home') || document.scrollingElement;
    const savedScroll = scroller ? scroller.scrollTop : window.scrollY;
    mainWrap.classList.add('hidden');
    detailWrap.classList.remove('hidden');
    scrollDetailIntoView();
    renderSeriesPicker(it, p, detailWrap, () => {
      detailWrap.classList.add('hidden');
      mainWrap.classList.remove('hidden');
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = savedScroll;
        else window.scrollTo(0, savedScroll);
      });
    }, pick, resolveCatalogItem);
  };

  const makePoster = (it) => {
    const isTv = it.mediaType === 'tv' || it.type === 'SHOW';
    const favBtn = h('button', {
      type: 'button',
      class: 'poster-fav-btn',
      title: 'Favorilere Ekle / Çıkar',
      style: { position: 'absolute', top: '6px', right: '6px', zIndex: '4', width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(6,8,14,.78)', border: '1px solid rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.85em', cursor: 'pointer' },
      onclick: (e) => {
        e.stopPropagation();
        const nowFav = toggleFavoriteMedia({ ...it, provider: p.id });
        favBtn.textContent = nowFav ? '❤️' : '🤍';
        toast(nowFav ? `"${it.title}" favorilerine eklendi` : `"${it.title}" favorilerden çıkarıldı`);
      },
    }, isFavoriteMedia(it) ? '❤️' : '🤍');

    const quickBtn = h('button', {
      class: 'btn primary poster-cta',
      onclick: async (e) => {
        e.stopPropagation();
        if (isTv) { openDetail(it); return; }
        if (card.querySelector('.loading')) return;
        const l = h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
        card.append(l);
        try {
          const media = await resolveCatalogItem(it, p, 1, 1);
          if (media) await pick(media);
        } finally { l.remove(); }
      },
    }, isTv ? '📺 Sezon & Bölüm Seç' : '▶ Tam Filmi İzle');

    const card = h('div', { class: 'poster catalog-card', role: 'button', tabindex: '0', onclick: () => openDetail(it), onkeydown: (e) => { if (e.key === 'Enter') openDetail(it); } },
      h('div', { class: 'poster-thumb-wrap' },
        h('img', { src: it.poster || '/static/watchlivo-poster.svg', alt: '', loading: 'lazy', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
        it.sourceBadge
          ? h('span', { class: 'poster-source-pill' }, it.sourceBadge)
          : (p?.logo ? h('span', { class: 'poster-prov-badge' }, h('img', { src: p.logo, alt: p.name })) : null),
        favBtn),
      h('div', { class: 'pt' }, `${it.title}${it.year ? ` (${it.year})` : ''}`),
      h('div', { class: 'offers' },
        h('span', {}, isTv ? '📺 DİZİ' : '🎬 FİLM'),
        it.rating ? h('span', {}, `⭐ ${it.rating}`) : null,
        it.genreLabel ? h('span', { class: 'poster-genre-tag' }, it.genreLabel) : h('span', {}, p.name)),
      quickBtn);
    return card;
  };

  const loadMorePage = async (btnEl) => {
    if (loadingMore || !hasMorePages || currentQuery) return;
    loadingMore = true;
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '⏳ Yeni Dizi & Filmler Yükleniyor...';
    }
    try {
      const nextPg = currentPage + 1;
      const catData = await api(`/api/rave/catalog?${qs({ provider: p.id, category: activeCat === 'favs' ? 'all' : activeCat, page: nextPg })}`, { timeout: 12000 }).catch(() => ({ items: [] }));
      const more = catData.items || [];
      if (more.length) {
        currentPage = nextPg;
        hasMorePages = catData.hasMore !== false;
        const prevLen = currentItems.length;
        currentItems = mergeUniqueItems(currentItems, more);
        const added = currentItems.slice(prevLen);
        if (!added.length) {
          hasMorePages = false;
        } else {
          const gridEl = contentArea.querySelector('#cat-archive-grid');
          const toAppend = activeCat === 'all' ? added : added.filter((it) => itemMatchesCat(it, activeCat));
          if (gridEl && toAppend.length) {
            gridEl.append(...toAppend.map(makePoster));
          } else if (!gridEl) {
            renderCategoryView();
          }
        }
      } else {
        hasMorePages = false;
      }
    } finally {
      loadingMore = false;
      if (btnEl && btnEl.isConnected) {
        btnEl.disabled = false;
        btnEl.textContent = hasMorePages ? `➕ Daha Fazla Dizi & Film Yükle (Sayfa ${currentPage + 1})` : '✓ Tüm Popüler Katalog Yüklendi';
      }
    }
  };

  const attachInfiniteScroll = (sentinelEl, btnEl) => {
    if (ioObserver) ioObserver.disconnect();
    if (!('IntersectionObserver' in window) || !sentinelEl) return;
    ioObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingMore && hasMorePages && !currentQuery) {
        loadMorePage(btnEl);
      }
    }, { rootMargin: '320px' });
    ioObserver.observe(sentinelEl);
  };

  const selectCategory = async (catId) => {
    activeCat = catId;
    currentPage = 1;
    hasMorePages = true;
    renderCategoryView();
    if (catId !== 'all' && catId !== 'favs' && !currentQuery) {
      const catData = await api(`/api/rave/catalog?${qs({ provider: p.id, category: catId, page: 1 })}`, { timeout: 10000 }).catch(() => null);
      if (catData?.items?.length && activeCat === catId) {
        currentItems = mergeUniqueItems(currentItems, catData.items);
        renderCategoryView();
      }
    }
  };

  const renderCategoryView = () => {
    const favList = getFavorites();
    catBar.replaceChildren(...CATALOG_CATEGORIES.map((c) => {
      let badgeTxt = '';
      if (c.id === 'favs') badgeTxt = String(favList.length);
      else if (c.id === 'all') badgeTxt = fmtCount(Math.max(catalogTotals.totalAvailable || 0, currentItems.length));
      else if (c.id === 'series') badgeTxt = fmtCount(Math.max(catalogTotals.totalTv || 0, currentItems.filter((it) => itemMatchesCat(it, 'series')).length));
      else if (c.id === 'movies') badgeTxt = fmtCount(Math.max(catalogTotals.totalMovies || 0, currentItems.filter((it) => itemMatchesCat(it, 'movies')).length));
      else badgeTxt = `${currentItems.filter((it) => itemMatchesCat(it, c.id)).length}+`;
      return h('button', {
        type: 'button',
        class: `cat-tab-pill ${activeCat === c.id ? 'active' : ''}`,
        'data-cat': c.id,
        onclick: () => selectCategory(c.id),
      }, c.label, h('span', { class: 'cat-cnt' }, badgeTxt));
    }));

    if (activeCat === 'favs') {
      if (!favList.length) {
        contentArea.replaceChildren(h('div', { class: 'lobby-empty' }, 'Henüz favorilere eklenmiş bir dizi veya film yok.'));
        return;
      }
      contentArea.replaceChildren(
        h('section', { class: 'cat-section' },
          h('div', { class: 'cat-sec-head' }, h('h3', {}, `❤️ Favori Dizi & Filmlerim (${favList.length})`)),
          h('div', { class: 'poster-grid' }, ...favList.map(makePoster))));
      return;
    }

    if (!currentItems.length) {
      contentArea.replaceChildren(h('div', { class: 'lobby-empty' }, 'Katalogda içerik bulunamadı.'));
      return;
    }

    const makeLoadMoreFooter = () => {
      if (currentQuery || !hasMorePages) return null;
      const moreBtn = h('button', {
        type: 'button',
        class: 'btn primary cat-load-more-btn',
        onclick: (e) => loadMorePage(e.currentTarget),
      }, `➕ Daha Fazla Dizi & Film Yükle (Sayfa ${currentPage + 1})`);
      const wrap = h('div', { class: 'cat-load-more-wrap' }, moreBtn);
      setTimeout(() => attachInfiniteScroll(wrap, moreBtn), 40);
      return wrap;
    };

    if (activeCat !== 'all' || currentQuery) {
      const filtered = currentItems.filter((it) => itemMatchesCat(it, activeCat));
      const catMeta = CATALOG_CATEGORIES.find((c) => c.id === activeCat) || CATALOG_CATEGORIES[0];
      if (!filtered.length) {
        contentArea.replaceChildren(h('div', { class: 'lobby-empty' }, 'Bu kategoride içerik yükleniyor...'));
        return;
      }
      contentArea.replaceChildren(
        h('section', { class: 'cat-section' },
          h('div', { class: 'cat-sec-head' },
            h('h3', {}, `${catMeta.label} (${filtered.length}+ Yapım Listeleniyor)`),
            activeCat !== 'all' ? h('button', { type: 'button', class: 'cat-see-all', onclick: () => selectCategory('all') }, '← Tüm Kategorilere Dön') : null),
          h('div', { class: 'poster-grid', id: 'cat-archive-grid' }, ...filtered.map(makePoster)),
          makeLoadMoreFooter()));
      return;
    }

    const shelves = [
      { id: 'trend', title: `🔥 ${p.name} Trend & Top 20` },
      { id: 'series', title: `📺 Popüler ${p.name} Dizileri` },
      { id: 'movies', title: `🎬 Gişe & Popüler Filmler` },
      { id: 'action', title: '⚔️ Aksiyon & Macera' },
      { id: 'scifi', title: '🚀 Bilim Kurgu & Fantastik' },
      { id: 'drama', title: '🎭 Dram & Suç' },
      { id: 'comedy', title: '😂 Komedi & Romantik' },
      { id: 'horror', title: '👻 Korku & Gerilim' },
      { id: 'animation', title: '🎨 Animasyon & Aile' },
      { id: 'doc', title: '🌍 Belgesel & Tarih' },
    ];
    const sections = [];
    const shownFirstInShelf = new Set();
    for (const sh of shelves) {
      let list = currentItems.filter((it) => itemMatchesCat(it, sh.id));
      if (!list.length) continue;
      if (sh.id === 'trend') {
        list = [...list].sort((a, b) => (Boolean(b.poster && String(b.poster).includes('image.tmdb.org')) - Boolean(a.poster && String(a.poster).includes('image.tmdb.org'))) || (Number(b.voteCount || 0) - Number(a.voteCount || 0)));
      } else {
        const fresh = list.filter((it) => !shownFirstInShelf.has(`${it.mediaType}:${it.tmdbId || it.id}`));
        const rest = list.filter((it) => shownFirstInShelf.has(`${it.mediaType}:${it.tmdbId || it.id}`));
        list = [...fresh, ...rest];
      }
      list.slice(0, 6).forEach((it) => shownFirstInShelf.add(`${it.mediaType}:${it.tmdbId || it.id}`));
      sections.push(
        h('section', { class: 'cat-section', 'data-shelf': sh.id },
          h('div', { class: 'cat-sec-head' },
            h('h3', {}, `${sh.title}`),
            h('button', {
              type: 'button',
              class: 'cat-see-all',
              onclick: () => selectCategory(sh.id),
            }, `Tümünü Gör →`)),
          h('div', { class: 'cat-shelf-row' }, ...list.slice(0, 24).map(makePoster))));
    }
    sections.push(
      h('section', { class: 'cat-section', 'data-shelf': 'full-archive' },
        h('div', { class: 'cat-sec-head' },
          h('h3', {}, `📚 Tüm ${p.name} Dizi ve Filmleri (${fmtCount(catalogTotals.totalAvailable)} Arşiv)`)),
        h('div', { class: 'poster-grid', id: 'cat-archive-grid' }, ...currentItems.map(makePoster)),
        makeLoadMoreFooter()));
    contentArea.replaceChildren(...sections);
  };

  const run = async (q) => {
    const mine = ++seq;
    detailWrap.classList.add('hidden');
    mainWrap.classList.remove('hidden');
    const raw = (q || '').trim();
    currentQuery = raw;
    currentPage = 1;
    hasMorePages = true;
    if (/^https?:\/\//i.test(raw)) {
      if (pickFromUrl) { await pickFromUrl(raw, `${p.name} Videosu`); return; }
      const parsed = parseVideoUrl(raw);
      if (parsed) {
        const media = await resolveMedia(parsed, `${p.name} Videosu`);
        if (media) await pick(media);
        return;
      }
    }
    contentArea.replaceChildren(spinner());
    const catData = await api(`/api/rave/catalog?${qs({ provider: p.id, q: raw, page: 1, category: activeCat === 'favs' ? 'all' : activeCat })}`, { timeout: 14000 }).catch(() => ({ items: [] }));
    if (mine !== seq) return;
    currentItems = catData.items || [];
    if (catData.totalAvailable) {
      catalogTotals = {
        totalAvailable: catData.totalAvailable,
        totalTv: catData.totalTv || 1400,
        totalMovies: catData.totalMovies || 2100,
      };
    }
    hasMorePages = catData.hasMore !== false;
    renderCategoryView();
  };

  let debTimer = null;
  const clearBtn = h('button', {
    type: 'button',
    class: `btn ${input.value ? '' : 'hidden'}`,
    onclick: () => {
      clearTimeout(debTimer);
      input.value = '';
      clearBtn.classList.add('hidden');
      run('');
    },
  }, 'Temizle');
  input.addEventListener('input', () => {
    clearBtn.classList.toggle('hidden', !input.value.trim());
    clearTimeout(debTimer);
    const val = input.value.trim();
    if (!val || (!/^https?:\/\//i.test(val) && val.length >= 2)) {
      debTimer = setTimeout(() => run(input.value), 380);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debTimer);
      run(input.value);
    }
  });
  mainWrap.append(
    h('div', { class: 'sel-search' }, h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }), input,
      h('button', { class: 'btn primary', onclick: () => { clearTimeout(debTimer); run(input.value); } }, 'Ara'),
      clearBtn),
    catBar,
    contentArea);
  body.append(authHolder, mainWrap, detailWrap);
  refreshAuth();
}


export async function resolveMusicItem(item, prov = { id: 'music', name: 'Müzik & Klip' }, mode = '') {
  const effectiveMode = mode || item.musicMode || (item.preferAudio ? 'audio' : 'video');
  const query = qs({
    provider: 'music',
    artist: item.artist || '',
    title: item.songTitle || item.title || '',
    videoId: item.videoId && item.videoId !== 'cLygvXtuklI' ? item.videoId : '',
    url: item.url && /spotify\.com|deezer\.com|apple\.com|soundcloud\.com|youtube\.com/i.test(item.url) ? item.url : '',
    poster: item.poster || item.thumbnail || '',
    audioPreviewUrl: item.audioPreviewUrl || '',
    mvUrl: item.mvUrl || '',
    duration: item.duration || '',
    mode: effectiveMode,
  });
  try {
    const res = await api(`/api/rave/music-resolve?${query}`, { timeout: 14000 });
    if (res && (res.url || res.videoId)) {
      res.musicMode = effectiveMode === 'audio' ? 'audio' : 'video';
      saveMusicHistory({ ...item, ...res });
      return res;
    }
  } catch (e) {
    toast('Şarkı klibi şu an çözümlenemedi, lütfen tekrar dene.');
  }
  return null;
}

const MUSIC_CATS = [
  { id: 'all', label: '🏠 Tümü & Sana Özel' },
  { id: 'trending', label: '🔥 Trend & Top 50' },
  { id: 'tr_pop', label: '🇹🇷 Türkçe Pop' },
  { id: 'tr_rap', label: '🎤 Türkçe Rap & Drill' },
  { id: 'slow', label: '💔 Slow & Akustik' },
  { id: 'arabesk', label: '🎻 Arabesk & Damar' },
  { id: 'tr_rock', label: '🎸 Anadolu & Türkçe Rock' },
  { id: 'nostalji', label: '🕰️ 90\'lar & 2000\'ler' },
  { id: 'global_pop', label: '🌍 Yabancı Hit & Pop' },
  { id: 'phonk', label: '⚡ Phonk & Remix' },
  { id: 'global_rock', label: '🎸 Yabancı Rock & Efsaneler' },
];

export function renderMusicKind(p, body, presetQuery, pick) {
  let activeCat = 'all';
  let currentQuery = presetQuery || '';
  let seq = 0;

  const aiCfg = getAiApiConfig();
  const banner = h('div', { class: 'rave-account-bar free-portal-bar music-portal-bar', style: { '--prov-accent': p.accent || '#ff0033' } },
    h('div', { class: 'rab-status' },
      h('span', { class: 'rab-dot ok' }),
      h('div', { class: 'rab-info' },
        h('b', {}, `${p.name} · Klip, Şarkı Sözleri & Ortak DJ Partisi`),
        h('span', { class: 'dim' }, 'Güncel hitler, eski klasikler, son çalınanlar ve YouTube Music benzer şarkı radyosu hazır.'))),
    h('div', { class: 'rab-actions', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { style: { fontSize: '.74rem', fontWeight: '700', color: '#10b981', background: 'rgba(16,185,129,0.14)', border: '1px solid rgba(16,185,129,0.3)', padding: '4px 10px', borderRadius: '999px' } }, `● OpenAI (${aiCfg.openaiModel}): AKTİF`),
      h('span', { style: { fontSize: '.74rem', fontWeight: '700', color: '#fb7185', background: 'rgba(244,63,94,0.14)', border: '1px solid rgba(244,63,94,0.3)', padding: '4px 10px', borderRadius: '999px' } }, '● Suno v4.5 + Mureka 9.5: AKTİF'),
      h('button', { type: 'button', class: 'btn', style: { padding: '5px 11px', fontSize: '.76rem' }, onclick: () => openAiConfigModal() }, '🔑 API & Model Ayarları')));

  const input = h('input', { placeholder: p.placeholder || 'Şarkı, sanatçı, klip ara veya bağlantı yapıştır...', value: currentQuery, 'aria-label': `${p.name} ara` });
  const catBar = h('div', { class: 'cat-filter-bar', id: 'music-cat-bar' });
  const contentArea = h('div', { class: 'cat-content-area' });

  const fmtSec = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 195));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const makeMusicCard = (it) => {
    const verLabel = it.versionBadge || (it.isRemix ? '🎛️ Remix' : '✅ Orijinal');
    const card = h('div', { class: 'poster catalog-card music-card', role: 'button', tabindex: '0' },
      h('div', { class: 'poster-thumb-wrap' },
        h('img', { src: it.poster || it.thumbnail || '/static/watchlivo-poster.svg', alt: it.title, loading: 'lazy', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
        h('span', { class: 'poster-rating-badge' }, `🎵 ${fmtSec(it.duration)}`),
        h('button', {
          type: 'button',
          class: 'poster-fav-btn on music-queue-btn',
          title: 'Sıraya Ekle (Diğer Müzikler)',
          onclick: async (e) => {
            e.stopPropagation();
            toast(`➕ "${it.songTitle || it.title}" sıraya ekleniyor...`);
            const media = await resolveMusicItem(it, p);
            if (media) {
              if (state.mesh && window.vortexActions) {
                window.vortexActions.queueMusic?.(media);
              } else {
                await pick(media);
              }
            }
          },
        }, '➕')),
      h('div', { class: 'pt' }, it.songTitle || it.title),
      h('div', { class: 'offers' },
        h('span', { class: 'tr-dub-pill' }, `🎤 ${it.artist || 'Sanatçı'}`),
        h('span', { class: 'tr-sub-pill', style: it.isRemix ? { background: 'rgba(245,158,11,.22)', borderColor: '#f59e0b', color: '#fde68a' } : { background: 'rgba(16,185,129,.2)', borderColor: '#10b981', color: '#a7f3d0' } }, verLabel),
        it.sourceBadge ? h('span', { class: 'tr-sub-pill' }, it.sourceBadge) : null),
      h('div', { style: { display: 'flex', gap: '4px', padding: '0 5px 6px' } },
        h('button', {
          type: 'button',
          class: 'btn primary poster-cta',
          style: { flex: '1', margin: '0', padding: '.36em .4em' },
          onclick: (e) => { e.stopPropagation(); go('video'); },
        }, it.isRemix ? '🎛️ Remix Klip' : '🎬 Klip Aç'),
        h('button', {
          type: 'button',
          class: 'btn poster-cta',
          style: { flex: '0 0 auto', width: 'auto', margin: '0', padding: '.36em .5em', background: 'rgba(255,255,255,.08)' },
          title: 'Plak / Orijinal Şarkı Modunda Dinle',
          onclick: (e) => { e.stopPropagation(); go('audio'); },
        }, '💿 Şarkı')));

    const go = async (mode = 'video') => {
      if (card.querySelector('.loading')) return;
      const l = h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
      card.append(l);
      try {
        toast(`🎵 ${it.artist ? it.artist + ' — ' : ''}${it.songTitle || it.title} ${mode === 'audio' ? 'şarkısı' : 'klibi'} hazırlanıyor...`);
        const media = await resolveMusicItem(it, p, mode);
        if (media) {
          await pick(media);
          renderShelves(lastData);
        }
      } finally {
        l.remove();
      }
    };
    card.addEventListener('click', () => go('video'));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('video'); });
    return card;
  };

  let lastData = { items: [], similarItems: [], shelves: [] };
  const renderCatBar = () => {
    catBar.replaceChildren(...MUSIC_CATS.map((c) => h('button', {
      type: 'button',
      class: `cat-filter-pill ${activeCat === c.id ? 'active' : ''}`,
      'data-music-cat': c.id,
      onclick: () => { activeCat = c.id; renderCatBar(); loadMusic(currentQuery); },
    }, c.label)));
  };

  const renderShelves = (data) => {
    lastData = data || lastData;
    const recentList = getMusicHistory();
    const topRecent = recentList[0] || { artist: 'Semicenk', songTitle: 'Çıkmaz Bir Sokakta' };
    const sections = [];

    if (!currentQuery && activeCat === 'all') {
      sections.push(
        h('section', { class: 'cat-section', 'data-shelf': 'music-recent' },
          h('div', { class: 'cat-sec-head' },
            h('h3', {}, `🕘 Son Çalınanlar & Tekrar Dinle (${recentList.length})`),
            h('span', { class: 'cat-total-pill' }, '🎧 Dinleme Geçmişin')),
          h('div', { class: 'cat-shelf-row' }, ...recentList.slice(0, 12).map(makeMusicCard))));

      if ((data.similarItems || []).length) {
        sections.push(
          h('section', { class: 'cat-section', 'data-shelf': 'music-similar' },
            h('div', { class: 'cat-sec-head' },
              h('h3', {}, `✨ Son Çalınanlara Göre Benzer Müzikler (${topRecent.artist} — ${topRecent.songTitle} Mix)`),
              h('span', { class: 'cat-total-pill' }, '📻 YouTube Music Diğer Müzikler')),
            h('div', { class: 'cat-shelf-row' }, ...(data.similarItems || []).map(makeMusicCard))));
      }
    }

    for (const sh of (data.shelves || [])) {
      if (!(sh.items || []).length) continue;
      sections.push(
        h('section', { class: 'cat-section', 'data-shelf': sh.id },
          h('div', { class: 'cat-sec-head' },
            h('h3', {}, sh.title),
            activeCat === 'all' && sh.id !== 'search' && sh.id !== 'similar' ? h('button', {
              type: 'button',
              class: 'cat-see-all',
              onclick: () => { activeCat = sh.id; renderCatBar(); loadMusic(''); },
            }, 'Tümünü Gör →') : null),
          activeCat === 'all' && !currentQuery
            ? h('div', { class: 'cat-shelf-row' }, ...sh.items.map(makeMusicCard))
            : h('div', { class: 'poster-grid' }, ...sh.items.map(makeMusicCard))));
    }
    contentArea.replaceChildren(...(sections.length ? sections : [h('div', { class: 'lobby-empty' }, 'Şarkı bulunamadı.')]));
  };

  const loadMusic = async (q) => {
    const mine = ++seq;
    const raw = (q || '').trim();
    currentQuery = raw;
    if (/^https?:\/\//i.test(raw)) {
      contentArea.replaceChildren(spinner());
      const media = await resolveMusicItem({ url: raw, title: `${p.name} Parçası` }, p);
      if (media) await pick(media);
      return;
    }
    contentArea.replaceChildren(spinner());
    const recent = getMusicHistory()[0] || { artist: 'Semicenk', songTitle: 'Çıkmaz Bir Sokakta' };
    const data = await api(`/api/rave/music-catalog?${qs({
      provider: p.id,
      category: activeCat,
      q: raw,
      recentArtist: recent.artist || 'Semicenk',
      recentTitle: recent.songTitle || '',
    })}`, { timeout: 14000 }).catch(() => ({ items: [], similarItems: [], shelves: [] }));
    if (mine !== seq) return;
    renderShelves(data);
  };

  let debTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debTimer);
    const val = input.value.trim();
    if (!val || (!/^https?:\/\//i.test(val) && val.length >= 2)) {
      debTimer = setTimeout(() => loadMusic(val), 380);
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debTimer); loadMusic(input.value); } });

  renderCatBar();
  body.append(
    banner,
    h('div', { class: 'sel-search' },
      h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }),
      input,
      h('button', { class: 'btn primary', onclick: () => { clearTimeout(debTimer); loadMusic(input.value); } }, 'Ara')),
    catBar,
    contentArea);
  loadMusic(currentQuery);
}
