import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FILE_PATH = "static/js/views/selection-kinds.js"
with open(FILE_PATH, "r", encoding="utf-8") as f:
    content = f.read()

bad_block_start = "  const renderNavTabs = () => {"
bad_block_end = "  const topBar = h('div', {"

start_pos = content.find(bad_block_start)
end_pos = content.find(bad_block_end)

if start_pos == -1 or end_pos == -1:
    print("Could not find markers")
    sys.exit(1)

fixed_nav_tabs = """  const renderNavTabs = () => {
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
          filterContent();
        },
      }, t.label))
    );
  };

"""

# Replace the mangled renderNavTabs with the clean renderNavTabs
content = content[:start_pos] + fixed_nav_tabs + content[end_pos:]

# Now let's place ravePortalWindow right after topBar definition and before heroItem
topbar_end_marker = "  renderNavTabs();"
# Find the second occurrence or the occurrence right after topBar closing parenthesis
# Let's find "  // 2. Netflix Hero Showcase Spotlight Billboard"
hero_marker = "  // 2. Netflix Hero Showcase Spotlight Billboard"
hero_pos = content.find(hero_marker)
if hero_pos == -1:
    print("Could not find hero_marker")
    sys.exit(1)

rave_portal_definition = """  // OPTION B: DIRECT EMBEDDED RAVE NETFLIX PORTAL (Rave parity)
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
      marginBottom: '24px',
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

"""

content = content[:hero_pos] + rave_portal_definition + content[hero_pos:]

with open(FILE_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("Successfully repaired renderNetflixRavePortal scope!")
