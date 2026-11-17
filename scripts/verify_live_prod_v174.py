import urllib.request
import urllib.parse
import json

print("=== 1. VERIFYING LIVE POSTER RESOLUTION ===")
titles = [
    ("Solo Leveling — 2. Sezon 12. Bölüm", "tv"),
    ("Don't Look Up (2021)", "movie"),
    ("The Last of Us — 2. Sezon 1. Bölüm", "tv"),
    ("Stranger Things — 1. Sezon 1. Bölüm", "tv"),
    ("Demon Slayer: Sonsuzluk Kalesi (2025)", "movie"),
    ("Below — S1:B1 - Sılaya Dönüş Yılı", "tv"),
    ("The Penguin", "tv"),
    ("Organize İşler: Karun Hazinesi", "movie"),
]

for t, mt in titles:
    qp = urllib.parse.urlencode({'t': t, 'mt': mt})
    u = f"https://watchlivo.online/api/rave/poster?{qp}"
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            final_url = resp.geturl()
            status = resp.status
            print(f"[OK] {t} ({mt}) -> {status} | {final_url}")
    except Exception as e:
        print(f"[FAIL] {t} -> {e}")

print("\n=== 2. VERIFYING LIVE SELECTION-KINDS.JS CONTENT ===")
js_url = "https://watchlivo.online/static/js/views/selection-kinds.js?v=20261110_v181"
req = urllib.request.Request(js_url, headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
with urllib.request.urlopen(req, timeout=12) as resp:
    js_text = resp.read().decode('utf-8', errors='ignore')

checks = [
    ("Netflix (Şifresiz)", False),
    ("jo***@gmail.com", False),
    ("Doğrudan Max Bağlantısı", False),
    ("max-gating-hero", False),
    ("netflix-gating-hero", False),
    ("Tüm Katalog (1.770+)", True),
    ("Ana Sayfa (5.700+)", True),
    ("netflix-hero-billboard", True),
    ("max-hero-billboard", True),
    ("api(`/api/rave/catalog?${qs(params)}`", True),
]

for phrase, should_exist in checks:
    exists = phrase in js_text
    passed = (exists == should_exist)
    status_str = "PASS" if passed else "FAIL"
    print(f"[{status_str}] '{phrase}' in JS: {exists} (expected: {should_exist})")
