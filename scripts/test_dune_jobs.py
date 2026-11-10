import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

# Let's inspect _extract_direct_stream_sync with fresh search
meta = server._get_tmdb_meta_sync("693134", "movie", "Dune: Part Two")
print("Meta:", meta.get("title"), meta.get("origLang"), meta.get("year"))

# Test extracting with HDFC forced fresh
s_res = server._extract_streams_for_movie_sync(
    tid="693134",
    mtype="movie",
    s=1,
    e=1,
    meta=meta,
    orig_title="Dune: Part Two",
    tr_title="Dune: Çöl Gezegeni Bölüm İki",
    year="2024",
    imdb_id="tt15239678",
    disp_title="Dune: Part Two",
    source_url="",
    extra_titles=["Dune: Part Two", "Dune 2", "Dune: Çöl Gezegeni Bölüm İki"],
    ekey="movie:693134:1:1",
    s_split=1,
    e_split=1,
    s_tmdb=1,
    e_tmdb=1,
    refresh=True
)
print("Extracted streams for Dune 2:", len(s_res))
for s in s_res:
    print("  -", s[1], s[0][:80])
