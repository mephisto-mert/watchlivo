import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server
import urllib.request
import json

# Cinejoy test
imdb_id = "tt15239678"
try:
    cj_u = f"https://cinejoy.site/api/source/{imdb_id}"
    req = urllib.request.Request(cj_u, headers={"User-Agent": server.UA137, "Referer": "https://cinejoy.site/"})
    with urllib.request.urlopen(req, timeout=4.0) as r:
        cj_data = json.loads(r.read().decode())
    print("Cinejoy response:", cj_data)
except Exception as e:
    print("Cinejoy error:", e)
