// Provider selection views by kind (Rave YouTubeSelection / WebSelection / Catalog / upload).
import { h, icons, toast, popup, openThemeModal, openAiConfigModal, getAiApiConfig } from '../ui.js?v=20261104_v106';
import { api, qs } from '../api.js?v=20261104_v106';
import { parseVideoUrl } from '../providers.js?v=20261104_v106';
import { videoCard, ytToMedia, resolveMedia, openYtPersonalizeModal } from './selection.js?v=20261104_v106';
import { renderAccountBar, renderSeriesPicker, getAccount } from '../accounts.js?v=20261104_v106';
import { profileSetup } from '../profile.js?v=20261104_v106';
import { createVoiceSearchButton } from '../voice-note.js?v=20261104_v106';
import {
  getFavorites, isFavoriteMedia, toggleFavoriteMedia, getMusicHistory, saveMusicHistory, clearMusicHistory,
  getWatchHistory, clearWatchHistory, saveWatchProgress, findSavedProgress,
  getYtPrefs, recordYtSearchQuery, fetchPersonalizedYtFeed, subscribe, state,
} from '../store.js?v=20261104_v106';

export async function resolveCatalogItem(it, prov, season = 1, episode = 1, epName = '', opts = {}) {
  const mediaType = it.mediaType || (it.type === 'SHOW' ? 'tv' : 'movie');
  const s = Math.max(1, Number(season) || 1);
  const e = Math.max(1, Number(episode) || 1);
  const rawTid = /^\d+$/.test(String(it.tmdbId || '').trim()) ? String(it.tmdbId).trim() : (/^\d+$/.test(String(it.id || '').trim()) ? String(it.id).trim() : '');
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
          res.seriesTitle = it.seriesTitle || String(disp || '').split(' — ')[0].trim();
        }
        res.originalTitle = res.originalTitle || it.originalTitle || '';
        res.catalogProvider = prov?.id || it.catalogProvider || it.provider || 'cinema';
        if (opts?.applySavedResume !== false) {
          const savedProg = findSavedProgress(
            { tmdbId: rawTid || res.tmdbId, title: disp, originalTitle: res.originalTitle, seriesTitle: res.seriesTitle, mediaType },
            mediaType === 'tv' ? s : null,
            mediaType === 'tv' ? e : null
          );
          const savedSec = Number(savedProg?.currentTime ?? savedProg?.position ?? 0);
          const savedPct = Number(savedProg?.percent || 0);
          if (Number.isFinite(savedSec) && savedSec > 3 && savedPct < 96) {
            const secFloor = Math.floor(savedSec);
            res.currentTime = secFloor;
            res.meshStatePosition = secFloor;
          }
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
  let activeTab = presetQuery ? 'search' : 'all';
  let dynamicChips = [
    { id: 'all', label: 'Tümü' },
    { id: 'for_you', label: '✨ Sana Özel' },
    { id: 'subscriptions', label: '🔔 Takip Edilenler' },
    { id: 'recent', label: '🆕 Yeni Yüklenenler' },
    { id: 'music', label: '🎵 Müzik' },
    { id: 'cinema', label: '🎬 Sinema & Fragman' },
    { id: 'gaming', label: '🎮 Oyun' },
    { id: 'live', label: '🔴 Canlı' },
  ];
  const authHolder = h('div', { style: { marginBottom: '12px' } });
  const tabBar = h('div', { class: 'yt-chip-bar', style: { marginBottom: '12px' } });
  const input = h('input', { placeholder: p.placeholder || 'YouTube\'da video, şarkı, kanal veya bağlantı ara...', value: presetQuery || '', 'aria-label': `${p.name} içinde ara` });
  const sectionHeader = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px', padding: '0 4px' } });
  const grid = h('div', { class: 'card-grid yt-feed-grid' });
  let seq = 0;

  const pickAndRecord = (media) => {
    try {
      saveWatchProgress({ ...media, provider: media.provider || 'youtube' }, 0, media.duration || 0);
    } catch (e) { /* ignore */ }
    return pick(media);
  };

  const refreshAuthBar = () => {
    const signedIn = Boolean(state.self && !state.self.isGuest);
    const prefs = getYtPrefs();
    const uLabel = signedIn
      ? `${prefs.googleChannelTitle || state.self.name || 'Hesabım'} (@${state.self.handle || 'uye'})`
      : 'Giriş Yap — Kişiselleştirilmiş Akışını Aç';
    const subCount = prefs.subscriptions.length;
    const likeCount = prefs.likedVideos.length;
    authHolder.replaceChildren(
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px',
          padding: '10px 14px', borderRadius: '14px',
          background: signedIn ? 'linear-gradient(135deg, rgba(255,0,51,0.14), rgba(15,23,42,0.88))' : 'rgba(15, 23, 42, 0.78)',
          border: signedIn ? '1px solid rgba(255, 0, 51, 0.36)' : '1px solid rgba(255, 255, 255, 0.1)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('div', {
            style: {
              width: '36px', height: '36px', borderRadius: '10px', background: '#ff0033', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800', fontSize: '1rem',
            },
          }, '▶'),
          h('div', {},
            h('div', { style: { fontWeight: '700', fontSize: '.9rem', color: '#f8fafc', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
              signedIn ? `🔴 ${uLabel}` : uLabel,
              signedIn ? h('span', { style: { fontSize: '.68rem', background: 'rgba(39,220,200,0.16)', color: '#27DCC8', padding: '2px 7px', borderRadius: '99px' } }, '✓ Sana Özel Akış Aktif') : null,
              h('span', { style: { fontSize: '.68rem', background: 'rgba(34,197,94,0.16)', color: '#4ade80', padding: '2px 7px', borderRadius: '99px' } }, '🛡️ Reklamsız 1080p')),
            h('div', { style: { fontSize: '.76rem', color: '#94a3b8' } },
              signedIn
                ? `${subCount} takip edilen kanal · ${likeCount} beğenilen video · İzleme ve arama geçmişine göre canlı öneriler`
                : 'Watchlivo hesabınla giriş yaptığında aynı YouTube gibi kişiselleştirilmiş videolar otomatik olarak karşına gelir.'))),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          signedIn ? h('button', {
            type: 'button',
            class: 'btn sm primary',
            onclick: () => openYtPersonalizeModal(() => { refreshAuthBar(); loadTab(activeTab, true); }),
          }, '🔗 Kanal & Google Eşitle') : h('button', {
            type: 'button',
            class: 'btn sm primary',
            onclick: () => profileSetup({ current: state.self, initialTab: 'login', onDone: () => { refreshAuthBar(); loadTab('all', true); } }),
          }, '🔑 Giriş Yap'),
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => loadTab(activeTab === 'search' ? 'all' : activeTab, true) }, '🔄 Yenile'),
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => loadTab('history') }, '🕘 Geçmişim')))
    );
  };

  const renderTabs = () => {
    const histCount = getWatchHistory().filter((x) => x.provider === 'youtube' || x.videoId || String(x.url || '').includes('youtu')).length + getMusicHistory().length;
    const favCount = getYtPrefs().likedVideos.length || getFavorites().filter((f) => f && (f.provider === 'youtube' || f.videoId || String(f.url || '').includes('youtu'))).length;
    const utilTabs = [
      { id: 'history', label: '🕘 İzleme Geçmişim', count: histCount },
      { id: 'liked', label: '❤️ Beğendiklerim', count: favCount },
      { id: 'playlists', label: '📋 Playlist İçe Aktar', count: 0 },
    ];
    tabBar.replaceChildren(
      ...dynamicChips.map((ch) => h('button', {
        type: 'button',
        class: `yt-filter-chip ${activeTab === ch.id ? 'active' : ''}`,
        onclick: () => loadTab(ch.id),
      }, ch.label)),
      ...utilTabs.map((t) => h('button', {
        type: 'button',
        class: `yt-filter-chip ${activeTab === t.id ? 'active' : ''}`,
        onclick: () => loadTab(t.id),
      }, t.label, t.count > 0 ? h('span', { class: 'cat-count', style: { marginLeft: '5px' } }, String(t.count)) : null))
    );
  };

  const cardOpts = {
    allowDismiss: true,
    onFollowChange: () => refreshAuthBar(),
    onLikeChange: () => { refreshAuthBar(); renderTabs(); },
    onChannelFilter: (med) => loadTab(`ch:${med.channelId || ''}:${med.channel || ''}`),
  };

  const runSearchQuery = async (q, customHeader = '', recordSearch = true) => {
    const mine = ++seq;
    const rawQ = String(q || '').trim();
    if (/[?&]list=([A-Za-z0-9_-]{10,64})/.test(rawQ) || /^(PL|UU|FL|RD|OLAK)[A-Za-z0-9_-]{8,64}$/.test(rawQ)) {
      grid.replaceChildren(spinner());
      const plRes = await api(`/api/rave/playlist?${qs({ url: rawQ })}`, { timeout: 14000 }).catch(() => ({ items: [] }));
      if (mine !== seq) return;
      const plItems = (plRes.items || []).map(ytToMedia);
      sectionHeader.replaceChildren(
        h('div', { style: { fontSize: '.86rem', fontWeight: '800', color: '#f8fafc' } },
          `📋 ${plRes.title || 'YouTube Oynatma Listesi'} (${plItems.length} video)`),
        plItems.length ? h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: async () => {
            if (window.vortexActions?.queueBatch && location.hash.startsWith('#/mesh/')) {
              window.vortexActions.queueBatch(plItems);
            } else {
              await pickAndRecord(plItems[0]);
              setTimeout(() => {
                if (window.vortexActions?.queueBatch && plItems.length > 1) {
                  window.vortexActions.queueBatch(plItems.slice(1));
                }
              }, 800);
            }
          },
        }, `📋 Tüm Playlisti Odaya Ekle (${plItems.length})`) : null
      );
      grid.replaceChildren(...(plItems.length ? plItems.map((m) => videoCard(m, pickAndRecord, cardOpts)) : [h('div', { class: 'lobby-empty' }, 'Oynatma listesi yüklenemedi.')]));
      return;
    }
    const pasted = parseVideoUrl(rawQ);
    if (pasted && pasted.provider === 'youtube') {
      grid.replaceChildren(spinner());
      const res = await api(`/api/search/youtube?${qs({ q: pasted.id })}`).catch(() => ({ items: [] }));
      const hit = (res.items || []).find((x) => x.videoId === pasted.id);
      grid.replaceChildren(videoCard(hit ? ytToMedia(hit) : ytToMedia({ videoId: pasted.id, title: 'YouTube videosu' }), pickAndRecord, cardOpts));
      return;
    }
    if (recordSearch && rawQ) recordYtSearchQuery(rawQ);
    grid.replaceChildren(spinner());
    let res;
    try { res = await api(`/api/search/youtube?${qs({ q: rawQ || p.defaultQuery || 'türkiye popüler video 2026' })}`, { timeout: 12000 }); } catch (e) { res = { items: [] }; }
    if (mine !== seq) return;
    const items = (res.items || []).map(ytToMedia);
    if (customHeader) {
      sectionHeader.replaceChildren(h('div', { style: { fontSize: '.84rem', fontWeight: '700', color: '#cbd5e1' } }, customHeader));
    } else {
      sectionHeader.replaceChildren();
    }
    grid.replaceChildren(...(items.length ? items.map((m) => videoCard(m, pickAndRecord, cardOpts)) : [h('div', { class: 'lobby-empty' }, 'Sonuç bulunamadı.')]));
  };

  const loadTab = async (tabId, forceRefresh = false) => {
    const tabSeq = ++seq;
    activeTab = tabId;
    renderTabs();
    const watchHist = getWatchHistory();
    const musicHist = getMusicHistory();

    if (tabId === 'history') {
      const ytHist = [
        ...watchHist.filter((x) => x && (x.provider === 'youtube' || x.videoId || String(x.url || '').includes('youtu'))),
        ...musicHist.filter((x) => x && (x.videoId || x.title)),
      ];
      const seenKeys = new Set();
      const uniqueHist = [];
      for (const item of ytHist) {
        const k = item.videoId || item.url || item.title;
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        uniqueHist.push(ytToMedia({
          videoId: item.videoId || '',
          url: item.url || (item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : ''),
          title: item.title || item.songTitle || 'YouTube Videosu',
          channel: item.channel || item.artist || 'İzleme Geçmişim',
          channelId: item.channelId || '',
          channelAvatar: item.channelAvatar || '',
          thumbnail: item.thumbnail || (item.videoId ? `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg` : '/static/watchlivo-poster.svg'),
          duration: item.duration || 0,
          watchedPercent: item.percent || 0,
        }));
      }
      sectionHeader.replaceChildren(
        h('div', { style: { fontSize: '.85rem', fontWeight: '700', color: '#e2e8f0' } }, `🕘 İzleme Geçmişim (${uniqueHist.length} video)`),
        uniqueHist.length ? h('button', {
          type: 'button',
          class: 'btn sm',
          onclick: () => {
            clearWatchHistory();
            clearMusicHistory();
            toast('İzleme geçmişi temizlendi');
            loadTab('history');
          },
        }, '🗑️ Geçmişi Temizle') : null
      );
      grid.replaceChildren(...(uniqueHist.length ? uniqueHist.map((m) => videoCard(m, pickAndRecord, cardOpts)) : [h('div', { class: 'lobby-empty' }, 'Henüz YouTube izleme geçmişin boş. İzlediğin videolar burada listelenir.')]));
      return;
    }

    if (tabId === 'liked') {
      const likedMap = new Map();
      for (const lv of getYtPrefs().likedVideos) {
        if (lv?.videoId) likedMap.set(lv.videoId, ytToMedia(lv));
      }
      for (const f of getFavorites()) {
        if (f && (f.provider === 'youtube' || f.videoId || String(f.url || '').includes('youtu'))) {
          const k = f.videoId || f.favId || f.title;
          if (k && !likedMap.has(k)) likedMap.set(k, ytToMedia({ ...f, thumbnail: f.thumbnail || f.poster }));
        }
      }
      const favs = [...likedMap.values()];
      sectionHeader.replaceChildren(h('div', { style: { fontSize: '.85rem', fontWeight: '700', color: '#e2e8f0' } }, `❤️ Beğenilen Videolarım (${favs.length})`));
      grid.replaceChildren(...(favs.length ? favs.map((m) => videoCard(m, pickAndRecord, cardOpts)) : [h('div', { class: 'lobby-empty' }, 'Henüz beğendiğin video yok. Videolardaki kalp ikonuna dokunarak ekleyebilirsin.')]));
      return;
    }

    if (tabId === 'playlists') {
      const plInp = h('input', {
        class: 'input',
        placeholder: 'YouTube Playlist URL veya ID yapıştır (örn. https://www.youtube.com/playlist?list=PL...)',
        value: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
        style: { flex: '1', minWidth: '220px' },
      });
      sectionHeader.replaceChildren(
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', width: '100%', alignItems: 'center' } },
          plInp,
          h('button', { type: 'button', class: 'btn sm primary', onclick: () => runSearchQuery(plInp.value.trim(), '📋 YouTube Playlist İçe Aktarma', false) }, '📋 Playlisti Getir'))
      );
      await runSearchQuery(plInp.value.trim(), '📋 YouTube Playlist İçe Aktarma', false);
      return;
    }

    const mine = ++seq;
    grid.replaceChildren(spinner());
    sectionHeader.replaceChildren(
      h('div', { style: { fontSize: '.84rem', fontWeight: '700', color: '#cbd5e1' } },
        state.self && !state.self.isGuest
          ? `✨ @${state.self.handle || state.self.name} için YouTube Öneri Akışı`
          : '🔥 YouTube Önerilenler & Trend Akışı')
    );
    try {
      const feed = await fetchPersonalizedYtFeed(tabId === 'recommended' ? 'all' : tabId, forceRefresh);
      if (mine !== seq) return;
      if (Array.isArray(feed?.chips) && feed.chips.length) {
        dynamicChips = feed.chips;
        renderTabs();
      }
      const items = (feed?.items || []).map(ytToMedia);
      if (!items.length && (tabId === 'all' || tabId === 'recommended' || tabId === 'for_you')) {
        await runSearchQuery('Türkiye popüler video müzik sinema 2026', '🔥 Önerilen Videolar', false);
        return;
      }
      grid.replaceChildren(...(items.length ? items.map((m) => videoCard(m, pickAndRecord, cardOpts)) : [h('div', { class: 'lobby-empty' }, 'Bu kategoride henüz video bulunamadı.')]));
    } catch (e) {
      if (mine === seq) await runSearchQuery('Türkiye popüler video müzik sinema 2026', '🔥 Önerilen Videolar', false);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q) {
        activeTab = 'search';
        renderTabs();
        runSearchQuery(q, `🔍 "${q}" için YouTube Arama Sonuçları`, true);
      } else {
        loadTab('all');
      }
    }
  });

  const _unsubSearchYt = subscribe((st) => {
    if (!body.isConnected) { _unsubSearchYt(); return; }
    refreshAuthBar();
  });

  refreshAuthBar();
  renderTabs();
  body.append(
    authHolder,
    h('div', { class: 'sel-search' },
      h('span', { html: icons.search, style: { display: 'flex', opacity: .7 } }),
      input,
      createVoiceSearchButton({
        h,
        icons,
        inputEl: input,
        toast,
        onResult: (q) => {
          activeTab = 'search';
          renderTabs();
          runSearchQuery(q, `🔍 "${q}" için YouTube Arama Sonuçları`, true);
        },
      }),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const q = input.value.trim();
          if (q) {
            activeTab = 'search';
            renderTabs();
            runSearchQuery(q, `🔍 "${q}" için YouTube Arama Sonuçları`, true);
          } else {
            loadTab('all');
          }
        },
      }, 'Ara')),
    tabBar,
    sectionHeader,
    grid
  );
  if (presetQuery) {
    runSearchQuery(presetQuery, `🔍 "${presetQuery}" için YouTube Sonuçları`, true);
  } else {
    loadTab('all');
  }
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
  { id: 'all', label: '✨ Tüm Katalog' },
  { id: 'vizyon', label: '🍿 Vizyondakiler & Yeni (2026)' },
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
  if (catId === 'all') return true;
  if (catId === 'vizyon') {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    return Boolean(it.isVizyon || it.customRelease || cats.includes('vizyon') || Number(it.year || 0) >= 2025);
  }
  if (catId === 'dublaj') {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    const badge = String(it.sourceBadge || it.audioBadge || '');
    return Boolean(cats.includes('dublaj') || it.hasTrDub || it.origLang === 'tr' || /dublaj|türkçe|yerli/i.test(badge) || Number(it.voteCount || 0) >= 800 || Number(it.rating || 0) >= 7.2);
  }
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
  if (window.vortexDesktop?.isElectron && !p.freeNoAuth && p.id !== 'cinema') { renderDesktopKind(p, body, pick); return; }
  const authHolder = h('div', {});
  const input = h('input', { id: 'hub-search-q', placeholder: p.placeholder || `${p.name} içinde binlerce dizi veya film ara...`, value: presetQuery || '', 'aria-label': `${p.name} içinde ara` });
  const mainWrap = h('div', { class: 'catalog-main' });
  const detailWrap = h('div', { class: 'catalog-detail hidden' });
  const catBar = h('div', { class: 'cat-tabs-bar', id: 'catalog-cat-bar' });
  const contentArea = h('div', { class: 'catalog-sections-wrap' });
  let seq = 0;
  let catSeq = 0;
  let catalogLoaded = false;
  let activeCat = p._initialCat || 'all';
  delete p._initialCat;
  let currentItems = [];
  let currentQuery = '';
  let currentPage = 1;
  let hasMorePages = true;
  let loadingMore = false;
  let catalogTotals = { totalAvailable: 0, totalTv: 0, totalMovies: 0 };
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
        const favBadge = catBar.querySelector('.cat-tab-pill[data-cat="favs"] .cat-cnt');
        if (favBadge) favBadge.textContent = String(getFavorites().length);
        if (activeCat === 'favs') renderCategoryView();
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
        h('img', {
          src: it.poster || (it.title ? `/api/rave/poster?${qs({ t: it.title || '', ot: it.originalTitle || '', y: it.year || '', mt: isTv ? 'tv' : 'movie' })}` : '/static/watchlivo-poster.svg'),
          alt: it.title || '',
          loading: 'lazy',
          onerror: (e) => {
            const el = e.currentTarget || e.target;
            if (!el.dataset.healed && it.title) {
              el.dataset.healed = '1';
              el.src = `/api/rave/poster?${qs({ t: it.title || '', ot: it.originalTitle || '', y: it.year || '', mt: isTv ? 'tv' : 'movie' })}`;
            } else {
              el.src = '/static/watchlivo-poster.svg';
            }
          },
        }),
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
        if (!added.length && !hasMorePages) {
          hasMorePages = false;
        } else if (added.length) {
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
    const myCatReq = ++catSeq;
    activeCat = catId;
    currentPage = 1;
    hasMorePages = true;
    renderCategoryView();
    if (catId !== 'all' && catId !== 'favs' && !currentQuery) {
      const catData = await api(`/api/rave/catalog?${qs({ provider: p.id, category: catId, page: 1 })}`, { timeout: 10000 }).catch(() => null);
      if (myCatReq !== catSeq || activeCat !== catId) return;
      if (catData?.items?.length) {
        currentItems = mergeUniqueItems(currentItems, catData.items);
        renderCategoryView();
      }
    }
  };

  const renderCategoryView = () => {
    const favList = getFavorites();
    catBar.replaceChildren(...CATALOG_CATEGORIES.map((c) => {
      let badgeTxt = '';
      const matchCount = (catId) => currentItems.filter((it) => itemMatchesCat(it, catId)).length;
      if (c.id === 'favs') badgeTxt = String(favList.length);
      else if (c.id === 'all') badgeTxt = fmtCount(Math.max(catalogTotals.totalAvailable || 0, currentItems.length));
      else if (c.id === 'series') badgeTxt = fmtCount(Math.max(catalogTotals.totalTv || 0, matchCount('series')));
      else if (c.id === 'movies') badgeTxt = fmtCount(Math.max(catalogTotals.totalMovies || 0, matchCount('movies')));
      else {
        const cnt = matchCount(c.id);
        badgeTxt = cnt > 0 ? `${cnt}+` : '0';
      }
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
        contentArea.replaceChildren(h('div', { class: 'lobby-empty' }, catalogLoaded ? 'Bu kategoride eşleşen içerik bulunamadı.' : 'Bu kategoride içerik yükleniyor...'));
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
      { id: 'vizyon', title: '🍿 Vizyondakiler & Yeni Eklenenler (2026)' },
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
    const archiveTotal = Math.max(catalogTotals.totalAvailable || 0, currentItems.length);
    sections.push(
      h('section', { class: 'cat-section', 'data-shelf': 'full-archive' },
        h('div', { class: 'cat-sec-head' },
          h('h3', {}, archiveTotal > 0 ? `📚 Tüm ${p.name} Dizi ve Filmleri (${fmtCount(archiveTotal)} Arşiv)` : `📚 Tüm ${p.name} Dizi ve Filmleri`)),
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
        totalTv: catData.totalTv || 0,
        totalMovies: catData.totalMovies || 0,
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
      createVoiceSearchButton({ h, icons, inputEl: input, toast, onResult: (q) => { clearTimeout(debTimer); run(q); } }),
      h('button', { class: 'btn primary', onclick: () => { clearTimeout(debTimer); run(input.value); } }, 'Ara'),
      h('button', {
        type: 'button',
        class: 'btn sm',
        id: 'btn-catalog-vizyon',
        title: 'Vizyondaki Yeni Filmleri Gör veya Yeni Film/Dizi Ekle',
        onclick: () => openVizyonModal(pick, (newItem) => {
          currentItems = [newItem, ...currentItems];
          renderCategoryView();
        }),
      }, '🍿 Vizyon & Yeni Ekle'),
      clearBtn),
    catBar,
    contentArea);
  body.append(authHolder, mainWrap, detailWrap);
  refreshAuth();
}

export function openVizyonModal(pick, onAdded) {
  const wrap = h('div', { class: 'wl-vizyon-modal', style: { display: 'flex', flexDirection: 'column', gap: '14px', minHeight: '360px' } });
  const titleIn = h('input', { class: 'input', placeholder: 'Film veya Dizi Adı (örn: Dune: Part Three, Eşref Rüya...)', 'aria-label': 'Film veya Dizi Adı' });
  const typeSel = h('select', { class: 'input', style: { maxWidth: '140px' }, 'aria-label': 'Tür Seçimi' },
    h('option', { value: 'movie' }, '🎬 Sinema Filmi'),
    h('option', { value: 'tv' }, '📺 Dizi / Sezon'),
  );
  const yearIn = h('input', { class: 'input', placeholder: 'Yıl veya TMDB ID (opsiyonel)', style: { maxWidth: '190px' }, 'aria-label': 'Yıl veya TMDB ID' });
  const streamIn = h('input', { class: 'input', placeholder: 'Doğrudan .m3u8 / .mp4 veya Kaynak URL (opsiyonel — boşsa otomatik aranır)', 'aria-label': 'Akış veya Kaynak URL' });
  const addForm = h('div', {
    class: 'wl-vizyon-form hidden',
    style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '14px', background: 'rgba(15, 23, 42, 0.78)', border: '1px solid rgba(56, 189, 248, 0.28)' },
  });
  const gridWrap = h('div', { class: 'poster-grid', style: { minHeight: '220px' } }, spinner());
  let closeRef = null;

  const startItem = async (it) => {
    if (!pick) return;
    toast(`🍿 "${it.title}" odada hazırlanıyor...`);
    const resolved = await resolveCatalogItem(it, { id: it.provider || 'cinema', name: 'Sinema+ Vizyon' });
    if (resolved) {
      closeRef?.close?.();
      await pick(resolved);
    }
  };

  const renderItems = (items) => {
    if (!Array.isArray(items) || !items.length) {
      gridWrap.replaceChildren(h('div', { class: 'lobby-empty' }, 'Vizyon havuzunda henüz içerik bulunamadı.'));
      return;
    }
    gridWrap.replaceChildren(...items.slice(0, 36).map((it) => {
      const isTv = it.mediaType === 'tv';
      return h('div', {
        class: 'poster-card',
        tabIndex: 0,
        role: 'button',
        'aria-label': `${it.title} (${it.year || '2026'})`,
        onclick: () => startItem(it),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startItem(it); } },
      },
        h('div', { class: 'poster-img-wrap' },
          it.poster
            ? h('img', { src: it.poster, alt: it.title, loading: 'lazy' })
            : h('div', { class: 'poster-fallback' }, isTv ? '📺' : '🎬'),
          h('span', { class: 'poster-badge' }, it.customRelease ? '✨ Yeni Eklendi' : (it.sourceBadge || '🍿 Vizyonda')),
          it.rating ? h('span', { class: 'poster-rating' }, `★ ${it.rating}`) : null,
        ),
        h('div', { class: 'poster-meta' },
          h('div', { class: 'poster-title' }, it.title),
          h('div', { class: 'poster-sub' }, `${it.year || '2026'} · ${isTv ? 'Dizi' : 'Film'}`),
        ),
      );
    }));
  };

  const loadVizyon = async (refresh = false) => {
    gridWrap.replaceChildren(spinner());
    const res = await api(`/api/rave/new-releases${refresh ? '?refresh=1' : ''}`, { timeout: 12000 }).catch(() => null);
    if (res?.items) {
      renderItems(res.items);
      if (refresh) toast(`🍿 Vizyon taraması tamamlandı (${res.items.length} film & dizi aktif)!`);
    } else {
      renderItems([]);
    }
  };

  const submitNewRelease = async () => {
    const title = titleIn.value.trim();
    const rawYrTid = yearIn.value.trim();
    if (!title && !/^\d+$/.test(rawYrTid)) {
      toast('Lütfen film/dizi adını veya TMDB kimliğini girin.');
      return;
    }
    const isTmdbId = /^\d{3,10}$/.test(rawYrTid) && Number(rawYrTid) > 2100;
    const body = {
      title,
      mediaType: typeSel.value,
      year: !isTmdbId && /^\d{4}$/.test(rawYrTid) ? rawYrTid : '',
      tmdbId: isTmdbId ? rawYrTid : '',
      streamUrl: streamIn.value.trim(),
      sourceUrl: streamIn.value.trim(),
    };
    toast('⏳ Yeni içerik vizyon kataloğuna ekleniyor...');
    const res = await api('/api/rave/new-releases', { method: 'POST', body }).catch(() => null);
    if (res?.ok && res.item) {
      toast(`✅ "${res.item.title}" vizyon kataloğuna eklendi!`);
      titleIn.value = '';
      yearIn.value = '';
      streamIn.value = '';
      addForm.classList.add('hidden');
      onAdded?.(res.item);
      await loadVizyon(true);
    } else {
      toast(res?.error || 'İçerik eklenirken bir sorun oluştu.');
    }
  };

  addForm.append(
    h('div', { style: { fontWeight: '700', fontSize: '0.9rem', color: '#38bdf8' } }, '➕ Yeni Vizyon Filmi veya Dizi Ekle (TMDB Otomatik Afiş & Akış Tanıma)'),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, titleIn, typeSel, yearIn),
    streamIn,
    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => addForm.classList.add('hidden') }, 'Vazgeç'),
      h('button', { type: 'button', class: 'btn sm primary', id: 'btn-submit-vizyon', onclick: submitNewRelease }, '🚀 Kataloğa Ekle'),
    ),
  );

  const topActions = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' } },
    h('div', { style: { fontSize: '0.84rem', opacity: '0.85' } }, 'Sinema salonlarındaki yeni filmler ve yeni bölüm diziler otomatik taranır veya 1 tıkla eklenir.'),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', {
        type: 'button',
        class: 'btn sm',
        id: 'btn-scan-vizyon-now',
        onclick: () => loadVizyon(true),
      }, '🔄 Vizyonu Şimdi Tara'),
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        id: 'btn-toggle-vizyon-form',
        onclick: () => addForm.classList.toggle('hidden'),
      }, '➕ Yeni Film / Dizi Ekle'),
    ),
  );

  wrap.append(topActions, addForm, gridWrap);
  closeRef = popup({
    title: '🍿 Vizyondakiler & Yeni Eklenen Film / Diziler (2026)',
    content: wrap,
    wide: true,
    options: [{ label: 'Kapat' }],
  });
  loadVizyon(false);
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
      h('span', { style: { fontSize: '.74rem', fontWeight: '700', color: '#6366f1', background: 'rgba(99, 102, 241,0.14)', border: '1px solid rgba(99, 102, 241,0.3)', padding: '4px 10px', borderRadius: '999px' } }, `● AI Radyo (${aiCfg.openaiModel})`),
      h('span', { style: { fontSize: '.74rem', fontWeight: '700', color: '#fb7185', background: 'rgba(244,63,94,0.14)', border: '1px solid rgba(244,63,94,0.3)', padding: '4px 10px', borderRadius: '999px' } }, `● ${aiCfg.sunoModel || 'suno-v4.5'}`),
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
        h('span', { class: 'tr-sub-pill', style: it.isRemix ? { background: 'rgba(245,158,11,.22)', borderColor: '#f59e0b', color: '#fde68a' } : { background: 'rgba(99, 102, 241,.2)', borderColor: '#6366f1', color: '#a7f3d0' } }, verLabel),
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
    const topRecent = recentList[0] || null;
    const sections = [];

    if (!currentQuery && activeCat === 'all') {
      if (recentList.length) {
        sections.push(
          h('section', { class: 'cat-section', 'data-shelf': 'music-recent' },
            h('div', { class: 'cat-sec-head' },
              h('h3', {}, `🕘 Son Çalınanlar & Tekrar Dinle (${recentList.length})`),
              h('span', { class: 'cat-total-pill' }, '🎧 Dinleme Geçmişin')),
            h('div', { class: 'cat-shelf-row' }, ...recentList.slice(0, 12).map(makeMusicCard))));
      }

      if ((data.similarItems || []).length && topRecent) {
        sections.push(
          h('section', { class: 'cat-section', 'data-shelf': 'music-similar' },
            h('div', { class: 'cat-sec-head' },
              h('h3', {}, `✨ Son Çalınanlara Göre Benzer Müzikler (${topRecent.artist || ''} — ${topRecent.songTitle || topRecent.title || ''} Mix)`),
              h('span', { class: 'cat-total-pill' }, '📻 Benzer Şarkılar')),
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
    const recent = getMusicHistory()[0] || {};
    const data = await api(`/api/rave/music-catalog?${qs({
      provider: p.id,
      category: activeCat,
      q: raw,
      recentArtist: recent.artist || '',
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

export function renderDriveKind(p, body, pick) {
  const folderInp = h('input', {
    placeholder: p.placeholder || 'Google Drive klasör veya video bağlantısı yapıştır (drive.google.com/drive/folders/...)',
    value: '',
    'aria-label': 'Google Drive klasör veya dosya bağlantısı',
  });
  const qualityHolder = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } });
  const listHolder = h('div', { class: 'card-grid' });
  let selectedQuality = '1080p';
  let cachedDriveItems = [];

  const renderDriveItems = (items) => {
    cachedDriveItems = items || [];
    qualityHolder.replaceChildren(
      h('span', { style: { fontSize: '.78rem', color: '#94a3b8', alignSelf: 'center', marginRight: '4px' } }, '🎞️ Çözünürlük & MKV/MP4 Akış Kalitesi:'),
      ...['1080p', '720p', '480p'].map((q) => h('button', {
        type: 'button',
        class: `provider-cat-pill ${selectedQuality === q ? 'active' : ''}`,
        onclick: () => {
          selectedQuality = q;
          renderDriveItems(cachedDriveItems);
        },
      }, `🎬 ${q} Direct Stream`))
    );
    listHolder.replaceChildren(...cachedDriveItems.map((it) => {
        const qObj = (it.qualities || []).find((x) => x.label === selectedQuality) || (it.qualities || [])[0] || { url: it.url };
        return videoCard({
          provider: 'direct',
          streamType: 'mp4',
          videoId: it.id,
          url: qObj.url || it.url,
          title: `${it.title} [${selectedQuality}]`,
          channel: `Google Drive · ${it.size || 'HD'}`,
          thumbnail: it.thumbnail || '/static/watchlivo-poster.svg',
          duration: it.duration || 0,
        }, pick);
      }));
  };

  const loadFolder = async (rawUrl = '') => {
    listHolder.replaceChildren(spinner());
    try {
      const res = await api(`/api/rave/gdrive-folder?${qs({ url: rawUrl })}`, { timeout: 12000 });
      renderDriveItems(res.items || res.presets || []);
    } catch (e) {
      listHolder.replaceChildren(h('div', { class: 'lobby-empty' }, 'Google Drive klasörü okunamadı.'));
    }
  };

  body.append(
    renderAccountBar(p, () => loadFolder(folderInp.value.trim())),
    h('div', { class: 'sel-search' },
      h('span', { html: icons.link, style: { display: 'flex', opacity: .7 } }),
      folderInp,
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const val = folderInp.value.trim();
          if (!val) { folderInp.focus(); toast('Lütfen bir Google Drive klasör veya dosya bağlantısı yapıştırın'); return; }
          loadFolder(val);
        },
      }, '📂 Klasörü / Videoyu Aç')),
    qualityHolder,
    listHolder
  );
  listHolder.replaceChildren(h('div', { class: 'lobby-empty' }, 'Google Drive klasör veya video bağlantısını yukarıya yapıştırıp "Klasörü / Videoyu Aç" butonuna tıklayın.'));
}

export function renderRaveDjKind(p, body, pick) {
  const trackAInp = h('input', {
    class: 'input',
    placeholder: '1. Şarkı adı veya YouTube URL girin...',
    value: '',
  });
  const trackBInp = h('input', {
    class: 'input',
    placeholder: '2. Şarkı adı veya YouTube URL girin...',
    value: '',
  });
  const statusBox = h('div', { style: { marginTop: '10px' } });
  const presetGrid = h('div', { class: 'card-grid', style: { marginTop: '12px' } });

  const createMashup = async (aVal, bVal) => {
    statusBox.replaceChildren(spinner());
    try {
      const res = await api('/api/rave/ravedj-mashup', {
        method: 'POST',
        body: { trackA: aVal, trackB: bVal },
        timeout: 15000,
      });
      if (res?.mashup) {
        toast(`🎧 Watchlivo DJ Mashup hazır: ${res.mashup.title}`);
        await pick(res.mashup);
      }
    } catch (e) {
      toast('Watchlivo DJ Mashup oluşturulamadı, lütfen tekrar dene');
    } finally {
      statusBox.replaceChildren();
    }
  };

  api('/api/rave/ravedj-trending').then((res) => {
    const items = res.items || res.presets || [];
    presetGrid.replaceChildren(...items.map((it) => h('div', {
      class: 'vcard',
      role: 'button',
      tabindex: '0',
      onclick: async () => {
        if (it.url && /^https?:\/\//i.test(it.url)) {
          toast(`🎧 RaveDJ Mix başlatılıyor: ${it.title}`);
          await pick({ provider: 'direct', streamType: 'mp4', url: it.url, title: it.title, thumbnail: it.thumbnail || '/static/watchlivo-poster.svg', channel: it.channel || 'Watchlivo DJ', duration: it.duration || 0 });
        } else if (it.trackA || it.trackB) {
          await createMashup(it.trackA || it.title, it.trackB || '');
        }
      },
    },
      h('div', { class: 'vcard-thumb', style: { background: 'linear-gradient(135deg,#ec4899,#6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '110px', fontSize: '2rem', position: 'relative', overflow: 'hidden' } },
        it.thumbnail ? h('img', { src: it.thumbnail, alt: it.title, style: { width: '100%', height: '100%', objectFit: 'cover' }, onerror: (e) => { e.target.remove(); } }) : '🎧',
        it.bpm ? h('span', { class: 'vcard-dur' }, `${it.bpm} BPM`) : null),
      h('div', { class: 'vcard-info' },
        h('div', { class: 'vcard-title' }, it.title),
        h('div', { class: 'vcard-sub' }, it.channel || (it.trackA && it.trackB ? `${it.trackA} × ${it.trackB}` : 'RaveDJ Mix'))))));
  }).catch(() => {});

  body.append(
    h('div', {
      style: {
        padding: '16px', borderRadius: '16px',
        background: 'linear-gradient(135deg, rgba(236,72,153,0.16), rgba(99,102,241,0.16))',
        border: '1px solid rgba(236,72,153,0.35)', marginBottom: '14px',
      },
    },
      h('div', { style: { fontWeight: '800', fontSize: '1rem', color: '#f8fafc', marginBottom: '6px' } }, '🎧 Watchlivo DJ AI Mashup & Çift Şarkı Mix Motoru'),
      h('div', { style: { fontSize: '.82rem', color: '#cbd5e1', marginBottom: '12px' } },
        'İki farklı şarkıyı veya YouTube bağlantısını seç; Watchlivo DJ yapay zeka BPM & vokal-ritim sentezleyici ile anında ortak Mashup oluşturup odada başlat!'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', marginBottom: '12px' } },
        trackAInp,
        trackBInp),
      h('button', {
        type: 'button',
        class: 'btn primary',
        onclick: () => createMashup(trackAInp.value.trim(), trackBInp.value.trim()),
      }, '⚡ AI Mashup Oluştur & Odaya Yansıt'),
      statusBox),
    h('div', { class: 'section-head' }, h('h2', {}, '🔥 Popüler Watchlivo DJ Mashup Şablonları')),
    presetGrid
  );
}

