"""v83 Regression & Rave Parity Suite:
1. Zero '21st.dev' / 'MiroFish' / '98p' strings & v83 cache-buster across static assets.
2. Strict per-account personal Watch History isolation + completed movie retention.
3. Mutual Friend Request approval gate + Real-Time Mutual DM + Reactions + Read Receipts.
4. Live Online/Watching/Idle/Offline Presence + Privacy + In-App Room Invitations.
"""
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from starlette.testclient import TestClient

import auth_engine
import rooms
import server
import social_engine


class V83SocialHistoryUiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = pathlib.Path(self._tmp.name) / "test_v83_auth.db"
        self._orig_db = auth_engine.AUTH_DB_PATH
        self._orig_ready = auth_engine._AUTH_DB_SCHEMA_READY
        auth_engine.AUTH_DB_PATH = self.db_path
        auth_engine._AUTH_DB_SCHEMA_READY = False
        auth_engine._get_db().close()
        social_engine._SOCIAL_USERS.clear()
        social_engine._DM_THREADS.clear()
        social_engine._NOTIFICATION_QUEUES.clear()
        social_engine._PRESENCE_MAP.clear()
        social_engine._SOCIAL_DIR.clear()
        social_engine._DM_TYPING.clear()
        social_engine._DM_CONFIG.clear()
        social_engine._USER_PROGRESS.clear()
        social_engine._USER_WATCHLIST.clear()
        self._kv_get_p = patch.object(social_engine, "_kv_get", side_effect=lambda k, default=None, **kw: default)
        self._kv_set_p = patch.object(social_engine, "_kv_set", return_value=None)
        self._kv_get_p.start()
        self._kv_set_p.start()
        self.client = TestClient(server.app)

    def tearDown(self):
        self._kv_get_p.stop()
        self._kv_set_p.stop()
        auth_engine.AUTH_DB_PATH = self._orig_db
        auth_engine._AUTH_DB_SCHEMA_READY = self._orig_ready
        self._tmp.cleanup()

    def _register(self, email: str, handle: str, name: str):
        auth_engine._REGISTER_LIMIT._hits.clear()
        r = self.client.post("/api/auth/register", json={
            "email": email, "handle": handle, "name": name, "password": "StrongPass!2026"
        })
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        return data["user"], {"Authorization": f"Bearer {data['authToken']}"}

    def test_01_zero_21st_dev_and_v83_ui_tokens(self):
        root = pathlib.Path(__file__).resolve().parent.parent / "static"
        index_txt = (root / "index.html").read_text(encoding="utf-8")
        self.assertIn("20261114_v215", index_txt)
        for ext in ("*.js", "*.css", "*.html"):
            for p in root.rglob(ext):
                txt = p.read_text(encoding="utf-8")
                self.assertNotIn("21st.dev", txt, f"Found 21st.dev in {p.name}")
                self.assertNotIn("MiroFish", txt, f"Found MiroFish in {p.name}")
                self.assertNotIn("'98p'", txt, f"Found '98p' in {p.name}")
        vortex_css = (root / "css" / "vortex.css").read_text(encoding="utf-8")
        for tok in ("--accent-ink", ".wl-studio-theme-strip", ".wl-tubelight-indicator", ".wl-history-hub", ".wl-dm-root", ".wl-pres-dot"):
            self.assertIn(tok, vortex_css)

    def test_02_personal_watch_history_strict_account_isolation_and_completed(self):
        self.assertEqual(self.client.get("/api/user/progress").status_code, 401)
        u_a, h_a = self._register("ali@watchlivo.online", "ali_sinema", "Ali Sinema")
        u_b, h_b = self._register("burcu@watchlivo.online", "burcu_film", "Burcu Film")

        # User A watches a movie to 42% and finishes another movie at 98%
        r1 = self.client.post("/api/user/progress", headers=h_a, json={
            "tmdbId": "693134", "mediaType": "movie", "title": "Dune: Çöl Gezegeni Bölüm İki",
            "position": 3800, "duration": 9000
        })
        self.assertEqual(r1.status_code, 200)
        r2 = self.client.post("/api/user/progress", headers=h_a, json={
            "tmdbId": "872585", "mediaType": "movie", "title": "Oppenheimer",
            "position": 10600, "duration": 10800
        })
        self.assertEqual(r2.status_code, 200)
        items_a = self.client.get("/api/user/progress", headers=h_a).json()["items"]
        self.assertEqual(len(items_a), 2)
        opp = next(x for x in items_a if x["tmdbId"] == "872585")
        self.assertTrue(opp["completed"])

        # User B's personal history MUST be completely empty (zero cross-account leakage)
        res_b = self.client.get("/api/user/progress", headers=h_b).json()
        self.assertEqual(res_b["uid"], u_b["uid"])
        self.assertEqual(res_b["items"], [])

    def test_03_mutual_friend_approval_dm_presence_and_room_invite(self):
        u_a, h_a = self._register("deniz@watchlivo.online", "deniz_4k", "Deniz")
        u_b, h_b = self._register("ece@watchlivo.online", "ece_imax", "Ece")

        # Search finds real registered user (zero fake bots)
        sr = self.client.get("/api/rave/social/search", params={"uid": u_a["uid"], "q": "ece_imax"}, headers=h_a).json()
        self.assertTrue(any(u["uid"] == u_b["uid"] for u in sr["users"]))
        self.assertFalse(any(u["uid"] == "u_ayla_cinema" for u in sr["users"]))

        # DM before mutual friendship MUST be blocked (403)
        dm_blocked = self.client.post("/api/rave/social/dm", headers=h_a, json={
            "uid": u_a["uid"], "peerId": u_b["uid"], "text": "Selam!"
        })
        self.assertEqual(dm_blocked.status_code, 403)

        # User A sends friend request -> pending on both sides + notification for User B
        req_res = self.client.post("/api/rave/social/friends", headers=h_a, json={
            "uid": u_a["uid"], "action": "request", "target": "@ece_imax"
        }).json()
        self.assertEqual(req_res["status"], "OUTGOING_PENDING")
        st_b = self.client.get("/api/rave/social/state", params={"uid": u_b["uid"]}, headers=h_b).json()
        self.assertEqual(len(st_b["requests"]), 1)
        notifs_b = self.client.get("/api/rave/notifications/poll", params={"uid": u_b["uid"]}, headers=h_b).json()["notifications"]
        self.assertTrue(any(n["type"] == "friend_request" for n in notifs_b))

        # User B approves -> mutual FRIENDS on both accounts
        acc_res = self.client.post("/api/rave/social/friends", headers=h_b, json={
            "uid": u_b["uid"], "action": "accept", "targetUid": u_a["uid"]
        }).json()
        self.assertEqual(acc_res["status"], "FRIENDS")

        # Real-time DM + typing + reaction + read receipt
        self.client.post("/api/rave/social/dm", headers=h_a, json={"uid": u_a["uid"], "peerId": u_b["uid"], "action": "typing"})
        dm_typing_view = self.client.get("/api/rave/social/dm", params={"uid": u_b["uid"], "peerId": u_a["uid"]}, headers=h_b).json()
        self.assertTrue(dm_typing_view["peerTyping"])
        dm_send = self.client.post("/api/rave/social/dm", headers=h_a, json={
            "uid": u_a["uid"], "fromName": "Deniz", "peerId": u_b["uid"], "text": "Bu akşam birlikte izleyelim mi?"
        }).json()
        msg_id = dm_send["messages"][-1]["id"]
        dm_b_view = self.client.get("/api/rave/social/dm", params={"uid": u_b["uid"], "peerId": u_a["uid"]}, headers=h_b).json()
        self.assertTrue(dm_b_view["canMessage"])
        self.assertFalse(dm_b_view["peerTyping"])
        self.assertGreater(dm_b_view["messages"][-1]["readAt"], 0)
        self.client.post("/api/rave/social/dm", headers=h_b, json={
            "uid": u_b["uid"], "peerId": u_a["uid"], "action": "react", "messageId": msg_id, "emoji": "🔥"
        })

        # Presence watching + In-App Room Invite
        cr = self.client.post("/api/rooms/create", headers=h_a, json={
            "name": "Deniz IMAX Odası", "privacy": "friends", "creator": "Deniz", "creatorId": u_a["uid"],
            "media": {"title": "Interstellar", "poster": "https://example.com/interstellar.jpg", "url": "https://example.com/v.m3u8"}
        }).json()["room"]
        self.client.post("/api/rave/social/presence", headers=h_a, json={
            "uid": u_a["uid"], "status": "watching", "roomId": cr["id"], "roomName": cr["name"], "mediaTitle": "Interstellar"
        })
        st_b_live = self.client.get("/api/rave/social/state", params={"uid": u_b["uid"]}, headers=h_b).json()
        fr_a = next(f for f in st_b_live["friends"] if f["uid"] == u_a["uid"])
        self.assertEqual(fr_a["presenceState"], "watching")
        self.assertEqual(fr_a["roomId"], cr["id"])

        inv = self.client.post("/api/rave/social/invite", headers=h_a, json={
            "uid": u_a["uid"], "targetUid": u_b["uid"], "action": "send", "roomId": cr["id"], "roomName": cr["name"], "mediaTitle": "Interstellar"
        }).json()
        self.assertTrue(inv["ok"])
        inv_notifs = self.client.get("/api/rave/notifications/poll", params={"uid": u_b["uid"]}, headers=h_b).json()["notifications"]
        self.assertTrue(any(n["type"] == "room_invite" and n["roomId"] == cr["id"] for n in inv_notifs))

    def test_06_v84_iphone13_pip_volume_brightness_and_camera_icons(self):
        root = pathlib.Path(__file__).resolve().parent.parent / "static"
        ctl_js = (root / "js" / "views" / "controls.js").read_text(encoding="utf-8")
        html5_js = (root / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        gain_js = (root / "js" / "players" / "audio-gain.js").read_text(encoding="utf-8")
        host_js = (root / "js" / "players" / "host.js").read_text(encoding="utf-8")
        voice_js = (root / "js" / "voice.js").read_text(encoding="utf-8")
        mesh_css = (root / "css" / "mesh.css").read_text(encoding="utf-8")

        # 1. iPhone 13 PiP: no 'desteklenmiyor' error toast, trustedTapProps + vortexMinimizeRoom fallback
        self.assertNotIn("Bu cihazda Pencere İçinde Pencere (PiP) desteklenmiyor.", ctl_js)
        self.assertIn("trustedTapProps", ctl_js)
        self.assertIn("window.vortexMinimizeRoom", ctl_js)
        self.assertIn("webkitSetPresentationMode", html5_js)

        # 2. Volume 0..100 smooth scaling without 0 -> 100 jump
        self.assertNotIn("if (!controllable && nv > 0 && nv !== 100)", ctl_js)
        self.assertIn("autoPictureInPicture", html5_js)
        self.assertIn("initialGain", gain_js)
        self.assertIn("this.userMuted = true;", host_js)

        # 3. Brightness strictly 0..100 (zero >100 boost distortion)
        self.assertNotIn("min: '15'", ctl_js)
        self.assertNotIn("max: '160'", ctl_js)
        self.assertNotIn("brightnessVeil.classList.add('is-boost')", ctl_js)
        self.assertNotIn(".wl-brightness-veil.is-boost", mesh_css)

        # 4. Zero camera bubble overlay icons inside .cam-bubble
        self.assertNotIn("swapBtn", voice_js)
        self.assertNotIn("spotBtn", voice_js)
        self.assertNotIn("sizeBtn", voice_js)
        self.assertNotIn("shapeBtn", voice_js)
        self.assertIn("wrap.append(vid, tag);", voice_js)
        self.assertIn(".cam-bubble-btn {\n  display: none !important;\n}", mesh_css)

    def test_07_v85_ios_system_pip_across_apps_and_home_screen(self):
        import zipfile
        repo_root = pathlib.Path(__file__).resolve().parent.parent
        static_root = repo_root / "static"
        html5_js = (static_root / "js" / "players" / "html5.js").read_text(encoding="utf-8")
        gain_js = (static_root / "js" / "players" / "audio-gain.js").read_text(encoding="utf-8")
        subs_js = (static_root / "js" / "players" / "subtitles.js").read_text(encoding="utf-8")
        yt_js = (static_root / "js" / "players" / "youtube.js").read_text(encoding="utf-8")
        host_js = (static_root / "js" / "players" / "host.js").read_text(encoding="utf-8")
        ctl_js = (static_root / "js" / "views" / "controls.js").read_text(encoding="utf-8")

        # 1. HTML5 adapter preserves untouched Native AVPlayer HLS on iOS + pre-warmed iosPipVideo standby + canvas Music PiP
        self.assertIn("_nativeIosPipSourceUrl", html5_js)
        self.assertIn("_ensureIosPipStandby", html5_js)
        self.assertIn("_switchIosNativeToInlineMse", html5_js)
        self.assertIn("watchlivoNativePiP", html5_js)
        self.assertIn("captureStream", html5_js)

        # 2. Audio gain never hijacks iOS <video> at 100%/0% or during PiP, and sets playback audioSession
        self.assertIn("ensureIosPlaybackAudioSession", gain_js)
        self.assertIn("hasWebAudioGraph", gain_js)
        self.assertIn("navigator.audioSession.type = 'playback'", gain_js)
        self.assertIn("syncNativeTrackToElement", subs_js)

        # 3. YouTube adapter has 1-tap synchronous iOS native <video> PiP bridge + backend HLS mux endpoint
        self.assertIn("_ensureIosPipBridge", yt_js)
        self.assertIn("/api/rave/yt-pip-hls.m3u8", yt_js)
        self.assertIn("watchlivoResolveYouTube", yt_js)
        self.assertIn("__onWatchlivoNativePiP", host_js)
        self.assertIn(":not(.wl-ios-pip-standby)", ctl_js)

        # 4. Backend /api/rave/yt-pip-hls.m3u8 route exists and kind=video on invalid ID returns 404 (never Semicenk fallback)
        r_bad_vid = self.client.get("/api/rave/yt-music-stream?v=bad id!&kind=video")
        self.assertEqual(r_bad_vid.status_code, 404)
        r_bad_hls = self.client.get("/api/rave/yt-pip-hls.m3u8?v=bad id!")
        self.assertEqual(r_bad_hls.status_code, 404)

        # 5. Rebuilt Watchlivo.ipa binary has PK\x03\x04 header, Unix 0o755 executable bits, and AVPictureInPictureController
        ipa_path = static_root / "Watchlivo.ipa"
        self.assertTrue(ipa_path.exists(), "Watchlivo.ipa missing from static/")
        raw_ipa = ipa_path.read_bytes()
        self.assertTrue(raw_ipa.startswith(b"PK\x03\x04"))
        with zipfile.ZipFile(ipa_path, "r") as zf:
            bin_info = zf.getinfo("Payload/Watchlivo.app/Watchlivo")
            unix_mode = (bin_info.external_attr >> 16) & 0o777
            self.assertEqual(unix_mode, 0o755)
            macho = zf.read("Payload/Watchlivo.app/Watchlivo")
            self.assertIn(b"AVPictureInPictureController", macho)
            self.assertIn(b"setCanStartPictureInPictureAutomaticallyFromInline:", macho)
            self.assertTrue(b"AVPlayerViewController" in macho or b"watchlivoPiP" in macho)


    def test_08_v86_zero_mock_and_native_ios_app_exit_pip(self):
        import zipfile
        repo_root = pathlib.Path(__file__).resolve().parent.parent
        static_root = repo_root / "static"

        # 1. Zero fake counters / dead mocks across all static JS/HTML/CSS
        for ext in ("*.js", "*.css", "*.html"):
            for p in static_root.rglob(ext):
                txt = p.read_text(encoding="utf-8")
                self.assertNotIn("85.000+", txt, f"Found 85.000+ in {p.name}")
                self.assertNotIn("Çevremdekiler", txt, f"Found Çevremdekiler in {p.name}")
                self.assertNotIn("SoundHelix", txt, f"Found SoundHelix in {p.name}")
                self.assertNotIn("BigBuckBunny", txt, f"Found BigBuckBunny in {p.name}")
                self.assertNotIn("gpt-6.1", txt, f"Found gpt-6.1 in {p.name}")

        # 2. WebClip mobileconfig has FullScreen=true and Precomposed=true so iOS opens without Safari link bar
        mc_txt = (static_root / "Watchlivo.mobileconfig").read_text(encoding="utf-8")
        self.assertRegex(mc_txt, r"<key>FullScreen</key>\s*<true/>")
        self.assertRegex(mc_txt, r"<key>Precomposed</key>\s*<true/>")

        # 3. Native Watchlivo.ipa Mach-O binary contains inline sync/pause + applicationWillResignActive: OS PiP handoff
        with zipfile.ZipFile(static_root / "Watchlivo.ipa", "r") as zf:
            macho = zf.read("Payload/Watchlivo.app/Watchlivo")
            self.assertIn(b"applicationWillResignActive:", macho)
            self.assertIn(b"restoreUserInterfaceForPictureInPictureStopWithCompletionHandler:", macho)
            self.assertIn(b"startOrSyncNativePiP:forceStart:", macho)
            plist_txt = zf.read("Payload/Watchlivo.app/Info.plist").decode("utf-8")
            self.assertTrue("<string>200</string>" in plist_txt or "<string>89</string>" in plist_txt)
