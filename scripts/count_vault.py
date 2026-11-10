import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

print("Total streams in vault:", len(vault.get("streams", {})))
