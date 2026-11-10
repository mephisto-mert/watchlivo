import urllib.request
import time

HOOK = "https://api.render.com/deploy/srv-dbmnb7etlv9c73bgmfi0?key=W3Qbb8j__WQ"
PROD = "https://watchlivo.online/static/index.html"
VERSION_TARGET = "20261110_v177"

print("Triggering Render deploy for v175...", flush=True)
req = urllib.request.Request(HOOK, method="POST")
with urllib.request.urlopen(req) as resp:
    print("Deploy triggered, status:", resp.status, flush=True)

print(f"Waiting for {VERSION_TARGET} to go live on {PROD}...", flush=True)
for attempt in range(1, 40):
    time.sleep(10)
    try:
        req = urllib.request.Request(f"{PROD}?t={int(time.time())}", headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read().decode("utf-8", errors="ignore")
            if VERSION_TARGET in body:
                print(f"SUCCESS! {VERSION_TARGET} is now LIVE on {PROD} after {attempt * 10} seconds!", flush=True)
                break
            else:
                print(f"[{attempt}] Not yet live...", flush=True)
    except Exception as e:
        print(f"[{attempt}] Poll error: {e}", flush=True)
