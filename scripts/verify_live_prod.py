import urllib.request, json, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

print("Verifying live production endpoints on watchlivo.online...")
req = urllib.request.Request("https://watchlivo.online/api/rave/latest-episodes", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx) as r:
    data = json.loads(r.read().decode())
    items = data.get("items", [])
    for it in items:
        if "Solo" in it.get("title", ""):
            print("Solo Leveling in Latest Episodes:")
            print("  backdrop:", it.get("backdrop"))
            print("  still:", it.get("still"))
            print("  poster:", it.get("poster"))
            assert "4Mt7WHox67uJ1yErwTBFcV8KWgG" not in str(it.get("backdrop")), "FAIL: One Piece backdrop found in Solo Leveling!"
            assert "xMNH87maNLt9n2bMDYeI6db5VFm" in str(it.get("backdrop")), "PASS: Real Solo Leveling backdrop confirmed!"
            print("  -> PASSED VERIFICATION!")

print("ALL VERIFICATIONS SUCCEEDED!")
