import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

res = server._resolve_catalog_sync(
    prov="netflix",
    title="The Union",
    year="2024",
    tmdb_id="845111",
    media_type="movie",
    poster=""
)

print("The Union result:", res is not None)
if res:
    print("Stream:", res.get("url"))
    print("Streams count:", len(res.get("altUrls", [])))
else:
    print("Result is None!")
