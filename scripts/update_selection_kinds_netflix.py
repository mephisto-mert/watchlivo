import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FILE_PATH = "static/js/views/selection-kinds.js"
with open(FILE_PATH, "r", encoding="utf-8") as f:
    content = f.read()

target = """      acct.loginSatisfied ? h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.35)',
          color: '#34d399',
          padding: '6px 12px',
          borderRadius: '10px',
          fontSize: '.82rem',
          fontWeight: '700',
        },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block' } }),
        acct.profileName || acct.accountEmail || '✓ Netflix Aktif'
      ) : h('button', {
        type: 'button',
        class: 'btn sm primary',
        style: {
          background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
          borderColor: '#e50914',
          fontWeight: '800',
          padding: '7px 14px',
          borderRadius: '8px',
          fontSize: '.82rem',
          cursor: 'pointer',
        },
        onclick: () => openProviderLoginModal(p, () => {
          body.replaceChildren();
          renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }),
      }, '🔑 Netflix Hesabı Bağla'),
      h('button', {
        type: 'button',
        class: 'btn sm ghost',
        style: { fontSize: '.8rem', padding: '6px 12px', borderRadius: '8px' },
        onclick: () => openProviderLoginModal(p, () => {
          body.replaceChildren();
          renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }),
      }, 'Hesap')"""

replacement = """      h('button', {
        type: 'button',
        class: 'btn sm primary',
        style: {
          background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
          borderColor: '#e50914',
          fontWeight: '800',
          padding: '7px 14px',
          borderRadius: '8px',
          fontSize: '.82rem',
          cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(229,9,20,0.35)',
        },
        onclick: () => openNetflixLoginModal(p, () => {
          body.replaceChildren();
          renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }, null, pick),
      }, '🎬 Canlı Netflix Portalı (Rave Görünümü)'),
      acct.loginSatisfied ? h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.35)',
          color: '#34d399',
          padding: '6px 12px',
          borderRadius: '10px',
          fontSize: '.82rem',
          fontWeight: '700',
        },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block' } }),
        acct.profileName || acct.accountEmail || '✓ Netflix Aktif'
      ) : null,
      h('button', {
        type: 'button',
        class: 'btn sm ghost',
        style: { fontSize: '.8rem', padding: '6px 12px', borderRadius: '8px' },
        onclick: () => openNetflixLoginModal(p, () => {
          body.replaceChildren();
          renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl);
        }, null, pick),
      }, 'Hesap')"""

if target in content:
    content = content.replace(target, replacement, 1)
    print("Replaced target in selection-kinds.js")
else:
    print("Could not find target in selection-kinds.js")

with open(FILE_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("selection-kinds.js updated successfully!")
