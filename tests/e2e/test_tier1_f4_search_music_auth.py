from __future__ import annotations

import uuid

import httpx
import pytest

from helpers import browser_headers

pytestmark = [pytest.mark.tier1]


def test_t1_f4_01_supersearch_resident_evil(api_client: httpx.Client) -> None:
    """T1-F4-01: SuperSearch keyword query returns Resident Evil (108296)."""
    resp = api_client.get("/api/rave/supersearch", params={"q": "Resident Evil"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("query") == "Resident Evil"
    items = data.get("items") or []
    tmdb = data.get("tmdb") or []
    assert len(items) >= 1 and len(tmdb) >= 1
    assert any(
        str(it.get("tmdbId")) == "108296" and it.get("mediaType") == "tv"
        for it in items
    ), f"Expected Resident Evil TV (108296) in supersearch items: {items[:3]}"


@pytest.mark.expects_m2
def test_t1_f4_02_catalog_filtering_and_shuffle(api_client: httpx.Client) -> None:
    """T1-F4-02: Catalog filtering, totalTv/totalMovies counts, and shuffle=1."""
    r1 = api_client.get(
        "/api/rave/catalog",
        params={"provider": "cinema", "shuffle": "1", "limit": "12"},
    )
    assert r1.status_code == 200, r1.text
    d1 = r1.json()
    assert len(d1.get("items") or []) <= 12
    assert isinstance(d1.get("totalTv"), int)
    assert isinstance(d1.get("totalMovies"), int)

    ids_set = {tuple(str(x.get("id") or x.get("tmdbId")) for x in (d1.get("items") or []))}
    for _ in range(3):
        r_next = api_client.get(
            "/api/rave/catalog",
            params={"provider": "cinema", "shuffle": "1", "limit": "12"},
        )
        assert r_next.status_code == 200
        ids_set.add(tuple(str(x.get("id") or x.get("tmdbId")) for x in (r_next.json().get("items") or [])))
    assert len(ids_set) >= 2, "shuffle=1 produced identical ordering across 4 requests"

    for prov in ("series", "anime"):
        rp = api_client.get("/api/rave/catalog", params={"provider": prov, "limit": "12"})
        assert rp.status_code == 200
        assert isinstance(rp.json().get("items"), list)


def test_t1_f4_03_music_catalog_and_lyrics_vtt(api_client: httpx.Client) -> None:
    """T1-F4-03: Music catalog shelves & music-lyrics.vtt WEBVTT response."""
    cat_resp = api_client.get("/api/rave/music-catalog", params={"provider": "music", "category": "all"})
    assert cat_resp.status_code == 200, cat_resp.text
    cat = cat_resp.json()
    assert cat.get("provider") == "music"
    assert isinstance(cat.get("categories"), list) and len(cat["categories"]) >= 1
    assert isinstance(cat.get("shelves"), list) and len(cat["shelves"]) >= 1
    assert isinstance(cat.get("items"), list) and len(cat["items"]) >= 3

    lyr_resp = api_client.get(
        "/api/rave/music-lyrics.vtt",
        params={"artist": "Semicenk", "title": "Pisman Degilim"},
    )
    assert lyr_resp.status_code == 200
    assert "text/vtt" in (lyr_resp.headers.get("content-type") or "").lower()
    assert lyr_resp.text.lstrip().startswith("WEBVTT")


@pytest.mark.expects_m2
def test_t1_f4_04_music_resolve_contract(api_client: httpx.Client) -> None:
    """T1-F4-04: Music resolve returns complete contract with non-empty url & isMusic."""
    r_vid = api_client.get(
        "/api/rave/music-resolve",
        params={"artist": "Mabel Matiz", "title": "Fan", "videoId": "dQw4w9WgXcQ"},
    )
    assert r_vid.status_code == 200, r_vid.text
    dv = r_vid.json()
    assert dv.get("isMusic") is True
    assert dv.get("mediaType") == "music"
    assert dv.get("url")
    assert dv.get("lyricsUrl")
    assert dv.get("title")

    r_auto = api_client.get(
        "/api/rave/music-resolve",
        params={"artist": "Mabel Matiz", "title": "Fan"},
    )
    assert r_auto.status_code == 200, r_auto.text
    da = r_auto.json()
    assert da.get("isMusic") is True
    assert da.get("mediaType") == "music"
    assert da.get("url")
    assert da.get("lyricsUrl")


@pytest.mark.expects_m2
def test_t1_f4_05_auth_register_me_login_logout_lifecycle(api_client: httpx.Client, base_url: str) -> None:
    """T1-F4-05: Full auth lifecycle register (with handle) -> me -> login -> logout."""
    uniq = uuid.uuid4().hex[:8]
    email = f"e2e_{uniq}@example.com"
    password = f"Pass_{uniq}!"
    name = f"Tester{uniq}"

    reg = api_client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "name": name},
    )
    assert reg.status_code == 200, reg.text
    reg_data = reg.json()
    assert reg_data.get("ok") is True
    token = reg_data.get("authToken")
    assert token
    user = reg_data.get("user") or {}
    assert user.get("handle"), f"Registered user missing handle: {user}"

    me_ok = api_client.get("/api/auth/me", headers=browser_headers(base_url, bearer=token))
    assert me_ok.status_code == 200
    assert me_ok.json().get("authenticated") is True

    login = api_client.post(
        "/api/auth/login",
        json={"identifier": user["handle"], "password": password},
    )
    assert login.status_code == 200, login.text
    login_tok = login.json().get("authToken")
    assert login_tok

    out = api_client.post("/api/auth/logout", headers=browser_headers(base_url, bearer=login_tok))
    assert out.status_code == 200
    assert out.json().get("ok") is True

    me_after = api_client.get("/api/auth/me", headers=browser_headers(base_url, bearer=login_tok))
    assert me_after.status_code == 401


