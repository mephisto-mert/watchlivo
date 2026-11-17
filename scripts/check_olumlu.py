import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

for k, v in vault.get("streams", {}).items():
    if "1143183" in k or "olumlu" in k.lower():
        print(k, "->", v)
