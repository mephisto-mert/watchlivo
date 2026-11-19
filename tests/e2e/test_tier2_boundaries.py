from __future__ import annotations

import uuid

import httpx
from playwright.sync_api import Page
import pytest

from helpers import (
    BROWSER_UA,
    close_modal_and_wait_detached,
    resolve_catalog_api,
    submit_home_search,
    to_ws_url,
    wait_for_home_boot,
    ws_connect_init,
)

pytestmark = [pytest.mark.tier2]


# =====================================================================
# F1 Boundaries (T2-F1-01 .. T2-F1-06)
# =====================================================================


@pytest.mark.expects_m2
def test_t2_f1_01_seasons_tmdb_tv_prefix_without_tmdbid(api_client: httpx.Client) -> None:
    """T2-F1-01: id=tmdb-tv-108296 without tmdbId resolves 8 Resident Evil S1 episodes."""
    resp = api_client.get(
        "/api/rave/seasons",
        params={"id": "tmdb-tv-108296", "mediaType": "tv", "season": "1"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert str(data.get("tmdbId")) == "108296"
    assert len(data.get("episodes") or []) == 8


@pytest.mark.expects_m1
def test_t2_f1_02_colon_subtitle_matching_empty_original_title(
    api_client: httpx.Client,
    edge_token: str,
) -> None:
    """T2-F1-02: Colon subtitle matching with empty originalTitle resolves 200."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "108296",
            "title": "Resident Evil: biohazard",
            "originalTitle": "",
            "mediaType": "tv",
            "season": "1",
            "episode": "3",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json().get("url")


def test_t2_f1_03_seasons_nonexistent_tmdbid_graceful_fallback(api_client: httpx.Client) -> None:
    """T2-F1-03: Non-existent tmdbId on /api/rave/seasons returns 200 fallback without 500."""
    resp = api_client.get(
        "/api/rave/seasons",
        params={"tmdbId": "999999999", "mediaType": "tv", "season": "1"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    assert isinstance(data.get("seasons"), list) and len(data["seasons"]) >= 1
    assert isinstance(data.get("episodes"), list) and len(data["episodes"]) >= 1


def test_t2_f1_04_seasons_mediatype_movie_returns_empty_lists(api_client: httpx.Client) -> None:
    """T2-F1-04: mediaType=movie on /api/rave/seasons returns empty seasons/episodes."""
    resp = api_client.get(
        "/api/rave/seasons",
        params={"tmdbId": "27205", "mediaType": "movie"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    assert data.get("mediaType") == "movie"
    assert data.get("seasons") == []
    assert data.get("episodes") == []


def test_t2_f1_05_negative_and_zero_season_episode_clamping(
    api_client: httpx.Client,
    edge_token: str,
) -> None:
    """T2-F1-05: Invalid/non-positive season=-5&episode=0 never causes 500."""
    s_resp = api_client.get(
        "/api/rave/seasons",
        params={"tmdbId": "108296", "mediaType": "tv", "season": "-5"},
    )
    assert s_resp.status_code == 200
    assert len(s_resp.json().get("episodes") or []) >= 1

    r_resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "0",
            "title": "zzzznotarealshow999111",
            "mediaType": "tv",
            "season": "-5",
            "episode": "0",
        },
    )
    assert r_resp.status_code in (200, 404), f"Unexpected status {r_resp.status_code}: {r_resp.text}"
    assert "application/json" in (r_resp.headers.get("content-type") or "").lower()


def test_t2_f1_06_refresh_bypass_and_bogus_tv_returns_404_json(
    api_client: httpx.Client,
    edge_token: str,
) -> None:
    """T2-F1-06: refresh=1 with unknown TV title returns structured 404 JSON, never 500."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "0",
            "title": "zzzznotarealshow999111",
            "mediaType": "tv",
            "season": "1",
            "episode": "1",
            "refresh": "1",
        },
    )
    assert resp.status_code == 404, resp.text
    data = resp.json()
    assert data.get("ok") is False
    assert data.get("error")


# =====================================================================
# F2 Boundaries (T2-F2-01 .. T2-F2-06)
# =====================================================================


def test_t2_f2_01_stream_missing_url_and_bad_sid(api_client: httpx.Client) -> None:
    """T2-F2-01: /api/rave/stream missing url/sid and invalid base64 sid return 400."""
    missing = api_client.get("/api/rave/stream")
    assert missing.status_code == 400
    assert "Missing stream URL" in missing.text

    bad_sid = api_client.get("/api/rave/stream", params={"sid": "!!!"})
    assert bad_sid.status_code == 400
    assert "Invalid sid" in bad_sid.text


