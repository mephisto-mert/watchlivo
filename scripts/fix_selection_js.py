# -*- coding: utf-8 -*-
from pathlib import Path

path = Path("static/js/views/selection.js")
content = path.read_text(encoding="utf-8")

old_block = """  if (provider === \\'max\\') {
    const p = getProvider(\\'max\\');
    const directMedia = {
      provider: \\'max\\',
      catalogProvider: \\'max\\',
      url: url || \\'https://play.max.com\\',
      sourceUrl: url || \\'https://play.max.com\\',
      officialUrl: url || \\'https://play.max.com\\',
      streamType: \\'official\\',
      title: fallbackTitle || \\'Max (HBO) Canlı Yayını\\',
      channel: \\'Max (HBO) · Canlı Oda Köprüsü\\',
      authenticated: true,
      duration: 3600,
    };
    if (window.vortexDesktop?.isElectron) return directMedia;
    try {
      const res = await resolveCatalogItem({ sourceUrl: url, title: fallbackTitle || id || \\'Max\\' }, p);
      if (res) return res;
    } catch (_) {}
    return directMedia;
  }"""

new_block = """  if (provider === 'max') {
    const p = getProvider('max');
    const directMedia = {
      provider: 'max',
      catalogProvider: 'max',
      url: url || 'https://play.max.com',
      sourceUrl: url || 'https://play.max.com',
      officialUrl: url || 'https://play.max.com',
      streamType: 'official',
      title: fallbackTitle || 'Max (HBO) Canlı Yayını',
      channel: 'Max (HBO) · Canlı Oda Köprüsü',
      authenticated: true,
      duration: 3600,
    };
    if (window.vortexDesktop?.isElectron) return directMedia;
    try {
      const res = await resolveCatalogItem({ sourceUrl: url, title: fallbackTitle || id || 'Max' }, p);
      if (res) return res;
    } catch (_) {}
    return directMedia;
  }"""

if old_block in content:
    content = content.replace(old_block, new_block)
    path.write_text(content, encoding="utf-8")
    print("[+] Fixed selection.js")
else:
    print("[!] old_block not found in selection.js")
