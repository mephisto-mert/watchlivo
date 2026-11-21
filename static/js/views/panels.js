// Side panels for Rave mesh/view: MeshList · Settings · Vote · Friends(Invite) · Globe · Participants.
import { h, icons, toast, confirmPopup, fill, openThemeModal, handleWindowsAppDownload } from '../ui.js?v=20261121_v232';
import {
  state, setUiPref, subscribe, isLeader, isHostOnly, isFriend,
  getWatchHistory, getMusicHistory,
  syncSocialState, sendFriendRequest, updateFriendAction, sendRoomInvite,
} from '../store.js?v=20261121_v232';
import { avatar } from '../profile.js?v=20261121_v232';
import { clock } from '../sync.js?v=20261121_v232';
import { fetchRooms, meshThumb, thumbFor, openFriendsManagerModal, openRoomInviteModal } from './lobby.js?v=20261121_v232';
import { copyInvite, inviteUrl } from './chat.js?v=20261121_v232';
import { parseVideoUrl, getProvider } from '../providers.js?v=20261121_v232';
import { resolveMedia } from './selection.js?v=20261121_v232';
import { resolveMusicItem, resolveCatalogItem } from './selection-kinds.js?v=20261121_v232';

const seg = (options, current, onPick, disabled) => h('div', { class: 'seg' }, options.map(([k, label, desc]) =>
  h('button', { class: current === k ? 'on' : '', disabled: disabled ? true : null, 'data-value': k, onclick: () => onPick(k) }, label, desc ? h('small', {}, desc) : null)));

function MeshList() {
  const el = h('div', { style: { padding: '.2em 0 1em' } }, h('div', { style: { display: 'flex', justifyContent: 'center', padding: '1em' } }, h('div', { class: 'spinner' })));
  const load = async () => {
    const rooms = (await fetchRooms().catch(() => [])).filter((r) => r.id !== state.mesh?.id && r.count > 0);
    el.replaceChildren(...(rooms.length ? [h('div', { class: 'lobby-grid', style: { gridTemplateColumns: '1fr', padding: '0 .6em' } }, rooms.map((r) => meshThumb(r, async (room) => {
      if (await confirmPopup(`"${room.media?.title || room.name}" odasına geçilsin mi?`, 'Geç', 'Kal')) window.vortexNavigate(`/mesh/${encodeURIComponent(room.id)}`);
    })))] : [h('div', { class: 'lobby-empty' }, 'Şu anda başka aktif oda yok.')]));
  };
  load();
  const t = setInterval(load, 10000);
  return { el, destroy: () => clearInterval(t) };
}