def test_t2_f2_02_ssrf_protection_on_stream_endpoints(api_client: httpx.Client) -> None:
    """T2-F2-02: SSRF targets on /api/rave/stream & /api/rave/stream-proxy are blocked (403)."""
    ssrf_urls = [
        "http://127.0.0.1:8785/api/health",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/secret.m3u8",
        "http://[::1]/secret.m3u8",
        "file:///etc/passwd",
    ]
    for target in ssrf_urls:
        r = api_client.get("/api/rave/stream", params={"url": target})
        assert r.status_code == 403, f"SSRF not 403 for {target}: {r.status_code} {r.text}"
        assert "Blocked target URL" in r.text

        rp = api_client.get("/api/rave/stream-proxy", params={"url": target})
        # Never 200; 403 from edge_streams or 503 if unconnected STREAM_PROXY binding in local dev
        assert rp.status_code in (403, 503), f"SSRF stream-proxy unexpected {rp.status_code} for {target}"


def test_t2_f2_03_blocked_betting_ad_hosts_on_stream(api_client: httpx.Client) -> None:
    """T2-F2-03: Blocked betting/ad hosts on /api/rave/stream return 403."""
    for bad in ("https://vidlink.pro/embed/123", "https://1xbet.com/a.m3u8"):
        r = api_client.get("/api/rave/stream", params={"url": bad})
        assert r.status_code == 403, f"Expected 403 for {bad}, got {r.status_code}"
        assert "Blocked target URL" in r.text


def test_t2_f2_04_stream_proxy_missing_tampered_expired_sig(api_client: httpx.Client) -> None:
    """T2-F2-04: /api/rave/stream-proxy rejects missing, tampered, and expired sig with 403."""
    target = "https://vidmoly.biz/test.m3u8"  # in BYPASS_WORKER_HOSTS -> handled by edge_streams.js
    for params in (
        {"url": target},
        {"url": target, "sig": "000000000000000000000000.9999999999"},
        {"url": target, "sig": "deadbeefdeadbeefdeadbeef.1000000000"},
    ):
        r = api_client.get("/api/rave/stream-proxy", params=params)
        assert r.status_code == 403, f"Expected 403 for {params}, got {r.status_code} {r.text}"
        assert "Invalid or expired stream signature" in r.text


def test_t2_f2_05_stream_proxy_cors_options_and_subtitle_ssrf(api_client: httpx.Client) -> None:
    """T2-F2-05: stream-proxy OPTIONS preflight returns 204 CORS; subtitle.vtt blocks local SSRF."""
    opt = api_client.options(
        "/api/rave/stream-proxy",
        params={"url": "https://vidmoly.biz/test.m3u8"},
    )
    assert opt.status_code == 204
    assert opt.headers.get("access-control-allow-origin") == "*"

    sub = api_client.get(
        "/api/rave/subtitle.vtt",
        params={"url": "http://127.0.0.1:8785/api/health"},
    )
    assert sub.status_code == 403


