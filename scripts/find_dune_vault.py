import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

for k, v in vault.get("streams", {}).items():
    if "cdnimage" in str(v) and any(yr in str(v) for yr in ("2024", "2025")):
        su = v.get("sourceUrl", "")
        if "dune" in su.lower():
            print("FOUND DUNE IN VAULT:", k, v)
