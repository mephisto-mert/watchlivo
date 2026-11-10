import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

TMDB_API_KEY = "4f042878f22ef63cb94f25e60cb4ec6e"

def tmdb_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))

# 1. The Penguin
print("=== 1. The Penguin ===")
res = tmdb_get(f"https://api.themoviedb.org/3/search/tv?api_key={TMDB_API_KEY}&query=The+Penguin")
for r in res.get("results", [])[:2]:
    print(f"ID: {r.get('id')} | Name: {r.get('name')} | Poster: https://image.tmdb.org/t/p/w500{r.get('poster_path')} | Backdrop: https://image.tmdb.org/t/p/w1280{r.get('backdrop_path')}")

# What is s1wP1YeQS9fgSHiXZ3yJb2ufB2D currently in selection-kinds.js?
# Let's check Dota: Dragon's Blood on TMDB
print("\n=== Dota: Dragon's Blood ===")
res_dota = tmdb_get(f"https://api.themoviedb.org/3/search/tv?api_key={TMDB_API_KEY}&query=Dota")
for r in res_dota.get("results", [])[:1]:
    print(f"Dota Poster: {r.get('poster_path')}")

# 2. Organize İşler
print("\n=== 2. Organize İşler ===")
res_org = tmdb_get(f"https://api.themoviedb.org/3/search/multi?api_key={TMDB_API_KEY}&query=Organize+%C4%B0%C5%9Fler")
for r in res_org.get("results", []):
    print(f"ID: {r.get('id')} | Type: {r.get('media_type')} | Title: {r.get('title') or r.get('name')} | Poster: https://image.tmdb.org/t/p/w500{r.get('poster_path')} | Backdrop: https://image.tmdb.org/t/p/w1280{r.get('backdrop_path')}")

# 3. Netflix "Amerika Yapımı Drama Dizileri" items:
# Check the posters of: Dexter, House M.D., Breaking Bad, Better Call Saul, Narcos, Ozark
print("\n=== 3. US Drama Series ===")
for name in ["Dexter", "House", "Breaking Bad", "Better Call Saul", "Narcos", "Ozark", "The Mentalist", "Cyberpunk: Edgerunners", "Vinland Saga"]:
    res_s = tmdb_get(f"https://api.themoviedb.org/3/search/tv?api_key={TMDB_API_KEY}&query={urllib.parse.quote(name)}")
    if res_s.get("results"):
        top = res_s["results"][0]
        print(f"{name}: ID={top.get('id')} | Poster: https://image.tmdb.org/t/p/w500{top.get('poster_path')} | Backdrop: https://image.tmdb.org/t/p/w780{top.get('backdrop_path')}")
