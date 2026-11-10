import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, r"c:/Users/pc/Documents/projelerim/rave_web_platform")
from starlette.testclient import TestClient
from server import app, _NETFLIX_BRIDGE_LIMIT

class NetflixBridgeAuditTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        _NETFLIX_BRIDGE_LIMIT._hits.clear()

    def test_01_options_preflight_cors_and_csp(self):
        """Verify OPTIONS preflight returns 204 with credentials and frame headers."""
        resp = self.client.options("/api/netflix-bridge", headers={"origin": "https://vortex.app"})
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(resp.headers.get("access-control-allow-origin"), "https://vortex.app")
        self.assertEqual(resp.headers.get("access-control-allow-credentials"), "true")
        self.assertIn("GET", resp.headers.get("access-control-allow-methods", ""))
        self.assertIn("PATCH", resp.headers.get("access-control-allow-methods", ""))
        self.assertEqual(resp.headers.get("x-frame-options"), "ALLOWALL")

    def test_02_rate_limiter_enforcement(self):
        """Verify RateLimiter triggers 429 without throwing 500."""
        test_ip = "testclient"
        for _ in range(600):
            _NETFLIX_BRIDGE_LIMIT.hit(test_ip)

        resp = self.client.get("/api/netflix-bridge/browse")
        self.assertEqual(resp.status_code, 429)
        self.assertIn("Rate limit exceeded", resp.json().get("error", ""))

    def test_03_connection_error_handling(self):
        """Verify curl_cffi connection/timeout error returns 502, not 500."""
        with patch("curl_cffi.requests.request", side_effect=Exception("Connection timed out")):
            resp = self.client.get("/api/netflix-bridge/browse")
            self.assertEqual(resp.status_code, 502)
            self.assertIn("Netflix proxy connection error", resp.json().get("error", ""))

    def test_04_unicode_decode_safety(self):
        """Verify non-UTF8 / binary HTML payload decodes with fallback without 500."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "text/html; charset=iso-8859-1"}
        mock_resp.content = b"<head><title>Test \xff\xfe</title></head>"
        # resp.text raises UnicodeDecodeError
        type(mock_resp).text = property(lambda self: (_ for _ in ()).throw(UnicodeDecodeError('utf-8', b"\xff", 0, 1, 'bad start')))
        mock_resp.cookies = {}

        with patch("curl_cffi.requests.request", return_value=mock_resp):
            resp = self.client.get("/api/netflix-bridge/browse")
            self.assertEqual(resp.status_code, 200)
            self.assertIn("watchlivo-netflix-bridge-agent", resp.text)

    def test_05_status_204_and_304_headers(self):
        """Verify 204 No Content has empty body and no Content-Type."""
        mock_resp = MagicMock()
        mock_resp.status_code = 204
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.content = b""
        mock_resp.cookies = {}

        with patch("curl_cffi.requests.request", return_value=mock_resp):
            resp = self.client.get("/api/netflix-bridge/browse")
            self.assertEqual(resp.status_code, 204)
            self.assertEqual(resp.content, b"")
            self.assertIsNone(resp.headers.get("content-type"))

    def test_06_redirect_location_rewrite(self):
        """Verify 302 redirects are rewritten to internal bridge path."""
        mock_resp = MagicMock()
        mock_resp.status_code = 302
        mock_resp.headers = {"location": "https://www.netflix.com/login", "content-type": "text/html"}
        mock_resp.content = b""
        mock_resp.text = ""
        mock_resp.cookies = {}

        with patch("curl_cffi.requests.request", return_value=mock_resp):
            resp = self.client.get("/api/netflix-bridge/browse", follow_redirects=False)
            self.assertEqual(resp.status_code, 302)
            self.assertEqual(resp.headers.get("location"), "/api/netflix-bridge/login")

    def test_07_cookie_persistence(self):
        """Verify cookies from curl_cffi are persisted to client response."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.content = b'{"status": "ok"}'
        mock_resp.cookies = {"NetflixId": "v1-secret-session-token", "nfvdid": "device-token-123"}

        with patch("curl_cffi.requests.request", return_value=mock_resp):
            resp = self.client.get("/api/netflix-bridge/api/shakti")
            self.assertEqual(resp.status_code, 200)
            self.assertIn("NetflixId", resp.headers.get("set-cookie", ""))
            self.assertIn("nfvdid", resp.headers.get("set-cookie", ""))

    def test_08_post_with_body_and_patch_route(self):
        """Verify POST and PATCH requests forward method and body cleanly."""
        captured_kwargs = {}
        def mock_request(**kwargs):
            captured_kwargs.update(kwargs)
            m = MagicMock()
            m.status_code = 200
            m.headers = {"content-type": "application/json"}
            m.content = b'{"updated": true}'
            m.cookies = {}
            return m

        with patch("curl_cffi.requests.request", side_effect=mock_request):
            resp = self.client.patch("/api/netflix-bridge/profile", json={"autoplay": True})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(captured_kwargs.get("method"), "PATCH")
            self.assertIn(b'"autoplay"', captured_kwargs.get("data", b""))
            self.assertEqual(captured_kwargs.get("headers", {}).get("Content-Type"), "application/json")
            self.assertEqual(captured_kwargs.get("headers", {}).get("Referer"), "https://www.netflix.com/")

    def test_09_live_netflix_get(self):
        """Verify live curl_cffi call to Netflix returns valid response with injected script."""
        resp = self.client.get("/api/netflix-bridge/browse", headers={"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0"})
        self.assertIn(resp.status_code, (200, 302, 403))
        if resp.status_code == 200:
            self.assertIn("watchlivo-netflix-bridge-agent", resp.text)
            self.assertEqual(resp.headers.get("x-frame-options"), "ALLOWALL")

if __name__ == "__main__":
    unittest.main(verbosity=2)
