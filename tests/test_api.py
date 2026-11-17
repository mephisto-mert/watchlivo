"""API smoke tests for the rebuilt VORTEX server (run against http://localhost:8765)."""
import json
import sys
import urllib.error
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
results = []


def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method or ("POST" if data else "GET"), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))


def test_api_smoke_inprocess():
    """Run core API smoke checks in-process via Starlette TestClient under pytest."""
    import os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from starlette.testclient import TestClient
    import server
    client = TestClient(server.app)
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json().get("ok") is True
    r_bad = client.post("/api/rooms/BAD..id/sync", json={"type": "init"})
    assert r_bad.status_code == 400


def test_rave_3_approved_features():
    """Verify the 3 Rave.io parity features (Camera Bubbles + RMS, Push Notifications, PiP + LockScreen)."""
    import os
    import pathlib
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from starlette.testclient import TestClient
    import server
    client = TestClient(server.app)

    # 1. Service Worker & Push Notification Endpoints
    r_sw = client.get("/sw.js")
    assert r_sw.status_code == 200
    assert "WATCHLIVO_SHOW_NOTIFICATION" in r_sw.text
    assert "showNotification" in r_sw.text

    r_sub = client.post("/api/rave/notifications/subscribe", json={"uid": "u_test_1", "name": "TestUser", "subscription": {"granted": True}})
    assert r_sub.status_code == 200 and r_sub.json().get("ok") is True

    r_send = client.post("/api/rave/notifications/send", json={
        "fromUid": "u_host_1",
        "fromName": "Mert Can",
        "roomId": "test-room-123",
        "roomTitle": "Örümcek Adam: Örümcek Evrenine Geçiş",
        "targetUid": "u_test_1",
    })
    assert r_send.status_code == 200 and r_send.json().get("ok") is True

    r_poll = client.get("/api/rave/notifications/poll?uid=u_test_1&since=0")
    assert r_poll.status_code == 200
    notifs = r_poll.json().get("notifications", [])
    assert any(n.get("roomId") == "test-room-123" for n in notifs)

    # 2. Verify Camera Bubbles & PiP & Lock-Screen MediaSession in static bundle
    base = pathlib.Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / "static"
    voice_js = (base / "js" / "voice.js").read_text(encoding="utf-8")
    assert "--voice-scale" in voice_js and "shape-btn" not in voice_js
    chat_js = (base / "js" / "views" / "chat.js").read_text(encoding="utf-8")
    assert "btn-discord-head-cam" in chat_js
    controls_js = (base / "js" / "views" / "controls.js").read_text(encoding="utf-8")
    assert "ctl-pip" in controls_js and "togglePiP" in controls_js
    html5_js = (base / "js" / "players" / "html5.js").read_text(encoding="utf-8")
    assert "requestPictureInPicture" in html5_js and "wakeLock" in html5_js


if __name__ == "__main__":
    s, r = call("/api/health")
    check("health", s == 200 and r.get("ok"), json.dumps(r))
    s, r = call("/api/rave/supersearch?q=dune")
    s, r = call("/api/rave/catalog?provider=netflix")
    check("netflix web catalog returns titles", s == 200 and len(r.get("items", [])) >= 6, f"{len(r.get('items', []))} items")
    s, r = call("/api/rave/resolve-catalog?provider=netflix&title=Stranger%20Things&tmdbId=66732&year=2016&mediaType=tv&season=1&episode=1")
    check("resolve-catalog resolves playable stream", s == 200 and (r.get("url") or r.get("videoId")) and int(r.get("duration") or 0) >= 1200, f"url={str(r.get('url'))[:45]} dur={r.get('duration')}")
    s, r = call("/api/rave/extract-video?url=http://127.0.0.1:8765/api/health")
    check("extract-video blocks SSRF to loopback", s == 422, f"{s} {r}")
    s, r = call("/api/rave/oembed?url=https://vimeo.com/22439234")
    check("vimeo oembed", s == 200 and r.get("title"), r.get("title", ""))
    s, r = call("/api/rooms/create", {"name": "Test Odası", "creator": "Tester",
    room = r.get("room", {})
    check("create room with media", s == 200 and room.get("media", {}).get("videoId") == "dQw4w9WgXcQ", room.get("id", ""))
    rid = room.get("id", "x")
    TOKENS = {}

    def sync(cid, **payload):
        """Act as ``cid`` using the server-signed clientToken (never a bare id)."""
        body = {"clientId": cid, "clientToken": TOKENS.get(cid, ""), **payload}
        status, data = call(f"/api/rooms/{rid}/sync", body)
        if data.get("clientToken"):
            TOKENS[cid] = data["clientToken"]
        return status, data

    s, a = sync("hA", type="init", username="Ayşe", color="#ff0000")
    check("http join → host", s == 200 and a["room"]["host_id"] == "hA")
    check("join returns a signed clientToken", bool(TOKENS.get("hA")))
    s, b = sync("hB", type="init", username="Berk")
    check("second joiner not host", b["room"]["host_id"] == "hA" and len(b["room"]["participants"]) == 2)
    s, b = sync("hB", type="seek", currentTime=99)
    check("non-leader seek rejected", b["room"]["media"]["meshStatePosition"] != 99 and b.get("errors"), str(b.get("errors")))
    s, a = sync("hA", type="seek", currentTime=42)
    check("leader seek applied", abs(a["room"]["media"]["meshStatePosition"] - 42) < 0.01, str(a.get("errors")))
    s, b = sync("hB", type="pause", currentTime=43)
    check("leader-choice blocks non-leader pause", b["room"]["media"]["meshStateStatus"] != "PAUSED" and b.get("errors"))
    check("leader-choice blocks non-leader pick", b["room"]["media"]["videoId"] == "dQw4w9WgXcQ")
    s, a = sync("hA", type="host_action", action="set_privacy", playMode="vote", privacy="friends")
    check("leader changes play mode + privacy", a["room"]["playMode"] == "vote" and a["room"]["privacy"] == "friends", str(a.get("errors")))
    check("vote mode: pick goes to queue", len(b["room"]["queue"]) == 1 and b["room"]["queue"][0]["votes"] == ["Berk"], str(b.get("errors")))
    s, b = sync("hB", type="chat", text="<script>alert(1)</script> merhaba")
    last = b["room"]["chat"][-1]
    check("chat stored as plain text", last["text"].startswith("<script>") and last["user"] == "Berk")
    s, b = sync("hB", type="chat", gif="https://evil.example/x.gif")
    check("gif host allow-list", b["room"]["chat"][-1].get("gif", "") == "")
    s, a = sync("hA", type="host_action", action="set_privacy", playMode="vote", privacy="public")
    s, l = call("/api/rooms")
    check("lobby lists active room", any(x["id"] == rid and x["count"] == 2 for x in l.get("rooms", [])),
          str([(x["id"], x["count"]) for x in l.get("rooms", []) if x["id"] == rid]))
    s, r = call("/api/rooms/BAD..id/sync", {"type": "init"})
    check("invalid room id rejected", s == 400)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
