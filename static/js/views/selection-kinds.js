// Provider selection views by kind (Rave YouTubeSelection / WebSelection / Catalog / upload).
import { h, fill, icons, toast, popup, openThemeModal, openAiConfigModal, getAiApiConfig } from '../ui.js?v=20261110_v170';
import { api, qs } from '../api.js?v=20261110_v170';
import { parseVideoUrl, getProvider } from '../providers.js?v=20261110_v170';
import { videoCard, ytToMedia, resolveMedia, openYtPersonalizeModal } from './selection.js?v=20261110_v170';
import { renderAccountBar, renderSeriesPicker, getAccount, openProviderLoginModal, openNetflixLoginModal } from '../accounts.js?v=20261110_v170';
import { profileSetup } from '../profile.js?v=20261110_v170';
import { createVoiceSearchButton } from '../voice-note.js?v=20261110_v170';
import {
  getFavorites, isFavoriteMedia, toggleFavoriteMedia, getMusicHistory, saveMusicHistory, clearMusicHistory,
  getWatchHistory, clearWatchHistory, saveWatchProgress, findSavedProgress,
  getYtPrefs, recordYtSearchQuery, fetchPersonalizedYtFeed, subscribe, state,
} from '../store.js?v=20261110_v170';

export async function resolveCatalogItem(it, prov, season = 1, episode = 1, epName = '', opts = {}) {
  const provId = prov?.id || it?.provider || 'cinema';
  const acct = getAccount(provId);
  const mediaType = it.mediaType || (it.type === 'SHOW' ? 'tv' : 'movie');
  const s = Math.max(1, Number(season) || 1);
  const e = Math.max(1, Number(episode) || 1);
  const rawTid = /^\d+$/.test(String(it.tmdbId || '').trim()) ? String(it.tmdbId).trim() : (/^\d+$/.test(String(it.id || '').trim()) ? String(it.id).trim() : '');
  const query = qs({
    provider: provId,
    title: it.originalTitle || it.title || prov?.name || provId,
    originalTitle: it.originalTitle || '',
    displayTitle: it.title || prov?.name || provId,
    year: it.year || '',
    tmdbId: rawTid,
    imdbId: it.imdbId || '',
    mediaType,
    poster: it.backdrop || it.poster || '',
    sourceUrl: it.officialUrl || it.sourceUrl || '',
    season: s,
    episode: e,
    accountEmail: acct?.accountEmail || '',
    authSatisfied: acct?.loginSatisfied ? '1' : '0',
    profileName: acct?.profileName || '',
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const qTry = attempt === 1 ? `${query}&refresh=1` : query;
      const res = await api(`/api/rave/resolve-catalog?${qTry}`, { timeout: 18000 });
      if (res?.authRequired || res?.status === 401) {
        const targetProv = (provId === 'max' || it?.provider === 'max') ? (getProvider('max') || prov) : prov;
        toast(res.error || (targetProv?.id === 'max' ? 'Max içeriklerini izlemek için önce Max hesabınızı bağlamalısınız.' : `${targetProv?.name || 'Sağlayıcı'} oturumu gerekli.`));
        if (targetProv) openProviderLoginModal(targetProv);
        return null;
      }
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
      if (err.status === 401 || err.data?.authRequired) {
        const targetProv = (provId === 'max' || it?.provider === 'max') ? (getProvider('max') || prov) : prov;
        toast(err.data?.error || (targetProv?.id === 'max' ? 'Max içeriklerini izlemek için önce Max hesabınızı bağlamalısınız.' : `${targetProv?.name || 'Sağlayıcı'} oturumu gerekli.`));
        if (targetProv) openProviderLoginModal(targetProv);
        return null;
      }
      if (attempt === 1) {
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
    const signedIn = Boolean(state.self && !state.self.isGuest && state.self.authToken);
    const prefs = getYtPrefs();
    const ytConnected = Boolean(signedIn && prefs.googleConnected && prefs.googleEmail);
    const uLabel = ytConnected
      ? `${prefs.googleChannelTitle || state.self.name || 'YouTube Hesabım'} (${prefs.googleEmail})`
      : signedIn
        ? `${state.self.name || 'Hesabım'} (@${state.self.handle || 'uye'}) — YouTube Hesabı Henüz Bağlı Değil`
        : 'YouTube / Google ile Giriş Yap (Şifre Doğrulamalı)';
    const subCount = prefs.subscriptions.length;
    const likeCount = prefs.likedVideos.length;
    fill(authHolder, 
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px',
          padding: '10px 14px', borderRadius: '14px',
          background: ytConnected ? 'linear-gradient(135deg, rgba(255,0,51,0.14), rgba(15,23,42,0.88))' : 'rgba(15, 23, 42, 0.78)',
          border: ytConnected ? '1px solid rgba(255, 0, 51, 0.36)' : '1px solid rgba(255, 255, 255, 0.1)',
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
              ytConnected ? `🔴 ${uLabel}` : uLabel,
              ytConnected ? h('span', { style: { fontSize: '.68rem', background: 'rgba(39,220,200,0.16)', color: '#27DCC8', padding: '2px 7px', borderRadius: '99px' } }, '✓ YouTube & Google Bağlı') : null,
              h('span', { style: { fontSize: '.68rem', background: 'rgba(34,197,94,0.16)', color: '#4ade80', padding: '2px 7px', borderRadius: '99px' } }, '🛡️ Reklamsız 1080p')),
            h('div', { style: { fontSize: '.76rem', color: '#94a3b8' } },
              ytConnected
                ? `${subCount} takip edilen kanal · ${likeCount} beğenilen video · İzleme ve arama geçmişine göre canlı öneriler`
                : 'YouTube akışını kişiselleştirmek için Google e-posta adresin ve şifrenle giriş yaparak hesabını eşitleyebilirsin.'))),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            class: 'btn sm primary',
            onclick: () => openYtPersonalizeModal(() => { refreshAuthBar(); loadTab(activeTab, true); }),
          }, ytConnected ? '🔗 Kanal & Google Eşitle' : '🔑 YouTube / Google Şifreli Giriş'),
          !signedIn ? h('button', {
            type: 'button',
            class: 'btn sm ghost',
            onclick: () => profileSetup({ current: state.self, initialTab: 'login', onDone: () => { refreshAuthBar(); loadTab('all', true); } }),
          }, '👤 Watchlivo Hesabı') : null,
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
    const refreshAuth = () => fill(authHolder, renderAccountBar(p, refreshAuth));
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
      const upHeaders = {};
      if (state.self?.authToken) upHeaders.Authorization = `Bearer ${state.self.authToken}`;
      const res = await fetch('/api/upload', { method: 'POST', headers: upHeaders, body: fd });
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
    return Boolean(cats.includes('dublaj') || it.hasTrDub || it.origLang === 'tr' || /dublaj|türkçe|yerli/i.test(badge));
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

function makeNetflixSpotlightBar(p, pick, pickFromUrl) {
  const linkInp = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'netflix.com/watch/... bağlantısı yapıştırın veya film/dizi adı yazın...',
    style: {
      flex: '1 1 320px',
      padding: '12px 16px',
      borderRadius: '10px',
      fontSize: '.9rem',
      background: 'rgba(20, 20, 20, 0.95)',
      border: '1px solid rgba(229, 9, 20, 0.45)',
      color: '#fff',
      outline: 'none',
    },
  });

  const launchBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
      borderColor: '#e50914',
      padding: '12px 20px',
      borderRadius: '10px',
      fontWeight: '800',
      fontSize: '.9rem',
      boxShadow: '0 4px 16px rgba(229, 9, 20, 0.45)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
  },
    h('span', {}, '🚀'),
    h('span', {}, 'Odayı Başlat')
  );

  const openBrowseBtn = h('button', {
    type: 'button',
    class: 'btn secondary',
    style: {
      background: 'rgba(255, 255, 255, 0.08)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      padding: '12px 18px',
      borderRadius: '10px',
      fontWeight: '700',
      fontSize: '.88rem',
      color: '#ffffff',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    },
    onclick: () => {
      window.open('https://www.netflix.com/browse', '_blank');
      toast('netflix.com/browse açıldı. Dilediğiniz filmi açıp bağlantısını buraya yapıştırabilirsiniz.');
    },
  },
    h('span', {}, '🌐'),
    h('span', {}, 'netflix.com/browse Aç (Dizi & Film Seç) ↗')
  );

  const handleLaunch = async () => {
    const rawVal = linkInp.value.trim();
    if (!rawVal) {
      toast('Lütfen bir Netflix bağlantısı yapıştırın veya film/dizi adı yazın');
      linkInp.focus();
      return;
    }
    toast(`⏳ Netflix içeriği çözümleniyor: ${rawVal}...`);
    launchBtn.disabled = true;
    launchBtn.style.opacity = '0.6';
    try {
      if (pickFromUrl && /^https?:\/\//i.test(rawVal)) {
        await pickFromUrl(rawVal, 'Netflix İçeriği');
      } else {
        const res = await resolveCatalogItem(
          { title: rawVal, originalTitle: rawVal, sourceUrl: rawVal.startsWith('http') ? rawVal : '', provider: 'netflix' },
          p, 1, 1
        );
        if (res) {
          toast(`✓ Oda başlatılıyor: ${res.title}`);
          await pick(res);
        }
      }
    } catch (err) {
      toast('İçerik çözümlenemedi, lütfen tekrar deneyin');
    } finally {
      launchBtn.disabled = false;
      launchBtn.style.opacity = '1';
    }
  };

  launchBtn.onclick = handleLaunch;
  linkInp.onkeydown = (e) => {
    if (e.key === 'Enter') handleLaunch();
  };

  return h('div', {
    class: 'netflix-spotlight-bar',
    style: {
      margin: '0 0 16px',
      padding: '14px 18px',
      borderRadius: '14px',
      background: 'linear-gradient(135deg, rgba(229, 9, 20, 0.22) 0%, rgba(20, 20, 20, 0.95) 100%)',
      border: '1px solid rgba(229, 9, 20, 0.45)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    },
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
      h('div', { style: { fontWeight: '700', fontSize: '.92rem', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { color: '#e50914', fontWeight: '900' } }, 'NETFLIX'),
        h('span', {}, 'Doğrudan Netflix Bağlantısı veya Başlık ile Oda Kur:')
      ),
      h('div', { style: { fontSize: '.8rem', color: '#94a3b8' } },
        'Desteklenen: netflix.com/watch/*, netflix.com/title/* veya film/dizi adı'
      )
    ),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
      linkInp,
      launchBtn,
      openBrowseBtn
    )
  );
}

