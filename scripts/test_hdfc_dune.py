import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

meta = server._get_tmdb_meta_sync("693134", "movie", "Dune: Part Two")
hdfc = server._extract_hdfc_sync(
    mtype="movie",
    s=1,
    e=1,
    title=meta.get("originalTitle"),
    disp_title=meta.get("trTitle"),
    ekey="movie:693134:1:1",
    year="2024",
    imdb_id=meta.get("imdbId"),
    extra_titles=["Dune: Çöl Gezegeni Bölüm İki", "Dune: Part Two", "Dune 2"],
    source_url="",
    tid="693134",
    refresh=True
)
print("HDFC results for Dune 2:", hdfc)
