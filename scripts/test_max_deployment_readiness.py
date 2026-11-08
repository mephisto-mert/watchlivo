# -*- coding: utf-8 -*-
"""
Watchlivo Max Integration & Deployment Readiness Test Suite
Author: Subagent 10 (max-live-deployer)
"""

import io
import json
import os
import re
import sys
from pathlib import Path

# UTF-8 Console Safety
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

PROJECT_ROOT = Path("c:/Users/pc/Documents/projelerim/rave_web_platform")
sys.path.insert(0, str(PROJECT_ROOT))


def test_app_version_json():
    print("[TEST 1] Validating app_version.json and ios_version.json...")
    app_v_file = PROJECT_ROOT / "app_version.json"
    assert app_v_file.exists(), "app_version.json must exist"
    data = json.loads(app_v_file.read_text(encoding="utf-8"))
    assert data.get("ok") is True, "app_version.json ok must be True"
    assert data.get("packageName") == "online.watchlivo.app"
    assert data.get("versionCode") == 22
    assert data.get("versionName") == "2.0.2"
    assert "https://watchlivo.online" in data.get("apkUrl")
    print("    [PASS] app_version.json is strictly valid and verified.")


def test_max_providers_configuration():
    print("[TEST 2] Validating static/js/providers.js configuration for Max...")
    prov_file = PROJECT_ROOT / "static" / "js" / "providers.js"
    content = prov_file.read_text(encoding="utf-8")
    assert "HBO · Max Hesabı Gerekir" in content, "Badge must be 'HBO · Max Hesabı Gerekir'"
    assert re.search(r"id:\s*['\"]max['\"].*?freeNoAuth:\s*false", content, re.DOTALL), "Max freeNoAuth must be false"
    assert re.search(r"id:\s*['\"]max['\"].*?accent:\s*['\"]#002be7['\"]", content, re.DOTALL), "Max accent must be #002be7"
    print("    [PASS] static/js/providers.js Max configuration verified.")


def test_max_accounts_modal_and_auth_bar():
    print("[TEST 3] Validating static/js/accounts.js Max modal & session persistence...")
    acct_file = PROJECT_ROOT / "static" / "js" / "accounts.js"
    content = acct_file.read_text(encoding="utf-8")
    assert "openMaxLoginModal" in content, "openMaxLoginModal must be defined"
    assert "https://auth.max.com/login" in content, "Official auth.max.com popup must be present"
    assert "Max Hesabı: " in content or "Max Hesabı Bağlı" in content, "Active connection status string must be present"
    assert "max-auth-bar-locked" in content, "Locked auth bar class must be present"
    assert "max-auth-bar-active" in content, "Active auth bar class must be present"
    print("    [PASS] static/js/accounts.js Max modal & auth bar verified.")


def test_max_scrapers_blocked_in_frontend():
    print("[TEST 4] Validating selection-kinds.js blocks free scrapers when unauthenticated...")
    sk_file = PROJECT_ROOT / "static" / "js" / "views" / "selection-kinds.js"
    content = sk_file.read_text(encoding="utf-8")
    assert "Max içeriklerini izlemek için önce Max hesabınızı bağlamalısınız." in content, "Must have warning toast"
    assert "if (!maxAcct?.loginSatisfied)" in content, "Must check maxAcct.loginSatisfied"
    assert "return null" in content, "Must abort without invoking scraper endpoints"
    print("    [PASS] Free stream scrapers are NOT invoked on frontend for unauthenticated Max.")


def test_backend_accounts_endpoints():
    print("[TEST 5] Testing backend /api/rave/accounts/* endpoints...")
    try:
        from server import app
        from starlette.testclient import TestClient

        client = TestClient(app)
        
        # Test status endpoint
        res = client.get("/api/rave/accounts/status?provider=max")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.json()
        assert data.get("ok") is True
        assert data.get("provider") == "max"
        print(f"    - /api/rave/accounts/status response: {data}")

        # Test verify endpoint with mock valid session
        res_v = client.post("/api/rave/accounts/verify", json={
            "provider": "max",
            "email": "test_subscriber@max.com",
            "profile": "Sinema 4K",
            "authType": "sso",
            "token": "mock_jwt_session_token_12345678"
        })
        assert res_v.status_code == 200, f"Expected 200, got {res_v.status_code}"
        v_data = res_v.json()
        assert v_data.get("ok") is True
        assert v_data.get("loginSatisfied") is True
        assert "***" in v_data.get("accountEmail", "") and "@max.com" in v_data.get("accountEmail", "")
        assert v_data.get("zeroKnowledge") is True
        print(f"    - /api/rave/accounts/verify response: {v_data}")

        # Test logout endpoint
        res_lo = client.post("/api/rave/accounts/logout", json={"provider": "max"})
        assert res_lo.status_code == 200
        lo_data = res_lo.json()
        assert lo_data.get("ok") is True
        assert lo_data.get("loginSatisfied") is False
        print(f"    - /api/rave/accounts/logout response: {lo_data}")

        print("    [PASS] Backend Max account status, verify, and logout endpoints functional.")
    except Exception as ex:
        print(f"    [FAIL] Backend endpoint test failed: {ex}")
        raise


if __name__ == "__main__":
    test_app_version_json()
    test_max_providers_configuration()
    test_max_accounts_modal_and_auth_bar()
    test_max_scrapers_blocked_in_frontend()
    test_backend_accounts_endpoints()
    print("\n[ALL 5 PRE-DEPLOYMENT CHECKS PASSED SUCCESSFULLY!]")
