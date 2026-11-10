import urllib.request
import re

url = "https://www.hdfilmcehennemi.nl/dune-part-two-17/"
headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36", "Referer": "https://www.hdfilmcehennemi.nl/"}
req = urllib.request.Request(url, headers=headers)
with urllib.request.urlopen(req, timeout=4.0) as r:
    html = r.read(1024*1024).decode("utf-8", errors="ignore")

# Find buttons or tabs with data-token
matches = re.findall(r'<[a-zA-Z0-9]+[^>]*data-token=["\']([^"\']+)["\'][^>]*>(.*?)</[a-zA-Z0-9]+>', html, re.S)
print("Matched data-token elements:", len(matches))
for tok, text in matches[:10]:
    print("TOKEN:", tok, "-> TEXT:", text.strip()[:80])
