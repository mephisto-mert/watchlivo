import os
import sys

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

res = server._resolve_catalog_sync(
    prov="film",
    title="Dune: Part Two",
    year="2024",
    tmdb_id="693134",
    media_type="movie",
    poster="",
    season=1,
    episode=1,
    imdb_id="",
    display_title="Dune: Çöl Gezegeni Bölüm İki",
    source_url="",
    refresh=True,
)

print("STATUS:", res.get("status"))
print("DIRECT_LIST_LEN:", len(res.get("direct_list", [])))
print("RAW RESOLVE RES:")
print(res)
