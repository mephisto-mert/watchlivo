import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

for k, v in vault.get("streams", {}).items():
    if "438631" in k or ("dune" in k.lower() and "two" not in k.lower() and "col" not in k.lower()):
        print(k, "->", v)
