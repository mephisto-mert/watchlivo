import sys, time
sys.path.insert(0, "c:/Users/pc/Documents/projelerim/rave_web_platform")
from server import _resolve_catalog_sync

def test_resolve(title, tmdb_id, mtype, s=1, e=1):
    t0 = time.time()
    res = _resolve_catalog_sync(
        prov="cinema",
        title=title,
        year="",
        tmdb_id=tmdb_id,
        media_type=mtype,
        poster="",
        season=s,
        episode=e,
        imdb_id="",
        display_title=title,
        source_url="",
        refresh=False
    )
    dt = time.time() - t0
    stream_url = res.get("url") if res else None
    print(f"[{mtype}] {title} (tid: {tmdb_id}) -> took {dt:.2f}s | stream: {bool(stream_url)} | {stream_url[:70] if stream_url else 'NONE'}")
    return res

print("Testing resolve speeds:")
test_resolve("Don't Look Up", "", "movie")
test_resolve("The Last of Us", "100088", "tv", 2, 1)
test_resolve("Stranger Things", "", "tv", 1, 1)
test_resolve("Solo Leveling", "127532", "tv", 2, 12)
