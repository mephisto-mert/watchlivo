import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from server import _resolve_fallback_poster_cdn_sync

test_items = [
    {"title": "Don't Look Up", "year": "2021", "mtype": "movie", "tid": "646380"},
    {"title": "The Last of Us", "year": "2023", "mtype": "tv", "tid": "100088"},
    {"title": "Stranger Things", "year": "2016", "mtype": "tv", "tid": "66732"},
    {"title": "Solo Leveling", "year": "2024", "mtype": "tv", "tid": "127532"},
    {"title": "Organize İşler", "year": "2019", "mtype": "movie", "tid": "577990"},
    {"title": "Organize İşler: Karun Hazinesi", "year": "2026", "mtype": "movie", "tid": "1806389"},
]

for item in test_items:
    res = _resolve_fallback_poster_cdn_sync(
        title=item["title"],
        year=item["year"],
        mtype=item["mtype"],
        tmdb_id=item["tid"]
    )
    print(f"{item['title']} -> {res}")
