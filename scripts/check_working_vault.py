import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\main_sites_vault.json', 'r', encoding='utf-8') as f:
    vault = json.load(f)

for k in ["tmdb:movie:872585:1:1", "id:872585", "tmdb:movie:1290418:1:1", "id:1290418", "tmdb:movie:27205:1:1"]:
    if k in vault.get("streams", {}):
        print("KEY:", k)
        print("  VAL:", vault["streams"][k])
