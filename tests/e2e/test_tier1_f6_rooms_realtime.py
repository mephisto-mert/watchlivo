from __future__ import annotations

import uuid

import httpx
from playwright.sync_api import Page
import pytest

from helpers import to_ws_url, wait_for_home_boot, ws_connect_init

pytestmark = [pytest.mark.tier1]


def _create_test_room(api_client: httpx.Client, name: str = "E2E Oda", privacy: str = "public") -> dict:
    resp = api_client.post(
        "/api/rooms/create",
        json={
            "name": name,
            "creator": "E2EHost",
            "privacy": privacy,
            "playMode": "leader",
            "media": {
                "provider": "mp4",
                "streamType": "mp4",
                "title": "Test Video",
                "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
            },
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    return data


def test_t1_f6_01_room_create_and_initial_host_sync(api_client: httpx.Client) -> None:
    """T1-F6-01: Room create & initial host sync."""
    created = _create_test_room(api_client, name="E2E Create Test")
    room = created["room"]
    rid = room["id"]
    assert rid.startswith("wl-")
    assert room["privacy"] == "public"
    assert room["isHost"] is True
    assert room["isCreator"] is True
    assert room["syncToken"]

    sync = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={
            "type": "init",
            "clientId": created["clientId"],
            "clientToken": created["clientToken"],
            "username": "E2EHost",
        },
    )
    assert sync.status_code == 200, sync.text
    s_room = sync.json()["room"]
    assert s_room["id"] == rid
    assert int(s_room.get("participantCount") or 0) >= 1

    # Cleanup
    api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "close_room", "clientId": created["clientId"], "clientToken": created["clientToken"]},
    )


def test_t1_f6_02_room_chat_and_reaction_persistence(api_client: httpx.Client) -> None:
    """T1-F6-02: Room chat message & msg_react persistence."""
    created = _create_test_room(api_client, name="E2E Chat Test")
    rid = created["room"]["id"]
    cid = created["clientId"]
    ctok = created["clientToken"]
    cmsg_id = f"m_{uuid.uuid4().hex[:8]}"

    chat_resp = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={
            "type": "chat",
            "clientId": cid,
            "clientToken": ctok,
            "username": "E2EHost",
            "text": "Merhaba E2E",
            "clientMsgId": cmsg_id,
        },
    )
    assert chat_resp.status_code == 200, chat_resp.text
    msgs = chat_resp.json()["room"]["chat"]
    target_msg = next((m for m in msgs if m.get("text") == "Merhaba E2E"), None)
    assert target_msg is not None

    react_resp = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={
            "type": "msg_react",
            "clientId": cid,
            "clientToken": ctok,
            "msgId": target_msg["id"],
            "emoji": "🔥",
        },
    )
    assert react_resp.status_code == 200, react_resp.text
    updated_msg = next((m for m in react_resp.json()["room"]["chat"] if m["id"] == target_msg["id"]), None)
    assert updated_msg and updated_msg.get("reactions", {}).get("🔥")

    api_client.post(f"/api/rooms/{rid}/sync", json={"type": "close_room", "clientId": cid, "clientToken": ctok})


def test_t1_f6_03_playback_state_sync(api_client: httpx.Client) -> None:
    """T1-F6-03: Playback pause, seek, rate, and heartbeat state sync."""
    created = _create_test_room(api_client, name="E2E Playback Sync")
    rid = created["room"]["id"]
    cid = created["clientId"]
    ctok = created["clientToken"]

    pause_r = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "pause", "clientId": cid, "clientToken": ctok, "currentTime": 10},
    )
    assert pause_r.status_code == 200
    p_media = pause_r.json()["room"]["media"]
    assert p_media.get("playing") is False
    assert p_media.get("meshStateStatus") == "PAUSED"

    seek_r = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "seek", "clientId": cid, "clientToken": ctok, "currentTime": 42},
    )
    assert seek_r.status_code == 200
    assert float(seek_r.json()["room"]["media"]["currentTime"]) == 42.0

    rate_r = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "rate", "clientId": cid, "clientToken": ctok, "rate": 1.5},
    )
    assert rate_r.status_code == 200
    assert float(rate_r.json()["room"]["media"]["rate"]) == 1.5

    hb_r = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "heartbeat", "clientId": cid, "clientToken": ctok, "currentTime": 42},
    )
    assert hb_r.status_code == 200

    api_client.post(f"/api/rooms/{rid}/sync", json={"type": "close_room", "clientId": cid, "clientToken": ctok})


def test_t1_f6_04_websocket_room_connect_and_ping_pong(api_client: httpx.Client, base_url: str) -> None:
    """T1-F6-04: WebSocket /ws/:id connects, receives init frame, and answers ping with pong."""
    created = _create_test_room(api_client, name="E2E WS Room")
    rid = created["room"]["id"]
    cid = created["clientId"]
    ctok = created["clientToken"]

    ws_url = to_ws_url(base_url, f"/ws/{rid}?username=WSGuest")
    init_pkt, pong_pkt = ws_connect_init(ws_url, origin=base_url)
    assert init_pkt.get("type") == "init"
    assert init_pkt.get("clientId")
    assert init_pkt.get("clientToken")
    assert (init_pkt.get("room") or {}).get("id") == rid
    assert pong_pkt is not None and pong_pkt.get("type") == "pong"

    api_client.post(f"/api/rooms/{rid}/sync", json={"type": "close_room", "clientId": cid, "clientToken": ctok})


