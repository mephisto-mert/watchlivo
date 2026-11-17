import json

with open(r'c:\Users\pc\Documents\projelerim\rave_web_platform\audit\audit_20_movies_playback_results.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

for x in data['results']:
    if '16' in str(x.get('id', '')) or 'Ölümlü' in x.get('title', ''):
        print(json.dumps(x, indent=2, ensure_ascii=False))
