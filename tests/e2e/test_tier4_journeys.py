from __future__ import annotations

import uuid

from playwright.sync_api import Page
import pytest

from helpers import (
    close_modal_and_wait_detached,
    leave_curated_room_and_wait_home,
    submit_home_search,
    wait_for_home_boot,
    wait_for_video_ready,
)

pytestmark = [pytest.mark.tier4]


@pytest.mark.expects_m1
@pytest.mark.expects_m2
@pytest.mark.expects_m3
def test_t4_j1_guest_tv_series_resident_evil_watch_party(page_session: Page, base_url: str) -> None:
    """T4-J1: Guest boot -> search Resident Evil -> S1E3 -> room & playback -> S1E6 -> chat -> clean hygiene."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.wait_for_timeout(5000)

    submit_home_search(page_session, "Resident Evil")
    card = (
        page_session.locator("#home-selection .super-results .poster.catalog-card")
        .filter(has_text="Resident Evil")
        .filter(has_text="Dizi")
        .first
    )
    card.click()

    eps = page_session.locator(".series-detail .episode-grid .episode-card")
    eps.first.wait_for(state="visible", timeout=15000)
    assert eps.count() == 8

    page_session.locator('.series-detail .episode-grid .episode-card:has-text("3. Bölüm")').first.click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=25000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)
    v_ep3 = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_ep3.get("readyState", 0) >= 2 and (
        v_ep3.get("videoWidth", 0) > 0 or v_ep3.get("duration", 0) > 0
    ), f"S1E3 video not decoded: {v_ep3}"

    # Switch to S1E6 via in-room episode selector
    page_session.locator("#video-frame").hover()
    ep_btn = page_session.locator("#ctl-ep-btn")
    ep_btn.wait_for(state="visible", timeout=8000)
    assert ep_btn.is_visible(), "#ctl-ep-btn must be visible for TV series room"
    ep_btn.click()
    page_session.locator('#popup-root .episode-grid .episode-card:has-text("6. Bölüm")').first.click()
    page_session.locator("#popup-root .popup-backdrop").wait_for(state="detached", timeout=8000)
    v_ep6 = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_ep6.get("readyState", 0) >= 2 and (
        v_ep6.get("videoWidth", 0) > 0 or v_ep6.get("duration", 0) > 0
    ), f"S1E6 video not decoded: {v_ep6}"

    chat_in = page_session.locator("#chat-input")
    if not chat_in.is_visible():
        page_session.locator("#nav-toggle-chat").click()
    chat_in.fill("Resident Evil J1 testi")
    page_session.locator("#btn-chat-send").click()
    page_session.locator('#chat-list .msg:has-text("Resident Evil J1 testi")').first.wait_for(
        state="visible", timeout=8000
    )

    page_session.locator("#nav-leave-room").click()
    page_session.locator("#popup-root .popup-options button.btn.danger").click()
    page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=10000
    )
    page_session.hygiene.assert_clean()


@pytest.mark.expects_m1
@pytest.mark.expects_m2
@pytest.mark.expects_m3
def test_t4_j2_movie_browse_sinema_card_and_inception_hls(page_session: Page, base_url: str) -> None:
    """T4-J2: Sinema+ card body preview -> search Inception -> HLS playback -> clean hygiene."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator('.floating-dock .dock-btn[data-view="cinema"]').click()
    cards = page_session.locator("#home-selection .catalog-main .poster.catalog-card")
    cards.first.wait_for(state="visible", timeout=15000)
    cards.first.locator(".pt").first.click()
    page_session.locator(
        "#home-selection .catalog-detail .series-detail, "
        "#popup-root .wl-preview-modal, "
        "#mesh-root .mesh-layout, "
        "#toast-root .wl-dynamic-toast"
    ).first.wait_for(state="visible", timeout=15000)
    if "#/mesh/" in page_session.url:
        page_session.locator("#nav-leave-room").click()
        danger = page_session.locator("#popup-root .popup-options button.btn.danger")
        if danger.count() > 0 and danger.first.is_visible():
            danger.first.click()
        page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
            state="visible", timeout=10000
        )
    else:
        close_modal_and_wait_detached(page_session)
        page_session.locator('.floating-dock .dock-btn[data-view="home"]').click()
    submit_home_search(page_session, "Inception")
    page_session.locator("#home-selection .super-results .poster.catalog-card:has-text('Inception')").first.click()

    page_session.wait_for_url("**#/mesh/wl-*", timeout=25000)
    v_info = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_info.get("readyState", 0) >= 2 and v_info.get("videoWidth", 0) > 0

    page_session.locator("#nav-leave-room").click()
    page_session.locator("#popup-root .popup-options button.btn.danger").click()
    page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=10000
    )
    page_session.hygiene.assert_clean()


