import urllib.request
import re

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36", "Referer": "https://www.hdfilmcehennemi.nl/"}

for path in ["/dist/js/movie.js", "/movie.js", "/dist/js/app.js", "/dist/js/front.js"]:
    try:
        u = "https://www.hdfilmcehennemi.nl" + path
        req = urllib.request.Request(u, headers=headers)
        with urllib.request.urlopen(req, timeout=3.0) as r:
            js = r.read(1024*1024).decode("utf-8", errors="ignore")
            print("FOUND JS:", path, "len:", len(js))
            endpoints = re.findall(r'["\'](/[^"\']+(?:video|player|ajax|source|embed)[^"\']*)["\']', js)
            print("  Endpoints:", set(endpoints))
    except Exception as e:
        pass
