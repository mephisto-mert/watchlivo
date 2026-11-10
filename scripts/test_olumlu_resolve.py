import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

res = server._resolve_catalog_sync("dizipal", "Ölümlü Dünya 2", "2023", "1143183", "movie", "", 1, 1)
print("Ölümlü Dünya 2 url:", res.get("url") if res else "None")
print("Servers:", len(res.get("servers", [])) if res else "None")
if res and res.get("servers"):
    print("First server:", res["servers"][0])
