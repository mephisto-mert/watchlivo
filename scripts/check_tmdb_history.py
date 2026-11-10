import urllib.request
import urllib.parse
import json

key = '4f042878f22ef63cb94f25e60cb4ec6e'
targets = [
    ("Don't Look Up", '2021'),
    ("The Last of Us", '2023'),
    ("Stranger Things", '2016'),
    ("Demon Slayer", '2025'),
    ("Below", '2021'),
    ("Organize İşler: Karun Hazinesi", '2026'),
    ("The Penguin", '2024'),
    ("Solo Leveling", '2024'),
    ("Breaking Bad", '2008'),
    ("Better Call Saul", '2015')
]

for title, yr in targets:
    params = urllib.parse.urlencode({'api_key': key, 'query': title, 'language': 'tr-TR'})
    u = f"https://api.themoviedb.org/3/search/multi?{params}"
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            results = data.get('results', [])
            if results:
                r = results[0]
                print(f"{title} -> ID: {r.get('id')} | mt: {r.get('media_type')} | poster: {r.get('poster_path')} | backdrop: {r.get('backdrop_path')}")
            else:
                print(f"{title} -> NO RESULT")
    except Exception as e:
        print(f"{title} -> ERROR: {e}")
