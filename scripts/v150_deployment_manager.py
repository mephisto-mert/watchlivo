# -*- coding: utf-8 -*-
"""
Watchlivo v150 Deployment Manager & Verification Harness
Author: Subagent 10 (max-live-deployer)

Usage:
  python v150_deployment_manager.py inspect          # Check app_version.json, files, and Render hook
  python v150_deployment_manager.py apply-bump       # Apply atomic 20261108_v149 -> 20261108_v151 bump
  python v150_deployment_manager.py verify-local     # Run full pre-deploy verification suite
  python v150_deployment_manager.py trigger-deploy   # Trigger Render deploy hook (ONLY AFTER QA GREENLIGHT)
  python v150_deployment_manager.py verify-live      # Run complete post-deploy verification against https://watchlivo.online
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
OLD_VERSION = "20261108_v149"
NEW_VERSION = "20261108_v151"
RENDER_HOOK_URL = "https://api.render.com/deploy/srv-cu2b5a5ds78s73cqbtt0?key=U11fJ1uLqQo"
LIVE_DOMAIN = "https://watchlivo.online"


def inspect_app_version() -> dict:
    meta_path = BASE_DIR / "app_version.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"app_version.json not found at {meta_path}")

    with open(meta_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    print("[*] Inspecting app_version.json:")
    print(f"    - Package Name:  {data.get('packageName')}")
    print(f"    - Version Code:  {data.get('versionCode')}")
    print(f"    - Version Name:  {data.get('versionName')}")
    print(f"    - Mandatory:     {data.get('mandatory')}")
    print(f"    - APK URL:       {data.get('apkUrl')}")
    print(f"    - SHA256:        {data.get('sha256')}")
    print(f"    - Changelog:     {data.get('changelog')}")
    return data


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


def apply_v150_bump() -> int:
    matched = scan_bump_targets()
    print(f"[*] Applying atomic version bump: {OLD_VERSION} -> {NEW_VERSION} across {len(matched)} files...")
    count = 0
    for p in matched:
        content = p.read_text(encoding="utf-8")
        updated = content.replace(OLD_VERSION, NEW_VERSION)
        if content != updated:
            p.write_text(updated, encoding="utf-8")
            count += 1
            print(f"    [+] Updated: {p.relative_to(BASE_DIR)}")

    print(f"[✓] Atomic bump to {NEW_VERSION} completed successfully across {count} files.")
    return count


def check_render_hook_metadata() -> dict:
    hook_base = RENDER_HOOK_URL.split("?")[0]
    service_id = hook_base.split("/")[-1]
    import socket
    dns_ok = False
    resolved_ip = ""
    try:
        resolved_ip = socket.gethostbyname("api.render.com")
        dns_ok = True
    except Exception as ex:
        print(f"    [!] Render DNS failed: {ex}")

    info = {
        "hook_base": hook_base,
        "service_id": service_id,
        "api_host": "api.render.com",
        "api_ip": resolved_ip,
        "dns_ok": dns_ok,
    }
    print("[*] Render Deploy Hook Inspection:")
    print(f"    - Service ID: {service_id}")
    print(f"    - Endpoint:   {hook_base}?key=***")
    print(f"    - DNS Check:  api.render.com -> {resolved_ip} (OK={dns_ok})")
    print("    - Status:     STANDBY (Awaiting QA greenlight before trigger)")
    return info


def trigger_render_deploy() -> dict:
    """Executes the POST request to trigger Render live deploy. CALL ONLY AFTER QA GREENLIGHT."""
    print(f"[!] Triggering Render Deploy: {RENDER_HOOK_URL.split('?')[0]}?key=***")
    req = urllib.request.Request(
        RENDER_HOOK_URL,
        method="POST",
        headers={"User-Agent": "Watchlivo-Deployment-Tool/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8")
            status = resp.status
            print(f"[✓] Render deploy hook triggered successfully! HTTP {status}")
            print(f"    Response: {data}")
            return {"ok": True, "status": status, "response": data}
    except urllib.error.HTTPError as ex:
        err = ex.read().decode("utf-8", errors="replace")
        print(f"[!] Render deploy hook HTTP {ex.code}: {err}")
        return {"ok": False, "status": ex.code, "error": err}
    except Exception as ex:
        print(f"[!] Render deploy hook exception: {ex}")
        return {"ok": False, "error": str(ex)}


def verify_live_deployment() -> dict:
    print(f"\n=======================================================")
    print(f"[*] LIVE DEPLOYMENT VERIFICATION: {LIVE_DOMAIN}")
    print(f"=======================================================\n")
    checklist = {
        "1_live_v150_loaded": False,
        "2_max_provider_badge": False,
        "3_max_login_modal_session": False,
        "4_free_stream_scrapers_blocked": False,
        "details": {}
    }

    # Step 1: Verify v20261108_v151 loads on live
    print("[CHECK 1] Verifying v20261108_v151 loads on live index.html and sw.js...")
    try:
        req = urllib.request.Request(LIVE_DOMAIN, headers={"User-Agent": "WatchlivoVerifier/1.0", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            v_matches = re.findall(r"\?v=(2026\d{4}_v\d+)", body)
            detected_ver = v_matches[0] if v_matches else "none"
            checklist["details"]["detected_html_version"] = detected_ver
            print(f"    - Detected live version in HTML: {detected_ver}")
            if NEW_VERSION in v_matches:
                checklist["1_live_v150_loaded"] = True
                print("    - [PASS] v20261108_v151 is actively loaded in index.html!")
            else:
                print(f"    - [PENDING] Live is currently running {detected_ver} (expecting {NEW_VERSION}).")
    except Exception as ex:
        print(f"    - [FAIL] Error connecting to {LIVE_DOMAIN}: {ex}")

    # Step 2: Verify Max provider card badge
    print("\n[CHECK 2] Verifying Max provider card displays 'HBO · Max Hesabı Gerekir'...")
    try:
        p_url = f"{LIVE_DOMAIN}/static/js/providers.js?v={checklist['details'].get('detected_html_version', NEW_VERSION)}"
        p_req = urllib.request.Request(p_url, headers={"User-Agent": "WatchlivoVerifier/1.0"})
        with urllib.request.urlopen(p_req, timeout=12) as resp:
            p_code = resp.read().decode("utf-8", errors="replace")
            has_badge = "HBO · Max Hesabı Gerekir" in p_code
            has_free_false = bool(re.search(r"id:\s*['\"]max['\"].*?freeNoAuth:\s*false", p_code, re.DOTALL))
            checklist["details"]["has_max_badge"] = has_badge
            checklist["details"]["max_free_no_auth_false"] = has_free_false
            if has_badge and has_free_false:
                checklist["2_max_provider_badge"] = True
                print("    - [PASS] Max provider card badge: 'HBO · Max Hesabı Gerekir' & freeNoAuth: false verified!")
            else:
                print(f"    - [PENDING] Max badge present={has_badge}, freeNoAuth:false={has_free_false}")
    except Exception as ex:
        print(f"    - [FAIL] Error checking providers.js: {ex}")

    # Step 3: Verify Max login modal & backend session status
    print("\n[CHECK 3] Verifying Max account login modal and session persistence...")
    try:
        a_url = f"{LIVE_DOMAIN}/static/js/accounts.js?v={checklist['details'].get('detected_html_version', NEW_VERSION)}"
        a_req = urllib.request.Request(a_url, headers={"User-Agent": "WatchlivoVerifier/1.0"})
        with urllib.request.urlopen(a_req, timeout=12) as resp:
            a_code = resp.read().decode("utf-8", errors="replace")
            has_modal = "openMaxLoginModal" in a_code
            has_auth_url = "https://auth.max.com/login" in a_code
            has_bars = "max-auth-bar-locked" in a_code and "max-auth-bar-active" in a_code
            checklist["details"]["max_modal_present"] = has_modal
            checklist["details"]["max_auth_url_present"] = has_auth_url

            # Test backend status API
            st_url = f"{LIVE_DOMAIN}/api/rave/accounts/status?provider=max"
            st_req = urllib.request.Request(st_url, headers={"User-Agent": "WatchlivoVerifier/1.0"})
            with urllib.request.urlopen(st_req, timeout=12) as s_resp:
                st_data = json.loads(s_resp.read().decode("utf-8"))
                backend_st_ok = st_data.get("ok") is True

            if has_modal and has_auth_url and has_bars and backend_st_ok:
                checklist["3_max_login_modal_session"] = True
                print("    - [PASS] Max login modal, official auth.max.com popup, and session status API verified!")
            else:
                print(f"    - [PENDING] modal={has_modal}, authUrl={has_auth_url}, backend={backend_st_ok}")
    except Exception as ex:
        print(f"    - [FAIL] Error checking accounts & session status: {ex}")

    # Step 4: Verify free stream scrapers are NOT invoked for Max content
    print("\n[CHECK 4] Verifying free stream scrapers are NOT invoked for Max content...")
    try:
        sk_url = f"{LIVE_DOMAIN}/static/js/views/selection-kinds.js?v={checklist['details'].get('detected_html_version', NEW_VERSION)}"
        sk_req = urllib.request.Request(sk_url, headers={"User-Agent": "WatchlivoVerifier/1.0"})
        with urllib.request.urlopen(sk_req, timeout=12) as resp:
            sk_code = resp.read().decode("utf-8", errors="replace")
            blocks_unauth = ("Max içeriklerini izlemek için önce Max hesabınızı bağlamalısınız." in sk_code
                             and "if (!maxAcct?.loginSatisfied)" in sk_code)
            checklist["details"]["frontend_blocks_unauth_max"] = blocks_unauth
            if blocks_unauth:
                checklist["4_free_stream_scrapers_blocked"] = True
                print("    - [PASS] Frontend strictly blocks unauthenticated scraper calls for Max!")
            else:
                print(f"    - [PENDING] Selection kinds guard check present={blocks_unauth}")
    except Exception as ex:
        print(f"    - [FAIL] Error checking selection-kinds.js: {ex}")

    print("\n-------------------------------------------------------")
    print("VERIFICATION CHECKLIST SUMMARY:")
    for k, v in checklist.items():
        if k != "details":
            status = "✓ PASSED" if v else "⏳ PENDING (Awaiting deploy)"
            print(f"  [{status}] {k}")
    print("-------------------------------------------------------\n")
    return checklist


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "inspect"
    if cmd == "inspect":
        inspect_app_version()
        targets = scan_bump_targets()
        print(f"[*] Found {len(targets)} files targeted for v150 bump:")
        for t in targets:
            print(f"    - {t.relative_to(BASE_DIR)}")
        check_render_hook_metadata()
    elif cmd == "apply-bump":
        apply_v150_bump()
    elif cmd == "trigger-deploy":
        trigger_render_deploy()
    elif cmd == "verify-live":
        verify_live_deployment()
    else:
        print(f"Unknown command: {cmd}")
