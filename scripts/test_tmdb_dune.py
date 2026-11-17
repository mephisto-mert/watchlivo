import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

hits = server._tmdb_sync("Dune Part Two")
print("TMDB hits for 'Dune Part Two':", len(hits))
for h in hits[:3]:
    print(" ", h.get("title"), "| ID:", h.get("tmdbId"), "| Orig:", h.get("originalTitle"))
