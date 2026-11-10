import json
import urllib.request

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

checked = 0
for k, v in vault.get("streams", {}).items():
    for st in v.get("streams", []):
        if "makesomthingup" in str(st[0]):
            u = str(st[0])
            try:
                req = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://dizilife.net/"})
                with urllib.request.urlopen(req, timeout=3.0) as r:
                    print(f"MAKESOMETHINGUP: {u[:60]} -> {r.status}")
            except Exception as e:
                print(f"MAKESOMETHINGUP FAIL: {u[:60]} -> {e}")
            checked += 1
            if checked >= 3:
                break
    if checked >= 3:
        break
