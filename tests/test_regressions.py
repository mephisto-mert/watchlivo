import base64
import unittest
from unittest.mock import patch

from starlette.testclient import TestClient

import auth_engine
import rooms
import server


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def test_status_never_exposes_credentials(self):
        with patch.object(server, 'OPENAI_API_KEY', 'private-test-secret'):
            response = self.client.get('/api/rave/ai-status')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('private-test-secret', response.text)
        self.assertTrue(all('apiKey' not in x for x in response.json()['engines']))

    def test_bad_manifest_parameter_is_client_error(self):
        self.assertEqual(self.client.get('/api/rave/stream?spt=bad').status_code, 400)

    def test_manifest_failure_never_plays_another_movie(self):
        sid = base64.urlsafe_b64encode(b'https://example.com/a.m3u8').decode()
        with patch.object(server, 'public_http_url', return_value=True), patch.object(server, '_public_open', side_effect=OSError):
            response = self.client.get('/api/rave/stream', params={'sid': sid})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('mux.dev', response.text)

    def test_proxy_preserves_unsatisfiable_range(self):
        with patch.object(server, '_proxy_chunk_sync', return_value=(b'', 416, 'bytes */100', 'video/mp4')):
            response = self.client.get(server._proxy_u('https://example.com/a.mp4'))
        self.assertEqual(response.status_code, 416)
        self.assertEqual(response.headers['content-range'], 'bytes */100')

    def test_proxy_rejects_unsigned_or_tampered_requests(self):
        resp_unsigned = self.client.get('/api/rave/stream-proxy?url=https://example.com/a.mp4')
        self.assertEqual(resp_unsigned.status_code, 403)
        resp_tampered = self.client.get('/api/rave/stream-proxy?url=https://example.com/a.mp4&sig=deadbeef0000')
        self.assertEqual(resp_tampered.status_code, 403)

    def test_ssrf_guard_blocks_loopback_and_cloud_metadata(self):
        self.assertFalse(server.public_http_url('http://127.0.0.1:8765/api/health'))
        self.assertFalse(server.public_http_url('http://169.254.169.254/latest/meta-data/'))
        self.assertFalse(server.public_http_url('http://10.0.0.1/admin'))
        self.assertFalse(server.public_http_url('http://192.168.1.1/'))
        self.assertFalse(server.public_http_url('file:///etc/passwd'))

    def test_security_headers_present_on_responses(self):
        response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get('x-content-type-options'), 'nosniff')
        self.assertEqual(response.headers.get('x-frame-options'), 'SAMEORIGIN')
        self.assertIn("frame-ancestors 'self'", response.headers.get('content-security-policy', ''))

    def test_auth_token_hmac_tamper_resistance_and_pbkdf2(self):
        h1 = auth_engine._hash_pw('GucluSifre!2026', 'salt_a')
        h2 = auth_engine._hash_pw('GucluSifre!2026', 'salt_b')
        self.assertNotEqual(h1, h2)
        tok = auth_engine.sign_auth_token({'uid': 'usr_test_1', 'email': 'sec@watchlivo.online', 'handle': 'sec_audit', 'name': 'Sec Audit'})
        verified = auth_engine.verify_auth_token(tok)
        self.assertIsNotNone(verified)
        self.assertEqual(verified['uid'], 'usr_test_1')
        b64, sig = tok.rsplit('.', 1)
        self.assertIsNone(auth_engine.verify_auth_token(f"{b64}.{'0' * len(sig)}"))
        tampered_b64 = base64.urlsafe_b64encode(b'{"uid":"admin","email":"root@watchlivo.online"}').decode().rstrip('=')
        self.assertIsNone(auth_engine.verify_auth_token(f"{tampered_b64}.{sig}"))

    def test_room_path_traversal_and_leader_acl(self):
        bad_resp = self.client.post('/api/rooms/..%2Fetc%2Fpasswd/sync', json={'type': 'init'})
        self.assertIn(bad_resp.status_code, (400, 404))
        bad_resp2 = self.client.post('/api/rooms/BAD..ID/sync', json={'type': 'init'})
        self.assertEqual(bad_resp2.status_code, 400)

    def test_platform_login_rejects_random_credentials_and_stores_zero_data(self):
        """Provider passwords cannot be verified without a real bridge.

        The server fails closed: 501 ``unsupported`` for every attempt, and no
        e-mail/cookie is ever retained. It must never answer 200 for guessed
        credentials.
        """
        attempts = [
            {'provider': 'netflix', 'email': 'asdf@asdf.com', 'password': '1234'},
            {'provider': 'disney', 'email': 'test@test.com', 'password': 'password'},
            {'provider': 'netflix', 'email': 'kullanici@uydurmadomain999999.xyz', 'password': 'GucluSifre!2026'},
            {'provider': 'netflix', 'email': 'sinema.sever@gmail.com', 'password': 'KinoStrong#2026!'},
            {'provider': 'netflix', 'email': 'jokallame06@hotmail.com', 'password': '30012001Mertcan', 'profile': 'mert'},
        ]
        for body in attempts:
            resp = self.client.post('/api/rave/accounts/login', json=body)
            self.assertEqual(resp.status_code, 501, body)
            data = resp.json()
            self.assertFalse(data.get('ok'), body)
            self.assertEqual(data.get('code'), 'unsupported', body)
            self.assertNotIn('vaultSeal', data, body)
            self.assertNotIn('cookies', data, body)

        with patch.object(server, '_upstream_authenticate_sync', return_value=(True, 'ok')):
            still_501 = self.client.post('/api/rave/accounts/login', json={
                'provider': 'netflix', 'email': 'sinema.sever@gmail.com', 'password': 'KinoStrong#2026!'})
            self.assertEqual(still_501.status_code, 501)

        r_accs = self.client.get('/api/rave/accounts').json()
        self.assertEqual(r_accs['accounts']['netflix']['accountEmail'], '')
        self.assertEqual(r_accs['accounts']['netflix']['cookies'], [])
        self.assertTrue(r_accs['accounts']['netflix']['loginSatisfied'] is False)

    def test_private_redirect_is_rejected(self):
        with patch.object(server, 'public_http_url', return_value=False):
            with self.assertRaises(Exception):
                server._NoRedirect().redirect_request(None, None, 302, '', {}, 'http://127.0.0.1/')

    def test_zero_heartbeat_and_explicit_seek(self):
        room = rooms.new_room('regression')
        rooms.add_participant(room, 'h', {'username': 'Host'}, 'http')
        room['host_id'] = 'h'
        rooms.set_media(room, {'url': 'https://example.com/a.mp4'}, 'Host', 120)
        rooms.handle_action(room, 'h', {'type': 'heartbeat', 'currentTime': 0})
        self.assertEqual(room['media']['currentTime'], 120)
        restored = rooms.merge_sync_token(None, rooms.pack_sync_token(room), room['id'])
        self.assertEqual(restored['media']['currentTime'], 120)
        rooms.handle_action(room, 'h', {'type': 'seek', 'currentTime': 5})
        self.assertEqual(room['media']['currentTime'], 5)

    def test_stream_matches_title_3arg_and_trusted_domains(self):
        self.assertTrue(server._stream_matches_title('https://srv29.cdnimages2.cyou/hls/abc/master.txt', ['Inception', 'Başlangıç'], '2010'))
        self.assertTrue(server._stream_matches_title('https://dbx.molystream.org/embed/sheila/xyz', ['Breaking Bad'], '2008'))
        self.assertTrue(server._stream_matches_title('https://sn.dplayer82.site/nm.php?v=123', ['Prens'], '2023'))

    def test_dizipal_pure_python_aes_decrypt(self):
        res = server._decrypt_dizipal_rmk('invalid')
        self.assertEqual(res, '')

    def test_srt_to_vtt_zero_offset_and_ass_conversion(self):
        vtt_with_map = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:180000,LOCAL:00:00:00.000\n\n00:00:10.000 --> 00:00:12.500\nMerhaba\n"
        converted = server._srt_to_vtt(vtt_with_map)
        self.assertIn("00:00:10.000 --> 00:00:12.500", converted)
        ass_raw = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:05.20,0:01:08.45,Default,,0,0,0,,{\\an8}Gördüm.\\NGördün mü gerçekten?\n"
        ass_vtt = server._srt_to_vtt(ass_raw)
        self.assertIn("00:01:05.200 --> 00:01:08.450", ass_vtt)
        self.assertIn("Gördüm.\nGördün mü gerçekten?", ass_vtt)

    def test_domestic_movies_and_series_in_vault_and_not_hidden(self):
        streams = server._MAIN_SITES_VAULT.get("streams") or {}
        for title in ("Kış Uykusu", "Bir Zamanlar Anadolu'da", "Ayla", "Babam ve Oğlum", "G.O.R.A.", "Dabbe", "Eşkıya", "7. Koğuştaki Mucize"):
            nt = server._norm_title(title)
            self.assertTrue(bool(streams.get(f"movie:{nt}:1:1")), f"Missing vault stream for {title} ({nt})")


if __name__ == '__main__':
    unittest.main()
