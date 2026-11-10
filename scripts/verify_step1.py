import sys
import io
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

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

client = TestClient(server.app)

# 1. Test /
r_root = client.get('/')
print('GET / status:', r_root.status_code)
print('X-Robots-Tag on /:', r_root.headers.get('x-robots-tag'))
assert 'noindex' in r_root.headers.get('x-robots-tag', ''), "Missing noindex on /"

# 2. Test /robots.txt
r_rob = client.get('/robots.txt')
print('GET /robots.txt status:', r_rob.status_code)
print('X-Robots-Tag on /robots.txt:', r_rob.headers.get('x-robots-tag'))
assert 'User-agent: Googlebot' in r_rob.text, "Missing Googlebot in robots.txt"
assert 'Disallow: /' in r_rob.text, "Missing Disallow in robots.txt"
assert 'User-agent: *' in r_rob.text, "Missing wild agent in robots.txt"

# 3. Test static/index.html
with open('static/index.html', 'r', encoding='utf-8') as f:
    idx = f.read()
assert '<meta name="robots" content="noindex' in idx, "Missing noindex meta tag"
assert '<meta name="googlebot" content="noindex' in idx, "Missing googlebot meta tag"

print('>>> STEP 1 VERIFICATION SUCCESS: All tests passed cleanly! <<<')
