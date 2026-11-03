// Chat panel (Rave Chat/Message/ChatBar + onboarding chat cards: invite, quick search, select privacy).
import { h, icons, fmtTime, toast, popup } from '../ui.js?v=20261103_v80';
import { state, isLeader, setView, getMusicHistory } from '../store.js?v=20261103_v80';
import { avatar } from '../profile.js?v=20261103_v80';
import { api, qs } from '../api.js?v=20261103_v80';
import { resolveMusicItem } from './selection-kinds.js?v=20261103_v80';

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
  } catch (e) { /* ignore */ }
}

export function playEmojiSfx(emoji) {
  try {
    if (emoji === '👏') { playRoomSfx('clap'); return; }
    if (emoji === '😂') { playRoomSfx('laugh'); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_sfxAudioCtx || _sfxAudioCtx.state === 'closed') {
      _sfxAudioCtx = new Ctx();
    }
    const ac = _sfxAudioCtx;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const now = ac.currentTime;
    if (emoji === '❤️') {
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.065);
        g.gain.setValueAtTime(0.14, now + i * 0.065);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.065 + 0.22);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.065);
        osc.stop(now + i * 0.065 + 0.24);
      });
    } else if (emoji === '😮') {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(310, now);
      osc.frequency.exponentialRampToValueAtTime(720, now + 0.26);
      g.gain.setValueAtTime(0.15, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(g).connect(ac.destination);
      osc.start(now);
      osc.stop(now + 0.32);
    } else if (emoji === '😢') {
      [440, 392, 329.63].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.12);
        g.gain.setValueAtTime(0.12, now + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.22);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.24);
      });
    } else if (emoji === '🔥') {
      [587.33, 880, 1174.66].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + i * 0.05);
        g.gain.setValueAtTime(0.09, now + i * 0.05);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 0.16);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.05);
        osc.stop(now + i * 0.05 + 0.18);
      });
    } else if (emoji === '☕') {
      [587.33, 880, 1046.5].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.085);
        g.gain.setValueAtTime(0.16, now + i * 0.085);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.085 + 0.22);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.085);
        osc.stop(now + i * 0.085 + 0.24);
      });
    } else {
      [640, 920].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.055);
        g.gain.setValueAtTime(0.15, now + i * 0.055);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.055 + 0.09);
        osc.connect(g).connect(ac.destination);
        osc.start(now + i * 0.055);
        osc.stop(now + i * 0.055 + 0.1);
      });
    }
  } catch (e) { /* ignore */ }
}
const PRIVACY = [
  ['public', 'Herkese Açık', 'globe', 'Herkes odaya katılabilir'],
  ['friends', 'Arkadaşlar', 'friends', 'Arkadaşlar odaya katılabilir'],
  ['private', 'Gizli', 'lock', 'Yalnızca davet edilenler katılabilir'],
];

export const inviteUrl = () => {
  const rid = state.mesh?.id || state.route.params.id || '';
  return `${location.origin}/r/${encodeURIComponent(rid)}`;
};

export async function copyInvite() {
  const url = inviteUrl();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      toast('Paylaşım bağlantısı panoya kopyalandı');
      return;
    }
  } catch (e) { /* fallback below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand('copy');
    ta.remove();
    if (copied) {
      toast('Paylaşım bağlantısı panoya kopyalandı');
      return;
    }
  } catch (e) { /* fallback below */ }
  prompt('Davet bağlantısı', url);
}

