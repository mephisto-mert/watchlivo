from __future__ import annotations

import uuid

import httpx
from playwright.sync_api import Page
import pytest

from helpers import (
    close_modal_and_wait_detached,
    leave_curated_room_and_wait_home,
    submit_home_search,
    wait_for_home_boot,
    wait_for_video_ready,
)

pytestmark = [pytest.mark.tier3]


@pytest.mark.expects_m1
@pytest.mark.expects_m3
def test_t3_01_search_tv_episode_room_create_deeplink_reload(
    page_session: Page,
    base_url: str,
) -> None:
    """T3-01: Search Resident Evil -> pick S1E3 -> create room -> reload at #/mesh/wl-*."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    submit_home_search(page_session, "Resident Evil")
    card = (
        page_session.locator("#home-selection .super-results .poster.catalog-card")
        .filter(has_text="Resident Evil")
        .filter(has_text="Dizi")
        .first
    )
    card.click()

    page_session.locator(".series-detail .episode-grid .episode-card").first.wait_for(
        state="visible", timeout=15000
    )
    ep3 = page_session.locator('.series-detail .episode-grid .episode-card:has-text("3. Bölüm")').first
    ep3.click()

    page_session.wait_for_url("**#/mesh/wl-*", timeout=25000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)
    mesh_url = page_session.url

    page_session.reload(wait_until="domcontentloaded")
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=15000)
    assert mesh_url.split("?")[0] in page_session.url
    assert "Resident Evil" in page_session.locator("#room-header-title").inner_text()
    v_info = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_info.get("readyState", 0) >= 2 and (
        v_info.get("videoWidth", 0) > 0 or v_info.get("duration", 0) > 0
    ), f"Video not decoded: {v_info}"


@pytest.mark.expects_m1
def test_t3_02_movie_resolve_stream_proxy_and_controls_refresh(
    page_session: Page,
    base_url: str,
) -> None:
    """T3-02: Inception resolve -> HLS manifest -> player controls source refresh (refresh=1)."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    submit_home_search(page_session, "Inception")
    page_session.locator("#home-selection .super-results .poster.catalog-card").first.click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=25000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)
    v_info = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_info.get("readyState", 0) >= 2 and v_info.get("videoWidth", 0) > 0, (
        f"Inception video not decoded: {v_info}"
    )

    # Open #ctl-gear -> Yayın Sunucusu (Kaynak) -> Kaynakları Canlı Yenile (refresh=1)
    page_session.locator("#video-frame").hover()
    gear_btn = page_session.locator("#ctl-gear")
    gear_btn.wait_for(state="visible", timeout=5000)
    gear_btn.click()

    srv_opt = page_session.locator('.ctl-menu .opt:has-text("Yayın Sunucusu")').first
    srv_opt.wait_for(state="visible", timeout=5000)
    srv_opt.click()

    refresh_opt = page_session.locator(
        '.ctl-menu div.opt.ctl-menu-switch-tab:has-text("Kaynakları Canlı Yenile")'
    ).first
    refresh_opt.wait_for(state="visible", timeout=5000)

    with page_session.expect_response(
        lambda r: "/api/rave/resolve-catalog" in r.url and "refresh=1" in r.url,
        timeout=20000,
    ) as refresh_info:
        refresh_opt.click()

    refresh_resp = refresh_info.value
    assert refresh_resp.status == 200, f"Controls refresh=1 failed: {refresh_resp.status}"
    assert refresh_resp.request.headers.get("x-watchlivo-token", ""), (
        "Missing X-Watchlivo-Token header on controls refresh=1 request"
    )


@pytest.mark.expects_m2
def test_t3_03_guest_boot_chat_curated_switch_and_leave(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T3-03: Guest boot -> Oda Oluştur -> chat -> leave -> tv-now-tv -> leave back to #/."""
    guest_statuses: list[int] = []
    page_session.on(
        "response",
        lambda r: guest_statuses.append(r.status) if "/api/rave/social/guest" in r.url else None,
    )
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.wait_for_timeout(1200)
    assert any(s == 200 for s in guest_statuses), f"Expected 200 social/guest, got {guest_statuses}"

    page_session.locator("#btn-create-room").click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=12000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
    rid = page_session.url.split("#/mesh/")[1].split("?")[0]

    msg = f"CrossChat_{uuid.uuid4().hex[:6]}"
    chat_in = page_session.locator("#chat-input")
    if not chat_in.is_visible():
        page_session.locator("#nav-toggle-chat").click()
    chat_in.fill(msg)
    page_session.locator("#btn-chat-send").click()
    page_session.locator(f'#chat-list .msg:has-text("{msg}")').first.wait_for(state="visible", timeout=8000)

    sync_r = api_client.post(f"/api/rooms/{rid}/sync", json={"type": "poll", "username": "Checker"})
    assert any(m.get("text") == msg for m in sync_r.json()["room"]["chat"])

    # Close room back to home
    page_session.locator("#nav-leave-room").click()
    page_session.locator('#popup-root .popup-options button.btn.danger').click()
    page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=12000
    )

    now_card = page_session.locator('#lobby-box .tv-glass-card[data-room="tv-now-tv"]')
    now_card.scroll_into_view_if_needed()
    now_card.click()
    page_session.wait_for_url("**#/mesh/tv-now-tv*", timeout=12000)
    assert "NOW" in page_session.locator("#room-header-title").inner_text()

    leave_curated_room_and_wait_home(page_session, timeout_ms=12000)


