import sys
import io
import re
from curl_cffi import requests as cffi_requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
}

resp = cffi_requests.get("https://www.netflix.com/login", headers=headers, impersonate="chrome124", allow_redirects=True, timeout=15)
html = resp.text

# Check links, action attributes, and scripts
scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html)
print(f"Total external scripts: {len(scripts)}")
for s in scripts[:5]:
    print(f"  script: {s}")

links = re.findall(r'<link[^>]+href=["\']([^"\']+)["\']', html)
print(f"Total external links: {len(links)}")
for l in links[:5]:
    print(f"  link: {l}")

forms = re.findall(r'<form[^>]+action=["\']([^"\']+)["\']', html)
print(f"Forms action: {forms}")
