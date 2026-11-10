import json
from collections import Counter
import urllib.parse

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

hosts = Counter()
for k, v in vault.get("streams", {}).items():
    for st in v.get("streams", []):
        if isinstance(st, (list, tuple)) and len(st) >= 1:
            u = str(st[0])
            parsed = urllib.parse.urlparse(u)
            if parsed.netloc:
                hosts[parsed.netloc] += 1

print("Top 15 stream hosts in vault:")
for h, c in hosts.most_common(15):
    print(f"  {h}: {c}")
