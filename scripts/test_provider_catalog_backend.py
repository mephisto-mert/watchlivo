import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

from starlette.testclient import TestClient
import server

client = TestClient(server.app)

for prov in ["netflix", "max", "disney", "prime", "apple", "cinema"]:
    r = client.get(
        f"/api/rave/catalog?provider={prov}&limit=20&page=1",
        headers={"User-Agent": "Mozilla/5.0 Chrome/130.0", "Referer": "https://watchlivo.online/"}
    )
    print(f"Provider '{prov}' status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        items = data.get("items") or []
        print(f"  Returned {len(items)} items. Total available: {data.get('totalAvailable')}")
        if items:
            print(f"  Sample item 1: {items[0].get('title')} (type: {items[0].get('mediaType')}, poster: {items[0].get('poster')[:45] if items[0].get('poster') else None})")
            print(f"  Sample item 2: {items[1].get('title') if len(items) > 1 else 'None'}")
