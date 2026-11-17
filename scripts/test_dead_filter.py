import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

orig_unp = server._is_unplayable_stream_url
server._is_unplayable_stream_url = lambda u: orig_unp(u) or any(d in str(u).lower() for d in ("makesomthingup", "dplayer82.site", "dplayer81", "dplayer80"))

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
print("Streams when dead domains are filtered:", len(streams or []))
for s in (streams or []):
    print("  -", s[1], s[0][:80])
