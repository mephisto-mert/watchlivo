import urllib.request
import urllib.parse
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

TMDB_API_KEY = "4f042878f22ef63cb94f25e60cb4ec6e"

def check(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=6) as resp:
            return resp.status == 200
    except Exception:
        return False

shows = [
    ("Squid Game", "93405", "tv"),
    ("La Casa de Papel", "71446", "tv"),
    ("Hajime no Ippo", "30983", "tv"),
    ("Monster", "1976", "tv"),
    ("Cyberpunk: Edgerunners", "105248", "tv"),
    ("Ölümlü Dünya", "499461", "movie"),
    ("Mindhunter", "67744", "tv"),
    ("Organize İşler Sazan Sarmalı", "577990", "movie"),
    ("The Penguin", "194764", "tv"),
]

for name, tid, mtype in shows:
    u = f"https://api.themoviedb.org/3/{mtype}/{tid}?api_key={TMDB_API_KEY}&language=tr-TR"
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            p_path = data.get("poster_path")
            b_path = data.get("backdrop_path")
            p_url = f"https://image.tmdb.org/t/p/w500{p_path}" if p_path else None
            b_url = f"https://image.tmdb.org/t/p/w1280{b_path}" if b_path else None
            p_ok = check(p_url) if p_url else False
            b_ok = check(b_url) if b_url else False
            print(f"=== {name} ({tid}) ===")
            print(f"  Poster: {p_url} [OK: {p_ok}]")
            print(f"  Backdrop: {b_url} [OK: {b_ok}]")
    except Exception as e:
        print(f"Error {name}: {e}")