@pytest.mark.expects_m2
def test_t3_04_auth_register_cloud_sync_and_notification_poll(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T3-04: Auth modal register -> cloud watchlist & yt-preferences -> notification poll hygiene."""
    uniq = uuid.uuid4().hex[:8]
    email = f"t3auth_{uniq}@example.com"
    handle = f"t3user{uniq}"

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator("#nav-account-btn").click()
    page_session.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
    page_session.locator('#popup-root .wl-auth-tab:has-text("Kayıt Ol")').click()
    page_session.locator('#popup-root input[placeholder*="Görünen Adın"]').fill(f"User{uniq}")
    page_session.locator('#popup-root input[placeholder*="@kullaniciadi"]').fill(handle)
    page_session.locator('#popup-root input[type="email"]').fill(email)
    page_session.locator('#popup-root input[autocomplete="new-password"]').fill("StrongPass123!")
    page_session.locator('#popup-root button[type="submit"]:has-text("Hesap Oluştur")').click()
    page_session.locator("#popup-root .popup-backdrop").wait_for(state="detached", timeout=10000)

    # Verify authenticated token stored in localStorage works on cloud sync & notification poll
    token = page_session.evaluate(
        "() => { for (const k of ['vortex_profile_v2', 'vortex_self_v1']) {"
        " try { const p = JSON.parse(localStorage.getItem(k) || '{}'); if (p && p.authToken) return p.authToken; } catch (_) {} }"
        " return ''; }"
    )
    assert token, "authToken missing in localStorage after registration"
    hdrs = {"Authorization": f"Bearer {token}"}
    assert api_client.get("/api/user/watchlist", headers=hdrs).status_code == 200
    assert api_client.get("/api/user/yt-preferences", headers=hdrs).status_code == 200
    page_session.wait_for_timeout(5000)
    page_session.hygiene.assert_clean()


@pytest.mark.expects_m2
def test_t3_05_music_resolve_room_playback_and_lyrics(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T3-05: Müzik & Karaoke -> music-resolve 200 -> room playback + WEBVTT lyrics."""
    lyr = api_client.get("/api/rave/music-lyrics.vtt", params={"artist": "Semicenk", "title": "Pişman Değilim"})
    assert lyr.status_code == 200 and lyr.text.lstrip().startswith("WEBVTT")

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.locator('.provider-tile[data-provider="music"]').click()
    cards = page_session.locator("#home-selection .music-card")
    cards.first.wait_for(state="visible", timeout=15000)

    with page_session.expect_response(lambda r: "/api/rave/music-resolve" in r.url, timeout=15000) as mr_info:
        cards.first.locator("button.poster-cta.primary").first.click()
    mr = mr_info.value
    assert mr.status == 200
    mr_json = mr.json()
    assert mr_json.get("isMusic") is True and mr_json.get("url")

    page_session.wait_for_url("**#/mesh/wl-*", timeout=15000)
    page_session.locator("#video-frame .player-host iframe, #video-frame .player-host > video, #video-frame .player-host > audio").first.wait_for(
        state="attached", timeout=12000
    )


@pytest.mark.expects_m3
def test_t3_06_sinema_card_body_preview_and_fallback(page_session: Page, base_url: str) -> None:
    """T3-06: Sinema+ .poster.catalog-card body opens detail/preview cleanly with 0 page errors."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.locator('.dock-btn[data-view="cinema"]').click()
    cards = page_session.locator("#home-selection .catalog-main .poster.catalog-card")
    cards.first.wait_for(state="visible", timeout=15000)

    cards.first.locator(".pt").first.click()
    page_session.locator(
        "#home-selection .catalog-detail .series-detail, "
        "#popup-root .wl-preview-modal, "
        "#mesh-root .mesh-layout, "
        "#toast-root .wl-dynamic-toast"
    ).first.wait_for(state="visible", timeout=15000)
    play_btn = page_session.locator("#btn-play-primary")
    if play_btn.count() > 0 and play_btn.first.is_visible():
        play_btn.first.click()
        page_session.locator("#mesh-root .mesh-layout, #toast-root .wl-dynamic-toast").first.wait_for(
            state="visible", timeout=15000
        )
    assert not page_session.hygiene.page_errors


@pytest.mark.expects_m3
def test_t3_07_mobile_390x844_search_and_modal_dismiss(
    mobile_page_session: Page,
    base_url: str,
) -> None:
    """T3-07: Mobile 390x844 -> search Inception -> open & dismiss Profil modal -> zero overflow."""
    mobile_page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(mobile_page_session)
    assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")

    submit_home_search(mobile_page_session, "Inception")
    assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")

    mobile_page_session.locator('.floating-dock .dock-btn[data-view="profile"]').click()
    mobile_page_session.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
    assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")

    close_modal_and_wait_detached(mobile_page_session, use_escape=True)
    assert mobile_page_session.locator("#popup-root .popup-backdrop").count() == 0
    assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")
    assert not mobile_page_session.hygiene.page_errors
