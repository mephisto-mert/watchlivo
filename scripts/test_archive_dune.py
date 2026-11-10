import urllib.request
import json

UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
meta_url = "https://archive.org/metadata/coitx-Feature_Flix_-_Dune_-_Part_Two"
try:
    req = urllib.request.Request(meta_url, headers={"User-Agent": UA137})
    with urllib.request.urlopen(req, timeout=4.0) as r:
        meta = json.loads(r.read().decode())
    files = meta.get("files", [])
    mp4s = [f for f in files if f.get("name", "").endswith(".mp4")]
    for m in mp4s:
        print(m.get("name"), "Size:", m.get("size"))
except Exception as e:
    print("Error:", e)
