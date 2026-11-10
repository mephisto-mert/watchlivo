from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent

# ==============================================================================
# 1. PATCH server.py
# ==============================================================================
server_file = ROOT / "server.py"
server_code = server_file.read_text(encoding="utf-8")

# Fix Solo Leveling in _CURATED_ACTIVE_SERIES_SEEDS
server_code = server_code.replace(
    '"poster": "https://image.tmdb.org/t/p/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg"',
    '"poster": "https://image.tmdb.org/t/p/w500/eCD7WS9h4lCT8N4Xavc9u8R1IGk.jpg"'
)

# In _resolve_fallback_poster_cdn_sync: strip season/episode patterns and safe get
old_clean_block = """    cands: list[str] = []
    for raw_t in (orig_title, title):
        s = re.sub(r"\\(\\d{4}\\)", "", str(raw_t or "")).strip()
        s = re.sub(r"\\b(izle|full|hd|turkce|dublaj|altyazili)\\b", "", s, flags=re.I).strip()
        s2 = re.sub(r"\\s+\\d{4}$", "", s).strip()"""

new_clean_block = """    cands: list[str] = []
    for raw_t in (orig_title, title):
        s = re.sub(r"\\(\\d{4}\\)", "", str(raw_t or "")).strip()
        s = re.sub(r"\\b(izle|full|hd|turkce|dublaj|altyazili)\\b", "", s, flags=re.I).strip()
        s = re.sub(r"\\s*(?:[—–-]\\s*)?(?:\\d+\\.\\s*Sezon|\\d+\\.\\s*Bölüm|S\\d+\\s*:\\s*B\\d+|Sezon\\s*\\d+|Bölüm\\s*\\d+).*$", "", s, flags=re.I).strip()
        s = s.split(" — ")[0].split(" - ")[0].strip()
        s2 = re.sub(r"\\s+\\d{4}$", "", s).strip()"""

if old_clean_block in server_code:
    server_code = server_code.replace(old_clean_block, new_clean_block, 1)
    print("Updated server.py candidate cleaning in _resolve_fallback_poster_cdn_sync")

# Safe get in line 9815
server_code = server_code.replace(
    'res_list = _http_json(u_tm, timeout=3.2).get("results") or []',
    'res_list = (_http_json(u_tm, timeout=3.2) or {}).get("results") or []'
)

server_file.write_text(server_code, encoding="utf-8")
print("Saved server.py")

# ==============================================================================
# 2. PATCH static/js/store.js
# ==============================================================================
store_file = ROOT / "static/js/store.js"
store_code = store_file.read_text(encoding="utf-8")

# Replace getWatchHistory() item mapping
old_store_hist = """      // Fix Solo Leveling mismatched One Piece backdrop/poster
      if (/solo leveling/i.test(titleStr) && (bdrop.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG') || thumb.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG') || poster.includes('4Mt7WHox67uJ1yErwTBFcV8KWgG'))) {
        poster = 'https://image.tmdb.org/t/p/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/xMNH87maNLt9n2bMDYeI6db5VFm.jpg';
        thumb = poster;
        itMod = true;
      }"""

