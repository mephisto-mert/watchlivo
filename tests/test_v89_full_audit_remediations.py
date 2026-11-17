"""v89 Full 20-Subagent Ecosystem Audit Regression Suite."""
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from starlette.testclient import TestClient

import auth_engine
import rooms
import server
import social_engine


class V89FullAuditRemediationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = pathlib.Path(self._tmp.name) / "test_v89_auth.db"
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
        social_engine._USER_PROGRESS.clear()
        social_engine._USER_WATCHLIST.clear()
        social_engine._USER_YT_PREFS.clear()
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

    def _register(self, email: str, handle: str, name: str, pw: str = "StrongPass!2026"):
        auth_engine._REGISTER_LIMIT._hits.clear()
        auth_engine._LOGIN_LIMIT._hits.clear()
        r = self.client.post("/api/auth/register", json={"email": email, "handle": handle, "name": name, "password": pw})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        return d["user"], {"Authorization": f"Bearer {d['authToken']}"}

    def test_01_rooms_no_store_vary_and_browser_proxy_csp_sandbox(self):
        cr = self.client.post("/api/rooms/create", json={"name": "Cache Test", "creator": "HostA"}).json()["room"]
        sync_r = self.client.post(f"/api/rooms/{cr['id']}/sync", json={"type": "init", "clientId": "c1", "username": "HostA"})
        self.assertEqual(sync_r.status_code, 200)
        self.assertIn("no-store", sync_r.headers.get("cache-control", "").lower())
        lobby_r = self.client.get("/api/rooms")
        self.assertEqual(lobby_r.status_code, 200)
        self.assertIn("authorization", lobby_r.headers.get("vary", "").lower())
        srv_txt = (pathlib.Path(__file__).resolve().parents[1] / "server.py").read_text(encoding="utf-8")
        self.assertIn("sandbox allow-scripts allow-forms;", srv_txt)
        self.assertIn("base-uri 'none'", srv_txt)

    def test_02_room_internal_keys_stripped_token_iat_bound_and_leave_verified(self):
        tok = rooms.sign_client_token("room_x", "cid_owner")
        self.assertEqual(rooms.verify_client_token("room_x", tok), "cid_owner")
        parts = tok.split(".")
        forged_iat = f"{parts[0]}.{int(parts[1]) - 5}.{parts[2]}"
        self.assertEqual(rooms.verify_client_token("room_x", forged_iat), "")

        cr = self.client.post("/api/rooms/create", json={"name": "ACL Room", "creator": "Owner"}).json()["room"]
        rid = cr["id"]
        j1 = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": "owner1", "username": "Owner", "isCreator": True
        }).json()
        owner_tok = j1["clientToken"]
        self.assertEqual(j1["room"]["host_id"], "owner1")
        j2 = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "init", "clientId": "guest1", "username": "Owner", "isCreator": True, "_internalCreator": True, "_precreated": True
        }).json()
        self.assertEqual(j2["room"]["host_id"], "owner1")
        # Unauthenticated spoofed close_room must NOT evict real host or delete room
        spoof_close = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "close_room", "clientId": "owner1", "username": "Owner"
        })
        self.assertEqual(spoof_close.status_code, 403)
        real_poll = self.client.post(f"/api/rooms/{rid}/sync", json={
            "type": "poll", "clientId": "owner1", "clientToken": owner_tok
        }).json()
        self.assertEqual(real_poll["room"]["host_id"], "owner1")

    def test_03_auth_local_password_never_overwritten_and_search_wildcard_safe(self):
        u1, h1 = self._register("koruma@watchlivo.online", "koruma_vip", "Koruma VIP", "GercekSifre#2026!")
            bad = self.client.post("/api/auth/login", json={"identifier": "koruma@watchlivo.online", "password": "SahteSifre#999"})
            self.assertEqual(bad.status_code, 401)
        good = self.client.post("/api/auth/login", json={"identifier": "koruma@watchlivo.online", "password": "GercekSifre#2026!"})
        self.assertEqual(good.status_code, 200)

        u2, h2 = self._register("arayici@watchlivo.online", "arayici_hd", "Arayici HD")
        wild = self.client.get("/api/rave/social/search", params={"uid": u2["uid"], "q": "%%%"}, headers=h2).json()
        self.assertEqual(wild["users"], [])
        by_email = self.client.get("/api/rave/social/search", params={"uid": u2["uid"], "q": "koruma@watchlivo.online"}, headers=h2).json()
        self.assertFalse(any(x["uid"] == u1["uid"] for x in by_email["users"]))
        by_handle = self.client.get("/api/rave/social/search", params={"uid": u2["uid"], "q": "@koruma_vip"}, headers=h2).json()
        self.assertTrue(any(x["uid"] == u1["uid"] for x in by_handle["users"]))

    def test_04_social_dm_privacy_invite_cancel_acl_and_notification_guards(self):
        u1, h1 = self._register("seda@watchlivo.online", "seda_1", "Seda")
        u2, h2 = self._register("kaan@watchlivo.online", "kaan_2", "Kaan")
        u3, h3 = self._register("mert3@watchlivo.online", "mert_3", "Mert3")

        # Seed thread then unfriend / check non-friend DM GET returns empty messages
        tid = social_engine._thread_key(u1["uid"], u2["uid"])
        social_engine._DM_THREADS[tid] = [{"id": "m1", "fromUid": u1["uid"], "text": "gizli", "ts": 1000}]
        dm_non_friend = self.client.get("/api/rave/social/dm", params={"uid": u1["uid"], "peerId": u2["uid"]}, headers=h1).json()
        self.assertFalse(dm_non_friend["canMessage"])
        self.assertEqual(dm_non_friend["messages"], [])

        # Broadcast '*' notification spam blocked & unauth push to registered user blocked
        bcast = self.client.post("/api/rave/notifications/send", json={"targetUid": "*", "roomId": "r1"})
        self.assertEqual(bcast.status_code, 400)
        unauth_reg = self.client.post("/api/rave/notifications/send", json={"targetUid": u1["uid"], "roomId": "r1"})
        self.assertIn(unauth_reg.status_code, (401, 403))

        # Invite cancel requires original sender uid
        self.client.post("/api/rave/social/friends", headers=h1, json={"uid": u1["uid"], "action": "request", "targetUid": u2["uid"]})
        self.client.post("/api/rave/social/friends", headers=h2, json={"uid": u2["uid"], "action": "accept", "targetUid": u1["uid"]})
        inv = self.client.post("/api/rave/social/invite", headers=h1, json={
            "uid": u1["uid"], "targetUid": u2["uid"], "action": "send", "roomId": "rm_inv", "roomName": "Oda"
        }).json()["invites"][0]
        self.client.post("/api/rave/social/invite", headers=h3, json={
            "uid": u3["uid"], "targetUid": u2["uid"], "action": "cancel", "inviteId": inv["id"]
        })
        notifs_u2 = self.client.get("/api/rave/notifications/poll", params={"uid": u2["uid"]}, headers=h2).json()["notifications"]
        self.assertTrue(any(i["id"] == inv["id"] for i in notifs_u2))

    def test_05_frontend_and_native_apk_ipa_hardening_invariants(self):
        repo = pathlib.Path(__file__).resolve().parents[1]
        proj = repo.parent
        self.assertIn("is_fmp4_seg", (repo / "server.py").read_text(encoding="utf-8"))
        self.assertIn("_SEG_CACHE_MAX_BYTES", (repo / "server.py").read_text(encoding="utf-8"))
        self.assertIn("about:blank", (repo / "static" / "js" / "players" / "embed.js").read_text(encoding="utf-8"))
        self.assertIn("pkt.fromCid = id;", (repo / "static" / "js" / "voice.js").read_text(encoding="utf-8"))
        self.assertIn("parsed.origin === self.location.origin", (repo / "static" / "sw.js").read_text(encoding="utf-8"))
        manifest = (proj / "watchlivo_android" / "AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertIn('android:allowBackup="false"', manifest)
        self.assertIn('android:versionCode="5"', manifest)
        ios_main = (proj / "watchlivo_ios" / "main.m").read_text(encoding="utf-8")
        self.assertIn("isTrustedWatchlivoHost:", ios_main)


        import music_engine
        repo = pathlib.Path(__file__).resolve().parents[1]
        self.assertIn("yt-adfree-video", yt_js)
        self.assertIn("/api/rave/yt-pip-hls.m3u8", yt_js)
        self.assertIn("kind=muxed", yt_js)
        self.assertIn("enterAutoPiP", yt_js)

        fake_info = {
            "muxedUrl": "",
            "videoFmt": {
                "initRange": {"start": "0", "end": "739"},
                "indexRange": {"start": "740", "end": "1227"},
                "width": 1920,
                "height": 1080,
                "bandwidth": 3200000,
                "codecs": 'video/mp4; codecs="avc1.640028"',
                "ua": music_engine.UA_YT_IOS,
            },
            "audioFmt": {
                "initRange": {"start": "0", "end": "631"},
                "indexRange": {"start": "632", "end": "999"},
                "bandwidth": 130000,
                "codecs": 'audio/mp4; codecs="mp4a.40.2"',
                "ua": music_engine.UA_YT_IOS,
            },
            "duration": 212,
            "ua": music_engine.UA_YT_IOS,
        }
        with patch.object(music_engine, "_yt_ios_extract_sync", return_value=fake_info):
            r_vod = self.client.get("/api/rave/yt-pip-hls.m3u8?v=dQw4w9WgXcQ")
            self.assertEqual(r_vod.status_code, 200)
            self.assertIn("/api/rave/yt-pip-track.m3u8?v=dQw4w9WgXcQ&kind=video", r_vod.text)
            self.assertIn('CODECS="avc1.640028,mp4a.40.2"', r_vod.text)
            self.assertIn("RESOLUTION=1920x1080", r_vod.text)

            r_live = self.client.get("/api/rave/yt-pip-hls.m3u8?v=dQw4w9WgXcQ&live=1")
            self.assertEqual(r_live.status_code, 200)
            self.assertIn("/api/rave/stream?u=", r_live.text)

            r_mux = self.client.get("/api/rave/yt-music-stream?v=dQw4w9WgXcQ&kind=muxed")
            self.assertEqual(r_mux.status_code, 404)



        # 1. Unauthenticated /api/user/yt-preferences must be rejected with 401
        r_unauth = self.client.get("/api/user/yt-preferences")
        self.assertEqual(r_unauth.status_code, 401)
        self.assertIn("no-store", r_unauth.headers.get("cache-control", "").lower())

        # 2. Register two independent accounts and verify strict isolation
        u1, h1 = self._register("yt_u1@watchlivo.test", "ytuser1", "YT User One")
        u2, h2 = self._register("yt_u2@watchlivo.test", "ytuser2", "YT User Two")

        pr = self.client.post("/api/user/progress", headers=h1, json={
            "action": "upsert",
            "key": "yt:kJQP7kiw5Fk",
            "videoId": "kJQP7kiw5Fk",
            "title": "Luis Fonsi - Despacito",
            "channel": "LuisFonsiVEVO",
            "channelId": "UCxoq-PAQeAdk_zyg8YS0JqA",
            "channelAvatar": "https://yt3.ggpht.com/avatar_test.jpg",
            "position": 45,
            "duration": 280,
        })
        self.assertEqual(pr.status_code, 200)
        saved_item = pr.json()["items"][0]
        self.assertEqual(saved_item["videoId"], "kJQP7kiw5Fk")
        self.assertEqual(saved_item["channel"], "LuisFonsiVEVO")
        self.assertEqual(saved_item["channelId"], "UCxoq-PAQeAdk_zyg8YS0JqA")

        # Save channel follow, like, search, dismiss & block for u1
        self.client.post("/api/user/yt-preferences", headers=h1, json={
            "action": "follow_channel",
            "channel": {"channelId": "UCq-Fj5jknLsUf-MWSy4_brA", "name": "Evrim Ağacı"},
        })
        self.client.post("/api/user/yt-preferences", headers=h1, json={
            "action": "like_video",
            "video": {"videoId": "7RW8n4iXZbA", "title": "mor ve ötesi - Bir Derdim Var", "channel": "mor ve ötesi"},
        })
        self.client.post("/api/user/yt-preferences", headers=h1, json={"action": "add_search", "query": "bilim kurgu analiz"})
        self.client.post("/api/user/yt-preferences", headers=h1, json={"action": "dismiss_video", "videoId": "HIDE_ME_123"})
        self.client.post("/api/user/yt-preferences", headers=h1, json={"action": "block_channel", "channel": "MutedSpamChannel"})

        prefs_u2 = self.client.get("/api/user/yt-preferences", headers=h2).json()["prefs"]
        self.assertEqual(prefs_u2["subscriptions"], [])
        self.assertEqual(prefs_u2["likedVideos"], [])
        self.assertEqual(prefs_u2["searchHistory"], [])

        sample_lvm = {
            "contentId": "AbCdEfGh123",
            "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
            "contentImage": {
                "thumbnailViewModel": {
                    "overlays": [{"thumbnailBottomOverlayViewModel": {"badges": [{"thumbnailBadgeViewModel": {"text": "12:45"}}]}}]
                }
            },
            "metadata": {
                "lockupMetadataViewModel": {
                    "title": {"content": "Derin Uzay Belgeseli 4K"},
                    "image": {
                        "decoratedAvatarViewModel": {
                            "avatar": {"avatarViewModel": {"image": {"sources": [{"url": "https://yt3.ggpht.com/ch1.jpg"}]}}},
                            "rendererContext": {"commandContext": {"onTap": {"innertubeCommand": {"browseEndpoint": {"browseId": "UC1234567890123456789012"}}}}},
                        }
                    },
                    "metadata": {
                        "contentMetadataViewModel": {
                            "metadataRows": [
                                {"metadataParts": [{"text": {"content": "Evrim Ağacı"}}]},
                                {"metadataParts": [{"text": {"content": "420 B görüntüleme"}}, {"text": {"content": "2 gün önce"}}]},
                            ]
                        }
                    },
                }
            },
        }
        parsed_lvm = server._parse_lockup_view_model(sample_lvm)
        self.assertIsNotNone(parsed_lvm)
        self.assertEqual(parsed_lvm["videoId"], "AbCdEfGh123")
        self.assertEqual(parsed_lvm["channel"], "Evrim Ağacı")
        self.assertEqual(parsed_lvm["channelId"], "UC1234567890123456789012")
        self.assertEqual(parsed_lvm["views"], "420 B görüntüleme")
        self.assertEqual(parsed_lvm["duration"], "12:45")

        # 4. Verify /api/rave/yt-personalized-feed interleaves & filters dismissed/blocked items with private no-store headers
        mock_next = [
            {"videoId": "HIDE_ME_123", "title": "Gizlenen Video", "channel": "Other", "channelId": "", "views": "10 B", "published": "1 gün önce", "duration": "3:10", "live": False, "thumbnail": "", "url": ""},
            {"videoId": "SPAM_VID_99", "title": "Spam Video", "channel": "MutedSpamChannel", "channelId": "", "views": "1 B", "published": "1 saat önce", "duration": "1:00", "live": False, "thumbnail": "", "url": ""},
        ]
        with patch.object(server, "_yt_next_related_sync", return_value=mock_next), \
             patch.object(server, "_yt_channel_feed_sync", return_value=[]), \
             patch.object(server, "_yt_search_sync", return_value=[]):
            feed_r = self.client.post("/api/rave/yt-personalized-feed", headers=h1, json={"chip": "all"})
            self.assertEqual(feed_r.status_code, 200)
            self.assertIn("no-store", feed_r.headers.get("cache-control", "").lower())
            self.assertIn("authorization", feed_r.headers.get("vary", "").lower())
            fd = feed_r.json()
            self.assertTrue(fd["ok"])
            self.assertTrue(fd["authenticated"])
            self.assertTrue(fd["personalized"])
            vids = [it["videoId"] for it in fd["items"]]
            self.assertIn("AbCdEfGh123", vids)
            self.assertNotIn("HIDE_ME_123", vids)
            self.assertNotIn("SPAM_VID_99", vids)
            self.assertTrue(fd["items"][0]["isFollowedChannel"])



    def test_08_poster_proxy_cloudflare_self_healing_and_vault_posters(self):
        import json
        repo = pathlib.Path(__file__).resolve().parents[1]
        vault = json.loads((repo / "main_sites_vault.json").read_text(encoding="utf-8"))
        for src_k, items in (vault.get("catalog") or {}).items():
            for it in (items or []):
                p = str(it.get("poster") or "").strip()
                self.assertTrue(bool(p), f"Empty poster in vault {src_k}: {it.get('title')}")
                for blocked_dom in ("img.fullhdfilmizlesene.", "www.hdfilmcehennemi.", "www.dizibox."):
                    self.assertNotIn(blocked_dom, p, f"Unhealed CF-blocked poster in {src_k}: {it.get('title')} -> {p}")
                if "Gekijoban Mononoke" in str(it.get("title") or ""):
                    self.assertTrue(any(d in p for d in ("image.tmdb.org", "m.media-amazon.com")), p)

        with patch.object(server, "_fetch_poster_sync", side_effect=OSError("HTTP 403 Forbidden")), \
             patch.object(server, "_http_json", return_value={"results": [{"poster_path": "/test_healed_poster.jpg", "release_date": "2010-07-16"}]}):
            server._POSTER_REDIRECT_CACHE.clear()
            r = self.client.get(
                "/api/rave/poster?u=https%3A%2F%2Fimg.fullhdfilmizlesene.now%2Fposter%2Ffilm%2Finception.jpg&t=Inception&y=2010&mt=movie",
                follow_redirects=False,
            )
            self.assertEqual(r.status_code, 302)
            self.assertEqual(r.headers.get("location"), "https://image.tmdb.org/t/p/w500/test_healed_poster.jpg")

    def test_09_vidlink_expiry_dead_stream_guard_and_yt_home_gated(self):
        import time
        repo = pathlib.Path(__file__).resolve().parents[1]

        # 1. Recent hakunaymatata signed URLs (e.g. 2 hours old CDN signature) must NOT be falsely expired
        two_hours_ago = int(time.time()) - 7200
        hk_u = f"https://bcdn.hakunaymatata.com/resource/abc123_1080p.mp4?sign=deadbeef&t={two_hours_ago}"
        self.assertFalse(server._is_vault_url_expired(hk_u))
        stale_u = f"https://bcdn.hakunaymatata.com/resource/abc123_1080p.mp4?sign=deadbeef&t={int(time.time()) - 300000}"
        self.assertTrue(server._is_vault_url_expired(stale_u))

        # 2. Chainsaw Man (114410 -> 11884) must have direct .cfd MP4s for S1E1..S1E12
        self.assertEqual(server._ANIMECIX_KNOWN_TMDB.get("114410"), 11884)
        for ep_n in range(1, 13):
            entries = server._ANIMECIX_TAU_MAP.get(f"11884:1:{ep_n}") or []
            self.assertTrue(
                any(isinstance(p, list) and len(p) >= 3 and ".cfd/file/tau-video/" in str(p[2]) for p in entries),
                f"Missing direct .cfd MP4 for Chainsaw Man S1E{ep_n}: {entries}",
            )

        sel_js = (repo / "static" / "js" / "views" / "selection.js").read_text(encoding="utf-8")
        self.assertIn("const showYtHome = false;", sel_js)
        self.assertNotIn("...(showYtHome ? [ytHomeMount] : [])", sel_js)
        kinds_js = (repo / "static" / "js" / "views" / "selection-kinds.js").read_text(encoding="utf-8")
        self.assertIn("fetchPersonalizedYtFeed", kinds_js)
        store_js = (repo / "static" / "js" / "store.js").read_text(encoding="utf-8")
        self.assertNotIn("fragman inceleme`", store_js)

        dead_u = "https://white-tooth-83b1.wellsrobertsonkmlt.workers.dev/video.m3u8"
        server._STREAM_RES_HINT[dead_u] = -1
        with patch.object(server, "_get_tmdb_meta_sync", return_value={"originalTitle": "From", "trTitle": "From", "year": "2022", "imdbId": "tt9813792", "origLang": "en", "runtime": 50}), \
             patch.object(server, "_tv_season_ep_map", return_value={1: 10}), \
             patch.object(server, "_extract_direct_stream_sync", return_value=[(dead_u, "hls_ve")]), \
             patch.object(server, "_build_audio_tracks", return_value=[]), \
             patch.object(server, "_fetch_subtitles_sync", return_value=[]), \
             patch.object(server, "_extract_official_yt_sync") as mock_yt:
            res_dead = server._resolve_catalog_sync("cinema", "From", "2022", "124364", "tv", "", season=1, episode=2)
            self.assertIsNone(res_dead)
            mock_yt.assert_not_called()

    def test_10_native_apk_download_and_rave_auto_updater_endpoint(self):
        import hashlib
        ver_resp = self.client.get("/api/app/version")
        self.assertEqual(ver_resp.status_code, 200)
        vdata = ver_resp.json()
        self.assertTrue(vdata.get("ok"))
        self.assertEqual(vdata.get("packageName"), "online.watchlivo.app")
        self.assertGreaterEqual(int(vdata.get("versionCode") or 0), 20)
        self.assertTrue(vdata.get("autoInstall"))
        self.assertIn("/download/Watchlivo-v2.0.apk", vdata.get("apkUrl", ""))

        for dl_path in ("/download/Watchlivo-v2.0.apk", "/download/apk", "/download/Watchlivo-v1.1.apk"):
            apk_resp = self.client.get(dl_path)
            self.assertEqual(apk_resp.status_code, 200, f"Failed on {dl_path}")
            self.assertEqual(apk_resp.content[:4], b"PK\x03\x04")
            self.assertEqual(hashlib.sha256(apk_resp.content).hexdigest(), vdata["sha256"])
            self.assertEqual(len(apk_resp.content), vdata["sizeBytes"])

    def test_11_v95_alem_fm_hls_and_music_q_and_ota_v21(self):
        import rooms
        import music_engine
        # 1. Alem FM must use HLS stream via /api/rave/stream proxy with zero mixed-content http:// altUrls
        alem_spec = next((s for s in rooms.CURATED_LIVE_SPECS if s["id"] == "radyo-alem-fm"), None)
        self.assertIsNotNone(alem_spec)
        self.assertEqual(alem_spec["media"]["streamType"], "hls")
        self.assertTrue(alem_spec["media"]["url"].startswith("/api/rave/stream?"))
        for u in alem_spec["media"].get("altUrls", []):
            self.assertTrue(u.startswith("https://"), f"Mixed-content altUrl leaked: {u}")

        # 2. music-resolve must parse ?q=Artist - Title when title/artist params are omitted
        with patch.object(music_engine, "_resolve_music_sync") as mock_rm:
            mock_rm.return_value = {"provider": "direct", "streamType": "mp4", "url": "https://example.com/a.mp4", "isMusic": True}
            mr = self.client.get("/api/rave/music-resolve?q=Tarkan+-+Kuzu+Kuzu")
            self.assertEqual(mr.status_code, 200)
            args = mock_rm.call_args[0]
            self.assertEqual(args[0], "Tarkan")
            self.assertEqual(args[1], "Kuzu Kuzu")

        # 3. OTA versionCode bumped to >= 21 (v2.0.1+)
        ver_resp = self.client.get("/api/app/version")
        self.assertEqual(ver_resp.status_code, 200)
        self.assertGreaterEqual(int(ver_resp.json().get("versionCode") or 0), 21)

    def test_12_v190_guest_playback_anti_stutter_and_seek_invariants(self):
        import pathlib
        static_dir = pathlib.Path(__file__).resolve().parent.parent / "static" / "js"
        sync_js = (static_dir / "sync.js").read_text(encoding="utf-8")
        mesh_js = (static_dir / "views" / "mesh.js").read_text(encoding="utf-8")
        rt_js = (static_dir / "realtime.js").read_text(encoding="utf-8")
        html5_js = (static_dir / "players" / "html5.js").read_text(encoding="utf-8")

        self.assertNotIn("abs > 0.75 && safeBuffered", sync_js)
        self.assertIn("!ad.useNativeHls", sync_js)
        self.assertIn("const isPassiveSync = data.action === 'heartbeat' || data.action === 'poll_sync';", mesh_js)
        self.assertIn("const significantJump = isPaused ? (posDiff > 0.35) : (posDiff > 2.2);", rt_js)
        self.assertIn("clearPrimaryInitSeek", html5_js)


if __name__ == "__main__":
    unittest.main()
