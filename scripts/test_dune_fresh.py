import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

print("Extracting fresh direct streams for Dune 2...")
streams = server._extract_direct_stream_sync(
    tid="693134",
    mtype="movie",
    s=1,
    e=1,
    title="Dune: Part Two",
    year="2024",
    refresh=True
)
print("Fresh streams for Dune 2:", len(streams or []))
for s in (streams or []):
    print("  -", s[1], s[0][:80])
