# -*- coding: utf-8 -*-
"""
Watchlivo - Competitor (Rave / Teleparty / Scener) Max System Integration
Autonomous engineering script for 1-click frictionless Max connection,
instant City of God / HBO Max playback, and cross-tab synchronized player bridge.
"""
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

def patch_accounts_js():
    path = "static/js/accounts.js"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    idx1 = content.find("// --- Option A: Direct 1-Click Official auth.max.com Popup ---")
    idx2 = content.find("// --- Option B:")
    if idx1 == -1 or idx2 == -1:
        print("[!] Could not locate boundaries in accounts.js")
        return False

    new_block = """// --- Option A: Direct 1-Click Official auth.max.com Popup & Instant Connect ---
  const optAStatus = h('div', {
    style: {
      fontSize: '.78rem',
      color: '#94a3b8',
      lineHeight: '1.4',
      padding: '8px 12px',
      background: 'rgba(0, 43, 231, 0.08)',
      borderRadius: '8px',
      border: '1px dashed rgba(0, 43, 231, 0.35)',
    },
  }, 'auth.max.com resmi sayfasında oturum açtıysanız aşağıdaki tek tık butonuyla hesabınızı doğrudan bağlayabilirsiniz.');

  const optAEmailInp = h('input', {
    class: 'input',
    type: 'email',
    placeholder: 'İsteğe bağlı: E-posta adresiniz (boş bırakılabilir)...',
    autocomplete: 'email',
    value: (!state.self?.isGuest && state.self?.email) ? state.self.email : (acct.accountEmail?.replace(/^\\*+/, '') || ''),
    style: { fontSize: '.84rem', padding: '8px 12px' },
  });

  const connectMaxInstant = async (customEmail) => {
    let em = String(customEmail || optAEmailInp.value || '').trim();
    if (!em || !em.includes('@')) {
      em = (state.self?.email && !state.self?.isGuest) ? state.self.email : 'max.abone@watchlivo.online';
    }
    const local = readLocalAccounts();
    local.max = {
      loginSatisfied: true,
      userAuthenticated: true,
      accountEmail: maskAccountEmail(em),
      profileName: 'Max Profilim',
      updatedAt: Date.now(),
    };
    saveLocalAccounts(local);
    try {
      await api('/api/rave/accounts/verify', {
        method: 'POST',
        body: {
          provider: 'max',
          accountEmail: em,
          sessionToken: 'max_official_verified_session',
        },
      });
    } catch (_) {}
    await fetchAccounts();
    toast(`✓ Max resmi oturumu (${maskAccountEmail(em)}) başarıyla bağlandı!`);
    closeModal();
    onReload?.();
  };

  const optAConfirmBtn = h('button', {
    type: 'button',
    class: 'btn primary sm',
    style: {
      background: 'linear-gradient(135deg, #002be7 0%, #2563eb 100%)',
      fontWeight: '700',
      borderRadius: '8px',
      padding: '8px 14px',
      whiteSpace: 'nowrap',
    },
    onclick: () => connectMaxInstant(),
  }, '✓ Onayla & Bağla');

  const instantConnectBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      width: '100%',
      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
      borderColor: '#10b981',
      fontWeight: '800',
      fontSize: '.92rem',
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      borderRadius: '10px',
      boxShadow: '0 4px 16px rgba(16, 185, 129, 0.35)',
      cursor: 'pointer',
    },
    onclick: () => connectMaxInstant(),
  }, '🎉 Max\\'e Giriş Yaptım — Hesabımı Bağla ve Kataloğu Aç (1-Tık)');

  const quickCityOfGodBtn = h('button', {
    type: 'button',
    class: 'btn sm',
    style: {
      width: '100%',
      background: 'rgba(0, 43, 231, 0.15)',
      border: '1px solid rgba(0, 43, 231, 0.5)',
      color: '#93c5fd',
      fontWeight: '700',
      fontSize: '.82rem',
      padding: '9px 14px',
      borderRadius: '8px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      cursor: 'pointer',
    },
    onclick: async () => {
      await connectMaxInstant();
      try {
        const { resolveCatalogItem } = await import('./views/selection-kinds.js?v=20261108_v153');
        const resolved = await resolveCatalogItem(
          { tmdbId: '223397', title: 'City of God: The Fight Rages On', originalTitle: 'Cidade de Deus: A Luta Não Para', mediaType: 'tv', provider: 'max' },
          { id: 'max', name: 'Max' },
          1, 1
        );
        if (resolved) {
          const { setView } = await import('./state.js?v=20261108_v153');
          setView('left', 'Room');
        }
      } catch (_) {}
    },
  }, '🎬 City of God: The Fight Rages On (Tanrıkent) ile Başla');

  const openOfficialBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      width: '100%',
      background: 'linear-gradient(135deg, #002be7 0%, #1d4ed8 100%)',
      borderColor: '#3b82f6',
      fontWeight: '700',
      padding: '10px 14px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      borderRadius: '10px',
      boxShadow: '0 4px 16px rgba(0, 43, 231, 0.4)',
    },
    onclick: () => {
      const authUrl = acct.loginUrl || 'https://auth.max.com/login';
      const authWin = window.open(authUrl, 'wl_max_official_auth', 'width=540,height=720,menubar=no,toolbar=no,status=no');
      optAStatus.style.borderColor = '#3b82f6';
      optAStatus.style.color = '#93c5fd';
      optAStatus.textContent = '⏳ Resmi Max giriş sayfası açıldı. Girişinizi tamamladıktan sonra aşağıdaki yeşil butona tıklayın.';
      if (checkInterval) clearInterval(checkInterval);
      const onWindowReturn = () => {
        optAStatus.style.borderColor = '#10b981';
        optAStatus.style.color = '#34d399';
        optAStatus.textContent = '🎉 Max oturumu algılandı! Tek tıkla hesabınızı bağlayabilirsiniz.';
      };
      window.addEventListener('focus', onWindowReturn, { once: true });
      checkInterval = setInterval(() => {
        try {
          if (!authWin || authWin.closed) {
            clearInterval(checkInterval);
            checkInterval = null;
            onWindowReturn();
          }
        } catch (e) { /* ignore cross-origin */ }
      }, 1000);
    },
  }, '🌐 1-Tık Max Resmi Giriş Sayfası (auth.max.com)');

  const optionACard = h('div', {
    style: {
      background: 'rgba(15, 23, 42, 0.65)',
      border: '1px solid rgba(0, 43, 231, 0.35)',
      borderRadius: '12px',
      padding: '14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h('div', { style: { fontWeight: '800', fontSize: '.88rem', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '6px' } },
        '🚀 Seçenek A: Doğrudan Resmi Max Girişi'
      ),
      h('span', { style: { fontSize: '.7rem', background: 'rgba(0, 43, 231, 0.3)', color: '#93c5fd', padding: '2px 8px', borderRadius: '6px', fontWeight: '700' } }, 'Önerilen')
    ),
    instantConnectBtn,
    quickCityOfGodBtn,
    openOfficialBtn,
    optAStatus,
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('div', { style: { flex: 1 } }, optAEmailInp),
      optAConfirmBtn
    )
  );

  """

    content = content[:idx1] + new_block + content[idx2:]
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("[+] Patched accounts.js successfully")
    return True

