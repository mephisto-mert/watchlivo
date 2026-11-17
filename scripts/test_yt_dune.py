import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

yt = server._extract_official_yt_sync("Dune: Part Two", 1, 1, "movie", ["Dune: Part Two", "Dune Çöl Gezegeni 2"])
print("YT result for Dune:", yt)
