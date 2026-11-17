import urllib.request, urllib.parse, json, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

tests = [
    {
        "provider": "cinema",
        "title": "Don't Look Up",
        "originalTitle": "Don't Look Up",
        "displayTitle": "Don't Look Up (2021)",
        "year": "2021",
        "tmdbId": "",
        "mediaType": "movie",
        "season": 1,
        "episode": 1,
    },
    {
        "provider": "max",
        "title": "The Last of Us",
        "originalTitle": "The Last of Us",
        "displayTitle": "The Last of Us",
        "year": "",
        "tmdbId": "100088",
        "mediaType": "tv",
        "season": 2,
        "episode": 1,
    },
    {
        "provider": "netflix",
        "title": "Stranger Things",
        "originalTitle": "Stranger Things",
        "displayTitle": "Stranger Things",
        "year": "",
        "tmdbId": "",
        "mediaType": "tv",
        "season": 1,
        "episode": 1,
    },
    {
        "provider": "cinema",
        "title": "Solo Leveling",
        "originalTitle": "Ore dake Level Up na Ken",
        "displayTitle": "Solo Leveling",
        "year": "2025",
        "tmdbId": "127532",
        "mediaType": "tv",
        "season": 2,
        "episode": 12,
    },
]

for t in tests:
    q = urllib.parse.urlencode(t)
    url = f"https://watchlivo.online/api/rave/resolve-catalog?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            data = json.loads(r.read().decode())
            print(f"[{t['mediaType']}] {t['title']} -> Status 200, url: {bool(data.get('url'))}, stream: {str(data.get('url'))[:60]}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:150]
        print(f"[{t['mediaType']}] {t['title']} -> HTTP {e.code}: {body}")
    except Exception as e:
        print(f"[{t['mediaType']}] {t['title']} -> Error: {e}")