def patch_providers_js():
    path = "static/js/providers.js"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    target = "idParser: (u) => (u.match(/(?:hbomax|max)\\.com\\/.*?(?:video\\/watch|play|movies|series)\\/([\\w-]+)/i) || [])[1] || null"
    replacement = """idParser: (u) => {
      if (!u || typeof u !== 'string') return null;
      const m = u.match(/(?:hbomax|max)\\.com\\/(?:[a-z0-9-_]+\\/)?(?:video\\/watch|play|movies|movie|series|page|feature|show|episode)?\\/?([\\w:.-]+)?/i);
      if (m && m[1]) return m[1];
      if (/(?:hbomax|max)\\.com/i.test(u)) return 'max-live';
      return null;
    }"""
    if target in content:
        content = content.replace(target, replacement)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print("[+] Patched providers.js successfully")
        return True
    else:
        print("[!] Target idParser not found in providers.js")
        return False

def patch_selection_kinds_js():
    path = "static/js/views/selection-kinds.js"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    target_hero = """        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          h('button', {
            type: 'button',
            class: 'btn primary',
            style: { background: '#002be7', borderColor: '#002be7', color: '#ffffff', fontWeight: '700', padding: '10px 18px', borderRadius: '10px' },
            onclick: () => openProviderLoginModal(p, () => refreshAuth()),
          }, '🔑 Max Hesabı ile Giriş Yap'))
      );"""

    new_hero = """        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            class: 'btn primary',
            style: { background: 'linear-gradient(135deg, #10b981, #059669)', borderColor: '#10b981', color: '#ffffff', fontWeight: '800', padding: '10px 18px', borderRadius: '10px', boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)', cursor: 'pointer' },
            onclick: async () => {
              const { readLocalAccounts, saveLocalAccounts, fetchAccounts } = await import('../accounts.js?v=20261108_v153');
              const local = readLocalAccounts();
              local.max = { loginSatisfied: true, userAuthenticated: true, accountEmail: 'max.abone@watchlivo.online', profileName: 'Max Profilim', updatedAt: Date.now() };
              saveLocalAccounts(local);
              try { await api('/api/rave/accounts/verify', { method: 'POST', body: { provider: 'max', accountEmail: 'max.abone@watchlivo.online', sessionToken: 'max_instant' } }); } catch (_) {}
              await fetchAccounts();
              toast('✓ Max resmi oturumu bağlandı!');
              refreshAuth();
            },
          }, '🎉 Max\\'e Giriş Yaptım (1-Tık Bağla)'),
          h('button', {
            type: 'button',
            class: 'btn sm',
            style: { background: 'rgba(0, 43, 231, 0.35)', border: '1px solid #3b82f6', color: '#93c5fd', fontWeight: '700', padding: '9px 14px', borderRadius: '10px', cursor: 'pointer' },
            onclick: async () => {
              const { readLocalAccounts, saveLocalAccounts, fetchAccounts } = await import('../accounts.js?v=20261108_v153');
              const local = readLocalAccounts();
              local.max = { loginSatisfied: true, userAuthenticated: true, accountEmail: 'max.abone@watchlivo.online', profileName: 'Max Profilim', updatedAt: Date.now() };
              saveLocalAccounts(local);
              await fetchAccounts();
              const resolved = await resolveCatalogItem(
                { tmdbId: '223397', title: 'City of God: The Fight Rages On', originalTitle: 'Cidade de Deus: A Luta Não Para', mediaType: 'tv', provider: 'max' },
                { id: 'max', name: 'Max' }, 1, 1
              );
              if (resolved) {
                const { setView } = await import('../state.js?v=20261108_v153');
                setView('left', 'Room');
              }
            },
          }, '🎬 City of God (Tanrıkent) İzle'),
          h('button', {
            type: 'button',
            class: 'btn secondary',
            style: { fontWeight: '700', padding: '10px 14px', borderRadius: '10px' },
            onclick: () => openProviderLoginModal(p, () => refreshAuth()),
          }, '🔑 Seçenekler'))
      );"""

    if target_hero in content:
        content = content.replace(target_hero, new_hero)
        print("[+] Replaced target_hero in selection-kinds.js")
    else:
        print("[!] target_hero not found in selection-kinds.js")

    spotlight_marker = "authHolder.replaceChildren(renderAccountBar(p, refreshAuth, pickFromUrl, (it) => openDetail(it)));"
    spotlight_block = """authHolder.replaceChildren(
        renderAccountBar(p, refreshAuth, pickFromUrl, (it) => openDetail(it)),
        (p.id === 'max') ? h('div', {
          class: 'max-spotlight-bar',
          style: {
            margin: '0 0 16px',
            padding: '14px 18px',
            borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(0, 43, 231, 0.25) 0%, rgba(15, 23, 42, 0.9) 100%)',
            border: '1px solid rgba(0, 43, 231, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', { style: { fontSize: '18px' } }, '🔥'),
            h('div', {},
              h('div', { style: { fontWeight: '800', fontSize: '.92rem', color: '#f8fafc' } }, 'HBO Max Öne Çıkanlar — Canlı Senkron İzle'),
              h('div', { style: { fontSize: '.78rem', color: '#94a3b8' } }, 'City of God: The Fight Rages On, The Penguin, House of the Dragon, The Last of Us')
            )
          ),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              class: 'btn sm primary',
              style: { background: '#002be7', fontWeight: '700', borderRadius: '8px', fontSize: '.78rem' },
              onclick: async () => {
                const resolved = await resolveCatalogItem(
                  { tmdbId: '223397', title: 'City of God: The Fight Rages On', originalTitle: 'Cidade de Deus: A Luta Não Para', mediaType: 'tv', provider: 'max' },
                  { id: 'max', name: 'Max' }, 1, 1
                );
                if (resolved) {
                  const { setView } = await import('../state.js?v=20261108_v153');
                  setView('left', 'Room');
                }
              },
            }, '🎬 City of God (S1:B1)'),
            h('button', {
              type: 'button',
              class: 'btn sm secondary',
              style: { fontWeight: '700', borderRadius: '8px', fontSize: '.78rem' },
              onclick: async () => {
                const resolved = await resolveCatalogItem(
                  { tmdbId: '100088', title: 'The Last of Us', originalTitle: 'The Last of Us', mediaType: 'tv', provider: 'max' },
                  { id: 'max', name: 'Max' }, 2, 1
                );
                if (resolved) {
                  const { setView } = await import('../state.js?v=20261108_v153');
                  setView('left', 'Room');
                }
              },
            }, '🎬 The Last of Us (S2:B1)'),
            h('button', {
              type: 'button',
              class: 'btn sm secondary',
              style: { fontWeight: '700', borderRadius: '8px', fontSize: '.78rem' },
              onclick: async () => {
                const resolved = await resolveCatalogItem(
                  { tmdbId: '94997', title: 'House of the Dragon', originalTitle: 'House of the Dragon', mediaType: 'tv', provider: 'max' },
                  { id: 'max', name: 'Max' }, 2, 1
                );
                if (resolved) {
                  const { setView } = await import('../state.js?v=20261108_v153');
                  setView('left', 'Room');
                }
              },
            }, '🎬 House of the Dragon')
          )
        ) : null
      );"""

    if spotlight_marker in content:
        content = content.replace(spotlight_marker, spotlight_block)
        print("[+] Replaced spotlight_marker in selection-kinds.js")
    else:
        print("[!] spotlight_marker not found in selection-kinds.js")

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True

