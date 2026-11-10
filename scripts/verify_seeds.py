import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

api_key = "4f042878f22ef63cb94f25e60cb4ec6e"

seeds = [
    {"tmdbId": "95479", "title": "Jujutsu Kaisen"},
    {"tmdbId": "127532", "title": "Solo Leveling"},
    {"tmdbId": "37854", "title": "One Piece"},
    {"tmdbId": "228853", "title": "Prens"},
    {"tmdbId": "115678", "title": "Gibi"},
    {"tmdbId": "280030", "title": "Gassal"},
    {"tmdbId": "100088", "title": "The Last of Us"},
    {"tmdbId": "95396", "title": "Severance"},
]

for s in seeds:
    tid = s["tmdbId"]
    url = f"https://api.themoviedb.org/3/tv/{tid}?api_key={api_key}&language=en-US"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ctx) as r:
            d = json.loads(r.read().decode())
            print(f"[{tid}] {s['title']}")
            print(f"   Name: {d.get('name')}")
            print(f"   Poster: https://image.tmdb.org/t/p/w500{d.get('poster_path')}")
            print(f"   Backdrop: https://image.tmdb.org/t/p/w780{d.get('backdrop_path')}")
    except Exception as e:
        print(f"[{tid}] {s['title']} ERROR: {e}")
