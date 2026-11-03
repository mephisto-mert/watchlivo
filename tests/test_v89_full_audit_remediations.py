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
        with patch.object(auth_engine, "_firebase_auth_req", return_value={"idToken": "tok_x", "users": [{"emailVerified": True, "email": "koruma@watchlivo.online"}]}):
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
        self.assertIn("forMainFrameOnly:YES", ios_main)
        self.assertIn("isTrustedWatchlivoHost:", ios_main)


    def test_06_adfree_youtube_fmp4_hls_and_nocookie_fallback(self):
        import music_engine
        repo = pathlib.Path(__file__).resolve().parents[1]
        yt_js = (repo / "static" / "js" / "players" / "youtube.js").read_text(encoding="utf-8")
        self.assertIn("yt-adfree-video", yt_js)
        self.assertIn("/api/rave/yt-pip-hls.m3u8", yt_js)
        self.assertIn("kind=muxed", yt_js)
        self.assertIn("https://www.youtube-nocookie.com", yt_js)
        self.assertIn("enterAutoPiP", yt_js)

        fake_info = {
            "hlsUrl": "https://manifest.googlevideo.com/api/manifest/hls_variant/ip/1.2.3.4/index.m3u8",
            "muxedUrl": "",
            "audioUrl": "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140",
            "videoUrl": "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
            "videoFmt": {
                "url": "https://rr1---sn-test.googlevideo.com/videoplayback?itag=137",
                "initRange": {"start": "0", "end": "739"},
                "indexRange": {"start": "740", "end": "1227"},
                "width": 1920,
                "height": 1080,
                "bandwidth": 3200000,
                "codecs": 'video/mp4; codecs="avc1.640028"',
                "ua": music_engine.UA_YT_IOS,
            },
            "audioFmt": {
                "url": "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140",
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



    def test_07_personalized_youtube_feed_account_isolation_and_lockup_parser(self):
        # 1. Unauthenticated /api/user/yt-preferences must be rejected with 401
        r_unauth = self.client.get("/api/user/yt-preferences")
        self.assertEqual(r_unauth.status_code, 401)
        self.assertIn("no-store", r_unauth.headers.get("cache-control", "").lower())

        # 2. Register two independent accounts and verify strict isolation
        u1, h1 = self._register("yt_u1@watchlivo.test", "ytuser1", "YT User One")
        u2, h2 = self._register("yt_u2@watchlivo.test", "ytuser2", "YT User Two")

        # Save YouTube watch progress with videoId/channel/channelId/channelAvatar for u1
        pr = self.client.post("/api/user/progress", headers=h1, json={
            "action": "upsert",
            "key": "yt:kJQP7kiw5Fk",
            "provider": "youtube",
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

        # Verify u2 sees ZERO of u1's YouTube preferences or history
        prefs_u2 = self.client.get("/api/user/yt-preferences", headers=h2).json()["prefs"]
        self.assertEqual(prefs_u2["subscriptions"], [])
        self.assertEqual(prefs_u2["likedVideos"], [])
        self.assertEqual(prefs_u2["searchHistory"], [])

        # 3. Verify 2026 YouTube lockupViewModel parser
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
            {"videoId": "AbCdEfGh123", "title": "Derin Uzay Belgeseli 4K", "channel": "Evrim Ağacı", "channelId": "UCq-Fj5jknLsUf-MWSy4_brA", "views": "420 B", "published": "2 gün önce", "duration": "12:45", "live": False, "thumbnail": "https://i.ytimg.com/vi/AbCdEfGh123/hqdefault.jpg", "url": "https://www.youtube.com/watch?v=AbCdEfGh123", "reason": "✨ İzlediğin videoya göre"},
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


if __name__ == "__main__":
    unittest.main()
