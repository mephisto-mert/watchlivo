import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

hits = server._tmdb_sync("The Union")
for h in hits[:5]:
    print(f"Title: {h.get('title')} | Year: {h.get('year')} | TMDB: {h.get('tmdbId') or h.get('id')} | MediaType: {h.get('mediaType')}")
