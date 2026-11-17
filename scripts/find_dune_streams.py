import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

streams = vault.get("streams", {})
matches = {}
for k, v in streams.items():
    if "693134" in k or "dune" in k.lower():
        matches[k] = v

print("FOUND MATCHES IN VAULT:", len(matches))
for k, v in matches.items():
    print(k, "->", v)
