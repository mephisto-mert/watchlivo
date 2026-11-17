import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

# Let's inspect _extract_hdfc_sync
print("--- HDFC ---")
res_hf = server._extract_hdfc_sync("movie", 1, 1, "Dune: Part Two", "Dune: Çöl Gezegeni Bölüm İki", "movie:693134:1:1", "2024", "tt15239678", ["Dune: Part Two", "Dune: Çöl Gezegeni Bölüm İki"], "", "693134", True)
print("HDFC returned:", res_hf)

# Let's inspect Dizilife
print("--- DIZILIFE ---")
res_dl = server._extract_dizilife_sync("movie", 1, 1, "Dune: Part Two", "Dune: Çöl Gezegeni Bölüm İki", "movie:693134:1:1", "2024", "tt15239678", ["Dune: Part Two", "Dune: Çöl Gezegeni Bölüm İki"], "")
print("Dizilife returned:", res_dl)

# Let's inspect Dizimag
print("--- DDIZIMAG ---")
res_pv = server._extract_ddizimag_sync("movie", 1, 1, "Dune: Part Two", "Dune: Çöl Gezegeni Bölüm İki", "movie:693134:1:1", "2024", ["Dune: Part Two", "Dune: Çöl Gezegeni Bölüm İki"], "", "en", "tt15239678")
print("Ddizimag returned:", res_pv)
