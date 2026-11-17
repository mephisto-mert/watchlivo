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
    # Fallback to multi search
    u2 = f"https://api.themoviedb.org/3/search/multi?" + urllib.parse.urlencode({"api_key": TMDB_API_KEY, "query": title})
    try:
        req = urllib.request.Request(u2, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for r in data.get("results") or []:
                if r.get("media_type") in ("tv", "movie"):
                    return r
    except Exception:
        pass
    return None

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

def check_url(url):
    if not url or not url.startswith("http"):
        return False
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=6) as resp:
            return resp.status == 200
    except Exception:
        return False

# Test the specific culprits first
print("--- Checking Penguin ---")
pen = tmdb_search("The Penguin", "tv", "2024")
print("Penguin TMDB:", pen.get("id"), pen.get("poster_path"), pen.get("backdrop_path"))

print("\n--- Checking Organize Isler ---")
org = tmdb_search("Organize İşler Sazan Sarmalı", "movie", "2019")
if not org:
    org = tmdb_details("577990", "movie")
print("Organize Isler TMDB:", org.get("id") if org else None, org.get("poster_path") if org else None, org.get("backdrop_path") if org else None)

print("\n--- Checking Dexter ---")
dex = tmdb_details("1405", "tv")
print("Dexter TMDB:", dex.get("poster_path"), dex.get("backdrop_path"))

print("\n--- Checking House M.D. ---")
hse = tmdb_details("1408", "tv")
print("House TMDB:", hse.get("poster_path"), hse.get("backdrop_path"))

print("\n--- Checking Narcos ---")
nar = tmdb_details("63351", "tv")
print("Narcos TMDB:", nar.get("poster_path"), nar.get("backdrop_path"))

print("\n--- Checking Mindhunter ---")
min = tmdb_details("67744", "tv")
print("Mindhunter TMDB:", min.get("poster_path"), min.get("backdrop_path"))
