import urllib.request
import urllib.parse
import json
import re

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# Test FullHDFilmizlesene search for Dune 2
fhd_search_url = "https://www.fullhdfilmizlesene.now/ara?q=" + urllib.parse.quote("Dune Bölüm 2")
try:
    req = urllib.request.Request(fhd_search_url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=5.0) as r:
        html = r.read().decode("utf-8", errors="ignore")
    print("FHD search length:", len(html))
    links = re.findall(r'href="([^"]*/film/[^"]+)"', html)
    print("FHD film links found:", set(links))
except Exception as e:
    print("FHD error:", e)

# Test HDFC search for Dune 2
hdfc_search_url = "https://www.hdfilmcehennemi.nl/search/" + urllib.parse.quote("Dune")
try:
    req = urllib.request.Request(hdfc_search_url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=5.0) as r:
        html = r.read().decode("utf-8", errors="ignore")
    print("HDFC search length:", len(html))
    links = re.findall(r'href="([^"]*/film/[^"]+)"', html)
    print("HDFC film links found:", set(links))
except Exception as e:
    print("HDFC error:", e)
