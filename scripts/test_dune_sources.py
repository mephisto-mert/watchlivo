import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server
import urllib.request
import re

# Let's search HDFC for "Dune"
print("Testing HDFC search...")
hits = server._search_hdfc_candidates("Dune", 2024, "movie")
print("HDFC candidates for 'Dune':", len(hits))
for h in hits:
    print(" ", h)

# Let's also check other movies in vault to see what providers work
print("Testing TMDB 693134 on vidsrc / videasy / hexa...")
