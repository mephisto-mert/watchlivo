import time
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

deploy_hook = "https://api.render.com/deploy/srv-dbmnb7etlv9c73bgmfi0?key=W3Qbb8j__WQ"

print("Triggering Render deployment for v169...")
req = urllib.request.Request(deploy_hook, method="POST")
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        print("Deploy hook status:", resp.status, resp.read().decode("utf-8"))
except Exception as e:
    print("Deploy hook error:", e)

print("Waiting for https://watchlivo.online to deploy v169...")
start = time.time()
deployed = False

for i in range(50):
    time.sleep(6)
    try:
        req = urllib.request.Request("https://watchlivo.online/", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            if "20261110_v177" in body:
                print(f"\n[LIVE CONFIRMED] v169 is LIVE on watchlivo.online in {int(time.time() - start)}s!")
                deployed = True
                break
            else:
                print(".", end="", flush=True)
    except Exception as e:
        print(f"x({e})", end="", flush=True)

if not deployed:
    print("\nTimeout waiting for live deployment, please check Render dashboard.")
else:
    print("\n>>> LIVE PRODUCTION v169 CONFIRMED AND ACTIVE! <<<")
