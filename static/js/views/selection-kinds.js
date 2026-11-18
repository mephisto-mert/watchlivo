// Provider selection views by kind (Rave YouTubeSelection / WebSelection / Catalog / upload).
import { h, fill, icons, toast, popup, openThemeModal, openAiConfigModal, getAiApiConfig } from '../ui.js?v=20261118_v184';
import { api, qs } from '../api.js?v=20261118_v184';
import { parseVideoUrl, getProvider, isDesktop, isNativeShell } from '../providers.js?v=20261118_v184';
import { videoCard, ytToMedia, resolveMedia, openYtPersonalizeModal } from './selection.js?v=20261118_v184';
import { renderAccountBar } from '../accounts.js?v=20261118_v184';
import { profileSetup } from '../profile.js?v=20261118_v184';
import { createVoiceSearchButton } from '../voice-note.js?v=20261118_v184';
import {
  getFavorites, isFavoriteMedia, toggleFavoriteMedia, getMusicHistory, saveMusicHistory, clearMusicHistory,
  getWatchHistory, clearWatchHistory, saveWatchProgress, findSavedProgress,
  getYtPrefs, recordYtSearchQuery, fetchPersonalizedYtFeed, subscribe, state,
} from '../store.js?v=20261118_v184';

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
    if (pasted && pasted.provider === 'youtube' && pasted.id) {
      grid.replaceChildren(spinner());
      const res = await api(`/api/search/youtube?${qs({ q: pasted.id })}`).catch(() => ({ items: [] }));
      if (mine !== seq) return;
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
        placeholder: 'https://www.youtube.com/playlist?list=...',
        value: '',
        style: { flex: '1', minWidth: '220px' },
      });
      sectionHeader.replaceChildren(
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', width: '100%', alignItems: 'center' } },
          plInp,
          h('button', { type: 'button', class: 'btn sm primary', onclick: () => {
            const v = plInp.value.trim();
            if (!v) { toast('Lütfen bir YouTube Playlist bağlantısı veya ID girin'); plInp.focus(); return; }
            runSearchQuery(v, '📋 YouTube Playlist İçe Aktarma', false);
          } }, '📋 Playlisti Getir'))
      );
      grid.replaceChildren(h('div', { class: 'lobby-empty' }, 'Odaya topluca aktarmak istediğin YouTube oynatma listesi bağlantısını yukarıya yapıştırıp "Playlisti Getir" butonuna tıkla.'));
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = data.error || (res.status === 401 ? 'Dosya yüklemek için giriş yapmalısınız' : (res.status === 501 ? 'Dosya yükleme özelliği şu an kullanılamıyor' : 'Dosya yüklenemedi'));
        toast(errMsg);
        throw new Error(errMsg);
      }
      status.textContent = 'Yüklendi.';
      await pick({ provider: 'upload', url: data.url, title: f.name.replace(/\.[^.]+$/, ''), channel: 'Yüklenen dosya', thumbnail: '' });
    } catch (e) { status.textContent = `Hata: ${e.message || 'Dosya yüklenemedi'}`; }
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
  wv.src = HOME_URLS[p.id] || p.homeUrl || 'https://www.netflix.com';
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    const url = wv.getURL ? wv.getURL() : wv.src;
    const title = wv.getTitle ? wv.getTitle() : p.name;
    await pick({ provider: p.id, url, videoId: p.idParser?.(url) || url, title: title || p.name, channel: p.name });
  } }, 'Bu Videoyu Odada Başlat');
  body.append(h('div', { class: 'sel-note' }, `${p.name} hesabınla giriş yap, izlemek istediğin içeriği aç ve "Bu Videoyu Odada Başlat" düğmesine tıkla.`), btn, wv);
}

const APP_DOWNLOADS = [
  { href: '/download/apk', label: 'Android uygulaması (APK)', icon: 'android' },
  { href: '/download/windows', label: 'Windows uygulaması', icon: 'windows' },
  { href: '/download/ios', label: 'iPhone / iPad', icon: 'download' },
];