new_store_hist = """      // Explicit TMDB mapping for popular/history items to eliminate mismatches
      const lowT = titleStr.toLowerCase();
      if (lowT.includes('solo leveling')) {
        poster = 'https://image.tmdb.org/t/p/w500/eCD7WS9h4lCT8N4Xavc9u8R1IGk.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/xMNH87maNLt9n2bMDYeI6db5VFm.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes(\"don't look up\")) {
        poster = 'https://image.tmdb.org/t/p/w500/j42pUYxgO0zg414d3PG3ug6OcJG.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/nvxrQQspxmSblCYDtvDAbVFX8Jt.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes('the last of us')) {
        poster = 'https://image.tmdb.org/t/p/w500/uKvVjHNqB5VmOrdxqAt2F7J78ED.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/uDgy6hyPd82kOHh6I95FLtLnj6p.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes('stranger things')) {
        poster = 'https://image.tmdb.org/t/p/w500/49WJfeN0moxb9IPfGn8AIqMGskD.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/56v2KjBlU4XaOv9rVYEQypROD7P.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes('demon slayer')) {
        poster = 'https://image.tmdb.org/t/p/w500/eIM28fkVIhPKkjOjfS01UAZXPM8.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/1RgPyOhN4DRs225BGTlHJqCudII.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes('below')) {
        poster = 'https://image.tmdb.org/t/p/w500/vgLqqhMUbljp585qPp1EFCyJtcz.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/cn0feYcDvVzVjUDoXa1O8sRgzz.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes('the penguin') || lowT.includes('penguin')) {
        poster = 'https://image.tmdb.org/t/p/w500/vOWcqC4oDQws1doDWLO7d3dh5qc.jpg';
        bdrop = 'https://image.tmdb.org/t/p/w780/4TdmuuwiIiKw3JOjIuhdgYxRXnN.jpg';
        thumb = bdrop;
        itMod = true;
      } else if (lowT.includes('organize işler')) {
        poster = 'https://image.tmdb.org/t/p/w500/p5vsOFlPOfdBEXSgrW9fcxdfJNC.jpg';
        bdrop = 'https://image.tmdb.org/t/p/original/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg';
        thumb = bdrop;
        itMod = true;
      }"""

if old_store_hist in store_code:
    store_code = store_code.replace(old_store_hist, new_store_hist, 1)
    print("Updated getWatchHistory in static/js/store.js")

# In cleanT inside getWatchHistory: also strip season/episode patterns
store_code = store_code.replace(
    "const cleanT = titleStr.replace(/\\s*(?:[—–-]\\s*)?(?:S\\d+\\s*:\\s*B\\d+|\\d+\\.\\s*Sezon\\s*\\d+\\.\\s*Bölüm).*$/i, '').split(' — ')[0].replace(/\\s*\\(\\s*(?:19|20)\\d{2}\\s*\\)\\s*$/, '').trim();",
    "const cleanT = titleStr.replace(/\\s*(?:[—–-]\\s*)?(?:\\d+\\.\\s*Sezon|\\d+\\.\\s*Bölüm|S\\d+\\s*:\\s*B\\d+|Sezon\\s*\\d+|Bölüm\\s*\\d+).*$/i, '').split(' — ')[0].split(' - ')[0].replace(/\\s*\\(\\s*(?:19|20)\\d{2}\\s*\\)\\s*$/, '').trim();"
)

store_file.write_text(store_code, encoding="utf-8")
print("Saved static/js/store.js")

# ==============================================================================
# 3. PATCH static/js/views/selection.js
# ==============================================================================
sel_file = ROOT / "static/js/views/selection.js"
sel_code = sel_file.read_text(encoding="utf-8")

# Fix Solo Leveling curated seed at line 492
old_seed = "{ id: 'ep-127532-s2e12', tmdbId: '127532', mediaType: 'tv', title: 'Solo Leveling', originalTitle: 'Ore dake Level Up na Ken', season: 2, episode: 12, episodeLabel: 'S2:B12', episodeTitle: 'Arise from the Shadow', sourceBadge: '⛩️ Yeni Anime Bölümü', provider: 'cinema', poster: 'https://image.tmdb.org/t/p/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/4Mt7WHox67uJ1yErwTBFcV8KWgG.jpg', year: '2025', rating: 8.7 }"
new_seed = "{ id: 'ep-127532-s2e12', tmdbId: '127532', mediaType: 'tv', title: 'Solo Leveling', originalTitle: 'Ore dake Level Up na Ken', season: 2, episode: 12, episodeLabel: 'S2:B12', episodeTitle: 'Arise from the Shadow', sourceBadge: '⛩️ Yeni Anime Bölümü', provider: 'cinema', poster: 'https://image.tmdb.org/t/p/w500/eCD7WS9h4lCT8N4Xavc9u8R1IGk.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/xMNH87maNLt9n2bMDYeI6db5VFm.jpg', year: '2025', rating: 8.7 }"

if old_seed in sel_code:
    sel_code = sel_code.replace(old_seed, new_seed, 1)
    print("Updated Solo Leveling seed in selection.js")

sel_file.write_text(sel_code, encoding="utf-8")
print("Saved static/js/views/selection.js")
