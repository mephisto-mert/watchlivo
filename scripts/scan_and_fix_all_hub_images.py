import re
import urllib.request
import urllib.parse
import json
import ssl
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

TMDB_API_KEY = "4f042878f22ef63cb94f25e60cb4ec6e"

def check_url(url):
    if not url or not url.startswith("http"):
        return False
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=6) as resp:
            return resp.status == 200
    except Exception:
        return False

def tmdb_details(tid, mtype="tv"):
    ep = "tv" if mtype in ("tv", "series") else "movie"
    u = f"https://api.themoviedb.org/3/{ep}/{tid}?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY})
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Error fetching details {tid}: {e}")
    return None

def tmdb_search(title, mtype="tv", year=None):
    ep = "tv" if mtype in ("tv", "series") else "movie"
    q_str = {"api_key": TMDB_API_KEY, "query": title}
    if year:
        if ep == "movie":
            q_str["primary_release_year"] = year
        else:
            q_str["first_air_date_year"] = year
    u = f"https://api.themoviedb.org/3/search/{ep}?" + urllib.parse.urlencode(q_str)
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = data.get("results") or []
            if results:
                return results[0]
    except Exception as e:
        print(f"Error searching {title}: {e}")
    return None

target_files = [
    ROOT / "static/js/views/selection-kinds.js",
    ROOT / "static/js/accounts.js"
]

replacements = {
    # 1. The Penguin (was Dota poster s1wP1YeQS9fgSHiXZ3yJb2ufB2D and wrong ID 118956)
    "s1wP1YeQS9fgSHiXZ3yJb2ufB2D.jpg": "vOWcqC4oDQws1doDWLO7d3dh5qc.jpg",
    "'118956', title: 'The Penguin'": "'194764', title: 'The Penguin'",
    "tmdbId: '118956'": "tmdbId: '194764'",

    # 2. Organize İşler: Karun Hazinesi (was dead 8YFLbXvHl686Yg5fI1PZ2W7v2)
    "8YFLbXvHl686Yg5fI1PZ2W7v2.jpg": "sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg",
    "poster: 'https://image.tmdb.org/t/p/w500/8YFLbXvHl686Yg5fI1PZ2W7v2.jpg'": "poster: 'https://image.tmdb.org/t/p/w500/yHVRfj6x7Mr1d8Ew3lysD9SsIX0.jpg'",
    "backdrop: 'https://image.tmdb.org/t/p/w1280/8YFLbXvHl686Yg5fI1PZ2W7v2.jpg'": "backdrop: 'https://image.tmdb.org/t/p/w1280/sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg'",

    # 3. Dexter (was dead 58H6CtF0npS1nT502r9TqUe9z1B)
    "58H6CtF0npS1nT502r9TqUe9z1B.jpg": "i8ORB1biusVy703lGxUi5Rle6zA.jpg",

    # 4. House M.D. (was dead 3r4LYFuXrg3G8f0vP8YvXm9f8)
    "3r4LYFuXrg3G8f0vP8YvXm9f8.jpg": "3Cz7ySOQJmqiuTdrc6CY0r65yDI.jpg",

    # 5. Narcos (was dead rTmal9fVEwh5x9hJ2Up78FS9v49)
    "rTmal9fVEwh5x9hJ2Up78FS9v49.jpg": "rTmal9fDbwh5F0waol2hq35U4ah.jpg",

    # 6. Mindhunter (was dead fbKE87mojpIETWepYpq5Sh6kjTg)
    "fbKE87mojpIETWepYpq5Sh6kjTg.jpg": "fbKE87mojpIETWepSbD5Qt741fp.jpg",

    # 7. The Mentalist (in accounts.js was dead acnHvslqBJa9g7W5z6YFm8UfW3z)
    "acnHvslqBJa9g7W5z6YFm8UfW3z.jpg": "acYXu4KaDj1NIkMgObnhe4C4a0T.jpg",

    # 8. Cyberpunk: Edgerunners (in accounts.js was dead 7vAOm412f8rR2Qo7q0v9b)
    "7vAOm412f8rR2Qo7q0v9b.jpg": "v3JuB15WybKmxDeT1hWdK3j6eSJ.jpg",

    # 9. Vinland Saga (in accounts.js was dead 9kC1eR2B8e0L9Pz8kF0G)
    "9kC1eR2B8e0L9Pz8kF0G.jpg": "vUHlpA5c1NXkds59reY3HMb4Abs.jpg",
}

for fpath in target_files:
    text = fpath.read_text(encoding="utf-8")
    original = text
    for old_val, new_val in replacements.items():
        if old_val in text:
            text = text.replace(old_val, new_val)
            print(f"[{fpath.name}] Replaced '{old_val}' -> '{new_val}'")
    if text != original:
        fpath.write_text(text, encoding="utf-8")
        print(f"SAVED {fpath.name}")
    else:
        print(f"No changes in {fpath.name}")

print("\nScanning for ANY remaining tmdb image URLs in selection-kinds.js to verify validity...")
sk_text = (ROOT / "static/js/views/selection-kinds.js").read_text(encoding="utf-8")
all_tmdb = set(re.findall(r'https://image\.tmdb\.org/t/p/\w+/([a-zA-Z0-9_\-]+\.jpg)', sk_text))
print(f"Found {len(all_tmdb)} unique TMDB image hashes in selection-kinds.js. Checking 404s...")

bad_count = 0
for hsh in sorted(all_tmdb):
    u = f"https://image.tmdb.org/t/p/w500/{hsh}"
    if not check_url(u):
        print(f"DEAD URL: {u}")
        bad_count += 1

print(f"\nTotal dead TMDB URLs remaining in selection-kinds.js: {bad_count}")
