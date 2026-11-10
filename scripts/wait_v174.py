import urllib.request
import time

HOOK = "https://api.render.com/deploy/srv-dbmnb7etlv9c73bgmfi0?key=W3Qbb8j__WQ"
PROD = "https://watchlivo.online/static/index.html"
VERSION_TARGET = "20261110_v181"

print("Triggering Render deploy...")
req = urllib.request.Request(HOOK, method="POST")
with urllib.request.urlopen(req) as resp:
    print("Deploy triggered, status:", resp.status)

print(f"Waiting for {VERSION_TARGET} to go live on {PROD}...")
for attempt in range(1, 35):
    time.sleep(10)
    try:
        req = urllib.request.Request(f"{PROD}?t={int(time.time())}", headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read().decode("utf-8", errors="ignore")
            if VERSION_TARGET in body:
                print(f"SUCCESS! {VERSION_TARGET} is now LIVE on {PROD} after {attempt * 10} seconds!")
                break
            else:
                print(f"[{attempt}] Not yet live, current version in index...")
    except Exception as e:
        print(f"[{attempt}] Poll error: {e}")
