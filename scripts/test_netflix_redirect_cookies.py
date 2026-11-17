import sys
import io
from curl_cffi import requests as cffi_requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

resp = cffi_requests.get("https://www.netflix.com/login", headers=headers, impersonate="chrome124", allow_redirects=True)
print("Final Status:", resp.status_code)
print("Final URL:", resp.url)
print("Cookies count:", len(resp.cookies))
for k, v in resp.cookies.items():
    print(f"  {k}: {v[:30]}...")
