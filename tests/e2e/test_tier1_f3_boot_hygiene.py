from __future__ import annotations

import re

import httpx
from playwright.sync_api import Page
import pytest

from helpers import extract_meta_edge_token, wait_for_home_boot

pytestmark = [pytest.mark.tier1]


def test_t1_f3_01_spa_boot_html_csp_and_edge_token(api_client: httpx.Client) -> None:
    """T1-F3-01: SPA boot HTML includes CSP nonce, edge token meta, and autonomous edge header."""
    resp = api_client.get("/")
    assert resp.status_code == 200
    assert "text/html" in (resp.headers.get("content-type") or "").lower()
    assert resp.headers.get("x-watchlivo-origin") == "cf-autonomous-edge"
    token = extract_meta_edge_token(resp.text)
    assert len(token) > 20, "Missing or empty wl-edge-token meta"
    inline_scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", resp.text, re.I)
    assert inline_scripts, "Expected inline bootstrap script tags"
    for tag in inline_scripts:
        assert "nonce=" in tag.lower(), f"Inline script missing nonce: {tag}"


@pytest.mark.expects_m2
def test_t1_f3_02_social_guest_provisioning(api_client: httpx.Client) -> None:
    """T1-F3-02: Guest session provisioning POST /api/rave/social/guest."""
    resp = api_client.post("/api/rave/social/guest", json={"name": "E2E Misafir"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    assert data.get("isGuest") is True
    assert data.get("uid")
    assert data.get("handle")
    assert data.get("guestToken")
    user = data.get("user") or {}
    assert user.get("uid") == data.get("uid")


@pytest.mark.expects_m2
def test_t1_f3_03_notifications_poll(api_client: httpx.Client) -> None:
    """T1-F3-03: Background notifications poll GET /api/rave/notifications/poll."""
    resp = api_client.get(
        "/api/rave/notifications/poll",
        params={"uid": "guest_e2e1", "name": "Test", "since": "0"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    assert isinstance(data.get("notifications"), list)
    assert isinstance(data.get("requestCount"), int)
    assert isinstance(data.get("totalUnread"), int)
    assert isinstance(data.get("serverTs"), (int, float))


@pytest.mark.expects_m2
def test_t1_f3_04_notifications_subscribe_and_send(api_client: httpx.Client) -> None:
    """T1-F3-04: Notifications subscribe & send do not 404 on edge."""
    sub_resp = api_client.post(
        "/api/rave/notifications/subscribe",
        json={"uid": "guest_e2e1", "name": "Test"},
    )
    assert sub_resp.status_code == 200, sub_resp.text
    assert sub_resp.json().get("ok") is True

    send_body = {
        "targetUid": "guest_e2e2",
        "fromUid": "guest_e2e1",
        "fromName": "Test",
        "roomId": "wl-test123",
        "type": "room_invite",
    }
    anon_send = api_client.post("/api/rave/notifications/send", json=send_body)
    assert anon_send.status_code == 401, anon_send.text

    guest = api_client.post("/api/rave/social/guest", json={"name": "Test"})
    assert guest.status_code == 200, guest.text
    guest_tok = guest.json().get("guestToken")
    assert guest_tok

    send_resp = api_client.post(
        "/api/rave/notifications/send",
        headers={"Authorization": f"Bearer {guest_tok}"},
        json=send_body,
    )
    assert send_resp.status_code == 200, send_resp.text
    assert send_resp.json().get("ok") is True


@pytest.mark.expects_m2
def test_t1_f3_05_ga_collect_first_party_beacon(api_client: httpx.Client) -> None:
    """T1-F3-05: GA4 first-party collect beacon never 404s."""
    resp = api_client.post(
        "/api/rave/ga-collect/g/collect",
        params={"v": "2", "tid": "G-HQXSREQV3R", "en": "page_view"},
        content=b"",
    )
    assert resp.status_code in (200, 204), f"Unexpected ga-collect status: {resp.status_code}"


def test_t1_f3_06_social_state_presence_and_analytics(api_client: httpx.Client) -> None:
    """T1-F3-06: Social state, presence, and analytics endpoints return 200 ok:true."""
    st = api_client.get("/api/rave/social/state", params={"uid": "guest_e2e1"})
    assert st.status_code == 200, st.text
    assert st.json().get("ok") is True

    pr = api_client.post(
        "/api/rave/social/presence",
        json={"uid": "guest_e2e1", "name": "E2E", "status": "online"},
    )
    assert pr.status_code == 200, pr.text
    assert pr.json().get("ok") is True

    an = api_client.post(
        "/api/rave/analytics",
        json={"event": "page_view", "path": "/"},
    )
    assert an.status_code == 200, an.text
    assert an.json().get("ok") is True


@pytest.mark.expects_m2
def test_t1_f3_07_browser_boot_six_second_network_hygiene(page_session: Page, base_url: str) -> None:
    """T1-F3-07: Full browser home boot 6-second network & console hygiene audit."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    # Wait past the 4500ms notifications poll interval
    page_session.wait_for_timeout(5500)
    page_session.hygiene.assert_clean()
