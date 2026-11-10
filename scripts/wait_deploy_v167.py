import urllib.request, ssl, time

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://watchlivo.online/?_t="
target_v = "20261110_v180"

print("Waiting for Render deployment to complete...")
for i in range(12):
    try:
        req = urllib.request.Request(f"{url}{time.time()}", headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
            html = r.read().decode("utf-8", errors="ignore")
            if target_v in html:
                print(f"[SUCCESS] {target_v} is live on watchlivo.online!")
                break
            else:
                print(f"[{i+1}/12] Still on previous version, waiting 8s...")
    except Exception as e:
        print(f"[{i+1}/12] Error: {e}")
    time.sleep(8)