export function renderCatalogKind(p, body, presetQuery, pick, pickFromUrl) {
  if (p.id === 'max') {
    return renderMaxRavePortal(p, body, presetQuery, pick, pickFromUrl);
  }
  if (p.id === 'netflix') {
    return renderNetflixRavePortal(p, body, presetQuery, pick, pickFromUrl);
  }
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
    const acct = getAccount(p.id);
    if (p.id === 'max' && !acct.loginSatisfied) {
      const hero = h('div', {
        class: 'max-gating-hero',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
          padding: '18px 22px',
          marginBottom: '16px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, rgba(0, 43, 231, 0.22) 0%, rgba(13, 16, 27, 0.95) 100%)',
          border: '1px solid rgba(0, 43, 231, 0.45)',
          boxShadow: '0 8px 30px rgba(0, 43, 231, 0.18)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', flex: '1 1 320px' } },
          h('div', {
            style: {
              width: '48px',
              height: '48px',
              minWidth: '48px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #002be7, #4f46e5)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: '900',
              fontSize: '1.15rem',
              letterSpacing: '-0.5px',
              boxShadow: '0 4px 14px rgba(0, 43, 231, 0.45)',
            },
          }, 'MAX'),
          h('div', {},
            h('div', { style: { fontWeight: '800', fontSize: '1.02rem', color: '#f8fafc', marginBottom: '4px', letterSpacing: '-0.2px' } },
              'HBO Max Resmi Abonelik Alanı — Watchlivo\'da arkadaşlarınızla senkronize Max izlemek için Max hesabınızla giriş yapın.'),
            h('div', { style: { fontSize: '.84rem', color: '#94a3b8', lineHeight: '1.45' } },
              'Max arşivindeki 4K film, dizi ve HBO yapımlarını odadaki arkadaşlarınızla canlı senkron izlemek için hesabınızı doğrulayın.'))),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            class: 'btn primary',
            style: {
              background: 'linear-gradient(135deg, #002be7, #4f46e5)',
              borderColor: '#3b82f6',
              color: '#ffffff',
              fontWeight: '800',
              padding: '11px 22px',
              borderRadius: '10px',
              boxShadow: '0 4px 18px rgba(0, 43, 231, 0.45)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '.94rem',
            },
            onclick: () => openProviderLoginModal(p, () => refreshAuth()),
          },
            h('span', {}, '🔑'),
            h('span', {}, 'HBO Max Hesabıyla Giriş Yap')
          )
        )
      );
      fill(authHolder, hero);
    } else if (p.id === 'netflix' && !acct.loginSatisfied) {
      const hero = h('div', {
        class: 'netflix-gating-hero',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
          padding: '18px 22px',
          marginBottom: '16px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, rgba(229, 9, 20, 0.22) 0%, rgba(13, 16, 27, 0.95) 100%)',
          border: '1px solid rgba(229, 9, 20, 0.45)',
          boxShadow: '0 8px 30px rgba(229, 9, 20, 0.18)',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', flex: '1 1 320px' } },
          h('div', {
            style: {
              width: '48px',
              height: '48px',
              minWidth: '48px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #e50914, #b20710)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: '900',
              fontSize: '1.25rem',
              letterSpacing: '-0.5px',
              boxShadow: '0 4px 14px rgba(229, 9, 20, 0.45)',
            },
          }, 'N'),
          h('div', {},
            h('div', { style: { fontWeight: '800', fontSize: '1.02rem', color: '#f8fafc', marginBottom: '4px', letterSpacing: '-0.2px' } },
              'Netflix Resmi Abonelik Alanı — Watchlivo\'da arkadaşlarınızla senkronize Netflix izlemek için Netflix hesabınızla giriş yapın.'),
            h('div', { style: { fontSize: '.84rem', color: '#94a3b8', lineHeight: '1.45' } },
              'Netflix arşivindeki 4K film, dizi ve orijinal yapımları odadaki arkadaşlarınızla canlı senkron izlemek için hesabınızı bağlayın.'))),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            class: 'btn primary',
            style: {
              background: 'linear-gradient(135deg, #e50914, #b20710)',
              borderColor: '#e50914',
              color: '#ffffff',
              fontWeight: '800',
              padding: '11px 22px',
              borderRadius: '10px',
              boxShadow: '0 4px 18px rgba(229, 9, 20, 0.45)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '.94rem',
            },
            onclick: () => openProviderLoginModal(p, () => refreshAuth()),
          },
            h('span', {}, '🔑'),
            h('span', {}, 'Netflix Hesabıyla Giriş Yap')
          )
        )
      );
      fill(authHolder, hero);
    } else {
      const children = [
        renderAccountBar(p, refreshAuth, pickFromUrl, (it) => openDetail(it))
      ];
      if (p.id === 'netflix') {
        children.push(makeNetflixSpotlightBar(p, pick, pickFromUrl));
      } else if (p.id === 'max') {
        children.push(h('div', {
          class: 'max-spotlight-bar',
          style: {
            margin: '0 0 16px',
            padding: '14px 18px',
            borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(0, 43, 231, 0.25) 0%, rgba(15, 23, 42, 0.9) 100%)',
            border: '1px solid rgba(0, 43, 231, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', { style: { fontSize: '18px' } }, '🔥'),
            h('div', {},
              h('div', { style: { fontWeight: '800', fontSize: '.92rem', color: '#f8fafc' } }, 'HBO Max Öne Çıkanlar — Canlı Senkron İzle'),
              h('div', { style: { fontSize: '.78rem', color: '#94a3b8' } }, 'City of God: The Fight Rages On, The Penguin, House of the Dragon, The Last of Us')
            )
          ),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              class: 'btn sm primary',
              style: { background: '#002be7', fontWeight: '700', borderRadius: '8px', fontSize: '.78rem' },
              onclick: async () => {
                const resolved = await resolveCatalogItem(
                  { tmdbId: '223397', title: 'City of God: The Fight Rages On', originalTitle: 'Cidade de Deus: A Luta Não Para', mediaType: 'tv', provider: 'max' },
                  { id: 'max', name: 'Max' }, 1, 1
                );
                if (resolved) {
                  const { setView } = await import('../state.js?v=20261110_v170');
                  setView('left', 'Room');
                }
              },
            }, '🎬 City of God (S1:B1)'),
            h('button', {
              type: 'button',
              class: 'btn sm secondary',
              style: { fontWeight: '700', borderRadius: '8px', fontSize: '.78rem' },
              onclick: async () => {
                const resolved = await resolveCatalogItem(
                  { tmdbId: '100088', title: 'The Last of Us', originalTitle: 'The Last of Us', mediaType: 'tv', provider: 'max' },
                  { id: 'max', name: 'Max' }, 2, 1
                );
                if (resolved) {
                  const { setView } = await import('../state.js?v=20261110_v170');
                  setView('left', 'Room');
                }
              },
            }, '🎬 The Last of Us (S2:B1)'),
            h('button', {
              type: 'button',
              class: 'btn sm secondary',
              style: { fontWeight: '700', borderRadius: '8px', fontSize: '.78rem' },
              onclick: async () => {
                const resolved = await resolveCatalogItem(
                  { tmdbId: '94997', title: 'House of the Dragon', originalTitle: 'House of the Dragon', mediaType: 'tv', provider: 'max' },
                  { id: 'max', name: 'Max' }, 2, 1
                );
                if (resolved) {
                  const { setView } = await import('../state.js?v=20261110_v170');
                  setView('left', 'Room');
                }
              },
            }, '🎬 House of the Dragon')
          )
        ));
      }
      fill(authHolder, ...children.filter(Boolean));
    }
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

    const card = h('div', { class: 'poster catalog-card', role: 'button', tabindex: '0', onclick: () => openDetail(it), onkeydown: (e) => { if (e.target === card && e.key === 'Enter') openDetail(it); } },
      h('div', { class: 'poster-thumb-wrap' },
        h('img', {
          src: it.poster || (it.title ? `/api/rave/poster?${qs({ tid: it.tmdbId || it.id || '', t: it.title || '', ot: it.originalTitle || '', y: it.year || '', mt: isTv ? 'tv' : 'movie' })}` : '/static/watchlivo-poster.svg'),
          alt: it.title || '',
          loading: 'lazy',
          onerror: (e) => {
            const el = e.currentTarget || e.target;
            if (!el.dataset.healed && (it.title || it.tmdbId)) {
              el.dataset.healed = '1';
              el.src = `/api/rave/poster?${qs({ tid: it.tmdbId || it.id || '', t: it.title || '', ot: it.originalTitle || '', y: it.year || '', mt: isTv ? 'tv' : 'movie' })}`;
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
      if (!sentinelEl.isConnected || !body.isConnected) {
        if (ioObserver) { ioObserver.disconnect(); ioObserver = null; }
        return;
      }
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
      const qLower = currentQuery.trim().toLowerCase();
      const shownFavs = qLower ? favList.filter((it) => `${it.title || ''} ${it.originalTitle || ''} ${it.year || ''}`.toLowerCase().includes(qLower)) : favList;
      if (!shownFavs.length) {
        contentArea.replaceChildren(h('div', { class: 'lobby-empty' }, qLower ? 'Favorilerinizde aramanızla eşleşen içerik bulunamadı.' : 'Henüz favorilere eklenmiş bir dizi veya film yok.'));
        return;
      }
      contentArea.replaceChildren(
        h('section', { class: 'cat-section' },
          h('div', { class: 'cat-sec-head' }, h('h3', {}, `❤️ Favori Dizi & Filmlerim (${shownFavs.length})`)),
          h('div', { class: 'poster-grid' }, ...shownFavs.map(makePoster))));
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
    if (mine !== seq || input.value.trim() !== raw) return;
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
      debTimer = setTimeout(() => run(input.value), 200);
    } else if (val.length === 1 && currentQuery.length >= 2) {
      debTimer = setTimeout(() => run(''), 200);
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
  let activeVizyonFilter = 'ready';
  let cachedVizyonItems = [];
  let cachedLatestEps = [];

  const startItem = async (it, directEpisode = false) => {
    if (!pick) return;
    if (it.mediaType === 'tv' && directEpisode && it.season && it.episode) {
      toast(`🆕 "${it.title}" ${it.season}. Sezon ${it.episode}. Bölüm odada hazırlanıyor...`);
      const resolved = await resolveCatalogItem(it, { id: it.provider || 'cinema', name: 'Sinema+ Yeni Bölüm' }, Number(it.season) || 1, Number(it.episode) || 1);
      if (resolved) {
        closeRef?.close?.();
        await pick(resolved);
      }
      return;
    }
    if (it.mediaType === 'tv') {
      const seriesHost = h('div', { style: { minHeight: '220px' } });
      let pickerPopup = null;
      pickerPopup = popup({ title: `📺 ${it.title} — Sezon & Bölüm Seç`, content: seriesHost, wide: true, options: [] });
      await renderSeriesPicker(
        it,
        { id: it.provider || 'cinema', name: 'Sinema+ Vizyon' },
        seriesHost,
        () => pickerPopup?.close?.(),
        async (media) => {
          pickerPopup?.close?.();
          closeRef?.close?.();
          await pick(media);
        },
        resolveCatalogItem
      );
      return;
    }
    toast(`🍿 "${it.title}" odada hazırlanıyor...`);
    const resolved = await resolveCatalogItem(it, { id: it.provider || 'cinema', name: 'Sinema+ Vizyon' });
    if (resolved) {
      closeRef?.close?.();
      await pick(resolved);
    } else if (it.streamReady === false) {
      toast(`🎟️ "${it.title}" şu an yalnızca sinema salonlarında — dijital akışa düştüğü anda otomatik aktifleşecek!`);
    }
  };

  const renderItems = (items) => {
    let list = Array.isArray(items) ? items : [];
    const isEpMode = activeVizyonFilter === 'episodes';
    if (!isEpMode) {
      if (activeVizyonFilter === 'ready') {
        const readyOnly = list.filter((x) => x.streamReady !== false);
        if (readyOnly.length) list = readyOnly;
      } else if (activeVizyonFilter === 'theatrical') {
        list = list.filter((x) => x.streamReady === false);
      }
    }
    if (!list.length) {
      gridWrap.replaceChildren(h('div', { class: 'lobby-empty' }, activeVizyonFilter === 'theatrical' ? 'Şu an yalnızca sinemada olan bekleyen film bulunmuyor; tüm vizyon içeriklerinin akışı hazır!' : 'Vizyon havuzunda henüz içerik bulunamadı.'));
      return;
    }
    gridWrap.replaceChildren(...list.slice(0, 36).map((it) => {
      const isTv = it.mediaType === 'tv';
      const epTag = (isEpMode && it.season && it.episode) ? `S${it.season}:B${it.episode}` : '';
      const subLine = isEpMode && it.episodeTitle
        ? `${epTag} · ${it.episodeTitle}`
        : `${it.year || '2026'} · ${isTv ? 'Dizi' : 'Film'}`;
      return h('div', {
        class: 'poster-card',
        tabIndex: 0,
        role: 'button',
        'aria-label': `${it.title} (${epTag || it.year || '2026'})`,
        onclick: () => startItem(it, isEpMode),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startItem(it, isEpMode); } },
      },
        h('div', { class: 'poster-img-wrap' },
          it.poster
            ? h('img', { src: it.poster, alt: it.title, loading: 'lazy', onerror: (e) => { e.currentTarget.onerror = null; e.currentTarget.src = '/static/watchlivo-poster.svg'; } })
            : h('div', { class: 'poster-fallback' }, isTv ? '📺' : '🎬'),
          h('span', { class: 'poster-badge' }, epTag ? `🆕 ${epTag}` : (it.customRelease ? '✨ Yeni Eklendi' : (it.sourceBadge || '🍿 Vizyonda'))),
          it.rating ? h('span', { class: 'poster-rating' }, `★ ${it.rating}`) : null,
        ),
        h('div', { class: 'poster-meta' },
          h('div', { class: 'poster-title' }, it.title),
          h('div', { class: 'poster-sub' }, subLine),
        ),
      );
    }));
  };

  const loadVizyon = async (refresh = false) => {
    gridWrap.replaceChildren(spinner());
    if (activeVizyonFilter === 'episodes') {
      if (!refresh && cachedLatestEps.length) {
        renderItems(cachedLatestEps);
        return;
      }
      const epRes = await api(`/api/rave/latest-episodes${refresh ? '?refresh=1' : ''}`, { timeout: 10000 }).catch(() => null);
      cachedLatestEps = epRes?.items || [];
      renderItems(cachedLatestEps);
      if (refresh) toast(`🆕 Yeni bölümler güncellendi (${cachedLatestEps.length} güncel bölüm aktif)!`);
      return;
    }
    if (!refresh && cachedVizyonItems.length) {
      renderItems(cachedVizyonItems);
      return;
    }
    const res = await api(`/api/rave/new-releases${refresh ? '?refresh=1' : ''}`, { timeout: 12000 }).catch(() => null);
    if (res?.items) {
      cachedVizyonItems = res.items;
      renderItems(cachedVizyonItems);
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

  const filterTabs = h('div', { class: 'wl-vizyon-tabs', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
    ...[
      ['ready', '✅ Akışı Hazır Olanlar'],
      ['episodes', '🆕 Yeni Eklenen Bölümler (S:B)'],
      ['theatrical', '🎟️ Sinemalarda (Yakında)'],
      ['all', '🌐 Tüm Vizyon Havuzu'],
    ].map(([fid, flabel]) => h('button', {
      type: 'button',
      class: `btn sm ${activeVizyonFilter === fid ? 'primary' : 'ghost'}`,
      onclick: (ev) => {
        activeVizyonFilter = fid;
        filterTabs.querySelectorAll('button').forEach((b) => {
          b.className = `btn sm ${b === ev.currentTarget ? 'primary' : 'ghost'}`;
        });
        loadVizyon(false);
      },
    }, flabel)),
  );

  wrap.append(topActions, filterTabs, addForm, gridWrap);
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
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); loadFolder(folderInp.value.trim()); } },
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



// ============================================================================
// RAVE-PARITY HBO MAX PORTAL & DIRECT IN-APP LINK/TITLE SELECTOR
// ============================================================================
export function openTvSeriesModal(tvItem, tvProv, pickFn) {
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
    async (media) => {
      modalRef?.close?.();
      if (pickFn) await pickFn(media);
    },
    resolveCatalogItem
  );
}

const MAX_OFFICIAL_HUBS = [
  {
    category: '🔥 HBO Orijinal Yapımları (4K Ultra HD)',
    items: [
      { tmdbId: '100088', title: 'The Last of Us', originalTitle: 'The Last of Us', mediaType: 'tv', season: 1, episode: 1, year: '2023', rating: 8.8, poster: 'https://image.tmdb.org/t/p/w500/uKvVjHNqB5VmOrdxqAt2F7J78ED.jpg', desc: 'Joel ve Ellie’nin distopik dünyadaki destansı mücadelesi.' },
      { tmdbId: '94997', title: 'House of the Dragon', originalTitle: 'House of the Dragon', mediaType: 'tv', season: 1, episode: 1, year: '2022', rating: 8.4, poster: 'https://image.tmdb.org/t/p/w500/6YM292PX2gSIBk16hufmlGT3iQW.jpg', desc: 'Targaryen hanedanının Ejderhaların Dansı iç savaşı.' },
      { tmdbId: '194764', title: 'The Penguin', originalTitle: 'The Penguin', mediaType: 'tv', season: 1, episode: 1, year: '2024', rating: 8.8, poster: 'https://image.tmdb.org/t/p/w500/vOWcqC4oDQws1doDWLO7d3dh5qc.jpg', desc: 'Gotham yeraltı dünyasının yeni lideri Oswald Cobblepot.' },
      { tmdbId: '223397', title: 'City of God: The Fight Rages On', originalTitle: 'Cidade de Deus: A Luta Não Para', mediaType: 'tv', season: 1, episode: 1, year: '2024', rating: 7.9, poster: 'https://image.tmdb.org/t/p/w500/58qiZruozysI2b7ZZV68m3wvxEO.jpg', desc: 'Efsanevi Tanrıkent hikayesi 20 yıl sonra devam ediyor.' },
      { tmdbId: '76331', title: 'Succession', originalTitle: 'Succession', mediaType: 'tv', season: 1, episode: 1, year: '2018', rating: 8.9, poster: 'https://image.tmdb.org/t/p/w500/z0XiwdrCQ9yVIr4O0pxzaAYRxdW.jpg', desc: 'Roy ailesinin medya imparatorluğundaki acımasız taht kavgası.' },
      { tmdbId: '1399', title: 'Game of Thrones', originalTitle: 'Game of Thrones', mediaType: 'tv', season: 1, episode: 1, year: '2011', rating: 9.2, poster: 'https://image.tmdb.org/t/p/w500/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg', desc: 'Demir Taht için 7 Krallığın amansız savaşı.' },
    ]
  },
  {
    category: '🎬 Warner Bros. 4K Sinema Gişesi (IMAX)',
    items: [
      { tmdbId: '693134', title: 'Dune: Part Two', originalTitle: 'Dune: Part Two', mediaType: 'movie', year: '2024', rating: 8.5, poster: 'https://image.tmdb.org/t/p/w500/tihf8Trht9zP3scmUQfvGlAY9FU.jpg', desc: 'Paul Atreides’in Arrakis ve Fremen halkıyla intikam savaşı.' },
      { tmdbId: '414906', title: 'The Batman', originalTitle: 'The Batman', mediaType: 'movie', year: '2022', rating: 7.7, poster: 'https://image.tmdb.org/t/p/w500/3B19RaHTSpyNEcjWtsAPqgJsQ0h.jpg', desc: 'Gotham sokaklarındaki yozlaşma ve Riddler cinayetleri.' },
      { tmdbId: '346698', title: 'Barbie', originalTitle: 'Barbie', mediaType: 'movie', year: '2023', rating: 7.0, poster: 'https://image.tmdb.org/t/p/w500/iPtla6hJOerwsgw0zMxyEI6pR3Q.jpg', desc: 'Barbie Land’den gerçek dünyaya uzanan renkli yolculuk.' },
      { tmdbId: '787699', title: 'Wonka', originalTitle: 'Wonka', mediaType: 'movie', year: '2023', rating: 7.1, poster: 'https://image.tmdb.org/t/p/w500/lfYTDWhYeUTWMznPMgWD2DFCACL.jpg', desc: 'Willy Wonka’nın dünyanın en büyük çikolatacısı olma hikayesi.' },
      { tmdbId: '823464', title: 'Godzilla x Kong: The New Empire', originalTitle: 'Godzilla x Kong: The New Empire', mediaType: 'movie', year: '2024', rating: 7.2, poster: 'https://image.tmdb.org/t/p/w500/6Hwzl9hP58DQcgju1MbqhADLo4Z.jpg', desc: 'Devasa canavarların içi boş dünyadaki yeni ittifakı.' },
      { tmdbId: '974635', title: 'Bir Minecraft Filmi', originalTitle: 'A Minecraft Movie', mediaType: 'movie', year: '2025', rating: 6.8, poster: 'https://image.tmdb.org/t/p/w500/5AC3hYF7Yd8wBtwxZHNaOD0biDB.jpg', desc: 'Overworld dünyasındaki büyülü ve eğlenceli Minecraft macerası.' },
    ]
  }
];

export function renderMaxRavePortal(p, body, presetQuery, pick, _pickFromUrl) {
  const acct = getAccount('max');

  // Electron Desktop Mode: Native webview tag parity
  if (window.vortexDesktop?.isElectron) {
    renderDesktopKind(p, body, pick);
    return;
  }

  const container = h('div', {
    class: 'max-rave-portal-view',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '10px 0 40px',
      color: '#ffffff',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
  });

  // 1. Top Brand & Status Header
  const headerCard = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: '16px',
      padding: '20px 24px',
      borderRadius: '16px',
      background: 'linear-gradient(135deg, rgba(0, 43, 231, 0.28) 0%, rgba(13, 16, 27, 0.96) 100%)',
      border: '1px solid rgba(0, 43, 231, 0.5)',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: '4px',
          background: 'rgba(0, 43, 231, 0.3)',
          padding: '8px 16px',
          borderRadius: '10px',
          border: '1px solid rgba(59, 130, 246, 0.4)',
        },
      },
        h('span', { style: { fontSize: '26px', fontWeight: '900', letterSpacing: '-0.5px', color: '#ffffff' } }, 'HBO'),
        h('span', { style: { fontSize: '26px', fontWeight: '300', fontStyle: 'italic', color: '#ffffff' } }, 'max')
      ),
      h('div', {},
        h('div', { style: { fontWeight: '800', fontSize: '1.1rem', color: '#f8fafc' } }, 'HBO Max Resmi İzleme & Oda Portalı'),
        h('div', { style: { fontSize: '.84rem', color: '#94a3b8', marginTop: '2px' } }, 'Rave çoklu izleyici protokolü: Resmi Max kütüphanesinden içerik seçip odada canlı senkron başlatın.')
      )
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
      acct.loginSatisfied ? h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(16, 185, 129, 0.15)',
          border: '1px solid rgba(16, 185, 129, 0.45)',
          color: '#34d399',
          padding: '8px 14px',
          borderRadius: '10px',
          fontSize: '.86rem',
          fontWeight: '700',
        },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block', boxShadow: '0 0 8px #10b981' } }),
        acct.accountEmail || '✓ Max Hesabı Aktif'
      ) : h('button', {
        type: 'button',
        class: 'btn primary',
        style: { background: 'linear-gradient(135deg, #002be7, #4f46e5)', fontWeight: '800', padding: '10px 18px', borderRadius: '10px' },
        onclick: () => openProviderLoginModal(p, () => {
          body.replaceChildren();
          renderMaxRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }),
      }, '🔑 HBO Max ile Giriş Yap'),
      h('button', {
        type: 'button',
        class: 'btn secondary',
        style: { fontSize: '.84rem', padding: '9px 14px', borderRadius: '10px' },
        onclick: () => openProviderLoginModal(p, () => {
          body.replaceChildren();
          renderMaxRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }),
      }, acct.loginSatisfied ? 'Hesap Değiştir' : 'Seçenekler')
    )
  );

  // 2. Direct Link Runner & Instant Search Bar (Rave Link Parity)
  const linkInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'play.max.com video bağlantısı yapıştırın veya film/dizi adı yazın (örn. The Last of Us)...',
    value: presetQuery || '',
    style: {
      flex: '1 1 340px',
      padding: '14px 18px',
      borderRadius: '12px',
      fontSize: '.95rem',
      background: 'rgba(15, 23, 42, 0.85)',
      border: '1px solid rgba(59, 130, 246, 0.35)',
      color: '#fff',
      outline: 'none',
    },
  });

  const launchBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      background: 'linear-gradient(135deg, #002be7 0%, #1d4ed8 100%)',
      padding: '14px 24px',
      borderRadius: '12px',
      fontWeight: '800',
      fontSize: '.95rem',
      boxShadow: '0 4px 16px rgba(0, 43, 231, 0.45)',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
  },
    h('span', {}, '🚀'),
    h('span', {}, 'Odayı Başlat')
  );

  const openPlayMaxBtn = h('button', {
    type: 'button',
    class: 'btn secondary',
    style: {
      background: 'rgba(255, 255, 255, 0.08)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      padding: '14px 20px',
      borderRadius: '12px',
      fontWeight: '700',
      fontSize: '.9rem',
      color: '#93c5fd',
      cursor: 'pointer',
    },
    onclick: () => {
      window.open('https://play.max.com', '_blank');
      toast('play.max.com açıldı. Dilediğiniz filmi açıp bağlantısını buraya yapıştırabilirsiniz.');
    },
  }, '🌐 play.max.com Aç ↗');

  const handleLaunch = async () => {
    const rawVal = linkInput.value.trim();
    if (!rawVal) {
      toast('Lütfen bir Max bağlantısı yapıştırın veya film/dizi adı yazın');
      linkInput.focus();
      return;
    }

    toast(`⏳ HBO Max içeriği çözümleniyor: ${rawVal}...`);
    launchBtn.disabled = true;
    launchBtn.style.opacity = '0.6';

    try {
      const res = await resolveCatalogItem(
        { title: rawVal, originalTitle: rawVal, sourceUrl: rawVal.startsWith('http') ? rawVal : '', provider: 'max' },
        p, 1, 1
      );
      if (res) {
        toast(`✓ Oda başlatılıyor: ${res.title}`);
        await pick(res);
      }
    } catch (err) {
      toast('İçerik çözümlenemedi, lütfen tekrar deneyin');
    } finally {
      launchBtn.disabled = false;
      launchBtn.style.opacity = '1';
    }
  };

  launchBtn.onclick = handleLaunch;
  linkInput.onkeydown = (e) => {
    if (e.key === 'Enter') handleLaunch();
  };

  const runnerBar = h('div', {
    style: {
      background: 'rgba(15, 23, 42, 0.75)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      borderRadius: '16px',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
    },
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
      h('div', { style: { fontWeight: '700', fontSize: '.94rem', color: '#e2e8f0' } },
        '🔗 Doğrudan Max Bağlantısı veya Başlık ile Oda Kur:'
      ),
      h('div', { style: { fontSize: '.8rem', color: '#94a3b8' } },
        'Desteklenen: play.max.com/video/watch/*, /movie/*, /show/* veya başlık adı'
      )
    ),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
      linkInput,
      launchBtn,
      openPlayMaxBtn
    )
  );

  // 3. Official Curated HBO Max Showcase (Hubs)
  const hubsWrap = h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '28px', marginTop: '10px' },
  });

  for (const hub of MAX_OFFICIAL_HUBS) {
    const rowTitle = h('div', {
      style: {
        fontSize: '1.15rem',
        fontWeight: '800',
        letterSpacing: '-0.3px',
        color: '#f8fafc',
        borderLeft: '4px solid #002be7',
        paddingLeft: '12px',
        marginBottom: '14px',
      },
    }, hub.category);

    const cardsGrid = h('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
        gap: '16px',
      },
    });

    for (const it of hub.items) {
      const card = h('div', {
        class: 'vcard max-showcase-card',
        role: 'button',
        tabindex: '0',
        style: {
          background: 'rgba(15, 23, 42, 0.65)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          overflow: 'hidden',
          cursor: 'pointer',
          transition: 'transform .2s, border-color .2s, box-shadow .2s',
          display: 'flex',
          flexDirection: 'column',
        },
        onmouseenter: () => {
          card.style.transform = 'translateY(-4px)';
          card.style.borderColor = '#3b82f6';
          card.style.boxShadow = '0 12px 24px rgba(0, 43, 231, 0.35)';
        },
        onmouseleave: () => {
          card.style.transform = 'translateY(0)';
          card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
          card.style.boxShadow = 'none';
        },
        onclick: async () => {
          if (it.mediaType === 'tv') {
            openTvSeriesModal(it, p, pick);
            return;
          }
          toast(`🎬 HBO Max içeriği odaya yükleniyor: ${it.title}`);
          const res = await resolveCatalogItem(
            { tmdbId: it.tmdbId, title: it.title, originalTitle: it.originalTitle, mediaType: it.mediaType, provider: 'max' },
            p, 1, 1
          );
          if (res) {
            await pick(res);
          }
        },
      },
        h('div', {
          style: { position: 'relative', width: '100%', paddingTop: '148%', background: '#070913', overflow: 'hidden' },
        },
          h('img', {
            src: it.poster,
            alt: it.title,
            loading: 'lazy',
            onerror: (e) => { e.currentTarget.src = '/static/watchlivo-poster.svg'; },
            style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' },
          }),
          h('div', {
            style: {
              position: 'absolute',
              top: '8px',
              left: '8px',
              background: 'linear-gradient(135deg, #002be7, #4f46e5)',
              color: '#fff',
              fontSize: '.68rem',
              fontWeight: '900',
              padding: '3px 7px',
              borderRadius: '6px',
              letterSpacing: '-0.3px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            },
          }, 'MAX'),
          h('div', {
            style: {
              position: 'absolute',
              bottom: '8px',
              right: '8px',
              background: 'rgba(0, 0, 0, 0.75)',
              color: '#fbbf24',
              fontSize: '.72rem',
              fontWeight: '800',
              padding: '2px 6px',
              borderRadius: '4px',
            },
          }, `★ ${it.rating}`)
        ),
        h('div', { style: { padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 } },
          h('div', {
            style: {
              fontWeight: '800',
              fontSize: '.88rem',
              color: '#ffffff',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, it.title),
          h('div', {
            style: { fontSize: '.76rem', color: '#94a3b8', display: 'flex', justifyContent: 'space-between' },
          },
            h('span', {}, it.mediaType === 'tv' ? `Dizi · ${it.year}` : `Film · ${it.year}`),
            h('span', { style: { color: '#60a5fa', fontWeight: '700' } }, '4K HDR')
          )
        )
      );

      cardsGrid.appendChild(card);
    }

    const sectionBox = h('div', {},
      rowTitle,
      cardsGrid
    );
    hubsWrap.appendChild(sectionBox);
  }

  container.append(
    headerCard,
    runnerBar,
    hubsWrap
  );

  body.replaceChildren(container);
}


export const NETFLIX_OFFICIAL_HUBS = [
  {
    category: "Amerika Yapımı Drama Dizileri",
    id: "us_drama",
    items: [
      { tmdbId: "1405", title: "Dexter", originalTitle: "Dexter", mediaType: "tv", year: "2006", rating: "8.7", poster: "https://image.tmdb.org/t/p/w500/i8ORB1biusVy703lGxUi5Rle6zA.jpg", backdrop: "https://image.tmdb.org/t/p/w780/i8ORB1biusVy703lGxUi5Rle6zA.jpg", overview: "Gündüzleri adli tıp uzmanı, geceleri ise adaletten kaçan katilleri avlayan bir seri katil.", season: 1, episode: 1 },
      { tmdbId: "1408", title: "House M.D.", originalTitle: "House", mediaType: "tv", year: "2004", rating: "8.6", poster: "https://image.tmdb.org/t/p/w500/3Cz7ySOQJmqiuTdrc6CY0r65yDI.jpg", backdrop: "https://image.tmdb.org/t/p/w780/3Cz7ySOQJmqiuTdrc6CY0r65yDI.jpg", overview: "Sıra dışı ve alaycı Dr. Gregory House ve ekibi tıbbi bilmeceleri çözer.", season: 1, episode: 1 },
      { tmdbId: "1396", title: "Breaking Bad", originalTitle: "Breaking Bad", mediaType: "tv", year: "2008", rating: "8.9", poster: "https://image.tmdb.org/t/p/w500/ggFHVNu6YYI5L9pCfOacjizRGt.jpg", backdrop: "https://image.tmdb.org/t/p/w780/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg", overview: "Kanser teşhisi konan bir kimya öğretmeni ailesinin geleceğini garantiye almak için metamfetamin üretimine başlar.", season: 1, episode: 1 },
      { tmdbId: "60059", title: "Better Call Saul", originalTitle: "Better Call Saul", mediaType: "tv", year: "2015", rating: "8.7", poster: "https://image.tmdb.org/t/p/w500/fC2HDm5t0kHl7mTm7jxMR31b7by.jpg", backdrop: "https://image.tmdb.org/t/p/w780/fC2HDm5t0kHl7mTm7jxMR31b7by.jpg", overview: "Jimmy McGill'in ahlaki sınırları zorlayan avukat Saul Goodman'a dönüşüm serüveni.", season: 1, episode: 1 },
      { tmdbId: "63351", title: "Narcos", originalTitle: "Narcos", mediaType: "tv", year: "2015", rating: "8.8", poster: "https://image.tmdb.org/t/p/w500/rTmal9fDbwh5F0waol2hq35U4ah.jpg", backdrop: "https://image.tmdb.org/t/p/w780/rTmal9fDbwh5F0waol2hq35U4ah.jpg", overview: "Kolombiya'nın kokain kartelleri ve Pablo Escobar'ın gerçek hayat hikayesi.", season: 1, episode: 1 },
      { tmdbId: "67744", title: "Mindhunter", originalTitle: "Mindhunter", mediaType: "tv", year: "2017", rating: "8.4", poster: "https://image.tmdb.org/t/p/w500/lpDVJuIro21gtMj9iXMFKHuroZN.jpg", backdrop: "https://image.tmdb.org/t/p/w780/lpDVJuIro21gtMj9iXMFKHuroZN.jpg", overview: "FBI ajanları seri katillerin zihnini anlayarak yeni suç profili çıkarma teknikleri geliştirir.", season: 1, episode: 1 },
    ],
  },
  {
    category: "Tekrar Tekrar İzlenen Diziler",
    id: "rewatch_classics",
    items: [
      { tmdbId: "5920", title: "The Mentalist", originalTitle: "The Mentalist", mediaType: "tv", year: "2008", rating: "8.4", poster: "https://image.tmdb.org/t/p/w500/acYXu4KaDj1NIkMgObnhe4C4a0T.jpg", backdrop: "https://image.tmdb.org/t/p/w780/acYXu4KaDj1NIkMgObnhe4C4a0T.jpg", overview: "Eski medyum Patrick Jane, keskin gözlem yeteneğini Kaliforniya Araştırma Bürosu için kullanır.", season: 7, episode: 8, epName: "Göz Akı" },
      { tmdbId: "105248", title: "Cyberpunk: Edgerunners", originalTitle: "Cyberpunk: Edgerunners", mediaType: "tv", year: "2022", rating: "8.6", poster: "https://image.tmdb.org/t/p/w500/v3JuB15WybKmxDeT1hWdK3j6eSJ.jpg", backdrop: "https://image.tmdb.org/t/p/w780/bknKZO7DWVYKeByuJMnGI46PFZg.jpg", overview: "Geleceğin sokaklarında hayatta kalmak için kanun kaçağı bir paralı askere dönüşen gencin hikayesi.", season: 1, episode: 1 },
      { tmdbId: "87083", title: "Vinland Saga", originalTitle: "Vinland Saga", mediaType: "tv", year: "2019", rating: "8.7", poster: "https://image.tmdb.org/t/p/w500/vUHlpA5c1NXkds59reY3HMb4Abs.jpg", backdrop: "https://image.tmdb.org/t/p/w780/vUHlpA5c1NXkds59reY3HMb4Abs.jpg", overview: "Genç Thorfinn intikam arayışında acımasız Viking savaşlarının ortasında büyür.", season: 1, episode: 1 },
      { tmdbId: "30983", title: "Hajime no Ippo", originalTitle: "Hajime no Ippo", mediaType: "tv", year: "2000", rating: "8.8", poster: "https://image.tmdb.org/t/p/w500/gW14n6xxONXrya8CIDhRe5Ada7U.jpg", backdrop: "https://image.tmdb.org/t/p/w780/gW14n6xxONXrya8CIDhRe5Ada7U.jpg", overview: "Zorbalığa uğrayan utangaç Ippo, boksun büyülü dünyasında zirveye tırmanır.", season: 1, episode: 1 },
      { tmdbId: "1976", title: "Monster", originalTitle: "Monster", mediaType: "tv", year: "2004", rating: "8.8", poster: "https://image.tmdb.org/t/p/w500/kF0DWjx3MfYRncPGSBoaL41StPe.jpg", backdrop: "https://image.tmdb.org/t/p/w780/kF0DWjx3MfYRncPGSBoaL41StPe.jpg", overview: "Başarılı beyin cerrahı Dr. Tenma, kurtardığı bir çocuğun acımasız bir canavar olduğunu anlar.", season: 1, episode: 1 },
      { tmdbId: "1399", title: "Game of Thrones", originalTitle: "Game of Thrones", mediaType: "tv", year: "2011", rating: "8.5", poster: "https://image.tmdb.org/t/p/w500/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg", backdrop: "https://image.tmdb.org/t/p/w780/2OMB0ynKlyIenMJWI2Dy9IWT4c.jpg", overview: "Yedi Krallık'ın Demir Tahtı için verilen epik iktidar ve entrika mücadelesi.", season: 1, episode: 1 },
    ],
  },
  {
    category: "🔥 Dünyaca Popüler Netflix Trend Yapımları",
    id: "trending",
    items: [
      { tmdbId: "66732", title: "Stranger Things", originalTitle: "Stranger Things", mediaType: "tv", year: "2016-2025", rating: "8.5", poster: "https://image.tmdb.org/t/p/w500/hjVNQA2a12OxkpDEOQTBMbKVZ1K.jpg", backdrop: "https://image.tmdb.org/t/p/w780/56v2KjBlU4XaOv9rVYEQypROD7P.jpg", overview: "Ufak bir kasabada bir çocuk kaybolunca gizli deneyler ve doğaüstü güçler ortaya çıkar.", season: 1, episode: 1 },
      { tmdbId: "93405", title: "Squid Game", originalTitle: "Squid Game", mediaType: "tv", year: "2021-2024", rating: "7.9", poster: "https://image.tmdb.org/t/p/w500/yACIAqAkSLkX4coHafpyLWAtQjw.jpg", backdrop: "https://image.tmdb.org/t/p/w780/2meX1nMdScFOoV4370rqHWKmXhY.jpg", overview: "Para sıkıntısı çeken yüzlerce oyuncu, ölümcül çocuk oyunlarında yarışmayı kabul eder.", season: 1, episode: 1 },
      { tmdbId: "119051", title: "Wednesday", originalTitle: "Wednesday", mediaType: "tv", year: "2022", rating: "8.3", poster: "https://image.tmdb.org/t/p/w500/9PFonBhy4cQy7Jz20NpMygczOkv.jpg", backdrop: "https://image.tmdb.org/t/p/w780/iHSwvRVsRyxpX7FE7GbviaDvgGZ.jpg", overview: "Wednesday Addams Nevermore Akademisinde yeni gizemleri ve doğaüstü cinayetleri çözer.", season: 1, episode: 1 },
      { tmdbId: "71446", title: "La Casa de Papel", originalTitle: "Money Heist", mediaType: "tv", year: "2017-2021", rating: "8.2", poster: "https://image.tmdb.org/t/p/w500/z01Dc0Ly2GmCpLe6Scx4d3dPP1S.jpg", backdrop: "https://image.tmdb.org/t/p/w780/xGexTKCJDkl12dTW4YCBDXWb1AD.jpg", overview: "Profesör önderliğindeki sekiz hırsız, İspanya Kraliyet Darphanesine kusursuz bir soygun düzenler.", season: 1, episode: 1 },
    ],
  },
  {
    category: "🇹🇷 Netflix Türk Orijinal Dizi & Filmleri",
    id: "turkish",
    items: [
      { tmdbId: "577990", title: "Organize İşler: Karun Hazinesi", originalTitle: "Organize İşler: Karun Hazinesi", mediaType: "tv", year: "2026", rating: "8.8", poster: "https://image.tmdb.org/t/p/w500/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg", backdrop: "https://image.tmdb.org/t/p/w780/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg", overview: "Asım Noyan jübilesini yapıp mesleği bırakmadan önce son performansını sergilemeye hazırdır.", season: 1, episode: 1 },
      { tmdbId: "136125", title: "Kulüp", originalTitle: "Kulüp", mediaType: "tv", year: "2021", rating: "6.9", poster: "https://image.tmdb.org/t/p/w500/jHgMj6mtMHEBrFhmZaQCGFGYnFx.jpg", backdrop: "https://image.tmdb.org/t/p/w780/AwEQ9wAOs1ZbvhpO7XxpGQHYvx5.jpg", overview: "1950'lerin kozmopolit İstanbul'unda bir gece kulübünde başlayan dokunaklı aile ve aşk hikayesi.", season: 1, episode: 1 },
      { tmdbId: "112745", title: "Bir Başkadır", originalTitle: "Bir Başkadır", mediaType: "tv", year: "2020", rating: "7.8", poster: "https://image.tmdb.org/t/p/w500/9MzukREEyaCqW197buBrJr2LcTI.jpg", backdrop: "https://image.tmdb.org/t/p/w780/peOoKDVMbXdBMwZd9SeOxtOfCXD.jpg", overview: "Farklı hayatlar yaşayan bir grup insanın İstanbul'da kesişen yolları ve derin psikolojik yüzleşmeleri.", season: 1, episode: 1 },
      { tmdbId: "499461", title: "Ölümlü Dünya", originalTitle: "Ölümlü Dünya", mediaType: "movie", year: "2018", rating: "7.1", poster: "https://image.tmdb.org/t/p/w500/6pUboTFJ6SNzrhb8sNcmc50fJCk.jpg", backdrop: "https://image.tmdb.org/t/p/w780/6V9AbZvuHi4vEFSnLMr1NnGCzic.jpg", overview: "Lokanta işleten sekiz kişilik Mermer Ailesi nesillerdir kiralık katil olarak çalışmaktadır." },
    ],
  },
];

export function renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl) {
  const acct = getAccount('netflix');

  // Electron Desktop Mode: Native webview tag parity
  if (window.vortexDesktop?.isElectron) {
    renderDesktopKind(p, body, pick);
    return;
  }

  const container = h('div', {
    class: 'netflix-rave-app-root',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      maxWidth: '1280px',
      margin: '0 auto',
      padding: '4px 0 40px',
      color: '#ffffff',
      fontFamily: '"Netflix Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    },
  });

  // 1. Netflix App Top Bar (Netflix Logo, Category Tabs, Account status)
  const navTabs = [
    { id: 'all', label: 'Ana Sayfa' },
    { id: 'turkish', label: '🇹🇷 Türk Yapımları' },
    { id: 'trending', label: '🔥 Trendler' },
    { id: 'movies', label: '🎬 4K Filmler' },
    { id: 'series', label: '📺 Diziler' },
  ];

  let currentTab = 'all';

  const tabPillsWrap = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      flexWrap: 'wrap',
    },
  });

  const renderNavTabs = () => {
    tabPillsWrap.replaceChildren(
      ...navTabs.map((t) => h('button', {
        type: 'button',
        class: `btn sm ${currentTab === t.id ? 'primary' : 'ghost'}`,
        style: {
          borderRadius: '20px',
          padding: '6px 14px',
          fontSize: '.82rem',
          fontWeight: currentTab === t.id ? '800' : '600',
          background: currentTab === t.id ? '#e50914' : 'rgba(255, 255, 255, 0.08)',
          border: currentTab === t.id ? '1px solid #e50914' : '1px solid rgba(255, 255, 255, 0.12)',
          color: currentTab === t.id ? '#ffffff' : '#cbd5e1',
          cursor: 'pointer',
          transition: 'all .2s ease',
        },
        onclick: () => {
          currentTab = t.id;
          renderNavTabs();

  // OPTION B: DIRECT EMBEDDED RAVE NETFLIX PORTAL (Rave parity)
  const isEmbedPortal = true;
  let activePortalUrl = acct.loginSatisfied ? '/api/netflix-bridge/browse' : '/api/netflix-bridge/login';

  const ravePortalFrame = h('iframe', {
    id: 'rave-live-netflix-iframe',
    src: activePortalUrl,
    allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
    style: {
      width: '100%',
      height: '620px',
      border: 'none',
      background: '#141414',
      flex: 1,
    },
  });

  const onPortalMsg = (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.data.type === 'WATCHLIVO_NETFLIX_PICK') {
      const { watchId, url, title } = ev.data;
      if (!watchId) return;
      toast(`🎬 Netflix "${title || ('#' + watchId)}" seçildi! Canlı oda başlatılıyor...`);
      window.removeEventListener('message', onPortalMsg);

      const mediaObj = {
        id: `netflix-${watchId}`,
        title: title || `Netflix #${watchId}`,
        originalTitle: title || `Netflix #${watchId}`,
        provider: 'netflix',
        catalogProvider: 'netflix',
        streamType: 'official',
        sourceUrl: url || `https://www.netflix.com/watch/${watchId}`,
        url: url || `https://www.netflix.com/watch/${watchId}`,
        mediaType: 'movie',
        authenticated: true,
      };
      pick(mediaObj);
    }
  };
  window.addEventListener('message', onPortalMsg);

  const ravePortalWindow = h('div', {
    class: 'rave-portal-direct-window',
    style: {
      width: '100%',
      minHeight: '640px',
      background: '#141414',
      borderRadius: '16px',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      boxShadow: '0 24px 70px rgba(0,0,0,0.95), 0 0 40px rgba(229, 9, 20, 0.25)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
    },
  },
    // Rave Title Bar
    h('div', {
      class: 'rave-native-header',
      style: {
        height: '46px',
        background: '#050507',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        flexShrink: 0,
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        h('div', {
          style: {
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #e50914, #0071eb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            fontWeight: '900',
            color: '#fff',
            overflow: 'hidden',
          },
        }, state.self?.avatar ? h('img', { src: state.self.avatar, style: { width: '100%', height: '100%', objectFit: 'cover' } }) : 'MC'),
        h('span', { style: { color: '#94a3b8', fontSize: '13px', fontWeight: '700' } }, 'Netflix')
      ),
      h('div', {
        style: {
          fontSize: '22px',
          fontWeight: '900',
          letterSpacing: '1px',
          color: '#ffffff',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
        },
      },
        h('span', { style: { textTransform: 'lowercase' } }, 'r'),
        h('span', { style: { textTransform: 'uppercase' } }, 'A'),
        h('span', { style: { textTransform: 'lowercase' } }, 'v'),
        h('span', { style: { textTransform: 'uppercase' } }, 'E')
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('button', {
          type: 'button',
          style: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px' },
          onclick: () => { ravePortalFrame.src = ravePortalFrame.src; },
        }, '🔄 Yenile'),
        h('button', {
          type: 'button',
          style: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px' },
          onclick: () => { ravePortalFrame.src = '/api/netflix-bridge/browse'; },
        }, '🏠 Ana Sayfa'),
        h('button', {
          type: 'button',
          style: { background: 'rgba(229,9,20,0.15)', border: '1px solid rgba(229,9,20,0.4)', color: '#f87171', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px', fontWeight: '700' },
          onclick: () => { ravePortalFrame.src = '/api/netflix-bridge/login'; },
        }, '🔑 Giriş Ekranı'),
        h('button', {
          type: 'button',
          style: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: '#38bdf8', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px' },
          onclick: () => openNetflixLoginModal(p, () => {
            body.replaceChildren();
            renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
          }, null, pick),
        }, 'Pencerede Aç ↗')
      )
    ),
    ravePortalFrame
  );

          filterContent();
        },
      }, t.label))
    );
  };

  const topBar = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: '14px',
      padding: '12px 20px',
      background: 'rgba(18, 18, 18, 0.95)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '16px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' } },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
        },
        onclick: () => { currentTab = 'all'; renderNavTabs(); filterContent(); },
      },
        h('span', {
          style: {
            color: '#e50914',
            fontWeight: '900',
            fontSize: '1.75rem',
            letterSpacing: '1px',
            fontFamily: 'Impact, "Bebas Neue", sans-serif',
          },
        }, 'NETFLIX'),
        h('span', {
          style: {
            fontSize: '.72rem',
            background: 'rgba(229, 9, 20, 0.15)',
            border: '1px solid rgba(229, 9, 20, 0.4)',
            color: '#f87171',
            padding: '2px 8px',
            borderRadius: '6px',
            fontWeight: '700',
          },
        }, 'CANLI ODA')
      ),
      tabPillsWrap
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        style: {
          background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
          borderColor: '#e50914',
          fontWeight: '800',
          padding: '7px 14px',
          borderRadius: '8px',
          fontSize: '.82rem',
          cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(229,9,20,0.35)',
        },
        onclick: () => openNetflixLoginModal(p, () => {
          body.replaceChildren();
          renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }, null, pick),
      }, '🎬 Canlı Netflix Portalı (Rave Görünümü)'),
      acct.loginSatisfied ? h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.35)',
          color: '#34d399',
          padding: '6px 12px',
          borderRadius: '10px',
          fontSize: '.82rem',
          fontWeight: '700',
        },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block' } }),
        acct.profileName || acct.accountEmail || '✓ Netflix Aktif'
      ) : null,
      h('button', {
        type: 'button',
        class: 'btn sm ghost',
        style: { fontSize: '.8rem', padding: '6px 12px', borderRadius: '8px' },
        onclick: () => openNetflixLoginModal(p, () => {
          body.replaceChildren();
          renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }, null, pick),
      }, 'Hesap')
    )
  );

  renderNavTabs();

  // 2. Netflix Hero Showcase Spotlight Billboard (Featured: Organize İşler: Sazan Sarmalı)
  const heroItem = {
    tmdbId: '577990',
    title: 'Organize İşler: Karun Hazinesi',
    originalTitle: 'Organize İşler: Karun Hazinesi',
    mediaType: 'tv',
    year: '2026',
    rating: '8.8',
    duration: '8 Bölüm',
    tags: ['TOP 10 DİZİ', '4K Ultra HD', '5.1 Dolby Audio', '2026 · 16+'],
    overview: 'Efsanevi Asım Noyan, jübilesini yapıp "mesleği" geride bırakmadan önce son performansını sergilemeye hazır. Peki ama usta dolandırıcı bu defa ateşle mi oynuyor?',
    backdrop: 'https://image.tmdb.org/t/p/w1280/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg',
    poster: 'https://image.tmdb.org/t/p/w500/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg',
    officialUrl: 'https://www.netflix.com/title/81682705',
    netflixId: '81682705',
  };

  const heroPlayBtn = h('button', {
    type: 'button',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '10px',
      background: '#ffffff',
      color: '#000000',
      border: 'none',
      borderRadius: '8px',
      padding: '12px 26px',
      fontSize: '1.05rem',
      fontWeight: '900',
      cursor: 'pointer',
      boxShadow: '0 4px 20px rgba(255, 255, 255, 0.35)',
      transition: 'transform .15s ease, background .15s ease',
    },
    onmouseenter: (e) => { e.currentTarget.style.background = '#e6e6e6'; e.currentTarget.style.transform = 'scale(1.03)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = '#ffffff'; e.currentTarget.style.transform = 'scale(1)'; },
    onclick: async () => {
      heroPlayBtn.disabled = true;
      heroPlayBtn.style.opacity = '0.7';
      toast(`🎬 "${heroItem.title}" hazırlanıyor, oda başlatılıyor...`);
      try {
        const res = await resolveCatalogItem(
          { tmdbId: heroItem.tmdbId, title: heroItem.title, originalTitle: heroItem.originalTitle, mediaType: heroItem.mediaType, provider: 'netflix' },
          p, 1, 1
        );
        if (res) {
          await pick(res);
        } else {
          await pick({
            provider: 'netflix',
            catalogProvider: 'netflix',
            streamType: 'official',
            title: heroItem.title,
            originalTitle: heroItem.originalTitle || heroItem.title,
            url: heroItem.officialUrl || 'https://www.netflix.com/browse',
            officialUrl: heroItem.officialUrl || 'https://www.netflix.com/browse',
            poster: heroItem.poster,
            backdrop: heroItem.backdrop || heroItem.poster,
            mediaType: heroItem.mediaType || 'tv',
            season: 1,
            episode: 1,
            authenticated: true,
            duration: 2880,
          });
        }
      } catch (err) {
        toast('Oda başlatılırken bir sorun oluştu.');
      } finally {
        heroPlayBtn.disabled = false;
        heroPlayBtn.style.opacity = '1';
      }
    },
  },
    h('span', { style: { fontSize: '1.25rem' } }, '▶'),
    h('span', {}, 'Oynat (Odayı Kur)')
  );

  const heroInfoBtn = h('button', {
    type: 'button',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      background: 'rgba(109, 109, 110, 0.7)',
      color: '#ffffff',
      border: 'none',
      borderRadius: '8px',
      padding: '12px 22px',
      fontSize: '1rem',
      fontWeight: '700',
      cursor: 'pointer',
      transition: 'background .15s ease, transform .15s ease',
    },
    onmouseenter: (e) => { e.currentTarget.style.background = 'rgba(109, 109, 110, 0.9)'; e.currentTarget.style.transform = 'scale(1.03)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = 'rgba(109, 109, 110, 0.7)'; e.currentTarget.style.transform = 'scale(1)'; },
    onclick: () => {
      toast(`ℹ️ ${heroItem.title} · Yılmaz Erdoğan, Kıvanç Tatlıtuğ, Ezgi Mola · Netflix Orijinal Yapımı`);
    },
  },
    h('span', { style: { fontSize: '1.1rem' } }, 'ⓘ'),
    h('span', {}, 'Daha Fazla Bilgi')
  );

  const heroBillboard = h('div', {
    class: 'netflix-hero-billboard',
    style: {
      position: 'relative',
      minHeight: '340px',
      borderRadius: '20px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      padding: '36px 36px 32px',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.75)',
      backgroundImage: `linear-gradient(to right, rgba(0, 0, 0, 0.92) 20%, rgba(0, 0, 0, 0.65) 55%, rgba(0, 0, 0, 0.15) 100%), linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 60%), url('${heroItem.backdrop}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center 20%',
    },
  },
    h('div', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '10px',
      },
    },
      h('span', {
        style: {
          background: '#e50914',
          color: '#fff',
          fontWeight: '900',
          fontSize: '.75rem',
          padding: '3px 8px',
          borderRadius: '4px',
          letterSpacing: '0.5px',
        },
      }, 'TOP 10 FİLM'),
      ...heroItem.tags.map((tg) => h('span', {
        style: {
          fontSize: '.75rem',
          color: '#cbd5e1',
          background: 'rgba(255, 255, 255, 0.15)',
          padding: '3px 8px',
          borderRadius: '4px',
          fontWeight: '600',
        },
      }, tg))
    ),
    h('h1', {
      style: {
        fontSize: '2.4rem',
        fontWeight: '900',
        letterSpacing: '-0.5px',
        margin: '0 0 12px 0',
        color: '#ffffff',
        textShadow: '0 4px 16px rgba(0, 0, 0, 0.8)',
        maxWidth: '720px',
        lineHeight: '1.15',
      },
    }, heroItem.title),
    h('p', {
      style: {
        fontSize: '.95rem',
        color: '#e2e8f0',
        lineHeight: '1.5',
        maxWidth: '620px',
        margin: '0 0 20px 0',
        textShadow: '0 2px 8px rgba(0, 0, 0, 0.8)',
      },
    }, heroItem.overview),
    h('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
      },
    },
      heroPlayBtn,
      heroInfoBtn
    )
  );

  // 3. Search & Instant Filter Bar
  const searchInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '🔍 Netflix kütüphanesinde film veya dizi ara (örn: Organize İşler, Stranger Things)...',
    value: presetQuery || '',
    style: {
      flex: '1 1 360px',
      padding: '14px 18px',
      borderRadius: '12px',
      fontSize: '.95rem',
      background: 'rgba(24, 24, 27, 0.95)',
      border: '1px solid rgba(229, 9, 20, 0.4)',
      color: '#ffffff',
      outline: 'none',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    },
  });

  const searchBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
      borderColor: '#e50914',
      padding: '14px 22px',
      borderRadius: '12px',
      fontWeight: '800',
      fontSize: '.92rem',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(229, 9, 20, 0.4)',
    },
  }, 'Ara');

  const searchWrap = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      flexWrap: 'wrap',
      padding: '4px 0',
    },
  },
    searchInput,
    searchBtn
  );

  // 4. Interactive Card Factory (1-Click Instant Room Creation, Zero Link Copying)
  const makeNetflixCard = (it) => {
    const isTv = it.mediaType === 'tv';
    const card = h('div', {
      class: 'vcard netflix-catalog-card',
      role: 'button',
      tabindex: '0',
      style: {
        background: 'rgba(24, 24, 27, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'all .22s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      },
      onmouseenter: () => {
        card.style.transform = 'translateY(-6px) scale(1.02)';
        card.style.borderColor = '#e50914';
        card.style.boxShadow = '0 12px 28px rgba(229, 9, 20, 0.35)';
      },
      onmouseleave: () => {
        card.style.transform = 'translateY(0) scale(1)';
        card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        card.style.boxShadow = 'none';
      },
      onclick: async () => {
        if (isTv) {
          openTvSeriesModal(it, p, pick);
          return;
        }
        toast(`🎬 Netflix "${it.title}" hazırlanıyor, oda başlatılıyor...`);
        try {
          const res = await resolveCatalogItem(
            { tmdbId: it.tmdbId, title: it.title, originalTitle: it.originalTitle, mediaType: it.mediaType, provider: 'netflix' },
            p, 1, 1
          );
          if (res) {
            await pick(res);
          } else {
            await pick({
              provider: 'netflix',
              catalogProvider: 'netflix',
              streamType: 'official',
              title: it.title,
              originalTitle: it.originalTitle || it.title,
              url: it.officialUrl || (it.netflixId ? `https://www.netflix.com/watch/${it.netflixId}` : `https://www.netflix.com/search?q=${encodeURIComponent(it.title)}`),
              officialUrl: it.officialUrl || 'https://www.netflix.com/browse',
              poster: it.poster,
              backdrop: it.backdrop || it.poster,
              mediaType: it.mediaType || 'tv',
              season: it.season || 1,
              episode: it.episode || 1,
              authenticated: true,
              duration: 3600,
            });
          }
        } catch (err) {
          toast('Oda başlatılırken bir sorun oluştu.');
        }
      },
    },
      h('div', {
        style: { position: 'relative', width: '100%', paddingTop: '148%', background: '#09090b', overflow: 'hidden' },
      },
        h('img', {
          src: it.poster,
          alt: it.title,
          loading: 'lazy',
          onerror: (e) => { e.currentTarget.src = '/static/watchlivo-poster.svg'; },
          style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' },
        }),
        h('div', {
          style: {
            position: 'absolute',
            top: '8px',
            left: '8px',
            background: 'linear-gradient(135deg, #e50914, #b20710)',
            color: '#fff',
            fontSize: '.7rem',
            fontWeight: '900',
            padding: '2px 7px',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
          },
        }, 'N'),
        h('div', {
          style: {
            position: 'absolute',
            bottom: '8px',
            right: '8px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: '#fbbf24',
            fontSize: '.72rem',
            fontWeight: '800',
            padding: '2px 6px',
            borderRadius: '4px',
          },
        }, `★ ${it.rating}`),
        h('div', {
          style: {
            position: 'absolute',
            bottom: '8px',
            left: '8px',
            background: isTv ? 'rgba(59, 130, 246, 0.85)' : 'rgba(229, 9, 20, 0.85)',
            color: '#ffffff',
            fontSize: '.66rem',
            fontWeight: '800',
            padding: '2px 6px',
            borderRadius: '4px',
          },
        }, isTv ? '📺 DİZİ' : '🎬 4K FİLM')
      ),
      h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 } },
        h('div', {
          style: {
            fontWeight: '800',
            fontSize: '.88rem',
            color: '#ffffff',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, it.title),
        h('div', {
          style: { fontSize: '.74rem', color: '#94a3b8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        },
          h('span', {}, it.year || '2024'),
          h('span', { style: { color: '#f87171', fontWeight: '700' } }, isTv ? 'Sezon Seç' : '▶ Hemen İzle')
        )
      )
    );
    return card;
  };

  // 5. Dynamic Shelves Container
  const shelvesContainer = h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '30px' },
  });

  const filterContent = (customQuery = '') => {
    const q = (customQuery || searchInput.value).trim().toLowerCase();
    shelvesContainer.replaceChildren();

    // If query is an active netflix url
    if (/netflix\.com\/(?:[a-z-]+\/)?(?:watch|title)\/(\d+)/i.test(q)) {
      toast('⏳ Netflix bağlantısı algılandı, oda otomatik başlatılıyor...');
      resolveCatalogItem({ sourceUrl: q, title: q, provider: 'netflix' }, p, 1, 1).then((res) => {
        if (res) pick(res);
      });
      return;
    }

    if (q) {
      // Search matching across all hubs
      const allItems = [];
      const seen = new Set();
      for (const hub of NETFLIX_OFFICIAL_HUBS) {
        for (const it of hub.items) {
          if (!seen.has(it.tmdbId)) {
            seen.add(it.tmdbId);
            allItems.push(it);
          }
        }
      }
      const matched = allItems.filter((it) =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.originalTitle || '').toLowerCase().includes(q) ||
        (it.overview || '').toLowerCase().includes(q)
      );

      const searchHead = h('div', {
        style: {
          fontSize: '1.2rem',
          fontWeight: '800',
          color: '#f8fafc',
          borderLeft: '4px solid #e50914',
          paddingLeft: '12px',
          marginBottom: '16px',
        },
      }, `🔍 "${q}" için Netflix Sonuçları (${matched.length} İçerik Bulundu)`);

      const searchGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
          gap: '16px',
        },
      }, ...matched.map(makeNetflixCard));

      if (!matched.length) {
        shelvesContainer.append(
          searchHead,
          h('div', {
            style: {
              padding: '40px',
              textAlign: 'center',
              color: '#94a3b8',
              background: 'rgba(24, 24, 27, 0.5)',
              borderRadius: '14px',
              border: '1px dashed rgba(255, 255, 255, 0.1)',
            },
          },
            h('div', { style: { fontSize: '1.1rem', fontWeight: '700', color: '#fff', marginBottom: '8px' } }, `"${q}" için yerel sonuç bulunamadı`),
            h('div', { style: { fontSize: '.88rem', marginBottom: '16px' } }, 'Genişletilmiş Netflix kütüphanesinden canlı arama yapılıyor...'),
            h('button', {
              type: 'button',
              class: 'btn primary',
              style: { background: '#e50914', borderColor: '#e50914', fontWeight: '800' },
              onclick: async () => {
                toast(`🔍 Netflix genel arşivinde aranıyor: "${q}"...`);
                const res = await resolveCatalogItem({ title: q, originalTitle: q, provider: 'netflix' }, p, 1, 1);
                if (res) await pick(res);
                else toast('İçerik bulunamadı.');
              },
            }, `🌐 "${q}" Başlığını Odada Canlı Başlat`)
          )
        );
        return;
      }

      shelvesContainer.append(searchHead, searchGrid);
      return;
    }

    // Normal Browsing by currentTab
    for (const hub of NETFLIX_OFFICIAL_HUBS) {
      if (currentTab !== 'all') {
        if (currentTab === 'turkish' && hub.id !== 'turkish') continue;
        if (currentTab === 'trending' && hub.id !== 'trending') continue;
        if (currentTab === 'movies' && hub.id !== 'movies') continue;
        if (currentTab === 'series' && hub.id === 'movies') continue;
      }

      const rowTitle = h('div', {
        style: {
          fontSize: '1.15rem',
          fontWeight: '800',
          letterSpacing: '-0.3px',
          color: '#f8fafc',
          borderLeft: '4px solid #e50914',
          paddingLeft: '12px',
          marginBottom: '14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
      },
        h('span', {}, hub.category),
        h('span', { style: { fontSize: '.8rem', color: '#94a3b8', fontWeight: '600' } }, `${hub.items.length} Yapım`)
      );

      const cardsGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
          gap: '16px',
        },
      }, ...hub.items.map(makeNetflixCard));

      const shelfBox = h('div', {},
        rowTitle,
        cardsGrid
      );
      shelvesContainer.appendChild(shelfBox);
    }
  };

  searchBtn.onclick = () => filterContent();
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') filterContent();
  };
  let searchDebounce = null;
  searchInput.oninput = () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => filterContent(), 220);
  };

  // Initial populate
  filterContent(presetQuery || '');

    // 6. Rave.io Nominative Fair Use & Legal Safe Harbor Disclaimer Banner
  const legalSafeHarborBanner = h('div', {
    class: 'netflix-legal-safeharbor-banner',
    style: {
      marginTop: '28px',
      padding: '16px 20px',
      borderRadius: '14px',
      background: 'rgba(15, 23, 42, 0.65)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      fontSize: '.78rem',
      color: '#94a3b8',
      lineHeight: '1.5',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    },
  },
    h('div', { style: { fontWeight: '800', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '.84rem' } },
      h('span', {}, '⚖️'),
      h('span', {}, 'Rave.io Birlikte İzleme Modeli & Yasal Safe Harbor Beyanı (5651 Sayılı Kanun & DMCA)')
    ),
    h('div', {},
      'Netflix, Netflix Inc.\'in tescilli ticari markasıdır. Watchlivo, Netflix Inc. ile doğrudan bağlantılı, sponsorlu veya onaylı bir kuruluş değildir. Platformumuz sunucularında hiçbir video veya medya dosyası barındırmaz (Non-Hosting Provider). Kullanıcıların yetkili hesapları veya açık kaynaklar üzerinden gerçek zamanlı birlikte izleme (Watch Party) ve oynatma zamanı senkronizasyonu sağlayan bağımsız bir köprü yazılımdır.'
    ),
    h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '4px' } },
      h('a', { href: '/dmca', target: '_blank', style: { color: '#ef4444', textDecoration: 'underline', fontWeight: '700' } }, 'Telif Hakkı & DMCA Uyar-Kaldır Bildirimi'),
      h('a', { href: '/terms', target: '_blank', style: { color: '#94a3b8', textDecoration: 'underline' } }, 'Kullanım Koşulları'),
      h('a', { href: '/privacy', target: '_blank', style: { color: '#94a3b8', textDecoration: 'underline' } }, 'Gizlilik & KVKK'),
      h('span', { style: { color: '#64748b' } }, '· İletişim: abuse@watchlivo.online')
    )
  );

  container.append(
    topBar,
    ravePortalWindow,
    heroBillboard,
    searchWrap,
    shelvesContainer,
    legalSafeHarborBanner
  );

  body.replaceChildren(container);
}