@pytest.mark.expects_m2
def test_t4_j3_curated_live_tv_and_radio_switching(page_session: Page, base_url: str) -> None:
    """T4-J3: Curated 7/24 Live TV & Radio switching (tv-trt1 -> tv-now-tv -> radyo-power-turk)."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    for rid, title_substr in (
        ("tv-trt1", "TRT 1"),
        ("tv-now-tv", "NOW"),
        ("radyo-power-turk", "Power Türk"),
    ):
        card = page_session.locator(f'#lobby-box .tv-glass-card[data-room="{rid}"]')
        card.scroll_into_view_if_needed()
        card.click()
        page_session.wait_for_url(f"**#/mesh/{rid}*", timeout=12000)
        page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
        page_session.wait_for_timeout(1200)
        assert f"#/mesh/{rid}" in page_session.url
        header = page_session.locator("#room-header-title").inner_text()
        assert title_substr in header, f"Expected {title_substr!r} in header {header!r}"
        assert "Watchlivo Sinema Odası" not in header

        leave_curated_room_and_wait_home(page_session, timeout_ms=10000)

    page_session.hygiene.assert_clean()


@pytest.mark.expects_m2
@pytest.mark.expects_m3
def test_t4_j4_full_user_room_lifecycle_reload_and_close(page_session: Page, base_url: str) -> None:
    """T4-J4: Oda Oluştur -> chat -> reload at #/mesh/wl-* -> chat persists -> Odayı Tamamen Kapat."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator("#btn-create-room").click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=12000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
    rid = page_session.url.split("#/mesh/")[1].split("?")[0]

    msg = "E2E test mesajı"
    chat_in = page_session.locator("#chat-input")
    if not chat_in.is_visible():
        page_session.locator("#nav-toggle-chat").click()
    chat_in.fill(msg)
    page_session.locator("#btn-chat-send").click()
    page_session.locator(f'#chat-list .msg:has-text("{msg}")').first.wait_for(state="visible", timeout=8000)

    page_session.reload(wait_until="domcontentloaded")
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)
    page_session.locator(f'#chat-list .msg:has-text("{msg}")').first.wait_for(state="visible", timeout=10000)

    page_session.locator("#nav-leave-room").click()
    page_session.locator("#popup-root .popup-options button.btn.danger").click()
    page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=10000
    )

    with page_session.hygiene.allow_http_error(f"/api/rooms/{rid}/sync", status=410):
        page_session.goto(f"{base_url}/#/mesh/{rid}", wait_until="domcontentloaded")
        page_session.locator("#toast-root .wl-dynamic-toast .wl-toast-text").wait_for(
            state="visible", timeout=10000
        )
        page_session.wait_for_url(lambda u: f"#/mesh/{rid}" not in u, timeout=10000)

    page_session.hygiene.assert_clean()


