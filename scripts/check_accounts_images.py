import re
import urllib.request
import ssl
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def check_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=6) as resp:
            return resp.status == 200
    except Exception:
        return False

acc_text = (ROOT / "static/js/accounts.js").read_text(encoding="utf-8")
all_tmdb = set(re.findall(r'https://image\.tmdb\.org/t/p/\w+/([a-zA-Z0-9_\-]+\.jpg)', acc_text))
print(f"Found {len(all_tmdb)} unique TMDB image hashes in accounts.js. Checking 404s...")

bad_count = 0
for hsh in sorted(all_tmdb):
    u = f"https://image.tmdb.org/t/p/w500/{hsh}"
    if not check_url(u):
        print(f"DEAD URL in accounts.js: {u}")
        bad_count += 1

print(f"Total dead in accounts.js: {bad_count}")
