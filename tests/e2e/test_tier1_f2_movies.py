from __future__ import annotations

import re

import httpx
import pytest

from helpers import resolve_catalog_api

pytestmark = [pytest.mark.tier1]

SHOP_BLACKLIST_RE = re.compile(r"(?:\.shop/(?:mo|mj)/|^https?://s\d+\.[^/]+\.shop/)", re.I)


def test_t1_f2_01_vault_backed_movie_dune2(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F2-01: Vault-backed movie resolve & HLS manifest (Dune: Part Two 693134)."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "693134",
            "title": "Dune: Part Two",
            "mediaType": "movie",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("streamType") == "hls"
    stream_url = str(data.get("url") or "")
    assert "/api/rave/stream" in stream_url
    m_resp = api_client.get(stream_url, timeout=25.0)
    assert m_resp.status_code == 200, f"Manifest error: {m_resp.status_code} {m_resp.text[:200]}"
    assert "mpegurl" in (m_resp.headers.get("content-type") or "").lower()
    assert m_resp.text.lstrip().startswith("#EXTM3U")
    if "/api/rave/stream-proxy" not in m_resp.text:
        variant_uri = next(
            (ln.strip() for ln in m_resp.text.splitlines() if ln.strip().startswith("/api/rave/stream?")),
            "",
        )
        assert variant_uri, f"Expected variant or stream-proxy URI in manifest:\n{m_resp.text[:400]}"
        v_resp = api_client.get(variant_uri, timeout=25.0)
        assert v_resp.status_code == 200, f"Variant error: {v_resp.status_code}"
        assert v_resp.text.lstrip().startswith("#EXTM3U")
        assert "/api/rave/stream-proxy" in v_resp.text


@pytest.mark.expects_m1
def test_t1_f2_02_inception_resolve_and_hls_playback(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F2-02: Inception (27205) resolve & HLS playlist/segment fetch without 502."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "27205",
            "title": "Inception",
            "mediaType": "movie",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data.get("servers") or []) >= 1
    stream_url = str(data.get("url") or "")
    assert stream_url
    m_resp = api_client.get(stream_url, timeout=25.0) if stream_url.startswith("/") else httpx.get(stream_url, timeout=25.0)
    assert m_resp.status_code == 200, f"HLS manifest failed: {m_resp.status_code} {m_resp.text[:200]}"
    assert m_resp.text.lstrip().startswith("#EXTM3U")

    next_uri = next(
        (ln.strip() for ln in m_resp.text.splitlines() if ln.strip() and not ln.strip().startswith("#")),
        "",
    )
    assert next_uri, "No variant or segment URI found in Inception playlist"
    if next_uri.startswith("/api/rave/stream?"):
        v_resp = api_client.get(next_uri, timeout=25.0)
        assert v_resp.status_code == 200, f"Variant playlist failed: {v_resp.status_code}"
        seg_uri = next(
            (ln.strip() for ln in v_resp.text.splitlines() if ln.strip() and not ln.strip().startswith("#")),
            "",
        )
    else:
        seg_uri = next_uri
    if seg_uri and seg_uri.startswith("/api/rave/stream-proxy"):
        seg_resp = api_client.get(seg_uri, headers={"Range": "bytes=0-1023"}, timeout=25.0)
        assert seg_resp.status_code in (200, 206), f"Segment failed: {seg_resp.status_code}"


@pytest.mark.expects_m1
def test_t1_f2_03_otis_sinema_movie_resolve(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F2-03: Sinema+ bootstrap movie (Otis Kasırgasının Tam Ortasında 1780005)."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "1780005",
            "title": "Otis Kasırgasının Tam Ortasında",
            "originalTitle": "Contra el huracán",
            "mediaType": "movie",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    stream_url = str(data.get("url") or "")
    assert stream_url
    if stream_url.startswith("/"):
        m_resp = api_client.get(stream_url, timeout=25.0)
        assert m_resp.status_code == 200, f"HLS manifest failed: {m_resp.status_code} {m_resp.text[:200]}"
        assert m_resp.text.lstrip().startswith("#EXTM3U")


@pytest.mark.expects_m1
def test_t1_f2_04_lotr_rotk_segment_proxy(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F2-04: LOTR: Return of the King (122) playlist & first segment proxy."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "122",
            "title": "The Lord of the Rings: The Return of the King",
            "mediaType": "movie",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    stream_url = str(data.get("url") or "")
    assert stream_url
    m_resp = api_client.get(stream_url, timeout=25.0) if stream_url.startswith("/") else httpx.get(stream_url, timeout=25.0)
    assert m_resp.status_code == 200, f"LOTR manifest failed: {m_resp.status_code} {m_resp.text[:200]}"
    assert m_resp.text.lstrip().startswith("#EXTM3U")

    next_uri = next(
        (ln.strip() for ln in m_resp.text.splitlines() if ln.strip() and not ln.strip().startswith("#")),
        "",
    )
    assert next_uri
    if next_uri.startswith("/api/rave/stream?"):
        v_resp = api_client.get(next_uri, timeout=25.0)
        assert v_resp.status_code == 200, f"LOTR variant failed: {v_resp.status_code}"
        seg_uri = next(
            (ln.strip() for ln in v_resp.text.splitlines() if ln.strip() and not ln.strip().startswith("#")),
            "",
        )
    else:
        seg_uri = next_uri
    assert seg_uri
    if seg_uri.startswith("/"):
        seg_resp = api_client.get(seg_uri, headers={"Range": "bytes=0-1023"}, timeout=25.0)
        assert seg_resp.status_code in (200, 206), f"LOTR segment failed: {seg_resp.status_code}"
        assert len(seg_resp.content) > 0


def test_t1_f2_05_shop_vault_filter_and_servers(api_client: httpx.Client, edge_token: str) -> None:
    """T1-F2-05: Preserved .shop vault filter & multi-server collection."""
    resp = resolve_catalog_api(
        api_client,
        edge_token,
        {
            "provider": "cinema",
            "tmdbId": "693134",
            "title": "Dune: Part Two",
            "mediaType": "movie",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    urls = [str(data.get("url") or "")] + [
        str(srv.get("url") or "") for srv in (data.get("servers") or [])
    ]
    non_empty = [u for u in urls if u]
    assert len(non_empty) >= 1
    for u in non_empty:
        assert not SHOP_BLACKLIST_RE.search(u), f"Expired .shop URL leaked: {u}"


def test_t1_f2_06_poster_proxy_endpoint(api_client: httpx.Client) -> None:
    """T1-F2-06: Poster proxy endpoint returns valid image with nosniff."""
    resp = api_client.get(
        "/api/rave/poster",
        params={"tid": "27205", "t": "Inception", "mt": "movie"},
    )
    assert resp.status_code == 200, resp.text
    ct = (resp.headers.get("content-type") or "").lower()
    assert ct.startswith("image/"), f"Unexpected poster Content-Type: {ct}"
    assert len(resp.content) > 500
    assert (resp.headers.get("x-content-type-options") or "").lower() == "nosniff"


def test_t1_f2_07_subtitle_vtt_and_subtitles_list(api_client: httpx.Client) -> None:
    """T1-F2-07: Empty subtitle.vtt returns WEBVTT & /api/rave/subtitles returns JSON."""
    vtt_resp = api_client.get("/api/rave/subtitle.vtt")
    assert vtt_resp.status_code == 200
    assert "text/vtt" in (vtt_resp.headers.get("content-type") or "").lower()
    assert vtt_resp.text.lstrip().startswith("WEBVTT")

    list_resp = api_client.get("/api/rave/subtitles", params={"tmdbId": "27205"})
    assert list_resp.status_code == 200
    data = list_resp.json()
    assert data.get("ok") is True
    assert isinstance(data.get("subtitleTracks"), list)
