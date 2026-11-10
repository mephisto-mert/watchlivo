import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

print("Testing global extractors for TMDB 693134 (Dune 2)...")
print("Videasy:", server._extract_videasy_sync("693134", "movie", 1, 1) if hasattr(server, "_extract_videasy_sync") else "N/A")
print("Hexa:", server._extract_hexa_sync("693134", "movie", 1, 1) if hasattr(server, "_extract_hexa_sync") else "N/A")
