from __future__ import annotations

from pathlib import Path

import httpx
from playwright.sync_api import Page
import pytest

from helpers import close_modal_and_wait_detached, wait_for_home_boot

pytestmark = [pytest.mark.tier1]

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_t1_f7_01_static_assets_and_manifest(api_client: httpx.Client) -> None:
    """T1-F7-01: Required static JS/CSS/SVG/manifest/sw.js bundles serve 200 with valid MIME types."""
    checks = [
        ("/static/js/main.js", "javascript"),
        ("/static/js/api.js", "javascript"),
        ("/static/css/vortex.css", "text/css"),
        ("/static/css/mesh.css", "text/css"),
        ("/static/watchlivo-logo.svg", "image/svg+xml"),
        ("/static/watchlivo-poster.svg", "image/svg+xml"),
        ("/manifest.json", "json"),
        ("/sw.js", "javascript"),
    ]
    for path, mime_substr in checks:
        resp = api_client.get(path)
        assert resp.status_code == 200, f"{path} failed: {resp.status_code}"
        ct = (resp.headers.get("content-type") or "").lower()
        assert mime_substr in ct, f"{path} unexpected Content-Type: {ct}"
        assert len(resp.content) > 50, f"{path} empty body"


@pytest.mark.expects_m3
def test_t1_f7_02_bg_img_clean_and_no_broken_visible_images(page_session: Page, base_url: str) -> None:
    """T1-F7-02: #bg-img clean state, zero broken visible images, and static/ synced to public/."""
    # Verify M3 sync between static/ and workers/ha-gateway/public/
    static_dir = REPO_ROOT / "static"
    public_dir = REPO_ROOT / "workers" / "ha-gateway" / "public"
    assert (static_dir / "index.html").read_bytes() == (public_dir / "index.html").read_bytes(), (
        "static/index.html is out of sync with workers/ha-gateway/public/index.html"
    )
    for src_file in static_dir.rglob("*"):
        if src_file.is_file():
            rel = src_file.relative_to(static_dir)
            pub_file = public_dir / "static" / rel
            assert pub_file.exists() and src_file.read_bytes() == pub_file.read_bytes(), (
                f"static/{rel} is out of sync with workers/ha-gateway/public/static/{rel}"
            )

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.wait_for_timeout(1200)

    img_audit = page_session.evaluate(
        """() => {
            const bg = document.getElementById('bg-img');
            const bgStyle = bg ? getComputedStyle(bg) : null;
            const bgOk = !bg || bgStyle.display === 'none' || (bg.complete && bg.naturalWidth > 0);
            const brokenVisible = [];
            for (const img of document.querySelectorAll('img')) {
                const st = getComputedStyle(img);
                if (st.display === 'none' || st.visibility === 'hidden') continue;
                const rect = img.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                if (img.loading === 'lazy' && rect.top > window.innerHeight * 2) continue;
                if (img.complete && img.naturalWidth === 0) {
                    brokenVisible.push({ id: img.id, cls: img.className, src: img.getAttribute('src') });
                }
            }
            return { bgOk, brokenVisible };
        }"""
    )
    assert img_audit["bgOk"], "#bg-img is visible without a loaded image"
    assert not img_audit["brokenVisible"], f"Broken visible images: {img_audit['brokenVisible']}"


