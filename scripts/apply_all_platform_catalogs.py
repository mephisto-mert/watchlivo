from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
code = sk_file.read_text(encoding="utf-8")

# 1. Define mergeUniqueItems above renderCatalogKind
pos_cat_kind = code.find("export function renderCatalogKind(p, body, presetQuery, pick, pickFromUrl) {")
assert pos_cat_kind != -1, "renderCatalogKind not found"

merge_func_code = """export const mergeUniqueItems = (existing, incoming) => {
  const seen = new Set(existing.map((x) => `${x.mediaType}:${x.tmdbId || x.id}`));
  const out = [...existing];
  for (const it of (incoming || [])) {
    const k = `${it.mediaType}:${it.tmdbId || it.id}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
};

"""

# Insert mergeUniqueItems before renderCatalogKind if not already there
if "export const mergeUniqueItems =" not in code:
    code = code[:pos_cat_kind] + merge_func_code + code[pos_cat_kind:]
    print("Added mergeUniqueItems export before renderCatalogKind")

# 2. In renderCatalogKind: Remove authHolder and replace refreshAuth with clean direct run
# Find const authHolder = h('div', {});
pos_auth_holder = code.find("const authHolder = h('div', {});")
pos_refresh_auth = code.find("const refreshAuth = () => {", pos_auth_holder)
pos_scroll_detail = code.find("const scrollDetailIntoView = () => {", pos_refresh_auth)

old_auth_block = code[pos_auth_holder:pos_scroll_detail]

new_auth_block = """const refreshAuth = () => {
    mainWrap.classList.remove('hidden');
    if (!catalogLoaded) {
      catalogLoaded = true;
      run(input.value || presetQuery || '');
    }
    if (window.innerWidth > 960) setTimeout(() => input.focus(), 30);
  };
"""

code = code.replace(old_auth_block, new_auth_block, 1)
print("Replaced authHolder / refreshAuth block in renderCatalogKind")

# Replace body.append(authHolder, mainWrap, detailWrap); with body.append(mainWrap, detailWrap);
code = code.replace("body.append(authHolder, mainWrap, detailWrap);", "body.append(mainWrap, detailWrap);")
print("Removed authHolder from body.append in renderCatalogKind")

# 3. Replace renderMaxRavePortal and renderNetflixRavePortal with the rich dynamic implementations
pos_max = code.find("export function renderMaxRavePortal(p, body, presetQuery, pick, _pickFromUrl) {")
assert pos_max != -1, "renderMaxRavePortal not found"

