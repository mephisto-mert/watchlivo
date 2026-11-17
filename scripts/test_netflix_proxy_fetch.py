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

print("Testing direct fetch to https://www.netflix.com/login with curl_cffi...")
try:
    resp = cffi_requests.get("https://www.netflix.com/login", headers=headers, impersonate="chrome124", allow_redirects=True, timeout=15)
    print(f"Status: {resp.status_code}")
    print(f"URL: {resp.url}")
    print(f"Content-Type: {resp.headers.get('content-type')}")
    print(f"Content length: {len(resp.content)}")
    print(f"Has login form/keywords: {'oturum' in resp.text.lower() or 'sign in' in resp.text.lower() or 'login' in resp.text.lower()}")
except Exception as e:
    print(f"Error: {e}")
