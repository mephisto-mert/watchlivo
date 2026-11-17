import time
import sys
import io
import requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

url = "https://watchlivo.online/api/netflix-bridge/login"
print(f"Waiting for Render deploy to complete and probing {url}...")

max_wait = 180
start = time.time()

while time.time() - start < max_wait:
    try:
        r = requests.get(url, timeout=10)
        print(f"[{int(time.time() - start)}s] Status: {r.status_code}, len: {len(r.content)}")
        if r.status_code == 200 and len(r.content) > 1000:
            print("✓ Option B Netflix live proxy bridge is UP and ACTIVE on production!")
            print(f"Content preview: {r.text[:200]}")
            sys.exit(0)
    except Exception as e:
        print(f"[{int(time.time() - start)}s] Error: {e}")
    time.sleep(10)

print("Timeout waiting for deploy.")
sys.exit(1)
