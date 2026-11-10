// Mesh layout: NavBar (Taverns/Hyperbeam Studio Header) + MeshLayout grid + side-panel switching.
import { h, icons, popup, confirmPopup, openThemeModal } from '../ui.js?v=20261110_v178';
import { state, setView, canSelectVideo, isHostOnly } from '../store.js?v=20261110_v178';
import { navIcon, logo } from './home.js?v=20261110_v178';
import { createSelection } from './selection.js?v=20261110_v178';
import { buildControls } from './controls.js?v=20261110_v178';
import { buildChat } from './chat.js?v=20261110_v178';
import { PANELS } from './panels.js?v=20261110_v178';
import { getAccount, openNetflixLoginModal, openProviderLoginModal } from '../accounts.js?v=20261110_v178';
import { getProvider } from '../providers.js?v=20261110_v178';

const PRIVACY_LABEL = { public: '🌐 Herkese Açık', friends: '👥 Sadece Arkadaşlar', private: '🔒 Gizli Oda', hidden: '🔒 Gizli Oda' };
const PANEL_TITLE = { Search: 'Video Ara', MeshList: 'Odalar', Settings: 'Oda Ayarları', Vote: 'Oylama ve Sıra', Friends: 'Davet & Arkadaşlar', Globe: 'Harita', Participants: 'Katılımcılar' };

