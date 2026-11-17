import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

print("Testing extractors for The Union (TMDB 845111)...")
meta = server._get_tmdb_meta_sync("845111", "movie", "The Union")
print("Meta:", meta.get("title"), meta.get("origTitle"), meta.get("year"))

extra_titles = [meta.get("title"), meta.get("origTitle"), "The Union"]
print("Videasy:", server._extract_videasy_sync("845111", "movie", 1, 1))
print("Cinejoy:", server._extract_cinejoy_sync("845111", "movie", 1, 1))
print("Hexa:", server._extract_hexa_sync("845111", "movie", 1, 1))
print("HDFC:", server._extract_hdfc_sync("movie", 1, 1, meta.get("origTitle"), meta.get("title"), "845111", "2024", "", extra_titles, "", "845111"))
