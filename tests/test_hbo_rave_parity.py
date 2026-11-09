import sys
import io
import os
import asyncio
import json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.abspath("rave_web_platform"))

import server

class MockRequest:
    def __init__(self, json_data=None, query_params=None, cookies=None, headers=None):
        self._json = json_data or {}
        self.query_params = query_params or {}
        self.cookies = cookies or {}
        self.headers = headers or {}
        self.scope = {"type": "http", "wl_uid": self.cookies.get("wl_uid")}
        self.method = "POST" if json_data else "GET"
    async def json(self):
        return self._json

async def run_tests():
    test_uid = "rave_test_user_tris_777"
    
    # 1. Unauthenticated status check
    req_status_unauth = MockRequest(query_params={"provider": "max"}, cookies={"wl_uid": test_uid})
    res = await server.rave_account_status(req_status_unauth)
    data = json.loads(res.body.decode("utf-8"))
    print("[1] Unauthenticated Status:", data)
    assert not data.get("hasActiveConnection"), "Should not be connected initially"

    # 2. Login validation failures
    req_bad_email = MockRequest(json_data={"provider": "max", "email": "bademail", "password": "123"}, cookies={"wl_uid": test_uid})
    res_bad = await server.rave_login_account(req_bad_email)
    print("[2a] Bad email rejected with status:", res_bad.status_code)
    assert res_bad.status_code == 400

    req_short_pw = MockRequest(json_data={"provider": "max", "email": "user@gmail.com", "password": "12"}, cookies={"wl_uid": test_uid})
    res_bad_pw = await server.rave_login_account(req_short_pw)
    print("[2b] Short password rejected with status:", res_bad_pw.status_code)
    assert res_bad_pw.status_code == 400

    # 3. Successful login
    req_login = MockRequest(
        json_data={"provider": "max", "email": "tris.author@gmail.com", "password": "supersecretpassword123"},
        cookies={"wl_uid": test_uid}
    )
    res_login = await server.rave_login_account(req_login)
    login_data = json.loads(res_login.body.decode("utf-8"))
    print("[3] Login Success:", login_data)
    assert login_data["ok"] is True
    assert login_data["loginSatisfied"] is True
    assert login_data["provider"] == "max"
    assert "tr***@gmail.com" in login_data["accountEmail"]

    # 4. Authenticated status check
    req_status_auth = MockRequest(query_params={"provider": "max"}, cookies={"wl_uid": test_uid})
    res_st = await server.rave_account_status(req_status_auth)
    st_data = json.loads(res_st.body.decode("utf-8"))
    print("[4] Authenticated Status:", st_data)
    assert st_data.get("hasActiveConnection") is True

    # 5. Playback gate check
    unauth_stream_req = MockRequest(query_params={"provider": "max", "tmdbId": "223397", "uid": "unauthenticated_guest_111"})
    res_stream_gate = await server.rave_stream_manifest(unauth_stream_req)
    print("[5a] Unauthenticated Playback Gate Status Code:", res_stream_gate.status_code)
    assert res_stream_gate.status_code == 401

    auth_stream_req = MockRequest(query_params={"provider": "max", "tmdbId": "223397", "uid": test_uid})
    res_stream_auth = await server.rave_stream_manifest(auth_stream_req)
    print("[5b] Authenticated Playback Gate Status Code:", res_stream_auth.status_code)
    assert res_stream_auth.status_code != 401, "Authenticated subscriber should pass the 401 gate!"

    # 6. Logout
    req_logout = MockRequest(json_data={"provider": "max"}, cookies={"wl_uid": test_uid})
    res_logout = await server.rave_logout_account(req_logout)
    logout_data = json.loads(res_logout.body.decode("utf-8"))
    print("[6] Logout Result:", logout_data)
    assert logout_data["loginSatisfied"] is False

    # 7. Post-logout status
    res_post_logout = await server.rave_account_status(req_status_unauth)
    post_data = json.loads(res_post_logout.body.decode("utf-8"))
    print("[7] Post-logout Status:", post_data)
    assert not post_data.get("hasActiveConnection"), "Should not be connected after logout"

    # Cleanup DB
    conn = server._get_acc_db()
    with conn:
        conn.execute("DELETE FROM user_provider_accounts WHERE user_id = ?", (test_uid,))
    conn.close()

    print("\n=======================================================")
    print("ALL 7 RAVE-PARITY HBO MAX AUTHENTICATION TESTS PASSED!")
    print("=======================================================")

if __name__ == "__main__":
    asyncio.run(run_tests())