@pytest.mark.expects_m3
def test_t1_f7_03_sinema_poster_card_body_clickable(page_session: Page, base_url: str) -> None:
    """T1-F7-03: Clicking Sinema+ .poster.catalog-card body (not only CTA) opens detail/preview/room."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator('.provider-tile[data-provider="cinema"], .dock-btn[data-view="cinema"]').first.click()
    cards = page_session.locator("#home-selection .catalog-main .poster.catalog-card")
    cards.first.wait_for(state="visible", timeout=15000)

    # Click the title/poster body (.pt or .poster-thumb), avoiding button.poster-cta
    title_el = cards.first.locator(".pt").first
    if title_el.count() > 0:
        title_el.click()
    else:
        cards.first.click(position={"x": 20, "y": 20})

    page_session.locator(
        "#home-selection .catalog-detail .series-detail, #popup-root .popup, #mesh-root .mesh-layout"
    ).first.wait_for(state="visible", timeout=10000)


@pytest.mark.expects_m3
def test_t1_f7_04_supersearch_single_request_dedupe(page_session: Page, base_url: str) -> None:
    """T1-F7-04: Submitting SuperSearch for 'Inception' does not fire duplicate identical requests."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    search_calls: list[str] = []

    def on_req(req) -> None:
        if "/api/rave/supersearch" in req.url and "q=Inception" in req.url:
            search_calls.append(req.url)

    page_session.on("request", on_req)
    search_input = page_session.locator('#home-selection .home-search input[aria-label="Ara"]')
    search_btn = page_session.locator('#home-selection .home-search button.btn.primary')
    search_input.fill("Inception")
    search_btn.click()
    page_session.locator("#home-selection .super-results .poster.catalog-card").first.wait_for(
        state="visible", timeout=15000
    )
    page_session.wait_for_timeout(500)
    assert len(search_calls) == 1, f"Expected 1 supersearch call for Inception, got {len(search_calls)}: {search_calls}"


@pytest.mark.expects_m3
def test_t1_f7_05_dock_navigation_and_oda_olustur_ux(page_session: Page, base_url: str) -> None:
    """T1-F7-05: Dock navigation (Sinema+, 7/24 Canlı TV, Profil) and Oda Oluştur UX."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator('.floating-dock .dock-btn[data-view="cinema"]').click()
    page_session.locator("#home-selection #hub-search-q").wait_for(state="visible", timeout=10000)

    page_session.locator('.floating-dock .dock-btn[data-view="tv"]').click()
    page_session.locator("#lobby-sec-tv").wait_for(state="visible", timeout=8000)

    page_session.locator('.floating-dock .dock-btn[data-view="profile"]').click()
    page_session.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
    close_modal_and_wait_detached(page_session, use_escape=True)
    # Dock remains clickable after closing profile modal
    page_session.locator('.floating-dock .dock-btn[data-view="home"]').click()
    page_session.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=8000
    )

    page_session.locator("#btn-create-room").click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=12000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
    assert not page_session.hygiene.page_errors


def test_t1_f7_06_mobile_viewport_390x844_responsive(
    mobile_page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T1-F7-06: Mobile 390x844 home and room layouts have zero horizontal overflow."""
    mobile_page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(mobile_page_session)

    home_overflow = mobile_page_session.evaluate(
        "() => document.documentElement.scrollWidth <= 390"
    )
    assert home_overflow, "Home page overflows 390px mobile viewport"
    assert mobile_page_session.locator("header.top-nav-capsule").is_visible()
    assert mobile_page_session.locator("nav.floating-dock").is_visible()

    created = api_client.post(
        "/api/rooms/create",
        json={"name": "Mobile Room", "creator": "MobileE2E", "privacy": "public"},
    ).json()
    rid = created["room"]["id"]
    try:
        mobile_page_session.goto(f"{base_url}/#/mesh/{rid}", wait_until="domcontentloaded")
        mobile_page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)
        room_overflow = mobile_page_session.evaluate(
            "() => document.documentElement.scrollWidth <= 390"
        )
        assert room_overflow, "Room page overflows 390px mobile viewport"
    finally:
        api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "close_room", "clientId": created["clientId"], "clientToken": created["clientToken"]},
        )


def test_t1_f7_07_apk_ios_and_windows_download_routes(api_client: httpx.Client) -> None:
    """T1-F7-07: Static APK asset, /download/ios, and /download/windows?check=1 routes."""
    static_apk = api_client.get("/static/Watchlivo-v2.0.apk")
    assert static_apk.status_code == 200
    assert len(static_apk.content) > 1000
    assert static_apk.content[:2] == b"PK"

    win = api_client.get("/download/windows", params={"check": "1"})
    assert win.status_code == 200
    assert win.json() == {"ok": False, "available": False, "platform": "windows", "url": "/#/?platform=windows"}

    ios = api_client.get("/download/ios")
    assert ios.status_code in (200, 302)
    if ios.status_code == 200:
        assert "apple-aspen-config" in (ios.headers.get("content-type") or "").lower()