def test_t2_f2_06_bogus_movie_resolve_returns_404_json(
    api_client: httpx.Client,
    edge_token: str,
) -> None:
    """T2-F2-06: Unextractable bogus movie returns 404 JSON without uncaught 500."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "999999999",
            "title": "NoSuchMovieXYZ999",
            "mediaType": "movie",
        },
    )
    assert resp.status_code == 404, resp.text
    data = resp.json()
    assert data.get("ok") is False
    assert data.get("error")


# =====================================================================
# F3 Boundaries (T2-F3-01 .. T2-F3-06)
# =====================================================================


@pytest.mark.expects_m2
def test_t2_f3_01_social_guest_empty_body_vs_short_handle(api_client: httpx.Client) -> None:
    """T2-F3-01: Empty {} guest request provisions profile (200); 1-char handle returns 400."""
    ok_r = api_client.post("/api/rave/social/guest", json={})
    assert ok_r.status_code == 200, ok_r.text
    d = ok_r.json()
    assert d.get("ok") is True and str(d.get("uid") or "").startswith("guest_")

    bad_r = api_client.post("/api/rave/social/guest", json={"handle": "a"})
    assert bad_r.status_code == 400, bad_r.text
    assert bad_r.json().get("ok") is False


@pytest.mark.expects_m2
def test_t2_f3_02_notifications_poll_missing_uid_and_future_since(api_client: httpx.Client) -> None:
    """T2-F3-02: notifications/poll with missing uid & future since returns empty 200 payload."""
    resp = api_client.get("/api/rave/notifications/poll", params={"since": "9999999999"})
    assert resp.status_code == 200, resp.text
    d = resp.json()
    assert d.get("ok") is True
    assert d.get("notifications") == []
    assert d.get("requestCount") == 0
    assert d.get("totalUnread") == 0


@pytest.mark.expects_m2
def test_t2_f3_03_ga_collect_options_get_and_large_post(api_client: httpx.Client) -> None:
    """T2-F3-03: ga-collect/g/collect OPTIONS, GET, and oversized POST return 204."""
    for method in ("OPTIONS", "GET"):
        r = api_client.request(method, "/api/rave/ga-collect/g/collect", params={"v": "2", "en": "page_view"})
        assert r.status_code == 204, f"{method} ga-collect returned {r.status_code}"

    big_payload = ("en=page_view&ep.extra=" + ("x" * 16384)).encode("utf-8")
    post_r = api_client.post("/api/rave/ga-collect/g/collect", content=big_payload)
    assert post_r.status_code == 204, f"POST ga-collect returned {post_r.status_code}"


def test_t2_f3_04_crawler_bot_ua_cloaking(base_url: str) -> None:
    """T2-F3-04: Googlebot UA receives CLOAKED_HTML on / and 403 bot_access_restricted on API."""
    with httpx.Client(base_url=base_url, follow_redirects=False, timeout=10.0) as bot_client:
        home_r = bot_client.get("/", headers={"User-Agent": "Googlebot/2.1"})
        assert home_r.status_code == 200
        assert "noindex" in (home_r.headers.get("x-robots-tag") or "").lower()
        assert home_r.headers.get("x-watchlivo-origin") == "cf-autonomous-edge-cloak"

        api_r = bot_client.get("/api/rave/catalog", headers={"User-Agent": "Googlebot/2.1"})
        assert api_r.status_code == 403
        assert "bot_access_restricted" in api_r.text


def test_t2_f3_05_robots_txt_and_sitemap_xml(api_client: httpx.Client) -> None:
    """T2-F3-05: /robots.txt and /sitemap.xml return valid 200 responses."""
    rob = api_client.get("/robots.txt")
    assert rob.status_code == 200
    assert "text/plain" in (rob.headers.get("content-type") or "").lower()
    assert "Disallow: /" in rob.text

    sm = api_client.get("/sitemap.xml")
    assert sm.status_code == 200
    assert "xml" in (sm.headers.get("content-type") or "").lower()
    assert "<urlset" in sm.text


@pytest.mark.expects_m2
def test_t2_f3_06_ten_second_idle_browser_zero_404_stability(page_session: Page, base_url: str) -> None:
    """T2-F3-06: Over 10s idle browser session, background poll timers emit zero 404s."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.wait_for_timeout(10000)
    page_session.hygiene.assert_clean()


# =====================================================================
# F4 Boundaries (T2-F4-01 .. T2-F4-06)
# =====================================================================


