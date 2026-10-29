// Mesh layout: NavBar (Rave icon order) + MeshLayout grid + side-panel switching.
import { h, icons, popup, confirmPopup, openThemeModal } from '../ui.js?v=20261029_v13';
import { state, setView, canSelectVideo } from '../store.js?v=20261029_v13';
import { navIcon, logo } from './home.js?v=20261029_v13';
import { createSelection } from './selection.js?v=20261029_v13';
import { buildControls } from './controls.js?v=20261029_v13';
import { buildChat } from './chat.js?v=20261029_v13';
import { PANELS } from './panels.js?v=20261029_v13';

const PRIVACY_LABEL = { public: 'Herkese Açık', nearby: 'Çevremdekiler', friends: 'Arkadaşlar', private: 'Gizli', hidden: 'Gizli' };
const PANEL_TITLE = { Search: 'Video Ara', MeshList: 'Odalar', Settings: 'Oda Ayarları', Vote: 'Oylama ve Sıra', Friends: 'Davet Et', Globe: 'Harita', Participants: 'Katılımcılar' };

export function buildLayout(app, ctx) {
  const { actions } = ctx;
  const nav = h('nav', { class: 'navbar' });
  const leftPanel = h('aside', { class: 'panel-side panel-left', 'aria-label': 'Sol panel' });
  const rightPanel = h('aside', { class: 'panel-side panel-right', 'aria-label': 'Sağ panel' });
  ctx.host.container.className = 'player-host';
  const frame = h('div', { class: 'video-frame', id: 'video-frame' }, ctx.host.container);
  const controls = buildControls(frame, ctx);
  const chat = buildChat(ctx);
  const handle = h('div', { class: 'resize-handle', title: 'Sürükleyerek boyutlandır' });
  const chatPanel = h('div', { class: 'panel-chat' }, chat.el);
  const videoChat = h('div', { class: 'video-chat' }, h('div', { class: 'panel-video' }, frame), handle, chatPanel);
  const layout = h('div', { class: 'mesh-layout' }, leftPanel, h('div'), videoChat, h('div'), rightPanel);
  app.replaceChildren(nav, h('main', { class: 'mesh' }, layout));
  initResize(handle, chatPanel);

  let leftKey = '', rightKey = '';
  let leftInst = null, rightInst = null;
  let selection = null;

  function panelContent(name, side) {
    if (name === 'Search') {
      selection = createSelection({ compact: true, onPick: async (m) => actions.pickMedia(m) });
      selection.render();
      return { el: selection };
    }
    const factory = PANELS[name];
    return factory ? factory(ctx) : { el: h('div', { class: 'lobby-empty' }, 'Yakında') };
  }

  const LEFT_TABS = [['Search', 'searchVideo', 'Platformlar'], ['MeshList', 'rooms', 'Odalar'], ['Settings', 'settings', 'Ayarlar']];
  const RIGHT_TABS = [['Vote', 'vote', 'Sıra'], ['Participants', 'users', 'Kişiler'], ['Friends', 'addUser', 'Davet'], ['Globe', 'map', 'Bölge']];

  function mountPanel(side, name) {
    const host = side === 'left' ? leftPanel : rightPanel;
    if (name === 'Collapsed') { host.replaceChildren(); return null; }
    const inst = panelContent(name, side);
    const tabs = side === 'left' ? LEFT_TABS : RIGHT_TABS;
    const tabBar = h('div', { class: 'drawer-tabs' }, tabs.map(([k, ic, lbl]) =>
      h('button', {
        type: 'button',
        class: `drawer-tab ${name === k ? 'on' : ''}`,
        onclick: () => { if (name !== k) { setView(side, k); update(); } },
      }, h('span', { html: icons[ic], style: { display: 'inline-flex' } }), h('span', {}, lbl))));
    host.replaceChildren(
      h('div', { class: 'panel-head' }, h('h3', {}, PANEL_TITLE[name] || name),
        h('button', { class: 'panel-close', 'aria-label': 'Kapat', html: icons.close, onclick: () => { setView(side, name); update(); } })),
      tabBar,
      h('div', { class: 'panel-body' }, inst.el));
    return inst;
  }

  let lastNavSig = '';
  function renderNav() {
    const m = state.mesh;
    const L = state.view.left, R = state.view.right;
    const voteCount = (m?.queue || []).length;
    const people = Number(m?.participantCount || m?.count || (m?.participants || []).length);
    const selDisabled = !canSelectVideo();
    const navSig = `${L}|${R}|${voteCount}|${people}|${selDisabled}|${m?.name || ''}|${m?.privacy || ''}|${state.connection}`;
    if (navSig === lastNavSig) return;
    lastNavSig = navSig;
    const openSide = (side, tab) => {
      if (typeof window !== 'undefined' && window.innerWidth <= 960) {
        const opp = side === 'left' ? 'right' : 'left';
        if (state.view[opp] !== 'Collapsed') setView(opp, state.view[opp]);
      }
      setView(side, tab);
      update();
    };
    nav.replaceChildren(
      h('div', { class: 'navbar-left' },
        navIcon('close', 'Ayrıl', async () => { if (await confirmPopup('Odadan ayrılmak istediğinize emin misiniz?', 'Ayrıl', 'Kal')) actions.leave(); }),
        navIcon('minimize', 'Odayı Küçült & Gezin', () => window.vortexMinimizeRoom?.(), { id: 'nav-minimize-room' }),
        navIcon('searchVideo', 'Video Ara', () => {
          if (selDisabled) { popup({ message: "Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider video seçebilir.", options: [{ label: 'Tamam' }] }); return; }
          openSide('left', 'Search');
        }, { selected: L !== 'Collapsed' && L !== 'Settings', disabled: selDisabled, id: 'nav-search-video' }),
        navIcon('settings', 'Ayarlar', () => openSide('left', 'Settings'), { selected: L === 'Settings' })),
      h('div', { class: 'navbar-center' }, logo(),
        m ? h('span', { class: 'mesh-title', title: m.name }, m.name) : null,
        m ? h('span', { class: 'privacy-chip', onclick: () => openSide('left', 'Settings') }, PRIVACY_LABEL[m.privacy] || 'Herkese Açık') : null,
        state.connection === 'online'
          ? h('span', { class: 'privacy-chip sync-live-chip', title: 'Sıfır gecikmeli senkronizasyon aktif' }, h('span', { class: 'room-live-dot' }), 'SENKRON')
          : h('span', { class: 'privacy-chip conn-chip', style: { borderColor: '#f59e0b' } }, state.connection === 'denied' ? 'Erişim yok' : 'Bağlanıyor…')),
      h('div', { class: 'navbar-right' },
        navIcon('addUser', 'Davet Et', () => openSide('right', 'Friends'), { selected: R === 'Friends' }),
        navIcon('users', 'Katılımcılar', () => openSide('right', 'Participants'), { selected: R !== 'Collapsed' && R !== 'Friends', badge: people, id: 'nav-participants' })));
  }

  function update() {
    const L = state.view.left, R = state.view.right;
    layout.classList.toggle('has-left', L !== 'Collapsed');
    layout.classList.toggle('has-right', R !== 'Collapsed');
    if (L !== leftKey) { leftInst?.destroy?.(); leftKey = L; leftInst = mountPanel('left', L); }
    if (R !== rightKey) { rightInst?.destroy?.(); rightKey = R; rightInst = mountPanel('right', R); }
    leftInst?.update?.();
    rightInst?.update?.();
    renderNav();
    controls.update();
    chat.update();
  }

  // Rave: a fresh mesh opens with invite + privacy prompts in chat and the selection panel ready.
  if (ctx.isNew) chat.showOnboarding();

  return {
    update,
    chatAppended: (msg) => chat.append(msg),
    pollsUpdated: () => chat.renderPolls?.(),
    reactionsUpdated: () => chat.renderReactions?.(),
    danmaku: (msg) => controls.danmaku?.(msg),
    showTyping: (u) => chat.showTyping(u),
    setMicLevel: (lvl) => chat.setMicLevel?.(lvl),
    floatEmoji: (e, user) => controls.floatEmoji(e, user),
    syncStatus: (s) => controls.syncStatus(s),
    playerEvent: (ev, arg) => controls.playerEvent(ev, arg),
    showUnmute: (b) => controls.showUnmute(b),
    destroy: () => { controls.destroy?.(); chat.destroy?.(); leftInst?.destroy?.(); rightInst?.destroy?.(); },
    openSearch: () => { if (state.view.left !== 'Search') { setView('left', 'Search'); update(); } },
  };
}

function initResize(handle, chatPanel) {
  const saved = Number(localStorage.getItem('vortex_chat_w'));
  if (saved > 200) chatPanel.style.setProperty('--chat-w', `${saved}px`);
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX = e.clientX, startW = chatPanel.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.max(230, Math.min(window.innerWidth * 0.6, startW - (ev.clientX - startX)));
      chatPanel.style.setProperty('--chat-w', `${w}px`);
    };
    const up = () => {
      handle.classList.remove('dragging');
      localStorage.setItem('vortex_chat_w', String(Math.round(chatPanel.getBoundingClientRect().width)));
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}