@pytest.mark.expects_m3
def test_t1_f6_05_deeplink_room_with_unresolved_catalog_url(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T1-F6-05: Deep-link #/mesh/:id with /api/rave/resolve-catalog media sends X-Watchlivo-Token (no 403)."""
    resp = api_client.post(
        "/api/rooms/create",
        json={
            "name": "Dune DeepLink E2E",
            "creator": "E2EHost",
            "privacy": "public",
            "media": {
                "provider": "cinema",
                "title": "Dune: Part Two",
                "tmdbId": "693134",
                "mediaType": "movie",
                "url": "/api/rave/resolve-catalog?provider=cinema&tmdbId=693134&title=Dune%3A%20Part%20Two&mediaType=movie",
            },
        },
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    rid = created["room"]["id"]

    resolve_statuses: list[int] = []
    seen_token_hdrs: list[str] = []

    def on_req(req) -> None:
        if "/api/rave/resolve-catalog" in req.url:
            seen_token_hdrs.append(req.headers.get("x-watchlivo-token", ""))

    def on_resp(r) -> None:
        if "/api/rave/resolve-catalog" in r.url:
            resolve_statuses.append(r.status)

    page_session.on("request", on_req)
    page_session.on("response", on_resp)
    try:
        page_session.goto(f"{base_url}/#/mesh/{rid}", wait_until="domcontentloaded")
        page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=15000)
        page_session.wait_for_function(
            """() => {
                const v = document.querySelector('#video-frame .player-host > video');
                return v && ((v.currentSrc || v.src) || '').length > 0;
            }""",
            timeout=20000,
        )
        assert any(s == 200 for s in resolve_statuses), f"Expected 200 on resolve-catalog, got {resolve_statuses}"
        assert all(s != 403 for s in resolve_statuses), f"Got 403 on resolve-catalog: {resolve_statuses}"
        assert any(bool(t) for t in seen_token_hdrs), "X-Watchlivo-Token was not attached!"
    finally:
        api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "close_room", "clientId": created["clientId"], "clientToken": created["clientToken"]},
        )


def test_t1_f6_06_room_close_and_post_close_410(api_client: httpx.Client) -> None:
    """T1-F6-06: close_room returns 200 roomClosed:true, subsequent sync returns 410, room removed from /api/rooms."""
    created = _create_test_room(api_client, name="E2E Close Room")
    rid = created["room"]["id"]
    cid = created["clientId"]
    ctok = created["clientToken"]

    close_r = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "close_room", "clientId": cid, "clientToken": ctok},
    )
    assert close_r.status_code == 200, close_r.text
    assert close_r.json().get("roomClosed") is True

    after_r = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "poll", "clientId": cid, "clientToken": ctok},
    )
    assert after_r.status_code == 410
    assert after_r.json().get("roomClosed") is True

    rooms = api_client.get("/api/rooms").json().get("rooms") or []
    assert not any(r.get("id") == rid for r in rooms)


def test_t1_f6_07_second_participant_and_leader_permissions(api_client: httpx.Client) -> None:
    """T1-F6-07: Guest B in leader mode gets 403 on pause/change_media; host promotes/kicks B (410)."""
    created = _create_test_room(api_client, name="E2E Leader Perms")
    rid = created["room"]["id"]
    host_cid = created["clientId"]
    host_tok = created["clientToken"]

    join_b = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "init", "clientId": "guest_b_e2e", "username": "GuestB"},
    )
    assert join_b.status_code == 200, join_b.text
    b_cid = join_b.json()["clientId"]
    b_tok = join_b.json()["clientToken"]

    b_pause = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "pause", "clientId": b_cid, "clientToken": b_tok, "currentTime": 5},
    )
    assert b_pause.status_code == 403

    b_media = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={
            "type": "change_media",
            "clientId": b_cid,
            "clientToken": b_tok,
            "media": {"title": "Hijack", "url": "https://example.com/a.mp4"},
        },
    )
    assert b_media.status_code == 403

    promote_b = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "host_action", "action": "promote", "targetId": b_cid, "clientId": host_cid, "clientToken": host_tok},
    )
    assert promote_b.status_code == 200

    kick_b = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "host_action", "action": "kick", "targetId": b_cid, "clientId": host_cid, "clientToken": host_tok},
    )
    assert kick_b.status_code == 200

    b_after_kick = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "poll", "clientId": b_cid, "clientToken": b_tok},
    )
    assert b_after_kick.status_code == 410

    api_client.post(f"/api/rooms/{rid}/sync", json={"type": "close_room", "clientId": host_cid, "clientToken": host_tok})