// Rave model explainer for subscription platforms on the plain web site: Watchlivo never plays
// platform content itself; each participant opens the platform in the Watchlivo app's in-app
// browser and signs in with their OWN account. Only play / pause / seek is synchronised.
export function accountExplainerCard(p) {
  const name = p?.name || 'Bu platform';
  return h('div', { class: 'sel-desktop wl-account-explainer', 'data-account-provider': p?.id || '' },
    p?.logo ? h('img', { src: p.logo, alt: name }) : h('h3', { style: { margin: 0 } }, name),
    h('b', { class: 'wl-account-explainer-title' }, `${name} ile birlikte izlemek için Watchlivo uygulamasını indir ve kendi ${name} hesabınla giriş yap`),
    h('div', { class: 'dim', style: { fontSize: '.86em', lineHeight: 1.55, maxWidth: '520px' } },
      `Watchlivo ${name} içeriğini barındırmaz, kopyalamaz veya yeniden yayınlamaz. Uygulamadaki dahili tarayıcıda odadaki herkes kendi ${name} aboneliğiyle giriş yapar; Watchlivo yalnızca oynat, duraklat ve ileri/geri sar komutlarını eşitler.`),
    h('div', { class: 'wl-account-dl-row', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
      ...APP_DOWNLOADS.map((d) => h('a', { class: 'btn primary wl-account-dl', href: d.href, style: { textDecoration: 'none' } },
        icons[d.icon] ? h('span', { html: icons[d.icon], style: { display: 'flex' } }) : null, d.label))),
    h('div', { class: 'dim', style: { fontSize: '.78em' } }, 'Tarayıcıda doğrudan izleyebileceklerin: YouTube, Google Drive dosyaların, kendi yüklediğin videolar, Vimeo / Twitch / Kick bağlantıları ve müzik.'));
}

export function openAccountPlatformModal(p) {
  return popup({ title: `${p?.name || 'Platform'} · Kendi hesabınla birlikte izle`, content: accountExplainerCard(p), options: [{ label: 'Kapat' }] });
}

export function renderAccountKind(p, body, pick) {
  if (isDesktop()) { renderDesktopKind(p, body, pick); return; }
  if (!isNativeShell()) { body.append(accountExplainerCard(p)); return; }
  const startWith = async (url, title) => {
    await pick({ provider: p.id, url, title: title || p.name, channel: `${p.name} · Kendi hesabınla`, streamType: 'official', ownAccount: true });
  };
  const input = h('input', { placeholder: p.placeholder || `${p.name} içerik bağlantısını yapıştır...`, 'aria-label': `${p.name} bağlantısı` });
  const go = async () => {
    let v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    const parsed = parseVideoUrl(v);
    if (!parsed || parsed.provider !== p.id) { toast(`Geçerli bir ${p.name} bağlantısı değil`); return; }
    await startWith(v, p.name);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  body.append(
    h('div', { class: 'sel-note' }, `Odadaki herkes ${p.name} sayfasını uygulamanın dahili tarayıcısında açar ve kendi ${p.name} hesabıyla giriş yapar. Watchlivo yalnızca oynat / duraklat / sar komutlarını eşitler.`),
    h('div', { class: 'sel-search' }, h('span', { html: icons.link, style: { display: 'flex', opacity: .7 } }), input,
      h('button', { class: 'btn primary', onclick: go }, 'Odada Aç')),
    h('button', { class: 'btn', style: { marginTop: '.6em' }, onclick: () => startWith(p.homeUrl || HOME_URLS[p.id], p.name) }, `${p.name} ana sayfasını odada aç`));
}

export async function resolveMusicItem(item, prov = { id: 'music', name: 'Müzik & Klip' }, mode = '') {
  const effectiveMode = mode || item.musicMode || (item.preferAudio ? 'audio' : 'video');
  const query = qs({
    provider: 'music',
    artist: item.artist || '',
    title: item.songTitle || item.title || '',
    videoId: item.videoId || '',
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
        const qObj = (it.qualities || []).find((x) => String(x.label || '').toLowerCase().startsWith(selectedQuality.toLowerCase())) || (it.qualities || [])[0] || { url: it.url };
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
    const qA = (aVal ?? trackAInp.value).trim();
    const qB = (bVal ?? trackBInp.value).trim();
    if (!qA || !qB) {
      toast('Lütfen Mashup için iki şarkı adı veya linki girin');
      return;
    }
    statusBox.replaceChildren(spinner());
    try {
      const res = await api('/api/rave/ravedj-mashup', {
        method: 'POST',
        body: { trackA: qA, trackB: qB },
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