export function buildChat(ctx) {
  const { actions } = ctx;
  const list = h('div', { class: 'chat-list', id: 'chat-list' });
  const typing = h('div', { class: 'typing' });
  const input = h('input', { placeholder: 'Sohbete mesaj yazın...', maxlength: '1000', enterkeyhint: 'send', autocomplete: 'off', 'aria-label': 'Mesaj', id: 'chat-input' });
  const micBtn = h('button', { class: 'mic-btn off', 'aria-label': 'Mikrofon', 'data-tip': 'Mikrofon', id: 'btn-mic', onclick: () => toggleMic() }, h('span', { html: icons.micOff, style: { display: 'flex' } }));
  const camBtn = h('button', { class: 'mic-btn off', 'aria-label': 'Kamera', 'data-tip': 'Kamera Aç/Kapat', id: 'btn-cam', onclick: () => toggleCam() }, h('span', { html: icons.cameraOff, style: { display: 'flex' } }));
  const screenBtn = h('button', { class: 'mic-btn off', 'aria-label': 'Ekran Paylaş', 'data-tip': 'Ekran Yansıt', id: 'btn-screen', onclick: () => toggleScreen() }, h('span', { html: icons.screenShare, style: { display: 'flex' } }));
  const gifBtn = h('button', { type: 'button', class: 'ctl-action', 'aria-label': 'GIF', onclick: () => toggleGif() }, h('span', { html: icons.gif, style: { display: 'contents' } }));
  const sendBtn = h('button', {
    type: 'button',
    class: 'ctl-action',
    id: 'btn-chat-send',
    'aria-label': 'Gönder',
    onpointerdown: (e) => { e.preventDefault(); send(); },
    onclick: () => send(),
  }, h('span', { html: icons.send, style: { display: 'contents' } }));
  let toolsPopover = null;
  let toolsBtn = null;
  const closeToolsPopover = () => {
    toolsPopover?.classList.add('hidden');
    toolsBtn?.classList.remove('active');
  };
  const pollBtn = h('button', {
    type: 'button',
    class: 'sfx-pill poll-pill',
    id: 'btn-chat-poll',
    title: 'Odada Canlı Anket Başlat',
    onclick: () => { closeToolsPopover(); openPollModal(); },
  }, h('span', { html: icons.poll, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Anket');
  const clearChatBtn = h('button', {
    type: 'button',
    class: 'sfx-pill',
    id: 'btn-chat-clear',
    title: 'Oda Sohbetini Temizle (Lider)',
    onclick: () => {
      closeToolsPopover();
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
      closeToolsPopover();
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
      closeToolsPopover();
      const sec = Number(window.vortexGetVideoPosition?.() || 0);
      const stamp = fmtTime(sec);
      input.value = `${input.value ? input.value.trimEnd() + ' ' : ''}${stamp} `;
      input.focus();
    },
  }, h('span', { html: icons.clock, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'An');
  const breakBarBtn = h('button', {
    type: 'button',
    class: 'react-break-btn',
    id: 'btn-chat-break',
    'aria-label': 'Mola Zamanı',
    title: 'Mola (duraklatma) isteği gönder veya odayı duraklat',
    onclick: () => {
      if (state.mesh?.curated) {
        toast('7/24 canlı TV yayını duraklatılamaz');
        return;
      }
      if (isLeader()) {
        actions.pause?.();
        toast('☕ Mola verildi — video duraklatıldı');
        return;
      }
      actions.requestBreak?.();
    },
  }, '☕ Mola Zamanı');
  const reactions = h('div', { class: 'reaction-bar' },
    h('div', { class: 'reaction-emoji-grid' },
      ...REACTIONS.map((e) => h('button', {
        type: 'button',
        class: 'react-emoji-btn',
        onclick: (ev) => {
          spawnReactionBurst(ev.currentTarget, e);
          spawnEmojiFountain(ev.currentTarget, e);
          actions.reaction(e);
        },
        'aria-label': `Tepki ${e}`,
        title: `Sahneye ${e} gönder`,
      }, e)),
      breakBarBtn));

  toolsPopover = h('div', { class: 'chat-tools-popover acrylic hidden', id: 'chat-tools-popover' },
    h('div', { class: 'chat-tools-sec-title' }, '⚡ Oda Araçları & Hızlı Paylaşım'),
    h('div', { class: 'reaction-tools-row' }, snapSceneBtn, stampTimeBtn, pollBtn, clearChatBtn),
    h('div', { class: 'chat-tools-sec-title' }, '🔊 Ses Efektleri (Soundboard)'),
    h('div', { class: 'reaction-tools-row' },
      ...SOUNDBOARD.map(([k, lbl]) => h('button', {
        type: 'button',
        class: 'sfx-pill',
        onclick: () => { actions.soundfx?.(k); closeToolsPopover(); },
        title: `Sesli Efekt: ${lbl}`,
      }, lbl))));

  toolsBtn = h('button', {
    type: 'button',
    class: 'ctl-action chat-tools-toggle',
    id: 'btn-chat-tools',
    'aria-label': 'Oda Araçları ve Ses Efektleri',
    title: 'Oda Araçları: Anket, Sahne Paylaş, Saniye Ekle & Ses Efektleri (+)',
    onclick: (e) => {
      e.stopPropagation();
      gifPanel.classList.add('hidden');
      const isHidden = toolsPopover.classList.toggle('hidden');
      toolsBtn.classList.toggle('active', !isHidden);
    },
  }, h('span', { html: icons.plus, style: { display: 'contents' } }));

  const discordCallPeers = h('div', { class: 'discord-call-peers', id: 'discord-call-peers' });
  const dCallStatusBadge = h('span', { class: 'discord-call-badge', id: 'discord-call-badge' }, 'Canlı');
  const dJoinBtn = h('button', {
    type: 'button',
    class: 'discord-join-btn',
    id: 'btn-discord-call',
    onclick: () => toggleCallJoin(),
  }, h('span', { html: icons.phoneCall, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '4px' } }), 'Sesliye Katıl');
  const dHeadCamBtn = h('button', {
    type: 'button',
    class: 'discord-stage-btn head-cam-btn',
    id: 'btn-discord-head-cam',
    title: 'Kamerayı Aç / Kapat (Yuvarlak Görüntülü Sohbet Baloncuğu)',
    onclick: () => toggleCam(),
  }, h('span', { html: icons.camera, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Kamera');
  const dShareQuickBtn = h('button', {
    type: 'button',
    class: 'discord-stage-btn share-toggle-btn',
    id: 'btn-discord-share-toggle',
    title: 'Hızlı Davet Linki, WhatsApp, QR & Oda Gizliliği',
    onclick: () => {
      const hiddenNow = quickAccessZone.classList.toggle('hidden');
      dShareQuickBtn.classList.toggle('on', !hiddenNow);
    },
  }, h('span', { html: icons.share, style: { display: 'inline-flex', width: '12px', height: '12px', marginRight: '3px' } }), 'Paylaş');
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
  const dStageMicPill = h('button', {
    type: 'button',
    class: 'discord-ctl-pill stage-mic-pill',
    id: 'btn-discord-stage-mic',
    onclick: () => {
      if (isLeader()) actions.toggleStageMode?.();
      else actions.raiseHand?.();
    },
  }, '🎤 Sahne');

  const discordCallBar = h('div', { class: 'discord-call-bar', id: 'discord-call-bar' },
    h('div', { class: 'discord-call-head' },
      h('div', { class: 'discord-call-title' },
        h('span', { class: 'discord-live-dot' }),
        h('span', { html: icons.audioWave, style: { display: 'inline-flex', width: '14px', height: '14px', color: '#27DCC8' } }),
        h('span', {}, 'Ses Kanalı'),
        dCallStatusBadge),
      h('div', { class: 'discord-call-head-actions' }, dSwapBtn, dStripBtn, dStageBtn, dShareQuickBtn, dHeadCamBtn, dJoinBtn)),
    discordCallPeers,
    h('div', { class: 'discord-call-controls', id: 'discord-call-controls' },
      dMicPill, dDeafPill, dCamPill, dScreenPill, dStageMicPill));

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

  const gifPanel = h('div', { class: 'gif-panel acrylic hidden' });
  const replyDraftBar = h('div', { class: 'reply-draft-bar hidden', id: 'chat-reply-draft' });
  const quickAccessZone = h('div', { class: 'chat-access-zone hidden', id: 'chat-access-zone' });
  let voiceRecState = null;
  const voiceRecOverlay = h('div', { class: 'voice-rec-overlay hidden', id: 'chat-voice-rec-overlay' });
  const voiceRecBtn = h('button', {
    type: 'button',
    class: 'ctl-action voice-note-btn',
    id: 'btn-chat-voice-rec',
    'aria-label': 'Sesli Mesaj Gönder',
    title: 'Sesli Mesaj Kaydet (Tıkla Başlat / Gönder)',
    onclick: () => toggleVoiceNoteRecording(),
  }, h('span', { html: icons.mic, style: { display: 'contents' } }));
  const bar = h('div', { class: 'chatbar' }, h('div', { class: 'chat-input' }, toolsBtn, input, voiceRecOverlay, voiceRecBtn, gifBtn, sendBtn), toolsPopover, gifPanel);
  const el = h('div', { class: 'chat' }, discordCallBar, quickAccessZone, musicSimilarBar, list, typing, reactions, replyDraftBar, bar);
  const rendered = new Set();
  let lastUser = null;
  let onboarding = false;
  let activeReply = null;

  function clearReply() {
    activeReply = null;
    replyDraftBar.classList.add('hidden');
    replyDraftBar.replaceChildren();
  }

  function stopVoiceRecorder(sendIt = false) {
    const st = voiceRecState;
    if (!st) return;
    voiceRecState = null;
    clearInterval(st.timer);
    voiceRecBtn.classList.remove('recording');
    voiceRecOverlay.classList.add('hidden');
    input.classList.remove('hidden');
    st.shouldSend = Boolean(sendIt);
    try { if (st.rec && st.rec.state !== 'inactive') st.rec.stop(); } catch (e) { /* ignore */ }
    try { st.stream?.getTracks?.().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { st.ac?.close?.(); } catch (e) { /* ignore */ }
  }

  async function toggleVoiceNoteRecording() {
    if (voiceRecState) {
      stopVoiceRecorder(true);
      return;
    }
    window.vortexStopActiveVoiceNote?.();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('Tarayıcınız sesli mesaj kaydını desteklemiyor');
      return;
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      toast('Sesli mesaj için mikrofon izni gerekli');
      return;
    }
    const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
    const mimeType = mimeCandidates.find((m) => !m || MediaRecorder.isTypeSupported?.(m)) || '';
    const chunks = [];
    const peaks = [];
    const startedAt = Date.now();
    let ac = null;
    let analyser = null;
    let freqBuf = null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        ac = new Ctx();
        const srcNode = ac.createMediaStreamSource(stream);
        analyser = ac.createAnalyser();
        analyser.fftSize = 64;
        srcNode.connect(analyser);
        freqBuf = new Uint8Array(analyser.frequencyBinCount);
      }
    } catch (e) { /* ignore */ }
    const recOpts = mimeType ? { mimeType, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 };
    const rec = new MediaRecorder(stream, recOpts);
    const stObj = { rec, stream, ac, timer: null, shouldSend: false };
    voiceRecState = stObj;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
    rec.onstop = () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      if (!stObj.shouldSend || !chunks.length) return;
      const durSec = Math.max(0.8, Math.min(25, (Date.now() - startedAt) / 1000));
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
      if (blob.size > 280000) {
        toast('Ses kaydı çok uzun — en fazla 25 saniye gönderilebilir');
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl.startsWith('data:audio/')) return;
        const normPeaks = peaks.length >= 6 ? peaks.slice(-24) : [0.28, 0.62, 0.84, 0.46, 0.72, 0.54, 0.88, 0.4, 0.66, 0.5];
        const extra = { audioNote: { dataUrl, duration: Number(durSec.toFixed(1)), peaks: normPeaks } };
        if (activeReply) extra.replyTo = activeReply;
        actions.sendChat('', extra);
        clearReply();
      };
      reader.readAsDataURL(blob);
    };
    const timerLbl = h('span', { class: 'voice-rec-timer' }, '🔴 0:00');
    const cancelBtn = h('button', { type: 'button', class: 'voice-rec-cancel', onclick: (e) => { e.stopPropagation(); stopVoiceRecorder(false); } }, 'İptal');
    const doneBtn = h('button', { type: 'button', class: 'voice-rec-send', onclick: (e) => { e.stopPropagation(); stopVoiceRecorder(true); } }, 'Gönder ➤');
    voiceRecOverlay.replaceChildren(timerLbl, cancelBtn, doneBtn);
    input.classList.add('hidden');
    voiceRecOverlay.classList.remove('hidden');
    voiceRecBtn.classList.add('recording');
    rec.start(250);
    stObj.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      timerLbl.textContent = `🔴 0:${String(elapsed).padStart(2, '0')}`;
      if (analyser && freqBuf) {
        analyser.getByteFrequencyData(freqBuf);
        const avg = freqBuf.reduce((a, b) => a + b, 0) / Math.max(1, freqBuf.length);
        peaks.push(Number(Math.max(0.1, Math.min(1, avg / 140)).toFixed(2)));
      } else {
        peaks.push(Number((0.25 + Math.random() * 0.6).toFixed(2)));
      }
      if (elapsed >= 24) stopVoiceRecorder(true);
    }, 350);
  }

  function setReplyTo(m) {
    if (!m || m.system) return;
    const fallbackKind = m.audioNote
      ? `🎙️ Sesli Mesaj (${Math.max(1, Math.round(Number(m.audioNote.duration || 1)))}sn)`
      : m.snapshot ? '📸 Sahne Karesi' : m.gif ? 'GIF Gönderdi' : m.pollId ? '📊 Anket' : '';
    const snippet = (m.text || fallbackKind).slice(0, 110);
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

  let lastSendAt = 0;
  function send() {
    const nowMs = Date.now();
    if (nowMs - lastSendAt < 80) return;
    const v = input.value;
    if (!v.trim()) return;
    lastSendAt = nowMs;
    const extra = activeReply ? { replyTo: activeReply } : {};
    actions.sendChat(v, extra);
    input.value = '';
    clearReply();
    list.querySelectorAll('.sys-card').forEach((c) => c.remove());
  }
  let lastTyping = 0;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => { if (Date.now() - lastTyping > 2000) { lastTyping = Date.now(); actions.typing(); } });
  const isVirtualKbDevice = () => Boolean(
    (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && typeof window !== 'undefined' && window.innerWidth <= 960 && !window.matchMedia?.('(pointer: fine)')?.matches)
  );
  input.addEventListener('focus', () => {
    if (isVirtualKbDevice()) document.body.classList.add('kb-open');
    try { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) { /* ignore */ }
    setTimeout(() => {
      try { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) { /* ignore */ }
      if (typeof onVisualViewportResize === 'function') onVisualViewportResize();
      list.scrollTop = list.scrollHeight;
    }, 60);
  });
  input.addEventListener('blur', () => {
    document.body.classList.remove('kb-open');
    setTimeout(() => {
      if (typeof onVisualViewportResize === 'function') onVisualViewportResize();
      try {
        document.documentElement.scrollLeft = 0;
        document.body.scrollLeft = 0;
      } catch (e) { /* ignore */ }
    }, 80);
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
    dHeadCamBtn.classList.toggle('on', camOn);
    dHeadCamBtn.replaceChildren(h('span', { html: camOn ? icons.camera : icons.cameraOff, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), camOn ? 'Kamera Açık' : 'Kamera');
    dCamPill.replaceChildren(h('span', { html: camOn ? icons.camera : icons.cameraOff, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), 'Kamera');
    dScreenPill.classList.toggle('on', screenOn);
    dScreenPill.replaceChildren(h('span', { html: icons.screenShare, style: { display: 'inline-flex', width: '13px', height: '13px', marginRight: '3px' } }), screenOn ? 'Durdur' : 'Ekran');

    const rawParts = state.mesh?.participants || [];
    const selfId = ctx.voice?.getSelfId?.() || state.clientId || state.self?.id;
    const mappedPeers = rawParts.map((p) => {
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
    const peerById = new Map();
    for (const p of mappedPeers) {
      if (!p || !p.id) continue;
      peerById.set(p.id, p);
    }
    const callPeers = Array.from(peerById.values());
    const nameTotals = new Map();
    for (const p of callPeers) {
      const nk = (p.name || 'Misafir').trim().toLowerCase();
      nameTotals.set(nk, (nameTotals.get(nk) || 0) + 1);
    }
    const isStageVoip = state.mesh?.voipMode === 'stage';
    const mePeerObj = peerById.get(selfId);
    const canSpeakInStage = Boolean(isLeader() || mePeerObj?.isHost || mePeerObj?.isCoHost || mePeerObj?.isStageSpeaker);
    if (isLeader()) {
      dStageMicPill.classList.remove('hidden');
      dStageMicPill.classList.toggle('on', isStageVoip);
      dStageMicPill.textContent = isStageVoip ? '🎤 Sahne Açık' : '🎤 Sahne Modu';
      dStageMicPill.title = '20+ kişilik odalar için Sahne (Söz İstemeli) Modunu aç/kapat';
    } else if (isStageVoip && !canSpeakInStage) {
      dStageMicPill.classList.remove('hidden');
      dStageMicPill.classList.toggle('on', Boolean(mePeerObj?.handRaised));
      dStageMicPill.textContent = mePeerObj?.handRaised ? '✋ El İndir' : '✋ Söz İste';
      dStageMicPill.title = 'Konuşmak için oda liderinden söz iste';
    } else {
      dStageMicPill.classList.add('hidden');
    }
    const activeVoiceCount = callPeers.filter((p) => p.inCall || !p.muted || p.cam || p.screen || p.speaking).length;
    dCallStatusBadge.textContent = isStageVoip
      ? `🎤 Sahne · ${activeVoiceCount > 0 ? `${activeVoiceCount} Konuşmacı` : `${callPeers.length || 1} Dinleyici`}`
      : (activeVoiceCount > 0 ? `${activeVoiceCount} Aktif` : `${callPeers.length || 1} Odada`);
    dCallStatusBadge.classList.toggle('live', activeVoiceCount > 0 || isStageVoip);

    const shownPeers = callPeers.slice(0, 12);
    const sig = `${isStageVoip}:${isLeader()}|` + shownPeers.map((p) => `${p.id}:${p.name}:${p.device}:${!p.muted}:${!!p.speaking}:${!!p.cam}:${!!p.screen}:${!!p.inCall}:${!!p.deafened}:${!!p.handRaised}:${!!p.isStageSpeaker}`).join('|');
    if (discordCallPeers.dataset.sig !== sig) {
      discordCallPeers.dataset.sig = sig;
      const seenNameIdx = new Map();
      discordCallPeers.replaceChildren(...shownPeers.map((p) => {
        const nk = (p.name || 'Misafir').trim().toLowerCase();
        const idx = (seenNameIdx.get(nk) || 0) + 1;
        seenNameIdx.set(nk, idx);
        const dupCount = nameTotals.get(nk) || 1;
        const labelText = dupCount > 1
          ? `${p.name || 'Misafir'} (${p.id === selfId ? 'Sen' : (p.device || `#${idx}`)})`
          : (p.name || 'Misafir');
        const isAct = Boolean(p.inCall || !p.muted || p.cam || p.screen || p.speaking);
        const badges = [];
        if (p.handRaised) {
          badges.push(h('span', {
            class: 'd-peer-badge hand-raised',
            title: isLeader() ? `${labelText} söz istiyor — mikrofon vermek için tıkla` : `${labelText} söz istiyor`,
            onclick: isLeader() ? (ev) => { ev.stopPropagation(); actions.toggleStageSpeaker?.(p.id); } : null,
          }, '✋'));
        }
        if (p.screen) badges.push(h('span', { class: 'd-peer-badge live-screen' }, 'YAYINDA'));
        if (p.cam) badges.push(h('span', { class: 'd-peer-badge cam', html: icons.camera }));
        if (p.deafened) badges.push(h('span', { class: 'd-peer-badge deaf', html: icons.headphonesOff }));
        else if (!p.muted) badges.push(h('span', { class: 'd-peer-badge mic-on', html: icons.mic }));
        else badges.push(h('span', { class: 'd-peer-badge mic-off', html: icons.micOff }));
        const av = avatar(p, 26);
        if (p.speaking) av.classList.add('speaking');
        return h('div', {
          class: `discord-peer-chip ${isAct ? 'in-call' : ''} ${p.speaking ? 'is-speaking' : ''} ${p.screen ? 'has-screen' : ''}`.trim(),
          title: p.screen ? `${labelText} ekran paylaşıyor — sahnede büyütmek için tıkla` : `${labelText}`,
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
        }, av, h('span', { class: 'd-peer-name' }, labelText), ...badges);
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
    if (state.mesh?.voipMode === 'stage' && !isLeader()) {
      const selfId = ctx.voice?.getSelfId?.() || state.clientId;
      const meP = (state.mesh?.participants || []).find((x) => x.id === selfId);
      if (!meP?.isHost && !meP?.isCoHost && !meP?.isStageSpeaker) {
        if (!meP?.handRaised) actions.raiseHand?.();
        else toast('🎤 Sahne Modu açık — oda liderinin söz vermesi bekleniyor ✋');
        return;
      }
    }
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
    closeToolsPopover();
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

  function spawnEmojiFountain(anchorEl, emoji) {
    try {
      const rect = anchorEl?.getBoundingClientRect?.();
      if (!rect || (!rect.width && !rect.height)) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top;
      for (let i = 0; i < 4; i += 1) {
        const sway = `${Math.round((Math.random() - 0.5) * 68)}px`;
        const rise = `${-Math.round(95 + Math.random() * 75)}px`;
        const delay = `${i * 55}ms`;
        const f = h('div', {
          class: 'wl-fountain-emoji',
          style: {
            left: `${Math.round(cx - 12)}px`,
            top: `${Math.round(cy - 10)}px`,
            '--sway': sway,
            '--rise': rise,
            animationDelay: delay,
          },
        }, emoji);
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 1150 + i * 60);
      }
    } catch (_) {}
  }

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
    if (!e.target?.closest?.('.chat-tools-popover, #btn-chat-tools')) {
      closeToolsPopover();
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

  let activeVoiceAudio = null;
  if (typeof window !== 'undefined') {
    window.vortexStopActiveVoiceNote = () => {
      if (activeVoiceAudio) {
        try { activeVoiceAudio.pause(); } catch (_) {}
        activeVoiceAudio = null;
      }
      window.vortexSetVoiceNotePlaying?.(false);
    };
  }
  function buildAudioNoteWidget(m) {
    const an = m?.audioNote;
    if (!an || !an.dataUrl || !String(an.dataUrl).startsWith('data:audio/')) return null;
    const totalDur = Math.max(1, Number(an.duration || 2));
    const rawPeaks = Array.isArray(an.peaks) && an.peaks.length ? an.peaks : [0.3, 0.65, 0.85, 0.45, 0.75, 0.55, 0.9, 0.4, 0.7, 0.5];
    const barsData = Array.from({ length: 22 }, (_, i) => Number(rawPeaks[i % rawPeaks.length] || 0.45));
    let audioEl = null;
    let rateIdx = 0;
    const rates = [1, 1.5, 2];
    const playBtn = h('button', { type: 'button', class: 'vn-play-btn', 'aria-label': 'Sesli Mesajı Oynat' }, '▶');
    const timeEl = h('span', { class: 'vn-time' }, `0:${String(Math.round(totalDur)).padStart(2, '0')}`);
    const rateBtn = h('button', {
      type: 'button',
      class: 'vn-rate-btn',
      onclick: (e) => {
        e.stopPropagation();
        rateIdx = (rateIdx + 1) % rates.length;
        const r = rates[rateIdx];
        rateBtn.textContent = `${r}x`;
        if (audioEl) audioEl.playbackRate = r;
      },
    }, '1x');
    const barEls = barsData.map((pk, idx) => h('span', {
      class: 'vn-bar',
      style: { height: `${Math.min(100, Math.max(22, Math.round((pk > 1 ? pk / 100 : pk) * 100)))}%` },
      onclick: (e) => {
        e.stopPropagation();
        if (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          audioEl.currentTime = (idx / barEls.length) * audioEl.duration;
        }
      },
    }));
    const syncBars = (ratio) => {
      const activeCount = Math.round(Math.max(0, Math.min(1, ratio)) * barEls.length);
      barEls.forEach((b, i) => b.classList.toggle('played', i < activeCount));
    };
    playBtn.onclick = (e) => {
      e.stopPropagation();
      if (!audioEl) {
        audioEl = new Audio(an.dataUrl);
        audioEl.preload = 'metadata';
        audioEl.playbackRate = rates[rateIdx];
        audioEl.ontimeupdate = () => {
          const d = (Number.isFinite(audioEl.duration) && audioEl.duration > 0) ? audioEl.duration : totalDur;
          syncBars(audioEl.currentTime / d);
          const rem = Math.max(0, Math.ceil(d - audioEl.currentTime));
          timeEl.textContent = `0:${String(rem).padStart(2, '0')}`;
        };
        const onStop = () => {
          playBtn.textContent = '▶';
          syncBars(0);
          timeEl.textContent = `0:${String(Math.round(totalDur)).padStart(2, '0')}`;
          if (activeVoiceAudio === audioEl) {
            activeVoiceAudio = null;
            window.vortexSetVoiceNotePlaying?.(false);
          }
        };
        audioEl.onended = onStop;
        audioEl.onpause = () => {
          playBtn.textContent = '▶';
          if (activeVoiceAudio === audioEl) {
            activeVoiceAudio = null;
            window.vortexSetVoiceNotePlaying?.(false);
          }
        };
      }
      if (audioEl.paused) {
        if (activeVoiceAudio && activeVoiceAudio !== audioEl) {
          try { activeVoiceAudio.pause(); } catch (err) { /* ignore */ }
        }
        activeVoiceAudio = audioEl;
        window.vortexSetVoiceNotePlaying?.(true);
        playBtn.textContent = '⏸';
        audioEl.play().catch(() => { playBtn.textContent = '▶'; window.vortexSetVoiceNotePlaying?.(false); });
      } else {
        audioEl.pause();
      }
    };
    return h('div', { class: 'chat-voice-note', onclick: (e) => e.stopPropagation() },
      playBtn,
      h('div', { class: 'vn-wave' }, ...barEls),
      timeEl,
      rateBtn);
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

  function formatLocalTime(m) {
    const ts = Number(m?.ts || 0);
    if (ts > 1000000000) {
      try {
        const d = new Date(ts * 1000);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
      } catch (e) { /* ignore */ }
    }
    return m?.time || '';
  }

  function msgNode(m) {
    const dispTime = formatLocalTime(m);
    if (m.system) {
      const txt = String(m.text || '');
      const isJoin = /katıldı/i.test(txt);
      const isLeave = /ayrıldı/i.test(txt);
      const isMedia = /oynatılıyor|başlatıldı|eklendi/i.test(txt);
      const sysKind = (isJoin || isLeave) ? 'presence' : isMedia ? 'media' : 'other';
      const badgeIcon = isJoin ? '🟢' : isLeave ? '🔴' : isMedia ? '🎬' : '✨';
      const displayTxt = txt === 'katıldı' ? 'odaya katıldı' : txt === 'ayrıldı' ? 'odadan ayrıldı' : txt;
      const t = h('div', {
        class: `sysmsg ${isJoin ? 'sysmsg-join' : isLeave ? 'sysmsg-leave' : isMedia ? 'sysmsg-media' : ''}`,
        'data-sys-user': m.user || '',
        'data-sys-kind': sysKind,
        'data-ts': String(m.ts || (Date.now() / 1000)),
      },
        h('span', { class: 'sysmsg-ico' }, badgeIcon),
        m.user ? h('b', { class: 'sysmsg-user' }, m.user) : null,
        m.user ? ' ' : null,
        h('span', { class: 'sysmsg-txt' }, displayTxt),
        dispTime ? h('time', { class: 'sysmsg-time' }, dispTime) : null);
      return t;
    }
    const cont = lastUser === m.user && !m.pollId && !m.replyTo && !m.snapshot && !m.audioNote;
    lastUser = (m.pollId || m.snapshot || m.audioNote) ? null : m.user;
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
      'data-ts': String(m.ts || (Date.now() / 1000)),
      onmouseleave: () => row.classList.remove('msg-closing'),
      ondblclick: (e) => {
        if (e.target.closest('button, a, .chat-voice-note, .chat-poll-card')) return;
        setReplyTo(m);
      },
      onclick: (e) => {
        if (e.target.closest('button, a, .chat-poll-card, .chat-snapshot-card, .chat-voice-note, .msg-actions, .msg-reactions')) return;
        const wasOpen = row.classList.contains('msg-active');
        list.querySelectorAll('.msg.msg-active').forEach((n) => n.classList.remove('msg-active'));
        row.classList.remove('msg-closing');
        if (!wasOpen) row.classList.add('msg-active');
      },
    },
      avatar({ name: m.user, color: m.color }, 30),
      h('div', { class: 'msg-body' },
        h('div', { class: 'msg-head-row' },
          h('div', { class: 'msg-name' }, h('span', { style: { color: m.color } }, m.user), h('time', {}, dispTime)),
          actionBar),
        buildQuoteBlock(m.replyTo),
        m.pollId
          ? buildPollWidget(m.pollId)
          : h('div', { class: 'msg-text' },
              ...renderRichMessageText(m.text || ''),
              buildAudioNoteWidget(m),
              buildSnapshotWidget(m),
              m.gif ? h('img', { class: 'gif', src: m.gif, alt: 'gif', loading: 'lazy' }) : null),
        reactWrap));
    let swX = 0;
    let swY = 0;
    row.addEventListener('touchstart', (ev) => {
      const t = ev.touches?.[0];
      if (t) { swX = t.clientX; swY = t.clientY; }
    }, { passive: true });
    row.addEventListener('touchend', (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t || !swX) return;
      const dx = t.clientX - swX;
      const dy = Math.abs(t.clientY - swY);
      swX = 0;
      if (dx > 52 && dy < 28) setReplyTo(m);
    }, { passive: true });
    return row;
  }

  const recentSysMap = new Map();
  function append(m) {
    if (!m || !m.id || rendered.has(m.id)) return;
    const nowSec = Date.now() / 1000;
    const curTs = Number(m.ts || nowSec);
    if (m.system) {
      if (nowSec - curTs > 1800) {
        rendered.add(m.id);
        return;
      }
      const txt = String(m.text || '');
      const isPresence = /katıldı|ayrıldı/i.test(txt);
      const isMedia = /oynatılıyor|başlatıldı|eklendi/i.test(txt);
      if (m.user && isPresence) {
        const normAct = /katıldı/i.test(txt) ? 'join' : 'leave';
        const sysKey = `${m.user}:${normAct}`;
        const prevTs = recentSysMap.get(sysKey) || 0;
        if (prevTs && Math.abs(curTs - prevTs) < 3) {
          rendered.add(m.id);
          return;
        }
        recentSysMap.set(sysKey, curTs);
        const remPresence = Array.from(list.querySelectorAll('.sysmsg[data-sys-kind="presence"]'));
        while (remPresence.length >= 6) {
          remPresence.shift()?.remove();
        }
      } else if (isMedia) {
        list.querySelectorAll('.sysmsg[data-sys-kind="media"]').forEach((node) => node.remove());
      }
    }
    rendered.add(m.id);
    if (m.system) lastUser = null;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const node = msgNode(m);
    const lastChild = list.lastElementChild;
    const lastTs = lastChild ? Number(lastChild.dataset?.ts || 0) : 0;
    if (lastTs > 0 && curTs > 0 && curTs < lastTs - 1) {
      const nextSibling = Array.from(list.children).find((ch) => Number(ch.dataset?.ts || 0) > curTs);
      if (nextSibling) list.insertBefore(node, nextSibling);
      else list.append(node);
    } else {
      list.append(node);
    }
    while (list.children.length > 150) {
      list.firstElementChild?.remove();
      list.firstElementChild?.classList?.remove('cont');
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
        h('button', { type: 'button', class: 'chat-q-pill friend-add-pill', id: 'btn-room-add-friend', onclick: () => { if (typeof window.vortexOpenFriendsModal === 'function') window.vortexOpenFriendsModal(); else { setView('right', 'Friends'); ctx.layout.update(); } }, title: 'Arkadaş Ekle & Arkadaş Listem' }, h('span', { html: icons.addUser, style: { display: 'inline-flex', width: '12px', height: '12px' } }), '+ Arkadaş Ekle'),
        h('a', { class: 'chat-q-pill', href: waUrl, target: '_blank', rel: 'noopener', title: 'WhatsApp ile davet et' }, h('span', { html: icons.share, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'WhatsApp'),
        h('button', { type: 'button', class: 'chat-q-pill', onclick: () => { setView('right', 'Friends'); ctx.layout.update(); }, title: 'Davet Kartı & QR' }, h('span', { html: icons.qr, style: { display: 'inline-flex', width: '12px', height: '12px' } }), 'QR')),
      h('div', { class: 'chat-access-seg', 'data-active-privacy': cur },
        ...PRIVACY.map(([k, label, ic, desc]) => h('button', {
          type: 'button',
          class: `chat-q-pill privacy-opt ${cur === k ? 'on' : ''}`,
          title: desc,
          'data-privacy': k,
          onclick: () => {
            if (!isLeader()) { toast('Bu ayarı yalnızca oda lideri değiştirebilir'); return; }
            actions.hostAction('set_privacy', { privacy: k });
          },
        }, h('span', { html: icons[ic], style: { display: 'flex', width: '12px', height: '12px' } }), h('span', { class: 'priv-opt-lbl' }, cur === k && k === 'friends' ? 'Sadece Arkadaşlar' : label)))),
      h('button', { type: 'button', class: 'chat-q-close', 'aria-label': 'Kapat', onclick: () => { quickAccessZone.classList.add('hidden'); dShareQuickBtn.classList.remove('on'); } }, '✕'));
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
    recentSysMap.clear();
    lastUser = null;
    clearReply();
    list.querySelectorAll('.msg, .sysmsg, .chat-msg, .chat-sys, .chat-poll-card').forEach((n) => n.remove());
  }

  let maxPortraitH = 0;
  let maxLandscapeH = 0;
  const onVisualViewportResize = () => {
    const rawW = window.innerWidth || document.documentElement.clientWidth || 0;
    const rawH = window.innerHeight || document.documentElement.clientHeight || 0;
    const vv = window.visualViewport;
    const vvH = vv ? vv.height : rawH;
    const activeEl = document.activeElement;
    const isInputTag = Boolean(activeEl && /^(INPUT|TEXTAREA)$/i.test(activeEl.tagName) && activeEl.type !== 'range' && activeEl.type !== 'checkbox' && activeEl.type !== 'radio' && activeEl.type !== 'file');
    const isChatFocused = Boolean(activeEl && (activeEl === input || (el.contains(activeEl) && isInputTag)));
    const isRoomOrPopupInput = Boolean(isChatFocused || (isInputTag && activeEl.closest?.('#mesh-root, #popup-root')));
    const isLandscape = rawW > rawH * 1.08;
    if (!isRoomOrPopupInput) {
      if (isLandscape) maxLandscapeH = Math.max(maxLandscapeH, rawH, vvH || 0);
      else maxPortraitH = Math.max(maxPortraitH, rawH, vvH || 0);
    }
    const baseH = isLandscape
      ? Math.max(maxLandscapeH, Math.min(rawW, rawH))
      : Math.max(maxPortraitH, rawH, vvH || 0);
    const kbOpen = Boolean(isRoomOrPopupInput && ((vv && (baseH - vvH > 95)) || (baseH - rawH > 95)));
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0 || document.body.scrollTop > 0) {
      try { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch (e) { /* ignore */ }
    }
    if (kbOpen) {
      const effH = Math.max(120, Math.round(vv ? vvH : rawH));
      const vvTop = vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
      document.documentElement.style.setProperty('--vvh', `${effH}px`);
      document.documentElement.style.setProperty('--vv-top', `${vvTop}px`);
    } else {
      document.documentElement.style.setProperty('--vvh', '100%');
      document.documentElement.style.setProperty('--vv-top', '0px');
    }
    document.body.classList.toggle('kb-open', kbOpen);
    document.body.classList.toggle('kb-chat-focus', Boolean(kbOpen && isChatFocused));
    document.body.classList.toggle('kb-portrait', Boolean(kbOpen && !isLandscape));
    if (kbOpen && isChatFocused) {
      list.scrollTop = list.scrollHeight;
    }
  };
  const onWindowOrientationOrResize = () => {
    onVisualViewportResize();
    [60, 200, 500].forEach((ms) => setTimeout(onVisualViewportResize, ms));
  };
  input.addEventListener('focus', () => {
    setTimeout(onVisualViewportResize, 80);
    setTimeout(onVisualViewportResize, 260);
  });
  input.addEventListener('blur', () => {
    document.body.classList.remove('kb-open');
    document.documentElement.style.setProperty('--vvh', '100%');
    document.documentElement.style.setProperty('--vv-top', '0px');
    setTimeout(onVisualViewportResize, 80);
  });
  window.addEventListener('resize', onWindowOrientationOrResize);
  window.addEventListener('orientationchange', onWindowOrientationOrResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onVisualViewportResize);
    window.visualViewport.addEventListener('scroll', onVisualViewportResize);
  }
  onVisualViewportResize();

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
      const nowSec = Date.now() / 1000;
      list.querySelectorAll('.sysmsg').forEach((node) => {
        const ts = Number(node.dataset.ts || 0);
        if (ts > 0 && nowSec - ts > 1800) node.remove();
      });
      const chatArr = state.mesh?.chat || [];
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
        const segEl = card.querySelector('.chat-access-seg');
        if (segEl) segEl.dataset.activePrivacy = cur;
        card.querySelectorAll('.privacy-opt').forEach((btn) => {
          const isOn = btn.dataset.privacy === cur;
          btn.classList.toggle('on', isOn);
          const lbl = btn.querySelector('.priv-opt-lbl');
          if (lbl && btn.dataset.privacy === 'friends') {
            lbl.textContent = isOn ? 'Sadece Arkadaşlar' : 'Arkadaşlar';
          }
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
      stopVoiceRecorder(false);
      if (activeVoiceAudio) { try { activeVoiceAudio.pause(); } catch (e) { /* ignore */ } activeVoiceAudio = null; }
      window.vortexSetVoiceNotePlaying?.(false);
      clearTimeout(typingTimer);
      document.body.classList.remove('kb-open', 'kb-chat-focus', 'kb-portrait');
      document.removeEventListener('pointerdown', onDocOutsideTap);
      window.removeEventListener('resize', onWindowOrientationOrResize);
      window.removeEventListener('orientationchange', onWindowOrientationOrResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onVisualViewportResize);
        window.visualViewport.removeEventListener('scroll', onVisualViewportResize);
      }
    },
  };
}
