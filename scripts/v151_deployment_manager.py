# -*- coding: utf-8 -*-
"""
Watchlivo v151 Deployment Manager & Verification Harness
Autonomous engineering script for 1-click Max connection, competitor parity,
and seamless HBO Max watch party integration.
"""

import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# UTF-8 Console Safety
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

BASE_DIR = Path(__file__).resolve().parent.parent
OLD_VERSION = "20261108_v150"
NEW_VERSION = "20261108_v153"
RENDER_HOOK_URL = "https://api.render.com/deploy/srv-dbmnb7etlv9c73bgmfi0?key=W3Qbb8j__WQ"
LIVE_DOMAIN = "https://watchlivo.online"


def scan_bump_targets() -> list[Path]:
    matched_files = []
    exclude_dirs = {".git", ".pytest_cache", "node_modules", "__pycache__", ".vercel", "uploads", "desktop_old_versions_backup"}
    self_path = Path(__file__).resolve()

    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for fname in files:
            p = Path(root) / fname
            if p.resolve() == self_path:
                continue
            if p.suffix in (".html", ".js", ".css", ".py", ".json", ".md"):
                try:
                    content = p.read_text(encoding="utf-8", errors="ignore")
                    if OLD_VERSION in content:
                        matched_files.append(p)
                except Exception as ex:
                    print(f"    [!] Error reading {p}: {ex}")

    return sorted(matched_files)


def apply_version_bump() -> int:
    print(f"[*] Applying atomic version bump: {OLD_VERSION} -> {NEW_VERSION}...")
    targets = scan_bump_targets()
    print(f"[*] Found {len(targets)} files containing '{OLD_VERSION}'")

    updated_count = 0
    for p in targets:
        try:
            content = p.read_text(encoding="utf-8")
            new_content = content.replace(OLD_VERSION, NEW_VERSION)
            if new_content != content:
                p.write_text(new_content, encoding="utf-8")
                updated_count += 1
                rel = p.relative_to(BASE_DIR)
                print(f"    - [OK] Updated: {rel}")
        except Exception as ex:
            print(f"    - [FAIL] Error updating {p}: {ex}")

    # Also update app_version.json if needed
    meta_path = BASE_DIR / "app_version.json"
    if meta_path.exists():
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            data["versionName"] = "2.0.3-v151"
            data["changelog"] = "v151: Competitor Parity for HBO Max — 1-click instant session connect (no email block), City of God & HBO showcase, and real-time cross-tab synchronizer bridge."
            meta_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print("    - [OK] Updated app_version.json")
        except Exception as ex:
            print(f"    - [FAIL] Error updating app_version.json: {ex}")

    print(f"[+] Total files updated: {updated_count}")
    return updated_count


def trigger_render_deploy() -> dict:
    print(f"[*] Triggering Render Production Deploy via Hook...")
    req = urllib.request.Request(
        RENDER_HOOK_URL,
        method="POST",
        headers={"User-Agent": "Watchlivo-Deployment-Manager/151.0", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", errors="replace")
            print(f"[+] Render response HTTP {status}")
            try:
                data = json.loads(body)
                print(f"    - Deploy ID: {data.get('deploy', {}).get('id')}")
                print(f"    - Status:    {data.get('deploy', {}).get('status')}")
                return data
            except Exception:
                print(f"    - Response body: {body[:300]}")
                return {"raw": body}
    except Exception as ex:
        print(f"[!] Failed to trigger Render deploy: {ex}")
        return {"error": str(ex)}


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "bump"
    if action == "bump":
        apply_version_bump()
    elif action == "deploy":
        trigger_render_deploy()
    else:
        print(f"Unknown action: {action}")
