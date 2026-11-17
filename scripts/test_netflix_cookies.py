import sys
import io
from curl_cffi import requests as cffi_requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

resp = cffi_requests.get("https://www.netflix.com/login", headers=headers, impersonate="chrome124", allow_redirects=False)
print("Status:", resp.status_code)
print("Location:", resp.headers.get("location"))

# Check Set-Cookie headers
if hasattr(resp.headers, "getlist"):
    cookies = resp.headers.getlist("set-cookie")
    print(f"resp.headers.getlist('set-cookie') ({len(cookies)}):")
    for c in cookies[:3]:
        print("  ", c[:60])
else:
    print("set-cookie:", resp.headers.get("set-cookie"))

print("resp.cookies:", list(resp.cookies.items())[:5])
