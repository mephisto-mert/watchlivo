import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

# Temporarily patch _is_unplayable_stream_url to filter makesomthingup
orig_unp = server._is_unplayable_stream_url
server._is_unplayable_stream_url = lambda u: orig_unp(u) or "makesomthingup" in str(u).lower()

res = server._extract_direct_stream_sync(
    tid="693134",
    mtype="movie",
    s=1,
    e=1,
    title="Dune: Part Two",
    year="2024",
    refresh=True
)
print("Streams without makesomthingup:", len(res or []))
for r in (res or []):
    print("  -", r[1], r[0][:80])