@pytest.mark.expects_m2
@pytest.mark.expects_m3
def test_t4_j5_providers_auth_social_and_mobile_390_audit(
    make_page,
    base_url: str,
) -> None:
    """T4-J5: Watchlivo DJ, YouTube, Müzik & Karaoke, Friends search, Auth register, and Mobile 390x844."""
    desktop = make_page(1280, 800, has_touch=False)
    desktop.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(desktop)

    for prov in ("ravedj", "youtube"):
        desktop.locator(f'.provider-tile[data-provider="{prov}"]').click()
        desktop.locator("#home-selection .sel-body").wait_for(state="visible", timeout=10000)
        desktop.locator('.sel-prov-head button.panel-close[aria-label="Geri"]').click()

    desktop.locator('.provider-tile[data-provider="music"]').click()
    desktop.locator("#home-selection .music-card").first.wait_for(state="visible", timeout=15000)
    desktop.locator('.sel-prov-head button.panel-close[aria-label="Geri"]').click()

    desktop.locator("#nav-friends-btn").click()
    desktop.locator("#popup-root .friends-manager-modal").wait_for(state="visible", timeout=5000)
    desktop.locator('#popup-root .wl-social-tab:has-text("Ara")').click()
    with desktop.expect_response(
        lambda r: "/api/rave/social/search" in r.url,
        timeout=10000,
    ) as sr_info:
        desktop.locator("#friend-name-input").fill("test")
    assert sr_info.value.status == 200, f"social/search returned {sr_info.value.status}"
    close_modal_and_wait_detached(desktop)

    uniq = uuid.uuid4().hex[:8]
    desktop.locator("#nav-account-btn").click()
    desktop.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
    desktop.locator('#popup-root .wl-auth-tab:has-text("Kayıt Ol")').click()
    desktop.locator('#popup-root input[placeholder*="Görünen Adın"]').fill(f"J5User{uniq}")
    desktop.locator('#popup-root input[placeholder*="@kullaniciadi"]').fill(f"j5user{uniq}")
    desktop.locator('#popup-root input[type="email"]').fill(f"j5_{uniq}@example.com")
    desktop.locator('#popup-root input[autocomplete="new-password"]').fill("ValidJ5Pass123!")
    desktop.locator('#popup-root button[type="submit"]:has-text("Hesap Oluştur")').click()
    desktop.locator("#popup-root .popup-backdrop").wait_for(state="detached", timeout=10000)
    assert f"J5User{uniq}" in desktop.locator("#nav-account-btn").inner_text()
    desktop.hygiene.assert_clean()

    mobile = make_page(390, 844, has_touch=True)
    mobile.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(mobile)
    assert mobile.evaluate("() => document.documentElement.scrollWidth <= 390")
    mobile.locator('.floating-dock .dock-btn[data-view="profile"]').click()
    mobile.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
    close_modal_and_wait_detached(mobile, use_escape=True)
    mobile.hygiene.assert_clean()


@pytest.mark.expects_m1
@pytest.mark.expects_m2
def test_t4_j6_anime_solo_leveling_and_turkish_series_gibi(page_session: Page, base_url: str) -> None:
    """T4-J6: Solo Leveling anime S1E1 & Gibi Turkish series S1E1 discovery & playback readiness."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    submit_home_search(page_session, "Solo Leveling")
    page_session.locator("#home-selection .super-results .poster.catalog-card:has-text('Solo Leveling')").first.click()
    page_session.locator(".series-detail .episode-grid .episode-card").first.wait_for(
        state="visible", timeout=15000
    )
    page_session.locator('.series-detail .episode-grid .episode-card').first.click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=25000)
    v_solo = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_solo.get("readyState", 0) >= 2 and v_solo.get("videoWidth", 0) >= 640

    page_session.locator("#nav-leave-room").click()
    page_session.locator("#popup-root .popup-options button.btn.danger").click()
    page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=10000
    )

    submit_home_search(page_session, "Gibi")
    page_session.locator("#home-selection .super-results .poster.catalog-card:has-text('Gibi')").first.click()
    page_session.locator(".series-detail .episode-grid .episode-card").first.wait_for(
        state="visible", timeout=15000
    )
    page_session.locator('.series-detail .episode-grid .episode-card').first.click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=25000)
    v_gibi = wait_for_video_ready(page_session, timeout_ms=25000)
    assert v_gibi.get("readyState", 0) >= 2 and (
        v_gibi.get("videoWidth", 0) > 0 or v_gibi.get("duration", 0) > 0
    ), f"Gibi video not decoded: {v_gibi}"

    page_session.locator("#nav-leave-room").click()
    page_session.locator("#popup-root .popup-options button.btn.danger").click()
    page_session.hygiene.assert_clean()
