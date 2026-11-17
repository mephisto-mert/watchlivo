import re
import urllib.request
import json
import ssl

with open("server.py", "r", encoding="utf-8") as f:
    server_code = f.read()

# Find TMDB API key in server.py
keys = re.findall(r'api_key=([a-f0-9]{32})', server_code)
print("Found TMDB keys in server.py:", set(keys))

api_key = list(set(keys))[0] if keys else None
if not api_key:
    # check TMDB_KEY or similar
    m = re.search(r'TMDB_API_KEY\s*=\s*["\']([^"\']+)["\']', server_code)
    if m:
        api_key = m.group(1)

print("Using API key:", api_key)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url_search = f"https://api.themoviedb.org/3/search/tv?api_key={api_key}&query=The+Penguin"
req = urllib.request.Request(url_search, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
    data = json.loads(resp.read().decode("utf-8"))
    print("\nSearch results for 'The Penguin':")
    for r in data.get("results", [])[:3]:
        print(f"  ID: {r.get('id')} | Title: {r.get('name')} | Poster: {r.get('poster_path')} | Backdrop: {r.get('backdrop_path')}")

# Also search for 'Organize İşler'
url_org = f"https://api.themoviedb.org/3/search/multi?api_key={api_key}&query=Organize+%C4%B0%C5%9Fler"
req = urllib.request.Request(url_org, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
    data = json.loads(resp.read().decode("utf-8"))
    print("\nSearch results for 'Organize İşler':")
    for r in data.get("results", [])[:5]:
        print(f"  ID: {r.get('id')} | Media: {r.get('media_type')} | Title: {r.get('title') or r.get('name')} | Poster: {r.get('poster_path')} | Backdrop: {r.get('backdrop_path')}")
