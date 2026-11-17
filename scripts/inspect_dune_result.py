import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\audit\audit_20_movies_playback_results.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

for x in data['results']:
    if 'Dune' in x.get('title', ''):
        print("STATUS:", x.get("status"))
        print("ISSUES:", x.get("issues"))
        print("LOGS:")
        for l in x.get("log", []):
            print(" ", l)
