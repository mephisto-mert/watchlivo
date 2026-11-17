import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from server import _resolve_fallback_poster_cdn_sync

test_titles = [
    ("Solo Leveling — 2. Sezon 12. Bölüm", "tv"),
    ("The Last of Us — 2. Sezon 1. Bölüm", "tv"),
    ("Stranger Things — 1. Sezon 1. Bölüm", "tv"),
    ("Don't Look Up (2021)", "movie"),
    ("Demon Slayer: Sonsuzluk Kalesi (2025)", "movie"),
    ("Below — S1:B1 - Sılaya Dönüş Yılı", "tv"),
    ("Organize İşler: Karun Hazinesi", "movie"),
    ("The Penguin", "tv"),
]

for t, mt in test_titles:
    res = _resolve_fallback_poster_cdn_sync(title=t, mtype=mt)
    print(f"{t} ({mt}) -> {res}")
