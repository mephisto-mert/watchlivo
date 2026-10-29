// Rave Selection parity: provider grid + SuperSearch → provider selection view → onPick(media).
import { h, icons, popup, toast, fill } from '../ui.js?v=20261029_v1';
import { PROVIDERS, PROVIDER_CATEGORIES, getProvider, parseVideoUrl, providerUsable } from '../providers.js?v=20261029_v1';
import { api, qs } from '../api.js?v=20261029_v1';
import { renderSearchKind, renderLinkKind, renderUploadKind, renderDesktopKind, renderCatalogKind, resolveCatalogItem, renderMusicKind, resolveMusicItem } from './selection-kinds.js?v=20261029_v1';
import { fetchAccounts, getAccount, renderSeriesPicker } from '../accounts.js?v=20261029_v1';
import { getWatchHistory, getFavorites, isFavoriteMedia, toggleFavoriteMedia } from '../store.js?v=20261029_v1';

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

export function providerTile(p, onClick) {
  const acct = getAccount(p.id);
  const isHero = p.id === 'cinema' || p.id === 'music';
  return h('div', {
    class: `provider-tile ${isHero ? 'hero-provider-tile' : ''}`,
    role: 'button',
    tabindex: '0',
    style: { '--tile-bg': p.bg || '#10121a', '--tile-accent': p.accent || '#00f5d4' },
    'data-provider': p.id,
    onclick: () => onClick(p),
    onkeydown: (e) => { if (e.key === 'Enter') onClick(p); },
  },
    h('div', { class: 'provider-logo-wrap' },
      p.logo ? h('img', { src: p.logo, alt: p.name, onerror: (e) => { e.target.remove(); } }) : (p.glyph ? h('span', { html: icons[p.glyph], style: { display: 'flex', fontSize: '1.6em' } }) : null)),
    h('div', { class: 'provider-meta' },
      h('span', { class: 'ptitle' }, p.name),
      p.badge ? h('span', { class: 'psub' }, p.badge) : null),
    isHero ? h('span', { class: 'rave-login-dot free-dot', title: `${p.name} — Üyeliksiz açık erişim` }, '4K · AÇIK') : null,
    providerUsable(p) ? null : h('span', { class: 'lock', title: 'Masaüstü uygulamasında' }, 'MASAÜSTÜ'));
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

export function createSelection({ onPick, compact = false, initialProvider = null } = {}) {
  const root = h('div', { class: 'selection fade-in' });
  let provider = initialProvider ? getProvider(initialProvider) : null;
  let superQuery = '';
  let catFilter = 'all';
  let showAllProviders = false;
  let showTrending = false;
  let trendingItems = [];
  let trendingLoading = false;
  fetchAccounts().then(() => { if (!provider && root.isConnected && !superQuery) renderGrid(); });

  const pickSafe = async (media) => {
    const p = getProvider(media.provider);
    if (p && !providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
    await onPick(media);
  };

  async function ensureTrending() {
    if (trendingItems.length || trendingLoading) return trendingItems;
    trendingLoading = true;
    try {
      const res = await api('/api/rave/catalog?provider=netflix', { timeout: 10000 });
      trendingItems = (res.items || []).slice(0, 12);
    } catch (e) {
      trendingItems = [];
    } finally {
      trendingLoading = false;
    }
    return trendingItems;
  }

  async function pickRandomMovie(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '🎲 Seçiliyor...'; }
    try {
      const items = await ensureTrending();
      const movies = items.filter((it) => it.mediaType !== 'tv');
      const pool = movies.length ? movies : items;
      if (!pool.length) { toast('Katalog yüklenemedi, lütfen tekrar dene'); return; }
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      toast(`🎲 Rastgele Seçim: ${chosen.title} hazırlanıyor...`);
      const defProv = getProvider(chosen.provider || 'netflix') || { id: 'netflix', name: 'Netflix' };
      const media = await resolveCatalogItem(chosen, defProv, 1, 1);
      if (media) await pickSafe(media);
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🎲 Rastgele Film'; }
    }
  }

  // Rave SuperSearch__provider-items 2-row default showcase order (Unified Cinema 40K + Unified Music + Global + TR + Live + Web/Upload)
  const RAVE_TOP_IDS = [
    'cinema', 'music',
    'netflix', 'disney', 'prime', 'max', 'youtube', 'apple', 'exxen', 'blutv', 'gain',
    'tod', 'tabii', 'tvplus', 'puhutv', 'mubi', 'crunchyroll', 'twitch', 'kick', 'drive', 'web', 'upload',
  ];

  function renderGrid() {
    const input = h('input', { placeholder: 'Video, dizi, film veya doğrudan bağlantı ara...', value: superQuery, 'aria-label': 'Ara' });
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
    const isMobileView = typeof window !== 'undefined' && window.innerWidth <= 768;
    const defaultCap = compact ? 30 : (isMobileView ? 11 : 17);
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

    const trendingRail = !compact && showTrending && trendingItems.length ? h('div', { class: 'trending-strip' },
      h('div', { class: 'trending-strip-head' },
        h('span', { class: 'trending-strip-title' }, '🔥 Günün Popüler Film & Dizileri (Tek Tıkla Odaya Aç)'),
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { showTrending = false; renderGrid(); } }, 'Kapat ×')),
      h('div', { class: 'trending-strip-row' },
        ...trendingItems.map((item) => {
          const prov = getProvider(item.provider || 'netflix') || { id: 'netflix', name: 'Netflix' };
          return h('div', {
            class: 'trending-mini-card',
            role: 'button',
            tabindex: '0',
            onclick: async (e) => {
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
      h('span', { class: 'continue-strip-label' }, '🕘 Son Açılanlar (Baştan):'),
      ...historyList.map((item) => {
        const prov = getProvider(item.catalogProvider || item.provider || 'netflix');
        return h('button', {
          type: 'button',
          class: 'continue-chip',
          onclick: async () => {
            if (item.tmdbId) {
              const resolved = await resolveCatalogItem({ tmdbId: item.tmdbId, imdbId: item.imdbId, mediaType: item.mediaType, title: item.title.split(' — ')[0], backdrop: item.thumbnail }, prov || { id: 'netflix', name: 'Netflix' }, item.season || 1, item.episode || 1);
              if (resolved) { resolved.currentTime = 0; await pickSafe(resolved); return; }
            }
            await pickSafe({ ...item, currentTime: 0 });
          },
        },
          prov?.logo ? h('img', { src: prov.logo, alt: '' }) : null,
          h('span', { class: 'c-title' }, item.title),
          h('span', { class: 'c-pct' }, '0:00'));
      })) : null;

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

    root.replaceChildren(
      topBar,
      results,
      ...(trendingRail ? [trendingRail] : []),
      ...(historyRail ? [historyRail] : []),
      h('div', { class: `provider-grid ${compact ? 'compact' : 'rave-rows'}` },
        ...visibleProviders.map((p) => providerTile(p, (pp) => { provider = pp; render(); })),
        ...(moreTile ? [moreTile] : [])));
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
    if (!providerUsable(p)) { popup({ content: desktopOnlyCard(p), options: [{ label: 'Kapat' }] }); return; }
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
    const head = h('div', { class: 'panel-head sel-prov-head', style: { '--prov-accent': p.accent || '#00f5d4' } },
      h('button', { class: 'panel-close', 'aria-label': 'Geri', html: icons.back, onclick: () => { provider = null; render(); } }),
      h('div', { class: 'sel-provider-badge', style: { '--prov-accent': p.accent || '#00f5d4' } },
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
