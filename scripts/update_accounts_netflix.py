import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FILE_PATH = "static/js/accounts.js"
with open(FILE_PATH, "r", encoding="utf-8") as f:
    content = f.read()

# Let's inspect where currentStep is initialized in openNetflixLoginModal
target_init = "let currentStep = acct.loginSatisfied ? 'browse' : 'login';"
replacement_init = """// Option B: Default to live in-app Netflix bridge session (Rave parity)
  let currentStep = 'bridge';
  let bridgeUrl = acct.loginSatisfied ? '/api/netflix-bridge/browse' : '/api/netflix-bridge/login';
"""

if target_init in content:
    content = content.replace(target_init, replacement_init, 1)
    print("Replaced currentStep initialization")
else:
    print("Could not find target_init in accounts.js")

# Now let's find the renderView start and add 'bridge' view before VIEW 1
render_view_start = """  const renderView = () => {
    bodyArea.replaceChildren();"""

bridge_view_code = """  const renderView = () => {
    bodyArea.replaceChildren();

    // OPTION B: LIVE IN-APP NETFLIX BRIDGE (RAVE PARITY)
    if (currentStep === 'bridge') {
      const bridgeToolbar = h('div', {
        class: 'rave-bridge-toolbar',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          background: '#0d0d0f',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          fontSize: '12px',
          color: '#94a3b8',
          flexShrink: 0,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { color: '#e50914', fontWeight: '900', letterSpacing: '0.5px' } }, 'NETFLIX LIVE PORTAL'),
          h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' } }),
          h('span', { style: { color: '#cbd5e1', fontSize: '11px' } }, 'Rave Köprüsü Aktif')
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('button', {
            type: 'button',
            style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px' },
            onclick: () => {
              const fr = bodyArea.querySelector('#watchlivo-netflix-bridge-frame');
              if (fr) fr.src = fr.src;
            },
          }, '🔄 Yenile'),
          h('button', {
            type: 'button',
            style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px' },
            onclick: () => {
              const fr = bodyArea.querySelector('#watchlivo-netflix-bridge-frame');
              if (fr) fr.src = '/api/netflix-bridge/browse';
            },
          }, '🏠 Ana Sayfa'),
          h('button', {
            type: 'button',
            style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px' },
            onclick: () => {
              const fr = bodyArea.querySelector('#watchlivo-netflix-bridge-frame');
              if (fr) fr.src = '/api/netflix-bridge/login';
            },
          }, '🔑 Giriş Yap'),
          h('button', {
            type: 'button',
            style: { background: 'rgba(229,9,20,0.15)', border: '1px solid rgba(229,9,20,0.4)', color: '#f87171', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '11px', fontWeight: '700' },
            onclick: () => {
              currentStep = 'profiles';
              renderView();
            },
          }, '⚡ Hızlı Profil Modu')
        )
      );

      const bridgeIframe = h('iframe', {
        id: 'watchlivo-netflix-bridge-frame',
        src: bridgeUrl,
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
        style: {
          width: '100%',
          height: '580px',
          minHeight: '520px',
          border: 'none',
          background: '#141414',
          flex: 1,
        },
      });

      bodyArea.appendChild(bridgeToolbar);
      bodyArea.appendChild(bridgeIframe);
      return;
    }
"""

if render_view_start in content:
    content = content.replace(render_view_start, bridge_view_code, 1)
    print("Added bridge view to renderView")
else:
    print("Could not find render_view_start in accounts.js")

# Add message listener to handle WATCHLIVO_NETFLIX_PICK
modal_handle_code = """  renderView();

  modalHandle = popup({
    content: modalContainer,
    wide: true,
    dismissable: true,
    onClose: () => closeModal(),
  });
}"""

replacement_modal_handle = """  // Bridge event listener for Netflix picking inside Option B iframe
  const onNetflixBridgeMsg = (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.data.type === 'WATCHLIVO_NETFLIX_PICK') {
      const { watchId, url, title } = ev.data;
      if (!watchId) return;
      toast(`🎬 Netflix "${title || ('#' + watchId)}" seçildi! Canlı oda başlatılıyor...`);
      setConnectedAccount('netflix', {
        loginSatisfied: true,
        userAuthenticated: true,
        accountEmail: 'Netflix Aktif Oturum',
        profileName: 'Netflix',
        extra: { watchId, url },
      });
      window.removeEventListener('message', onNetflixBridgeMsg);
      closeModal();
      onReload?.();

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

      if (typeof onPickContent === 'function') {
        onPickContent(mediaObj);
      } else {
        location.hash = `#/mesh/netflix-${watchId}`;
      }
    }
  };
  window.addEventListener('message', onNetflixBridgeMsg);

  const origCloseModal = closeModal;
  closeModal = () => {
    window.removeEventListener('message', onNetflixBridgeMsg);
    origCloseModal();
  };

  renderView();

  modalHandle = popup({
    content: modalContainer,
    wide: true,
    dismissable: true,
    onClose: () => closeModal(),
  });
}"""

if modal_handle_code in content:
    content = content.replace(modal_handle_code, replacement_modal_handle, 1)
    print("Added message listener for WATCHLIVO_NETFLIX_PICK")
else:
    print("Could not find modal_handle_code in accounts.js")

with open(FILE_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("accounts.js updated successfully!")
