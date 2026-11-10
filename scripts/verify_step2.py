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

# 1. Normal Chrome User
chrome_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
r_user = client.get("/", headers={"User-Agent": chrome_ua})
print("Normal user status:", r_user.status_code)
assert r_user.status_code == 200
assert "Birlikte Sinema" in r_user.text, "Normal user should see Watchlivo portal"
assert "Watchlivo Media Cloud" not in r_user.text, "Normal user should NOT see cloaked text"

# 2. Googlebot on /
google_ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
r_bot = client.get("/", headers={"User-Agent": google_ua})
print("Googlebot / status:", r_bot.status_code)
assert r_bot.status_code == 200
assert "Watchlivo Media Cloud" in r_bot.text, "Googlebot should see cloaked workspace page"
assert "Birlikte Sinema" not in r_bot.text, "Googlebot should NOT see movie titles"

# 3. Bingbot on /r/cinema-club
bing_ua = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
r_bing = client.get("/r/cinema-club", headers={"User-Agent": bing_ua})
print("Bingbot /r/cinema-club status:", r_bing.status_code)
assert r_bing.status_code == 200
assert "Watchlivo Media Cloud" in r_bing.text, "Bingbot should see cloaked page"

# 4. DMCA Scraper on /api/rave/resolve-catalog
muso_ua = "MUSO Copyright Scanner v1.0"
r_muso = client.get("/api/rave/resolve-catalog?provider=cinema&title=Matrix", headers={"User-Agent": muso_ua})
print("MUSO scraper /api/rave/resolve-catalog status:", r_muso.status_code)
assert r_muso.status_code == 403, "Scraper must be blocked with 403"
assert r_muso.json().get("detail") == "bot_access_restricted"

# 5. Normal user on /api/health
r_health = client.get("/api/health", headers={"User-Agent": chrome_ua})
print("Normal user /api/health status:", r_health.status_code)
assert r_health.status_code == 200

print(">>> STEP 2 VERIFICATION SUCCESS: All cloaking and bot protection checks passed! <<<")
