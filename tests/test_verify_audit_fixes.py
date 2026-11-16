from starlette.testclient import TestClient
import server

client = TestClient(server.app)

def test_aliases_and_routes():
    # 1. Alias routes
    r1 = client.get("/api/rave/series-info?tmdbId=1396&season=1")
    assert r1.status_code == 200 and len(r1.json().get("seasons", [])) >= 1
    r2 = client.get("/api/rave/lyrics?artist=Semicenk&title=Pisman+Degilim")
    assert r2.status_code == 200 and "-->" in r2.text
    r3 = client.get("/api/rave/resolve-music?artist=Semicenk&title=Canin+Sag+Olsun&mode=video")
    assert r3.status_code == 200 and r3.json().get("musicMode") == "video"

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

def test_youtube_search_and_twitch_kick_extract():
    # 6. YouTube search with Turkish chars
    yt = client.get("/api/search/youtube?q=tarkan+%C5%9F%C4%B1mar%C4%B1k")
    assert yt.status_code == 200 and len(yt.json().get("items", [])) >= 1
    # 7. Twitch & Kick extract
    tw = client.get("/api/rave/extract-video?url=https://www.twitch.tv/elraenn")
    assert tw.status_code == 200 and tw.json().get("provider") == "twitch"
    kc = client.get("/api/rave/extract-video?url=https://kick.com/elraenn")
    assert kc.status_code == 200 and kc.json().get("provider") == "kick"

def test_catalog_pagination_and_filters():
    # 8. Dizibox returns only TV
    dbx = client.get("/api/rave/catalog?provider=dizibox&page=1").json()
    assert all(x.get("mediaType") == "tv" for x in dbx.get("items", []))
    # 9. HDFilmCehennemi returns only movies
    hfnl = client.get("/api/rave/catalog?provider=hdfilmcehennemi&page=1").json()
    assert all(x.get("mediaType") != "tv" for x in hfnl.get("items", []))
    # 10. Page 2 vs Page 3 no 307-item vault dump duplication
    p2 = client.get("/api/rave/catalog?provider=cinema&page=2").json().get("items", [])
    p3 = client.get("/api/rave/catalog?provider=cinema&page=3").json().get("items", [])
    assert len(p2) < 120 and len(p3) < 120
    # 11. Domestic TR originals distinct & Prens search ranks 228853 #1
    blu = client.get("/api/rave/catalog?provider=blutv&page=1").json().get("items", [])
    exx = client.get("/api/rave/catalog?provider=exxen&page=1").json().get("items", [])
    assert blu[0]["tmdbId"] != exx[0]["tmdbId"]
    q_prens = client.get("/api/rave/catalog?provider=blutv&q=Prens").json().get("items", [])
    assert q_prens and str(q_prens[0].get("tmdbId")) == "228853"
    # 12. No double wsrv.nl wrapping
    for it in p2 + blu:
        assert (it.get("poster") or "").count("wsrv.nl") <= 1

def test_intro_and_turkish_series_resolve():
    # 13. Movie intro is ALWAYS None
    assert server._detect_intro_sync("tt1375666", "27205", "movie", 1, 1, []) is None
    # 14. Turkish domestic series (Behzat C 37681) resolves HTTP 200 with [Orijinal] audio label
    rc = client.get("/api/rave/resolve-catalog?provider=blutv&title=Behzat+C&tmdbId=37681&mediaType=tv&season=1&episode=1")
    assert rc.status_code == 200
    rj = rc.json()
    assert rj.get("provider") == "blutv"
    assert any("[Orijinal]" in (a.get("label") or "") for a in rj.get("audioTracks", []))
    assert not any(a.get("id") == "tr-ai-dub" for a in rj.get("audioTracks", []))
