// Chat panel (Rave Chat/Message/ChatBar + onboarding chat cards: invite, quick search, select privacy).
import { h, icons, fmtTime, toast, popup } from '../ui.js?v=20261030_v18';
import { state, isLeader, setView, getMusicHistory } from '../store.js?v=20261030_v18';
import { avatar } from '../profile.js?v=20261030_v18';
import { api, qs } from '../api.js?v=20261030_v18';
import { resolveMusicItem } from './selection-kinds.js?v=20261030_v18';

const REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👏', '🍿'];
const SOUNDBOARD = [
  ['clap', '👏 Alkış'],
  ['laugh', '😂 Kahkaha'],
  ['suspense', '🥁 Gerilim'],
  ['fanfare', '🎉 Zafer'],
];

let _sfxAudioCtx = null;

export function playRoomSfx(sfx) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_sfxAudioCtx || _sfxAudioCtx.state === 'closed') {
      _sfxAudioCtx = new Ctx();
    }
    const ac = _sfxAudioCtx;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const now = ac.currentTime;
    if (sfx === 'clap') {
      for (let i = 0; i < 6; i += 1) {
        const buf = ac.createBuffer(1, ac.sampleRate * 0.06, ac.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < data.length; j += 1) data[j] = (Math.random() * 2 - 1) * Math.exp(-j / (ac.sampleRate * 0.018));
        const src = ac.createBufferSource();
        const g = ac.createGain();
        g.gain.setValueAtTime(0.18, now + i * 0.075);
        src.buffer = buf;
        src.connect(g).connect(ac.destination);
        src.start(now + i * 0.075);
      }
    } else if (sfx === 'laugh') {
      [520, 480, 440, 400, 360].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.11);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.78, now + i * 0.11 + 0.09);
        g.gain.setValueAtTime(0.16, now + i * 0.11);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.095);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.11);
        osc.stop(now + i * 0.11 + 0.1);
      });
    } else if (sfx === 'suspense') {
      [110, 116.5].forEach((freq) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        g.gain.setValueAtTime(0.12, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
        osc.connect(g).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.92);
      });
    } else {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.09);
        g.gain.setValueAtTime(0.15, now + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.25);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + i * 0.09 + 0.26);
      });
    }
    setTimeout(() => ac.close().catch(() => {}), 1400);
  } catch (e) { /* ignore */ }
}
const PRIVACY = [
  ['public', 'Herkese Açık', 'globe', 'Herkes odaya katılabilir'],
  ['friends', 'Arkadaşlar', 'friends', 'Arkadaşlar odaya katılabilir'],
  ['private', 'Gizli', 'lock', 'Yalnızca davet edilenler katılabilir'],
];

export const inviteUrl = () => {
  const rid = state.mesh?.id || state.route.params.id || '';
  const base = `${location.origin}/#/mesh/${encodeURIComponent(rid)}`;
  const tok = state.mesh?.syncToken || (rid ? sessionStorage.getItem(`vortex_st_${rid}`) : '') || '';
  return tok ? `${base}?r_tok=${encodeURIComponent(tok)}` : base;
};

export async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteUrl()); toast('Paylaşım bağlantısı panoya kopyalandı'); }
  catch (e) { prompt('Davet bağlantısı', inviteUrl()); }
}

