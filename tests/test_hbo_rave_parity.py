import sys
import io
import os
import asyncio
import json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
    
    # 1. Passwordless login for Max
    req_login = MockRequest(
        json_data={"provider": "max", "email": "tris.author@gmail.com"},
        cookies={"wl_uid": test_uid}
    )
    res_login = await server.rave_login_account(req_login)
    login_data = json.loads(res_login.body.decode("utf-8"))
    print("[1] Max Passwordless Login Success:", login_data)
    assert login_data["ok"] is True
    assert login_data["loginSatisfied"] is True
    assert login_data["provider"] == "max"

    # 2. Passwordless login for Netflix
    req_nf = MockRequest(
        json_data={"provider": "netflix", "profileName": "Mertcan"},
        cookies={"wl_uid": test_uid}
    )
    res_nf = await server.rave_login_account(req_nf)
    nf_data = json.loads(res_nf.body.decode("utf-8"))
    print("[2] Netflix Passwordless Login Success:", nf_data)
    assert nf_data["ok"] is True
    assert nf_data["loginSatisfied"] is True

    # 3. Unauthenticated guest stream manifest check (must NOT return 401 gate)
    unauth_stream_req = MockRequest(query_params={"provider": "max", "tmdbId": "223397", "uid": "unauthenticated_guest_111"})
    res_stream_gate = await server.rave_stream_manifest(unauth_stream_req)
    print("[3] Free Playback Status Code (no 401 blocker):", res_stream_gate.status_code)
    assert res_stream_gate.status_code != 401, "Should never be 401 blocked!"

    # 4. Cleanup DB
    conn = server._get_acc_db()
    with conn:
        conn.execute("DELETE FROM user_provider_accounts WHERE user_id = ?", (test_uid,))
    conn.close()

    print("\n=======================================================")
    print("ALL HBO & NETFLIX PASSWORDLESS ACCESS TESTS PASSED!")
    print("=======================================================")

if __name__ == "__main__":
    asyncio.run(run_tests())
