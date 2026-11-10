import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

# Let's inspect where Dune 2 gets streams
streams = server._extract_direct_stream_sync(
    tid="693134",
    mtype="movie",
    s=1,
    e=1,
    title="Dune: Part Two",
    year="2024",
    imdb_id="tt15239678",
    disp_title="Dune: Part Two",
    refresh=True
)
print("Direct streams for Dune 2:", len(streams or []))
for s in (streams or []):
    print("  -", s[1], s[0][:80])