export function buildChat(ctx) {
  const { actions } = ctx;
  const list = h('div', { class: 'chat-list', id: 'chat-list' });
  const typing = h('div', { class: 'typing' });
  const input = h('input', { placeholder: 'Sohbete mesaj yazın...', maxlength: '1000', 'aria-label': 'Mesaj', id: 'chat-input' });
  const micBtn = h('button', { class: 'mic-btn off', 'aria-label': 'Mikrofon', 'data-tip': 'Mikrofon', id: 'btn-mic', onclick: () => toggleMic() }, h('span', { html: icons.micOff, style: { display: 'flex' } }));
  const camBtn = h('button', { class: 'mic-btn off', 'aria-label': 'Kamera', 'data-tip': 'Kamera Aç/Kapat', id: 'btn-cam', onclick: () => toggleCam() }, h('span', { html: icons.cameraOff, style: { display: 'flex' } }));
  const screenBtn = h('button', { class: 'mic-btn off', 'aria-label': 'Ekran Paylaş', 'data-tip': 'Ekran Yansıt', id: 'btn-screen', onclick: () => toggleScreen() }, h('span', { html: icons.screenShare, style: { display: 'flex' } }));
  const gifBtn = h('button', { class: 'ctl-action', 'aria-label': 'GIF', onclick: () => toggleGif() }, h('span', { html: icons.gif, style: { display: 'contents' } }));
  const sendBtn = h('button', { class: 'ctl-action', 'aria-label': 'Gönder', onclick: () => send() }, h('span', { html: icons.send, style: { display: 'contents' } }));
  const pollBtn = h('button', {
    type: 'button',
    class: 'sfx-pill poll-pill',
    id: 'btn-chat-poll',
    title: 'Odada Canlı Anket Başlat',
    onclick: () => openPollModal(),
  }, h('span', { html: icons.poll, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Anket');
  const clearChatBtn = h('button', {
    type: 'button',
    class: 'sfx-pill',
    id: 'btn-chat-clear',
    title: 'Oda Sohbetini Temizle (Lider)',
    onclick: () => {
      if (!isLeader()) {
        toast('⚠️ Sohbeti yalnızca oda lideri temizleyebilir');
        return;
      }
      clear();
      actions.clearChat?.();
      toast('🧹 Oda sohbeti temizlendi');
    },
  }, h('span', { html: icons.trash, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Temizle');
  const snapSceneBtn = h('button', {
    type: 'button',
    class: 'sfx-pill',
    id: 'btn-chat-snap',
    title: 'Oynatılan Sahneden Kare Yakala ve Sohbette Paylaş',
    onclick: () => {
      const cap = input.value.trim();
      const res = window.vortexCaptureSceneToChat?.(cap);
      if (res && cap) input.value = '';
    },
  }, h('span', { html: icons.cameraSnap, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Sahne');
  const stampTimeBtn = h('button', {
    type: 'button',
    class: 'sfx-pill',
    id: 'btn-chat-ts',
    title: 'Videodaki Anlık Dakika:Saniye Damgasını Mesaja Ekle',
    onclick: () => {
      const sec = Number(window.vortexGetVideoPosition?.() || 0);
      const stamp = fmtTime(sec);
      input.value = `${input.value ? input.value.trimEnd() + ' ' : ''}${stamp} `;
      input.focus();
    },
  }, h('span', { html: icons.clock, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'An');
  const reactions = h('div', { class: 'reaction-bar' },
    h('div', { class: 'reaction-emoji-grid' },
      ...REACTIONS.map((e) => h('button', { type: 'button', class: 'react-emoji-btn', onclick: () => actions.reaction(e), 'aria-label': `Tepki ${e}`, title: `Sahneye ${e} gönder` }, e))),
    h('div', { class: 'reaction-tools-row' },
      snapSceneBtn,
      stampTimeBtn,
      pollBtn,
      ...SOUNDBOARD.map(([k, lbl]) => h('button', { type: 'button', class: 'sfx-pill', onclick: () => actions.soundfx?.(k), title: `Sesli Efekt: ${lbl}` }, lbl)),
      clearChatBtn));

  const discordCallPeers = h('div', { class: 'discord-call-peers', id: 'discord-call-peers' });
  const dCallStatusBadge = h('span', { class: 'discord-call-badge', id: 'discord-call-badge' }, 'Canlı');
  const dJoinBtn = h('button', {
    type: 'button',
    class: 'discord-join-btn',
    id: 'btn-discord-call',
    onclick: () => toggleCallJoin(),
  }, h('span', { html: icons.phoneCall, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '4px' } }), 'Sesliye Katıl');
  const dSwapBtn = h('button', {
    type: 'button',
    class: 'discord-stage-btn',
    id: 'btn-discord-swap',
    title: 'Kamera Ekranlarının Yerini Değiştir',
    onclick: () => { ctx.voice?.swapCameraPositions?.(); syncVoiceUi(); },
  }, h('span', { html: icons.swap, style: { display: 'inline-flex', width: '12px', height: '12px', marginRight: '3px' } }), 'Yer Değiştir');
  const dStripBtn = h('button', {
    type: 'button',
    class: 'discord-stage-btn',
    id: 'btn-discord-strip',
    title: 'Kameraları Kanal Şeridine veya Video Köşelerine Al',
    onclick: () => { ctx.voice?.toggleStripMode?.(); syncVoiceUi(); },
  }, h('span', { html: icons.theater, style: { display: 'inline-flex', width: '12px', height: '12px', marginRight: '3px' } }), 'Şerit');
  const dStageBtn = h('button', {
    type: 'button',
    class: 'discord-stage-btn',
    id: 'btn-discord-stage',
    title: 'Kamera ve Ekran Paylaşımlarını Sahne / Izgara Görünümünde Aç',
    onclick: () => { ctx.voice?.toggleStageGrid?.(); syncVoiceUi(); },
  }, h('span', { html: icons.layoutGrid, style: { display: 'inline-flex', width: '12px', height: '12px', marginRight: '3px' } }), 'Sahne');
  const dMicPill = h('button', { type: 'button', class: 'discord-ctl-pill', id: 'btn-discord-mic', onclick: () => toggleMic() }, '🎙️ Mikrofon');
  const dDeafPill = h('button', { type: 'button', class: 'discord-ctl-pill', id: 'btn-discord-deafen', onclick: () => toggleDeafen() }, '🎧 Ses Açık');
  const dCamPill = h('button', { type: 'button', class: 'discord-ctl-pill', id: 'btn-discord-cam', onclick: () => toggleCam() }, '📷 Kamera');
  const dScreenPill = h('button', { type: 'button', class: 'discord-ctl-pill', id: 'btn-discord-screen', onclick: () => toggleScreen() }, '🖥️ Ekran Yansıt');

  const discordCallBar = h('div', { class: 'discord-call-bar', id: 'discord-call-bar' },
    h('div', { class: 'discord-call-head' },
      h('div', { class: 'discord-call-title' },
        h('span', { class: 'discord-live-dot' }),
        h('span', { html: icons.audioWave, style: { display: 'inline-flex', width: '14px', height: '14px', color: '#27DCC8' } }),
        h('span', {}, 'Ses Kanalı'),
        dCallStatusBadge),
      h('div', { class: 'discord-call-head-actions' }, dSwapBtn, dStripBtn, dStageBtn, dJoinBtn)),
    discordCallPeers,
    h('div', { class: 'discord-call-controls', id: 'discord-call-controls' },
      dMicPill, dDeafPill, dCamPill, dScreenPill));

  let musicTab = 'similar';
  let lastSimKey = '';
  let cachedSimTracks = [];
  const musicStrip = h('div', { class: 'music-similar-strip', id: 'music-similar-strip' });
  const btnTabSimilar = h('button', {
    type: 'button',
    class: 'music-tab-pill active',
    id: 'btn-music-tab-similar',
    onclick: () => { musicTab = 'similar'; syncMusicSimilarUi(true); },
  }, '✨ Benzerler');
  const btnTabRecent = h('button', {
    type: 'button',
    class: 'music-tab-pill',
    id: 'btn-music-tab-recent',
    onclick: () => { musicTab = 'recent'; syncMusicSimilarUi(true); },
  }, '🕘 Son Çalınan');
  const btnVinylToggle = h('button', {
    type: 'button',
    class: 'music-tab-pill',
    id: 'btn-music-vinyl',
    title: 'Klip / Plak Görünümü Değiştir',
    onclick: () => {
      const ad = ctx.host?.adapter;
      if (ad?.toggleVinylMode) {
        const on = ad.toggleVinylMode();
        btnVinylToggle.textContent = on ? '🎬 Klip' : '💿 Plak';
        btnVinylToggle.classList.toggle('active', on);
      } else if (ad?._setMusicVisualMode) {
        const nextVinyl = !btnVinylToggle.classList.contains('active');
        ad._setMusicVisualMode(nextVinyl ? 'vinyl' : 'clip');
        btnVinylToggle.textContent = nextVinyl ? '🎬 Klip' : '💿 Plak';
        btnVinylToggle.classList.toggle('active', nextVinyl);
      } else {
        setView('left', 'Search');
      }
    },
  }, '💿 Plak');
  const btnNextSim = h('button', {
    type: 'button',
    class: 'music-tab-pill next-sim',
    id: 'btn-music-next',
    title: 'Benzer Sıradaki Şarkıyı Aç',
    onclick: async () => {
      const pool = cachedSimTracks.length ? cachedSimTracks : getMusicHistory();
      if (!pool.length) return;
      const pickItem = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
      toast(`🎵 Benzer Şarkı Açılıyor: ${pickItem.artist} — ${pickItem.songTitle || pickItem.title}`);
      const resolved = await resolveMusicItem(pickItem);
      if (resolved) actions.pickMedia(resolved);
    },
  }, '⏭️ Benzer Aç');

  const musicSimilarBar = h('div', { class: 'music-similar-bar hidden', id: 'music-similar-bar' },
    h('div', { class: 'music-similar-head' },
      h('span', { class: 'music-similar-title', id: 'music-similar-title' }, '🎵 Diğer Müzikler'),
      h('div', { class: 'music-similar-tabs' }, btnTabSimilar, btnTabRecent, btnVinylToggle, btnNextSim)),
    musicStrip);

  const toggleRightDrawer = (tabName) => {
    const curR = state.view.right;
    setView('right', curR === tabName ? 'Collapsed' : tabName);
    ctx.layout?.update?.();
  };
  const chatLoungeHead = h('div', { class: 'chat-lounge-head' },
    h('div', { class: 'chat-lounge-brand' },
      h('span', { class: 'chat-lounge-dot' }),
      h('span', { class: 'chat-lounge-title' }, 'ODA SALONU')),
    h('div', { class: 'chat-lounge-tabs' },
      h('button', { type: 'button', class: 'chat-lounge-tab', title: 'Oynatma Sırası & Oylama', onclick: () => toggleRightDrawer('Vote') }, h('span', { html: icons.vote, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'Sıra'),
      h('button', { type: 'button', class: 'chat-lounge-tab', title: 'Odadaki Katılımcılar', onclick: () => toggleRightDrawer('Participants') }, h('span', { html: icons.users, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'Kişiler'),
      h('button', { type: 'button', class: 'chat-lounge-tab accent', title: 'Arkadaş Davet Et', onclick: () => toggleRightDrawer('Friends') }, h('span', { html: icons.addUser, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'Davet')));

  const welcomeHub = h('div', { class: 'chat-welcome-hub', id: 'chat-welcome-hub' },
    h('div', { class: 'chat-hub-top' },
      h('div', { class: 'chat-hub-badge' }, h('span', { class: 'chat-hub-pulse' }), 'CANLI SENKRON STÜDYO'),
      h('button', { type: 'button', class: 'chat-hub-close', title: 'Gizle', onclick: () => welcomeHub.remove() }, '✕')),
    h('div', { class: 'chat-hub-desc' }, 'Odadaki herkes videoyu milisaniye senkronla aynı anda izler. Hızlı oda araçları:'),
    h('div', { class: 'chat-hub-grid' },
      h('button', { type: 'button', class: 'chat-hub-action primary', onclick: () => { setView('left', 'Search'); ctx.layout?.update?.(); } },
        h('span', { class: 'hub-act-ico', html: icons.searchVideo }),
        h('span', { class: 'hub-act-txt' }, h('b', {}, 'İçerik Seç'), h('small', {}, 'Film, Dizi, Platform'))),
      h('button', { type: 'button', class: 'chat-hub-action', onclick: () => openPollModal() },
        h('span', { class: 'hub-act-ico', html: icons.poll }),
        h('span', { class: 'hub-act-txt' }, h('b', {}, 'Anket Başlat'), h('small', {}, 'Canlı Oda Oylaması'))),
      h('button', { type: 'button', class: 'chat-hub-action', onclick: () => window.vortexCaptureSceneToChat?.('') },
        h('span', { class: 'hub-act-ico', html: icons.cameraSnap }),
        h('span', { class: 'hub-act-txt' }, h('b', {}, 'Sahne Paylaş'), h('small', {}, 'Anlık Kare Gönder'))),
      h('button', { type: 'button', class: 'chat-hub-action', onclick: () => copyInvite() },
        h('span', { class: 'hub-act-ico', html: icons.link }),
        h('span', { class: 'hub-act-txt' }, h('b', {}, 'Link Kopyala'), h('small', {}, 'Arkadaşlarını Çağır')))),
    h('div', { class: 'chat-hub-keys' },
      h('span', {}, h('kbd', {}, 'Space'), ' Oynat'),
      h('span', {}, h('kbd', {}, 'T'), ' Sinema'),
      h('span', {}, h('kbd', {}, 'F'), ' Tam Ekran'),
      h('span', {}, h('kbd', {}, 'M'), ' Sessiz')));
  list.append(welcomeHub);

  const gifPanel = h('div', { class: 'gif-panel acrylic hidden' });
  const replyDraftBar = h('div', { class: 'reply-draft-bar hidden', id: 'chat-reply-draft' });
  const quickAccessZone = h('div', { class: 'chat-access-zone', id: 'chat-access-zone' });
  const bar = h('div', { class: 'chatbar' }, micBtn, camBtn, screenBtn, h('div', { class: 'chat-input' }, input, gifBtn, sendBtn), gifPanel);
  const el = h('div', { class: 'chat' }, chatLoungeHead, discordCallBar, quickAccessZone, musicSimilarBar, list, typing, reactions, replyDraftBar, bar);
  const rendered = new Set();
  let lastUser = null;
  let onboarding = false;
  let activeReply = null;

  function clearReply() {
    activeReply = null;
    replyDraftBar.classList.add('hidden');
    replyDraftBar.replaceChildren();
  }

  function setReplyTo(m) {
    if (!m || m.system) return;
    const snippet = (m.text || (m.gif ? 'GIF Gönderdi' : m.pollId ? '📊 Anket' : '')).slice(0, 110);
    activeReply = { id: m.id, user: m.user, text: snippet, color: m.color || '#6366f1' };
    replyDraftBar.replaceChildren(
      h('div', { class: 'reply-draft-info', style: { '--quote-color': activeReply.color } },
        h('span', { class: 'reply-draft-user', style: { color: activeReply.color } }, h('span', { html: icons.reply, style: { display: 'inline-flex', width: '12px', height: '12px', marginRight: '4px' } }), `${m.user} yanıtlanıyor`),
        h('span', { class: 'reply-draft-text' }, snippet)),
      h('button', { type: 'button', class: 'reply-draft-close', 'aria-label': 'Yanıtı İptal Et', onclick: () => clearReply() }, '✕'),
    );
    replyDraftBar.classList.remove('hidden');
    input.focus();
  }

  function send() {
    const v = input.value;
    if (!v.trim()) return;
    const extra = activeReply ? { replyTo: activeReply } : {};
    actions.sendChat(v, extra);
    input.value = '';
    clearReply();
    list.querySelectorAll('.sys-card').forEach((c) => c.remove());
  }
  let lastTyping = 0;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  input.addEventListener('input', () => { if (Date.now() - lastTyping > 2000) { lastTyping = Date.now(); actions.typing(); } });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      try {
        window.scrollTo(0, 0);
        document.documentElement.scrollLeft = 0;
        document.body.scrollLeft = 0;
      } catch (e) { /* ignore */ }
    }, 60);
  });

  function syncVoiceUi() {
    const v = ctx.voice;
    const micOn = Boolean(v?.micOn);
    const camOn = Boolean(v?.camOn);
    const screenOn = Boolean(v?.screenOn);
    const deafened = Boolean(v?.deafened);
    const inCall = Boolean(v?.inCall || micOn || camOn || screenOn);
    const stageOn = Boolean(v?.stageGridMode);

    micBtn.classList.toggle('on', micOn); micBtn.classList.toggle('off', !micOn);
    micBtn.replaceChildren(h('span', { html: micOn ? icons.mic : icons.micOff, style: { display: 'flex' } }));
    camBtn.classList.toggle('on', camOn); camBtn.classList.toggle('off', !camOn);
    camBtn.replaceChildren(h('span', { html: camOn ? icons.camera : icons.cameraOff, style: { display: 'flex' } }));
    screenBtn.classList.toggle('on', screenOn); screenBtn.classList.toggle('off', !screenOn);

    discordCallBar.classList.toggle('in-call', inCall);
    dJoinBtn.classList.toggle('active', inCall);
    dJoinBtn.replaceChildren(h('span', { html: inCall ? icons.phoneOff : icons.phoneCall, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '4px' } }), inCall ? 'Ayrıl' : 'Sesliye Katıl');
    dStageBtn.classList.toggle('on', stageOn);
    dStripBtn.classList.toggle('on', Boolean(v?.stripMode));
    dMicPill.classList.toggle('on', micOn);
    dMicPill.replaceChildren(h('span', { html: micOn ? icons.mic : icons.micOff, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), micOn ? 'Mikrofon' : 'Sessiz');
    dDeafPill.classList.toggle('on', deafened);
    dDeafPill.replaceChildren(h('span', { html: deafened ? icons.headphonesOff : icons.headphones, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), deafened ? 'Sağır' : 'Kulaklık');
    dCamPill.classList.toggle('on', camOn);
    dCamPill.replaceChildren(h('span', { html: camOn ? icons.camera : icons.cameraOff, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Kamera');
    dScreenPill.classList.toggle('on', screenOn);
    dScreenPill.replaceChildren(h('span', { html: icons.screenShare, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), screenOn ? 'Durdur' : 'Ekran');

    const rawParts = state.mesh?.participants || [];
    const selfId = ctx.voice?.getSelfId?.() || state.clientId || state.self?.id;
    const callPeers = rawParts.map((p) => {
      if (p.id === selfId) {
        return {
          ...p,
          muted: !micOn,
          speaking: Boolean(v?.selfSpeaking),
          cam: camOn,
          screen: screenOn,
          inCall,
          deafened,
        };
      }
      return p;
    });
    const activeVoiceCount = callPeers.filter((p) => p.inCall || !p.muted || p.cam || p.screen || p.speaking).length;
    dCallStatusBadge.textContent = activeVoiceCount > 0 ? `${activeVoiceCount} Aktif` : `${callPeers.length || 1} Odada`;
    dCallStatusBadge.classList.toggle('live', activeVoiceCount > 0);

    const shownPeers = callPeers.slice(0, 12);
    const sig = shownPeers.map((p) => `${p.id}:${p.name}:${!p.muted}:${!!p.speaking}:${!!p.cam}:${!!p.screen}:${!!p.inCall}:${!!p.deafened}`).join('|');
    if (discordCallPeers.dataset.sig !== sig) {
      discordCallPeers.dataset.sig = sig;
      discordCallPeers.replaceChildren(...shownPeers.map((p) => {
        const isAct = Boolean(p.inCall || !p.muted || p.cam || p.screen || p.speaking);
        const badges = [];
        if (p.screen) badges.push(h('span', { class: 'd-peer-badge live-screen' }, 'YAYINDA'));
        if (p.cam) badges.push(h('span', { class: 'd-peer-badge cam', html: icons.camera }));
        if (p.deafened) badges.push(h('span', { class: 'd-peer-badge deaf', html: icons.headphonesOff }));
        else if (!p.muted) badges.push(h('span', { class: 'd-peer-badge mic-on', html: icons.mic }));
        else badges.push(h('span', { class: 'd-peer-badge mic-off', html: icons.micOff }));
        const av = avatar(p, 26);
        if (p.speaking) av.classList.add('speaking');
        return h('div', {
          class: `discord-peer-chip ${isAct ? 'in-call' : ''} ${p.speaking ? 'is-speaking' : ''} ${p.screen ? 'has-screen' : ''}`.trim(),
          title: p.screen ? `${p.name} ekran paylaşıyor — sahnede büyütmek için tıkla` : `${p.name}`,
          onclick: () => {
            const targetCamId = p.id === selfId ? (screenOn ? 'self-screen' : 'self') : p.id;
            const bubble = document.querySelector(`#vortex-cam-dock [data-cam-id="${targetCamId}"]`);
            if (bubble) {
              bubble.classList.toggle('spotlight');
              document.getElementById('vortex-cam-dock')?.classList.toggle('has-spotlight', bubble.classList.contains('spotlight'));
            } else if (p.id === selfId && !inCall) {
              toggleCallJoin();
            }
          },
        }, av, h('span', { class: 'd-peer-name' }, p.name || 'Misafir'), ...badges);
      }));
    }
  }

  if (ctx.voice) {
    ctx.voice.onStateChange = () => syncVoiceUi();
  }

  async function toggleCallJoin() {
    if (!ctx.voice) return;
    const isAct = Boolean(ctx.voice.inCall || ctx.voice.micOn || ctx.voice.camOn || ctx.voice.screenOn);
    if (isAct) await ctx.voice.leaveCall();
    else await ctx.voice.joinCall({ withMic: true });
    syncVoiceUi();
  }

  function toggleDeafen() {
    ctx.voice?.toggleDeafen?.();
    syncVoiceUi();
  }

  async function toggleMic() {
    await ctx.voice?.toggleMic();
    syncVoiceUi();
  }

  async function toggleCam() {
    await ctx.voice?.toggleCamera?.();
    syncVoiceUi();
  }

  async function toggleScreen() {
    await ctx.voice?.toggleScreenShare?.();
    syncVoiceUi();
  }

  async function toggleGif() {
    if (!gifPanel.classList.contains('hidden')) { gifPanel.classList.add('hidden'); return; }
    const q = h('input', { class: 'input', placeholder: 'GIF ara...' });
    const grid = h('div', { class: 'gif-grid' });
    const load = async () => {
      grid.replaceChildren(h('div', { class: 'spinner' }));
      const res = await api(`/api/rave/gifs?${qs({ q: q.value || 'funny' })}`).catch(() => ({ gifs: [] }));
      grid.replaceChildren(...(res.gifs || []).map((g) => h('img', { src: g.preview || g.url, loading: 'lazy', alt: g.title || 'gif', onclick: () => { actions.sendChat('', { gif: g.url }); gifPanel.classList.add('hidden'); } })));
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    gifPanel.replaceChildren(q, grid);
    gifPanel.classList.remove('hidden');
    load();
  }

  function openPollModal() {
    const qIn = h('input', { class: 'input', value: 'Sıradaki ne izleyelim?', placeholder: 'Anket sorusu...' });
    const o1 = h('input', { class: 'input', value: '🎬 Bilim Kurgu / Aksiyon Filmi', placeholder: '1. Seçenek' });
    const o2 = h('input', { class: 'input', value: '😂 Komedi / Eğlence', placeholder: '2. Seçenek' });
    const o3 = h('input', { class: 'input', value: '👻 Korku / Gerilim', placeholder: '3. Seçenek (İsteğe bağlı)' });
    const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('div', { class: 'dim', style: { fontSize: '.82rem' } }, 'Odadaki herkes sohbette tek tıkla oy verebilir:'),
      qIn, o1, o2, o3);
    popup({
      title: '📊 Canlı Oda Anketi Başlat',
      content: box,
      options: [
        {
          label: 'Anketi Başlat',
          primary: true,
          onClick: () => {
            const q = qIn.value.trim();
            const opts = [o1.value.trim(), o2.value.trim(), o3.value.trim()].filter(Boolean);
            if (!q || opts.length < 2) { toast('En az bir soru ve 2 seçenek girin'); return true; }
            actions.createPoll?.(q, opts);
          },
        },
        { label: 'Vazgeç' },
      ],
    });
  }

  function buildPollWidget(pollId) {
    const wrap = h('div', { class: 'chat-poll-card', 'data-poll-id': pollId });
    fillPollWidget(wrap, pollId);
    return wrap;
  }

  function fillPollWidget(wrap, pollId) {
    const poll = (state.mesh?.polls || []).find((p) => p.id === pollId);
    if (!poll) {
      if (wrap.dataset.pollSig !== 'loading') {
        wrap.dataset.pollSig = 'loading';
        wrap.replaceChildren(h('div', { class: 'dim' }, '📊 Anket yükleniyor...'));
      }
      return;
    }
    const myName = state.self?.name || '';
    const sig = `${myName}|${poll.question}|${(poll.options || []).map((o) => `${o.text}:${(o.votes || []).join(',')}`).join(';')}`;
    if (wrap.dataset.pollSig === sig) return;
    wrap.dataset.pollSig = sig;
    const total = (poll.options || []).reduce((acc, o) => acc + (o.votes?.length || 0), 0);
    wrap.replaceChildren(
      h('div', { class: 'chat-poll-q' }, `📊 ${poll.question}`),
      h('div', { class: 'chat-poll-opts' }, ...(poll.options || []).map((opt, idx) => {
        const count = (opt.votes || []).length;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const voted = (opt.votes || []).includes(myName);
        return h('button', {
          type: 'button',
          class: `chat-poll-opt ${voted ? 'voted' : ''}`,
          onclick: () => actions.votePoll?.(poll.id, idx),
        },
          h('div', { class: 'chat-poll-bar', style: { width: `${pct}%` } }),
          h('span', { class: 'chat-poll-txt' }, `${voted ? '✓ ' : ''}${opt.text}`),
          h('span', { class: 'chat-poll-cnt' }, `${count} oy (%${pct})`));
      })),
      h('div', { class: 'chat-poll-foot' }, `Toplam ${total} oy · Oy vermek için seçeneğe tıkla`));
  }

  function renderPolls() {
    list.querySelectorAll('.chat-poll-card').forEach((elNode) => {
      fillPollWidget(elNode, elNode.dataset.pollId);
    });
  }

  const MSG_QUICK_EMOJIS = ['❤️', '😂', '🔥', '👍', '😮'];

  function spawnReactionBurst(anchorEl, emoji) {
    try {
      const rect = anchorEl?.getBoundingClientRect?.();
      if (!rect || (!rect.width && !rect.height)) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const count = 7;
      for (let i = 0; i < count; i += 1) {
        const angle = (-Math.PI / 2) + ((i - (count - 1) / 2) * 0.42) + (Math.random() - 0.5) * 0.22;
        const dist = 34 + Math.random() * 34;
        const dx = `${Math.round(Math.cos(angle) * dist)}px`;
        const dy = `${Math.round(Math.sin(angle) * dist - 14)}px`;
        const rot = `${Math.round((Math.random() - 0.5) * 55)}deg`;
        const p = h('div', {
          class: 'emoji-burst-p',
          style: {
            left: `${Math.round(cx - 9)}px`,
            top: `${Math.round(cy - 9)}px`,
            '--dx': dx,
            '--dy': dy,
            '--rot': rot,
          },
        }, emoji);
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 700);
      }
    } catch (e) { /* ignore */ }
  }

  function closeAllMsgActions(rowToClose) {
    list.querySelectorAll('.msg.msg-active').forEach((n) => n.classList.remove('msg-active'));
    if (rowToClose) {
      rowToClose.classList.remove('msg-active');
      rowToClose.classList.add('msg-closing');
      setTimeout(() => rowToClose.classList.remove('msg-closing'), 380);
    }
  }

  const onDocOutsideTap = (e) => {
    if (!e.target?.closest?.('.msg')) {
      list.querySelectorAll('.msg.msg-active').forEach((n) => n.classList.remove('msg-active'));
    }
    if (!e.target?.closest?.('.gif-panel, [aria-label="GIF"]')) {
      gifPanel.classList.add('hidden');
    }
  };
  document.addEventListener('pointerdown', onDocOutsideTap, { passive: true });

  function fillReactionBadges(wrap, msgId) {
    const msgObj = (state.mesh?.chat || []).find((x) => x.id === msgId);
    const reacts = msgObj?.reactions || {};
    const myName = state.self?.name || 'Misafir';
    const entries = Object.entries(reacts).filter(([, u]) => Array.isArray(u) && u.length > 0);
    const sig = `${myName}|${entries.map(([em, u]) => `${em}:${u.join(',')}`).join(';')}`;
    if (wrap.dataset.reactSig === sig) return;
    wrap.dataset.reactSig = sig;
    if (!entries.length) {
      wrap.replaceChildren();
      wrap.classList.add('empty');
      return;
    }
    wrap.classList.remove('empty');
    wrap.replaceChildren(...entries.map(([em, users]) => {
      const mine = users.includes(myName);
      return h('button', {
        type: 'button',
        class: `msg-react-pill ${mine ? 'mine' : ''}`,
        title: users.join(', '),
        onclick: (e) => {
          e.stopPropagation();
          spawnReactionBurst(e.currentTarget, em);
          closeAllMsgActions(e.currentTarget.closest('.msg'));
          actions.reactMessage?.(msgId, em);
        },
      }, h('span', { class: 'em-ico' }, em), h('span', { class: 'cnt' }, String(users.length)));
    }));
  }

  function renderReactions() {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    list.querySelectorAll('.msg-reactions').forEach((node) => {
      fillReactionBadges(node, node.dataset.reactFor);
    });
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function buildQuoteBlock(rep) {
    if (!rep) return null;
    const obj = typeof rep === 'object' ? rep : { id: '', user: 'Mesaj', text: String(rep), color: '#6366f1' };
    if (!obj.user && !obj.text) return null;
    return h('div', {
      class: 'msg-quote',
      style: { '--quote-color': obj.color || '#6366f1' },
      onclick: (e) => {
        e.stopPropagation();
        if (!obj.id) return;
        const target = list.querySelector(`.msg[data-id="${obj.id}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('msg-highlight');
          setTimeout(() => target.classList.remove('msg-highlight'), 1600);
        }
      },
    },
      h('span', { class: 'msg-quote-user', style: { color: obj.color || '#6366f1' } }, obj.user || 'Alıntı'),
      h('span', { class: 'msg-quote-text' }, obj.text || ''));
  }

  function parseStampToSec(stamp) {
    const parts = String(stamp || '').split(':').map((x) => Number(x));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function renderRichMessageText(rawText) {
    const text = String(rawText || '');
    if (!text) return [];
    const re = /\b((?:\d{1,2}:)?\d{1,2}:\d{2})\b/g;
    const out = [];
    let lastIdx = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIdx) {
        out.push(text.slice(lastIdx, match.index));
      }
      const stamp = match[1];
      const sec = parseStampToSec(stamp);
      if (sec !== null) {
        out.push(h('button', {
          type: 'button',
          class: 'chat-ts-badge',
          title: `${stamp} sahnesine git`,
          onclick: (e) => {
            e.stopPropagation();
            window.vortexSeekToTimestamp?.(sec);
          },
        }, `⏱️ ${stamp}`));
      } else {
        out.push(stamp);
      }
      lastIdx = re.lastIndex;
    }
    if (lastIdx < text.length) {
      out.push(text.slice(lastIdx));
    }
    return out;
  }

  function buildSnapshotWidget(m) {
    if (!m?.snapshot) return null;
    const hasTime = Number.isFinite(Number(m.videoTime)) && Number(m.videoTime) >= 0;
    const sec = hasTime ? Math.round(Number(m.videoTime)) : null;
    return h('div', {
      class: 'chat-snapshot-card',
      onclick: (e) => {
        e.stopPropagation();
        if (sec !== null) window.vortexSeekToTimestamp?.(sec);
      },
    },
      h('img', { class: 'chat-snapshot-img', src: m.snapshot, alt: 'Sahne', loading: 'lazy' }),
      sec !== null
        ? h('button', {
            type: 'button',
            class: 'chat-snapshot-time',
            onclick: (e) => {
              e.stopPropagation();
              window.vortexSeekToTimestamp?.(sec);
            },
          }, `▶ ${fmtTime(sec)} Sahnesine Git`)
        : null);
  }

  function msgNode(m) {
    if (m.system) {
      const t = h('div', { class: 'sysmsg' });
      if (m.user) t.append(h('b', {}, m.user), ' ');
      t.append(m.text || '');
      return t;
    }
    const cont = lastUser === m.user && !m.pollId && !m.replyTo && !m.snapshot;
    lastUser = (m.pollId || m.snapshot) ? null : m.user;
    const reactWrap = h('div', { class: 'msg-reactions empty', 'data-react-for': m.id });
    fillReactionBadges(reactWrap, m.id);
    let row = null;
    const actionBar = h('div', { class: 'msg-actions' },
      ...MSG_QUICK_EMOJIS.map((em, idx) => h('button', {
        type: 'button',
        class: 'msg-act-emoji',
        style: { '--i': String(idx) },
        title: `İfade bırak: ${em}`,
        onclick: (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          spawnReactionBurst(btn, em);
          btn.blur?.();
          closeAllMsgActions(row);
          actions.reactMessage?.(m.id, em);
        },
      }, em)),
      h('button', {
        type: 'button',
        class: 'msg-act-reply',
        style: { '--i': String(MSG_QUICK_EMOJIS.length) },
        title: 'Bu mesajı yanıtla',
        onclick: (e) => {
          e.stopPropagation();
          e.currentTarget?.blur?.();
          closeAllMsgActions(row);
          setReplyTo(m);
        },
      }, h('span', { html: icons.reply, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'Yanıtla'));

    row = h('div', {
      class: `msg ${cont ? 'cont' : ''}`,
      'data-id': m.id,
      onmouseleave: () => row.classList.remove('msg-closing'),
      onclick: (e) => {
        if (e.target.closest('button, a, .chat-poll-card, .chat-snapshot-card, .msg-actions, .msg-reactions')) return;
        const wasOpen = row.classList.contains('msg-active');
        list.querySelectorAll('.msg.msg-active').forEach((n) => n.classList.remove('msg-active'));
        row.classList.remove('msg-closing');
        if (!wasOpen) row.classList.add('msg-active');
      },
    },
      avatar({ name: m.user, color: m.color }, 30),
      h('div', { class: 'msg-body' },
        h('div', { class: 'msg-head-row' },
          h('div', { class: 'msg-name' }, h('span', { style: { color: m.color } }, m.user), h('time', {}, m.time || '')),
          actionBar),
        buildQuoteBlock(m.replyTo),
        m.pollId
          ? buildPollWidget(m.pollId)
          : h('div', { class: 'msg-text' },
              ...renderRichMessageText(m.text || ''),
              buildSnapshotWidget(m),
              m.gif ? h('img', { class: 'gif', src: m.gif, alt: 'gif', loading: 'lazy' }) : null),
        reactWrap));
    return row;
  }

  function append(m) {
    if (!m || rendered.has(m.id)) return;
    if (m.system && m.user) {
      const joinKey = `join:${m.user}`;
      if (m.text === 'katıldı') {
        if (rendered.has(joinKey)) return;
        rendered.add(joinKey);
      } else if (m.text === 'ayrıldı') {
        rendered.delete(joinKey);
      }
    }
    rendered.add(m.id);
    if (m.system) lastUser = null;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(msgNode(m));
    while (list.children.length > 120) {
      list.firstElementChild?.remove();
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function quickRoomBar() {
    const cur = state.mesh?.privacy || 'public';
    const url = inviteUrl();
    const roomTitle = state.mesh?.media?.title || state.mesh?.name || 'Sinema Odası';
    const sender = state.self?.name || 'Arkadaşın';
    const waUrl = `https://wa.me/?text=${encodeURIComponent(`🎬 ${sender} seni Watchlivo'da "${roomTitle}" izlemeye çağırıyor! Katıl: ${url}`)}`;
    let barEl = null;
    barEl = h('div', { class: 'chat-quick-bar', id: 'privacy-card' },
      h('div', { class: 'chat-quick-pills' },
        h('button', { type: 'button', class: 'chat-q-pill primary', onclick: copyInvite, title: 'Davet bağlantısını kopyala' }, h('span', { html: icons.link, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'Davet Linki'),
        h('a', { class: 'chat-q-pill', href: waUrl, target: '_blank', rel: 'noopener', title: 'WhatsApp ile davet et' }, h('span', { html: icons.share, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'WhatsApp'),
        h('button', { type: 'button', class: 'chat-q-pill', onclick: () => { setView('right', 'Friends'); ctx.layout.update(); }, title: 'Davet Kartı & QR' }, h('span', { html: icons.qr, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'QR')),
      h('div', { class: 'chat-access-seg' },
        ...PRIVACY.map(([k, label, ic, desc]) => h('button', {
          type: 'button',
          class: `chat-q-pill privacy-opt ${cur === k ? 'on' : ''}`,
          title: desc,
          'data-privacy': k,
          onclick: () => {
            if (!isLeader()) { toast('Bu ayarı yalnızca oda lideri değiştirebilir'); return; }
            actions.hostAction('set_privacy', { privacy: k });
          },
        }, h('span', { html: icons[ic], style: { display: 'flex', width: '12px', height: '12px' } }), label))),
      h('button', { type: 'button', class: 'chat-q-close', 'aria-label': 'Kapat', onclick: () => barEl.remove() }, '✕'));
    return barEl;
  }

  function renderMusicStripItems(items) {
    musicStrip.replaceChildren(...(items || []).slice(0, 14).map((it) => {
      const chip = h('div', {
        class: 'music-sim-chip',
        role: 'button',
        tabindex: '0',
        title: `${it.artist || ''} — ${it.songTitle || it.title} (Klip Oynat)`,
        onclick: async () => {
          toast(`🎵 Klip Açılıyor: ${it.artist ? it.artist + ' — ' : ''}${it.songTitle || it.title}`);
          const resolved = await resolveMusicItem(it);
          if (resolved) actions.pickMedia(resolved);
        },
      },
        h('img', { src: it.poster || it.thumbnail || '/static/watchlivo-poster.svg', alt: '', onerror: (e) => { e.target.src = '/static/watchlivo-poster.svg'; } }),
        h('div', { class: 'music-sim-meta' },
          h('span', { class: 'music-sim-song' }, it.songTitle || it.title),
          h('span', { class: 'music-sim-artist' }, it.artist || 'Sanatçı')),
        h('button', {
          type: 'button',
          class: 'music-sim-add',
          title: 'Sıraya Ekle',
          onclick: async (e) => {
            e.stopPropagation();
            const resolved = await resolveMusicItem(it);
            if (resolved) actions.queueMusic?.(resolved);
          },
        }, '+'));
      return chip;
    }));
  }

  function syncMusicSimilarUi(force = false) {
    const curMedia = state.mesh?.media;
    const isMusicActive = Boolean(
      curMedia?.isMusic ||
      ['music', 'ytmusic', 'spotify', 'deezer', 'applemusic', 'soundcloud'].includes(curMedia?.catalogProvider || curMedia?.provider),
    );
    musicSimilarBar.classList.toggle('hidden', !isMusicActive);
    if (!isMusicActive) return;
    btnTabSimilar.classList.toggle('active', musicTab === 'similar');
    btnTabRecent.classList.toggle('active', musicTab === 'recent');
    const recentList = getMusicHistory();
    const seedArtist = (curMedia?.isMusic && curMedia?.artist) ? curMedia.artist : (recentList[0]?.artist || 'Semicenk');
    const seedTitle = (curMedia?.isMusic && curMedia?.songTitle) ? curMedia.songTitle : (recentList[0]?.songTitle || 'Çıkmaz Bir Sokakta');
    const titleEl = musicSimilarBar.querySelector('#music-similar-title');
    if (titleEl) {
      titleEl.textContent = musicTab === 'recent' ? '🕘 Son Çalınanlar' : `🎵 Diğer Müzikler (${seedArtist} Mix)`;
    }
    if (musicTab === 'recent') {
      renderMusicStripItems(recentList);
      return;
    }
    if (Array.isArray(curMedia?.similar) && curMedia.similar.length) {
      cachedSimTracks = curMedia.similar;
      window.__kinoxCachedSimilar = cachedSimTracks;
    }
    const sig = `${seedArtist}|${seedTitle}|${musicTab}`;
    if (!force && sig === lastSimKey && musicStrip.children.length > 0) return;
    lastSimKey = sig;
    if (cachedSimTracks.length && curMedia?.artist === seedArtist) {
      renderMusicStripItems(cachedSimTracks);
      return;
    }
    api(`/api/rave/music-similar?${qs({ artist: seedArtist, title: seedTitle })}`, { timeout: 8000 })
      .then((res) => {
        if (res?.items?.length) {
          cachedSimTracks = res.items;
          window.__kinoxCachedSimilar = cachedSimTracks;
          if (musicTab === 'similar') renderMusicStripItems(cachedSimTracks);
        } else if (musicTab === 'similar') {
          renderMusicStripItems(recentList);
        }
      })
      .catch(() => { if (musicTab === 'similar') renderMusicStripItems(recentList); });
  }

  function clear() {
    rendered.clear();
    lastUser = null;
    list.querySelectorAll('.msg, .sysmsg, .chat-msg, .chat-sys, .chat-poll-card').forEach((n) => n.remove());
  }

  const onVisualViewportResize = () => {
    if (!window.visualViewport) return;
    document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
    list.scrollTop = list.scrollHeight;
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onVisualViewportResize);
    window.visualViewport.addEventListener('scroll', onVisualViewportResize);
    onVisualViewportResize();
  }

  let typingTimer = null;
  setTimeout(() => { syncVoiceUi(); syncMusicSimilarUi(true); }, 0);
  return {
    el,
    append,
    clear,
    renderPolls,
    renderReactions,
    syncVoiceUi,
    update() {
      if (ctx.voice && !ctx.voice.onStateChange) {
        ctx.voice.onStateChange = () => syncVoiceUi();
      }
      syncVoiceUi();
      syncMusicSimilarUi();
      const chatArr = state.mesh?.chat || [];
      if (chatArr.length === 0 && rendered.size > 0) {
        clear();
      }
      for (const m of chatArr) append(m);
      renderPolls();
      renderReactions();
      if (!onboarding && state.mesh) {
        onboarding = true;
        quickAccessZone.replaceChildren(quickRoomBar());
      }
      const card = el.querySelector('#privacy-card');
      if (card) {
        const cur = state.mesh?.privacy || 'public';
        card.querySelectorAll('.privacy-opt').forEach((btn) => {
          btn.classList.toggle('on', btn.dataset.privacy === cur);
        });
      }
    },
    showOnboarding() {
      if (onboarding) return;
      onboarding = true;
      quickAccessZone.replaceChildren(quickRoomBar());
    },
    showTyping(user) {
      if (!user || user === state.self?.name) return;
      typing.textContent = `${user} yazıyor…`;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typing.textContent = ''; }, 2500);
    },
    setMicLevel(lvl) {
      const n = Math.max(0, Math.min(1, Number(lvl || 0)));
      micBtn.classList.toggle('speaking', n > 0.08);
      micBtn.style.setProperty('--mic-lvl', n.toFixed(2));
      dMicPill.classList.toggle('speaking', n > 0.08);
      dMicPill.style.setProperty('--mic-lvl', n.toFixed(2));
    },
    destroy() {
      clearTimeout(typingTimer);
      document.removeEventListener('pointerdown', onDocOutsideTap);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onVisualViewportResize);
        window.visualViewport.removeEventListener('scroll', onVisualViewportResize);
      }
    },
  };
}