@pytest.mark.expects_m2
def test_t1_f4_06_user_cloud_sync_endpoints(api_client: httpx.Client, base_url: str) -> None:
    """T1-F4-06: User cloud sync (progress, watchlist, music-history, yt-preferences)."""
    for path in ("/api/user/progress", "/api/user/watchlist", "/api/user/music-history", "/api/user/yt-preferences"):
        unauth = api_client.get(path)
        assert unauth.status_code == 401, f"Expected 401 unauthenticated for {path}, got {unauth.status_code}"

    uniq = uuid.uuid4().hex[:8]
    reg = api_client.post(
        "/api/auth/register",
        json={"email": f"sync_{uniq}@example.com", "password": f"Sync_{uniq}!", "name": f"Sync{uniq}"},
    )
    assert reg.status_code == 200, reg.text
    token = reg.json()["authToken"]
    hdrs = browser_headers(base_url, bearer=token)

    p_post = api_client.post(
        "/api/user/progress",
        headers=hdrs,
        json={"item": {"key": "movie:27205", "tmdbId": "27205", "title": "Inception", "currentTime": 125}},
    )
    assert p_post.status_code == 200
    assert any(it.get("key") == "movie:27205" for it in api_client.get("/api/user/progress", headers=hdrs).json().get("items", []))

    w_post = api_client.post(
        "/api/user/watchlist",
        headers=hdrs,
        json={"item": {"key": "tv:108296", "tmdbId": "108296", "title": "Resident Evil"}},
    )
    assert w_post.status_code == 200
    assert any(it.get("key") == "tv:108296" for it in api_client.get("/api/user/watchlist", headers=hdrs).json().get("items", []))

    yt_post = api_client.post(
        "/api/user/yt-preferences",
        headers=hdrs,
        json={"likedChannels": ["Watchlivo"], "history": ["dQw4w9WgXcQ"]},
    )
    assert yt_post.status_code == 200, yt_post.text
    yt_get = api_client.get("/api/user/yt-preferences", headers=hdrs)
    assert yt_get.status_code == 200


@pytest.mark.expects_m2
def test_t1_f4_07_youtube_ravedj_and_social_search(api_client: httpx.Client) -> None:
    """T1-F4-07: YouTube, RaveDJ & Social Search endpoints do not raw-404 on edge."""
    yt_s = api_client.get("/api/search/youtube", params={"q": "lofi"})
    assert yt_s.status_code == 200, yt_s.text
    assert isinstance(yt_s.json().get("items"), list)

    yt_feed = api_client.post("/api/rave/yt-personalized-feed", json={"history": []})
    assert yt_feed.status_code == 200, yt_feed.text
    assert isinstance(yt_feed.json().get("items"), list)

    rdj = api_client.get("/api/rave/ravedj-trending")
    assert rdj.status_code == 200, rdj.text
    assert isinstance(rdj.json().get("items"), list)

    soc = api_client.get("/api/rave/social/search", params={"q": "test"})
    assert soc.status_code == 200, soc.text
    assert isinstance(soc.json().get("users"), list)
