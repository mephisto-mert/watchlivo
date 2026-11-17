import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

for k, v in vault.get("streams", {}).items():
    s_url = v.get("sourceUrl", "")
    if "dune" in s_url.lower() or "dune" in k.lower():
        print("KEY:", k)
        print("  streams:", v.get("streams"))
        print("  sourceUrl:", s_url)