@pytest.mark.expects_m3
def test_t2_f4_01_empty_and_whitespace_search_no_blank_results(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F4-01: Empty & whitespace search does not render blank visible .super-results box."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    for q in ("", "   "):
        submit_home_search(page_session, q)
        sr = page_session.locator("#home-selection .super-results")
        is_hidden_or_empty = sr.evaluate(
            "el => el.classList.contains('hidden') || el.children.length === 0"
        )
        assert is_hidden_or_empty, f"Blank .super-results rendered for query {q!r}"

    empty_api = api_client.get("/api/rave/supersearch", params={"q": ""})
    assert empty_api.status_code == 200
    assert isinstance(empty_api.json().get("items"), list)


def test_t2_f4_02_xss_payload_in_supersearch_escaped(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F4-02: XSS payload in SuperSearch is safely escaped without script execution."""
    api_r = api_client.get("/api/rave/supersearch", params={"q": "<script>alert(1)</script>"})
    assert api_r.status_code == 200

    dialogs: list[str] = []
    page_session.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    submit_home_search(page_session, "<img src=x onerror=window.__xss=1>")

    empty_msg = page_session.locator("#home-selection .super-results .lobby-empty")
    empty_msg.wait_for(state="visible", timeout=10000)
    assert "Aramanızla eşleşen içerik bulunamadı." in empty_msg.inner_text()
    assert page_session.evaluate("() => window.__xss === undefined") is True
    assert not dialogs, f"XSS alert dialog fired: {dialogs}"


@pytest.mark.expects_m3
def test_t2_f4_03_music_resolve_missing_preview_shows_toast_or_resolves(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F4-03: music-resolve missing preview returns structured JSON; UI never silently drops."""
    r = api_client.get(
        "/api/rave/music-resolve",
        params={"artist": "UnknownArtistXYZ", "title": "NoPreviewTrack999"},
    )
    assert r.status_code in (200, 404)
    data = r.json()
    assert isinstance(data, dict)

    # Verify in UI by opening Müzik & Karaoke and intercepting music-resolve to return empty unplayable url
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.locator('.provider-tile[data-provider="music"]').click()
    page_session.locator("#home-selection .music-card").first.wait_for(state="visible", timeout=15000)

    page_session.route(
        "**/api/rave/music-resolve*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='{"ok":false,"error":"Şarkı akışı şu an çözümlenemedi"}',
        ),
    )
    page_session.locator("#home-selection .music-card button.poster-cta").first.click()
    toast_txt = page_session.locator("#toast-root .wl-dynamic-toast .wl-toast-text")
    toast_txt.wait_for(state="visible", timeout=5000)
    assert toast_txt.inner_text().strip() != ""


def test_t2_f4_04_invalid_auth_credentials_and_validation(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F4-04: Auth validation (400/401/409) & browser modal .wl-auth-err display."""
    uniq = uuid.uuid4().hex[:8]
    email = f"dup_{uniq}@example.com"
    reg_ok = api_client.post("/api/auth/register", json={"email": email, "password": "ValidPass123", "name": f"Dup{uniq}"})
    assert reg_ok.status_code == 200

    assert api_client.post("/api/auth/register", json={"email": "notanemail", "password": "ValidPass123"}).status_code == 400
    assert api_client.post("/api/auth/register", json={"email": f"s_{uniq}@example.com", "password": "123"}).status_code == 400
    assert api_client.post("/api/auth/register", json={"email": email, "password": "ValidPass123"}).status_code == 409
    assert api_client.post("/api/auth/login", json={"identifier": email}).status_code == 400
    assert api_client.post("/api/auth/login", json={"identifier": email, "password": "WrongPassword!"}).status_code == 401

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    with page_session.hygiene.allow_http_error("/api/auth/login", status=401, method="POST"):
        page_session.locator("#nav-account-btn").click()
        page_session.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
        page_session.locator('#popup-root .wl-auth-form input[autocomplete="username"]').fill(email)
        page_session.locator('#popup-root .wl-auth-form input[autocomplete="current-password"]').fill("WrongPass999")
        page_session.locator('#popup-root button[type="submit"]:has-text("Hesabımla Giriş Yap")').click()
        page_session.wait_for_function(
            "() => (document.querySelector('#popup-root .wl-auth-err')?.textContent || '').trim().length > 0",
            timeout=8000,
        )
        err_box = page_session.locator("#popup-root .wl-auth-err")
        assert err_box.inner_text().strip() != ""


@pytest.mark.expects_m2
def test_t2_f4_05_render_dependent_endpoints_structured_json(
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F4-05: Render-dependent endpoints return structured JSON (never raw 404)."""
    assert api_client.get("/api/rave/extract-video", params={"url": "ftp://bad"}).status_code == 400

    ext_unk = api_client.get("/api/rave/extract-video", params={"url": "https://example.com/nope"})
    assert ext_unk.status_code == 503
    assert ext_unk.json().get("code") == "origin_required"

    assert api_client.post("/api/upload").status_code == 401
    assert api_client.post("/api/rave/ai-chat", json={"prompt": "hi"}).status_code == 401

    uniq = uuid.uuid4().hex[:8]
    tok = api_client.post(
        "/api/auth/register",
        json={"email": f"rend_{uniq}@example.com", "password": "ValidPass123", "name": f"Rend{uniq}"},
    ).json()["authToken"]
    auth_hdrs = {"Authorization": f"Bearer {tok}"}
    assert api_client.post("/api/upload", headers=auth_hdrs).status_code == 501
    assert api_client.post("/api/rave/ai-chat", headers=auth_hdrs, json={"prompt": "hi"}).status_code == 501

    for path, params in (
        ("/api/rave/yt-music-stream", {"v": "dQw4w9WgXcQ"}),
        ("/api/rave/yt-pip-hls.m3u8", {"v": "dQw4w9WgXcQ"}),
        ("/api/rave/tts", {"text": "merhaba"}),
    ):
        r = api_client.get(path, params=params)
        assert r.status_code in (200, 501, 503), f"{path} returned {r.status_code}: {r.text}"
        assert r.status_code != 404, f"{path} returned raw 404"
        if r.status_code in (501, 503):
            j = r.json()
            assert j.get("ok") is False and j.get("error")


@pytest.mark.expects_m2
def test_t2_f4_06_new_releases_post_and_auth_profile_management(
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F4-06: POST /api/rave/new-releases & /api/auth/profile,password,delete do not raw-404."""
    nr = api_client.post(
        "/api/rave/new-releases",
        json={"title": "Test Film E2E", "mediaType": "movie", "year": "2025"},
    )
    assert nr.status_code in (200, 201, 400, 401, 403), (
        f"POST /api/rave/new-releases returned unexpected {nr.status_code}: {nr.text}"
    )

    uniq = uuid.uuid4().hex[:8]
    email = f"prof_{uniq}@example.com"
    tok = api_client.post(
        "/api/auth/register",
        json={"email": email, "password": "OldPass123", "name": f"Prof{uniq}"},
    ).json()["authToken"]
    hdrs = {"Authorization": f"Bearer {tok}"}

    prof = api_client.post(
        "/api/auth/profile",
        headers=hdrs,
        json={"name": f"Updated{uniq}", "bio": "E2E bio"},
    )
    assert prof.status_code == 200, prof.text
    assert prof.json().get("ok") is True

    pwd = api_client.post(
        "/api/auth/password",
        headers=hdrs,
        json={"currentPassword": "OldPass123", "newPassword": "NewPass123"},
    )
    assert pwd.status_code == 200, pwd.text
    new_tok = pwd.json().get("authToken")
    assert new_tok and new_tok != tok

    stale = api_client.get("/api/user/watchlist", headers=hdrs)
    assert stale.status_code == 401, f"Old session must be revoked after password change: {stale.status_code}"

    assert api_client.get("/api/auth/delete", headers={"Authorization": f"Bearer {new_tok}"}).status_code == 405

    dele = api_client.post("/api/auth/delete", headers={"Authorization": f"Bearer {new_tok}"}, json={"password": "NewPass123"})
    assert dele.status_code == 200, dele.text
    after = api_client.get("/api/user/watchlist", headers={"Authorization": f"Bearer {new_tok}"})
    assert after.status_code == 401, f"Session must be revoked after account deletion: {after.status_code}"


# =====================================================================
# F5 Boundaries (T2-F5-01 .. T2-F5-06)
# =====================================================================


def test_t2_f5_01_curated_room_rejects_close_room(api_client: httpx.Client) -> None:
    """T2-F5-01: Curated room rejects close_room with 403 and never closes."""
    r = api_client.post(
        "/api/rooms/tv-trt1/sync",
        json={"type": "close_room", "clientId": "spoof_host"},
    )
    assert r.status_code == 403
    assert r.json().get("ok") is False


@pytest.mark.expects_m2
def test_t2_f5_02_curated_room_rejects_change_media(api_client: httpx.Client) -> None:
    """T2-F5-02: Curated room rejects change_media with 403."""
    r = api_client.post(
        "/api/rooms/tv-now-tv/sync",
        json={"type": "change_media", "media": {"url": "https://example.com/a.mp4"}},
    )
    assert r.status_code == 403
    assert r.json().get("ok") is False


@pytest.mark.expects_m2
def test_t2_f5_03_unknown_room_404_vs_closed_room_410(api_client: httpx.Client) -> None:
    """T2-F5-03: Unknown room GET returns 404; closed room returns 410 roomClosed:true."""
    unk = api_client.get("/api/rooms/wl-does-not-exist-999")
    assert unk.status_code == 404, unk.text

    created = api_client.post("/api/rooms/create", json={"name": "Temp Close", "creator": "E2E"}).json()
    rid = created["room"]["id"]
    api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "close_room", "clientId": created["clientId"], "clientToken": created["clientToken"]},
    )
    closed_sync = api_client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "username": "Late"})
    assert closed_sync.status_code == 410
    assert closed_sync.json().get("roomClosed") is True


@pytest.mark.expects_m2
def test_t2_f5_04_ws_connect_curated_room_before_http_sync(base_url: str) -> None:
    """T2-F5-04: WebSocket init on tv-star-tv preserves curated:true, Star TV name, and media.url."""
    ws_url = to_ws_url(base_url, "/ws/tv-star-tv?username=WSTV")
    init_pkt, _ = ws_connect_init(ws_url, origin=base_url)
    room = init_pkt.get("room") or {}
    assert room.get("curated") is True
    assert "Star TV" in (room.get("name") or "")
    assert room.get("name") != "Watchlivo Sinema Odası"
    assert (room.get("media") or {}).get("url")


@pytest.mark.expects_m2
def test_t2_f5_05_curated_sync_without_active_media_preserves_seed(api_client: httpx.Client) -> None:
    """T2-F5-05: /sync without activeMedia/syncToken preserves curated seed metadata."""
    for rid, expected_name in (("tv-trt-spor", "TRT Spor"), ("radyo-power-turk", "Power Türk")):
        r = api_client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "username": "NoMediaE2E"})
        assert r.status_code == 200, r.text
        room = r.json().get("room") or {}
        assert room.get("curated") is True
        assert expected_name in (room.get("name") or "")
        assert (room.get("media") or {}).get("url")


@pytest.mark.expects_m2
@pytest.mark.expects_m3
def test_t2_f5_06_browser_nonexistent_room_shows_toast_and_returns_home(
    page_session: Page,
    base_url: str,
) -> None:
    """T2-F5-06: Navigating to #/mesh/tv-nonexistent-xyz shows toast and returns to #/."""
    with page_session.hygiene.allow_http_error("/api/rooms/tv-nonexistent-xyz", status=404):
        page_session.goto(f"{base_url}/#/mesh/tv-nonexistent-xyz", wait_until="domcontentloaded")
        toast_el = page_session.locator("#toast-root .wl-dynamic-toast .wl-toast-text")
        toast_el.wait_for(state="visible", timeout=10000)
        page_session.wait_for_url(lambda u: "#/mesh/tv-nonexistent-xyz" not in u, timeout=10000)
        assert not page_session.hygiene.page_errors


# =====================================================================
# F6 Boundaries (T2-F6-01 .. T2-F6-06)
# =====================================================================


def test_t2_f6_01_missing_edge_token_on_resolve_catalog_returns_403(api_client: httpx.Client) -> None:
    """T2-F6-01: Missing X-Watchlivo-Token on resolve-catalog returns 403 even with same-origin Referer."""
    r = api_client.get(
        "/api/rave/resolve-catalog",
        params={"provider": "cinema", "tmdbId": "693134", "title": "Dune: Part Two", "mediaType": "movie"},
    )
    assert r.status_code == 403
    assert "Forbidden" in (r.json().get("error") or "")


@pytest.mark.expects_m3
def test_t2_f6_02_expired_token_triggers_frontend_refresh_and_retry(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F6-02: Expired/tampered token returns 403; frontend refreshes via /api/rave/session-token and retries 200."""
    tampered = "1000000000.abcdef123456.000000000000000000000000"
    bad_r = resolve_catalog_api(
        api_client,
        tampered,
        {"provider": "cinema", "tmdbId": "693134", "title": "Dune: Part Two", "mediaType": "movie"},
    )
    assert bad_r.status_code == 403

    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    # Inject tampered token into meta tag and trigger resolve-catalog via search movie click
    page_session.evaluate(
        f'() => {{ const m = document.querySelector(\'meta[name="wl-edge-token"]\'); if (m) m.setAttribute("content", "{tampered}"); }}'
    )
    statuses: list[tuple[str, int]] = []
    page_session.on(
        "response",
        lambda resp: statuses.append((resp.url, resp.status))
        if ("/api/rave/resolve-catalog" in resp.url or "/api/rave/session-token" in resp.url)
        else None,
    )
    with page_session.hygiene.allow_http_error("/api/rave/resolve-catalog", status=403):
        submit_home_search(page_session, "Dune: Part Two")
        page_session.locator("#home-selection .super-results .poster.catalog-card").first.click()
        page_session.wait_for_url("**#/mesh/wl-*", timeout=20000)

    assert any("/api/rave/session-token" in u and s == 200 for u, s in statuses), (
        f"Expected /api/rave/session-token refresh, saw {statuses}"
    )
    assert any("/api/rave/resolve-catalog" in u and s == 200 for u, s in statuses), (
        f"Expected retried resolve-catalog 200, saw {statuses}"
    )
    new_tok = page_session.locator('meta[name="wl-edge-token"]').get_attribute("content")
    assert new_tok and new_tok != tampered


def test_t2_f6_03_cross_site_sec_fetch_site_rejected(base_url: str) -> None:
    """T2-F6-03: Sec-Fetch-Site: cross-site returns 403 on session-token, catalog, and supersearch."""
    with httpx.Client(
        base_url=base_url,
        headers={
            "User-Agent": BROWSER_UA,
            "Sec-Fetch-Site": "cross-site",
            "Origin": "https://evil.example",
        },
        timeout=10.0,
    ) as xs_client:
        for path in ("/api/rave/session-token", "/api/rave/catalog", "/api/rave/supersearch?q=test"):
            r = xs_client.get(path)
            assert r.status_code == 403, f"Expected 403 for cross-site {path}, got {r.status_code}"


def test_t2_f6_04_password_protected_room_wrong_vs_correct_pwd(api_client: httpx.Client) -> None:
    """T2-F6-04: Password-protected room rejects wrong pwd (403) and accepts correct pwd (200)."""
    created = api_client.post(
        "/api/rooms/create",
        json={"name": "Locked E2E", "creator": "E2EHost", "privacy": "public", "password": "gizli123"},
    ).json()
    rid = created["room"]["id"]
    try:
        wrong = api_client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "username": "Guest", "pwd": "wrong"})
        assert wrong.status_code == 403
        assert wrong.json().get("error") == "password_required"

        right = api_client.post(f"/api/rooms/{rid}/sync", json={"type": "init", "username": "Guest", "pwd": "gizli123"})
        assert right.status_code == 200
        assert right.json()["room"]["id"] == rid
    finally:
        api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "close_room", "clientId": created["clientId"], "clientToken": created["clientToken"]},
        )


@pytest.mark.expects_m3
def test_t2_f6_05_non_creator_close_403_and_creator_close_410_toast_in_guest_browser(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F6-05: Non-creator close_room 403; creator close_room triggers 410 toast + redirect in guest browser."""
    created = api_client.post(
        "/api/rooms/create",
        json={"name": "Close Toast Room", "creator": "HostE2E", "privacy": "public"},
    ).json()
    rid = created["room"]["id"]
    cid = created["clientId"]
    ctok = created["clientToken"]

    non_creator = api_client.post(
        f"/api/rooms/{rid}/sync",
        json={"type": "close_room", "clientId": "random_guest"},
    )
    assert non_creator.status_code == 403

    with page_session.hygiene.allow_http_error(f"/api/rooms/{rid}/sync", status=410):
        page_session.goto(f"{base_url}/#/mesh/{rid}", wait_until="domcontentloaded")
        page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)

        close_r = api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "close_room", "clientId": cid, "clientToken": ctok},
        )
        assert close_r.status_code == 200

        toast_el = page_session.locator("#toast-root .wl-dynamic-toast .wl-toast-text")
        toast_el.wait_for(state="visible", timeout=10000)
        page_session.wait_for_url(lambda u: f"#/mesh/{rid}" not in u, timeout=10000)


@pytest.mark.expects_m3
def test_t2_f6_06_realtime_chat_no_duplicate_retry(
    page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F6-06: Sending one chat message persists exactly 1 message (no spurious retry duplicate)."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.locator("#btn-create-room").click()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=12000)
    page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=10000)
    rid = page_session.url.split("#/mesh/")[1].split("?")[0]

    unique_msg = f"TekMesaj_{uuid.uuid4().hex[:6]}"
    chat_input = page_session.locator("#chat-input")
    if not chat_input.is_visible():
        page_session.locator("#nav-toggle-chat").click()
    chat_input.wait_for(state="visible", timeout=5000)
    chat_input.fill(unique_msg)
    page_session.locator("#btn-chat-send").click()

    page_session.locator(f'#chat-list .msg:has-text("{unique_msg}")').first.wait_for(state="visible", timeout=8000)
    page_session.wait_for_timeout(1500)

    dom_count = page_session.locator(f'#chat-list .msg:has-text("{unique_msg}")').count()
    assert dom_count == 1, f"Expected 1 DOM chat message, got {dom_count}"

    sync_r = api_client.post(f"/api/rooms/{rid}/sync", json={"type": "poll", "username": "Verifier"})
    assert sync_r.status_code == 200
    srv_msgs = [m for m in sync_r.json()["room"]["chat"] if m.get("text") == unique_msg]
    assert len(srv_msgs) == 1, f"Expected 1 server chat message, got {len(srv_msgs)}"


# =====================================================================
# F7 Boundaries (T2-F7-01 .. T2-F7-06)
# =====================================================================


def test_t2_f7_01_mobile_390x844_across_search_sinema_and_room(
    mobile_page_session: Page,
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F7-01: Mobile 390x844 has zero horizontal overflow in search, Sinema+, and room."""
    mobile_page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(mobile_page_session)

    submit_home_search(mobile_page_session, "Inception")
    assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")

    mobile_page_session.locator('.floating-dock .dock-btn[data-view="cinema"]').click()
    mobile_page_session.locator("#home-selection .catalog-main .poster.catalog-card").first.wait_for(
        state="visible", timeout=15000
    )
    assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")

    created = api_client.post("/api/rooms/create", json={"name": "Mob390", "creator": "Mob"}).json()
    rid = created["room"]["id"]
    try:
        mobile_page_session.goto(f"{base_url}/#/mesh/{rid}", wait_until="domcontentloaded")
        mobile_page_session.locator("#mesh-root .mesh-layout").wait_for(state="visible", timeout=12000)
        assert mobile_page_session.evaluate("() => document.documentElement.scrollWidth <= 390")
    finally:
        api_client.post(
            f"/api/rooms/{rid}/sync",
            json={"type": "close_room", "clientId": created["clientId"], "clientToken": created["clientToken"]},
        )


@pytest.mark.expects_m2
@pytest.mark.expects_m3
def test_t2_f7_02_no_broken_hardcoded_solo_leveling_backdrop(page_session: Page, base_url: str) -> None:
    """T2-F7-02: Home & latest-episodes emit zero ORB/broken requests for od5S7r2v306B2eR0E5t6vP8K2wG.jpg."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)
    page_session.wait_for_timeout(1500)

    bad_urls = [
        url for _, url in page_session.hygiene.all_requests
        if "od5S7r2v306B2eR0E5t6vP8K2wG.jpg" in url
    ]
    assert not bad_urls, f"Broken hardcoded TMDB backdrop still requested: {bad_urls}"
    page_session.hygiene.assert_clean()


@pytest.mark.expects_m3
def test_t2_f7_03_profile_dock_backdrop_dismiss_and_create_room_double_click_guard(
    page_session: Page,
    base_url: str,
) -> None:
    """T2-F7-03: Profil modal closes cleanly freeing dock; rapid double-click on Oda Oluştur creates 1 room."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator('.floating-dock .dock-btn[data-view="profile"]').click()
    page_session.locator("#popup-root .wl-auth-modal").wait_for(state="visible", timeout=5000)
    close_modal_and_wait_detached(page_session, use_escape=False)
    assert page_session.locator("#popup-root .popup-backdrop").count() == 0

    create_calls: list[str] = []
    page_session.on(
        "request",
        lambda req: create_calls.append(req.url) if "/api/rooms/create" in req.url else None,
    )
    page_session.locator("#btn-create-room").dblclick()
    page_session.wait_for_url("**#/mesh/wl-*", timeout=12000)
    page_session.wait_for_timeout(600)
    assert len(create_calls) == 1, f"Double-click created {len(create_calls)} rooms instead of 1"


@pytest.mark.expects_m3
def test_t2_f7_04_movie_preview_modal_failure_keeps_feedback_clean(
    page_session: Page,
    base_url: str,
) -> None:
    """T2-F7-04: When resolve-catalog fails (404) from preview modal, user gets clear toast without silent close."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator('.provider-tile[data-provider="cinema"]').click()
    page_session.locator("#home-selection .catalog-main .poster.catalog-card").first.wait_for(
        state="visible", timeout=15000
    )

    page_session.route(
        "**/api/rave/resolve-catalog*",
        lambda route: route.fulfill(
            status=404,
            content_type="application/json",
            body='{"ok":false,"error":"Kaynak geçici olarak bulunamadı."}',
        ),
    )
    with page_session.hygiene.allow_http_error("/api/rave/resolve-catalog", status=404):
        # Click movie card CTA or preview
        cta = page_session.locator("#home-selection .catalog-main .poster.catalog-card button.poster-cta").first
        cta.click()
        toast_el = page_session.locator("#toast-root .wl-dynamic-toast .wl-toast-text")
        toast_el.wait_for(state="visible", timeout=8000)
        assert toast_el.inner_text().strip() != ""


def test_t2_f7_05_join_by_code_invalid_symbols_shows_toast_keeps_modal(
    page_session: Page,
    base_url: str,
) -> None:
    """T2-F7-05: Invalid room code '!@#$%' in Kodla katıl shows Turkish toast and keeps modal open."""
    page_session.goto(base_url, wait_until="domcontentloaded")
    wait_for_home_boot(page_session)

    page_session.locator('header.top-nav-capsule button[aria-label="Kodla katıl"]').click()
    page_session.locator("#popup-root .popup").wait_for(state="visible", timeout=5000)
    code_input = page_session.locator("#popup-root input").first
    code_input.fill("!@#$%")
    page_session.locator('#popup-root .popup-options button.btn.primary').click()

    toast_el = page_session.locator("#toast-root .wl-dynamic-toast .wl-toast-text")
    toast_el.wait_for(state="visible", timeout=5000)
    assert "oda kodu" in toast_el.inner_text().lower() or "geçerli" in toast_el.inner_text().lower()
    assert page_session.locator("#popup-root .popup").is_visible()


def test_t2_f7_06_path_traversal_and_double_slash_normalization(
    api_client: httpx.Client,
    base_url: str,
) -> None:
    """T2-F7-06: Path traversal never leaks wrangler.toml; //api/health normalizes safely."""
    import http.client
    from urllib.parse import urlparse

    trav = api_client.get("/static/../wrangler.toml")
    assert trav.status_code in (200, 403, 404)
    assert "WATCHLIVO_KV" not in trav.text
    assert "compatibility_date" not in trav.text
    if trav.status_code == 200:
        assert "text/html" in (trav.headers.get("content-type") or "").lower()

    parsed = urlparse(base_url)
    conn = http.client.HTTPConnection(parsed.hostname or "127.0.0.1", parsed.port or 80, timeout=10)
    try:
        for raw_path in ("/static/../wrangler.toml", "/static/%2e%2e/wrangler.toml"):
            conn.request("GET", raw_path, headers={"User-Agent": BROWSER_UA})
            raw_resp = conn.getresponse()
            raw_body = raw_resp.read().decode("utf-8", errors="replace")
            assert raw_resp.status in (200, 400, 403, 404), f"{raw_path} returned {raw_resp.status}"
            assert "WATCHLIVO_KV" not in raw_body
            assert "compatibility_date" not in raw_body
            if raw_resp.status == 200:
                assert "text/html" in (raw_resp.getheader("Content-Type") or "").lower()
    finally:
        conn.close()

    dbl = api_client.get("//api/health")
    assert dbl.status_code in (200, 404)
    if dbl.status_code == 200:
        assert dbl.json().get("ok") is True
