# -*- coding: utf-8 -*-
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BASE_DIR = Path(__file__).resolve().parent.parent

OLD_VERSION = "20261109_v163"
NEW_VERSION = "20261110_v165"
exclude_dirs = {".git", ".pytest_cache", "node_modules", "__pycache__", ".vercel", "uploads", "desktop_old_versions_backup"}
self_path = Path(__file__).resolve()

count = 0
for root, dirs, files in os.walk(BASE_DIR):
    dirs[:] = [d for d in dirs if d not in exclude_dirs]
    for fname in files:
        p = Path(root) / fname
        if p.resolve() == self_path:
            continue
        if p.suffix in (".html", ".js", ".css", ".py", ".json", ".md"):
            try:
                c = p.read_text(encoding="utf-8", errors="ignore")
                if OLD_VERSION in c:
                    p.write_text(c.replace(OLD_VERSION, NEW_VERSION), encoding="utf-8")
                    count += 1
                    print(f"    - Bumped {p.relative_to(BASE_DIR)}")
            except Exception as ex:
                print(f"    [!] Error in {p}: {ex}")

av_path = BASE_DIR / "app_version.json"
if av_path.exists():
    data = json.loads(av_path.read_text(encoding="utf-8"))
    data["version"] = NEW_VERSION
    data["changelog"] = "v164: Exact Rave In-App Netflix Experience — In-window interactive login, password/SMS OTP challenge, 5 canonical smiley profile selector (Kim İzliyor?), Organize İşler Karun Hazinesi billboard, and live synchronized room bridge."
    av_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

print(f"[+] Total files bumped to v164: {count}")

def trigger_render():
    hook = "https://api.render.com/deploy/srv-dbmnb7etlv9c73bgmfi0?key=W3Qbb8j__WQ"
    req = urllib.request.Request(hook, method="POST", headers={"User-Agent": "Watchlivo/164.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"[+] Render deploy triggered: {data.get('deploy', {}).get('id')}")
            return data
    except Exception as e:
        print(f"[!] Deploy hook error: {e}")
        return None

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "deploy":
        trigger_render()
