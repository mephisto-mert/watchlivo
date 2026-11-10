import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server
import time

movies = [
    ("max", "Korku Seansı 4: Son Ayin", "2025", "1034541", "movie"),
    ("netflix", "Rebel Ridge", "2024", "646097", "movie"),
    ("film", "Oppenheimer", "2023", "872585", "movie"),
    ("dizipal", "Ölümlü Dünya 2", "2023", "1137064", "movie"),
    ("anime", "Bleach", "2004", "30984", "tv"),
]

print("=== CURRENT RESOLVE LATENCIES (COLD / REFRESH) ===")
for prov, title, yr, tid, mtype in movies:
    t0 = time.time()
    res = server._resolve_catalog_sync(prov, title, yr, tid, mtype, "", 1, 1, refresh=True)
    dt = time.time() - t0
    stream_type = res.get("streamType") if res else "None"
    print(f"[{prov.upper()}] '{title}' -> {round(dt, 2)}s (Stream: {stream_type})")
