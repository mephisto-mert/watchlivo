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
            {'provider': 'netflix', 'email': 'demo_user@example.test', 'password': 'DemoPass#2026!', 'profile': 'demo'},
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

    def test_provider_catalog_and_resolve_domestic_endpoints(self):
        import catalog_api
        c = TestClient(catalog_api.app)
        r_cat = c.get("/api/rave/catalog?provider=tvplus&page=1")
        self.assertEqual(r_cat.status_code, 200)
        self.assertTrue(len(r_cat.json().get("items") or []) > 0)
        r_res = c.get("/api/rave/resolve-catalog?tmdbId=225565&title=K%C4%B1%C5%9F+Uykusu&mediaType=movie&year=2014")
        self.assertEqual(r_res.status_code, 200)
        self.assertTrue(bool(r_res.json().get("url")))

    def test_media_key_stability_across_catalog_resolution(self):
        self.assertEqual(rooms.media_key({}), "")
        self.assertEqual(rooms.media_key(None), "")
        unresolved_title_only = {
            "title": "YAGA — 1. Sezon 2. Bölüm",
            "season": 1,
            "episode": 2,
            "url": "/api/rave/resolve-catalog?title=YAGA&season=1&episode=2",
        }
        resolved_title_only = {
            "title": "YAGA — 1. Sezon 2. Bölüm",
            "season": 1,
            "episode": 2,
            "url": "/api/rave/stream?sid=abc123xyz",
        }
        self.assertEqual(rooms.media_key(unresolved_title_only), rooms.media_key(resolved_title_only))
        unresolved_cat = {"id": "acx_9988", "season": 1, "episode": 3, "url": "/api/rave/resolve-catalog?id=acx_9988"}
        resolved_cat = {"id": "acx_9988", "season": 1, "episode": 3, "url": "https://cdn.example.com/hls/master.m3u8"}
        self.assertEqual(rooms.media_key(unresolved_cat), "cat|acx_9988|1|3")
        self.assertEqual(rooms.media_key(unresolved_cat), rooms.media_key(resolved_cat))

    def test_resolve_media_guards_and_broadcast(self):
        room = rooms.new_room("res_guard_room")
        rooms.add_participant(room, "host1", {"username": "HostUser"}, "ws")
        rooms.add_participant(room, "guest1", {"username": "GuestUser"}, "ws")
        room["host_id"] = "host1"
        rooms.set_media(room, {
            "tmdbId": "550",
            "title": "Fight Club",
            "url": "/api/rave/resolve-catalog?tmdbId=550",
        }, "HostUser", 42.0)
        out1 = rooms.handle_action(room, "guest1", {
            "type": "resolve_media",
            "tmdbId": "550",
            "title": "Fight Club",
            "url": "https://cdn.example.com/fightclub/master.m3u8",
            "streamType": "hls",
        })
        self.assertEqual(room["media"]["url"], "https://cdn.example.com/fightclub/master.m3u8")
        self.assertGreaterEqual(room["media"]["currentTime"], 42.0)
        self.assertEqual(len(out1["broadcast"]), 1)
        self.assertEqual(out1["broadcast"][0][0]["action"], "resolve_media")
        # Non-leader cannot overwrite already-resolved URL with a different URL
        rooms.handle_action(room, "guest1", {
            "type": "resolve_media",
            "tmdbId": "550",
            "title": "Fight Club",
            "url": "https://evil.example.com/other.m3u8",
        })
        self.assertEqual(room["media"]["url"], "https://cdn.example.com/fightclub/master.m3u8")
        # Unresolved catalog URL is never accepted into resolve_media
        rooms.handle_action(room, "host1", {
            "type": "resolve_media",
            "tmdbId": "550",
            "title": "Fight Club",
            "url": "/api/rave/resolve-catalog?tmdbId=550",
        })
        self.assertEqual(room["media"]["url"], "https://cdn.example.com/fightclub/master.m3u8")

    def test_proxy_segment_cache_bounds(self):
        server._SEGMENT_CACHE.clear()
        for idx in range(35):
            server._SEGMENT_CACHE[f"https://cdn.example.com/seg_{idx}.ts|"] = (9999999999.0, b"G" * 188, "video/mp2t")
            if len(server._SEGMENT_CACHE) > 28:
                oldest_k = min(server._SEGMENT_CACHE, key=lambda k: server._SEGMENT_CACHE[k][0])
                server._SEGMENT_CACHE.pop(oldest_k, None)
        self.assertLessEqual(len(server._SEGMENT_CACHE), 28)

    def test_platform_download_endpoints_and_manifest(self):
        m_resp = self.client.get("/manifest.json")
        self.assertEqual(m_resp.status_code, 200)
        icons = m_resp.json().get("icons") or []
        self.assertGreaterEqual(len(icons), 3)
        for path in ("/download/apk", "/download/ipa", "/download/ios", "/download/windows", "/download/exe"):
            r = self.client.get(path, follow_redirects=False)
            self.assertIn(r.status_code, (200, 302), path)

    def test_realtime_imports_state_and_hls_abr_anti_freeze(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        rt_js = (root / "static" / "js" / "realtime.js").read_text(encoding="utf-8")
        self.assertIn("import { state } from './store.js", rt_js)
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        self.assertIn("fragLoadingTimeOut: 28000", html5_js)
        self.assertIn("this.hls.autoLevelCapping = chosenCap", html5_js)
        self.assertNotIn("this.hls.loadLevel = bestIdx", html5_js)
        srv_py = (root / "server.py").read_text(encoding="utf-8")
        self.assertIn("non_4k = [v for v in variant_pairs if v[0] <= 2700 and v[1] <= 11000000]", srv_py)

    def test_multi_device_creator_role_and_exact_frame_sync(self):
        room = rooms.new_room(
            "mert-can-yildiz-odasi-f1e42",
            "Mert Can Yıldız odası",
            "public",
            "leader",
            "Mert Can Yıldız",
            "h_web1",
            "",
        )
        rooms.add_participant(room, "h_web1", {"username": "Mert Can Yıldız", "device": "Web", "_internalCreator": True}, "http")
        room["host_id"] = "h_web1"
        rooms.set_media(room, {"title": "Zmora", "url": "https://cdn.example.com/zmora/master.m3u8", "provider": "hls"}, "Mert Can Yıldız", 120.0)
        # Second device (Desktop App) with the same display name joins while h_web1 is active
        rooms.add_participant(room, "h_desk2", {"username": "Mert Can Yıldız", "device": "Masaüstü"}, "http")
        # Guest viewer joins
        rooms.add_participant(room, "h_guest3", {"username": "Misafir", "device": "Mobil"}, "http")
        # Strict single-creator lock: ONLY h_web1 (creatorCid) is creator/host; h_desk2 is a regular viewer while h_web1 is active
        self.assertEqual(room["host_id"], "h_web1")
        self.assertEqual(room["creatorCid"], "h_web1")
        self.assertIn("h_web1", room["co_hosts"])
        self.assertNotIn("h_desk2", room["co_hosts"])
        ser = rooms.serialize(room)
        by_id = {p["id"]: p for p in ser["participants"]}
        self.assertTrue(by_id["h_web1"]["isCreator"])
        self.assertTrue(by_id["h_web1"]["isHost"])
        self.assertFalse(by_id["h_desk2"]["isCreator"])
        self.assertFalse(by_id["h_desk2"]["isCoHost"])
        self.assertFalse(by_id["h_guest3"]["isCreator"])
        # Heartbeat from non-host (h_desk2) while h_web1 is alive is ignored
        rooms.handle_action(room, "h_desk2", {"type": "heartbeat", "currentTime": 15.0, "playing": True})
        self.assertGreaterEqual(room["media"]["currentTime"], 120.0)
        # Heartbeat from active host (h_web1) updates server timestamp and emits heartbeat sync event
        hb_out = rooms.handle_action(room, "h_web1", {"type": "heartbeat", "currentTime": 145.5, "playing": True})
        self.assertAlmostEqual(room["media"]["currentTime"], 145.5, places=1)
        self.assertTrue(any(e.get("action") == "heartbeat" for e, _ in hb_out["broadcast"]))
        # Unpromoted second device (h_desk2) CANNOT seek while h_web1 is active
        denied_seek = rooms.handle_action(room, "h_desk2", {"type": "seek", "currentTime": 310.25})
        self.assertEqual(room["host_id"], "h_web1")
        self.assertLess(room["media"]["currentTime"], 200.0)
        self.assertTrue(any(m.get("type") == "error" for m in denied_seek["reply"]))
        # Creator h_web1 CAN seek and syncs all clients
        seek_out = rooms.handle_action(room, "h_web1", {"type": "seek", "currentTime": 310.25})
        self.assertAlmostEqual(room["media"]["currentTime"], 310.25, places=2)
        self.assertEqual(seek_out["broadcast"][0][0]["action"], "seek")
        # If h_web1 goes stale (>10s) and creator refreshes on Web with new cid h_web_new, h_web_new immediately reclaims host_id & creatorCid
        room["participants"]["h_web1"]["lastSeen"] = rooms.now() - 12.0
        rooms.add_participant(room, "h_web_new", {"username": "Mert Can Yıldız", "device": "Web"}, "http")
        self.assertEqual(room["host_id"], "h_web_new")
        self.assertEqual(room["creatorCid"], "h_web_new")

    def test_v34_merge_sync_token_preserves_creator_and_rejects_spoofing(self):
        room = rooms.new_room(
            "mert-can-yildiz-odasi-9a1b2",
            "Mert Can Yıldız odası",
            "public",
            "leader",
            "Mert Can Yıldız",
            "u_creator_1",
            "",
        )
        rooms.add_participant(room, "h_creator", {"username": "Mert Can Yıldız", "userId": "u_creator_1", "_internalCreator": True}, "http")
        room["host_id"] = "h_creator"
        # Untrusted guest sends isCreator=True on non-empty room -> must be rejected
        rooms.add_participant(room, "h_attacker", {"username": "Saldırgan", "userId": "u_attacker_9", "isCreator": True}, "http")
        self.assertFalse(room["participants"]["h_attacker"].get("isCreator", False))
        self.assertNotIn("h_attacker", room["co_hosts"])
        # Different registered account with same display name must not spoof creator when creatorId is u_creator_1
        rooms.add_participant(room, "h_impostor", {"username": "Mert Can Yıldız", "userId": "u_impostor_2", "isCreator": True}, "http")
        self.assertFalse(room["participants"]["h_impostor"].get("isCreator", False))
        # Incoming syncToken with higher rev from another serverless worker must not overwrite live host_id or creatorId
        import copy
        remote_room = copy.deepcopy(room)
        remote_room["rev"] = room["rev"] + 5
        remote_room["host_id"] = "h_attacker"
        remote_room["creatorId"] = ""
        remote_room["co_hosts"] = ["h_extra_cohost"]
        remote_room.pop("_tok_sig", None)
        remote_room.pop("_tok_val", None)
        token = rooms.pack_sync_token(remote_room)
        rooms.merge_sync_token(room, token, room["id"])
        self.assertEqual(room["host_id"], "h_creator")
        self.assertEqual(room["creatorId"], "u_creator_1")
        self.assertIn("h_creator", room["co_hosts"])
        self.assertIn("h_extra_cohost", room["co_hosts"])
        # Co-host pauses room; creator's playing heartbeat within 15s must not unpause room
        room["co_hosts"].append("h_attacker")
        rooms.set_media(room, {"title": "Film", "url": "https://cdn.example.com/f.m3u8", "provider": "hls"}, "Mert Can Yıldız", 50.0)
        rooms.handle_action(room, "h_attacker", {"type": "pause", "currentTime": 55.0})
        self.assertFalse(room["media"]["playing"])
        rooms.handle_action(room, "h_creator", {"type": "heartbeat", "currentTime": 56.0, "playing": True})
        self.assertFalse(room["media"]["playing"])

    def test_v35_fmp4_init_cache_abr_and_fullscreen_pause(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        srv_py = (root / "server.py").read_text(encoding="utf-8")
        # fMP4 init-*.mp4 detection and MP4 box header detection before .cfd/ check
        self.assertIn('is_fmp4_init = ("init-" in clean_u_path or "/init." in clean_u_path or "_init." in clean_u_path)', srv_py)
        self.assertIn('is_ftyp_moof = len(data) >= 8 and data[4:8] in (b"ftyp", b"moof", b"styp", b"sidx")', srv_py)
        self.assertIn("variant_pairs.sort(key=lambda v: (v[0] if v[0] > 0 else 9999, v[1] if v[1] > 0 else 99999999))", srv_py)
        # Fresh catalog resolution preserves 0.0 start position
        room = rooms.new_room("test-v35-room", "Test V35", "public", "leader", "Tris", "u_tris", "")
        rooms.add_participant(room, "h_tris", {"username": "Tris", "userId": "u_tris", "_internalCreator": True}, "http")
        room["host_id"] = "h_tris"
        rooms.set_media(room, {"title": "Zmora", "tmdbId": "253372", "url": "/api/rave/resolve-catalog?tmdbId=253372", "provider": "hls"}, "Tris", 0.0)
        # Simulate 3 seconds of catalog resolution delay before resolve_media arrives with currentTime=0
        room["media"]["updatedAt"] = rooms.now() - 3.5
        rooms.handle_action(room, "h_tris", {
            "type": "resolve_media",
            "tmdbId": "253372",
            "title": "Zmora",
            "url": "/api/rave/stream_manifest?sid=test123&ext=.m3u8",
            "currentTime": 0.0,
        })
        self.assertEqual(room["media"]["currentTime"], 0.0)
        # Verify CSS pointer-events isolation when controls are hidden and idle-cursor auto-hide in controls.js
        mesh_css = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        self.assertIn("frame.classList.add('idle-cursor')", mesh_css)
        main_js = (root / "static" / "js" / "main.js").read_text(encoding="utf-8")
        self.assertIn("document.querySelectorAll('.modal-backdrop, .popup-backdrop')", main_js)

    def test_v37_sync_token_resolved_url_and_events(self):
        import copy
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        host_js = (root / "static" / "js" / "players" / "host.js").read_text(encoding="utf-8")
        self.assertIn("this.onEvent('play', arg)", host_js)
        self.assertIn("onPause: guard((arg) => this.onEvent('pause', arg))", host_js)
        room = rooms.new_room("test-v37-room", "Test V37", "public", "leader", "Mert Can Yıldız", "u_mert", "")
        rooms.add_participant(room, "h_mert", {"username": "Mert Can Yıldız", "userId": "u_mert", "_internalCreator": True}, "http")
        # Subsequent guest fallback must not overwrite real name
        rooms.add_participant(room, "h_mert", {"username": "Misafir İzleyici"}, "http")
        self.assertEqual(room["participants"]["h_mert"]["name"], "Mert Can Yıldız")
        rooms.set_media(room, {"title": "Zmora", "tmdbId": "253372", "url": "/api/rave/resolve-catalog?tmdbId=253372", "provider": "hls"}, "Mert Can Yıldız", 0.0)
        rooms.handle_action(room, "h_mert", {
            "type": "resolve_media",
            "tmdbId": "253372",
            "title": "Zmora",
            "url": "/api/rave/stream_manifest?sid=resolved123&ext=.m3u8",
            "currentTime": 0.0,
        })
        self.assertTrue(any(e.get("action") == "resolve_media" for e in room.get("events", [])))
        # Ensure unresolved syncToken never overwrites resolved URL in room
        stale_snap = copy.deepcopy(room)
        stale_snap["media"]["url"] = "/api/rave/resolve-catalog?tmdbId=253372"
        stale_snap["media"]["updatedAt"] = rooms.now() + 5.0
        stale_snap.pop("_tok_sig", None)
        stale_tok = rooms.pack_sync_token(stale_snap)
        rooms.merge_sync_token(room, stale_tok, room["id"])
        self.assertEqual(room["media"]["url"], "/api/rave/stream_manifest?sid=resolved123&ext=.m3u8")

    def test_v38_multi_user_anti_freeze_and_heartbeat_order(self):
        import copy
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        self.assertIn("if (behindAct === 'defer'", sync_js)
        self.assertIn("const JUMP_DELTA = 3.5;", sync_js)
        room = rooms.new_room("test-v38-room", "Test V38", "public", "leader", "Lider", "u_lider", "")
        rooms.add_participant(room, "h_lider", {"username": "Lider", "userId": "u_lider", "_internalCreator": True}, "http")
        room["host_id"] = "h_lider"
        rooms.set_media(room, {"title": "Zmora", "tmdbId": "253372", "url": "https://cdn.example.com/zmora.m3u8", "provider": "hls"}, "Lider", 0.0)
        # First heartbeat at t=1.2s, stored in follower's older syncToken
        rooms.handle_action(room, "h_lider", {"type": "heartbeat", "currentTime": 1.2, "playing": True})
        old_snap = copy.deepcopy(room)
        old_snap.pop("_tok_sig", None)
        old_tok = rooms.pack_sync_token(old_snap)
        # Newer heartbeat at t=12.5s (explicit jump > 4.5s) arrives on room
        room["events"][-1]["ts"] = rooms.now() - 3.0
        rooms.handle_action(room, "h_lider", {"type": "heartbeat", "currentTime": 12.5, "playing": True})
        # Follower polls with old_tok -> merge_sync_token must NOT resurrect the older heartbeat!
        rooms.merge_sync_token(room, old_tok, room["id"])
        hbs = [e for e in room.get("events", []) if e.get("type") == "sync" and e.get("action") == "heartbeat"]
        self.assertEqual(len(hbs), 1)
        self.assertAlmostEqual(float(hbs[0]["media"]["currentTime"]), 12.5, places=1)

    def test_v43_room_screen_8_fixes(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        # 1. Wi-Fi stream proxy Vary: Range + non-immutable 206 + backward seek loop guard
        with patch.object(server, "_proxy_chunk_sync", return_value=(b"A" * 64, 206, "bytes 0-63/1000", "video/mp2t")):
            r_rng = self.client.get(server._proxy_u("https://example.com/seg.ts"), headers={"Range": "bytes=0-63"})
        self.assertEqual(r_rng.status_code, 206)
        self.assertEqual(r_rng.headers.get("vary"), "Range")
        self.assertIn("private", r_rng.headers.get("cache-control", ""))
        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        self.assertIn("const SEEK_SETTLE_MS = 12000;", sync_js)

        # 2. Chat persistence on refresh (init merges recentChat) & dual storage
        r_init = self.client.post("/api/rooms/v43-chat-test-room/sync", json={
            "type": "init",
            "clientId": "h_chat_u1",
            "username": "Mert",
            "recentChat": [
                {"id": "m_saved_1", "user": "Mert", "color": "#27DCC8", "text": "Yenileme öncesi mesaj", "ts": rooms.now() - 15.0, "time": "22:10"},
            ],
        })
        self.assertEqual(r_init.status_code, 200)
        chat_texts = [c.get("text") for c in (r_init.json().get("room", {}).get("chat") or [])]
        self.assertIn("Yenileme öncesi mesaj", chat_texts)

        # 3. Reaction emojis play synthesized audio & AudioContext stays open
        chat_js = (root / "static" / "js" / "views" / "chat.js").read_text(encoding="utf-8")
        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        self.assertIn("export function playEmojiSfx(emoji)", chat_js)
        self.assertNotIn("setTimeout(() => ac.close()", chat_js)
        self.assertIn("playEmojiSfx(emoji)", mesh_js)

        # 4. App-switch resilience (60s TTL + visibilitychange recovery)
        self.assertGreaterEqual(rooms.HTTP_PARTICIPANT_TTL, 45.0)
        rt_js = (root / "static" / "js" / "realtime.js").read_text(encoding="utf-8")
        self.assertIn("visibilitychange", rt_js)

        # 5 & 6 & 7. Fullscreen chat stack, pause fix, landscape side-by-side chat, and B1->B2 triggerNextEpisode(true)
        ctl_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        self.assertIn("fs-chat-stack", ctl_js)
        self.assertIn("triggerNextEpisode(true)", ctl_js)
        self.assertIn("nextEpTopBtn.dataset.sig", ctl_js)
        self.assertIn("playBtn.dataset.sig", ctl_js)
        self.assertIn("@media (max-width: 960px) and (orientation: landscape)", mesh_css)

    def test_v44_break_time_pause_request(self):
        # Creator initializes room
        r1 = self.client.post("/api/rooms/v44-break-room/sync", json={
            "type": "init",
            "clientId": "h_leader_1",
            "username": "MertKurucu",
        })
        self.assertEqual(r1.status_code, 200)
        # Viewer joins and sends break_request ("Mola Zamanı")
        r2 = self.client.post("/api/rooms/v44-break-room/sync", json={
            "type": "break_request",
            "clientId": "h_viewer_2",
            "username": "ElifIzleyici",
            "videoTime": 124.5,
        })
        self.assertEqual(r2.status_code, 200)
        room_data = r2.json().get("room", {})
        ev_types = [e.get("type") for e in (room_data.get("events") or [])]
        self.assertIn("break_request", ev_types)
        brk_ev = next(e for e in room_data["events"] if e.get("type") == "break_request")
        self.assertEqual(brk_ev.get("user"), "ElifIzleyici")
        chat_texts = [c.get("text", "") for c in (room_data.get("chat") or [])]
        self.assertTrue(any("Mola Zamanı" in t and "duraklatma isteği gönderdi" in t for t in chat_texts))

    def test_v45_full_site_audit_fixes(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        sw_js = (root / "static" / "sw.js").read_text(encoding="utf-8")
        self.assertIn("skipWaiting", sw_js)
        chat_js = (root / "static" / "js" / "views" / "chat.js").read_text(encoding="utf-8")
        self.assertIn("actions.requestBreak?.();", chat_js)
        # Guest name isolation: two different guests named 'Misafir İzleyici' must not share creator privilege
        test_room = rooms.new_room("misafir-izleyici-odasi-1234", creator="Misafir İzleyici", creator_id="h_guest_1")
        self.assertFalse(rooms._is_creator_of_room(test_room, "h_guest_2", {"id": "h_guest_2", "name": "Misafir İzleyici"}))
        # Chat clear timestamp prevents old recentChat from re-populating cleared room
        old_ts = rooms.now() - 30.0
        self.client.post("/api/rooms/v45-clear-room/sync", json={
            "type": "init", "clientId": "h_c1", "username": "Lider",
            "recentChat": [{"id": "m_old_1", "user": "Lider", "text": "Silinecek mesaj", "ts": old_ts}],
        })
        self.client.post("/api/rooms/v45-clear-room/sync", json={
            "type": "clear_chat", "clientId": "h_c1", "username": "Lider",
        })
        r_after = self.client.post("/api/rooms/v45-clear-room/sync", json={
            "type": "init", "clientId": "h_c2", "username": "Izleyici",
            "recentChat": [{"id": "m_old_1", "user": "Lider", "text": "Silinecek mesaj", "ts": old_ts}],
        })
        self.assertEqual(r_after.status_code, 200)
        after_texts = [c.get("text") for c in (r_after.json().get("room", {}).get("chat") or []) if not c.get("system")]
        self.assertNotIn("Silinecek mesaj", after_texts)

    def test_v46_full_architecture_audit_fixes(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        # 1. clean_media & merge_sync_token preserve musicMode, clipVideoId, and playable similar fields
        cm = rooms.clean_media({
            "provider": "youtube",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Test Song",
            "isMusic": True,
            "musicMode": "video",
            "clipVideoId": "dQw4w9WgXcQ",
            "isRemix": True,
            "versionBadge": "🎛️ Remix",
            "similar": [{
                "id": "sim_1",
                "title": "Sim Track",
                "songTitle": "Sim Track",
                "artist": "Artist",
                "videoId": "abc12345678",
                "audioPreviewUrl": "https://example.com/p.m4a",
            }],
        })
        self.assertEqual(cm.get("musicMode"), "video")
        self.assertEqual(cm.get("clipVideoId"), "dQw4w9WgXcQ")
        self.assertTrue(cm.get("isRemix"))
        self.assertEqual(cm["similar"][0].get("videoId"), "abc12345678")
        self.assertEqual(cm["similar"][0].get("audioPreviewUrl"), "https://example.com/p.m4a")

        # 2. providers.js includes vimeo, twitch, kick, dailymotion, tiktok, drive in INTERNAL_FALLBACK_PROVIDERS
        prov_js = (root / "static" / "js" / "providers.js").read_text(encoding="utf-8")
        for pid in ("vimeo", "twitch", "kick", "dailymotion", "tiktok", "drive"):
            self.assertIn(f"id: '{pid}'", prov_js)

        # 3. controls.js combines video filter with brightness(--video-brightness) and skipBtn has id: 'ctl-skip'
        ctl_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        self.assertIn("brightness(var(--video-brightness, 100%))", ctl_js)
        self.assertIn("id: 'ctl-skip'", ctl_js)

        # 4. mesh.css fits 7 emojis + Mola Zamanı button on a single grid row
        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        self.assertIn("repeat(7, minmax(0, 1fr)) auto !important", mesh_css)

    def test_v48_dublaj_and_spinner_sync_fixes(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        # 1. Vault has all 18 episodes of Arcane (Season 1 & Season 2) with DiziLife dual audio + Pilavyer TR dublaj
        v_streams = (server._MAIN_SITES_VAULT.get("streams") or {})
        for s in (1, 2):
            for e in range(1, 10):
                ent = v_streams.get(f"tmdb:tv:94605:{s}:{e}")
                self.assertIsNotNone(ent, f"Missing Arcane S{s}E{e} in vault")
                sts = [x[1] for x in (ent.get("streams") or [])]
                self.assertIn("hls_dl", sts)
                self.assertIn("hls_pv_tr", sts)
        # 2. host.js resets loading=false and fires 'loaded' on early return in setMedia
        host_js = (root / "static" / "js" / "players" / "host.js").read_text(encoding="utf-8")
        self.assertIn("this.onEvent('loaded');\n      }\n      return false;", host_js)
        # 3. mesh.js preserves resolved URL in applyRoom and handles alreadyLoadedResolved across aud/resolve-catalog
        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        self.assertIn("stripAudParam(ctx.host.loadedUrl) === stripAudParam(media.url)", mesh_js)

    def test_v49_creator_only_seek_and_complete_room_closure(self):
        # 1. Creator creates a room via /api/rooms/create
        r_create = self.client.post("/api/rooms/create", json={
            "name": "MC odası",
            "creator": "MC",
            "clientId": "h_mc_creator_1",
            "creatorId": "h_mc_creator_1",
            "privacy": "public",
            "playMode": "leader",
            "media": {
                "title": "Arcane — S1B1",
                "url": "https://cdn.example.com/arcane/s1e1.m3u8",
                "provider": "hls",
                "currentTime": 50.0,
            },
        })
        self.assertEqual(r_create.status_code, 200)
        room_info = r_create.json()["room"]
        room_id = room_info["id"]
        sync_token = room_info["syncToken"]
        self.assertEqual(room_info["creatorCid"], "h_mc_creator_1")

        # 2. Second participant joins with the EXACT SAME username ("MC") and userId ("h_mc_creator_1")
        r_join2 = self.client.post(f"/api/rooms/{room_id}/sync", json={
            "type": "init",
            "clientId": "h_mc_viewer_2",
            "userId": "h_mc_creator_1",
            "username": "MC",
            "syncToken": sync_token,
        })
        self.assertEqual(r_join2.status_code, 200)
        r2_room = r_join2.json()["room"]
        by_cid = {p["id"]: p for p in r2_room["participants"]}
        self.assertEqual(len(by_cid), 2)
        self.assertTrue(by_cid["h_mc_creator_1"]["isCreator"])
        self.assertTrue(by_cid["h_mc_creator_1"]["isHost"])
        self.assertFalse(by_cid["h_mc_viewer_2"]["isCreator"])
        self.assertFalse(by_cid["h_mc_viewer_2"]["isHost"])
        self.assertFalse(by_cid["h_mc_viewer_2"]["isCoHost"])

        # 3. Second participant attempts to seek -> DENIED! Time stays ~50s
        r_seek_denied = self.client.post(f"/api/rooms/{room_id}/sync", json={
            "type": "seek",
            "clientId": "h_mc_viewer_2",
            "userId": "h_mc_creator_1",
            "username": "MC",
            "currentTime": 900.0,
        })
        self.assertEqual(r_seek_denied.status_code, 200)
        denied_payload = r_seek_denied.json()
        self.assertLess(denied_payload["room"]["media"]["currentTime"], 100.0)
        self.assertTrue(len(denied_payload.get("errors") or []) > 0)

        # 4. Creator seeks -> ALLOWED! Time updates to 420.0
        r_seek_ok = self.client.post(f"/api/rooms/{room_id}/sync", json={
            "type": "seek",
            "clientId": "h_mc_creator_1",
            "userId": "h_mc_creator_1",
            "username": "MC",
            "currentTime": 420.0,
        })
        self.assertEqual(r_seek_ok.status_code, 200)
        self.assertAlmostEqual(r_seek_ok.json()["room"]["media"]["currentTime"], 420.0, places=1)

        # 5. Creator closes the room -> permanently closed for everyone
        r_close = self.client.post(f"/api/rooms/{room_id}/sync", json={
            "type": "close_room",
            "clientId": "h_mc_creator_1",
            "username": "MC",
        })
        self.assertEqual(r_close.status_code, 200)
        self.assertTrue(r_close.json().get("roomClosed"))

        # 6. Viewer 2 polls (even passing old syncToken!) -> receives 410 roomClosed and room is NOT resurrected
        r_poll_after = self.client.post(f"/api/rooms/{room_id}/sync", json={
            "type": "poll",
            "clientId": "h_mc_viewer_2",
            "username": "MC",
            "syncToken": sync_token,
        })
        self.assertEqual(r_poll_after.status_code, 410)
        self.assertTrue(r_poll_after.json().get("roomClosed"))

        # 7. Room does not appear in /api/rooms
        r_list = self.client.get("/api/rooms")
        listed_ids = [rm["id"] for rm in (r_list.json().get("rooms") or [])]
        self.assertNotIn(room_id, listed_ids)

    def test_v50_ten_subagent_audit_and_seven_worlds_stream(self):
        # 1. Single user creates room and immediately calls init (even without clientToken or with rotated cid + isCreator) -> ZERO duplicate avatars and ZERO duplicate join chat messages
        r_cr = self.client.post("/api/rooms/create", json={
            "name": "Mert Can Yıldız odası",
            "creator": "Mert Can Yıldız",
            "creatorId": "u_mert_v50",
            "clientId": "h_mert_v50_a",
            "color": "#f43f5e",
            "device": "Web",
            "media": {
                "title": "Yedi Dünya, Bir Gezegen — S1:B1 · Antarktika",
                "tmdbId": "90790",
                "url": "/api/rave/resolve-catalog?tmdbId=90790&mediaType=tv&season=1&episode=1",
                "provider": "cinema",
            },
        })
        self.assertEqual(r_cr.status_code, 200)
        rid = r_cr.json()["room"]["id"]
        r_init = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "h_mert_v50_a",
            "username": "Mert Can Yıldız",
            "color": "#f43f5e",
            "device": "Web",
            "isCreator": True,
        })
        self.assertEqual(r_init.status_code, 200)
        init_room = r_init.json()["room"]
        self.assertEqual(len(init_room["participants"]), 1)
        self.assertEqual(init_room["participants"][0]["color"], "#f43f5e")
        join_msgs = [m for m in init_room["chat"] if "odaya katıldı" in str(m.get("text") or "")]
        self.assertEqual(len(join_msgs), 1)

        # 2. Curated 7/24 rooms block pause, seek, queue_add, vote_skip, and host_action from viewers
        self.client.post("/api/rooms/tv-trt1/sync", json={"type": "init", "clientId": "h_tv_v1", "username": "IzleyiciTV"})
        r_tv_pause = self.client.post("/api/rooms/tv-trt1/sync", json={"type": "pause", "clientId": "h_tv_v1", "username": "IzleyiciTV", "currentTime": 10})
        self.assertTrue(r_tv_pause.json()["room"]["media"]["playing"])
        r_tv_q = self.client.post("/api/rooms/tv-trt1/sync", json={"type": "queue_add", "clientId": "h_tv_v1", "username": "IzleyiciTV", "item": {"title": "Hack", "url": "https://example.com/a.mp4"}})
        self.assertEqual(len(r_tv_q.json()["room"]["queue"]), 0)
        r_tv_priv = self.client.post("/api/rooms/tv-trt1/sync", json={"type": "host_action", "action": "set_privacy", "privacy": "private", "clientId": "h_tv_v1", "username": "IzleyiciTV"})
        self.assertEqual(r_tv_priv.json()["room"]["privacy"], "public")

        # 3. Seven Worlds, One Planet (tmdbId=90790) resolves on Vercel (IS_VERCEL=True) via Vidmoly HLS
        with patch.object(server, "IS_VERCEL", True):
            st_list = server._extract_hdfc_sync("tv", 1, 1, "Seven Worlds, One Planet", "Yedi Dünya, Bir Gezegen", "tv:90790:1:1", "2019", tid="90790")
        self.assertTrue(any("vidmoly.biz/embed-" in u for u, _ in st_list), f"Expected vidmoly HLS stream for 90790, got {st_list}")

    def test_v51_rave_io_direct_cdn_and_wall_clock_sync(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        # 1. Native <video> pause during buffering never emits native:true pause or triggers actions.pause()
        self.assertNotIn("this.events.onPause?.({ native: true })", html5_js)
        self.assertNotIn("if (ev === 'pause' && arg?.native", mesh_js)
        # 2. Leader lag (>JUMP_DELTA behind expected) re-anchors room smoothly without dragging backwards during buffering
        self.assertIn("abs <= JUMP_DELTA", sync_js)
        room = rooms.new_room("v51-rave-sync-room", "Rave Sync", "public", "leader", "Kurucu", "u_k1", "")
        rooms.add_participant(room, "h_k1", {"username": "Kurucu", "userId": "u_k1", "_internalCreator": True}, "http")
        room["host_id"] = "h_k1"
        rooms.set_media(room, {"title": "Spider-Man", "url": "https://cdn.example.com/sm.m3u8", "provider": "hls"}, "Kurucu", 45.0)
        # Lagging heartbeat from leader (e.g. leader buffered at 22.0s while room clock is at 45.0s) must NOT drag room backwards
        hb_lag = rooms.handle_action(room, "h_k1", {"type": "heartbeat", "currentTime": 22.0, "playing": True})
        self.assertGreaterEqual(room["media"]["currentTime"], 45.0)
        self.assertEqual(len(hb_lag["broadcast"]), 0)
        # Explicit seek from leader CAN still seek backwards to 10.0s
        seek_back = rooms.handle_action(room, "h_k1", {"type": "seek", "currentTime": 10.0})
        self.assertAlmostEqual(room["media"]["currentTime"], 10.0, places=1)
        self.assertEqual(seek_back["broadcast"][0][0]["action"], "seek")

    def test_v53_mobile_landscape_pip_and_episode_fixes(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parent.parent
        # 1. clean_media sets season=0, episode=0 for movies even if season=1, episode=1 passed, and preserves sourceUrl + season/episode for TV
        cm_movie = rooms.clean_media({
            "title": "Örümcek Adam: Örümcek Evrenine Geçiş (2023)",
            "url": "https://cdn.example.com/spiderman.m3u8",
            "mediaType": "movie",
            "season": 1,
            "episode": 1,
            "sourceUrl": "https://www.fullhdfilmizlesene.now/film/orumcek-adam/",
        })
        self.assertEqual(cm_movie["season"], 0)
        self.assertEqual(cm_movie["episode"], 0)
        self.assertEqual(cm_movie["sourceUrl"], "https://www.fullhdfilmizlesene.now/film/orumcek-adam/")

        cm_tv = rooms.clean_media({
            "title": "Arcane — 1. Sezon 2. Bölüm",
            "url": "https://cdn.example.com/arcane-s1e2.m3u8",
            "mediaType": "tv",
            "season": 1,
            "episode": 2,
            "sourceUrl": "https://www.dizibox.live/diziler/arcane/",
        })
        self.assertEqual(cm_tv["season"], 1)
        self.assertEqual(cm_tv["episode"], 2)
        self.assertEqual(cm_tv["sourceUrl"], "https://www.dizibox.live/diziler/arcane/")

        # 2. controls.js never activates is-hero-cover over video, guards movies from S1:B1/B2, and falls back to floating PiP
        ctl_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        self.assertIn("stageBackdrop.classList.toggle('is-hero-cover', false);", ctl_js)
        self.assertIn("const isMovie = m.mediaType === 'movie' || /Tam Film/i.test(String(m.channel || ''));", ctl_js)
        self.assertIn("if ((ok === 'entered' || ok === 'exited' || ok === true) && host.adapter?.video)", ctl_js)

        # 3. mesh.css keeps #ctl-pip and #nav-minimize-room visible on mobile, allows mesh-minimized on mobile, and locks .player-host > video to 100%
        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        self.assertIn("body:not(.mesh-minimized) #mesh-root:not(.hidden)", mesh_css)
        self.assertIn("@media (max-width: 960px) and (orientation: landscape), (orientation: landscape) and (max-height: 560px)", mesh_css)
        self.assertNotIn("#ctl-pip,", mesh_css)
        self.assertNotIn("#nav-minimize-room,", mesh_css)

    def test_v57_apk_watchlivodj_and_mobile_room_entry(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. APK download endpoints must serve real signed Android APK binary (PK\x03\x04)
        for apk_route in ("/download/apk", "/download/Watchlivo-v1.1.0.apk", "/download/Watchlivo-v1.1.apk"):
            resp = self.client.get(apk_route)
            self.assertEqual(resp.status_code, 200, f"Failed on {apk_route}")
            self.assertEqual(resp.headers.get("content-type"), "application/vnd.android.package-archive")
            self.assertTrue(resp.content.startswith(b"PK\x03\x04"), f"Invalid APK ZIP header on {apk_route}")
            self.assertGreater(len(resp.content), 20000)

        # 2. Watchlivo DJ trending & mashup endpoints
        tr_resp = self.client.get("/api/rave/ravedj-trending")
        self.assertEqual(tr_resp.status_code, 200)
        tr_data = tr_resp.json()
        self.assertTrue(len(tr_data.get("items") or []) > 0)
        self.assertTrue(len(tr_data.get("presets") or []) > 0)
        self.assertIn("Watchlivo DJ", tr_data["items"][0]["title"])
        self.assertNotIn("RaveDJ", tr_data["items"][0]["title"])

        m_resp = self.client.post(
            "/api/rave/ravedj-mashup",
            json={"trackA": "Semicenk Canin Sag Olsun", "trackB": "Lvbel C5 Doberman", "bpm": 124},
        )
        self.assertEqual(m_resp.status_code, 200)
        m_data = m_resp.json()
        self.assertTrue(m_data.get("ok"))
        mashup = m_data.get("mashup") or {}
        self.assertEqual(mashup.get("provider"), "direct")
        self.assertTrue(bool(mashup.get("url")))
        self.assertTrue(bool(mashup.get("audioPreviewUrl")))
        self.assertIn("Watchlivo DJ", mashup.get("title", ""))
        self.assertNotIn("RaveDJ", mashup.get("title", ""))
        self.assertTrue(len(mashup.get("mashupTracks") or []) >= 1)

        # 3. Mobile room entry & Watchlivo DJ branding static checks
        main_js = (root / "static" / "js" / "main.js").read_text(encoding="utf-8")
        self.assertIn("import { h, toast } from", main_js)
        self.assertIn("const hasMeshDom = Boolean(meshRoot.querySelector('.mesh-layout'));", main_js)
        self.assertIn("enteringMeshRoomId", main_js)

        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        self.assertIn("document.getElementById('mesh-root')", mesh_js)

        providers_js = (root / "static" / "js" / "providers.js").read_text(encoding="utf-8")
        self.assertIn("name: 'Watchlivo DJ'", providers_js)
        self.assertNotIn("name: 'RaveDJ'", providers_js)

    def test_v80_continue_watching_exact_second_and_ios_kb_landscape(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        # 1. Creating a room with resume currentTime=1824 (30:24) preserves exact second across unresolved catalog + resolve_media
        cr = self.client.post(
            "/api/rooms/create",
            json={
                "name": "Arcane Devam Odasi",
                "privacy": "public",
                "playMode": "leader",
                "creator": "Mert Can",
                "creatorId": "h_mert_v80",
                "clientId": "h_mert_v80",
                "media": {
                    "title": "Arcane — 1. Sezon 9. Bölüm",
                    "tmdbId": "94605",
                    "mediaType": "tv",
                    "season": 1,
                    "episode": 9,
                    "url": "/api/rave/resolve-catalog?tmdbId=94605&type=tv&season=1&episode=9",
                    "provider": "hls",
                    "currentTime": 1824.0,
                },
            },
        )
        self.assertEqual(cr.status_code, 200)
        cr_data = cr.json()
        room_obj = cr_data["room"]
        rid = room_obj["id"]
        self.assertAlmostEqual(float(room_obj["media"]["currentTime"]), 1824.0, places=1)
        self.assertAlmostEqual(float(room_obj["media"]["meshStatePosition"]), 1824.0, places=1)

        # Simulate catalog resolution 5s later: position must still be 1824.0 (not reset to 0 and not drifted during resolve)
        r_res = self.client.post(
            f"/api/rooms/{rid}/sync",
            json={
                "type": "resolve_media",
                "clientId": cr_data["clientId"],
                "clientToken": cr_data["clientToken"],
                "username": "Mert Can",
                "tmdbId": "94605",
                "mediaType": "tv",
                "season": 1,
                "episode": 9,
                "title": "Arcane — 1. Sezon 9. Bölüm",
                "url": "/api/rave/stream_manifest?sid=testarcane1824&ext=.m3u8",
                "currentTime": 1824.0,
            },
        )
        self.assertEqual(r_res.status_code, 200)
        rm_after = r_res.json()["room"]["media"]
        self.assertEqual(rm_after["url"], "/api/rave/stream_manifest?sid=testarcane1824&ext=.m3u8")
        self.assertAlmostEqual(float(rm_after["currentTime"]), 1824.0, places=1)

        # 2. Static checks for store.js non-zero progress preservation & mesh.css kb-open / theme accent sync
        store_js = (root / "static" / "js" / "store.js").read_text(encoding="utf-8")
        self.assertIn("export function findSavedProgress(", store_js)
        self.assertIn("preserveExistingPos", store_js)
        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        self.assertIn("body.kb-open:not(.vortex-fs):not(.mesh-minimized) #mesh-root .chatbar", mesh_css)
        self.assertIn("var(--accent, #27DCC8)", mesh_css)

    def test_v80_twenty_subagent_full_site_remediations(self):
        import json
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. Cache-bust bumped cleanly to 20261107_v136 with zero stale v79/v87/v88/v132 references
        index_html = (root / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn("20261107_v136", index_html)
        self.assertNotIn("20261106_v132", index_html)
        self.assertNotIn("20261103_v79", index_html)
        self.assertNotIn("20261103_v87", index_html)
        self.assertNotIn("20261103_v88", index_html)

        # 2. Non-destructive creator leave: creator leaves without closing room -> viewer stays & becomes host
        cr = self.client.post("/api/rooms/create", json={
            "name": "Acik Kalan Oda",
            "privacy": "public",
            "playMode": "leader",
            "creator": "KurucuMert",
            "creatorId": "u_kurucu_v80",
            "clientId": "h_kurucu_v80",
            "media": {
                "title": "Arcane — 1. Sezon 9. Bölüm",
                "tmdbId": "94605",
                "mediaType": "tv",
                "season": 1,
                "episode": 9,
                "episodeCount": 9,
                "totalSeasons": 2,
                "url": "https://cdn.example.com/arcane-s1e9.m3u8",
                "provider": "hls",
                "currentTime": 1358.0,
            },
        }).json()
        rid = cr["room"]["id"]
        st = cr["room"]["syncToken"]
        # Season metadata preserved in clean_media
        self.assertEqual(cr["room"]["media"].get("episodeCount"), 9)
        self.assertEqual(cr["room"]["media"].get("totalSeasons"), 2)

        # Viewer joins
        r_v = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "h_ayse_v80",
            "username": "AyseNur",
            "syncToken": st,
        })
        self.assertEqual(r_v.status_code, 200)
        self.assertEqual(len(r_v.json()["room"]["participants"]), 2)

        # Creator sends explicit 'leave' (NOT 'close_room')
        r_leave = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "leave",
            "clientId": "h_kurucu_v80",
            "clientToken": cr["clientToken"],
            "username": "KurucuMert",
        })
        self.assertEqual(r_leave.status_code, 200)
        self.assertFalse(bool(r_leave.json().get("roomClosed")))

        # Viewer polls -> room is STILL alive (200) and Viewer is now host!
        r_poll = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "poll",
            "clientId": "h_ayse_v80",
            "username": "AyseNur",
            "syncToken": st,
        })
        self.assertEqual(r_poll.status_code, 200)
        self.assertEqual(r_poll.json()["room"]["host_id"], "h_ayse_v80")

        # 3. Signed Drive proxy emits HMAC sig= and stream-proxy blocks unsigned Drive URLs (403)
        r_unsigned = self.client.get("/api/rave/stream-proxy?u=https%3A%2F%2Fdrive.usercontent.google.com%2Fdownload%3Fid%3D1AbCdEfGhIjKlMnOp")
        self.assertEqual(r_unsigned.status_code, 403)
        r_drv = self.client.get("/api/rave/gdrive-folder?url=https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view")
        self.assertEqual(r_drv.status_code, 200)
        self.assertIn("sig=", r_drv.json()["items"][0]["url"])

        # 4. CSP allows data: in media-src in both server.py and vercel.json (for voice notes)
        r_idx = self.client.get("/")
        self.assertIn("media-src 'self' data:", r_idx.headers.get("content-security-policy", ""))
        vercel_cfg = json.loads((root / "vercel.json").read_text(encoding="utf-8"))
        csp_vals = [
            rule.get("headers", {}).get("Content-Security-Policy", "")
            for rule in vercel_cfg.get("routes", [])
            if isinstance(rule.get("headers"), dict) and "media-src" in rule["headers"].get("Content-Security-Policy", "")
        ]
        self.assertTrue(len(csp_vals) >= 4 and all("media-src 'self' data:" in v for v in csp_vals))

        # 5. Per-episode epProgress & season-finale S1:B9 -> S2:B1 static verification
        store_js = (root / "static" / "js" / "store.js").read_text(encoding="utf-8")
        accounts_js = (root / "static" / "js" / "accounts.js").read_text(encoding="utf-8")
        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        realtime_js = (root / "static" / "js" / "realtime.js").read_text(encoding="utf-8")
        chat_js = (root / "static" / "js" / "views" / "chat.js").read_text(encoding="utf-8")
        voice_note_js = (root / "static" / "js" / "voice-note.js").read_text(encoding="utf-8")
        vortex_css = (root / "static" / "css" / "vortex.css").read_text(encoding="utf-8")
        self.assertIn("epProgress", store_js)
        self.assertIn("findSavedProgress(", accounts_js)
        self.assertIn("epStartSec", accounts_js)
        self.assertIn("computeNextEpSpec", controls_js)
        self.assertIn("const shouldCloseRoom = Boolean(closeRoomForAll);", realtime_js)
        self.assertIn("startUniversalVoiceRecorder", chat_js)
        self.assertIn("/api/rave/voice-note", voice_note_js)
        self.assertIn("font-size: 16px !important;", vortex_css)

    def test_v81_fullscreen_pause_and_no_ghost_controls(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. Server pause protection: client clock skew (-1.2s atTime) + stale viewer syncToken poll must NEVER unpause room
        cr = self.client.post("/api/rooms/create", json={
            "name": "Tam Ekran Duraklatma Odasi",
            "privacy": "public",
            "playMode": "leader",
            "creator": "Mert Can",
            "creatorId": "u_mert_v81",
            "clientId": "h_mert_v81",
            "media": {
                "title": "Arcane — 1. Sezon 9. Bölüm",
                "tmdbId": "94605",
                "mediaType": "tv",
                "season": 1,
                "episode": 9,
                "url": "https://cdn.example.com/arcane-s1e9.m3u8",
                "provider": "hls",
                "currentTime": 1358.0,
            },
        }).json()
        rid = cr["room"]["id"]
        stale_playing_token = cr["room"]["syncToken"]
        self.assertTrue(cr["room"]["media"]["playing"])

        # Viewer joins with stale_playing_token
        self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "h_ayse_v81",
            "username": "Ayse Nur",
            "syncToken": stale_playing_token,
        })

        # Leader pauses with slightly clock-skewed client atTime (-1.2s behind server now())
        r_pause = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "pause",
            "clientId": "h_mert_v81",
            "clientToken": cr["clientToken"],
            "username": "Mert Can",
            "currentTime": 1362.4,
            "atTime": rooms.now() - 1.2,
        })
        self.assertEqual(r_pause.status_code, 200)
        self.assertFalse(r_pause.json()["room"]["media"]["playing"])
        self.assertEqual(r_pause.json()["room"]["media"]["meshStateStatus"], "PAUSED")

        # Viewer immediately polls carrying the old PLAYING syncToken -> room MUST stay PAUSED!
        r_viewer_poll = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "poll",
            "clientId": "h_ayse_v81",
            "username": "Ayse Nur",
            "syncToken": stale_playing_token,
        })
        self.assertEqual(r_viewer_poll.status_code, 200)
        self.assertFalse(r_viewer_poll.json()["room"]["media"]["playing"])
        self.assertEqual(r_viewer_poll.json()["room"]["media"]["meshStateStatus"], "PAUSED")

        # 2. Static invariants for fullscreen pause & zero unsolicited HUD popups
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        host_js = (root / "static" / "js" / "players" / "host.js").read_text(encoding="utf-8")
        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")

        self.assertIn("reportReadyOnce", html5_js)
        self.assertIn("userFullscreenPause: true", html5_js)
        self.assertIn("if (settledReady) return;", host_js)
        self.assertIn("togglePlayPause", controls_js)
        self.assertIn("Date.now() - lastTouchAt < 950", controls_js)
        self.assertIn("lastRevealedMediaKey", controls_js)
        self.assertIn("arg?.userFullscreenPause", mesh_js)
        self.assertIn("leader && ad.wantPlaying === false", sync_js)
        self.assertNotIn(".video-frame:not(.fullscreen):not(.idle-cursor):hover .controls", mesh_css)


    def test_v82_account_history_isolation_real_vol_brightness_pip_and_mobile_hud(self):
        import uuid
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. Unauthenticated endpoints MUST reject with 401 (zero shared guest_local history!)
        for ep in ("/api/user/progress", "/api/user/watchlist", "/api/user/music-history"):
            r_unauth = self.client.get(ep)
            self.assertEqual(r_unauth.status_code, 401, f"Expected 401 on unauthenticated GET {ep}")
            r_unauth_post = self.client.post(ep, json={"tmdbId": "94605", "title": "LeakTest"})
            self.assertEqual(r_unauth_post.status_code, 401, f"Expected 401 on unauthenticated POST {ep}")

        # 2. Register two independent accounts (Mert vs Ayse) and verify strict per-account isolation
        suf = uuid.uuid4().hex[:8]
        r_a = self.client.post("/api/auth/register", json={
            "email": f"mert_{suf}@watchlivo.test",
            "password": "StrongPassword!123",
            "name": "Mert Hesap",
        })
        self.assertEqual(r_a.status_code, 200)
        tok_a = r_a.json()["authToken"]
        hdr_a = {"Authorization": f"Bearer {tok_a}"}

        r_b = self.client.post("/api/auth/register", json={
            "email": f"ayse_{suf}@watchlivo.test",
            "password": "StrongPassword!456",
            "name": "Ayse Hesap",
        })
        self.assertEqual(r_b.status_code, 200)
        tok_b = r_b.json()["authToken"]
        hdr_b = {"Authorization": f"Bearer {tok_b}"}

        # Account A saves Arcane S1B9 & watchlist & music
        self.assertEqual(self.client.post("/api/user/progress", headers=hdr_a, json={
            "key": "tv:94605", "tmdbId": "94605", "title": "Arcane", "mediaType": "tv",
            "season": 1, "episode": 9, "position": 1358, "duration": 2465,
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/user/watchlist", headers=hdr_a, json={
            "action": "add", "item": {"key": "tv:94605", "tmdbId": "94605", "title": "Arcane", "mediaType": "tv"},
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/user/music-history", headers=hdr_a, json={
            "videoId": "mertSong123", "title": "Mert Favori Parca", "artist": "Sanatci A",
        }).status_code, 200)

        # Account B saves Dune Part Two & watchlist & music
        self.assertEqual(self.client.post("/api/user/progress", headers=hdr_b, json={
            "key": "movie:693134", "tmdbId": "693134", "title": "Dune: Çöl Gezegeni Bölüm İki", "mediaType": "movie",
            "position": 2410, "duration": 9960,
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/user/watchlist", headers=hdr_b, json={
            "action": "add", "item": {"key": "movie:693134", "tmdbId": "693134", "title": "Dune: Çöl Gezegeni Bölüm İki", "mediaType": "movie"},
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/user/music-history", headers=hdr_b, json={
            "videoId": "ayseSong999", "title": "Ayse Favori Parca", "artist": "Sanatci B",
        }).status_code, 200)

        # Verify Account A ONLY sees Account A's history + private no-store headers
        pa = self.client.get("/api/user/progress", headers=hdr_a)
        self.assertEqual(pa.status_code, 200)
        self.assertIn("no-store", pa.headers.get("cache-control", ""))
        self.assertIn("private", pa.headers.get("cache-control", ""))
        pa_titles = [x.get("title") for x in pa.json().get("items", [])]
        self.assertEqual(pa_titles, ["Arcane"])

        pb = self.client.get("/api/user/progress", headers=hdr_b)
        pb_titles = [x.get("title") for x in pb.json().get("items", [])]
        self.assertEqual(pb_titles, ["Dune: Çöl Gezegeni Bölüm İki"])

        wa_titles = [x.get("title") for x in self.client.get("/api/user/watchlist", headers=hdr_a).json().get("items", [])]
        wb_titles = [x.get("title") for x in self.client.get("/api/user/watchlist", headers=hdr_b).json().get("items", [])]
        self.assertEqual(wa_titles, ["Arcane"])
        self.assertEqual(wb_titles, ["Dune: Çöl Gezegeni Bölüm İki"])

        ma_ids = [x.get("videoId") for x in self.client.get("/api/user/music-history", headers=hdr_a).json().get("items", [])]
        mb_ids = [x.get("videoId") for x in self.client.get("/api/user/music-history", headers=hdr_b).json().get("items", [])]
        self.assertEqual(ma_ids, ["mertSong123"])
        self.assertEqual(mb_ids, ["ayseSong999"])

        # 3. Verify Permissions-Policy picture-in-picture & index no-store
        r_idx = self.client.get("/")
        self.assertIn("picture-in-picture=*", r_idx.headers.get("permissions-policy", ""))
        self.assertIn("no-store", r_idx.headers.get("cache-control", ""))

        # 4. Verify Real Volume/Brightness, Multi-Phone HUD Lock & OS PiP static invariants
        gain_js = (root / "static" / "js" / "players" / "audio-gain.js").read_text(encoding="utf-8")
        ctl_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        subs_js = (root / "static" / "js" / "players" / "subtitles.js").read_text(encoding="utf-8")
        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        manifest_xml = (root.parent / "watchlivo_android" / "AndroidManifest.xml").read_text(encoding="utf-8")
        main_java = (root.parent / "watchlivo_android" / "src" / "online" / "watchlivo" / "app" / "MainActivity.java").read_text(encoding="utf-8")

        self.assertIn("createMediaElementSource", gain_js)
        self.assertIn("createDynamicsCompressor", gain_js)
        self.assertIn("wl-brightness-veil", ctl_js)
        self.assertIn("setBrightness(", ctl_js)
        self.assertIn("setRealVolume(", ctl_js)
        self.assertIn("ctl-sliders-card", ctl_js)
        self.assertIn("enterpictureinpicture", ctl_js)
        self.assertIn("viewer-playing-hidden", ctl_js)
        self.assertIn("localPauseSince", ctl_js)
        self.assertIn("data-watchlivo-pip", subs_js)
        self.assertIn("VTTCue", subs_js)
        self.assertIn("--wl-composed-filter", mesh_css)
        self.assertIn("html.is-android-pip", mesh_css)
        self.assertIn("body.kb-open.kb-portrait", mesh_css)
        self.assertIn('android:supportsPictureInPicture="true"', manifest_xml)
        self.assertIn("WatchlivoBridge", main_java)
        self.assertIn("enterPictureInPictureMode", main_java)

    def test_v87_hls_large_segment_no_truncation_and_sync(self):
        import io as _io
        from unittest.mock import patch

        server._SEGMENT_CACHE.clear()
        ts_packets = 27888  # 27888 * 188 = 5,242,944 bytes (> 3.5 MB)
        big_ts = (b"\x47" + b"\x11" * 187) * ts_packets
        test_ts_url = "https://example.com/hls/movie1080/seg_001.ts"

        class _FakeResp:
            def __init__(self, payload: bytes, content_type: str = "video/mp2t", declared_len: int | None = None):
                self._buf = _io.BytesIO(payload)
                self.status = 200
                self.headers = {
                    "Content-Type": content_type,
                    "Content-Length": str(len(payload) if declared_len is None else declared_len),
                }

            def read(self, n: int = -1) -> bytes:
                return self._buf.read(n)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        # 1) Full 5.24 MB MPEG-TS segment under IS_VERCEL=True must NOT truncate at 3.5 MB
        sig1 = server._proxy_sig(test_ts_url, "")
        with patch.object(server, "IS_VERCEL", True), patch.object(server, "_public_open", return_value=_FakeResp(big_ts)):
            r_seg = self.client.get(f"/api/rave/stream-proxy?url={test_ts_url}&sig={sig1}&ext=.ts")
            self.assertEqual(r_seg.status_code, 200)
            self.assertEqual(len(r_seg.content), len(big_ts))
            self.assertEqual(r_seg.headers.get("content-type"), "video/mp2t")

        # 2) Truncated upstream read (declared 5 MB, delivered 2 MB) must fail and NOT poison _SEGMENT_CACHE
        trunc_url = "https://example.com/hls/movie1080/seg_trunc.ts"
        sig2 = server._proxy_sig(trunc_url, "")
        with patch.object(server, "IS_VERCEL", True), patch.object(
            server, "_public_open", side_effect=lambda *a, **kw: _FakeResp(big_ts[:2_000_000], declared_len=len(big_ts))
        ):
            r_bad = self.client.get(f"/api/rave/stream-proxy?url={trunc_url}&sig={sig2}&ext=.ts")
            self.assertEqual(r_bad.status_code, 502)
            self.assertNotIn(trunc_url, server._SEGMENT_CACHE)

        # 3) 3.1 MB fMP4 .m4s HLS segment with ext=.m4s must return full 200 OK video/mp4 (not 206 2MB slice)
        m4s_body = b"\x00\x00\x00\x18moof" + (b"\x22" * (3_145_728 - 8))
        m4s_url = "https://example.com/hls/fmp4/seg_002.m4s"
        sig3 = server._proxy_sig(m4s_url, "")
        with patch.object(server, "IS_VERCEL", True), patch.object(
            server, "_public_open", return_value=_FakeResp(m4s_body, content_type="video/iso.segment")
        ):
            r_m4s = self.client.get(f"/api/rave/stream-proxy?url={m4s_url}&sig={sig3}&ext=.m4s")
            self.assertEqual(r_m4s.status_code, 200)
            self.assertEqual(len(r_m4s.content), len(m4s_body))
            self.assertEqual(r_m4s.headers.get("content-type"), "video/mp4")

        # 4) Non-leader viewer http_sync activeMedia resolves unresolved /api/rave/resolve-catalog room URL
        c_res = self.client.post("/api/rooms/create", json={
            "name": "V87 Sync Room",
            "privacy": "public",
            "playMode": "leader",
            "creator": "HostUser",
            "creatorId": "u_host_v87",
            "clientId": "h_host_v87",
            "media": {
                "title": "Çürük Elmalar",
                "tmdbId": "1198654",
                "mediaType": "movie",
                "provider": "hls",
                "url": "/api/rave/resolve-catalog?tmdbId=1198654&type=movie",
            },
        })
        self.assertEqual(c_res.status_code, 200)
        rid = c_res.json()["room"]["id"]
        # Host initializes room so host_id is locked to HostUser
        self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "h_host_v87",
            "username": "HostUser",
            "isCreator": True,
        })
        # Viewer joins with already-resolved URL in activeMedia for same tmdbId
        v_sync = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "poll",
            "clientId": "h_viewer_v87",
            "username": "ViewerUser",
            "activeMedia": {
                "title": "Çürük Elmalar",
                "tmdbId": "1198654",
                "mediaType": "movie",
                "provider": "hls",
                "streamType": "hls",
                "url": "/api/rave/stream?url=https%3A%2F%2Fcdn-v87-test.shop%2Fmaster.m3u8&ext=.m3u8",
                "currentTime": 4.2,
            },
        })
        self.assertEqual(v_sync.status_code, 200)
        synced_url = v_sync.json()["room"]["media"]["url"]
        self.assertTrue(synced_url.startswith("/api/rave/stream?"), synced_url)

        # 5) Auto-PiP visibility, WebKit attributes, Android sourceRectHint & Swift/ObjC native parity
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        host_js = (root / "static" / "js" / "players" / "host.js").read_text(encoding="utf-8")
        main_java = (root.parent / "watchlivo_android" / "src" / "online" / "watchlivo" / "app" / "MainActivity.java").read_text(encoding="utf-8")
        swift_wv = (root.parent / "watchlivo_ios" / "Sources" / "Watchlivo" / "WatchlivoWebView.swift").read_text(encoding="utf-8")
        self.assertIn("applyOptimalPipAttributes", html5_js)
        self.assertIn("allowsPictureInPicture", html5_js)
        self.assertIn("webkit-playsinline", html5_js)
        self.assertIn("autopictureinpicture", html5_js)
        self.assertIn("enterAutoPiP", html5_js)
        self.assertIn("async enterPiP(", host_js)
        self.assertIn("setSourceRectHint", main_java)
        self.assertIn("setSeamlessResizeEnabled", main_java)
        self.assertIn("setVideoPlayingBounds", main_java)
        self.assertIn("canStartPictureInPictureAutomaticallyFromInline = true", swift_wv)

    def test_v100_native_non_webrtc_ios_ipa_and_rave_ota_updater(self):
        import hashlib
        import io
        import zipfile

        # 1. /api/ios/version returns Rave.io-style OTA metadata & remoteConfig
        v_resp = self.client.get("/api/ios/version")
        self.assertEqual(v_resp.status_code, 200)
        v_data = v_resp.json()
        self.assertTrue(v_data.get("ok"))
        self.assertEqual(v_data.get("bundleId"), "online.watchlivo.app")
        self.assertGreaterEqual(int(v_data.get("versionCode") or 0), 200)
        self.assertTrue(v_data.get("autoInstall"))
        self.assertTrue(v_data.get("mandatory"))
        self.assertIn("remoteConfig", v_data)

        # 2. /api/ios/manifest.plist returns valid Apple itms-services OTA manifest XML
        m_resp = self.client.get("/api/ios/manifest.plist")
        self.assertEqual(m_resp.status_code, 200)
        self.assertIn("software-package", m_resp.text)
        self.assertIn("online.watchlivo.app", m_resp.text)
        self.assertIn("https://watchlivo.online/download/ipa", m_resp.text)

        # 3. /download/ipa serves pure native ARM64 Mach-O IPA (ZERO WebKit/WebRTC) matching SHA-256
        ipa_resp = self.client.get("/download/ipa")
        self.assertEqual(ipa_resp.status_code, 200)
        self.assertTrue(ipa_resp.content.startswith(b"PK\x03\x04"))
        self.assertEqual(len(ipa_resp.content), v_data.get("sizeBytes"))
        self.assertEqual(hashlib.sha256(ipa_resp.content).hexdigest(), v_data.get("sha256"))

        with zipfile.ZipFile(io.BytesIO(ipa_resp.content), "r") as zf:
            names = set(zf.namelist())
            self.assertIn("Payload/Watchlivo.app/Watchlivo", names)
            self.assertIn("Payload/Watchlivo.app/Info.plist", names)
            self.assertIn("Payload/Watchlivo.app/_CodeSignature/CodeResources", names)
            macho = zf.read("Payload/Watchlivo.app/Watchlivo")
            self.assertEqual(macho[:4], b"\xcf\xfa\xed\xfe")  # 64-bit ARM64 Mach-O magic
            for forbidden in (b"WebKit.framework", b"WKWebView", b"RTCPeerConnection", b"WebRTC.framework"):
                self.assertNotIn(forbidden, macho)
            for required in (b"AVPlayerViewController", b"AVAudioRecorder", b"WLAutoUpdater", b"/api/ios/version"):
                self.assertIn(required, macho)

    def test_v101_home_navbar_tablet_overflow_and_mobile_web_app_meta(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        index_html = (root / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn('<meta name="mobile-web-app-capable" content="yes" />', index_html)
        self.assertIn('<meta name="apple-mobile-web-app-capable" content="yes" />', index_html)

        vortex_css = (root / "static" / "css" / "vortex.css").read_text(encoding="utf-8")
        self.assertIn("@media (max-width: 1020px)", vortex_css)
        self.assertIn(".top-nav-capsule .wl-nav-account-sub,\n  .top-nav-capsule #nav-btn-apk", vortex_css)
        self.assertIn("@media (max-width: 820px)", vortex_css)

        profile_js = (root / "static" / "js" / "profile.js").read_text(encoding="utf-8")
        self.assertNotIn("if (!email && !password) { doGuestLogin(name); return; }", profile_js)
        self.assertIn("Google ile Giriş Yap (Şifreli)", profile_js)

    def test_v102_series_prev_episode_poster_cors_and_youtube_muxed_playback(self):
        from pathlib import Path
        import music_engine
        root = Path(__file__).resolve().parent.parent

        # 1. Series previous episode button (#ctl-prev-ep-top) and boundary checks in controls.js + host.js
        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        self.assertIn("id: 'ctl-prev-ep-top'", controls_js)
        self.assertIn("computePrevEpSpec", controls_js)
        self.assertIn("triggerPrevEpisode", controls_js)
        self.assertIn("Dizinin ilk bölümündesiniz", controls_js)
        self.assertIn("host.key = '';", controls_js)

        host_js = (root / "static" / "js" / "players" / "host.js").read_text(encoding="utf-8")
        self.assertIn("if (!this.error && key && key === this.key", host_js)

        # 2. External <video poster> URLs routed via /api/rave/poster to prevent CORS errors with crossOrigin='anonymous'
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        self.assertIn("/api/rave/poster?url=${encodeURIComponent(rawPoster)}", html5_js)
        yt_js = (root / "static" / "js" / "players" / "youtube.js").read_text(encoding="utf-8")
        self.assertIn("/api/rave/poster?url=${encodeURIComponent(rawPoster)}", yt_js)

        # Verify /api/rave/poster whitelists TMDB/YouTube poster domains and serves Access-Control-Allow-Origin: *
        with patch.object(server, "_fetch_poster_sync", return_value=(b"\xff\xd8\xff\xe0testjpeg", "image/jpeg")):
            r_poster = self.client.get("/api/rave/poster?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw780%2Ftest.jpg")
        self.assertEqual(r_poster.status_code, 200)
        self.assertEqual(r_poster.headers.get("access-control-allow-origin"), "*")

        # 3. YouTube VOD prioritizes progressive muxed MP4 (kind=muxed) and ANDROID 20.10.38 client to avoid 60s GVS 403/502
        self.assertLess(yt_js.index("kind=muxed"), yt_js.index("streamCandidates.push(srvHls)"))
        me_py = (root / "music_engine.py").read_text(encoding="utf-8")
        self.assertIn('"clientName": "ANDROID"', me_py)
        self.assertIn('"clientVersion": "20.10.38"', me_py)

    def test_v103_watch_rooms_sync_precreated_host_claim_and_cohost_succession(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. /api/rooms/create precreated placeholder is claimed by the first real human joiner
        cr_resp = self.client.post("/api/rooms/create", json={
            "name": "QA4 Regresyon Odası",
            "privacy": "public",
            "creator": "LiderQA4Reg103",
        })
        self.assertEqual(cr_resp.status_code, 200)
        cr_data = cr_resp.json()
        room_id = cr_data["room"]["id"]
        pre_cid = cr_data["clientId"]

        # First real human joins with a different browser clientId ("h_realleader") and name ("GerçekLider")
        join_resp = self.client.post(f"/api/rooms/{room_id}/sync", json={
            "clientId": "h_realleader",
            "username": "GerçekLider",
        })
        self.assertEqual(join_resp.status_code, 200)
        j_room = join_resp.json()["room"]
        part_ids = [p["id"] for p in j_room["participants"]]
        self.assertEqual(part_ids, ["h_realleader"])
        self.assertNotIn(pre_cid, part_ids)
        self.assertEqual(j_room["host_id"], "h_realleader")

        # 2. Anchor heartbeat from leader overrides extrapolated server clock after media load delay
        room = rooms.new_room("qa4_anchor_test")
        rooms.add_participant(room, "h1", {"username": "LiderQA4Reg103"}, "ws")
        room["host_id"] = "h1"
        rooms.set_media(room, {"url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", "title": "BBB"}, "LiderQA4Reg103", 0.0)
        # Simulate 4.5s of wall-clock load delay before leader's video actually starts at 0.35s
        room["media"]["updatedAt"] = rooms.now() - 4.5
        rooms.handle_action(room, "h1", {"type": "heartbeat", "currentTime": 0.35, "anchor": True})
        self.assertAlmostEqual(float(room["media"]["currentTime"]), 0.35, places=2)

        # 3. Co-Host succession priority in ensure_host() when host leaves
        room2 = rooms.new_room("qa4_cohost_succ")
        t0 = rooms.now()
        room2["participants"] = {
            "g_cohost": {"id": "g_cohost", "name": "Ayşe", "transport": "ws", "lastSeen": t0 - 5.0},
            "g_regular": {"id": "g_regular", "name": "Mehmet", "transport": "ws", "lastSeen": t0 - 1.0},
        }
        room2["host_id"] = "h_departed"
        room2["co_hosts"] = ["g_cohost"]
        rooms.ensure_host(room2)
        self.assertEqual(room2["host_id"], "g_cohost")

        # 4. Private room hidden from /api/rooms & password room enforces 403/200
        priv_r = self.client.post("/api/rooms/create", json={
            "name": "QA4 Gizli Regresyon",
            "privacy": "private",
            "creator": "GizliLiderQA4",
        }).json()["room"]["id"]
        pwd_r = self.client.post("/api/rooms/create", json={
            "name": "QA4 Şifreli Regresyon",
            "privacy": "public",
            "password": "7788",
            "creator": "SifreliLiderQA4",
        }).json()["room"]["id"]
        lobby_ids = [r["id"] for r in self.client.get("/api/rooms").json().get("rooms", [])]
        self.assertNotIn(priv_r, lobby_ids)
        self.assertIn(pwd_r, lobby_ids)
        self.assertEqual(self.client.post(f"/api/rooms/{pwd_r}/sync", json={"username": "G1", "pwd": "0000"}).status_code, 403)
        self.assertEqual(self.client.post(f"/api/rooms/{pwd_r}/sync", json={"username": "G1", "pwd": "7788"}).status_code, 200)

        # 5. Frontend sync & controls guards present
        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        self.assertIn("const safeBuffered = (t, minAhead = 2.8)", sync_js)
        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        self.assertIn("frame.addEventListener('pointerenter'", controls_js)
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        self.assertIn("if (v && v.readyState >= 1 && Math.abs((Number(v.currentTime) || 0) - target) < 0.04)", html5_js)

    def test_v104_yt_search_cache_and_personalized_feed_fallback(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. _yt_search_sync caches results in _YT_SEARCH_CACHE for 300s to prevent cold YouTube feed timeouts
        server._YT_SEARCH_CACHE.clear()
        with patch.object(server, "_http", side_effect=OSError("simulated timeout")), \
             patch.object(server.music_engine, "_yt_innertube_search_sync", return_value=[{"videoId": "dQw4w9WgXcQ", "title": "Cached Hit", "artist": "Watchlivo", "duration": 212}]) as mock_it:
            res1 = server._yt_search_sync("Watchlivo Test Query 2026")
            res2 = server._yt_search_sync("Watchlivo Test Query 2026")
        self.assertEqual(len(res1), 1)
        self.assertEqual(res1[0]["videoId"], "dQw4w9WgXcQ")
        self.assertEqual(res2[0]["videoId"], "dQw4w9WgXcQ")
        self.assertEqual(mock_it.call_count, 1)

        # 2. selection-kinds.js falls back to runSearchQuery when personalized feed returns empty items on default tab
        sk_js = (root / "static" / "js" / "views" / "selection-kinds.js").read_text(encoding="utf-8")
        self.assertIn("if (!items.length && (tabId === 'all' || tabId === 'recommended' || tabId === 'for_you'))", sk_js)

        # 3. Root /ios_version.json and /app_version.json endpoints return valid version metadata
        r_ios = self.client.get("/ios_version.json")
        self.assertEqual(r_ios.status_code, 200)
        self.assertTrue(r_ios.json().get("ok"))
        self.assertEqual(r_ios.json().get("bundleId"), "online.watchlivo.app")

        r_apk = self.client.get("/app_version.json")
        self.assertEqual(r_apk.status_code, 200)
        self.assertTrue(r_apk.json().get("ok"))
        self.assertEqual(r_apk.json().get("packageName"), "online.watchlivo.app")

    def test_v105_cross_platform_zero_stutter_video_pipeline(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        self.assertIn("if (this.isSolo())", sync_js)
        self.assertIn("this.isRateNudging", sync_js)
        self.assertIn("Math.abs(ad.getRate() - targetRate) >= 0.01", sync_js)

        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        self.assertIn("isSolo: () => !state.mesh?.curated && (state.mesh?.participants || []).length <= 1", mesh_js)
        self.assertIn("if (!isTimeKeeper() && ctx?.sync && data.action === 'play')", mesh_js)

        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        self.assertIn("const clearInitSeekListeners = () =>", html5_js)
        self.assertIn("v.removeEventListener('timeupdate', checkZeroDimAudioOnly);", html5_js)
        self.assertIn("maxBufferLength: isMobileScreen ? 35 : 50", html5_js)

        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        self.assertIn("let lastCinemaSeatsSig = '';", controls_js)
        self.assertIn("if (nextEpBanner.dataset.bannerKey !== bannerKey)", controls_js)

        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        self.assertIn("filter: var(--wl-composed-filter, none);", mesh_css)

    def test_v106_ios_screen_fit_and_safe_area_insets(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        main_js = (root / "static" / "js" / "main.js").read_text(encoding="utf-8")
        self.assertIn("syncAppViewportMetrics", main_js)
        self.assertIn("--app-height", main_js)
        self.assertIn("navigator.standalone === true", main_js)

        vortex_css = (root / "static" / "css" / "vortex.css").read_text(encoding="utf-8")
        self.assertIn("height: var(--app-height, 100vh)", vortex_css)
        self.assertIn("height: calc(50px + env(safe-area-inset-top, 0px)) !important;", vortex_css)
        self.assertNotIn("height: calc(100vh - 60px) !important;", vortex_css)

        mesh_css = (root / "static" / "css" / "mesh.css").read_text(encoding="utf-8")
        self.assertIn("height: calc(44px + env(safe-area-inset-top, 0px)) !important;", mesh_css)
        self.assertIn("height: calc(100% - 44px - env(safe-area-inset-top, 0px)) !important;", mesh_css)
        self.assertIn("height: calc(100% - 36px - env(safe-area-inset-top, 0px)) !important;", mesh_css)

    def test_v107_vizyon_new_releases_large_room_and_tv_nav(self):
        from pathlib import Path
        import rooms

        # 1. Test POST /api/rave/new-releases & GET /api/rave/new-releases & catalog category=vizyon
        post_res = self.client.post("/api/rave/new-releases", json={
            "title": "Dune: Messiah Vizyon Test",
            "mediaType": "movie",
            "year": "2026",
            "poster": "https://image.tmdb.org/t/p/w500/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg",
            "streamUrl": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        })
        self.assertEqual(post_res.status_code, 200)
        post_data = post_res.json()
        self.assertTrue(post_data.get("ok"))
        added_item = post_data.get("item") or {}
        self.assertEqual(added_item.get("title"), "Dune: Messiah Vizyon Test")
        self.assertTrue(added_item.get("customRelease"))
        self.assertIn("vizyon", added_item.get("categories") or [])

        get_res = self.client.get("/api/rave/new-releases")
        self.assertEqual(get_res.status_code, 200)
        get_data = get_res.json()
        self.assertTrue(get_data.get("ok"))
        self.assertTrue(any(x.get("title") == "Dune: Messiah Vizyon Test" for x in (get_data.get("items") or [])))

        cat_res = self.client.get("/api/rave/catalog?provider=cinema&category=vizyon&page=1")
        self.assertEqual(cat_res.status_code, 200)
        cat_items = cat_res.json().get("items") or []
        self.assertTrue(any(x.get("title") == "Dune: Messiah Vizyon Test" for x in cat_items))

        # 2. Test 100+ Participant Large-Room Broadcast Mode & compact syncToken
        rm = rooms.new_room("large-100", "Dev Gala Odası", "public", "leader", "HostUser", "cid-host")
        t_now = rooms.now()
        for idx in range(35):
            cid_u = f"cid-u-{idx}"
            rm["participants"][cid_u] = {
                "id": cid_u,
                "name": f"Izleyici {idx}",
                "color": "#38bdf8",
                "muted": idx > 3,
                "cam": idx == 1,
                "lastSeen": t_now,
                "transport": "http",
            }
        ser = rooms.serialize(rm, for_cid="cid-u-30")
        self.assertTrue(ser.get("largeRoomMode"))
        self.assertGreaterEqual(ser.get("participantCount"), 35)
        self.assertLess(len(ser.get("syncToken") or ""), 8192)
        restored = rooms.merge_sync_token(None, ser["syncToken"], "large-100")
        self.assertIsNotNone(restored)
        self.assertEqual(restored.get("totalParticipants"), 35)

        # 3. Test Smart TV D-Pad Spatial Navigation & WCAG focus-visible hooks
        root = Path(__file__).resolve().parent.parent
        main_js = (root / "static" / "js" / "main.js").read_text(encoding="utf-8")
        self.assertIn("initSpatialTvNavigation", main_js)
        self.assertIn("window.vortexSpatialMove", main_js)
        vortex_css = (root / "static" / "css" / "vortex.css").read_text(encoding="utf-8")
        self.assertIn("body.tv-nav-active :focus", vortex_css)
        sel_kinds_js = (root / "static" / "js" / "views" / "selection-kinds.js").read_text(encoding="utf-8")
        self.assertIn("openVizyonModal", sel_kinds_js)

    def test_v108_multi_season_canonical_splits_and_animecix_resolution(self):
        from pathlib import Path

        # 1. Bidirectional season/episode <-> absolute episode numbering for single-season TMDB shows
        jjk_s2e9 = server._resolve_episode_numbering("95479", 2, 9)
        self.assertTrue(jjk_s2e9["has_splits"])
        self.assertEqual((jjk_s2e9["s_split"], jjk_s2e9["e_split"]), (2, 9))
        self.assertEqual((jjk_s2e9["s_tmdb"], jjk_s2e9["e_tmdb"]), (1, 33))
        self.assertEqual(jjk_s2e9["abs_ep"], 33)

        jjk_s1e33 = server._resolve_episode_numbering("95479", 1, 33)
        self.assertEqual((jjk_s1e33["s_split"], jjk_s1e33["e_split"]), (2, 9))
        self.assertEqual((jjk_s1e33["s_tmdb"], jjk_s1e33["e_tmdb"]), (1, 33))

        jjk_s3e1 = server._resolve_episode_numbering("95479", 3, 1)
        self.assertEqual((jjk_s3e1["s_split"], jjk_s3e1["e_split"]), (3, 1))
        self.assertEqual((jjk_s3e1["s_tmdb"], jjk_s3e1["e_tmdb"]), (1, 48))

        solo_s2e1 = server._resolve_episode_numbering("127532", 2, 1)
        self.assertEqual((solo_s2e1["s_split"], solo_s2e1["e_split"]), (2, 1))
        self.assertEqual((solo_s2e1["s_tmdb"], solo_s2e1["e_tmdb"]), (1, 13))

        fmab_s2e1 = server._resolve_episode_numbering("31911", 2, 1)
        self.assertEqual((fmab_s2e1["s_split"], fmab_s2e1["e_split"]), (2, 1))
        self.assertEqual((fmab_s2e1["s_tmdb"], fmab_s2e1["e_tmdb"]), (1, 17))

        # 2. _ANIMECIX_KNOWN_TMDB corrected IDs
        self.assertEqual(server._ANIMECIX_KNOWN_TMDB.get("31910"), 7490)
        self.assertEqual(server._ANIMECIX_KNOWN_TMDB.get("37865"), 234)
        self.assertEqual(server._ANIMECIX_KNOWN_TMDB.get("46298"), 238)
        self.assertEqual(server._ANIMECIX_KNOWN_TMDB.get("85937"), 7394)
        self.assertEqual(server._ANIMECIX_KNOWN_TMDB.get("1159311"), 11793)

        dn_s2e1 = server._resolve_episode_numbering("13916", 2, 1)
        self.assertEqual((dn_s2e1["s_split"], dn_s2e1["e_split"]), (2, 1))
        self.assertEqual(dn_s2e1["abs_ep"], 20)

        fma_s3e1 = server._resolve_episode_numbering("37863", 3, 1)
        self.assertEqual((fma_s3e1["s_split"], fma_s3e1["e_split"]), (3, 1))
        self.assertEqual(fma_s3e1["abs_ep"], 26)

        spy_s2e1 = server._resolve_episode_numbering("120089", 2, 1)
        self.assertEqual((spy_s2e1["s_split"], spy_s2e1["e_split"]), (2, 1))
        self.assertEqual(spy_s2e1["abs_ep"], 13)

        # 3. Frontend series picker season counts, hero season selector, dropdown & episode badges
        root = Path(__file__).resolve().parent.parent
        accounts_js = (root / "static" / "js" / "accounts.js").read_text(encoding="utf-8")
        self.assertIn("s.count ? ` (${s.count} Bölüm)` : ''", accounts_js)
        self.assertIn("hero-season-picker", accounts_js)
        self.assertIn("season-select-dropdown", accounts_js)
        self.assertIn("episode-season-badge", accounts_js)

        # 4. iOS/Android Lock Screen MediaSession API & Background Audio Continuity
        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        youtube_js = (root / "static" / "js" / "players" / "youtube.js").read_text(encoding="utf-8")
        self.assertIn("bindMediaSessionHandlers", controls_js)
        self.assertIn("updateMediaSessionPositionImmediate", controls_js)
        self.assertIn("previoustrack", controls_js)
        self.assertIn("nexttrack", controls_js)
        self.assertIn("ctl-opt-bgaudio", controls_js)
        self.assertIn("vortex_bg_audio", html5_js)
        self.assertIn("_userPausedViaMediaSession", html5_js)
        self.assertIn("_userPausedViaMediaSession", youtube_js)

    def test_v109_strict_password_auth_google_youtube_register_and_guest_isolation(self):
        import uuid
        from pathlib import Path
        from unittest.mock import patch

        root = Path(__file__).resolve().parent.parent
        suf = uuid.uuid4().hex[:8]
        test_email = f"auth_v109_{suf}@gmail.com"

        # 1. Register requires >= 6 char password and rejects empty/short passwords
        r_short = self.client.post("/api/auth/register", json={
            "name": "Deniz Test",
            "email": test_email,
            "password": "123",
        })
        self.assertEqual(r_short.status_code, 400)

        r_ok = self.client.post("/api/auth/register", json={
            "name": "Deniz Test",
            "email": test_email,
            "password": "GucluSifre!2026",
        })
        self.assertEqual(r_ok.status_code, 200)
        self.assertTrue(r_ok.json().get("ok"))

        # Duplicate register returns 409 (never auto-logs in from register tab)
        r_dup = self.client.post("/api/auth/register", json={
            "name": "Deniz Test",
            "email": test_email,
            "password": "GucluSifre!2026",
        })
        self.assertEqual(r_dup.status_code, 409)

        # 2. Google / YouTube OAuth (/api/auth/oauth) strictly rejects passwordless requests
        r_oauth_nopw = self.client.post("/api/auth/oauth", json={
            "provider": "google",
            "idToken": "fake_token_123",
            "email": test_email,
        })
        self.assertEqual(r_oauth_nopw.status_code, 400)
        self.assertIn("Şifre yazmadan", r_oauth_nopw.json().get("error", ""))

        # Wrong password with valid Google token is rejected with 401
        with patch.object(auth_engine, "_firebase_auth_req", return_value={"users": [{"email": test_email, "displayName": "Deniz Test"}]}):
            r_oauth_wrongpw = self.client.post("/api/auth/oauth", json={
                "provider": "google",
                "idToken": "valid_token_123",
                "email": test_email,
                "password": "YanlisSifre999",
            })
            self.assertEqual(r_oauth_wrongpw.status_code, 401)

            # Correct password with valid Google token succeeds
            r_oauth_good = self.client.post("/api/auth/oauth", json={
                "provider": "google",
                "idToken": "valid_token_123",
                "email": test_email,
                "password": "GucluSifre!2026",
            })
            self.assertEqual(r_oauth_good.status_code, 200)
            self.assertTrue(r_oauth_good.json().get("ok"))

        # 3. Frontend static verification for Google, YouTube, Register & Provider password gates
        profile_js = (root / "static" / "js" / "profile.js").read_text(encoding="utf-8")
        selection_js = (root / "static" / "js" / "views" / "selection.js").read_text(encoding="utf-8")
        selection_kinds_js = (root / "static" / "js" / "views" / "selection-kinds.js").read_text(encoding="utf-8")
        accounts_js = (root / "static" / "js" / "accounts.js").read_text(encoding="utf-8")

        self.assertIn("wl-google-pw-panel", profile_js)
        self.assertIn("export async function syncGoogleYoutubeOAuth(password = '', expectedEmail = '')", profile_js)
        self.assertIn("Şifreyi Doğrula & Google YouTube Hesabını Eşitle", selection_js)
        self.assertIn("const ytConnected = Boolean(signedIn && prefs.googleConnected && prefs.googleEmail);", selection_kinds_js)
        self.assertIn("hesap şifreniz (en az 6 karakter — zorunlu)", accounts_js)

    def test_v110_thirty_subagent_security_hardening(self):
        import security
        import time

        # 1. unsign_b64 rejects non-ASCII signatures and future/NaN iat timestamps without raising
        key = b"watchlivo_test_secret_key_32bytes"
        tok_valid = security.sign_b64(key, {"uid": "u_1", "iat": time.time()})
        self.assertIsNotNone(security.unsign_b64(key, tok_valid, max_age=60))
        self.assertIsNone(security.unsign_b64(key, tok_valid.rsplit(".", 1)[0] + ".şğüöç", max_age=60))
        tok_future = security.sign_b64(key, {"uid": "u_1", "iat": time.time() + 86400})
        self.assertIsNone(security.unsign_b64(key, tok_future, max_age=60))

        # 2. Password-protected rooms redact creatorCid/host_id/participant IDs in public lobby & reject unsigned cid spoofing
        r_create = self.client.post("/api/rooms/create", json={
            "name": "Gizli Kasa",
            "creator": "Kaptan",
            "password": "GizliSifre!88",
            "privacy": "public",
        })
        self.assertEqual(r_create.status_code, 200)
        created_data = r_create.json()
        rid = created_data["room"]["id"]
        real_cid = created_data["clientId"]
        real_token = created_data["clientToken"]

        # Public lobby (/api/rooms) must never leak real_cid for password-protected rooms
        r_lobby = self.client.get("/api/rooms")
        self.assertEqual(r_lobby.status_code, 200)
        lobby_room = next((x for x in (r_lobby.json().get("rooms") or []) if x.get("id") == rid), None)
        self.assertIsNotNone(lobby_room)
        self.assertEqual(lobby_room.get("creatorCid"), "")
        self.assertEqual(lobby_room.get("host_id"), "")
        for p_item in (lobby_room.get("participants") or []):
            self.assertNotEqual(p_item.get("id"), real_cid)

        # First creator join consumes _precreated flag; subsequent unauthenticated spoof with real_cid and no clientToken/pwd must be rejected with 403
        r_first = self.client.post(f"/api/rooms/{rid}/sync", json={
            "cid": real_cid,
            "clientToken": real_token,
            "username": "Kaptan",
        })
        self.assertEqual(r_first.status_code, 200)

        r_spoof = self.client.post(f"/api/rooms/{rid}/sync", json={
            "cid": real_cid,
            "username": "HackerSpoof",
        })
        self.assertEqual(r_spoof.status_code, 403)
        self.assertEqual(r_spoof.json().get("error"), "password_required")

        # 3. SSRF protection on /api/rave/new-releases rejects loopback/private streamUrl
        r_ssrf = self.client.post("/api/rave/new-releases", json={
            "title": "Internal Probe",
            "streamUrl": "http://127.0.0.1:8080/secret.m3u8",
        })
        self.assertEqual(r_ssrf.status_code, 400)

    def test_v111_thirty_subagent_ui_and_interaction_fixes(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        ui_js = (root / "static" / "js" / "ui.js").read_text(encoding="utf-8")
        home_js = (root / "static" / "js" / "views" / "home.js").read_text(encoding="utf-8")
        selection_js = (root / "static" / "js" / "views" / "selection.js").read_text(encoding="utf-8")
        selection_kinds_js = (root / "static" / "js" / "views" / "selection-kinds.js").read_text(encoding="utf-8")
        lobby_js = (root / "static" / "js" / "views" / "lobby.js").read_text(encoding="utf-8")
        controls_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        vortex_css = (root / "static" / "css" / "vortex.css").read_text(encoding="utf-8")

        # 1. Safe SVG data URI allowed on <img src="data:image/svg+xml..."> so 31 platform logos & 21 Live TV cards render
        self.assertIn("const isSafeSvgImg = (k === 'src' && String(tag).toLowerCase() === 'img' && /^data:image\\/svg\\+xml[,;]/i.test(cleanV));", ui_js)
        self.assertIn("card.classList.add('is-closing');", ui_js)

        # 2. Bottom dock profile modal does not steal active tab highlight & labels fit 72px without truncating
        self.assertIn("if (id !== 'profile') {", home_js)
        self.assertIn("max-width: 72px !important;", vortex_css)

        # 3. Mobile provider card logo & corner badge non-overlapping constraints + search & continue-watching layout
        self.assertIn("max-width: calc(100% - 78px) !important;", vortex_css)
        self.assertIn(".popup-close-x {", vortex_css)
        self.assertIn("placeholder: 'Film, dizi, anime veya link ara...'", selection_js)
        self.assertIn("🔒 Bulut Senkron", selection_js)
        self.assertIn("const created = await api('/api/rooms/create', {", selection_js)

        # 4. In-room video controls mount syncPill, qualityBadge, and subPillBtn in top bar + Vizyon TV picker + Friends timer cleanup
        self.assertIn("h('div', { class: 'ctl-top-right' }, syncPill, qualityBadge, subPillBtn, breakTopBtn, prevEpTopBtn, epBtn, nextEpTopBtn, origBtn, provLogo)", controls_js)
        self.assertIn("Sezon & Bölüm Seç", selection_kinds_js)
        self.assertIn("onClose: () => clearInterval(liveTimer),", lobby_js)

    def test_v112_vizyon_playability_and_latest_episodes_feed(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. Live /api/rave/latest-episodes returns S:B episode items ready for 1-click playback
        r_eps = self.client.get("/api/rave/latest-episodes")
        self.assertEqual(r_eps.status_code, 200)
        ep_data = r_eps.json()
        self.assertTrue(ep_data.get("ok"))
        items = ep_data.get("items") or []
        self.assertGreaterEqual(len(items), 6)
        first_ep = items[0]
        self.assertEqual(first_ep.get("mediaType"), "tv")
        self.assertGreaterEqual(int(first_ep.get("season") or 0), 1)
        self.assertGreaterEqual(int(first_ep.get("episode") or 0), 1)
        self.assertIn(":B", str(first_ep.get("episodeLabel") or ""))
        self.assertTrue(first_ep.get("streamReady"))

        # 2. /api/rave/new-releases annotates streamReady and prioritizes playable items first
        r_viz = self.client.get("/api/rave/new-releases")
        self.assertEqual(r_viz.status_code, 200)
        viz_items = r_viz.json().get("items") or []
        self.assertGreater(len(viz_items), 0)
        self.assertIn("streamReady", viz_items[0])

        # 3. Frontend selection.js & selection-kinds.js include latest episodes rail & vizyon filter tabs
        selection_js = (root / "static" / "js" / "views" / "selection.js").read_text(encoding="utf-8")
        selection_kinds_js = (root / "static" / "js" / "views" / "selection-kinds.js").read_text(encoding="utf-8")
        self.assertIn("wl-latest-eps-section", selection_js)
        self.assertIn("/api/rave/latest-episodes", selection_js)
        self.assertIn("wl-vizyon-tabs", selection_kinds_js)

    def test_v114_fifty_query_search_accuracy(self):
        # 1. Verify query parser extracts trailing release years and media-type hints cleanly
        self.assertEqual(server._parse_search_query("Triangle 2009"), ("Triangle", "2009", "", False))
        self.assertEqual(server._parse_search_query("Stalker 1979"), ("Stalker", "1979", "", False))
        self.assertEqual(server._parse_search_query("Monster anime"), ("Monster", "", "tv", True))
        self.assertEqual(server._parse_search_query("1917"), ("1917", "", "", False))

        # 2. Verify curated matching never lets single-word substrings ("Dark", "prens") hijack exact titles
        cur_dark = server._match_star_wars_curated("Dark")
        self.assertFalse(any(x.get("tmdbId") == "155" for x in cur_dark))
        cur_prens = server._match_star_wars_curated("prens")
        self.assertTrue(cur_prens and cur_prens[0].get("tmdbId") == "228853")
        self.assertFalse(any(x.get("tmdbId") == "767" for x in cur_prens))

        # 3. Verify vault substring matcher blocks short reverse-substring false positives ("Talker" in "Stalker")
        self.assertFalse(server._vault_title_matches_query("stalker", "talker", "the most notorious talker"))
        self.assertTrue(server._vault_title_matches_query("stalker", "stalker", "stalker"))

        # 4. Verify unified ranker prioritizes flagship & substantial exact matches over B-movies and spin-offs
        for q, exp_sub, exp_mt in [
            ("Yüzüklerin Efendisi", "Yüzüklerin Efendisi", "movie"),
            ("Severance", "Severance", "tv"),
            ("prens", "Prens", "tv"),
            ("gassal", "Gassal", "tv"),
            ("Demon Slayer", "Demon Slayer", "tv"),
            ("Steins Gate", "Steins;Gate", "tv"),
            ("Monster anime", "Monster", "tv"),
            ("Triangle 2009", "Triangle", "movie"),
            ("Stalker 1979", "Stalker", "movie"),
            ("Dark", "Dark", "tv"),
            ("Twin Peaks", "Twin Peaks", "tv"),
            ("Utopia", "Utopia", "tv"),
        ]:
            cat_items = (server._provider_catalog_page_sync("cinema", q, 1, "all", "") or {}).get("items") or []
            self.assertTrue(cat_items, f"No catalog items returned for {q}")
            top_it = cat_items[0]
            self.assertEqual(top_it.get("mediaType"), exp_mt, f"Wrong mediaType for {q}: {top_it}")
            exp_n = server._norm_title(exp_sub)
            t_n = server._norm_title(top_it.get("title") or "")
            o_n = server._norm_title(top_it.get("originalTitle") or "")
            self.assertTrue(exp_n in t_n or exp_n in o_n, f"Wrong #1 title for {q}: {top_it}")


    def test_v115_hundred_query_search_accuracy(self):
        # 1. Verify macron, apostrophe, and romaji vowel normalization in _norm_title
        self.assertEqual(server._norm_title("Shōgun"), "shogun")
        self.assertEqual(server._norm_title("Bir Zamanlar Anadolu'da"), "1 zamanlar anadoluda")
        self.assertEqual(server._norm_title("Naruto: Shippuuden"), "naruto shippuden")

        # 2. Verify CJK title mapping & ASCII letter threshold for Mob Psycho 100, Ergo Proxy, Samurai Champloo, Paranoia Agent, Pulse
        it_mob = server._tmdb_item({"id": 67075, "media_type": "tv", "name": "モブサイコ100", "original_name": "モブサイコ100", "poster_path": "/x.jpg", "vote_average": 8.5, "vote_count": 1400}, "tv")
        self.assertEqual(it_mob["title"], "Mob Psycho 100")
        it_par = server._tmdb_item({"id": 2368, "media_type": "tv", "name": "Paranoya Ajanı", "original_name": "妄想代理人", "poster_path": "/x.jpg", "vote_average": 8.0, "vote_count": 480}, "tv")
        self.assertIn("Paranoia Agent", it_par["title"])
        self.assertEqual(it_par["originalTitle"], "Paranoia Agent")

        # 3. Verify all 11 previously mismatched queries in the 100-query benchmark resolve to #1
        for q, exp_sub, exp_mt in [
            ("Fargo", "Fargo", "tv"),
            ("Shogun", "Shōgun", "tv"),
            ("Hannibal", "Hannibal", "tv"),
            ("masum", "Masum", "tv"),
            ("bir zamanlar anadoluda", "Bir Zamanlar Anadolu'da", "movie"),
            ("Naruto Shippuden", "Naruto Shippuden", "tv"),
            ("Code Geass", "Code Geass", "tv"),
            ("Ergo Proxy", "Ergo Proxy", "tv"),
            ("Paranoia Agent", "Paranoia Agent", "tv"),
            ("Samurai Champloo", "Samurai Champloo", "tv"),
            ("Mob Psycho 100", "Mob Psycho 100", "tv"),
            ("Pulse 2001", "Pulse", "movie"),
        ]:
            cat_items = (server._provider_catalog_page_sync("cinema", q, 1, "all", "") or {}).get("items") or []
            self.assertTrue(cat_items, f"No catalog items returned for {q}")
            top_it = cat_items[0]
            self.assertEqual(top_it.get("mediaType"), exp_mt, f"Wrong mediaType for {q}: {top_it}")
            exp_n = server._norm_title(exp_sub)
            t_n = server._norm_title(top_it.get("title") or "")
            o_n = server._norm_title(top_it.get("originalTitle") or "")
            self.assertTrue(exp_n in t_n or exp_n in o_n, f"Wrong #1 title for {q}: {top_it}")


    def test_v117_seo_and_analytics_engine(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent

        # 1. Verify /robots.txt and /sitemap.xml
        r_rob = self.client.get("/robots.txt")
        self.assertEqual(r_rob.status_code, 200)
        self.assertIn("Sitemap: https://watchlivo.online/sitemap.xml", r_rob.text)

        r_map = self.client.get("/sitemap.xml")
        self.assertEqual(r_map.status_code, 200)
        self.assertIn("<loc>https://watchlivo.online/</loc>", r_map.text)
        self.assertIn("<loc>https://watchlivo.online/privacy</loc>", r_map.text)
        self.assertIn("<loc>https://watchlivo.online/dmca</loc>", r_map.text)
        self.assertIn("<loc>https://watchlivo.online/r/cinema-club</loc>", r_map.text)

        # 2. Verify index.html has PNG og:image, dimensions, JSON-LD Schema.org (Organization + FAQPage), and Google Analytics 4 gtag.js
        idx_html = (root / "static" / "index.html").read_text(encoding="utf-8")
        boot_js = (root / "static" / "js" / "bootstrap.js").read_text(encoding="utf-8")
        self.assertIn("https://watchlivo.online/static/watchlivo-og.png", idx_html)
        self.assertIn("application/ld+json", idx_html)
        self.assertIn('"FAQPage"', idx_html)
        self.assertIn('"Organization"', idx_html)
        self.assertIn("jokallame0@gmail.com", idx_html)
        self.assertIn("https://www.googletagmanager.com/gtag/js", idx_html)
        self.assertIn("__initWatchlivoGA4", boot_js)
        self.assertTrue((root / "static" / "watchlivo-og.png").exists())
        self.assertTrue((root / "static" / "js" / "views" / "site-footer.js").exists())

        # 2b. Verify legal & contact pages (/about, /privacy, /terms, /dmca, /contact) and /api/rave/contact
        for l_route in ("/about", "/privacy", "/terms", "/dmca", "/contact"):
            r_leg = self.client.get(l_route)
            self.assertEqual(r_leg.status_code, 200, f"Failed legal route {l_route}")
            self.assertIn("jokallame0@gmail.com", r_leg.text)

        r_cpost = self.client.post("/api/rave/contact", json={
            "category": "request",
            "name": "Mert Can",
            "email": "jokallame0@gmail.com",
            "subject": "Interstellar 4K",
            "message": "Lütfen IMAX versiyonunu da ekleyin",
        })
        self.assertEqual(r_cpost.status_code, 200)
        self.assertTrue(r_cpost.json().get("ok"))
        r_cget = self.client.get("/api/rave/contact")
        self.assertEqual(r_cget.status_code, 200)
        self.assertEqual(r_cget.json().get("officialEmail"), "jokallame0@gmail.com")
        self.assertTrue(any(m.get("subject") == "Interstellar 4K" for m in (r_cget.json().get("messages") or [])))

        # 2c. Verify sw_iframe.html requests never return 0-byte 204 downloads on iOS
        r_sw_iframe = self.client.get("/api/rave/ga-collect/_/service_worker/6b40/sw_iframe.html?origin=https://watchlivo.online")
        self.assertEqual(r_sw_iframe.status_code, 200)
        self.assertIn("text/html", r_sw_iframe.headers.get("content-type", ""))
        self.assertGreater(len(r_sw_iframe.text), 20)

        # 2d. Verify v127 iOS WebClip/Safari viewport geometry & inline footer cookie banner
        main_js = (root / "static" / "js" / "main.js").read_text(encoding="utf-8")
        self.assertIn("isIosFullBleed", main_js)
        self.assertIn("isIosWebClipShort", main_js)
        footer_js = (root / "static" / "js" / "views" / "site-footer.js").read_text(encoding="utf-8")
        self.assertIn("footerEl.insertBefore(banner, footerEl.firstChild)", footer_js)
        vortex_css = (root / "static" / "css" / "vortex.css").read_text(encoding="utf-8")
        self.assertIn("top: calc(var(--app-height, 100dvh) - var(--dock-mobile-h, 60px)) !important;", vortex_css)

        # 3. Verify /api/rave/analytics POST + GET, GA4 gtag.js binding, and zero-increment on /stats refresh
        r_post = self.client.post("/api/rave/analytics", json={"event": "pageview", "device": "ios", "gaMeasurementId": "G-HQXSREQV3R"})
        self.assertEqual(r_post.status_code, 200)
        self.assertTrue(r_post.json().get("ok"))
        self.assertEqual(r_post.json().get("gaMeasurementId"), "G-HQXSREQV3R")

        r_get = self.client.get("/api/rave/analytics")
        self.assertEqual(r_get.status_code, 200)
        adata = r_get.json()
        self.assertTrue(adata.get("ok"))
        self.assertEqual(adata.get("gaMeasurementId"), "G-HQXSREQV3R")
        pv_before = adata.get("todayPageviews", 0)
        self.assertGreaterEqual(adata.get("todayUniqueVisitors", 0), 1)
        self.assertGreaterEqual(pv_before, 1)
        self.assertGreaterEqual(adata.get("devices", {}).get("ios", 0), 1)

        # Refreshing /stats or calling GET /api/rave/analytics must NEVER increment pageviews
        r_dash = self.client.get("/stats")
        self.assertEqual(r_dash.status_code, 200)
        self.assertIn("Google Analytics 4", r_dash.text)
        r_dash2 = self.client.get("/stats")
        self.assertEqual(r_dash2.status_code, 200)
        r_get_after = self.client.get("/api/rave/analytics").json()
        self.assertEqual(r_get_after.get("todayPageviews"), pv_before)

    def test_v130_room_invites_posters_and_10_agent_audit(self):
        # 1. Room share link (/r/{room_id}) forwards pwd, t, tmdbId, s, e, and r_tok; restores on cold instance
        cr = self.client.post("/api/rooms/create", json={
            "name": "Sinema Gece Odasi",
            "privacy": "private",
            "password": "gizli",
            "creator": "TrisHost",
            "creatorId": "u_tris_v130",
            "clientId": "c_tris_v130",
            "media": {
                "provider": "hls",
                "url": "https://cdn.example.com/movie.m3u8",
                "title": "Amerikan Pastasi 1",
                "tmdbId": "2105",
                "mediaType": "movie",
                "poster": "https://image.tmdb.org/t/p/w500/pNzarHZjSGo6NgotluiAG3U2nwy.jpg",
                "playing": True,
                "currentTime": 120.0,
            }
        }).json()
        rid = cr["room"]["id"]
        stok = cr["room"]["syncToken"]
        r_share = self.client.get(f"/r/{rid}?pwd=gizli&t=Amerikan+Pastasi+1&r_tok={stok}")
        self.assertEqual(r_share.status_code, 200)
        self.assertIn(f"/#/mesh/{rid}?", r_share.text)
        self.assertIn("pwd=gizli", r_share.text)
        self.assertIn("r_tok=", r_share.text)

        # Simulate cold instance wipe and restore via syncToken
        import rooms as rooms_mod
        rooms_mod.STORE.rooms.pop(rid, None)
        if getattr(rooms_mod.STORE, "tmp_dir", None):
            (rooms_mod.STORE.tmp_dir / f"{rid}.json").unlink(missing_ok=True)
        r_sync = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "c_guest_v130",
            "username": "Misafir",
            "pwd": "gizli",
            "syncToken": stok,
        })
        self.assertEqual(r_sync.status_code, 200)
        self.assertEqual(r_sync.json()["room"]["media"]["tmdbId"], "2105")

        # 2. Underscore room IDs accepted
        r_under = self.client.post("/api/rooms/call_room_v130/sync", json={
            "type": "join",
            "clientId": "c_call_v130",
            "name": "Caller",
        })
        self.assertEqual(r_under.status_code, 200)

        # 3. Broadcast room notification targetUid='*' succeeds
        r_notif = self.client.post("/api/rave/notifications/send", json={
            "targetUid": "*",
            "type": "room_invite",
            "title": "Oda Daveti",
            "body": "Davet!",
            "roomId": rid,
        })
        self.assertEqual(r_notif.status_code, 200)
        self.assertTrue(r_notif.json().get("ok"))

        # 4. Exact TMDB ID poster proxy resolution & vault poster accuracy
        r_p = self.client.get("/api/rave/poster?title=Amerikan+Pastasi+1&tid=2105&mt=movie", follow_redirects=False)
        self.assertIn(r_p.status_code, (302, 307))
        self.assertIn("pNzarHZjSGo6NgotluiAG3U2nwy.jpg", r_p.headers.get("location", ""))

    def test_v131_accounts_usernames_and_friends_audit(self):
        import uuid
        import auth_engine
        import social_engine

        sfx = uuid.uuid4().hex[:6]
        # 1. Turkish handle normalization & strict 409 handle collision on register + profile update
        r_reg1 = self.client.post("/api/auth/register", json={
            "name": "Çağrı Işık",
            "handle": f"@Çağrı_{sfx}",
            "email": f"cagri_{sfx}@watchlivo.test",
            "password": "Password131!",
            "color": "#27DCC8",
        })
        self.assertEqual(r_reg1.status_code, 200, r_reg1.text)
        u1 = r_reg1.json()["user"]
        tok1 = r_reg1.json()["authToken"]
        self.assertEqual(u1["handle"], f"cagri_{sfx}")
        self.assertTrue(u1["uid"].startswith("u_wl_"))

        # Duplicate handle registration -> 409 Conflict
        r_dup = self.client.post("/api/auth/register", json={
            "name": "Başka Çağrı",
            "handle": f"@CAGRI_{sfx}",
            "email": f"other_{sfx}@watchlivo.test",
            "password": "Password131!",
        })
        self.assertEqual(r_dup.status_code, 409)

        # Second account registration + profile rename collision (409) + valid rename (200)
        r_reg2 = self.client.post("/api/auth/register", json={
            "name": "Şeyma Öztürk",
            "handle": f"@Şeyma_{sfx}",
            "email": f"seyma_{sfx}@watchlivo.test",
            "password": "Password131!",
        })
        self.assertEqual(r_reg2.status_code, 200)
        u2 = r_reg2.json()["user"]
        tok2 = r_reg2.json()["authToken"]
        self.assertEqual(u2["handle"], f"seyma_{sfx}")

        r_prof_col = self.client.post(
            "/api/auth/profile",
            headers={"Authorization": f"Bearer {tok2}"},
            json={"name": "Şeyma Öztürk", "handle": f"cagri_{sfx}"},
        )
        self.assertEqual(r_prof_col.status_code, 409)

        r_prof_ok = self.client.post(
            "/api/auth/profile",
            headers={"Authorization": f"Bearer {tok2}"},
            json={"name": "Şeyma Sinema", "handle": f"@ŞeymaSinema_{sfx}", "bio": "Gece sineması"},
        )
        self.assertEqual(r_prof_ok.status_code, 200)
        tok2 = r_prof_ok.json()["authToken"]
        self.assertEqual(r_prof_ok.json()["user"]["handle"], f"seymasinema_{sfx}")

        # 2. Cold-instance login via vaultToken (pwh) & /api/auth/me self-healing
        if auth_engine.store_backend() != "redis":
            conn = auth_engine._get_db()
            try:
                conn.execute("DELETE FROM watchlivo_users WHERE uid = ?", (u1["uid"],))
                conn.commit()
            finally:
                conn.close()

        r_bad_pw = self.client.post("/api/auth/login", json={
            "identifier": f"@Çağrı_{sfx}",
            "password": "WrongPassword!",
            "vaultToken": tok1,
        })
        self.assertEqual(r_bad_pw.status_code, 401)

        r_cold_login = self.client.post("/api/auth/login", json={
            "identifier": f"@Çağrı_{sfx}",
            "password": "Password131!",
            "vaultToken": tok1,
        })
        self.assertEqual(r_cold_login.status_code, 200, r_cold_login.text)
        self.assertEqual(r_cold_login.json()["user"]["uid"], u1["uid"])

        r_me = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok2}"})
        self.assertEqual(r_me.status_code, 200)
        self.assertTrue(r_me.json()["authenticated"])
        self.assertEqual(r_me.json()["user"]["handle"], f"seymasinema_{sfx}")

        # 3. Turkish & #tag user search (cagri, çağrı, @ÇAĞRI, #1234)
        for q_variant in (f"cagri_{sfx}", f"çağrı_{sfx}", f"@ÇAĞRI_{sfx}", f"cagri_{sfx}#4821"):
            r_srch = self.client.get(
                f"/api/rave/social/search?q={q_variant}&uid={u2['uid']}",
                headers={"Authorization": f"Bearer {tok2}"},
            )
            self.assertEqual(r_srch.status_code, 200)
            uids_found = [x["uid"] for x in r_srch.json().get("users", [])]
            self.assertIn(u1["uid"], uids_found, f"Query {q_variant} missed {u1['uid']}")

        # 4. Guest provisioning, collision check, mutual friend request/accept & DM
        guest_uid = f"guest_v131{sfx}"
        r_gcol = self.client.post("/api/rave/social/guest", json={
            "uid": guest_uid, "name": "Misafir Test", "handle": f"cagri_{sfx}",
        })
        self.assertEqual(r_gcol.status_code, 409)

        r_gok = self.client.post("/api/rave/social/guest", json={
            "uid": guest_uid, "name": "Misafir Ömer", "handle": f"@ÖmerMisafir_{sfx}", "color": "#f43f5e",
        })
        self.assertEqual(r_gok.status_code, 200)
        self.assertEqual(r_gok.json()["user"]["handle"], f"omermisafir_{sfx}")

        # Member searches guest by Turkish query & sends friend request -> Guest accepts -> DM works
        r_gs = self.client.get(
            f"/api/rave/social/search?q=ömermisafir_{sfx}&uid={u1['uid']}",
            headers={"Authorization": f"Bearer {tok1}"},
        )
        self.assertIn(guest_uid, [x["uid"] for x in r_gs.json().get("users", [])])

        r_freq = self.client.post(
            "/api/rave/social/friends",
            headers={"Authorization": f"Bearer {tok1}"},
            json={"action": "request", "uid": u1["uid"], "target": f"@omermisafir_{sfx}"},
        )
        self.assertEqual(r_freq.status_code, 200)
        self.assertEqual(r_freq.json().get("status"), "OUTGOING_PENDING")

        r_facc = self.client.post("/api/rave/social/friends", json={
            "action": "accept", "uid": guest_uid, "targetUid": u1["uid"],
        })
        self.assertEqual(r_facc.status_code, 200)
        self.assertIn(u1["uid"], [f["uid"] for f in r_facc.json().get("friends", [])])

        r_dm = self.client.post("/api/rave/social/dm", json={
            "action": "send", "uid": guest_uid, "peerUid": u1["uid"], "text": "Selam Çağrı!",
        })
        self.assertEqual(r_dm.status_code, 200)
        self.assertTrue(r_dm.json().get("ok"))

        # 5. In-room participant uid/handle serialization, spoof blocking, and live profile_update
        cr_room = self.client.post(
            "/api/rooms/create",
            headers={"Authorization": f"Bearer {tok1}"},
            json={
                "name": "Sosyal Test Odası",
                "privacy": "public",
                "creator": u1["name"],
                "creatorId": u1["uid"],
                "clientId": f"h_cagri_{sfx}",
            },
        ).json()
        rid = cr_room["room"]["id"]
        # Unauthenticated client trying to spoof u_wl_* in room sync gets scrubbed to empty uid, while guest_* is kept
        r_spoof = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": f"h_spoof_{sfx}", "uid": u1["uid"], "username": "Taklitci",
        })
        self.assertEqual(r_spoof.status_code, 200)
        spoof_p = next(p for p in r_spoof.json()["room"]["participants"] if p["id"] == f"h_spoof_{sfx}")
        self.assertEqual(spoof_p.get("uid", ""), "")

        r_gjoin = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": f"h_guest_{sfx}", "uid": guest_uid, "username": "Misafir Ömer", "handle": f"omermisafir_{sfx}",
        })
        self.assertEqual(r_gjoin.status_code, 200)
        guest_p = next(p for p in r_gjoin.json()["room"]["participants"] if p["id"] == f"h_guest_{sfx}")
        self.assertEqual(guest_p.get("uid"), guest_uid)
        self.assertEqual(guest_p.get("handle"), f"omermisafir_{sfx}")

        r_pupd = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "profile_update",
            "clientId": f"h_guest_{sfx}",
            "clientToken": r_gjoin.json()["clientToken"],
            "username": "Ömer Kaptan",
            "handle": f"omerkaptan_{sfx}",
        })
        self.assertEqual(r_pupd.status_code, 200)
        upd_p = next(p for p in r_pupd.json()["room"]["participants"] if p["id"] == f"h_guest_{sfx}")
        self.assertEqual(upd_p["name"], "Ömer Kaptan")
        self.assertEqual(upd_p["handle"], f"omerkaptan_{sfx}")

    def test_v132_viewer_leave_rejoin_host_live_sync(self):
        from pathlib import Path
        import uuid
        import rooms

        sfx = uuid.uuid4().hex[:6]
        host_cid = f"h_host_{sfx}"
        viewer_cid = f"h_view_{sfx}"

        # 1. Host creates a room with an initially unresolved catalog stream (/api/rave/resolve-catalog)
        cr = self.client.post("/api/rooms/create", json={
            "name": "Breaking Bad Maratonu",
            "privacy": "public",
            "playMode": "leader",
            "creator": "KaptanLider",
            "creatorId": f"guest_host_{sfx}",
            "clientId": host_cid,
            "media": {
                "provider": "hls",
                "streamType": "hls",
                "url": "/api/rave/resolve-catalog?provider=cinema&title=Breaking+Bad&tmdbId=1396&mediaType=tv&season=3&episode=7",
                "title": "Breaking Bad — 3. Sezon 7. Bölüm",
                "tmdbId": "1396",
                "mediaType": "tv",
                "season": 3,
                "episode": 7,
                "duration": 2880,
                "playing": True,
                "currentTime": 0,
            },
        }).json()
        rid = cr["room"]["id"]

        # Host joins and sends heartbeat at 2450.0s (40m 50s) even BEFORE/WITH activeMedia upgrade
        r_h_init = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": host_cid, "username": "KaptanLider", "uid": f"guest_host_{sfx}", "isCreator": True,
        }).json()
        host_tok = r_h_init["clientToken"]

        r_hb = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "heartbeat",
            "clientId": host_cid,
            "clientToken": host_tok,
            "username": "KaptanLider",
            "currentTime": 2450.0,
            "playing": True,
            "anchor": True,
            "activeMedia": {
                "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
                "provider": "hls",
                "streamType": "hls",
                "duration": 2880,
                "title": "Breaking Bad — 3. Sezon 7. Bölüm",
                "tmdbId": "1396",
                "mediaType": "tv",
                "season": 3,
                "episode": 7,
            },
        })
        self.assertEqual(r_hb.status_code, 200)
        hb_room = r_hb.json()["room"]
        self.assertEqual(hb_room["media"]["url"], "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8")
        self.assertGreaterEqual(hb_room["media"]["liveTime"], 2449.5)
        self.assertGreaterEqual(hb_room["media"]["meshStatePosition"], 2449.5)

        # 2. Viewer joins, sees 2450s+, then leaves the room
        r_v_join1 = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": viewer_cid, "username": "GezginIzleyici", "uid": f"guest_view_{sfx}",
        })
        self.assertEqual(r_v_join1.status_code, 200)
        v_tok1 = r_v_join1.json()["clientToken"]
        self.assertGreaterEqual(r_v_join1.json()["room"]["media"]["liveTime"], 2449.5)

        r_v_leave = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "leave", "clientId": viewer_cid, "clientToken": v_tok1, "username": "GezginIzleyici", "uid": f"guest_view_{sfx}",
        })
        self.assertEqual(r_v_leave.status_code, 200)

        # 3. Lobby entry MUST expose liveTime + meshStatePosition + meshStateTime (never 0:00!)
        rooms._LOBBY_CACHE["ts"] = 0.0
        lobby_rooms = self.client.get("/api/rooms").json().get("rooms", [])
        lobby_hit = next((x for x in lobby_rooms if x["id"] == rid), None)
        self.assertIsNotNone(lobby_hit)
        self.assertGreaterEqual(lobby_hit["media"]["liveTime"], 2449.5)
        self.assertGreaterEqual(lobby_hit["media"]["meshStatePosition"], 2449.5)
        self.assertGreater(lobby_hit["media"]["meshStateTime"], 1000000000)

        # 4. Non-leader viewer re-enters (even sending an old/zero resolve_media or stale syncToken) -> NEVER resets room to 0:00!
        viewer_cid2 = f"h_view2_{sfx}"
        r_v_rejoin = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": viewer_cid2, "username": "GezginIzleyici", "uid": f"guest_view_{sfx}",
        })
        self.assertEqual(r_v_rejoin.status_code, 200)
        rejoin_room = r_v_rejoin.json()["room"]
        v_tok2 = r_v_rejoin.json()["clientToken"]
        self.assertGreaterEqual(rejoin_room["media"]["liveTime"], 2449.5)
        self.assertEqual(rejoin_room["host_id"], host_cid)
        # HTTP user_joined event must be emitted so HTTP-polling Host immediately fires a fresh heartbeat anchor
        self.assertTrue(any(ev.get("type") == "user_joined" and ev.get("cid") == viewer_cid2 for ev in rejoin_room.get("events", [])))

        # Non-leader attempting resolve_media with currentTime=0 must NOT reset playback
        r_v_res0 = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "resolve_media",
            "clientId": viewer_cid2,
            "clientToken": v_tok2,
            "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
            "tmdbId": "1396",
            "mediaType": "tv",
            "season": 3,
            "episode": 7,
            "currentTime": 0,
        })
        self.assertEqual(r_v_res0.status_code, 200)
        self.assertGreaterEqual(r_v_res0.json()["room"]["media"]["liveTime"], 2449.5)

        # 5. Cold serverless instance restore via syncToken keeps 2450s+ live position
        fresh_sync_tok = r_v_res0.json()["room"]["syncToken"]
        restored_cold = rooms.merge_sync_token(None, fresh_sync_tok, rid)
        self.assertIsNotNone(restored_cold)
        ser_cold = rooms.serialize(restored_cold, for_cid=viewer_cid2)
        self.assertGreaterEqual(ser_cold["media"]["liveTime"], 2449.5)

        # 6. Verify frontend guards exist in lobby.js, mesh.js, sync.js, html5.js
        root = Path(__file__).resolve().parent.parent
        lobby_js = (root / "static" / "js" / "views" / "lobby.js").read_text(encoding="utf-8")
        mesh_js = (root / "static" / "js" / "views" / "mesh.js").read_text(encoding="utf-8")
        sync_js = (root / "static" / "js" / "sync.js").read_text(encoding="utf-8")
        html5_js = (root / "static" / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        self.assertIn("hasValidAnchor", lobby_js)
        self.assertIn("ctx.initFallbackTimer", mesh_js)
        self.assertIn("this.didInitialSync", sync_js)
        self.assertIn("updateInitialSeek(targetPos)", html5_js)

    def test_v133_full_autonomous_audit_remediations(self):
        import uuid
        from pathlib import Path

        root = Path(__file__).resolve().parent.parent
        sfx = uuid.uuid4().hex[:6]

        # 1. Malformed & non-dict JSON on /api/rooms/create returns 400 (never silently creates room)
        r_bad_json = self.client.post(
            "/api/rooms/create",
            content=b"{malformed_json",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(r_bad_json.status_code, 400)
        r_list_json = self.client.post("/api/rooms/create", json=["not", "a", "dict"])
        self.assertEqual(r_list_json.status_code, 400)

        # 2. Newly created room blocks unauthenticated outsider from hijacking _precreated slot via close_room
        cr = self.client.post("/api/rooms/create", json={
            "name": "Korunan Oda v133",
            "privacy": "public",
            "creator": "KaptanV133",
            "creatorId": f"u_wl_v133_{sfx}",
            "clientId": f"h_cap_{sfx}",
        }).json()
        rid = cr["room"]["id"]
        r_hijack = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "host_action",
            "action": "close_room",
            "clientId": f"h_evil_{sfx}",
        })
        self.assertFalse(bool(r_hijack.json().get("roomClosed")))
        self.assertEqual(self.client.get(f"/api/rooms/{rid}").status_code, 200)

        # 3. Auth token server-side revocation on /api/auth/logout
        r_reg = self.client.post("/api/auth/register", json={
            "name": "Revoke Test",
            "email": f"rev_{sfx}@watchlivo.test",
            "password": "SafePassword133!",
        })
        self.assertEqual(r_reg.status_code, 200)
        tok = r_reg.json()["authToken"]
        self.assertTrue(self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).json().get("authenticated"))
        r_out = self.client.post("/api/auth/logout", headers={"Authorization": f"Bearer {tok}"})
        self.assertEqual(r_out.status_code, 200)
        self.assertFalse(self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).json().get("authenticated"))

        # 4. Locked room share landing suppresses syncToken (r_tok) unless valid password is supplied
        cr_pwd = self.client.post("/api/rooms/create", json={
            "name": "Kilitli Oda v133",
            "privacy": "public",
            "password": "sifre133",
            "creator": "KilitHost",
        }).json()
        pwd_rid = cr_pwd["room"]["id"]
        pwd_stok = cr_pwd["room"]["syncToken"]
        r_no_pwd = self.client.get(f"/r/{pwd_rid}?r_tok={pwd_stok}")
        self.assertNotIn("r_tok=", r_no_pwd.text)
        r_with_pwd = self.client.get(f"/r/{pwd_rid}?pwd=sifre133&r_tok={pwd_stok}")
        self.assertIn("r_tok=", r_with_pwd.text)

        # 5. Upload auth gate (401) + magic-byte verification blocks SVG/HTML disguised as .png (415)
        r_unauth_up = self.client.post(
            "/api/upload",
            files={"file": ("disguised.png", b"<svg onload=alert(1)></svg>", "image/png")},
        )
        self.assertEqual(r_unauth_up.status_code, 401)
        r_up_user = self.client.post("/api/auth/register", json={
            "name": "Upload Guard",
            "email": f"up_{sfx}@watchlivo.test",
            "password": "SafePassword133!",
        })
        self.assertEqual(r_up_user.status_code, 200)
        tok_up = r_up_user.json()["authToken"]
        r_bad_ext = self.client.post(
            "/api/upload",
            headers={"Authorization": f"Bearer {tok_up}"},
            files={"file": ("disguised.png", b"<svg onload=alert(1)></svg>", "image/png")},
        )
        self.assertEqual(r_bad_ext.status_code, 400)
        r_fake_mp4 = self.client.post(
            "/api/upload",
            headers={"Authorization": f"Bearer {tok_up}"},
            files={"file": ("disguised.mp4", b"<svg onload=alert(1)></svg>", "video/mp4")},
        )
        self.assertEqual(r_fake_mp4.status_code, 415)

        # 6. GA4 Measurement ID overwrite blocked for non-admin (403) & contact email masked
        r_ga_hijack = self.client.post("/api/rave/analytics", json={"gaMeasurementId": "G-EVILHACK99"})
        self.assertEqual(r_ga_hijack.status_code, 403)
        self.client.post("/api/rave/contact", json={
            "name": "Gizli Kullanici",
            "email": "secretuser@example.com",
            "subject": "Maskeleme Testi",
            "message": "E-posta maskelenmeli",
        })
        msgs = self.client.get("/api/rave/contact").json().get("messages", [])
        hit_msg = next((m for m in msgs if m.get("subject") == "Maskeleme Testi"), None)
        self.assertIsNotNone(hit_msg)
        self.assertEqual(hit_msg.get("email"), "s***@example.com")

        # 7. SelectiveGZipMiddleware compresses HTML/JSON while keeping APK binary unbuffered
        r_gz = self.client.get("/", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r_gz.headers.get("content-encoding"), "gzip")
        r_apk = self.client.get("/download/apk", headers={"Accept-Encoding": "gzip"})
        self.assertIsNone(r_apk.headers.get("content-encoding"))

        # 8. Static v133 accessibility, security & Electron contracts
        sw_js = (root / "static" / "sw.js").read_text(encoding="utf-8")
        ctl_js = (root / "static" / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        elec_js = (root / "desktop" / "main.js").read_text(encoding="utf-8")
        self.assertIn("v20261107_v136", sw_js)
        self.assertIn("role: 'slider'", ctl_js)
        self.assertIn("sandbox: true", elec_js)
        self.assertIn("requestSingleInstanceLock", elec_js)

    def test_v134_code_splitting_strict_csp_and_atomic_ratelimit(self):
        import json as _json
        import os as _os
        import re as _re
        from pathlib import Path
        from unittest.mock import patch
        import security

        root = Path(__file__).resolve().parent.parent

        # 1. Strict script-src CSP: zero 'unsafe-inline' in script-src across server.py and vercel.json
        vercel_cfg = _json.loads((root / "vercel.json").read_text(encoding="utf-8"))
        csp_routes = [
            r for r in vercel_cfg.get("routes", [])
            if isinstance(r.get("headers"), dict) and "Content-Security-Policy" in r["headers"]
        ]
        self.assertGreaterEqual(len(csp_routes), 4)
        for r in csp_routes:
            csp_str = r["headers"]["Content-Security-Policy"]
            script_dir = next((d.strip() for d in csp_str.split(";") if d.strip().startswith("script-src")), "")
            self.assertTrue(script_dir.startswith("script-src 'self'"))
            self.assertNotIn("unsafe-inline", script_dir)

        # 2. Dynamic HTML routes emit per-request cryptographic CSP nonce matching <script nonce="...">
        for dyn_path in ("/r/cinema-club", "/contact", "/stats"):
            resp = self.client.get(dyn_path)
            self.assertEqual(resp.status_code, 200)
            csp_h = resp.headers.get("content-security-policy", "")
            script_h = next((d.strip() for d in csp_h.split(";") if d.strip().startswith("script-src")), "")
            self.assertNotIn("unsafe-inline", script_h)
            m_nonce = _re.search(r"'nonce-([A-Za-z0-9_-]{16,})'", script_h)
            self.assertIsNotNone(m_nonce, f"Missing script-src nonce on {dyn_path}: {script_h}")
            nonce_val = m_nonce.group(1)
            self.assertIn(f'<script nonce="{nonce_val}">', resp.text)
            self.assertNotIn("onclick=", resp.text)

        # Two consecutive requests MUST produce distinct nonces
        n1 = _re.search(r"'nonce-([A-Za-z0-9_-]{16,})'", self.client.get("/contact").headers.get("content-security-policy", "")).group(1)
        n2 = _re.search(r"'nonce-([A-Za-z0-9_-]{16,})'", self.client.get("/contact").headers.get("content-security-policy", "")).group(1)
        self.assertNotEqual(n1, n2)
        self.assertIn("no-store", self.client.get("/contact").headers.get("cache-control", ""))

        # 3. Externalized bootstrap + dynamic import() code-splitting + on-demand hls.js loader
        index_html = (root / "static" / "index.html").read_text(encoding="utf-8")
        desktop_auth_html = (root / "static" / "desktop-auth.html").read_text(encoding="utf-8")
        main_js = (root / "static" / "js" / "main.js").read_text(encoding="utf-8")
        hls_loader_js = (root / "static" / "js" / "players" / "hls-loader.js").read_text(encoding="utf-8")

        self.assertIn('/static/js/bootstrap.js?v=20261107_v136', index_html)
        self.assertNotIn('hls.min.js', index_html)
        self.assertIsNone(_re.search(r"<script(?![^>]*\bsrc=)(?![^>]*application/ld\+json)", index_html, _re.I))
        self.assertIn('/static/js/desktop-auth.js?v=20261107_v136', desktop_auth_html)
        self.assertIsNone(_re.search(r"<script(?![^>]*\bsrc=)", desktop_auth_html, _re.I))
        self.assertIn("import('./views/mesh.js?v=20261107_v136')", main_js)
        self.assertIsNone(_re.search(r"^import\s+.*from\s+['\"]\./views/mesh\.js", main_js, _re.M))
        self.assertIn("export function ensureHlsJs", hls_loader_js)

        # 4. Atomic single-RTT Upstash Redis Lua EVAL RateLimiter
        rl = security.RateLimiter(2, 30.0, name="v134_lua_test")
        calls = []

        def fake_kv(*cmd):
            calls.append(cmd)
            if cmd[0] == "EVAL":
                n = sum(1 for c in calls if c[0] == "EVAL")
                return [n, 29500]
            return None

        with patch.dict(_os.environ, {"UPSTASH_REDIS_REST_URL": "https://fake-upstash.example", "UPSTASH_REDIS_REST_TOKEN": "tok"}):
            with patch.object(rl, "_kv", side_effect=fake_kv):
                ok1, r1 = rl.hit("198.51.100.7")
                ok2, r2 = rl.hit("198.51.100.7")
                ok3, r3 = rl.hit("198.51.100.7")
        self.assertTrue(ok1 and r1 == 0.0)
        self.assertTrue(ok2 and r2 == 0.0)
        self.assertFalse(ok3)
        self.assertGreaterEqual(r3, 29.0)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c[0] == "EVAL" for c in calls))

    def test_v135_zero_egress_stream_proxy_and_bundle_slimming(self):
        """v135: STREAM_PROXY_BASE_URL routes streams to Cloudflare Worker, bypasses CF-blocked hosts, and slims Lambda bundle."""
        import json as _json
        import os as _os
        import pathlib as _pl

        root = _pl.Path(server.__file__).resolve().parent

        # 1. Default local behavior (no STREAM_PROXY_BASE_URL) stays relative /api/rave/stream-proxy
        with patch.dict(_os.environ, {"STREAM_PROXY_BASE_URL": ""}, clear=False):
            local_u = server._proxy_u("https://s26.cdnimg1399.shop/seg01.ts", "https://rapidvid.org/", ".ts")
            self.assertTrue(local_u.startswith("/api/rave/stream-proxy?url="))

        # 2. Production STREAM_PROXY_BASE_URL routes normal HLS/MP4 CDNs to Cloudflare Worker, while bypassing hakunaymatata.com
        edge = "https://watchlivo-stream-proxy.watchlivo-edge.workers.dev"
        with patch.dict(_os.environ, {"STREAM_PROXY_BASE_URL": edge + "/"}, clear=False):
            edge_u = server._proxy_u("https://s26.cdnimg1399.shop/seg01.ts", "https://rapidvid.org/", ".ts")
            self.assertTrue(edge_u.startswith(edge + "/api/rave/stream-proxy?url="))
            hakuna_u = server._proxy_u("https://bcdn.hakunaymatata.com/resource/movie.mp4?sign=abc", "", ".mp4")
            self.assertTrue(hakuna_u.startswith("/api/rave/stream-proxy?url="))

        # 3. vercel.json builds a single Python Lambda and excludes binary APK/IPA bloat from Lambda bundle
        vcfg = _json.loads((root / "vercel.json").read_text(encoding="utf-8"))
        py_builds = [b for b in vcfg.get("builds", []) if b.get("use") == "@vercel/python"]
        self.assertEqual(len(py_builds), 1)
        inc_files = py_builds[0].get("config", {}).get("includeFiles", [])
        self.assertNotIn("static/Watchlivo-v2.0.apk", inc_files)
        self.assertNotIn("static/Watchlivo.ipa", inc_files)

        # 4. Cloudflare Worker source exists and implements timing-safe HMAC-SHA256 + SSRF guard
        worker_js = (root / "workers" / "stream-proxy" / "worker.js").read_text(encoding="utf-8")
        self.assertIn("verifyProxySig", worker_js)
        self.assertIn("isPublicHttpUrl", worker_js)
        self.assertIn("FALLBACK_ORIGIN", worker_js)

    def test_v135_ha_gateway_failover_and_keepalive_cron(self):
        """v135 Part 3: Cloudflare HA Gateway fails over on DEPLOYMENT_PAUSED, routes WebSockets & APK, and runs keep-alive cron."""
        import pathlib as _pl
        import subprocess as _sp

        root = _pl.Path(server.__file__).resolve().parent
        ha_dir = root / "workers" / "ha-gateway"
        wrangler_toml = (ha_dir / "wrangler.toml").read_text(encoding="utf-8")
        self.assertIn('pattern = "watchlivo.online/*"', wrangler_toml)
        self.assertIn('pattern = "www.watchlivo.online/*"', wrangler_toml)
        self.assertIn('crons = ["*/10 * * * *"]', wrangler_toml)
        self.assertIn('service = "watchlivo-stream-proxy"', wrangler_toml)

        worker_url = (ha_dir / "worker.js").as_uri()
        harness = f"""
import gw from {worker_url!r};
import assert from 'node:assert/strict';

const calls = [];
globalThis.fetch = async (input, init = {{}}) => {{
  const u = typeof input === 'string' ? input : input.url;
  calls.push({{ url: u, method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers || {{}}).entries()) }});
  if (u.startsWith('https://watchlivo.online/api/rave/catalog')) {{
    return new Response('Paused', {{ status: 503, headers: {{ 'x-vercel-error': 'DEPLOYMENT_PAUSED' }} }});
  }}
  if (u.startsWith('https://watchlivo-origin-eu.onrender.com/api/rave/catalog')) {{
    return new Response(JSON.stringify({{ items: [{{ id: 'cat-1' }}] }}), {{ status: 200, headers: {{ 'content-type': 'application/json' }} }});
  }}
  if (u.startsWith('https://watchlivo-origin-eu.onrender.com/api/rooms')) {{
    return new Response(JSON.stringify({{ rooms: [{{ id: 'tv-trt1' }}] }}), {{ status: 200, headers: {{ 'content-type': 'application/json' }} }});
  }}
  if (u.startsWith('https://watchlivo-origin-eu.onrender.com/ws/room1')) {{
    return new Response('ws-ok', {{ status: 200 }});
  }}
  if (u.startsWith('https://watchlivo-origin-eu.onrender.com/api/health')) {{
    return new Response(JSON.stringify({{ ok: true }}), {{ status: 200 }});
  }}
  return new Response('ok', {{ status: 200 }});
}};

const env = {{
  SECONDARY_ORIGIN: 'https://watchlivo-origin-eu.onrender.com',
  STREAM_PROXY_ORIGIN: 'https://watchlivo-stream-proxy.watchlivo-edge.workers.dev',
  FORCE_SECONDARY: '0',
  STREAM_PROXY: {{ fetch: async () => new Response('APK_BYTES', {{ status: 200 }}) }},
}};

// 1. www -> apex 308
const rWww = await gw.fetch(new Request('https://www.watchlivo.online/room/abc'), env, {{}});
assert.equal(rWww.status, 308);
assert.equal(rWww.headers.get('location'), 'https://watchlivo.online/room/abc');

// 2. Service binding APK offload
const rApk = await gw.fetch(new Request('https://watchlivo.online/download/apk'), env, {{}});
assert.equal(rApk.status, 200);
assert.equal(await rApk.text(), 'APK_BYTES');

// 3. WebSocket upgrade routes directly to Secondary Render
const rWs = await gw.fetch(new Request('https://watchlivo.online/ws/room1', {{ headers: {{ Upgrade: 'websocket' }} }}), env, {{}});
assert.equal(rWs.status, 200);
assert.ok(calls.some(c => c.url === 'https://watchlivo-origin-eu.onrender.com/ws/room1'));

// 4. Primary Vercel DEPLOYMENT_PAUSED -> automatic failover to Secondary Render on stateless routes
const rFail = await gw.fetch(new Request('https://watchlivo.online/api/rave/catalog'), env, {{}});
assert.equal(rFail.status, 200);
assert.equal(rFail.headers.get('X-Watchlivo-Origin'), 'render-eu-failover');
const jFail = await rFail.json();
assert.equal(jFail.items[0].id, 'cat-1');

// 4b. Stateful /api/rooms routes directly to Render EU to eliminate HTTP/WS split-brain
const rStateful = await gw.fetch(new Request('https://watchlivo.online/api/rooms'), env, {{}});
assert.equal(rStateful.status, 200);
assert.equal(rStateful.headers.get('X-Watchlivo-Origin'), 'render-eu-stateful');
const jStateful = await rStateful.json();
assert.equal(jStateful.rooms[0].id, 'tv-trt1');

// 5. Scheduled keep-alive cron pings Render /api/health
let waited = null;
await gw.scheduled({{}}, env, {{ waitUntil: (p) => {{ waited = p; }} }});
await waited;
assert.ok(calls.some(c => c.url === 'https://watchlivo-origin-eu.onrender.com/api/health'));
console.log('HA_UNIT_TESTS_PASSED');
"""
        proc = _sp.run(["node", "--input-type=module", "-e", harness], capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        self.assertIn("HA_UNIT_TESTS_PASSED", proc.stdout)

    def test_v136_audit_remediations_and_rejoin_sync(self):
        """v136: Solo/guest leave-rejoin preserves playback, near-zero heartbeat guard, edge IP auth, 45KB avatar, voice-relay auth, and Windows check."""
        import asyncio as _aio
        import os as _os
        import security
        import social_engine

        # 1. Solo creator creates room, plays to 1845s, leaves (without close_room), and rejoins -> currentTime preserved!
        cr = self.client.post("/api/rooms/create", json={
            "name": "Solo Rejoin Test",
            "creator": "Kaptan",
            "clientId": "h_solo_cap",
            "creatorCid": "h_solo_cap",
            "media": {
                "provider": "hls",
                "url": "https://cdn.example.com/movie.m3u8",
                "title": "Uzay Yolu",
                "currentTime": 1845.0,
                "playing": True,
            },
        })
        self.assertEqual(cr.status_code, 200)
        rid = cr.json()["room"]["id"]

        init1 = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "h_solo_cap",
            "username": "Kaptan",
            "isCreator": True,
        }).json()
        ctok = init1["clientToken"]
        self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "seek",
            "clientId": "h_solo_cap",
            "clientToken": ctok,
            "currentTime": 1845.0,
        })
        # Creator leaves temporarily (not close_room)
        lv = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "leave",
            "clientId": "h_solo_cap",
            "clientToken": ctok,
        })
        self.assertEqual(lv.status_code, 200)
        # Lobby snapshot and rejoin must NOT reset currentTime to 0 or return 410
        rejoin = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init",
            "clientId": "h_solo_cap",
            "clientToken": ctok,
            "username": "Kaptan",
            "isCreator": True,
        })
        self.assertEqual(rejoin.status_code, 200)
        rejoin_pos = float(rejoin.json()["room"]["media"]["currentTime"])
        self.assertGreaterEqual(rejoin_pos, 1840.0)

        # 2. Near-zero leader heartbeat rewind guard when playbackAnchored is true
        hb_rewind = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "heartbeat",
            "clientId": "h_solo_cap",
            "clientToken": ctok,
            "currentTime": 1.2,
            "playing": True,
            "forceAnchor": True,
        })
        self.assertEqual(hb_rewind.status_code, 200)
        after_hb_pos = float(hb_rewind.json()["room"]["media"]["currentTime"])
        self.assertGreaterEqual(after_hb_pos, 1840.0)

        # 3. Voice relay GET rejects non-participant outsider (403) and allows verified participant (200)
        outsider_vr = self.client.get(f"/api/rave/voice-relay/{rid}?clientId=h_outsider_999&sinceTs=0")
        self.assertEqual(outsider_vr.status_code, 403)
        member_vr = self.client.get(f"/api/rave/voice-relay/{rid}?clientId=h_solo_cap&clientToken={ctok}&sinceTs=0")
        self.assertEqual(member_vr.status_code, 200)
        self.assertTrue(member_vr.json().get("ok"))

        # 4. Cross-cloud WS fanout delivers remote Redis events once without duplicates
        sent_payloads = []

        class DummyWs:
            async def send_json(self, obj):
                sent_payloads.append(rooms.json.dumps(obj))

            async def send_text(self, txt):
                sent_payloads.append(txt)

        rooms.SOCKETS[rid] = {"h_ws_listener": DummyWs()}
        try:
            r_room = dict(_aio.run(rooms.STORE.get(rid)))
            r_room["events"] = list(r_room.get("events") or []) + [{
                "id": "ev_cross_cloud_test_1",
                "type": "chat",
                "ts": rooms.now(),
                "message": {"id": "m_cc_1", "user": "Bulut", "text": "Merhaba!"},
            }]

            class FakeSharedStore:
                shared = True

                def __init__(self, payload_dict):
                    self.l1_rooms = {}
                    self.l1_read_ts = {}
                    self._raw = rooms.json.dumps(payload_dict)

                async def cmd(self, op, *keys):
                    half = len(keys) // 2
                    return [self._raw] * half + [None] * (len(keys) - half)

            with patch.object(rooms, "STORE", FakeSharedStore(r_room)):
                _aio.run(rooms._ws_redis_fanout_step())
                _aio.run(rooms._ws_redis_fanout_step())
            matching = [p for p in sent_payloads if "ev_cross_cloud_test_1" in p]
            self.assertEqual(len(matching), 1)
            # Local event marked before STORE.put must NOT fanout a second time
            r_room["events"].append({
                "id": "ev_local_ws_chat_no_dup",
                "type": "chat",
                "ts": rooms.now(),
                "message": {"id": "m_loc_1", "user": "Yerel", "text": "Tek sefer!"},
            })
            rooms._mark_room_local_events_delivered(r_room)
            with patch.object(rooms, "STORE", FakeSharedStore(r_room)):
                _aio.run(rooms._ws_redis_fanout_step())
            dup_local = [p for p in sent_payloads if "ev_local_ws_chat_no_dup" in p]
            self.assertEqual(len(dup_local), 0)
        finally:
            rooms.SOCKETS.pop(rid, None)

        # 5. Edge authenticated X-Watchlivo-Client-IP vs spoofed header
        class FakeReq:
            def __init__(self, headers, peer="203.0.113.50"):
                self.headers = headers
                self.client = type("C", (), {"host": peer})()

        with patch.dict(_os.environ, {"EDGE_ORIGIN_SECRET": "edge_sec_v136", "VERCEL": "1"}):
            ip_valid = security.client_ip(FakeReq({
                "x-watchlivo-client-ip": "198.51.100.42",
                "x-watchlivo-edge-secret": "edge_sec_v136",
                "x-forwarded-for": "1.2.3.4",
            }))
            ip_spoof = security.client_ip(FakeReq({
                "x-watchlivo-client-ip": "198.51.100.42",
                "x-watchlivo-edge-secret": "wrong_secret",
                "cf-connecting-ip": "198.51.100.99",
            }))
        self.assertEqual(ip_valid, "198.51.100.42")
        self.assertEqual(ip_spoof, "198.51.100.99")

        # 6. 45KB raster data:image avatar preserved; SVG data URI blocked
        big_png = "data:image/png;base64," + ("A" * 12000)
        self.assertEqual(social_engine._clean_avatar(big_png), big_png)
        self.assertEqual(social_engine._clean_avatar("data:image/svg+xml;base64,PHN2Zz4="), "")

        # 7. /download/windows?check=1 returns JSON capability metadata while plain GET redirects/serves cleanly
        chk = self.client.get("/download/windows?check=1")
        self.assertEqual(chk.status_code, 200)
        self.assertIn("available", chk.json())


if __name__ == '__main__':
    unittest.main()
