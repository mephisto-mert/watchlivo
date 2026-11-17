import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

res = server._resolve_catalog_sync(prov="film", title="Dune: Part Two", year="2024", tmdb_id="693134", media_type="movie", poster="")
print("Dune 2 res:", res is not None)
if res:
    print("URL:", res.get("url"))
    print("Alts:", len(res.get("altUrls", [])))
    for a in res.get("altUrls", []):
        print("  -", a[:80])
