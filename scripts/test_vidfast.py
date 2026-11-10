import urllib.request
import urllib.parse
import json
import re

UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
tid = "693134"

try:
    vf_u = f"https://vidfast.vc/movie/{tid}/"
    req = urllib.request.Request(vf_u, headers={"User-Agent": UA137})
    with urllib.request.urlopen(req, timeout=5.0) as r:
        html = r.read().decode("utf-8", errors="ignore")
    print("Vidfast HTML len:", len(html))
    m_en = re.search(r'\\"(?:en|token)\\":\\"(.*?)\\"', html)
    if m_en:
        print("Found token:", m_en.group(1)[:20])
    else:
        print("No token in vidfast html")
except Exception as e:
    print("Vidfast error:", e)
