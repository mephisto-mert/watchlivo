// Side panels for Rave mesh/view: MeshList · Settings · Vote · Friends(Invite) · Globe · Participants.
import { h, icons, toast, confirmPopup, fill, openThemeModal } from '../ui.js?v=20261030_v33';
import { state, isLeader, isHostOnly, isFriend, toggleFriend, getWatchHistory, getMusicHistory } from '../store.js?v=20261030_v33';
import { avatar } from '../profile.js?v=20261030_v33';
import { clock } from '../sync.js?v=20261030_v33';
import { fetchRooms, meshThumb, thumbFor, openFriendsManagerModal } from './lobby.js?v=20261030_v33';
import { copyInvite, inviteUrl } from './chat.js?v=20261030_v33';
import { parseVideoUrl } from '../providers.js?v=20261030_v33';
import { resolveMedia } from './selection.js?v=20261030_v33';

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
  const update = () => {
    const m = state.mesh;
    if (!m || el.contains(document.activeElement)) return;
    const lead = isHostOnly();
    const sig = `${m.name}|${m.privacy}|${m.playMode}|${m.voipMode}|${m.hasPassword}|${lead}`;
    if (sig === lastSig) return;
    lastSig = sig;
    const act = (action, extra) => (lead ? ctx.actions.hostAction(action, extra) : toast('Bu ayarları yalnızca oda lideri değiştirebilir.'));
    const nameInput = h('input', { class: 'input', value: m.name, maxlength: '45', disabled: lead ? null : true, onchange: (e) => act('set_privacy', { name: e.target.value }) });
    const pwInput = h('input', { class: 'input', type: 'password', placeholder: m.hasPassword ? 'Şifre ayarlı (değiştirmek için yaz)' : 'Şifre yok', disabled: lead ? null : true, onchange: (e) => act('set_privacy', { password: e.target.value }) });
    fill(el,
      lead ? null : h('div', { class: 'sel-note' }, 'Oda ayarlarını yalnızca oda lideri değiştirebilir.'),
      h('div', { class: 'settings-group' }, h('h4', {}, 'Oda adı'), nameInput),
      h('div', { class: 'settings-group' }, h('h4', {}, 'Gizlilik'), seg([
        ['public', 'Herkese Açık', 'Herkes odaya katılabilir'], ['nearby', 'Çevremdekiler', 'Aynı ağdaki kullanıcılar görür'],
        ['friends', 'Arkadaşlar', 'Arkadaşlar odaya katılabilir'], ['private', 'Gizli', 'Yalnızca bağlantısı olanlar katılır']], m.privacy, (k) => act('set_privacy', { privacy: k }), !lead)),
      h('div', { class: 'settings-group' }, h('h4', {}, 'Oynatma'), seg([
        ['leader', 'Liderin Seçimi', 'Yalnızca lider video seçebilir'],
        ['cohost', 'Ortak Kontrol (Çift Modu)', 'Herkes oynatıp sarabilir ve seçebilir'],
        ['autoplay', 'Otomatik Oynat', 'Sıradaki videolar otomatik oynar'],
        ['quickplay', 'Hemen Oynat', 'Tek seçimle video oynar'],
        ['vote', 'Oylayalım', 'Video sırası oylamayla belirlenir']], m.playMode, (k) => act('set_privacy', { playMode: k }), !lead)),
      h('div', { class: 'settings-group' }, h('h4', {}, 'Ses'), seg([
        ['off', 'Kapalı', 'Sesli sohbet yok'], ['leader', 'Yalnızca Lider', 'Yalnızca lider konuşabilir'], ['all', 'Herkes', 'Herkes sesli sohbet yapabilir']],
        m.voipMode === 'on' ? 'all' : m.voipMode, (k) => act('set_privacy', { voipMode: k }), !lead)),
      h('div', { class: 'settings-group' }, h('h4', {}, 'Oda şifresi'), pwInput),
      h('div', { class: 'settings-group' },
        h('h4', {}, 'Görünüm & Tema'),
        h('button', { type: 'button', class: 'btn primary', style: { width: '100%' }, onclick: () => openThemeModal() }, '🎨 Görünüm & Tema Ayarları')),
      h('div', { class: 'settings-group' },
        h('h4', {}, 'Watchlivo Uygulamaları'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('a', { href: '/download/apk', download: 'Watchlivo-v1.1.0.apk', class: 'btn', style: { width: '100%', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg, rgba(99, 102, 241,.18), rgba(56,189,248,.18))', border: '1px solid rgba(99, 102, 241,.4)', color: '#6366f1', fontWeight: '700' } }, '📱 Android APK İndir (.apk)'),
          h('a', { href: '/download/windows', download: 'Watchlivo.exe', class: 'btn', style: { width: '100%', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'linear-gradient(135deg, rgba(168,85,247,.18), rgba(59,130,246,.18))', border: '1px solid rgba(168,85,247,.4)', color: '#c084fc', fontWeight: '700' } }, '💻 Windows Masaüstü İndir (.exe)')
        )
      )
    );
  };
  update();
  return { el, update };
}

function Vote(ctx) {
  const el = h('div');
  let pieTimer = null;
  const urlInput = h('input', {
    class: 'input',
    placeholder: 'YouTube, MP4, M3U8, Kick bağlantısı yapıştır...',
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
      toast('Geçerli bir video bağlantısı girin veya Katalogdan Ara\'ya tıklayın');
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
      h('button', { type: 'button', class: 'btn sm ghost', style: { flex: '1', justifyContent: 'center' }, onclick: () => ctx?.layout?.openSearch?.() }, '🔍 40.000+ Katalog & YouTube Ara')));

  const update = () => {
    if (el.contains(document.activeElement) && document.activeElement === urlInput) return;
    const m = state.mesh;
    const q = m?.queue || [];
    const mode = m?.playMode;
    const me = state.self?.name;
    const lead = isLeader();
    const maxVotes = Math.max(0, ...q.map((x) => (x.votes || []).length));
    const pie = h('div', { class: 'pie-timer', id: 'vote-pie' });
    clearInterval(pieTimer);
    const nowMs = () => clock.now() * 1000;
    if (m?.voteEndsAt && m.voteEndsAt * 1000 > nowMs()) {
      const total = 8000;
      pieTimer = setInterval(() => {
        const left = m.voteEndsAt * 1000 - nowMs();
        if (left <= 0) { clearInterval(pieTimer); pie.remove(); return; }
        pie.style.setProperty('--p', `${100 - (left / total) * 100}%`);
        pie.textContent = Math.ceil(left / 1000);
      }, 200);
    }
    const recentHistory = [...getWatchHistory().slice(0, 4), ...getMusicHistory().slice(0, 3)].slice(0, 5);
    const historyBox = recentHistory.length ? h('div', { style: { padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '6px' } },
      h('div', { style: { fontSize: '.74rem', fontWeight: '700', color: '#A0A9B8', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '.04em' } }, '🕘 Oda & İzleme Geçmişi'),
      h('div', { class: 'vote-list' }, recentHistory.map((item) => h('div', { class: 'vote-card', style: { cursor: 'default' } },
        h('img', { src: item.thumbnail || item.poster || '/static/watchlivo-poster.svg', alt: '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
        h('div', { class: 'vi' },
          h('div', { class: 'vt' }, item.songTitle || item.title || 'Video'),
          h('div', { style: { display: 'flex', gap: '4px', marginTop: '4px' } },
            h('button', { type: 'button', class: 'btn sm', style: { padding: '2px 7px', fontSize: '.7rem' }, onclick: () => ctx.actions.queueMusic(item) }, '+ Sıraya'),
            lead ? h('button', { type: 'button', class: 'btn sm primary', style: { padding: '2px 7px', fontSize: '.7rem' }, onclick: () => ctx.actions.pickMedia(item) }, '▶ Oynat') : null)))))) : null;

    fill(el,
      quickAddBox,
      h('div', { class: 'sel-note' }, mode === 'vote' ? 'Oylayalım: en çok oy alan video sıradaki olur.' : mode === 'autoplay' ? 'Otomatik Oynat: sıradaki video bitince otomatik başlar.' : mode === 'leader' ? "Liderin Seçimi: herkes sıraya video önerebilir, lider başlatır." : 'Hemen Oynat: seçilen video hemen oynar.'),
      m?.voteEndsAt && m.voteEndsAt * 1000 > nowMs() ? h('div', { style: { display: 'flex', justifyContent: 'center' } }, pie) : null,
      q.length ? h('div', { class: 'vote-list' }, q.map((item, i) => {
        const votes = (item.votes || []).length;
        return h('div', { class: `vote-card ${votes && votes === maxVotes ? 'winning' : ''} ${(item.votes || []).includes(me) ? 'voted' : ''}`, onclick: () => ctx.actions.voteVideo(i) },
          h('img', { src: thumbFor(item) || '/static/watchlivo-logo.svg', alt: '' }),
          h('div', { class: 'vi' }, h('div', { class: 'vt' }, item.title || 'Video'), h('div', { class: 'vs' }, `${item.addedBy || ''} ekledi`),
            lead ? h('div', { style: { display: 'flex', gap: '.3em', marginTop: '.35em' } },
              h('button', { class: 'btn', style: { padding: '.3em .7em', fontSize: '.75em' }, onclick: (e) => { e.stopPropagation(); ctx.actions.playQueueIndex(i); } }, 'Şimdi Oynat'),
              h('button', { class: 'btn danger', style: { padding: '.3em .7em', fontSize: '.75em' }, onclick: (e) => { e.stopPropagation(); ctx.actions.removeQueueItem(i); } }, 'Kaldır')) : null),
          votes ? h('span', { class: 'vote-counter' }, votes) : null);
      })) : h('div', { class: 'lobby-empty', style: { padding: '14px 10px' } }, 'Sıra boş. Yukarıdan bağlantı yapıştırabilir veya Katalogdan video ekleyebilirsin.'),
      (m?.skip_votes || []).length ? h('div', { class: 'sel-note' }, `Atlama oyu: ${(m.skip_votes || []).length}/${m.skipNeeded || '?'}`) : null,
      historyBox);
  };
  update();
  return { el, update, destroy: () => clearInterval(pieTimer) };
}

function Friends() {
  const url = inviteUrl();
  const roomTitle = state.mesh?.media?.title || state.mesh?.name || 'Sinema Odası';
  const sender = state.self?.name || 'Arkadaşın';
  const inviteText = `🎬 ${sender} seni Watchlivo'da "${roomTitle}" izlemeye çağırıyor! Tek tıkla odaya katıl: ${url}`;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(inviteText)}`;
  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`🎬 ${sender} seni Watchlivo'da "${roomTitle}" izlemeye çağırıyor!`)}`;
  const copyCardMsg = async () => {
    try { await navigator.clipboard.writeText(inviteText); toast('📋 Hazır davet mesajı kopyalandı!'); }
    catch (e) { copyInvite(); }
  };
  const el = h('div', { class: 'invite-panel-wrap' },
    h('div', { class: 'invite-preview-card' },
      h('div', { class: 'invite-preview-badge' }, '🎬 WATCHLIVO DAVET KARTI'),
      h('div', { class: 'invite-preview-title' }, roomTitle),
      h('div', { class: 'invite-preview-sub' }, `${sender} seni birlikte film/dizi izlemeye davet ediyor.`)),
    h('button', {
      type: 'button',
      class: 'btn primary',
      style: { width: '100%', justifyContent: 'center', gap: '6px' },
      onclick: () => openFriendsManagerModal(),
    }, '👥 + Arkadaş Ekle & Arkadaş Listem'),
    h('div', { class: 'share-box' },
      h('input', { class: 'input', value: url, readonly: true, onclick: (e) => e.target.select() }),
      h('button', { class: 'btn primary', onclick: copyInvite, 'aria-label': 'Kopyala' }, h('span', { html: icons.copy, style: { display: 'flex' } }))),
    h('div', { class: 'invite-social-grid' },
      h('a', { class: 'btn invite-social-btn wa', href: waUrl, target: '_blank', rel: 'noopener' }, '💬 WhatsApp ile Gönder'),
      h('a', { class: 'btn invite-social-btn tg', href: tgUrl, target: '_blank', rel: 'noopener' }, '✈️ Telegram ile Gönder'),
      h('button', { type: 'button', class: 'btn invite-social-btn copy-msg', onclick: copyCardMsg }, '📋 Davet Mesajını Kopyala'),
      navigator.share ? h('button', { type: 'button', class: 'btn invite-social-btn', onclick: () => navigator.share({ title: 'Watchlivo Sinema Odası', text: inviteText, url }).catch(() => {}) }, '📲 Diğer Uygulamalar') : null),
    h('img', { class: 'qr', alt: 'Davet QR kodu', src: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=${encodeURIComponent(url)}` }),
    h('div', { class: 'sel-note', style: { textAlign: 'center' } }, 'Telefon kamerasıyla QR kodu okut ve anında odaya katıl.'));
  return { el };
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
    const m = state.mesh;
    const hostOnly = isHostOnly();
    const duckOn = localStorage.getItem('vortex_voice_duck') !== 'off';
    const duckBar = h('div', { class: 'voice-duck-bar' },
      h('span', {}, '🔉 Konuşurken Filmi Otomatik Kıs'),
      h('button', {
        type: 'button',
        class: `btn sm ${duckOn ? 'primary' : ''}`,
        onclick: () => {
          const next = !duckOn;
          try { localStorage.setItem('vortex_voice_duck', next ? 'on' : 'off'); } catch (e) { /* ignore */ }
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
          avatar(p, 36, { speaking: p.speaking, online: true }),
          h('div', { class: 'raver-name' },
            h('b', {}, p.name, isMe ? ' (sen)' : '', p.speaking ? h('span', { class: 'speaking-pill' }, '🎙️ Konuşuyor') : null),
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
          !isMe && !isBot ? h('button', {
            type: 'button',
            class: `btn sm friend-toggle-btn ${friendAdded ? 'on' : ''}`,
            title: friendAdded ? 'Arkadaş listende' : 'Arkadaş olarak ekle',
            onclick: () => {
              const nowFriend = toggleFriend(p);
              toast(nowFriend ? `👥 ${p.name} arkadaşlarına eklendi` : `${p.name} arkadaşlardan çıkarıldı`);
              update();
            },
          }, friendAdded ? '✓ Arkadaş' : '+ Arkadaş') : null,
          hostOnly && !isMe && !isBot ? h('div', { class: 'raver-actions' },
            h('button', { 'data-tip': p.isCoHost ? 'Ortak liderliği kaldır' : 'Ortak lider (Co-Host) yap', style: { fontSize: '.85em', padding: '.2em .4em', background: p.isCoHost ? 'rgba(99, 102, 241,.22)' : '' }, onclick: () => ctx.actions.hostAction('toggle_cohost', { targetId: p.id }) }, '🤝'),
            h('button', { 'data-tip': 'Lider yap', onclick: () => ctx.actions.hostAction('transfer_host', { targetId: p.id }), html: icons.crown }),
            h('button', { 'data-tip': 'Odadan çıkar', onclick: async () => { if (await confirmPopup(`${p.name} odadan çıkarılsın mı?`, 'Çıkar', 'Vazgeç')) ctx.actions.hostAction('kick', { targetId: p.id }); }, html: icons.kick })) : null);
      }),
      overflowCount > 0 ? h('div', { class: 'dim', style: { padding: '10px 12px', textAlign: 'center', fontSize: '.82rem' } }, `+${overflowCount} diğer izleyici odada aktif (Toplam ${totalCount} kişi)`) : null);
  };
  update();
  return { el, update };
}

export const PANELS = { MeshList, Settings, Vote, Friends, Globe, Participants };
