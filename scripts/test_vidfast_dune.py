import urllib.request
import re

url = "https://vidfast.vc/movie/693134/"
headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"}
try:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=4.0) as r:
        html = r.read(1024*1024).decode("utf-8", errors="ignore")
    print("vidfast status:", r.status, "len:", len(html))
    m_en = re.search(r'\\"(?:en|token)\\":\\"(.*?)\\"', html)
    print("m_en:", m_en.group(1) if m_en else "None")
except Exception as e:
    print("vidfast error:", e)