function Settings(ctx) {
  const el = h('div');
  let lastSig = '';
  const act = (action, extra) => (isHostOnly() ? ctx.actions.hostAction(action, extra) : toast('Bu ayarları yalnızca oda lideri değiştirebilir.'));
  const leadNote = h('div', { class: 'sel-note', style: { display: 'none' } }, 'Oda ayarlarını yalnızca oda lideri değiştirebilir.');
  const nameInput = h('input', {
    class: 'input',
    'aria-label': 'Oda adı',
    maxlength: '45',
    onchange: (e) => {
      const next = String(e.target.value || '').trim();
      if (!next || next === state.mesh?.name) return;
      act('set_privacy', { name: next });
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
      }
    },
  });
  const pwInput = h('input', {
    class: 'input',
    type: 'password',
    'aria-label': 'Oda şifresi',
    placeholder: 'Şifre yok',
    onchange: (e) => {
      const clean = String(e.target.value || '').trim();
      if (!clean) return;
      e.target.value = '';
      e.target.blur();
      act('set_privacy', { password: clean });
      toast('🔒 Oda şifresi güncellendi');
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.dispatchEvent(new Event('change'));
      }
    },
  });
  const clearPwBtn = h('button', {
    type: 'button',
    class: 'btn sm ghost',
    style: { marginTop: '6px', display: 'none' },
    onclick: () => act('set_privacy', { password: '' }),
  }, '🔓 Şifreyi Kaldır');
  const privacySeg = seg([
    ['public', 'Herkese Açık', 'Herkes odaya katılabilir'],
    ['friends', 'Arkadaşlar', 'Arkadaşlar odaya katılabilir'],
    ['private', 'Gizli', 'Yalnızca bağlantısı olanlar katılır'],
  ], '', (k) => act('set_privacy', { privacy: k }), false);
  const playModeSeg = seg([
    ['leader', 'Liderin Seçimi', 'Yalnızca lider video seçebilir'],
    ['cohost', 'Ortak Kontrol (Çift Modu)', 'Herkes oynatıp sarabilir ve seçebilir'],
    ['autoplay', 'Otomatik Oynat', 'Sıradaki videolar otomatik oynar'],
    ['quickplay', 'Hemen Oynat', 'Tek seçimle video oynar'],
    ['vote', 'Oylayalım', 'Video sırası oylamayla belirlenir'],
  ], '', (k) => act('set_privacy', { playMode: k }), false);
  const voipModeSeg = seg([
    ['off', 'Kapalı', 'Sesli sohbet yok'],
    ['leader', 'Yalnızca Lider', 'Yalnızca lider konuşabilir'],
    ['stage', 'Sahne Modu (20+ Kişi)', 'Dinleyiciler ✋ Söz İste ile mikrofon alır'],
    ['all', 'Herkes', 'Herkes sesli sohbet yapabilir'],
  ], '', (k) => act('set_privacy', { voipMode: k }), false);
  const closeRoomGroup = h('div', { class: 'settings-group', style: { display: 'none' } },
    h('h4', {}, 'Oda Yönetimi'),
    h('button', {
      type: 'button',
      class: 'btn danger',
      id: 'btn-close-room-all',
      style: { width: '100%', justifyContent: 'center', fontWeight: '800', background: 'rgba(239, 68, 68, 0.18)', border: '1px solid rgba(239, 68, 68, 0.5)', color: '#fca5a5' },
      onclick: async () => {
        if (await confirmPopup('Odayı herkes için tamamen kapatmak istediğinize emin misiniz?', 'Odayı Kapat', 'Vazgeç')) {
          ctx.actions.leave(true);
        }
      },
    }, '🚪 Odayı Kapat ve Herkesi Çıkar'));
  const appsGroup = (() => {
    const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
    const inApk = /WatchlivoApp/i.test(ua) || (/Android/i.test(ua) && /;\s*wv\b/i.test(ua));
    if (inApk) return null;
    const safeBinaryDownload = async (ev, dlUrl, filename, label) => {
      ev.preventDefault();
      try {
        const head = await fetch(dlUrl, { method: 'HEAD', cache: 'no-store' });
        const ct = String(head.headers.get('content-type') || '').toLowerCase();
        if (!head.ok || ct.includes('text/html')) {
          toast(`ℹ️ ${label} paketi bu sunucuda geçici olarak mevcut değil — tarayıcıdan PWA olarak kurabilirsin.`);
          return;
        }
        toast(`⬇️ ${label} indiriliyor...`, 3500);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = filename;
        a.click();
      } catch (_) {
        toast(`ℹ️ ${label} indirme bağlantısına şu an ulaşılamıyor.`);
      }
    };
    return h('div', { class: 'settings-group' },
      h('h4', {}, 'Watchlivo Uygulamaları'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('a', { href: '/download/ipa', onclick: (ev) => safeBinaryDownload(ev, '/download/ipa', 'Watchlivo.ipa', 'iOS IPA'), class: 'btn', style: { width: '100%', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg, rgba(244,63,94,.18), rgba(251,146,60,.18))', border: '1px solid rgba(244,63,94,.4)', color: '#fda4af', fontWeight: '700' } }, '🍎 iPhone / iOS IPA İndir (.ipa)'),
        h('a', { href: '/download/Watchlivo-v2.0.apk', onclick: (ev) => safeBinaryDownload(ev, '/download/Watchlivo-v2.0.apk', 'Watchlivo-v2.0.apk', 'Android APK'), class: 'btn', style: { width: '100%', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg, rgba(99, 102, 241,.18), rgba(56,189,248,.18))', border: '1px solid rgba(99, 102, 241,.4)', color: '#6366f1', fontWeight: '700' } }, '📱 Android Native APK İndir (v2.0.2)'),
        h('a', { href: '/download/windows', onclick: handleWindowsAppDownload, class: 'btn', style: { width: '100%', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg, rgba(168,85,247,.18), rgba(59,130,246,.18))', border: '1px solid rgba(168,85,247,.4)', color: '#c084fc', fontWeight: '700' } }, '💻 Windows Masaüstü Kur')
      )
    );
  })();
  fill(el,
    leadNote,
    h('div', { class: 'settings-group' }, h('h4', {}, 'Oda adı'), nameInput),
    h('div', { class: 'settings-group' }, h('h4', {}, 'Gizlilik'), privacySeg),
    h('div', { class: 'settings-group' }, h('h4', {}, 'Oynatma'), playModeSeg),
    h('div', { class: 'settings-group' }, h('h4', {}, 'Ses'), voipModeSeg),
    h('div', { class: 'settings-group' }, h('h4', {}, 'Oda şifresi'), pwInput, clearPwBtn),
    h('div', { class: 'settings-group' },
      h('h4', {}, 'Görünüm & Tema'),
      h('button', { type: 'button', class: 'btn primary', style: { width: '100%' }, onclick: () => openThemeModal() }, '🎨 Görünüm & Tema Ayarları')),
    closeRoomGroup,
    appsGroup
  );
  const syncSeg = (container, current, disabled) => {
    container.querySelectorAll('button[data-value]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.value === current);
      btn.disabled = Boolean(disabled);
    });
  };
  const update = () => {
    const m = state.mesh;
    if (!m) return;
    const lead = isHostOnly();
    const voipVal = m.voipMode === 'on' ? 'all' : m.voipMode;
    const sig = `${m.name}|${m.privacy}|${m.playMode}|${voipVal}|${Boolean(m.hasPassword)}|${lead}|${Boolean(m.curated)}`;
    if (sig === lastSig) return;
    lastSig = sig;
    leadNote.style.display = lead ? 'none' : '';
    nameInput.disabled = !lead;
    if (document.activeElement !== nameInput) nameInput.value = m.name || '';
    pwInput.disabled = !lead;
    pwInput.placeholder = m.hasPassword ? 'Şifre ayarlı (değiştirmek için yaz)' : 'Şifre yok';
    clearPwBtn.style.display = (m.hasPassword && lead) ? '' : 'none';
    syncSeg(privacySeg, m.privacy, !lead);
    syncSeg(playModeSeg, m.playMode, !lead);
    syncSeg(voipModeSeg, voipVal, !lead);
    closeRoomGroup.style.display = (lead && !m.curated) ? '' : 'none';
  };
  update();
  return { el, update };
}

function Vote(ctx) {
  const el = h('div');
  let pieTimer = null;
  let lastTriggeredVoteEnd = 0;
  const voteVideo = (i, id) => (ctx.actions.voteVideo || ctx.actions.voteQueue)?.(i, id);
  const playQueueIndex = (i, id) => (ctx.actions.playQueueIndex || ctx.actions.playQueue)?.(i, id);
  const removeQueueItem = (i, id) => (ctx.actions.removeQueueItem || ctx.actions.removeQueue)?.(i, id);
  const urlInput = h('input', {
    class: 'input',
    placeholder: 'YouTube, MP4, M3U8, Kick bağlantısı yapıştır...',
    'aria-label': 'Sıraya video bağlantısı ekle',
    style: { flex: '1', fontSize: '.78rem', padding: '7px 10px' },
  });
  const addFromInput = async (playNow = false) => {
    const raw = String(urlInput.value || '').trim();
    if (!raw) {
      ctx?.layout?.openSearch?.();
      return;
    }
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = parseVideoUrl(url);
    if (!parsed) {
      urlInput.value = '';
      ctx?.layout?.openSearch?.();
      setTimeout(() => {
        const sInp = document.querySelector('#mesh-root .panel-left input.wl-search-input, #mesh-root .panel-left input[aria-label="Ara"], #mesh-root .panel-left input');
        if (sInp) {
          sInp.value = raw;
          sInp.dispatchEvent(new Event('input', { bubbles: true }));
          try { sInp.focus(); } catch (_) {}
        }
      }, 60);
      toast(`🔍 "${raw}" katalogda aranıyor...`);
      return;
    }
    toast('⏳ Video bilgisi alınıyor...');
    const media = await resolveMedia(parsed);
    if (!media) return;
    urlInput.value = '';
    if (playNow && isLeader()) {
      ctx.actions.pickMedia(media);
    } else {
      ctx.actions.queueMusic(media);
    }
  };
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput(false);
    }
  });
  const quickAddBox = h('div', { class: 'w2g-queue-add-box', style: { padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)' } },
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
      urlInput,
      h('button', { type: 'button', class: 'btn sm primary', onclick: () => addFromInput(false) }, '+ Ekle')),
    h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { type: 'button', class: 'btn sm ghost', style: { flex: '1', justifyContent: 'center' }, onclick: () => ctx?.layout?.openSearch?.() }, '🔍 Katalog & YouTube Ara')));

  const update = () => {
    if (el.contains(document.activeElement) && document.activeElement === urlInput) return;
    const m = state.mesh;
    const q = m?.queue || [];
    const mode = m?.playMode;
    const lead = isLeader();
    const maxVotes = Math.max(0, ...q.map((x) => (x.votes || []).length));
    const pie = h('div', { class: 'pie-timer', id: 'vote-pie' });
    clearInterval(pieTimer);
    const nowMs = () => clock.now() * 1000;
    if (m?.voteEndsAt && m.voteEndsAt * 1000 > nowMs()) {
      const total = 8000;
      pieTimer = setInterval(() => {
        const rem = m.voteEndsAt * 1000 - nowMs();
        if (rem <= 0) {
          clearInterval(pieTimer);
          pie.remove();
          if (state.mesh?.voteEndsAt && Date.now() / 1000 >= state.mesh.voteEndsAt && lastTriggeredVoteEnd !== state.mesh.voteEndsAt) {
            lastTriggeredVoteEnd = state.mesh.voteEndsAt;
            ctx.actions?.ended?.();
          }
          return;
        }
        pie.style.setProperty('--p', `${100 - (rem / total) * 100}%`);
        pie.textContent = Math.ceil(rem / 1000);
      }, 200);
    }
    const resolveHistoryEntry = async (item) => {
      if (!item) return null;
      const isMus = Boolean(item.isMusic || item.mediaType === 'music' || item.provider === 'music' || item.artist);
      if (isMus) {
        const resolved = await resolveMusicItem(item).catch(() => null);
        return resolved || (item.videoId ? { ...item, provider: 'youtube', isMusic: true } : null);
      }
      if (item.provider === 'youtube' && item.videoId) return item;
      if (item.tmdbId || item.catalogProvider || /cinema|anime|turkish/i.test(String(item.provider || ''))) {
        const prov = getProvider(item.catalogProvider || item.provider || 'cinema') || { id: 'cinema', name: 'Sinema & Dizi' };
        const resolved = await resolveCatalogItem(item, prov, Number(item.season || 1), Number(item.episode || 1), '', { applySavedResume: false }).catch(() => null);
        if (resolved) return resolved;
      }
      return (item.url || item.videoId || item.embedUrl) ? item : null;
    };
    const recentHistory = [...getWatchHistory().slice(0, 4), ...getMusicHistory().slice(0, 3)].slice(0, 5);
    const historyBox = recentHistory.length ? h('div', { style: { padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '6px' } },
      h('div', { style: { fontSize: '.74rem', fontWeight: '700', color: '#A0A9B8', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '.04em' } }, '🕘 Oda & İzleme Geçmişi'),
      h('div', { class: 'vote-list' }, recentHistory.map((item) => h('div', { class: 'vote-card', style: { cursor: 'default' } },
        h('img', { src: item.thumbnail || item.poster || '/static/watchlivo-poster.svg', alt: '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
        h('div', { class: 'vi' },
          h('div', { class: 'vt' }, item.songTitle || item.title || 'Video'),
          h('div', { style: { display: 'flex', gap: '4px', marginTop: '4px' } },
            h('button', {
              type: 'button',
              class: 'btn sm',
              style: { padding: '2px 7px', fontSize: '.7rem' },
              onclick: async () => {
                toast('⏳ İçerik hazırlanıyor...');
                const ready = await resolveHistoryEntry(item);
                if (ready) ctx.actions.queueMusic(ready);
                else toast('⚠️ Bu geçmiş öğesi şu an çözümlenemedi');
              },
            }, '+ Sıraya'),
            lead ? h('button', {
              type: 'button',
              class: 'btn sm primary',
              style: { padding: '2px 7px', fontSize: '.7rem' },
              onclick: async () => {
                toast('⏳ İçerik hazırlanıyor...');
                const ready = await resolveHistoryEntry(item);
                if (ready) ctx.actions.pickMedia(ready);
                else toast('⚠️ Bu geçmiş öğesi şu an açılamadı');
              },
            }, '▶ Oynat') : null)))))) : null;

    const humanCount = (state.mesh?.participants || []).filter((p) => p && p.transport !== 'bot').length || 1;
    const skipNeeded = state.mesh?.skipNeeded || Math.max(1, Math.floor(humanCount / 2) + 1);
    const skipVotes = state.mesh?.skipVotes || state.mesh?.skip_votes || [];

    fill(el,
      quickAddBox,
      h('div', { class: 'sel-note' }, mode === 'vote' ? 'Oylayalım: en çok oy alan video sıradaki olur.' : mode === 'autoplay' ? 'Otomatik Oynat: sıradaki video bitince otomatik başlar.' : mode === 'leader' ? "Liderin Seçimi: herkes sıraya video önerebilir, lider başlatır." : 'Hemen Oynat: seçilen video hemen oynar.'),
      m?.voteEndsAt && m.voteEndsAt * 1000 > nowMs() ? h('div', { style: { display: 'flex', justifyContent: 'center' } }, pie) : null,
      q.length ? h('div', { class: 'vote-list' }, q.map((it, i) => {
        const votes = (it.votes || []).length;
        const voted = (it.votes || []).includes(state.clientId) || (it.votes || []).includes(state.self?.uid) || (it.votes || []).includes(state.self?.id) || (it.votes || []).includes(state.self?.name);
        const canPlayItem = lead || ['quickplay', 'free', 'cohost'].includes(mode || '');
        const canRemoveItem = lead || Boolean(it.addedByCid && state.clientId && it.addedByCid === state.clientId);
        return h('div', { class: `vote-card ${votes && votes === maxVotes ? 'winning' : ''} ${voted ? 'voted' : ''}`, onclick: () => voteVideo(i, it.id) },
          h('img', { src: thumbFor(it) || '/static/watchlivo-logo.svg', alt: '', onerror: (e) => { e.target.onerror = null; e.target.src = '/static/watchlivo-poster.svg'; } }),
          h('div', { class: 'vi' }, h('div', { class: 'vt' }, it.title || 'Video'), h('div', { class: 'vs' }, `${it.addedBy || ''} ekledi`),
            (canPlayItem || canRemoveItem) ? h('div', { style: { display: 'flex', gap: '.3em', marginTop: '.35em' } },
              canPlayItem ? h('button', { class: 'btn', style: { padding: '.3em .7em', fontSize: '.75em' }, onclick: (e) => { e.stopPropagation(); playQueueIndex(i, it.id); } }, 'Şimdi Oynat') : null,
              canRemoveItem ? h('button', { class: 'btn danger', style: { padding: '.3em .7em', fontSize: '.75em' }, onclick: (e) => { e.stopPropagation(); removeQueueItem(i, it.id); } }, 'Kaldır') : null) : null),
          votes ? h('span', { class: 'vote-counter' }, votes) : null);
      })) : h('div', { class: 'lobby-empty', style: { padding: '14px 10px' } }, 'Sıra boş. Yukarıdan bağlantı yapıştırabilir veya Katalogdan video ekleyebilirsin.'),
      skipVotes.length ? h('div', { class: 'sel-note' }, `⚡ Geç (${skipVotes.length}/${skipNeeded})`) : null,
      historyBox);
  };
  update();
  return { el, update, destroy: () => clearInterval(pieTimer) };
}

function Friends() {
  const invitedSet = new Set();
  const liveFriendsSlot = h('div', { class: 'wl-room-invite-friends' });

  const computeInviteMeta = () => {
    const shareUrl = inviteUrl();
    const roomTitle = state.mesh?.media?.title || state.mesh?.name || 'Sinema Odası';
    const rid = state.mesh?.id || state.route?.params?.id || '';
    let roomPassword = state.route?.params?.pwd || '';
    if (!roomPassword && rid) {
      try { roomPassword = sessionStorage.getItem('vortex_pwd_' + rid) || ''; } catch (_) {}
    }
    const sender = state.self?.name || 'Arkadaşın';
    const pwdPart = roomPassword ? ` (Şifre: ${roomPassword})` : '';
    const inviteText = `🎬 ${sender} seni Watchlivo'da "${roomTitle}" izlemeye çağırıyor!${pwdPart} Tek tıkla odaya katıl: ${shareUrl}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(inviteText)}`;
    const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(`🎬 ${sender} seni Watchlivo'da "${roomTitle}" izlemeye çağırıyor!${pwdPart}`)}`;
    let qrSrc = '';
    try {
      const cleanQr = new URL(shareUrl);
      const rTok = state.mesh?.syncToken || (rid ? sessionStorage.getItem(`vortex_st_${rid}`) : '') || '';
      if (rTok && !cleanQr.searchParams.get('r_tok')) {
        cleanQr.searchParams.set('r_tok', rTok);
      }
      qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=${encodeURIComponent(cleanQr.toString())}`;
    } catch (_) {
      qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=${encodeURIComponent(shareUrl || location.origin)}`;
    }
    return { shareUrl, roomTitle, roomPassword, sender, inviteText, waUrl, tgUrl, qrSrc };
  };

  const copyCardMsg = async () => {
    const { inviteText } = computeInviteMeta();
    try { await navigator.clipboard.writeText(inviteText); toast('📋 Hazır davet mesajı kopyalandı!'); }
    catch (e) { copyInvite(); }
  };

  const previewTitleEl = h('div', { class: 'invite-preview-title' });
  const previewSubEl = h('div', { class: 'invite-preview-sub' });
  const shareInputEl = h('input', { class: 'input', 'aria-label': 'Oda davet bağlantısı', value: '', readonly: true, onclick: (e) => e.target.select() });
  const waLinkEl = h('a', { class: 'btn invite-social-btn wa', href: '#', target: '_blank', rel: 'noopener' }, '💬 WhatsApp ile Gönder');
  const tgLinkEl = h('a', { class: 'btn invite-social-btn tg', href: '#', target: '_blank', rel: 'noopener' }, '✈️ Telegram ile Gönder');
  const qrImgEl = h('img', {
    class: 'qr',
    alt: 'Davet QR kodu',
    loading: 'lazy',
    src: '',
  });

  const renderLiveFriends = () => {
    const friends = state.social?.friends || [];
    if (!friends.length) {
      liveFriendsSlot.replaceChildren(
        h('div', { style: { padding: '8px 10px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', fontSize: '.77rem', color: 'rgba(255,255,255,0.65)' } },
          'Henüz karşılıklı arkadaşın yok. Aşağıdan @kullaniciadi ile arkadaş ekleyip tek tıkla odaya davet edebilirsin.')
      );
      return;
    }
    liveFriendsSlot.replaceChildren(
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
        h('strong', { style: { fontSize: '.78rem', color: '#e2e8f0' } }, `👥 Arkadaşlarını Odaya Çağır (${friends.length})`),
        h('button', {
          type: 'button',
          class: 'btn sm',
          style: { fontSize: '.7rem', padding: '3px 8px' },
          onclick: () => openRoomInviteModal(),
        }, 'Tüm Liste')),
      ...friends.slice(0, 8).map((f) => {
        const fUid = f.uid || f.id || '';
        const pState = f.presenceState || (f.online ? 'online' : 'offline');
        const isInv = invitedSet.has(fUid);
        const inSameRoom = Boolean(state.mesh?.id && (
          f.roomId === state.mesh.id ||
          f.watchingRoom?.roomId === state.mesh.id ||
          (state.mesh.participants || []).some((p) =>
            (p.uid && f.uid && p.uid === f.uid) ||
            (p.handle && f.handle && p.handle.toLowerCase() === f.handle.toLowerCase())
          )
        ));
        return h('div', { class: 'wl-room-invite-row' },
          h('div', { style: { position: 'relative', flexShrink: '0' } },
            avatar(f, 30),
            h('span', { class: `wl-pres-dot is-${pState}` })),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('strong', { style: { fontSize: '.79rem', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
            h('span', { class: `wl-dm-pres-line is-${pState}` },
              inSameRoom ? '✅ Şu an bu odada' : (pState === 'watching' && f.mediaTitle ? `🎬 ${f.mediaTitle}` : (pState === 'online' ? '🟢 Çevrimiçi' : (pState === 'idle' ? '🌙 Uzakta' : '⚫ Çevrimdışı'))))),
          inSameRoom
            ? h('span', { class: 'wl-friend-pill ok', style: { fontSize: '.72rem', padding: '4px 9px' } }, '✅ Odada')
            : h('button', {
                type: 'button',
                class: `btn sm ${isInv ? '' : 'primary'}`,
                style: { fontSize: '.72rem', padding: '4px 9px' },
                onclick: async () => {
                  if (isInv) {
                    const r = await sendRoomInvite(fUid, 'cancel');
                    if (!r?.ok) { toast(r?.error || 'Davet iptal edilemedi.'); return; }
                    invitedSet.delete(fUid);
                    toast(`${f.name} daveti iptal edildi`);
                  } else {
                    const r = await sendRoomInvite(fUid, 'send');
                    if (r?.ok && Number(r?.sentCount ?? 1) > 0) {
                      invitedSet.add(fUid);
                      toast(`📩 ${f.name} odaya davet edildi!`);
                    } else {
                      toast(r?.error || 'Davet gönderilemedi');
                    }
                  }
                  renderLiveFriends();
                },
              }, isInv ? '✓ Davetli · İptal' : '📩 Davet Et'));
      })
    );
  };

  const refreshFriendsPanel = () => {
    const { shareUrl, roomTitle, roomPassword, sender, waUrl, tgUrl, qrSrc } = computeInviteMeta();
    previewTitleEl.textContent = roomTitle;
    previewSubEl.textContent = `${sender} seni birlikte film/dizi izlemeye davet ediyor.${roomPassword ? ` · 🔒 Şifre: ${roomPassword}` : ''}`;
    shareInputEl.value = shareUrl;
    waLinkEl.href = waUrl;
    tgLinkEl.href = tgUrl;
    if (qrImgEl.dataset.qrSrc !== qrSrc) {
      qrImgEl.dataset.qrSrc = qrSrc;
      qrImgEl.src = qrSrc;
    }
    renderLiveFriends();
  };

  refreshFriendsPanel();
  syncSocialState(true).then(() => { if (liveFriendsSlot.isConnected) refreshFriendsPanel(); }).catch(() => {});

  const onFriendsUpdated = () => {
    if (liveFriendsSlot.isConnected) refreshFriendsPanel();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('vortex_friends_updated', onFriendsUpdated);
  }

  const el = h('div', { class: 'invite-panel-wrap' },
    h('div', { class: 'invite-preview-card' },
      h('div', { class: 'invite-preview-badge' }, '🎬 WATCHLIVO DAVET KARTI'),
      previewTitleEl,
      previewSubEl),
    liveFriendsSlot,
    h('div', { style: { display: 'flex', gap: '6px', width: '100%' } },
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        id: 'btn-send-room-push',
        style: { flex: '1', justifyContent: 'center' },
        onclick: async () => {
          const r = await sendRoomInvite('', 'invite_all_online');
          const invCnt = Number(r?.invitedCount ?? r?.sentCount ?? 0);
          if (r?.ok && invCnt > 0) {
            toast(`🔔 ${invCnt} çevrimiçi arkadaşına oda daveti gönderildi!`);
          } else {
            window.vortexSendRoomNotification?.();
          }
        },
      }, '🔔 Çevrimiçi Arkadaşları Çağır'),
      h('button', {
        type: 'button',
        class: 'btn sm',
        style: { justifyContent: 'center' },
        onclick: () => openFriendsManagerModal(() => refreshFriendsPanel(), 'search'),
      }, '➕ Arkadaş Ekle')),
    h('div', { class: 'share-box' },
      shareInputEl,
      h('button', { class: 'btn primary', onclick: copyInvite, 'aria-label': 'Kopyala' }, h('span', { html: icons.copy, style: { display: 'flex' } }))),
    h('div', { class: 'invite-social-grid' },
      waLinkEl,
      tgLinkEl,
      h('button', { type: 'button', class: 'btn invite-social-btn copy-msg', onclick: copyCardMsg }, '📋 Davet Mesajını Kopyala'),
      navigator.share ? h('button', { type: 'button', class: 'btn invite-social-btn', onclick: () => { const m = computeInviteMeta(); navigator.share({ title: 'Watchlivo Sinema Odası', text: m.inviteText, url: m.shareUrl }).catch(() => {}); } }, '📲 Diğer Uygulamalar') : null),
    qrImgEl,
    h('div', { class: 'sel-note', style: { textAlign: 'center' } }, 'Telefon kamerasıyla QR kodu okut ve anında odaya katıl.'));
  return {
    el,
    update: refreshFriendsPanel,
    destroy: () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('vortex_friends_updated', onFriendsUpdated);
      }
    },
  };
}

const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐');
function Globe() {
  const el = h('div');
  const update = () => {
    const groups = {};
    for (const p of state.mesh?.participants || []) (groups[p.country || '??'] ||= []).push(p);
    el.replaceChildren(h('div', { class: 'sel-note' }, 'Katılımcıların cihaz dil/bölge ayarına göre konumları.'),
      ...Object.entries(groups).map(([cc, list]) => h('div', { class: 'settings-group' }, h('h4', {}, `${flag(cc)} ${cc === '??' ? 'Bilinmiyor' : cc} · ${list.length}`),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, list.map((p) => h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '.82em' } }, avatar(p, 24), p.name))))));
  };
  update();
  return { el, update };
}

function Participants(ctx) {
  const el = h('div', { style: { paddingBottom: '1em' } });
  const update = () => {
    if (el.contains(document.activeElement) && document.activeElement?.classList?.contains('peer-vol-slider')) return;
    const m = state.mesh;
    const hostOnly = isHostOnly();
    const duckOn = state.uiPrefs?.voiceDucking !== false && !['off', '0', 'false'].includes(String(localStorage.getItem('vortex_voice_duck') || '').toLowerCase());
    const duckBar = h('div', { class: 'voice-duck-bar' },
      h('span', {}, '🔉 Konuşurken Filmi Otomatik Kıs'),
      h('button', {
        type: 'button',
        class: `btn sm ${duckOn ? 'primary' : ''}`,
        onclick: () => {
          const next = !duckOn;
          try { localStorage.setItem('vortex_voice_duck', next ? 'on' : 'off'); } catch (e) { /* ignore */ }
          setUiPref({ voiceDucking: next });
          window.vortexSetAutoDuck?.(next);
          window.__kinoxSyncDuckVolume?.();
          toast(next ? '🔉 Akıllı ses dengesi açıldı' : '🔉 Akıllı ses dengesi kapatıldı');
          update();
        },
      }, duckOn ? 'Açık ✓' : 'Kapalı'));
    const allParts = m?.participants || [];
    const totalCount = Number(m?.participantCount || m?.count || allParts.length);
    const visibleParts = allParts.slice(0, 60);
    const overflowCount = Math.max(0, totalCount - visibleParts.length);
    fill(el,
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        style: { width: '100%', marginBottom: '8px', justifyContent: 'center' },
        onclick: () => openFriendsManagerModal(() => update()),
      }, '👥 + Kullanıcı Adıyla Arkadaş Ekle'),
      duckBar,
      ...visibleParts.map((p) => {
        const isMe = p.id === state.clientId;
        const isBot = p.id === 'kinox_bot';
        const friendAdded = isFriend(p);
        const peerVol = ctx.voice?.getPeerVolume?.(p.id) ?? 100;
        return h('div', { class: `raver ${p.speaking ? 'is-speaking' : ''}`, 'data-user': p.id },
          h('div', { style: { cursor: 'pointer' }, title: 'Profili görüntüle', onclick: () => window.vortexOpenUserProfile?.(p) }, avatar(p, 36, { speaking: p.speaking, online: true })),
          h('div', { class: 'raver-name', style: { cursor: 'pointer' }, onclick: () => window.vortexOpenUserProfile?.(p) },
            h('b', {}, p.name, isMe ? ' (sen)' : '', p.speaking ? h('span', { class: 'speaking-pill' }, '🎙️ Konuşuyor') : null, p.handRaised ? h('span', { class: 'speaking-pill hand-pill' }, '✋ Söz İstiyor') : null),
            p.statusText ? h('span', { style: { color: '#5eead4', fontSize: '.72rem' } }, `${p.statusEmoji || '🍿'} ${p.statusText}`) : null,
            h('span', {}, `${p.device || 'Web'}${p.muted ? ' · mikrofon kapalı' : ' · mikrofon açık'}${p.isCreator ? ' · 👑 Oda Kurucusu' : (p.isCoHost && !p.isHost ? ' · 🤝 Ortak Lider' : '')}`),
            !isMe && !isBot ? h('div', { class: 'peer-vol-row' },
              h('span', { class: 'peer-vol-lbl' }, `🔊 %${peerVol}`),
              h('input', {
                type: 'range',
                min: '0',
                max: '150',
                value: String(peerVol),
                class: 'peer-vol-slider',
                title: `${p.name} ses seviyesi`,
                oninput: (e) => {
                  const v = ctx.voice?.setPeerVolume?.(p.id, e.target.value) ?? e.target.value;
                  e.target.previousElementSibling.textContent = `🔊 %${v}`;
                },
              })) : null),
          (p.isHost || p.isCreator) ? h('span', { class: 'crown', title: p.isHost ? 'Oda Lideri' : 'Oda Kurucusu', html: icons.crown }) : null,
          !isMe && !isBot ? (() => {
            const safePUid = String(p.uid || (/^(u_wl_|guest_|u_)/i.test(String(p.id || '')) ? p.id : '') || '').trim();
            const pHandleClean = String(p.handle || '').replace(/^@+/, '').toLowerCase();
            const pTarget = safePUid || (pHandleClean ? `@${pHandleClean}` : p.name);
            const matchedFriend = (state.social?.friends || []).find((f) =>
              (safePUid && f.uid === safePUid) ||
              (pHandleClean && String(f.handle || '').replace(/^@+/, '').toLowerCase() === pHandleClean)
            );
            const matchedOutReq = (state.social?.outgoingRequests || []).find((o) =>
              (safePUid && o.toUid === safePUid) ||
              (pHandleClean && String(o.toHandle || '').replace(/^@+/, '').toLowerCase() === pHandleClean)
            );
            const resolvedTargetUid = safePUid || matchedFriend?.uid || matchedOutReq?.toUid || '';
            const isMut = friendAdded || Boolean(matchedFriend);
            const isPend = Boolean(matchedOutReq);
            return h('button', {
              type: 'button',
              class: `btn sm friend-toggle-btn ${isMut ? 'on' : ''}`,
              title: isMut ? 'Karşılıklı arkadaşsınız' : (isPend ? 'Onay bekleniyor' : 'Arkadaşlık isteği gönder'),
              onclick: async () => {
                if (isMut && resolvedTargetUid) {
                  const r = await updateFriendAction('remove', { targetUid: resolvedTargetUid });
                  if (!r?.ok) { toast(r?.error || 'Arkadaş çıkarılamadı.'); return; }
                  toast(`${p.name} arkadaş listesinden çıkarıldı`);
                } else if (isMut && !resolvedTargetUid) {
                  toast('Bu misafir kullanıcının kayıtlı hesabı bulunmuyor');
                } else if (isPend && resolvedTargetUid) {
                  const r = await updateFriendAction('cancel', { targetUid: resolvedTargetUid });
                  if (!r?.ok) { toast(r?.error || 'İstek geri çekilemedi.'); return; }
                  toast('Arkadaşlık isteği geri çekildi');
                } else {
                  const r = await sendFriendRequest(pTarget);
                  toast(r?.ok ? (r.status === 'FRIENDS' ? `🎉 ${p.name} ile artık arkadaşsınız!` : `📩 ${p.name} kişisine arkadaşlık isteği gönderildi`) : (r?.error || 'Kayıtlı kullanıcı bulunamadı'));
                }
                update();
              },
            }, isMut ? '✓ Arkadaş' : (isPend ? '⏳ İstekli' : '+ Arkadaş'));
          })() : null,
          (() => {
            const mePart = allParts.find((x) => x && x.id === state.clientId);
            const canStageCtrl = hostOnly || (m?.co_hosts || []).includes(state.clientId) || Boolean(mePart?.isCoHost);
            if (!isMe && !isBot && (hostOnly || (canStageCtrl && m?.voipMode === 'stage'))) {
              return h('div', { class: 'raver-actions' },
                hostOnly && !p.muted ? h('button', { class: 'btn sm', title: 'Mikrofonu Kapat (Sustur)', onclick: (e) => { e.stopPropagation(); ctx.actions.hostAction('mute', { targetId: p.id }); } }, '🔇') : null,
                canStageCtrl && m?.voipMode === 'stage' ? h('button', { type: 'button', 'aria-label': p.isStageSpeaker ? 'Sahneden dinleyiciye al' : 'Sahneye konuşmacı al', 'data-tip': p.isStageSpeaker ? 'Sahneden dinleyiciye al' : 'Sahneye konuşmacı al (Söz Ver)', style: { fontSize: '.85em', padding: '.2em .4em', background: p.isStageSpeaker ? 'rgba(39, 220, 200,.24)' : '' }, onclick: () => ctx.actions.toggleStageSpeaker?.(p.id) }, p.isStageSpeaker ? '🎤✓' : '✋🎤') : null,
                hostOnly ? h('button', { type: 'button', 'aria-label': p.isCoHost ? 'Ortak liderliği kaldır' : 'Ortak lider yap', 'data-tip': p.isCoHost ? 'Ortak liderliği kaldır' : 'Ortak lider (Co-Host) yap', style: { fontSize: '.85em', padding: '.2em .4em', background: p.isCoHost ? 'rgba(99, 102, 241,.22)' : '' }, onclick: () => ctx.actions.hostAction('toggle_cohost', { targetId: p.id }) }, '🤝') : null,
                hostOnly ? h('button', { type: 'button', 'aria-label': `${p.name} kişisini lider yap`, 'data-tip': 'Lider yap', onclick: () => ctx.actions.hostAction('transfer_host', { targetId: p.id }), html: icons.crown }) : null,
                hostOnly ? h('button', { type: 'button', 'aria-label': `${p.name} kişisini odadan çıkar`, 'data-tip': 'Odadan çıkar', onclick: async () => { if (await confirmPopup(`${p.name} odadan çıkarılsın mı?`, 'Çıkar', 'Vazgeç')) ctx.actions.hostAction('kick', { targetId: p.id }); }, html: icons.kick }) : null);
            }
            return null;
          })());
      }),
      overflowCount > 0 ? h('div', { class: 'dim', style: { padding: '10px 12px', textAlign: 'center', fontSize: '.82rem' } }, `+${overflowCount} diğer izleyici odada aktif (Toplam ${totalCount} kişi)`) : null);
  };
  update();
  let lastDuckPref = state.uiPrefs?.voiceDucking !== false;
  const unsub = subscribe((st) => {
    const nextDuckPref = st.uiPrefs?.voiceDucking !== false;
    if (nextDuckPref !== lastDuckPref) {
      lastDuckPref = nextDuckPref;
      update();
    }
  });
  return { el, update, destroy: () => unsub() };
}

export const PANELS = { MeshList, Settings, Vote, Friends, Globe, Participants };
