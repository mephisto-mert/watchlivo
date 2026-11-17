import urllib.request
import re

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Referer": "https://www.fullhdfilmizlesene.now/"
}

for query in ["Dune Çöl Gezegeni Bölüm İki", "Dune Part Two", "Dune 2"]:
    try:
        url = f"https://www.fullhdfilmizlesene.now/arama/{urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=4.0) as r:
            html = r.read(1024*1024).decode("utf-8", errors="ignore")
        links = re.findall(r'href=["\'](https://[^"\']*fullhdfilmizlesene\.[^/"\']+/film/[^"\']+)["\']', html)
        print(f"Query '{query}': found {len(links)} links:", links[:3])
    except Exception as e:
        print(f"Query '{query}' error:", e)
