from __future__ import annotations

import uuid

import httpx
import pytest

from helpers import browser_headers, fetch_edge_token

pytestmark = [pytest.mark.py_parity]


@pytest.fixture(scope="session")
def py_client(py_base_url: str) -> httpx.Client:
    with httpx.Client(
        base_url=py_base_url,
        follow_redirects=False,
        timeout=25.0,
        headers=browser_headers(py_base_url),
    ) as client:
        yield client


def test_p01_health_parity(api_client: httpx.Client, py_client: httpx.Client) -> None:
    """P-01: /api/health returns 200 ok:true and activeRooms >= 0 on both origins."""
    er = api_client.get("/api/health")
    pr = py_client.get("/api/health")
    assert er.status_code == 200 and pr.status_code == 200
    assert er.json().get("ok") is True and pr.json().get("ok") is True
    assert int(er.json().get("activeRooms", -1)) >= 0
    assert int(pr.json().get("activeRooms", -1)) >= 0


def test_p02_social_guest_parity(api_client: httpx.Client, py_client: httpx.Client) -> None:
    """P-02: POST /api/rave/social/guest parity."""
    er = api_client.post("/api/rave/social/guest", json={"name": "ParityGuest"})
    pr = py_client.post("/api/rave/social/guest", json={"name": "ParityGuest"})
    assert pr.status_code == 200, pr.text
    assert er.status_code == 200, f"Edge social/guest failed: {er.status_code} {er.text}"
    for data in (er.json(), pr.json()):
        assert data.get("ok") is True
        assert data.get("uid") and data.get("handle") and data.get("guestToken")
        assert isinstance(data.get("user"), dict)


def test_p03_notifications_poll_parity(api_client: httpx.Client, py_client: httpx.Client) -> None:
    """P-03: GET /api/rave/notifications/poll parity."""
    params = {"uid": "guest_parity1", "name": "Parity", "since": "0"}
    pr = py_client.get("/api/rave/notifications/poll", params=params)
    er = api_client.get("/api/rave/notifications/poll", params=params)
    assert pr.status_code == 200, pr.text
    assert er.status_code == 200, f"Edge notifications/poll failed: {er.status_code} {er.text}"
    for data in (er.json(), pr.json()):
        assert data.get("ok") is True
        assert isinstance(data.get("notifications"), list)
        assert "requestCount" in data and "totalUnread" in data and "serverTs" in data


def test_p04_ga_collect_parity(api_client: httpx.Client, py_client: httpx.Client) -> None:
    """P-04: POST /api/rave/ga-collect/g/collect returns 204 on both origins."""
    params = {"v": "2", "tid": "G-HQXSREQV3R", "en": "page_view"}
    pr = py_client.post("/api/rave/ga-collect/g/collect", params=params, content=b"")
    er = api_client.post("/api/rave/ga-collect/g/collect", params=params, content=b"")
    assert pr.status_code == 204
    assert er.status_code == 204, f"Edge ga-collect returned {er.status_code}"


def test_p05_supersearch_and_seasons_parity(api_client: httpx.Client, py_client: httpx.Client) -> None:
    """P-05: supersearch Resident Evil & seasons 108296 (8 episodes) parity."""
    for client, label in ((py_client, "python"), (api_client, "edge")):
        sr = client.get("/api/rave/supersearch", params={"q": "Resident Evil"})
        assert sr.status_code == 200, f"{label} supersearch: {sr.status_code}"
        sr_j = sr.json()
        hits = sr_j.get("items") or sr_j.get("justwatch") or sr_j.get("tmdb") or []
        assert len(hits) >= 1, f"{label} supersearch empty: {sr_j}"

        sea = client.get("/api/rave/seasons", params={"tmdbId": "108296", "mediaType": "tv", "season": "1"})
        assert sea.status_code == 200, f"{label} seasons: {sea.status_code}"
        assert len(sea.json().get("episodes") or []) == 8


def test_p06_resolve_catalog_resident_evil_s1e3_parity(
    api_client: httpx.Client,
    py_client: httpx.Client,
    base_url: str,
) -> None:
    """P-06: Resident Evil (108296) S1E3 resolve-catalog parity across Python and Edge."""
    params = {
        "provider": "cinema",
        "tmdbId": "108296",
        "title": "Resident Evil",
        "mediaType": "tv",
        "season": "1",
        "episode": "3",
    }
    tok = fetch_edge_token(api_client, base_url)
    pr = py_client.get("/api/rave/resolve-catalog", params=params, timeout=35.0)
    er = api_client.get(
        "/api/rave/resolve-catalog",
        params=params,
        headers={"X-Watchlivo-Token": tok},
        timeout=35.0,
    )
    assert pr.status_code == 200, f"Python resolve failed: {pr.status_code} {pr.text}"
    assert er.status_code == 200, f"Edge resolve failed: {er.status_code} {er.text}"
    assert pr.json().get("url") and er.json().get("url")


def test_p07_rooms_create_info_sync_and_curated_parity(
    api_client: httpx.Client,
    py_client: httpx.Client,
) -> None:
    """P-07: Rooms create/get/sync & curated rooms tv-trt1/tv-atv parity."""
    for client, label in ((py_client, "python"), (api_client, "edge")):
        lst = client.get("/api/rooms")
        assert lst.status_code == 200
        ids = {r.get("id") for r in lst.json().get("rooms", [])}
        assert {"tv-trt1", "tv-atv"}.issubset(ids), f"{label} missing curated rooms"

        cr = client.post("/api/rooms/create", json={"name": f"Parity {label}", "creator": "Parity"})
        assert cr.status_code == 200, cr.text
        rid = cr.json()["room"]["id"]
        info = client.get(f"/api/rooms/{rid}")
        assert info.status_code == 200, f"{label} GET /api/rooms/{rid} returned {info.status_code}"
        sync = client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "init", "clientId": cr.json()["clientId"], "clientToken": cr.json()["clientToken"]},
        )
        assert sync.status_code == 200
        client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "close_room", "clientId": cr.json()["clientId"], "clientToken": cr.json()["clientToken"]},
        )


def test_p08_auth_register_me_profile_parity(api_client: httpx.Client, py_client: httpx.Client) -> None:
    """P-08: Auth register -> me -> profile parity (user.handle present)."""
    for client, label in ((py_client, "python"), (api_client, "edge")):
        uniq = uuid.uuid4().hex[:8]
        reg = client.post(
            "/api/auth/register",
            json={"email": f"par_{label}_{uniq}@example.com", "password": "ParityPass123!", "name": f"Par{uniq}"},
        )
        assert reg.status_code == 200, f"{label} register: {reg.status_code} {reg.text}"
        reg_j = reg.json()
        assert (reg_j.get("user") or {}).get("handle"), f"{label} missing user.handle"
        tok = reg_j["authToken"]
        hdrs = {"Authorization": f"Bearer {tok}"}

        me = client.get("/api/auth/me", headers=hdrs)
        assert me.status_code == 200 and me.json().get("authenticated") is True

        prof = client.post("/api/auth/profile", headers=hdrs, json={"name": f"Updated{uniq}"})
        assert prof.status_code == 200, f"{label} profile: {prof.status_code} {prof.text}"
