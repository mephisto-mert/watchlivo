import sys
import os
from pathlib import Path

os.environ["WATCHLIVO_TRUST_PROXY"] = "1"
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from starlette.testclient import TestClient
import server

client = TestClient(server.app)

bad_crawler_ip = "198.51.100.22"
clean_user_ip = "203.0.113.88"

# 1. Clean user visits / before trap is triggered
r_clean1 = client.get("/", headers={"X-Forwarded-For": clean_user_ip, "User-Agent": "Mozilla/5.0 Chrome/130.0"})
print("Clean user status before:", r_clean1.status_code)
assert r_clean1.status_code == 200

# 2. Malicious bot visits /api/system/crawler-trap
r_trap = client.get("/api/system/crawler-trap", headers={"X-Forwarded-For": bad_crawler_ip, "User-Agent": "Scrapy/2.11"})
print("Crawler hitting honeypot status:", r_trap.status_code)
assert r_trap.status_code == 403
assert r_trap.json().get("detail") == "crawler_trap_triggered"

# 3. Malicious bot now tries to access ANY page on Watchlivo
r_banned = client.get("/", headers={"X-Forwarded-For": bad_crawler_ip, "User-Agent": "Mozilla/5.0 Chrome/130.0"})
print("Banned crawler trying to access / status:", r_banned.status_code)
assert r_banned.status_code == 403
assert r_banned.json().get("detail") == "ip_blacklisted_by_honeypot"

# 4. Clean user is completely unaffected and continues browsing
r_clean2 = client.get("/", headers={"X-Forwarded-For": clean_user_ip, "User-Agent": "Mozilla/5.0 Chrome/130.0"})
print("Clean user status after:", r_clean2.status_code)
assert r_clean2.status_code == 200

# 5. Check honeypot link in static/index.html
with open("static/index.html", "r", encoding="utf-8") as f:
    idx = f.read()
assert "/api/system/crawler-trap" in idx

print(">>> STEP 4 VERIFICATION SUCCESS: Honeypot trap & auto-ban verified! <<<")
