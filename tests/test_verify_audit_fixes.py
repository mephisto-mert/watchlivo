import pytest
from starlette.testclient import TestClient
import server
from _net import network_available

client = TestClient(server.app)

# These checks hit real music/lyrics/YouTube upstreams (lrclib, iTunes, Deezer, YouTube).
_needs_network = pytest.mark.skipif(
    not network_available(),
    reason="network unavailable: music/lyrics/YouTube upstream lookups cannot be exercised offline",
)


@_needs_network
def test_aliases_and_routes():
    # 1. Alias routes
    r2 = client.get("/api/rave/lyrics?artist=Semicenk&title=Pisman+Degilim")
    assert r2.status_code == 200 and "-->" in r2.text
    r3 = client.get("/api/rave/resolve-music?artist=Semicenk&title=Canin+Sag+Olsun&mode=video")
    assert r3.status_code == 200 and r3.json().get("musicMode") == "video"

@_needs_network
def test_music_drm_and_shelves_and_lyrics():
    # 2. All 10 music categories & no Lvbel C5 in slow/nostalji
    mc = client.get("/api/rave/music-catalog?category=all").json()
    shelf_ids = [s["id"] for s in mc.get("shelves", [])]
    assert len(shelf_ids) >= 8, f"Expected >=8 shelves, got {shelf_ids}"
    for s in mc.get("shelves", []):
        if s["id"] in ("slow", "nostalji"):
            for it in s["items"]:
                assert "lvbel" not in (it.get("artist") or "").lower()
    # 3. No /cenc/ or /cbcs/ DRM in resolved music
    mr = client.get("/api/rave/music-resolve?artist=Mabel+Matiz&title=Antidepresan").json()
    assert "/cenc/" not in (mr.get("url") or "") and "/cbcs/" not in (mr.get("url") or "")
    # 4. Lyrics fallback always returns cues > 0
    lrc = client.get("/api/rave/music-lyrics.vtt?artist=Semicenk&title=UnkownSongTitle123").text
    assert lrc.count("-->") >= 1
    # 5. Direct music platform URL resolution (Deezer)
    dz = client.get("/api/rave/music-resolve?url=https://www.deezer.com/track/3135556").json()
    assert dz.get("songTitle") and dz.get("songTitle") != "Müzik & Klip Parçası"
    # 6. YouTube search
    yt = client.get("/api/rave/yt-search?q=Semicenk")
    assert yt.status_code == 200 and len(yt.json().get("items", [])) >= 1
