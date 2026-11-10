import urllib.request
import re

url = "https://www.hdfilmcehennemi.nl/dune-part-two-17/"
headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36", "Referer": "https://www.hdfilmcehennemi.nl/"}
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, timeout=4.0) as r:
    html = r.read(1024*1024).decode("utf-8", errors="ignore")

# Find player container
print("Player divs:")
for m in re.finditer(r'<div[^>]+id=["\'](?:player|video|watch)[^"\']*["\'][^>]*>(.*?)</div>', html, re.S | re.I):
    print(m.group(0)[:400])

print("Data attributes:")
data_attrs = re.findall(r'data-[a-zA-Z0-9_-]+=["\'][^"\']+["\']', html)
for da in set(data_attrs):
    if any(k in da for k in ("video", "source", "url", "id", "film", "hash", "token")):
        print(" ", da)
