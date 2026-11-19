from __future__ import annotations

import httpx
import pytest

from helpers import resolve_catalog_api

pytestmark = [pytest.mark.tier1]


def test_t1_f1_01_resident_evil_seasons_metadata(api_client: httpx.Client) -> None:
    """T1-F1-01: Resident Evil (108296) S1 seasons metadata."""
    resp = api_client.get(
        "/api/rave/seasons",
        params={"tmdbId": "108296", "mediaType": "tv", "season": "1"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("ok") is True
    assert len(data.get("seasons") or []) >= 1
    episodes = data.get("episodes") or []
    assert len(episodes) == 8, f"Expected 8 episodes for Resident Evil S1, got {len(episodes)}"
    assert [ep.get("episode") for ep in episodes] == list(range(1, 9))


@pytest.mark.expects_m1
def test_t1_f1_02_resident_evil_s1e3_resolve(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F1-02: Resident Evil S1E3 direct edge resolve & playable manifest/proxy."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "108296",
            "title": "Resident Evil",
            "displayTitle": "Resident Evil: biohazard",
            "mediaType": "tv",
            "season": "1",
            "episode": "3",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("streamType") in ("hls", "mp4")
    stream_url = str(data.get("url") or "")
    assert stream_url.startswith("/api/rave/") or stream_url.startswith("https://")
    assert len(data.get("servers") or []) >= 1
    if stream_url.startswith("/"):
        s_resp = api_client.get(stream_url, timeout=25.0)
        assert s_resp.status_code in (200, 206), f"Stream fetch failed: {s_resp.status_code} {s_resp.text[:200]}"
        if data.get("streamType") == "hls" and s_resp.status_code == 200:
            assert s_resp.text.lstrip().startswith("#EXTM3U")


@pytest.mark.expects_m1
def test_t1_f1_03_resident_evil_s1e6_resolve(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F1-03: Resident Evil S1E6 direct edge resolve."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "108296",
            "title": "Resident Evil",
            "displayTitle": "Resident Evil: biohazard",
            "mediaType": "tv",
            "season": "1",
            "episode": "6",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert int(data.get("season") or 0) == 1
    assert int(data.get("episode") or 0) == 6
    stream_url = str(data.get("url") or "")
    assert stream_url
    assert len(data.get("servers") or []) >= 1
    if stream_url.startswith("/"):
        s_resp = api_client.get(stream_url, timeout=25.0)
        assert s_resp.status_code in (200, 206), f"Stream fetch failed: {s_resp.status_code}"


@pytest.mark.expects_m1
def test_t1_f1_04_resident_evil_s1_full_sweep(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F1-04: Resident Evil S1E1-S1E8 sweep without 404s."""
    failures: list[tuple[int, int, str]] = []
    for ep in range(1, 9):
        resp = resolve_catalog_api(
            api_client,
            edge_token,
            {
                "provider": "cinema",
                "tmdbId": "108296",
                "title": "Resident Evil",
                "displayTitle": "Resident Evil: biohazard",
                "mediaType": "tv",
                "season": "1",
                "episode": str(ep),
            },
        )
        if resp.status_code != 200:
            failures.append((ep, resp.status_code, resp.text[:150]))
            continue
        data = resp.json()
        servers = data.get("servers") or []
        if not data.get("url") or not servers or not servers[0].get("url"):
            failures.append((ep, resp.status_code, "missing url or servers"))
    assert not failures, f"Resident Evil S1 episode failures: {failures}"


@pytest.mark.expects_m1
def test_t1_f1_05_popular_and_turkish_tv_resolve(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F1-05: Popular & Turkish TV series (Wednesday 119051 & Gibi 115678) S1E1."""
    cases = [
        {"provider": "cinema", "tmdbId": "119051", "title": "Wednesday", "mediaType": "tv", "season": "1", "episode": "1"},
        {"provider": "cinema", "tmdbId": "115678", "title": "Gibi", "mediaType": "tv", "season": "1", "episode": "1"},
    ]
    for params in cases:
        resp = resolve_catalog_api(api_client, edge_token, params)
        assert resp.status_code == 200, f"{params['title']} failed: {resp.status_code} {resp.text[:200]}"
        data = resp.json()
        assert data.get("url"), f"{params['title']} missing url"
        assert data.get("streamType") in ("hls", "mp4")


@pytest.mark.expects_m1
def test_t1_f1_06_latest_episodes_and_la_masacre_resolve(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F1-06: Latest episodes feed & La masacre de Flores (337800) S1E1."""
    le_resp = api_client.get("/api/rave/latest-episodes")
    assert le_resp.status_code == 200, le_resp.text
    le_data = le_resp.json()
    assert le_data.get("ok") is True
    assert isinstance(le_data.get("items"), list) and len(le_data["items"]) >= 1

    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "337800",
            "title": "La masacre de Flores",
            "sourceUrl": "https://www.dizibox.live/diziler/la-masacre-de-flores/",
            "mediaType": "tv",
            "season": "1",
            "episode": "1",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("url")


@pytest.mark.expects_m1
def test_t1_f1_07_anime_series_resolve(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F1-07: Anime TV Series Solo Leveling (127532) & Infinite Darkness (110642)."""
    solo = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "127532",
            "title": "Solo Leveling",
            "origLang": "ja",
            "mediaType": "tv",
            "season": "1",
            "episode": "1",
        },
    )
    assert solo.status_code == 200, solo.text
    assert solo.json().get("url")

    inf_dark = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "110642",
            "title": "RESIDENT EVIL: Infinite Darkness",
            "origLang": "ja",
            "mediaType": "tv",
            "season": "1",
            "episode": "1",
        },
    )
    assert inf_dark.status_code == 200, inf_dark.text
    assert inf_dark.json().get("url")
