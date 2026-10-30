// Mesh layout: NavBar (Taverns/Hyperbeam Studio Header) + MeshLayout grid + side-panel switching.
import { h, icons, popup, confirmPopup, openThemeModal } from '../ui.js?v=20261030_v41';
import { state, setView, canSelectVideo } from '../store.js?v=20261030_v41';
import { navIcon, logo } from './home.js?v=20261030_v41';
import { createSelection } from './selection.js?v=20261030_v41';
import { buildControls } from './controls.js?v=20261030_v41';
import { buildChat } from './chat.js?v=20261030_v41';
import { PANELS } from './panels.js?v=20261030_v41';

const PRIVACY_LABEL = { public: '🌐 Herkese Açık', nearby: '📍 Çevremdekiler', friends: '👥 Sadece Arkadaşlar', private: '🔒 Gizli Oda', hidden: '🔒 Gizli Oda' };
const PANEL_TITLE = { Search: 'Video Ara', MeshList: 'Odalar', Settings: 'Oda Ayarları', Vote: 'Oylama ve Sıra', Friends: 'Davet & Arkadaşlar', Globe: 'Harita', Participants: 'Katılımcılar' };

export function buildLayout(app, ctx) {
  const { actions } = ctx;
  const nav = h('nav', { class: 'navbar' });
  const leftPanel = h('aside', { class: 'panel-side panel-left', 'aria-label': 'Sol panel' });
  const rightPanel = h('aside', { class: 'panel-side panel-right', 'aria-label': 'Sağ panel' });
  ctx.host.container.className = 'player-host';
  const frame = h('div', { class: 'video-frame', id: 'video-frame' }, ctx.host.container);
  let theaterMode = false;
  let controls = null;
  let chat = null;
  const handle = h('div', { class: 'resize-handle', title: 'Sürükleyerek boyutlandır' });
  const chatPanel = h('div', { class: 'panel-chat' });
  const videoChat = h('div', { class: 'video-chat' }, h('div', { class: 'panel-video' }, frame), handle, chatPanel);
  const layout = h('div', { class: 'mesh-layout' }, leftPanel, h('div'), videoChat, h('div'), rightPanel);

  function toggleTheaterMode(force) {
    theaterMode = typeof force === 'boolean' ? force : !theaterMode;
    videoChat.classList.toggle('no-chat', theaterMode);
    document.body.classList.toggle('theater-mode', theaterMode);
    lastNavSig = '';
    renderNav();
    controls?.update?.();
    return theaterMode;
  }
  ctx.toggleTheaterMode = toggleTheaterMode;
  ctx.isTheaterMode = () => theaterMode;

  controls = buildControls(frame, ctx);
  chat = buildChat(ctx);
  chatPanel.append(chat.el);
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

  function roomActionBtn(iconName, labelText, tip, onClick, { selected = false, disabled = false, badge = 0, variant = '', id } = {}) {
    return h('button', {
      type: 'button',
      class: `nav-icon room-nav-pill ${variant} ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`.trim(),
      'data-tip': tip,
      'aria-label': tip,
      id,
      onclick: onClick,
    },
      h('span', { class: 'room-nav-ico', html: icons[iconName], style: { display: 'inline-flex' } }),
      labelText ? h('span', { class: 'room-nav-lbl' }, labelText) : null,
      badge > 0 ? h('span', { class: 'badge' }, badge > 9999 ? '9.9B+' : badge) : null);
  }

  let lastNavSig = '';
  function renderNav() {
    const m = state.mesh;
    const L = state.view.left, R = state.view.right;
    const voteCount = (m?.queue || []).length;
    const people = Number(m?.participantCount || m?.count || (m?.participants || []).length) || 1;
    const selDisabled = !canSelectVideo();
    const mediaTitle = m?.media?.title || '';
    const navSig = `${L}|${R}|${voteCount}|${people}|${selDisabled}|${m?.name || ''}|${m?.privacy || ''}|${state.connection}|${theaterMode}|${mediaTitle}`;
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
        roomActionBtn('close', 'Ayrıl', 'Odadan Ayrıl', async () => { if (await confirmPopup('Odadan ayrılmak istediğinize emin misiniz?', 'Ayrıl', 'Kal')) actions.leave(); }, { variant: 'leave-pill' }),
        roomActionBtn('searchVideo', 'İçerik Seç', 'Video & Katalog Ara', () => {
          if (selDisabled) { popup({ message: "Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider video seçebilir.", options: [{ label: 'Tamam' }] }); return; }
          openSide('left', 'Search');
        }, { selected: L !== 'Collapsed' && L !== 'Settings', disabled: selDisabled, variant: 'primary-pill', id: 'nav-search-video' }),
        roomActionBtn('minimize', 'Küçült', 'Odayı Küçült & Gezin', () => window.vortexMinimizeRoom?.(), { id: 'nav-minimize-room' })),
      h('div', { class: 'navbar-center' },
        h('div', { class: 'room-brand-capsule' },
          logo(),
          h('span', { class: 'room-header-sep' }),
          m ? h('span', { class: 'mesh-title', title: `${m.name} (#${String(m.id || '').split('-').pop()})` },
            m.name,
            !m.curated && m.id ? h('span', { style: { opacity: '0.55', fontSize: '11px', marginLeft: '5px', fontWeight: '600' } }, `#${String(m.id).split('-').pop()}`) : null
          ) : null,
          m ? h('span', {
            class: `privacy-chip is-${m.privacy || 'public'} ${L === 'Settings' ? 'selected' : ''}`.trim(),
            'data-privacy': m.privacy || 'public',
            title: 'Oda gizliliği ve oda ayarlarını aç',
            onclick: () => openSide('left', 'Settings'),
          }, `${PRIVACY_LABEL[m.privacy] || '🌐 Herkese Açık'} ▾`) : null,
          (!m && state.connection !== 'online') || state.connection === 'denied'
            ? h('span', { class: 'privacy-chip conn-chip', style: { borderColor: '#f59e0b' } }, state.connection === 'denied' ? 'Erişim yok' : 'Bağlanıyor…')
            : null)),
      h('div', { class: 'navbar-right' },
        roomActionBtn('vote', 'Sıra', 'Sıra ve Oylama', () => openSide('right', 'Vote'), { selected: R === 'Vote', badge: voteCount, id: 'nav-vote' }),
        roomActionBtn('addUser', 'Davet Et', 'Arkadaş Davet Et', () => openSide('right', 'Friends'), { selected: R === 'Friends', variant: 'invite-pill' }),
        roomActionBtn('users', 'Kişiler', 'Katılımcılar', () => openSide('right', 'Participants'), { selected: R === 'Participants', badge: people, id: 'nav-participants' }),
        theaterMode
          ? roomActionBtn('panelRightOpen', 'Sohbeti Aç', 'Sohbet Panelini Aç (T)', () => toggleTheaterMode(), { selected: true, id: 'nav-toggle-chat' })
          : null));
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

  if (ctx.isNew) chat.showOnboarding();

  return {
    update,
    toggleTheaterMode,
    chatAppended: (msg) => chat.append(msg),
    clearChatDom: () => chat.clear?.(),
    pollsUpdated: () => chat.renderPolls?.(),
    reactionsUpdated: () => chat.renderReactions?.(),
    danmaku: (msg) => controls.danmaku?.(msg),
    showTyping: (u) => chat.showTyping(u),
    setMicLevel: (lvl) => chat.setMicLevel?.(lvl),
    floatEmoji: (e, user) => controls.floatEmoji(e, user),
    syncStatus: (s) => controls.syncStatus(s),
    playerEvent: (ev, arg) => controls.playerEvent(ev, arg),
    showUnmute: (b) => controls.showUnmute(b),
    destroy: () => {
      document.body.classList.remove('theater-mode');
      controls.destroy?.();
      chat.destroy?.();
      leftInst?.destroy?.();
      rightInst?.destroy?.();
    },
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
      const w = Math.max(250, Math.min(window.innerWidth * 0.55, startW - (ev.clientX - startX)));
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
