import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

# Let's check Dizipal live
res_dp = server._extract_dizipal_hls_sync("movie", 1, 1, ["Dune: Part Two", "Dune 2", "Dune Çöl Gezegeni Bölüm İki"], "movie:693134:1:1", "2024", "tt15239678")
print("Dizipal:", res_dp)
