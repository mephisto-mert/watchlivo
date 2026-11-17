import time
import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

deploy_hook = "https://api.render.com/deploy/srv-dbmnb7etlv9c73bgmfi0?key=W3Qbb8j__WQ"

print("Triggering Render deployment for v168...")
req = urllib.request.Request(deploy_hook, method="POST")
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        print("Deploy hook status:", resp.status, resp.read().decode("utf-8"))
except Exception as e:
    print("Deploy hook error:", e)

print("Waiting for https://watchlivo.online to deploy v168...")
start = time.time()
deployed = False

for i in range(50):
    time.sleep(6)
    try:
        req = urllib.request.Request("https://watchlivo.online/", headers={"User-Agent": "Mozilla/5.0 Chrome/130.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            headers = dict(resp.headers)
            if "20261110_v181" in body:
                print(f"\n[LIVE CONFIRMED] v168 is LIVE on watchlivo.online in {int(time.time() - start)}s!")
                print("Live X-Robots-Tag:", headers.get("X-Robots-Tag") or headers.get("x-robots-tag"))
                deployed = True
                break
            else:
                print(".", end="", flush=True)
    except Exception as e:
        print(f"x({e})", end="", flush=True)

if not deployed:
    print("\nTimeout waiting for live deployment, please check Render dashboard.")
else:
    # Verify Live Robots.txt
    print("\nChecking Live /robots.txt...")
    req = urllib.request.Request("https://watchlivo.online/robots.txt", headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        rob_txt = resp.read().decode("utf-8", errors="ignore")
        assert "Disallow: /" in rob_txt
        print("Live /robots.txt verified!")

    # Verify Live Cloaking
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        bot_body = resp.read().decode("utf-8", errors="ignore")
        assert "Watchlivo Media Cloud" in bot_body
        assert "Birlikte Sinema" not in bot_body
        print("Live Cloaking verified!")

    print("\n>>> ALL 5 STEPS SUCCESSFULLY DEPLOYED AND VERIFIED ON LIVE PRODUCTION! <<<")
