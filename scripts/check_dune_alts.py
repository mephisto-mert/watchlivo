import base64
import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

res = server._resolve_catalog_sync(prov="film", title="Dune: Part Two", year="2024", tmdb_id="693134", media_type="movie", poster="")
for i, a in enumerate(res.get("altUrls", [])):
    # decode sid
    import urllib.parse
    q = urllib.parse.parse_qs(urllib.parse.urlparse(a).query)
    sid = q.get("sid", [""])[0]
    if sid:
        pad = sid + "=" * ((4 - len(sid) % 4) % 4)
        target = base64.urlsafe_b64decode(pad.encode("ascii")).decode("utf-8")
        print(f"Alt {i}: {target}")
