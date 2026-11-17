import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request("https://watchlivo.online/api/rave/latest-episodes", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx) as r:
    data = json.loads(r.read().decode())
    items = data.get("items", [])
    for it in items:
        if "Solo" in it.get("title", "") or "One" in it.get("title", ""):
            print("TITLE:", it.get("title"))
            print("  still:", it.get("still"))
            print("  backdrop:", it.get("backdrop"))
            print("  poster:", it.get("poster"))
            print("  tmdbId:", it.get("tmdbId"))