new_portals_code = """export function renderMaxRavePortal(p, body, presetQuery, pick, _pickFromUrl) {
  const container = h('div', {
    class: 'max-rave-portal-view',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      maxWidth: '1280px',
      margin: '0 auto',
      padding: '4px 0 40px',
      color: '#ffffff',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
  });

  const navTabs = [
    { id: 'all', label: 'Tüm Katalog (1.770+)' },
    { id: 'hbo', label: '🔥 HBO Orijinalleri' },
    { id: 'warner', label: '🎬 Warner Bros. 4K' },
    { id: 'series', label: '📺 Diziler' },
    { id: 'movies', label: '🍿 Filmler' },
    { id: 'dc', label: '🦇 DC Evreni' },
  ];

  let currentTab = 'all';
  let currentPage = 1;
  let hasMore = true;
  let isLoading = false;
  let maxItems = [];

  const tabPillsWrap = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  });

  const renderNavTabs = () => {
    tabPillsWrap.replaceChildren(
      ...navTabs.map((t) => h('button', {
        type: 'button',
        class: `btn sm ${currentTab === t.id ? 'primary' : 'ghost'}`,
        style: {
          borderRadius: '20px',
          padding: '7px 16px',
          fontSize: '.84rem',
          fontWeight: currentTab === t.id ? '800' : '600',
          background: currentTab === t.id ? 'linear-gradient(135deg, #002be7, #4f46e5)' : 'rgba(255, 255, 255, 0.08)',
          border: currentTab === t.id ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.12)',
          color: '#ffffff',
          cursor: 'pointer',
          transition: 'all .2s ease',
        },
        onclick: () => {
          if (currentTab === t.id) return;
          currentTab = t.id;
          renderNavTabs();
          loadCatalog(true);
        },
      }, t.label))
    );
  };
  renderNavTabs();

  const topBar = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: '16px',
      padding: '16px 24px',
      borderRadius: '16px',
      background: 'linear-gradient(135deg, rgba(0, 43, 231, 0.32) 0%, rgba(13, 16, 27, 0.98) 100%)',
      border: '1px solid rgba(0, 43, 231, 0.55)',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' } },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: '4px',
          background: 'rgba(0, 43, 231, 0.35)',
          padding: '6px 14px',
          borderRadius: '10px',
          border: '1px solid rgba(59, 130, 246, 0.45)',
          cursor: 'pointer',
        },
        onclick: () => { currentTab = 'all'; renderNavTabs(); loadCatalog(true); },
      },
        h('span', { style: { fontSize: '24px', fontWeight: '900', letterSpacing: '-0.5px', color: '#ffffff' } }, 'HBO'),
        h('span', { style: { fontSize: '24px', fontWeight: '300', fontStyle: 'italic', color: '#ffffff' } }, 'max')
      ),
      tabPillsWrap
    )
  );

  const heroItem = {
    tmdbId: '194764',
    title: 'The Penguin',
    originalTitle: 'The Penguin',
    mediaType: 'tv',
    year: '2024',
    rating: '8.8',
    duration: '8 Bölüm',
    tags: ['TOP 10 DİZİ', '4K Ultra HD', '5.1 Dolby Audio', '2024 · 18+'],
    overview: 'Gotham City yeraltı dünyasının yeni efendisi Oswald Cobblepot. Carmine Falcone\\'un ölümünün ardından güç boşluğunu doldurmak için acımasız bir savaşa girişir.',
    backdrop: 'https://image.tmdb.org/t/p/w1280/4TdmuuwiIiKw3JOjIuhdgYxRXnN.jpg',
    poster: 'https://image.tmdb.org/t/p/w500/vOWcqC4oDQws1doDWLO7d3dh5qc.jpg',
  };

  const heroPlayBtn = h('button', {
    type: 'button',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '10px',
      background: 'linear-gradient(135deg, #002be7, #4f46e5)',
      color: '#ffffff',
      border: 'none',
      borderRadius: '8px',
      padding: '12px 26px',
      fontSize: '1.05rem',
      fontWeight: '900',
      cursor: 'pointer',
      boxShadow: '0 4px 20px rgba(0, 43, 231, 0.45)',
      transition: 'transform .15s ease, background .15s ease',
    },
    onmouseenter: (e) => { e.currentTarget.style.transform = 'scale(1.03)'; },
    onmouseleave: (e) => { e.currentTarget.style.transform = 'scale(1)'; },
    onclick: async () => {
      heroPlayBtn.disabled = true;
      heroPlayBtn.style.opacity = '0.7';
      toast(`🎬 "${heroItem.title}" hazırlanıyor, oda başlatılıyor...`);
      try {
        const res = await resolveCatalogItem(
          { tmdbId: heroItem.tmdbId, title: heroItem.title, originalTitle: heroItem.originalTitle, mediaType: heroItem.mediaType, provider: 'max' },
          p, 1, 1
        );
        if (res) await pick(res);
      } catch (err) {
        toast('Oda başlatılırken bir sorun oluştu.');
      } finally {
        heroPlayBtn.disabled = false;
        heroPlayBtn.style.opacity = '1';
      }
    },
  },
    h('span', { style: { fontSize: '1.25rem' } }, '▶'),
    h('span', {}, 'Odayı Başlat')
  );

  const heroInfoBtn = h('button', {
    type: 'button',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      background: 'rgba(255, 255, 255, 0.15)',
      color: '#ffffff',
      border: '1px solid rgba(255, 255, 255, 0.25)',
      borderRadius: '8px',
      padding: '12px 22px',
      fontSize: '1rem',
      fontWeight: '700',
      cursor: 'pointer',
      transition: 'background .15s ease, transform .15s ease',
    },
    onmouseenter: (e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.25)'; e.currentTarget.style.transform = 'scale(1.03)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'; e.currentTarget.style.transform = 'scale(1)'; },
    onclick: () => {
      toast(`ℹ️ ${heroItem.title} · Colin Farrell, Cristin Milioti · HBO Orijinal Mini Dizisi`);
    },
  },
    h('span', { style: { fontSize: '1.1rem' } }, 'ⓘ'),
    h('span', {}, 'Daha Fazla Bilgi')
  );

  const heroBillboard = h('div', {
    class: 'max-hero-billboard',
    style: {
      position: 'relative',
      minHeight: '340px',
      borderRadius: '20px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      padding: '36px 36px 32px',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.75)',
      backgroundImage: `linear-gradient(to right, rgba(10, 14, 28, 0.95) 20%, rgba(10, 14, 28, 0.65) 55%, rgba(0, 0, 0, 0.15) 100%), linear-gradient(to top, rgba(10, 14, 28, 0.95) 0%, transparent 60%), url('${heroItem.backdrop}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center 20%',
    },
  },
    h('div', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
    },
      h('span', {
        style: {
          background: 'linear-gradient(135deg, #002be7, #4f46e5)',
          color: '#fff',
          fontWeight: '900',
          fontSize: '.75rem',
          padding: '3px 8px',
          borderRadius: '4px',
          letterSpacing: '0.5px',
        },
      }, 'TOP 10 DİZİ'),
      ...heroItem.tags.map((tg) => h('span', {
        style: {
          fontSize: '.75rem',
          color: '#cbd5e1',
          background: 'rgba(255, 255, 255, 0.15)',
          padding: '3px 8px',
          borderRadius: '4px',
          fontWeight: '600',
        },
      }, tg))
    ),
    h('h1', {
      style: {
        fontSize: '2.4rem',
        fontWeight: '900',
        letterSpacing: '-0.5px',
        margin: '0 0 12px 0',
        color: '#ffffff',
        textShadow: '0 4px 16px rgba(0, 0, 0, 0.8)',
        maxWidth: '720px',
        lineHeight: '1.15',
      },
    }, heroItem.title),
    h('p', {
      style: {
        fontSize: '.95rem',
        color: '#e2e8f0',
        lineHeight: '1.5',
        maxWidth: '620px',
        margin: '0 0 20px 0',
        textShadow: '0 2px 8px rgba(0, 0, 0, 0.8)',
      },
    }, heroItem.overview),
    h('div', {
      style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
    },
      heroPlayBtn,
      heroInfoBtn
    )
  );

  const searchInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '🔍 HBO Max kütüphanesinde ara (örn: The Penguin, House of the Dragon, Succession, Dune)...',
    value: presetQuery || '',
    style: {
      flex: '1 1 360px',
      padding: '14px 18px',
      borderRadius: '12px',
      fontSize: '.95rem',
      background: 'rgba(15, 23, 42, 0.95)',
      border: '1px solid rgba(59, 130, 246, 0.4)',
      color: '#ffffff',
      outline: 'none',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    },
  });

  const searchBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      background: 'linear-gradient(135deg, #002be7 0%, #1d4ed8 100%)',
      borderColor: '#3b82f6',
      padding: '14px 24px',
      borderRadius: '12px',
      fontWeight: '800',
      fontSize: '.92rem',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0, 43, 231, 0.4)',
    },
  }, 'Ara');

  const searchWrap = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '4px 0' },
  }, searchInput, searchBtn);

  const makeMaxCard = (it) => {
    const isTv = it.mediaType === 'tv';
    const card = h('div', {
      class: 'vcard max-catalog-card',
      role: 'button',
      tabindex: '0',
      style: {
        background: 'rgba(15, 23, 42, 0.85)',
        border: '1px solid rgba(59, 130, 246, 0.15)',
        borderRadius: '12px',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'all .22s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      },
      onmouseenter: () => {
        card.style.transform = 'translateY(-6px) scale(1.02)';
        card.style.borderColor = '#3b82f6';
        card.style.boxShadow = '0 12px 28px rgba(0, 43, 231, 0.35)';
      },
      onmouseleave: () => {
        card.style.transform = 'translateY(0) scale(1)';
        card.style.borderColor = 'rgba(59, 130, 246, 0.15)';
        card.style.boxShadow = 'none';
      },
      onclick: async () => {
        if (isTv) {
          openTvSeriesModal(it, p, pick);
          return;
        }
        toast(`🎬 HBO Max "${it.title}" hazırlanıyor, oda başlatılıyor...`);
        try {
          const res = await resolveCatalogItem(
            { tmdbId: it.tmdbId, title: it.title, originalTitle: it.originalTitle, mediaType: it.mediaType, provider: 'max' },
            p, 1, 1
          );
          if (res) await pick(res);
        } catch (err) {
          toast('Oda başlatılırken bir sorun oluştu.');
        }
      },
    },
      h('div', {
        style: { position: 'relative', width: '100%', paddingTop: '148%', background: '#09090b', overflow: 'hidden' },
      },
        h('img', {
          src: it.poster || `/api/rave/poster?tid=${it.tmdbId || it.id}&t=${encodeURIComponent(it.title || '')}&mt=${it.mediaType || 'movie'}`,
          alt: it.title,
          loading: 'lazy',
          onerror: (e) => {
            if (!e.currentTarget.dataset.retried) {
              e.currentTarget.dataset.retried = '1';
              e.currentTarget.src = `/api/rave/poster?tid=${it.tmdbId || it.id}&t=${encodeURIComponent(it.title || '')}&mt=${it.mediaType || 'movie'}`;
            } else {
              e.currentTarget.src = '/static/watchlivo-poster.svg';
            }
          },
          style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' },
        }),
        h('div', {
          style: {
            position: 'absolute',
            top: '8px',
            left: '8px',
            background: 'linear-gradient(135deg, #002be7, #4f46e5)',
            color: '#fff',
            fontSize: '.68rem',
            fontWeight: '900',
            padding: '2px 7px',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
          },
        }, 'MAX'),
        h('div', {
          style: {
            position: 'absolute',
            bottom: '8px',
            right: '8px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: '#fbbf24',
            fontSize: '.72rem',
            fontWeight: '800',
            padding: '2px 6px',
            borderRadius: '4px',
          },
        }, `★ ${it.rating || '8.2'}`),
        h('div', {
          style: {
            position: 'absolute',
            bottom: '8px',
            left: '8px',
            background: isTv ? 'rgba(59, 130, 246, 0.85)' : 'rgba(147, 51, 234, 0.85)',
            color: '#ffffff',
            fontSize: '.66rem',
            fontWeight: '800',
            padding: '2px 6px',
            borderRadius: '4px',
          },
        }, isTv ? '📺 DİZİ' : '🎬 4K FİLM')
      ),
      h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 } },
        h('div', {
          style: {
            fontWeight: '800',
            fontSize: '.88rem',
            color: '#ffffff',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, it.title),
        h('div', {
          style: { fontSize: '.74rem', color: '#94a3b8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        },
          h('span', {}, it.year || '2024'),
          h('span', { style: { color: '#60a5fa', fontWeight: '700' } }, isTv ? 'Sezon Seç' : '▶ Hemen İzle')
        )
      )
    );
    return card;
  };

  const catalogGrid = h('div', {
    class: 'max-catalog-grid',
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      gap: '16px',
      minHeight: '400px',
    },
  });

  const loadMoreBtn = h('button', {
    type: 'button',
    class: 'btn secondary',
    style: {
      alignSelf: 'center',
      padding: '12px 30px',
      borderRadius: '12px',
      fontWeight: '800',
      fontSize: '.92rem',
      background: 'rgba(255, 255, 255, 0.08)',
      border: '1px solid rgba(59, 130, 246, 0.4)',
      color: '#ffffff',
      cursor: 'pointer',
      marginTop: '20px',
      display: 'none',
    },
    onclick: () => loadCatalog(false),
  }, '➕ Daha Fazla HBO Max İçeriği Yükle (1.770+ İçerik)');

  const loadCatalog = async (reset = false) => {
    if (isLoading || (!hasMore && !reset)) return;
    isLoading = true;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = '⏳ Yükleniyor...';

    if (reset) {
      currentPage = 1;
      hasMore = true;
      maxItems = [];
      catalogGrid.replaceChildren(
        h('div', {
          style: {
            padding: '60px 20px',
            textAlign: 'center',
            color: '#94a3b8',
            gridColumn: '1 / -1',
            fontSize: '1rem',
          },
        }, '⏳ HBO Max kütüphanesi yükleniyor...')
      );
    }

    try {
      const qVal = searchInput.value.trim();
      const params = {
        provider: 'max',
        page: currentPage,
        limit: 48,
      };
      if (qVal) {
        params.q = qVal;
      } else if (currentTab !== 'all') {
        params.category = currentTab;
      }

      const data = await api(`/api/rave/catalog?${qs(params)}`, { timeout: 12000 }).catch(() => ({ items: [] }));
      const newItems = data.items || [];

      if (reset) catalogGrid.replaceChildren();

      if (newItems.length) {
        maxItems = mergeUniqueItems(maxItems, newItems);
        catalogGrid.append(...newItems.map(makeMaxCard));
        currentPage++;
        hasMore = data.hasMore !== false && newItems.length >= 24;
      } else {
        hasMore = false;
        if (reset) {
          catalogGrid.replaceChildren(
            h('div', {
              style: {
                padding: '60px 20px',
                textAlign: 'center',
                color: '#94a3b8',
                gridColumn: '1 / -1',
                fontSize: '1rem',
              },
            }, `🔍 "${qVal}" araması için HBO Max kütüphanesinde içerik bulunamadı.`)
          );
        }
      }
    } finally {
      isLoading = false;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = hasMore ? '➕ Daha Fazla HBO Max İçeriği Yükle (1.770+ İçerik)' : '✓ Tüm Max Kataloğu Yüklendi';
      loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
    }
  };

  searchBtn.onclick = () => loadCatalog(true);
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') loadCatalog(true);
  };

  container.append(
    topBar,
    heroBillboard,
    searchWrap,
    catalogGrid,
    loadMoreBtn
  );

  body.replaceChildren(container);
  loadCatalog(true);
}

export function renderNetflixRavePortal(p, body, presetQuery, pick, _pickFromUrl) {
  const container = h('div', {
    class: 'netflix-rave-app-root',
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      maxWidth: '1280px',
      margin: '0 auto',
      padding: '4px 0 40px',
      color: '#ffffff',
      fontFamily: '"Netflix Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    },
  });

  const navTabs = [
    { id: 'all', label: 'Ana Sayfa' },
    { id: 'turkish', label: '🇹🇷 Türk Yapımları' },
    { id: 'trending', label: '🔥 Trendler' },
    { id: 'movies', label: '🎬 4K Filmler' },
    { id: 'series', label: '📺 Diziler' },
    { id: 'action', label: '💥 Aksiyon' },
    { id: 'comedy', label: '😂 Komedi' },
    { id: 'anime', label: '🌸 Anime' },
  ];

  let currentTab = 'all';
  let currentPage = 1;
  let hasMore = true;
  let isLoading = false;
  let netflixItems = [];

  const tabPillsWrap = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  });

  const renderNavTabs = () => {
    tabPillsWrap.replaceChildren(
      ...navTabs.map((t) => h('button', {
        type: 'button',
        class: `btn sm ${currentTab === t.id ? 'primary' : 'ghost'}`,
        style: {
          borderRadius: '20px',
          padding: '7px 16px',
          fontSize: '.84rem',
          fontWeight: currentTab === t.id ? '800' : '600',
          background: currentTab === t.id ? '#e50914' : 'rgba(255, 255, 255, 0.08)',
          border: currentTab === t.id ? '1px solid #e50914' : '1px solid rgba(255, 255, 255, 0.12)',
          color: currentTab === t.id ? '#ffffff' : '#cbd5e1',
          cursor: 'pointer',
          transition: 'all .2s ease',
        },
        onclick: () => {
          if (currentTab === t.id) return;
          currentTab = t.id;
          renderNavTabs();
          loadCatalog(true);
        },
      }, t.label))
    );
  };
  renderNavTabs();

  const topBar = h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: '16px',
      padding: '14px 22px',
      background: 'rgba(18, 18, 18, 0.95)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '16px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' } },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
        },
        onclick: () => { currentTab = 'all'; renderNavTabs(); loadCatalog(true); },
      },
        h('span', {
          style: {
            color: '#e50914',
            fontWeight: '900',
            fontSize: '1.85rem',
            letterSpacing: '1px',
            fontFamily: 'Impact, "Bebas Neue", sans-serif',
          },
        }, 'NETFLIX'),
        h('span', {
          style: {
            fontSize: '.72rem',
            background: 'rgba(229, 9, 20, 0.15)',
            border: '1px solid rgba(229, 9, 20, 0.4)',
            color: '#f87171',
            padding: '2px 8px',
            borderRadius: '6px',
            fontWeight: '700',
          },
        }, 'RESMİ KATALOG')
      ),
      tabPillsWrap
    )
  );

  const heroItem = {
    tmdbId: '577990',
    title: 'Organize İşler: Karun Hazinesi',
    originalTitle: 'Organize İşler: Karun Hazinesi',
    mediaType: 'tv',
    year: '2026',
    rating: '8.8',
    duration: '8 Bölüm',
    tags: ['TOP 10 DİZİ', '4K Ultra HD', '5.1 Dolby Audio', '2026 · 16+'],
    overview: 'Efsanevi Asım Noyan, jübilesini yapıp "mesleği" geride bırakmadan önce son performansını sergilemeye hazır. Peki ama usta dolandırıcı bu defa ateşle mi oynuyor?',
    backdrop: 'https://image.tmdb.org/t/p/w1280/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg',
    poster: 'https://image.tmdb.org/t/p/w500/p5vsOFlPOfdBEXSgrW9fcxdfJNC.jpg',
  };

  const heroPlayBtn = h('button', {
    type: 'button',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '10px',
      background: '#ffffff',
      color: '#000000',
      border: 'none',
      borderRadius: '8px',
      padding: '12px 26px',
      fontSize: '1.05rem',
      fontWeight: '900',
      cursor: 'pointer',
      boxShadow: '0 4px 20px rgba(255, 255, 255, 0.35)',
      transition: 'transform .15s ease, background .15s ease',
    },
    onmouseenter: (e) => { e.currentTarget.style.background = '#e6e6e6'; e.currentTarget.style.transform = 'scale(1.03)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = '#ffffff'; e.currentTarget.style.transform = 'scale(1)'; },
    onclick: async () => {
      heroPlayBtn.disabled = true;
      heroPlayBtn.style.opacity = '0.7';
      toast(`🎬 "${heroItem.title}" hazırlanıyor, oda başlatılıyor...`);
      try {
        const res = await resolveCatalogItem(
          { tmdbId: heroItem.tmdbId, title: heroItem.title, originalTitle: heroItem.originalTitle, mediaType: heroItem.mediaType, provider: 'netflix' },
          p, 1, 1
        );
        if (res) await pick(res);
      } catch (err) {
        toast('Oda başlatılırken bir sorun oluştu.');
      } finally {
        heroPlayBtn.disabled = false;
        heroPlayBtn.style.opacity = '1';
      }
    },
  },
    h('span', { style: { fontSize: '1.25rem' } }, '▶'),
    h('span', {}, 'Oynat (Odayı Kur)')
  );

  const heroInfoBtn = h('button', {
    type: 'button',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      background: 'rgba(109, 109, 110, 0.7)',
      color: '#ffffff',
      border: 'none',
      borderRadius: '8px',
      padding: '12px 22px',
      fontSize: '1rem',
      fontWeight: '700',
      cursor: 'pointer',
      transition: 'background .15s ease, transform .15s ease',
    },
    onmouseenter: (e) => { e.currentTarget.style.background = 'rgba(109, 109, 110, 0.9)'; e.currentTarget.style.transform = 'scale(1.03)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = 'rgba(109, 109, 110, 0.7)'; e.currentTarget.style.transform = 'scale(1)'; },
    onclick: () => {
      toast(`ℹ️ ${heroItem.title} · Yılmaz Erdoğan, Kıvanç Tatlıtuğ, Ezgi Mola · Netflix Orijinal Yapımı`);
    },
  },
    h('span', { style: { fontSize: '1.1rem' } }, 'ⓘ'),
    h('span', {}, 'Daha Fazla Bilgi')
  );

  const heroBillboard = h('div', {
    class: 'netflix-hero-billboard',
    style: {
      position: 'relative',
      minHeight: '340px',
      borderRadius: '20px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      padding: '36px 36px 32px',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.75)',
      backgroundImage: `linear-gradient(to right, rgba(0, 0, 0, 0.92) 20%, rgba(0, 0, 0, 0.65) 55%, rgba(0, 0, 0, 0.15) 100%), linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 60%), url('${heroItem.backdrop}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center 20%',
    },
  },
    h('div', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
    },
      h('span', {
        style: {
          background: '#e50914',
          color: '#fff',
          fontWeight: '900',
          fontSize: '.75rem',
          padding: '3px 8px',
          borderRadius: '4px',
          letterSpacing: '0.5px',
        },
      }, 'TOP 10 FİLM'),
      ...heroItem.tags.map((tg) => h('span', {
        style: {
          fontSize: '.75rem',
          color: '#cbd5e1',
          background: 'rgba(255, 255, 255, 0.15)',
          padding: '3px 8px',
          borderRadius: '4px',
          fontWeight: '600',
        },
      }, tg))
    ),
    h('h1', {
      style: {
        fontSize: '2.4rem',
        fontWeight: '900',
        letterSpacing: '-0.5px',
        margin: '0 0 12px 0',
        color: '#ffffff',
        textShadow: '0 4px 16px rgba(0, 0, 0, 0.8)',
        maxWidth: '720px',
        lineHeight: '1.15',
      },
    }, heroItem.title),
    h('p', {
      style: {
        fontSize: '.95rem',
        color: '#e2e8f0',
        lineHeight: '1.5',
        maxWidth: '620px',
        margin: '0 0 20px 0',
        textShadow: '0 2px 8px rgba(0, 0, 0, 0.8)',
      },
    }, heroItem.overview),
    h('div', {
      style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
    },
      heroPlayBtn,
      heroInfoBtn
    )
  );

  const searchInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '🔍 Netflix kütüphanesinde film veya dizi ara (örn: Organize İşler, Stranger Things, Narcos)...',
    value: presetQuery || '',
    style: {
      flex: '1 1 360px',
      padding: '14px 18px',
      borderRadius: '12px',
      fontSize: '.95rem',
      background: 'rgba(24, 24, 27, 0.95)',
      border: '1px solid rgba(229, 9, 20, 0.4)',
      color: '#ffffff',
      outline: 'none',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    },
  });

  const searchBtn = h('button', {
    type: 'button',
    class: 'btn primary',
    style: {
      background: 'linear-gradient(135deg, #e50914 0%, #b20710 100%)',
      borderColor: '#e50914',
      padding: '14px 24px',
      borderRadius: '12px',
      fontWeight: '800',
      fontSize: '.92rem',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(229, 9, 20, 0.4)',
    },
  }, 'Ara');

  const searchWrap = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '4px 0' },
  }, searchInput, searchBtn);

  const makeNetflixCard = (it) => {
    const isTv = it.mediaType === 'tv';
    const card = h('div', {
      class: 'vcard netflix-catalog-card',
      role: 'button',
      tabindex: '0',
      style: {
        background: 'rgba(24, 24, 27, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '12px',
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'all .22s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      },
      onmouseenter: () => {
        card.style.transform = 'translateY(-6px) scale(1.02)';
        card.style.borderColor = '#e50914';
        card.style.boxShadow = '0 12px 28px rgba(229, 9, 20, 0.35)';
      },
      onmouseleave: () => {
        card.style.transform = 'translateY(0) scale(1)';
        card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        card.style.boxShadow = 'none';
      },
      onclick: async () => {
        if (isTv) {
          openTvSeriesModal(it, p, pick);
          return;
        }
        toast(`🎬 Netflix "${it.title}" hazırlanıyor, oda başlatılıyor...`);
        try {
          const res = await resolveCatalogItem(
            { tmdbId: it.tmdbId, title: it.title, originalTitle: it.originalTitle, mediaType: it.mediaType, provider: 'netflix' },
            p, 1, 1
          );
          if (res) await pick(res);
        } catch (err) {
          toast('Oda başlatılırken bir sorun oluştu.');
        }
      },
    },
      h('div', {
        style: { position: 'relative', width: '100%', paddingTop: '148%', background: '#09090b', overflow: 'hidden' },
      },
        h('img', {
          src: it.poster || `/api/rave/poster?tid=${it.tmdbId || it.id}&t=${encodeURIComponent(it.title || '')}&mt=${it.mediaType || 'movie'}`,
          alt: it.title,
          loading: 'lazy',
          onerror: (e) => {
            if (!e.currentTarget.dataset.retried) {
              e.currentTarget.dataset.retried = '1';
              e.currentTarget.src = `/api/rave/poster?tid=${it.tmdbId || it.id}&t=${encodeURIComponent(it.title || '')}&mt=${it.mediaType || 'movie'}`;
            } else {
              e.currentTarget.src = '/static/watchlivo-poster.svg';
            }
          },
          style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' },
        }),
        h('div', {
          style: {
            position: 'absolute',
            top: '8px',
            left: '8px',
            background: 'linear-gradient(135deg, #e50914, #b20710)',
            color: '#fff',
            fontSize: '.7rem',
            fontWeight: '900',
            padding: '2px 7px',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
          },
        }, 'N'),
        h('div', {
          style: {
            position: 'absolute',
            bottom: '8px',
            right: '8px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: '#fbbf24',
            fontSize: '.72rem',
            fontWeight: '800',
            padding: '2px 6px',
            borderRadius: '4px',
          },
        }, `★ ${it.rating || '8.0'}`),
        h('div', {
          style: {
            position: 'absolute',
            bottom: '8px',
            left: '8px',
            background: isTv ? 'rgba(59, 130, 246, 0.85)' : 'rgba(229, 9, 20, 0.85)',
            color: '#ffffff',
            fontSize: '.66rem',
            fontWeight: '800',
            padding: '2px 6px',
            borderRadius: '4px',
          },
        }, isTv ? '📺 DİZİ' : '🎬 4K FİLM')
      ),
      h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 } },
        h('div', {
          style: {
            fontWeight: '800',
            fontSize: '.88rem',
            color: '#ffffff',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, it.title),
        h('div', {
          style: { fontSize: '.74rem', color: '#94a3b8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        },
          h('span', {}, it.year || '2024'),
          h('span', { style: { color: '#f87171', fontWeight: '700' } }, isTv ? 'Sezon Seç' : '▶ Hemen İzle')
        )
      )
    );
    return card;
  };

  const catalogGrid = h('div', {
    class: 'netflix-catalog-grid',
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      gap: '16px',
      minHeight: '400px',
    },
  });

  const loadMoreBtn = h('button', {
    type: 'button',
    class: 'btn secondary',
    style: {
      alignSelf: 'center',
      padding: '12px 30px',
      borderRadius: '12px',
      fontWeight: '800',
      fontSize: '.92rem',
      background: 'rgba(255, 255, 255, 0.08)',
      border: '1px solid rgba(229, 9, 20, 0.4)',
      color: '#ffffff',
      cursor: 'pointer',
      marginTop: '20px',
      display: 'none',
    },
    onclick: () => loadCatalog(false),
  }, '➕ Daha Fazla Netflix İçeriği Yükle (5.700+ Film & Dizi)');

  const loadCatalog = async (reset = false) => {
    if (isLoading || (!hasMore && !reset)) return;
    isLoading = true;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = '⏳ Yükleniyor...';

    if (reset) {
      currentPage = 1;
      hasMore = true;
      netflixItems = [];
      catalogGrid.replaceChildren(
        h('div', {
          style: {
            padding: '60px 20px',
            textAlign: 'center',
            color: '#94a3b8',
            gridColumn: '1 / -1',
            fontSize: '1rem',
          },
        }, '⏳ Netflix kütüphanesi yükleniyor...')
      );
    }

    try {
      const qVal = searchInput.value.trim();
      const params = {
        provider: 'netflix',
        page: currentPage,
        limit: 48,
      };
      if (qVal) {
        params.q = qVal;
      } else if (currentTab !== 'all') {
        params.category = currentTab;
      }

      const data = await api(`/api/rave/catalog?${qs(params)}`, { timeout: 12000 }).catch(() => ({ items: [] }));
      const newItems = data.items || [];

      if (reset) catalogGrid.replaceChildren();

      if (newItems.length) {
        netflixItems = mergeUniqueItems(netflixItems, newItems);
        catalogGrid.append(...newItems.map(makeNetflixCard));
        currentPage++;
        hasMore = data.hasMore !== false && newItems.length >= 24;
      } else {
        hasMore = false;
        if (reset) {
          catalogGrid.replaceChildren(
            h('div', {
              style: {
                padding: '60px 20px',
                textAlign: 'center',
                color: '#94a3b8',
                gridColumn: '1 / -1',
                fontSize: '1rem',
              },
            }, `🔍 "${qVal}" araması için Netflix kütüphanesinde içerik bulunamadı.`)
          );
        }
      }
    } finally {
      isLoading = false;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = hasMore ? '➕ Daha Fazla Netflix İçeriği Yükle (5.700+ Film & Dizi)' : '✓ Tüm Netflix Kataloğu Yüklendi';
      loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
    }
  };

  searchBtn.onclick = () => loadCatalog(true);
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') loadCatalog(true);
  };

  container.append(
    topBar,
    heroBillboard,
    searchWrap,
    catalogGrid,
    loadMoreBtn
  );

  body.replaceChildren(container);
  loadCatalog(true);
}
"""

# Replace from pos_max to the end of the file with new_portals_code
code = code[:pos_max] + new_portals_code
sk_file.write_text(code, encoding="utf-8")
print("Successfully updated selection-kinds.js with full dynamic Netflix and Max portals, zero account logins!")
