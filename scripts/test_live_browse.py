import requests
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

r = requests.get("https://watchlivo.online/api/netflix-bridge/browse", headers=headers, timeout=15)
print("Browse status:", r.status_code)
print("Browse len:", len(r.content))
print("Has bridge script:", "watchlivo-netflix-bridge-agent" in r.text)
