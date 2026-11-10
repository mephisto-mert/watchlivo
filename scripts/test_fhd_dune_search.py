import urllib.request
import re

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Referer": "https://www.fullhdfilmizlesene.now/"
}

url = "https://www.fullhdfilmizlesene.now/arama/Dune"
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, timeout=4.0) as r:
    html = r.read(1024*1024).decode("utf-8", errors="ignore")

for card in re.findall(r'<li class="film"[^>]*>(.*?)</li>', html, re.S):
    hm = re.search(r'<a[^>]+class="tt"[^>]+href=["\']([^"\']+)["\']', card)
    tm = re.search(r'<span class="film-title">([^<]+)</span>', card)
    ym = re.search(r'<span class="film-yil">(\d{4})</span>', card)
    if hm and tm:
        print(f"Title: {tm.group(1)} | Year: {ym.group(1) if ym else '?'} | URL: {hm.group(1)}")
