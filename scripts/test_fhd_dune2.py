import urllib.request
import re

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Referer": "https://www.fullhdfilmizlesene.now/"
}

candidates = [
    "https://www.fullhdfilmizlesene.now/film/dune-col-gezegeni-bolum-iki/",
    "https://www.fullhdfilmizlesene.now/film/dune-col-gezegeni-bolum-2/",
    "https://www.fullhdfilmizlesene.now/film/dune-part-two/",
    "https://www.fullhdfilmizlesene.now/film/dune-bolum-iki/",
    "https://www.fullhdfilmizlesene.now/film/dune-2/",
]

for u in candidates:
    try:
        req = urllib.request.Request(u, headers=headers)
        with urllib.request.urlopen(req, timeout=3.0) as r:
            print("FOUND CANDIDATE:", u, "Status:", r.status)
    except Exception as e:
        # print("Not found:", u)
        pass