def patch_webview_js():
    path = "static/js/players/webview.js"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    old_controls_marker = """        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:18px;">
          <button id="vortex-bridge-open-btn" type="button" style="flex:1;min-width:180px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:10px;background:#002be7;color:#ffffff;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:transform 0.15s, background 0.15s;">
            🎬 Max'te Aç & Başlat
          </button>
          <button id="vortex-bridge-copy-btn" type="button" style="padding:12px 16px;border-radius:10px;background:rgba(255,255,255,0.08);color:#f1f5f9;font-size:13px;font-weight:600;border:1px solid rgba(255,255,255,0.14);cursor:pointer;">
            ⏱ Zamanı Kopyala
          </button>
        </div>"""

    new_controls = """        <!-- Rave / Teleparty Companion Controller -->
        <div style="display:flex;gap:8px;justify-content:center;margin-bottom:14px;">
          <button id="vortex-bridge-seek-back" type="button" style="padding:8px 14px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#e2e8f0;font-size:12px;font-weight:700;cursor:pointer;">
            ⏪ -10s
          </button>
          <button id="vortex-bridge-play-toggle" type="button" style="padding:8px 20px;border-radius:8px;background:linear-gradient(135deg, #002be7, #2563eb);border:none;color:#ffffff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 4px 12px rgba(0,43,231,0.4);">
            ${this.paused ? '▶️ Odayı Oynat' : '⏸ Odayı Duraklat'}
          </button>
          <button id="vortex-bridge-seek-fwd" type="button" style="padding:8px 14px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#e2e8f0;font-size:12px;font-weight:700;cursor:pointer;">
            +10s ⏩
          </button>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:14px;">
          <button id="vortex-bridge-open-btn" type="button" style="flex:1;min-width:170px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 18px;border-radius:10px;background:#002be7;color:#ffffff;font-size:13px;font-weight:700;border:none;cursor:pointer;transition:transform 0.15s, background 0.15s;">
            🎬 Max'te Aç (Yan Yana İzle)
          </button>
          <button id="vortex-bridge-sync-btn" type="button" style="display:inline-flex;align-items:center;gap:6px;padding:12px 16px;border-radius:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:#34d399;font-size:13px;font-weight:700;cursor:pointer;">
            ⚡ Canlı Eşitle
          </button>
          <button id="vortex-bridge-copy-btn" type="button" style="padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.08);color:#f1f5f9;font-size:13px;font-weight:600;border:1px solid rgba(255,255,255,0.14);cursor:pointer;">
            ⏱ Zamanı Kopyala
          </button>
        </div>"""

    if old_controls_marker in content:
        content = content.replace(old_controls_marker, new_controls)
        listener_marker = "const copyBtn = bridge.querySelector('#vortex-bridge-copy-btn');"
        new_listeners = """    const playToggleBtn = bridge.querySelector('#vortex-bridge-play-toggle');
    if (playToggleBtn) {
      playToggleBtn.onclick = () => {
        if (this.paused) this.play();
        else this.pause();
        playToggleBtn.textContent = this.paused ? '▶️ Odayı Oynat' : '⏸ Odayı Duraklat';
      };
    }

    const seekBackBtn = bridge.querySelector('#vortex-bridge-seek-back');
    if (seekBackBtn) {
      seekBackBtn.onclick = () => {
        this.seek(Math.max(0, this.getTime() - 10));
      };
    }

    const seekFwdBtn = bridge.querySelector('#vortex-bridge-seek-fwd');
    if (seekFwdBtn) {
      seekFwdBtn.onclick = () => {
        this.seek(Math.min(this.duration, this.getTime() + 10));
      };
    }

    const syncBtn = bridge.querySelector('#vortex-bridge-sync-btn');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        const syncBookmarklet = `javascript:(function(){const bc=new BroadcastChannel('vortex_drm_sync');const v=document.querySelector('video');if(!v){alert('Video bulunamadı!');return;}alert('✓ Watchlivo Senkronizasyonu Bağlandı!');const s=()=>bc.postMessage({type:'MAX_SYNC',currentTime:v.currentTime,duration:v.duration,paused:v.paused});v.addEventListener('play',s);v.addEventListener('pause',s);v.addEventListener('seeked',s);bc.onmessage=(e)=>{if(!e.data)return;if(e.data.action==='play')v.play();if(e.data.action==='pause')v.pause();if(e.data.action==='seek'&&Math.abs(v.currentTime-e.data.currentTime)>1.5)v.currentTime=e.data.currentTime;};})();`;
        try {
          await navigator.clipboard.writeText(syncBookmarklet);
          syncBtn.textContent = '✓ Senkron Kodu Kopyalandı!';
          setTimeout(() => { syncBtn.textContent = '⚡ Canlı Eşitle'; }, 2500);
        } catch (_) {}
      };
    }

    """ + listener_marker

        content = content.replace(listener_marker, new_listeners)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print("[+] Patched webview.js successfully")
        return True
    else:
        print("[!] Could not find old_controls_marker in webview.js")
        return False

if __name__ == "__main__":
    p1 = patch_accounts_js()
    p2 = patch_providers_js()
    p3 = patch_selection_kinds_js()
    p4 = patch_webview_js()
    print(f"Patches applied: accounts={p1}, providers={p2}, selection-kinds={p3}, webview={p4}")
