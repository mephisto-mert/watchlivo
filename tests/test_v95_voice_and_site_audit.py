"""v95 Voice Notes, Live Room Mic/Relay, Voice Search & Website Regression Suite."""
import base64
import pathlib
import struct
import tempfile
import unittest
from unittest.mock import patch

from starlette.testclient import TestClient

import auth_engine
import rooms
import server
import social_engine


def _make_wav_bytes(sample_count: int = 8000, rate: int = 12000) -> bytes:
    pcm = b"\x10\x04\xf0\xfb" * (sample_count // 2)
    data_len = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_len,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        data_len,
    )
    return header + pcm


class V95VoiceAndSiteAuditTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = pathlib.Path(self._tmp.name) / "test_v95_auth.db"
        self._orig_db = auth_engine.AUTH_DB_PATH
        self._orig_ready = auth_engine._AUTH_DB_SCHEMA_READY
        auth_engine.AUTH_DB_PATH = self.db_path
        auth_engine._AUTH_DB_SCHEMA_READY = False
        auth_engine._get_db().close()
        social_engine._SOCIAL_USERS.clear()
        social_engine._DM_THREADS.clear()
        social_engine._VOICE_NOTE_MEM.clear()
        social_engine._VOICE_RELAY_MEM.clear()
        self._kv_store = {}
        self._kv_get_p = patch.object(
            social_engine, "_kv_get", side_effect=lambda k, default=None, **kw: self._kv_store.get(k, default)
        )
        self._kv_set_p = patch.object(
            social_engine, "_kv_set", side_effect=lambda k, v, ttl_sec=604800: self._kv_store.__setitem__(k, v)
        )
        self._kv_get_p.start()
        self._kv_set_p.start()
        self.client = TestClient(server.app)

    def tearDown(self):
        self._kv_get_p.stop()
        self._kv_set_p.stop()
        auth_engine.AUTH_DB_PATH = self._orig_db
        auth_engine._AUTH_DB_SCHEMA_READY = self._orig_ready
        self._tmp.cleanup()

    def test_01_voice_note_upload_and_ios_range_streaming(self):
        wav = _make_wav_bytes(12000)
        b64 = base64.b64encode(wav).decode("ascii")
        up = self.client.post(
            "/api/rave/voice-note",
            json={"dataUrl": f"data:audio/wav;base64,{b64}", "duration": 2.0, "peaks": [0.4, 0.8, 0.6, 0.5]},
        )
        self.assertEqual(up.status_code, 200, up.text)
        an = up.json()["audioNote"]
        self.assertTrue(an["url"].startswith("/api/rave/voice-note/"))
        self.assertEqual(an["mime"], "audio/wav")

        full_r = self.client.get(an["url"])
        self.assertEqual(full_r.status_code, 200)
        self.assertEqual(full_r.headers.get("accept-ranges"), "bytes")
        self.assertEqual(full_r.content, wav)

        range_r = self.client.get(an["url"], headers={"Range": "bytes=0-15"})
        self.assertEqual(range_r.status_code, 206)
        self.assertEqual(len(range_r.content), 16)
        self.assertEqual(range_r.content, wav[:16])
        self.assertIn(f"bytes 0-15/{len(wav)}", range_r.headers.get("content-range", ""))

        mp4_fake = b"\x00\x00\x00\x18ftypmp42" + (b"\xaa" * 128)
        up_mp4 = self.client.post(
            "/api/rave/voice-note",
            json={"dataUrl": "data:video/mp4;base64," + base64.b64encode(mp4_fake).decode("ascii"), "duration": 1.4},
        )
        self.assertEqual(up_mp4.status_code, 200)
        self.assertEqual(up_mp4.json()["audioNote"]["mime"], "audio/mp4")

    def test_02_large_room_voice_note_survives_sync_token_and_peer_sync(self):
        wav = _make_wav_bytes(16000)
        b64 = base64.b64encode(wav).decode("ascii")
        cr = self.client.post("/api/rooms/create", json={"name": "Voice Room", "creator": "PeerA"}).json()["room"]
        rid = cr["id"]
        init_a = self.client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "clientId": "peerA", "username": "PeerA"}).json()
        self.client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "clientId": "peerB", "username": "PeerB"})

        chat_r = self.client.post(
            f"/api/rooms/{rid}/sync",
            json={
                "type": "chat",
                "clientId": "peerA",
                "clientToken": init_a["clientToken"],
                "username": "PeerA",
                "text": "",
                "audioNote": {"dataUrl": f"data:audio/wav;base64,{b64}", "duration": 2.6, "peaks": [0.5, 0.9, 0.7, 0.4]},
            },
        )
        self.assertEqual(chat_r.status_code, 200)
        tok = chat_r.json()["room"].get("syncToken", "")
        self.assertTrue(tok)

        cold_room = merge_room = rooms.merge_sync_token(None, tok, rid)
        self.assertIsNotNone(merge_room)
        vn_msgs = [m for m in cold_room["chat"] if m.get("audioNote")]
        self.assertEqual(len(vn_msgs), 1)
        self.assertTrue(vn_msgs[0]["audioNote"]["url"].startswith("/api/rave/voice-note/"))
        stream_r = self.client.get(vn_msgs[0]["audioNote"]["url"])
        self.assertEqual(stream_r.status_code, 200)
        self.assertEqual(stream_r.content, wav)

    def test_03_webrtc_signaling_and_live_https_voice_relay(self):
        cr = self.client.post("/api/rooms/create", json={"name": "Live Call", "creator": "PeerA"}).json()["room"]
        rid = cr["id"]
        r_a = self.client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "clientId": "peerA", "username": "PeerA"}).json()
        r_b = self.client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "clientId": "peerB", "username": "PeerB"}).json()
        rev_before = r_b["room"]["rev"]

        sig_r = self.client.post(
            f"/api/rooms/{rid}/sync",
            json={
                "type": "batch",
                "clientId": "peerA",
                "clientToken": r_a["clientToken"],
                "items": [
                    {"type": "voice_state", "inCall": True, "muted": False},
                    {"type": "webrtc_offer", "targetId": "peerB", "sdp": {"type": "offer", "sdp": "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"}},
                ],
            },
        )
        self.assertEqual(sig_r.status_code, 200)
        poll_b = self.client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "poll", "clientId": "peerB", "clientToken": r_b["clientToken"], "sinceRev": rev_before},
        ).json()
        self.assertGreater(poll_b["room"]["rev"], rev_before)
        all_sigs = poll_b.get("signals") or poll_b["room"].get("signals") or []
        offers = [s for s in all_sigs if s.get("type") == "webrtc_offer" and s.get("fromId") == "peerA"]
        self.assertEqual(len(offers), 1)

        wav_chunk = _make_wav_bytes(3200, rate=8000)
        post_rel = self.client.post(
            f"/api/rave/voice-relay/{rid}",
            json={"clientId": "peerA", "clientToken": r_a["clientToken"], "seq": 7, "mime": "audio/wav", "b64": base64.b64encode(wav_chunk).decode("ascii")},
        )
        self.assertEqual(post_rel.status_code, 200)

        get_self = self.client.get(
            f"/api/rave/voice-relay/{rid}",
            params={"clientId": "peerA", "clientToken": r_a["clientToken"], "sinceTs": 0},
        ).json()
        self.assertEqual(len(get_self["packets"]), 0)

        get_peer = self.client.get(
            f"/api/rave/voice-relay/{rid}",
            params={"clientId": "peerB", "clientToken": r_b["clientToken"], "sinceTs": 0},
        ).json()
        self.assertEqual(len(get_peer["packets"]), 1)
        self.assertEqual(get_peer["packets"][0]["seq"], 7)

    def test_04_ui_voice_controls_and_cache_version_sync(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        chat_js = (root / "static/js/views/chat.js").read_text(encoding="utf-8")
        sel_js = (root / "static/js/views/selection.js").read_text(encoding="utf-8")
        prof_js = (root / "static/js/profile.js").read_text(encoding="utf-8")
        mesh_css = (root / "static/css/mesh.css").read_text(encoding="utf-8")
        self.assertIn("btn-discord-head-mic", chat_js)
        self.assertIn("startUniversalVoiceRecorder", chat_js)
        self.assertIn("buildUniversalAudioNotePlayer", chat_js)
        self.assertIn("createVoiceSearchButton", sel_js)
        self.assertIn("autocall=1", prof_js)
        self.assertIn(".wl-voice-search-btn", mesh_css)

    def test_05_dm_voice_note_and_voice_call_invite(self):
        auth_engine._REGISTER_LIMIT._hits.clear()
        auth_engine._LOGIN_LIMIT._hits.clear()
        ra = self.client.post("/api/auth/register", json={"email": "a_vn@wl.test", "handle": "avn", "name": "Ali", "password": "StrongPassword!123"}).json()
        rb = self.client.post("/api/auth/register", json={"email": "b_vn@wl.test", "handle": "bvn", "name": "Buse", "password": "StrongPassword!123"}).json()
        uid_a, hdr_a = ra["user"]["uid"], {"Authorization": f"Bearer {ra['authToken']}"}
        uid_b, hdr_b = rb["user"]["uid"], {"Authorization": f"Bearer {rb['authToken']}"}

        # Mutual friends
        self.client.post("/api/rave/social/friends", headers=hdr_a, json={"uid": uid_a, "action": "request", "targetUid": uid_b})
        self.client.post("/api/rave/social/friends", headers=hdr_b, json={"uid": uid_b, "action": "accept", "targetUid": uid_a})

        wav = _make_wav_bytes(16000)  # >32KB raw so dataUrl is stripped from DM JSON while url stays playable
        b64 = base64.b64encode(wav).decode("ascii")
        dm_r = self.client.post(
            "/api/rave/social/dm",
            headers=hdr_a,
            json={"uid": uid_a, "peerId": uid_b, "text": "", "audioNote": {"dataUrl": f"data:audio/wav;base64,{b64}", "duration": 2.4}},
        )
        self.assertEqual(dm_r.status_code, 200, dm_r.text)
        msgs = self.client.get("/api/rave/social/dm", headers=hdr_b, params={"uid": uid_b, "peerId": uid_a}).json()["messages"]
        self.assertEqual(len(msgs), 1)
        self.assertTrue(msgs[0]["audioNote"]["url"].startswith("/api/rave/voice-note/"))
        self.assertEqual(self.client.get(msgs[0]["audioNote"]["url"]).content, wav)

    def test_06_v97_adversarial_voice_range_privacy_and_apk_ota(self):
        # 1. Malformed JSON primitives/lists on voice-note & voice-relay -> 400 (never 500)
        for bad_payload in (["bad"], "bad_str", {}):
            r_vn = self.client.post("/api/rave/voice-note", json=bad_payload)
            self.assertEqual(r_vn.status_code, 400, r_vn.text)
            r_vr = self.client.post("/api/rave/voice-relay/qatestroom", json=bad_payload)
            self.assertEqual(r_vr.status_code, 400, r_vr.text)

        # 2. Invalid HTTP Range requests on voice-note -> 416 Range Not Satisfiable
        wav = _make_wav_bytes(4000)
        b64 = base64.b64encode(wav).decode("ascii")
        up = self.client.post("/api/rave/voice-note", json={"dataUrl": f"data:audio/wav;base64,{b64}", "duration": 1.2}).json()["audioNote"]
        for bad_rng in ("bytes=999999-1000000", "bytes=50-10", "bytes=-"):
            rr = self.client.get(up["url"], headers={"Range": bad_rng})
            self.assertEqual(rr.status_code, 416, bad_rng)
            self.assertIn(f"bytes */{len(wav)}", rr.headers.get("content-range", ""))

        # 3. Outsider clientId rejected on voice-relay (403)
        cr_resp = self.client.post("/api/rooms/create", json={"name": "Priv Audit", "creator": "HostG"}).json()
        rid = cr_resp["room"]["id"]
        init_h = self.client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "init", "clientId": cr_resp["clientId"], "clientToken": cr_resp["clientToken"], "username": "HostG", "isCreator": True},
        ).json()
        outsider_rel = self.client.post(
            f"/api/rave/voice-relay/{rid}",
            json={"clientId": "intruderCid", "seq": 1, "mime": "audio/wav", "b64": b64},
        )
        self.assertEqual(outsider_rel.status_code, 403)

        # 4. Guest 'friends' & 'private' rooms stay isolated from anonymous /api/rooms + no-store header
        for p_mode in ("friends", "private"):
            act_r = self.client.post(
                f"/api/rooms/{rid}/sync",
                json={"type": "host_action", "clientId": init_h["clientId"], "clientToken": init_h["clientToken"], "action": "set_privacy", "privacy": p_mode},
            ).json()
            self.assertEqual(act_r["room"]["privacy"], p_mode)
            lobby_r = self.client.get("/api/rooms")
            self.assertIn("no-store", lobby_r.headers.get("cache-control", ""))
            ids = [x["id"] for x in lobby_r.json().get("rooms", [])]
            self.assertNotIn(rid, ids, f"Room leaked in {p_mode} mode")

        # 5. chat.js teardown free of undeclared activeVoiceAudio & APK v2.0.2 OTA integrity
        root = pathlib.Path(__file__).resolve().parent.parent
        chat_js = (root / "static/js/views/chat.js").read_text(encoding="utf-8")
        self.assertNotIn("activeVoiceAudio", chat_js)
        self.assertIn("stopActiveVoiceNoteGlobal", chat_js)

        ver_r = self.client.get("/api/app/version")
        self.assertEqual(ver_r.status_code, 200)
        vj = ver_r.json()
        self.assertGreaterEqual(int(vj["versionCode"]), 22)
        apk_r = self.client.get("/download/apk")
        self.assertEqual(apk_r.status_code, 200)
        self.assertEqual(apk_r.content[:4], b"PK\x03\x04")


