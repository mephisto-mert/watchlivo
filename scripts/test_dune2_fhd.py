import urllib.request
import urllib.parse
import re

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
s_u = f"https://www.fullhdfilmizlesene.now/arama/{urllib.parse.quote('Dune Bölüm İki')}"
req = urllib.request.Request(s_u, headers={"User-Agent": UA, "Referer": "https://www.fullhdfilmizlesene.now/"})
try:
    with urllib.request.urlopen(req, timeout=5.0) as r:
        html = r.read().decode("utf-8", errors="ignore")
    cards = re.findall(r'<span class="film-title">([^<]+)</span>.*?href=["\'](https://[^"\']*fullhdfilmizlesene\.[^/"\']+/film/[^"\']+)["\']', html, re.S)
    print("Dune 2 Cards on FHD:", cards)
except Exception as e:
    print("Error:", e)
