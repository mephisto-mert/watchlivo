import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server
import urllib.request
import re

# How does ddizimag search?
# Let's check server.py _extract_ddizimag_sync
UA137 = server.UA137

for q in ["dune", "dune-2", "dune-part-two"]:
    try:
        u = f"https://ddizimag.com/arama?q={q}"
        req = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://ddizimag.com/"})
        with urllib.request.urlopen(req, timeout=4.0) as r:
            html = r.read(1024*1024).decode("utf-8", errors="ignore")
        links = re.findall(r'href=["\'](https://ddizimag\.com/[^"\']+)["\']', html)
        print("ddizimag query:", q, "links:", set(links))
    except Exception as e:
        print("ddizimag error on", q, ":", e)