export function buildLayout(app, ctx) {
  const { actions } = ctx;
  const nav = h('nav', { class: 'navbar' });
  const leftPanel = h('aside', { class: 'panel-side panel-left', 'aria-label': 'Sol panel' });
  const rightPanel = h('aside', { class: 'panel-side panel-right', 'aria-label': 'Sağ panel' });
  ctx.host.container.className = 'player-host';
  const frame = h('div', { class: 'video-frame', id: 'video-frame' }, ctx.host.container);
  const drmGateEl = h('div', { class: 'wl-room-drm-gate-overlay hidden', id: 'room-drm-gate' });
  frame.appendChild(drmGateEl);

  let theaterMode = false;
  let controls = null;
  let chat = null;
  const handle = h('div', { class: 'resize-handle', title: 'Sürükleyerek boyutlandır' });
  const chatPanel = h('div', { class: 'panel-chat' });
  const videoChat = h('div', { class: 'video-chat' }, h('div', { class: 'panel-video' }, frame), handle, chatPanel);
  const layout = h('div', { class: 'mesh-layout' }, leftPanel, h('div'), videoChat, h('div'), rightPanel);

  function showDrmGate(provId, { media, onSuccess, onLeave } = {}) {
    const isNf = provId === 'netflix';
    const brandName = isNf ? 'Netflix' : 'HBO Max';
    const brandGradient = isNf ? 'linear-gradient(135deg, #e50914, #b20710)' : 'linear-gradient(135deg, #002be7, #4f46e5)';
    const brandLogoLetter = isNf ? 'N' : 'MAX';
    const officialBrowseUrl = isNf ? 'https://www.netflix.com/browse' : 'https://play.max.com';

    drmGateEl.replaceChildren(
      h('div', {
        class: 'wl-drm-gate-backdrop',
        style: {
          position: 'absolute',
          inset: '0',
          zIndex: '95',
          background: 'rgba(5, 7, 13, 0.96)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 16px',
          boxSizing: 'border-box',
          overflowY: 'auto',
        },
      },
        h('div', {
          class: 'wl-drm-gate-card',
          style: {
            width: '100%',
            maxWidth: '520px',
            background: 'linear-gradient(145deg, rgba(20, 24, 38, 0.98) 0%, rgba(10, 12, 20, 0.99) 100%)',
            border: `1px solid ${isNf ? 'rgba(229, 9, 20, 0.5)' : 'rgba(0, 43, 231, 0.5)'}`,
            borderRadius: '20px',
            padding: '32px 28px',
            boxShadow: `0 24px 60px rgba(0,0,0,0.85), 0 0 40px ${isNf ? 'rgba(229, 9, 20, 0.2)' : 'rgba(0, 43, 231, 0.2)'}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: '18px',
            color: '#f8fafc',
            fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          },
        },
          h('div', { style: { position: 'relative', display: 'inline-flex' } },
            h('div', {
              style: {
                width: '64px',
                height: '64px',
                borderRadius: '16px',
                background: brandGradient,
                color: '#fff',
                fontWeight: '900',
                fontSize: isNf ? '2rem' : '1.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                letterSpacing: '-0.5px',
                boxShadow: `0 8px 24px ${isNf ? 'rgba(229, 9, 20, 0.5)' : 'rgba(0, 43, 231, 0.5)'}`,
              },
            }, brandLogoLetter),
            h('div', {
              style: {
                position: 'absolute',
                bottom: '-6px',
                right: '-6px',
                width: '26px',
                height: '26px',
                borderRadius: '50%',
                background: '#0f172a',
                border: '2px solid #ef4444',
                color: '#ef4444',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '.75rem',
                fontWeight: '900',
              },
            }, '🔒')
          ),
          h('div', {
            style: {
              fontSize: '.74rem',
              fontWeight: '800',
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
              padding: '4px 12px',
              borderRadius: '999px',
              background: isNf ? 'rgba(229, 9, 20, 0.15)' : 'rgba(0, 43, 231, 0.15)',
              border: `1px solid ${isNf ? 'rgba(229, 9, 20, 0.4)' : 'rgba(0, 43, 231, 0.4)'}`,
              color: isNf ? '#f87171' : '#60a5fa',
            },
          }, 'Rave.io Çoklu İzleyici Lisans Protokolü'),
          h('h2', {
            style: {
              margin: '0',
              fontSize: '1.35rem',
              fontWeight: '800',
              color: '#ffffff',
              lineHeight: '1.3',
            },
          }, `Bu Odayı İzlemek İçin ${brandName} Hesabı Gerekir`),
          h('p', {
            style: {
              margin: '0',
              fontSize: '.88rem',
              color: '#94a3b8',
              lineHeight: '1.55',
              maxWidth: '440px',
            },
          }, `Bu odadaki yayın resmi ${brandName} içeriğidir. Rave protokolü ve telif hakları gereğince, odadaki herkesin kendi resmi ${brandName} hesabıyla oturum açmış olması zorunludur. Hesabınız bağlandıktan sonra yayın odadaki diğer izleyicilerle aynı saniyede canlı senkronize açılacaktır.`),
          media?.title ? h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '10px 14px',
              borderRadius: '12px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              width: '100%',
              maxWidth: '440px',
              boxSizing: 'border-box',
              textAlign: 'left',
            },
          },
            media.poster || media.thumbnail ? h('img', {
              src: media.poster || media.thumbnail,
              alt: media.title,
              style: { width: '40px', height: '56px', borderRadius: '6px', objectFit: 'cover' },
            }) : null,
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', {
                style: { fontWeight: '700', fontSize: '.9rem', color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              }, media.title),
              h('div', {
                style: { fontSize: '.76rem', color: isNf ? '#f87171' : '#60a5fa', fontWeight: '600', marginTop: '2px' },
              }, `4K Ultra HD · ${brandName} Resmi Yayını`)
            )
          ) : null,
          h('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              width: '100%',
              maxWidth: '440px',
              marginTop: '4px',
            },
          },
            h('button', {
              type: 'button',
              class: 'btn primary',
              style: {
                background: brandGradient,
                border: 'none',
                color: '#ffffff',
                fontWeight: '800',
                fontSize: '.95rem',
                padding: '14px 20px',
                borderRadius: '12px',
                cursor: 'pointer',
                boxShadow: `0 6px 20px ${isNf ? 'rgba(229, 9, 20, 0.45)' : 'rgba(0, 43, 231, 0.45)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              },
              onclick: () => {
                if (isNf) {
                  openNetflixLoginModal(getProvider('netflix') || { id: 'netflix', name: 'Netflix' }, () => {
                    const chk = getAccount('netflix');
                    if (chk.loginSatisfied) onSuccess?.();
                  });
                } else {
                  openProviderLoginModal(getProvider('max') || { id: 'max', name: 'Max' }, () => {
                    const chk = getAccount('max');
                    if (chk.loginSatisfied) onSuccess?.();
                  });
                }
              },
            },
              h('span', {}, '🔑'),
              h('span', {}, `${brandName} Hesabını Bağla (Resmi Giriş)`)
            ),
            h('button', {
              type: 'button',
              class: 'btn secondary',
              style: {
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                color: '#f8fafc',
                fontWeight: '700',
                fontSize: '.88rem',
                padding: '11px 18px',
                borderRadius: '10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              },
              onclick: () => window.open(officialBrowseUrl, '_blank'),
            },
              h('span', {}, '🌐'),
              h('span', {}, `${brandName.toLowerCase()}.com Aç ↗`)
            ),
            h('button', {
              type: 'button',
              style: {
                background: 'transparent',
                border: 'none',
                color: '#64748b',
                fontWeight: '600',
                fontSize: '.82rem',
                padding: '8px 12px',
                cursor: 'pointer',
                textDecoration: 'underline',
              },
              onclick: () => onLeave?.(),
            }, '🚪 Odadan Ayrıl (Ana Sayfaya Dön)')
          )
        )
      )
    );
    drmGateEl.classList.remove('hidden');
  }

  function hideDrmGate() {
    drmGateEl.classList.add('hidden');
    drmGateEl.replaceChildren();
  }

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

  app.replaceChildren(nav, h('main', { class: 'mesh' }, layout));
  controls = buildControls(frame, ctx);
  chat = buildChat(ctx);
  chatPanel.appendChild(chat.el);
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
    const people = Number((Array.isArray(m?.participants) && m.participants.length) ? m.participants.length : (m?.participantCount || m?.count)) || 1;
    const selDisabled = !canSelectVideo();
    const isCreatorOrHost = Boolean(m && !m.curated && isHostOnly());
    const mediaTitle = m?.media?.title || '';
    const navSig = `${L}|${R}|${voteCount}|${people}|${selDisabled}|${isCreatorOrHost}|${m?.name || ''}|${m?.privacy || ''}|${state.connection}|${theaterMode}|${mediaTitle}`;
    if (navSig === lastNavSig) return;
    lastNavSig = navSig;
    const openSide = (side, tab) => {
      if (typeof window !== 'undefined' && window.innerWidth <= 1180) {
        const opp = side === 'left' ? 'right' : 'left';
        if (state.view[opp] !== 'Collapsed') setView(opp, state.view[opp]);
      }
      setView(side, tab);
      update();
    };
    nav.replaceChildren(
      h('div', { class: 'navbar-left' },
        roomActionBtn(
          'close',
          isCreatorOrHost ? 'Odayı Kapat' : 'Ayrıl',
          isCreatorOrHost ? 'Odayı Kapat ve Herkesi Çıkar' : 'Odadan Ayrıl',
          async () => {
            if (isCreatorOrHost && !m?.curated) {
              popup({
                title: 'Odadan Ayrıl veya Kapat',
                message: people > 1
                  ? `Odada şu an ${people} kişi var. Sadece kendiniz ayrılıp odayı diğer izleyicilere devredebilir veya odayı herkes için kapatabilirsiniz.`
                  : 'Odadan geçici olarak ayrılıp kaldığınız dakikayı koruyabilir veya odayı tamamen kapatabilirsiniz.',
                options: [
                  { label: people > 1 ? 'Sadece Ben Ayrıl (Oda Açık Kalsın)' : 'Sadece Ayrıl (Kaldığım Yer Korunsun)', primary: true, onClick: () => actions.leave(false) },
                  { label: people > 1 ? 'Odayı Herkes İçin Kapat' : 'Odayı Tamamen Kapat', danger: true, onClick: () => actions.leave(true) },
                  { label: 'Kal' },
                ],
              });
              return;
            }
            if (await confirmPopup('Odadan ayrılmak istediğinize emin misiniz?', 'Ayrıl', 'Kal')) actions.leave(false);
          },
          { variant: 'leave-pill', id: 'nav-leave-room' }
        ),
        roomActionBtn('searchVideo', 'İçerik Seç', 'Video & Katalog Ara', () => {
          if (selDisabled) { popup({ message: "Oynatma ayarı 'Liderin Seçimi'. Yalnızca lider video seçebilir.", options: [{ label: 'Tamam' }] }); return; }
          openSide('left', 'Search');
        }, { selected: L === 'Search', disabled: selDisabled, variant: 'primary-pill', id: 'nav-search-video' }),
        roomActionBtn('minimize', 'Küçült', 'Odayı Küçült & Gezin', () => window.vortexMinimizeRoom?.(), { id: 'nav-minimize-room' })),
      h('div', { class: 'navbar-center' },
        h('div', { class: 'room-brand-capsule' },
          logo(),
          h('span', { class: 'room-header-sep' }),
          m ? (() => {
            const activeRoomTitle = (!m.curated && m.media?.title && !/içerik seçilmedi|medya seçilmedi|hazır/i.test(String(m.media.title)))
              ? String(m.media.title).trim()
              : (m.name || 'Watchlivo Odası');
            return h('span', { class: 'mesh-title', id: 'room-header-title', title: `${activeRoomTitle} (#${String(m.id || '').split('-').pop()})` },
              activeRoomTitle,
              !m.curated && m.id ? h('span', { class: 'mesh-title-code', style: { opacity: '0.55', fontSize: '11px', marginLeft: '5px', fontWeight: '600' } }, `#${String(m.id).split('-').pop()}`) : null
            );
          })() : null,
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
        roomActionBtn('addUser', 'Davet Et', 'Arkadaş Davet Et', () => openSide('right', 'Friends'), { selected: R === 'Friends', variant: 'invite-pill', id: 'nav-invite' }),
        roomActionBtn('users', 'Kişiler', 'Katılımcılar', () => openSide('right', 'Participants'), { selected: R === 'Participants', badge: people, id: 'nav-participants' }),
        theaterMode
          ? roomActionBtn('panelRightOpen', 'Sohbeti Aç', 'Sohbet Panelini Aç (T)', () => toggleTheaterMode(), { selected: true, id: 'nav-toggle-chat' })
          : roomActionBtn('panelRightClose', 'Sinema', 'Sohbeti Gizle / Sinema Modu (T)', () => toggleTheaterMode(), { selected: false, id: 'nav-toggle-chat' })));
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
  renderNav();
  controls.update();

  return {
    update,
    toggleTheaterMode,
    showDrmGate,
    hideDrmGate,
    chatAppended: (msg) => chat.append(msg),
    clearChatDom: () => chat.clear?.(),
    pollsUpdated: () => chat.renderPolls?.(),
    reactionsUpdated: () => chat.renderReactions?.(),
    danmaku: (msg) => controls.danmaku?.(msg),
    showTyping: (u) => chat.showTyping(u),
    setMicLevel: (lvl) => chat.setMicLevel?.(lvl),
    floatEmoji: (e, user) => controls.floatEmoji(e, user),
    showBreakSentOverlay: () => controls.showBreakSentOverlay?.(),
    showBreakRequestBanner: (u) => controls.showBreakRequestBanner?.(u),
    syncStatus: (s) => controls.syncStatus(s),
    playerEvent: (ev, arg) => controls.playerEvent(ev, arg),
    showUnmute: (b) => controls.showUnmute(b),
    destroy: () => {
      document.body.classList.remove('theater-mode');
      try { controls.destroy?.(); } catch (_) {}
      try { chat.destroy?.(); } catch (_) {}
      try { leftInst?.destroy?.(); } catch (_) {}
      try { rightInst?.destroy?.(); } catch (_) {}
    },
    openSearch: () => { if (state.view.left !== 'Search') { setView('left', 'Search'); update(); } },
  };
}

function initResize(handle, chatPanel) {
  const saved = Number(localStorage.getItem('vortex_chat_w'));
  if (saved > 200) {
    const maxSaved = typeof window !== 'undefined' ? Math.max(260, Math.round((window.innerWidth || 1280) * 0.5)) : 640;
    chatPanel.style.setProperty('--chat-w', `${Math.max(240, Math.min(maxSaved, saved))}px`);
  }
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    const startX = e.clientX, startW = chatPanel.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.max(250, Math.min(window.innerWidth * 0.55, startW - (ev.clientX - startX)));
      chatPanel.style.setProperty('--chat-w', `${w}px`);
    };
    const up = (ev) => {
      handle.classList.remove('dragging');
      try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
      localStorage.setItem('vortex_chat_w', String(Math.round(chatPanel.getBoundingClientRect().width)));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
