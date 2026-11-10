import sys
import os
from pathlib import Path

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

chrome_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

# 1. Normal user browsing from watchlivo.online
r_legit = client.get(
    "/api/rave/catalog?provider=cinema&page=1",
    headers={
        "User-Agent": chrome_ua,
        "Referer": "https://watchlivo.online/",
        "Sec-Fetch-Site": "same-origin"
    }
)
print("Legitimate user catalog status:", r_legit.status_code)
assert r_legit.status_code == 200, f"Expected 200, got {r_legit.status_code}"

# 2. Cross-site attacker trying to fetch internal catalog
r_cross = client.get(
    "/api/rave/catalog?provider=cinema",
    headers={
        "User-Agent": chrome_ua,
        "Sec-Fetch-Site": "cross-site"
    }
)
print("Cross-site attacker catalog status:", r_cross.status_code)
assert r_cross.status_code == 403, "Cross-site requests must be blocked with 403"

# 3. Third party embedding/scraping with hostile Origin
r_origin = client.get(
    "/api/rave/resolve-catalog?provider=cinema&title=Matrix",
    headers={
        "User-Agent": chrome_ua,
        "Origin": "https://hostile-scraper-site.com"
    }
)
print("Hostile Origin resolve-catalog status:", r_origin.status_code)
assert r_origin.status_code == 403, "Hostile origin must be blocked with 403"

# 4. Third party embedding with hostile Referer
r_ref = client.get(
    "/api/rave/resolve-catalog?provider=cinema&title=Matrix",
    headers={
        "User-Agent": chrome_ua,
        "Referer": "https://unauthorized-stream-portal.com/watch"
    }
)
print("Hostile Referer resolve-catalog status:", r_ref.status_code)
assert r_ref.status_code == 403, "Hostile referer must be blocked with 403"

print(">>> STEP 3 VERIFICATION SUCCESS: Referer and Anti-Hotlink shields verified! <<<")
