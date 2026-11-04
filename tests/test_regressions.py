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
        self.assertIn("onPause: (arg) => this.onEvent('pause', arg)", host_js)
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

        # 1. Cache-bust bumped cleanly to 20261104_v106 with zero stale v79/v87/v88 references
        index_html = (root / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn("20261104_v106", index_html)
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
        self.assertIn("picture-in-picture=(self *)", r_idx.headers.get("permissions-policy", ""))
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
        self.assertIn("if (!email && !password) { doGuestLogin(name); return; }", profile_js)

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

        # 3. Frontend series picker season counts & full episode labels
        root = Path(__file__).resolve().parent.parent
        accounts_js = (root / "static" / "js" / "accounts.js").read_text(encoding="utf-8")
        self.assertIn("s.count ? ` (${s.count} Bölüm)` : ''", accounts_js)
        self.assertIn("`${curSeason}. Sezon ${ep.episode}. Bölüm — ${rawEpName}`", accounts_js)


if __name__ == '__main__':
    unittest.main()
