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
        self.assertIn("fragLoadingTimeOut: 25000", html5_js)
        self.assertIn("this.hls.autoLevelCapping = maxAllowedIdx", html5_js)
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
        # Second device (Desktop App) of the same creator joins
        rooms.add_participant(room, "h_desk2", {"username": "Mert Can Yıldız", "device": "Masaüstü"}, "http")
        # Guest viewer joins
        rooms.add_participant(room, "h_guest3", {"username": "Misafir", "device": "Mobil"}, "http")
        # Host stays on h_web1 (no ping-pong host stealing while h_web1 is alive), and BOTH creator sessions have isCreator=True & co_hosts
        self.assertEqual(room["host_id"], "h_web1")
        self.assertIn("h_web1", room["co_hosts"])
        self.assertIn("h_desk2", room["co_hosts"])
        ser = rooms.serialize(room)
        by_id = {p["id"]: p for p in ser["participants"]}
        self.assertTrue(by_id["h_web1"]["isCreator"])
        self.assertTrue(by_id["h_web1"]["isHost"])
        self.assertTrue(by_id["h_desk2"]["isCreator"])
        self.assertTrue(by_id["h_desk2"]["isCoHost"])
        self.assertFalse(by_id["h_guest3"]["isCreator"])
        # Heartbeat from non-host (h_desk2) while h_web1 is alive is ignored so two windows don't fight over timestamps
        rooms.handle_action(room, "h_desk2", {"type": "heartbeat", "currentTime": 15.0, "playing": True})
        self.assertGreaterEqual(room["media"]["currentTime"], 120.0)
        # Heartbeat from active host (h_web1) updates server timestamp and emits heartbeat sync event
        hb_out = rooms.handle_action(room, "h_web1", {"type": "heartbeat", "currentTime": 145.5, "playing": True})
        self.assertAlmostEqual(room["media"]["currentTime"], 145.5, places=1)
        self.assertTrue(any(e.get("action") == "heartbeat" for e, _ in hb_out["broadcast"]))
        # Explicit seek/pause from creator's second device (h_desk2) promotes h_desk2 to host_id and syncs all clients
        seek_out = rooms.handle_action(room, "h_desk2", {"type": "seek", "currentTime": 310.25})
        self.assertEqual(room["host_id"], "h_desk2")
        self.assertAlmostEqual(room["media"]["currentTime"], 310.25, places=2)
        self.assertEqual(seek_out["broadcast"][0][0]["action"], "seek")
        # If h_desk2 goes stale (>10s) and creator refreshes on Web with new cid h_web_new, h_web_new immediately reclaims host_id
        room["participants"]["h_desk2"]["lastSeen"] = rooms.now() - 12.0
        room["participants"]["h_web1"]["lastSeen"] = rooms.now() - 12.0
        rooms.add_participant(room, "h_web_new", {"username": "Mert Can Yıldız", "device": "Web"}, "http")
        self.assertEqual(room["host_id"], "h_web_new")

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
        self.assertIn("onPlay: (arg) => this.onEvent('play', arg)", host_js)
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
        self.assertIn("else if (behindAct === 'defer'", sync_js)
        self.assertIn("const JUMP_DELTA = 2.4;", sync_js)
        room = rooms.new_room("test-v38-room", "Test V38", "public", "leader", "Lider", "u_lider", "")
        rooms.add_participant(room, "h_lider", {"username": "Lider", "userId": "u_lider", "_internalCreator": True}, "http")
        room["host_id"] = "h_lider"
        rooms.set_media(room, {"title": "Zmora", "tmdbId": "253372", "url": "https://cdn.example.com/zmora.m3u8", "provider": "hls"}, "Lider", 0.0)
        # First heartbeat at t=1.2s, stored in follower's older syncToken
        rooms.handle_action(room, "h_lider", {"type": "heartbeat", "currentTime": 1.2, "playing": True})
        old_snap = copy.deepcopy(room)
        old_snap.pop("_tok_sig", None)
        old_tok = rooms.pack_sync_token(old_snap)
        # Newer heartbeat at t=6.5s arrives on room
        room["events"][-1]["ts"] = rooms.now() - 3.0
        rooms.handle_action(room, "h_lider", {"type": "heartbeat", "currentTime": 6.5, "playing": True})
        # Follower polls with old_tok -> merge_sync_token must NOT resurrect the older heartbeat!
        rooms.merge_sync_token(room, old_tok, room["id"])
        hbs = [e for e in room.get("events", []) if e.get("type") == "sync" and e.get("action") == "heartbeat"]
        self.assertEqual(len(hbs), 1)
        self.assertAlmostEqual(float(hbs[0]["media"]["currentTime"]), 6.5, places=1)


if __name__ == '__main__':
    unittest.main()
