from __future__ import annotations

import httpx
from playwright.sync_api import Page
import pytest

from helpers import wait_for_home_boot

pytestmark = [pytest.mark.tier1]

EXPECTED_CURATED_IDS = {
    "tv-trt1",
    "tv-atv",
    "tv-now-tv",
    "tv-star-tv",
    "tv-trt-spor",
    "tv-a-spor",
    "tv-ntv",
    "tv-haberturk",
    "tv-halk-tv",
    "tv-trt-haber",
    "tv-cnbc-e",
    "tv-trt-belgesel",
    "radyo-power-turk",
    "radyo-kral-fm",
    "radyo-super-fm",
    "radyo-metro-fm",
    "radyo-power-fm",
    "radyo-joy-turk",
    "radyo-slow-turk",
    "radyo-best-fm",
    "radyo-alem-fm",
}


def test_t1_f5_01_curated_tv_and_radio_listing(api_client: httpx.Client) -> None:
    """T1-F5-01: /api/rooms and /api/rave/catalog?provider=livetv|radio list all 21 curated rooms."""
    rooms_resp = api_client.get("/api/rooms")
    assert rooms_resp.status_code == 200, rooms_resp.text
    rooms = rooms_resp.json().get("rooms") or []
    curated_by_id = {r["id"]: r for r in rooms if r.get("curated")}
    missing = EXPECTED_CURATED_IDS - set(curated_by_id)
    assert not missing, f"Missing curated rooms: {missing}"

    tv_cat = api_client.get("/api/rave/catalog", params={"provider": "livetv"})
    assert tv_cat.status_code == 200
    assert any(it.get("roomId") == "tv-trt1" and it.get("live") is True for it in tv_cat.json().get("items", []))

    rad_cat = api_client.get("/api/rave/catalog", params={"provider": "radio"})
    assert rad_cat.status_code == 200
    assert any(it.get("roomId") == "radyo-power-turk" and it.get("live") is True for it in rad_cat.json().get("items", []))


@pytest.mark.expects_m2
def test_t1_f5_02_trt1_and_atv_sync_active_not_410(api_client: httpx.Client) -> None:
    """T1-F5-02: TRT 1 (tv-trt1) & ATV (tv-atv) /sync stay active (no 410 roomClosed)."""
    for rid in ("tv-trt1", "tv-atv"):
        resp = api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "init", "username": "E2E"},
        )
        assert resp.status_code == 200, f"{rid} sync failed: {resp.status_code} {resp.text}"
        data = resp.json()
        assert not data.get("roomClosed")
        room = data.get("room") or {}
        assert room.get("curated") is True
        assert (room.get("media") or {}).get("url")


@pytest.mark.expects_m2
def test_t1_f5_03_curated_tv_metadata_preservation(api_client: httpx.Client) -> None:
    """T1-F5-03: Curated TV rooms preserve channel name & creator across /sync."""
    expectations = {
        "tv-now-tv": "NOW",
        "tv-star-tv": "Star TV",
        "tv-trt-spor": "TRT Spor",
    }
    for rid, expected_substr in expectations.items():
        resp = api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "init", "username": "E2E"},
        )
        assert resp.status_code == 200, f"{rid}: {resp.status_code} {resp.text}"
        room = resp.json().get("room") or {}
        assert expected_substr in (room.get("name") or ""), f"{rid} name overwritten to {room.get('name')!r}"
        assert room.get("name") != "Watchlivo Sinema Odası"
        assert room.get("creator") == "Watchlivo Canlı TV"
        assert room.get("curated") is True


@pytest.mark.expects_m2
def test_t1_f5_04_curated_radio_metadata_preservation(api_client: httpx.Client) -> None:
    """T1-F5-04: Curated radio metadata & stream preserved on /sync and /api/rooms."""
    resp = api_client.post(
        "/api/rooms/radyo-power-turk/sync",
        json={"type": "init", "username": "E2E"},
    )
    assert resp.status_code == 200, resp.text
    room = resp.json().get("room") or {}
    assert room.get("name") == "7/24 Power Türk Canlı Radyo"
    assert room.get("creator") == "Watchlivo Canlı Radyo"
    assert room.get("curated") is True
    assert (room.get("media") or {}).get("isMusic") is True

    kral = api_client.post("/api/rooms/radyo-kral-fm/sync", json={"type": "init", "username": "E2E"})
    assert kral.status_code == 200, kral.text
    assert "Kral FM" in ((kral.json().get("room") or {}).get("name") or "")

    list_resp = api_client.get("/api/rooms")
    assert list_resp.status_code == 200
    pt = next((r for r in list_resp.json().get("rooms", []) if r.get("id") == "radyo-power-turk"), None)
    assert pt and pt.get("name") == "7/24 Power Türk Canlı Radyo"


def test_t1_f5_05_curated_tv_stream_manifest_reachability(api_client: httpx.Client) -> None:
    """T1-F5-05: Wrapped /api/rave/stream URLs on curated TV rooms respond without 404/500."""
    rooms = api_client.get("/api/rooms").json().get("rooms") or []
    by_id = {r["id"]: r for r in rooms}
    for rid in ("tv-trt1", "tv-now-tv", "tv-star-tv"):
        media_url = str(((by_id.get(rid) or {}).get("media") or {}).get("url") or "")
        assert media_url, f"Missing media.url for {rid}"
        if media_url.startswith("/api/rave/stream"):
            s_resp = api_client.get(media_url, timeout=20.0)
            assert s_resp.status_code == 200, f"{rid} stream error: {s_resp.status_code} {s_resp.text[:200]}"
            assert "mpegurl" in (s_resp.headers.get("content-type") or "").lower()
            assert "#EXTM3U" in s_resp.text


@pytest.mark.expects_m2
def test_t1_f5_06_browser_curated_tv_cards_stay_in_room(page_session: Page, base_url: str) -> None:
    """T1-F5-06: Clicking TRT 1 & NOW .tv-glass-card stays in #/mesh/tv-* with channel title."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    trt_card = page_session.locator('#lobby-box .tv-glass-card[data-room="tv-trt1"]')
    trt_card.scroll_into_view_if_needed()
    trt_card.click()
    page_session.wait_for_url("**#/mesh/tv-trt1*", timeout=12000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
    page_session.wait_for_timeout(1200)
    assert "#/mesh/tv-trt1" in page_session.url
    header_txt = page_session.locator("#room-header-title").inner_text()
    assert "TRT 1" in header_txt or "TRT 1" in page_session.title()

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    now_card = page_session.locator('#lobby-box .tv-glass-card[data-room="tv-now-tv"]')
    now_card.scroll_into_view_if_needed()
    now_card.click()
    page_session.wait_for_url("**#/mesh/tv-now-tv*", timeout=12000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
    page_session.wait_for_timeout(1200)
    assert "#/mesh/tv-now-tv" in page_session.url


@pytest.mark.expects_m2
def test_t1_f5_07_room_info_and_polling_aliases(api_client: httpx.Client) -> None:
    """T1-F5-07: GET /api/rooms/:id, POST /poll, and POST /action do not 404."""
    info = api_client.get("/api/rooms/tv-now-tv")
    assert info.status_code == 200, info.text
    rm = info.json().get("room") or {}
    assert rm.get("id") == "tv-now-tv"
    assert rm.get("curated") is True

    poll = api_client.post("/api/rooms/tv-now-tv/poll", json={"sinceRev": 0, "username": "E2E"})
    assert poll.status_code == 200, poll.text

    action = api_client.post("/api/rooms/tv-now-tv/action", json={"type": "heartbeat", "username": "E2E"})
    assert action.status_code == 200, action.text
