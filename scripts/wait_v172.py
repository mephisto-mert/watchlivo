import time
import requests
import sys

url = "https://watchlivo.online/"
print("Waiting for v172 to go live...")

for i in range(35):
    try:
        r = requests.get(url, timeout=10)
        if "20261110_v178" in r.text:
            print(f"[{i*6}s] ✓ v172 is LIVE on watchlivo.online!")
            sys.exit(0)
        else:
            print(f"[{i*6}s] Waiting for v172 deploy...")
    except Exception as e:
        print(f"[{i*6}s] {e}")
    time.sleep(6)

print("Deploy polling timeout")
sys.exit(1)
