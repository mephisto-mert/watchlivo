import json

with open(r"c:\Users\pc\Documents\projelerim\rave_web_platform\audit\audit_20_movies_playback_results.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for r in data["results"]:
    sub = r.get("subagent")
    title = r.get("title")
    prov = r.get("provider")
    status = r.get("status")
    url = (r.get("stream_url") or "NO_STREAM")[:60]
    issues = r.get("issues", [])
    print(f"{sub} | {title[:25]:25} | {prov:8} | Status: {status:5} | Issues: {len(issues)}")
    for iss in issues:
        print(f"    - {iss}")
